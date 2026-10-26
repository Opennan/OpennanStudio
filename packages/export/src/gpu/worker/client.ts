// The page side of the GPU export worker (phase 10d): hands the project to the worker (with how to fetch each media
// file and the bundled font faces graphics need), serves text bitmaps from the page's rasterizer, runs the worker's
// mux requests on the page's ffmpeg.wasm runner, forwards progress, and turns Cancel into a prompt settle (the worker
// gets a moment to close its decoders and files, then is terminated).
import { GRAPHICS_FONT_FACES } from "@opennan/timeline-core/graphics/draw/helpers";
import { graphicsAssetUrls, isBuiltinGraphics } from "@opennan/timeline-core/graphics/render";
import type { TextFontFace } from "@opennan/timeline-core/text/fonts";
import { checkAborted } from "../../abort";
import { collectMediaUrls } from "../../compile";
import type { ExportTimelineOptions } from "../../export-timeline";
import { serveOverlayRasterizer } from "../../remote";
import { playableClips } from "../../timeline-model";
import { ExportError, type ExportInput, type ExportSettings } from "../../types";
import type { GpuExportOptions, GpuExportOutcome } from "../gpu-export";
import { bytesTransfer, type PageToWorker, type WorkerFontSource, type WorkerMediaRequest, type WorkerToPage } from "./protocol";

export interface GpuWorkerHost {
    /** A new GPU export worker (`@opennan/export/gpu-worker`), one per export. */
    create(): Worker;
    /** How the worker fetches `url` (resolved URL, auth headers only for the host's own origin), or null when it cannot. */
    request(url: string): Promise<WorkerMediaRequest | null>;
    /** Bundled faces for the worker's FontFaceSet. Default: the document's @font-face rules for those faces. */
    fonts?(faces: readonly TextFontFace[]): Promise<WorkerFontSource[]>;
    /** Stream the encoded video into the origin private file system (the page's runner then muxes from disk). */
    opfs?: boolean;
    /** Milliseconds a cancelled worker gets to clean up before it is terminated. Default 1500. */
    cancelGraceMs?: number;
}

export type WorkerOutcome = GpuExportOutcome | { kind: "unavailable"; reason: string };

const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");

/** The document's @font-face rules for `faces`, with absolute URLs (the worker resolves nothing against the page). */
export function documentFontSources(faces: readonly TextFontFace[], doc: Document | undefined = typeof document === "undefined" ? undefined : document): WorkerFontSource[] {
    if (!doc) return [];
    const out: WorkerFontSource[] = [];
    const wanted = (family: string, weight: string, style: string) => faces.some((face) => face.family === family && String(face.weight) === weight && face.style === (style || "normal"));
    for (const sheet of Array.from(doc.styleSheets)) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            continue;
        }
        const base = sheet.href ?? doc.baseURI;
        for (const rule of Array.from(rules)) {
            if (typeof CSSFontFaceRule === "undefined" || !(rule instanceof CSSFontFaceRule)) continue;
            const family = unquote(rule.style.getPropertyValue("font-family"));
            const weight = rule.style.getPropertyValue("font-weight").trim() || "400";
            const style = rule.style.getPropertyValue("font-style").trim() || "normal";
            if (!wanted(family, weight, style)) continue;
            const src = rule.style.getPropertyValue("src").replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (_m, _q, url: string) => `url("${new URL(url, base).href}")`);
            const unicodeRange = rule.style.getPropertyValue("unicode-range").trim();
            out.push({ family, weight, style, src, ...(unicodeRange ? { unicodeRange } : {}) });
        }
    }
    return out;
}

/** Runs the GPU export in a worker; "unavailable" means the caller should run it on the page instead. */
export async function exportTimelineGpuInWorker(
    input: ExportInput, settings: ExportSettings, options: ExportTimelineOptions & { gpu: GpuExportOptions }, host: GpuWorkerHost,
): Promise<WorkerOutcome> {
    const { signal } = options;
    checkAborted(signal);
    const clips = playableClips(input.clips, input.tracks);
    const urls = new Set(collectMediaUrls(input));
    for (const clip of clips) if (isBuiltinGraphics(clip)) graphicsAssetUrls(clip).forEach((url) => urls.add(url));
    const media: Record<string, WorkerMediaRequest> = {};
    for (const url of urls) {
        const request = await host.request(url).catch(() => null);
        if (request) media[url] = request;
    }
    const fonts = clips.some((clip) => isBuiltinGraphics(clip))
        ? await (host.fonts ?? (async (faces) => documentFontSources(faces)))(GRAPHICS_FONT_FACES).catch(() => [])
        : [];
    checkAborted(signal);

    let worker: Worker;
    try {
        worker = host.create();
    } catch (error) {
        return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
    const channel = new MessageChannel();
    const stopRaster = options.rasterizer ? serveOverlayRasterizer(channel.port1 as never, options.rasterizer) : null;

    return new Promise<WorkerOutcome>((resolve, reject) => {
        let settled = false;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (terminateNow: boolean) => {
            clearTimeout(watchdog);
            signal?.removeEventListener("abort", onAbort);
            stopRaster?.();
            channel.port1.close();
            if (terminateNow) worker.terminate();
        };
        const settle = (finish: () => void, terminateNow = true) => {
            if (settled) return;
            settled = true;
            cleanup(terminateNow);
            finish();
        };
        // A driver/codec can stop fulfilling frame requests without raising a worker error.
        // Give a stalled worker time to release its files, then use the compatible exporter.
        const watch = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                worker.postMessage({ type: "cancel" } satisfies PageToWorker);
                setTimeout(() => worker.terminate(), host.cancelGraceMs ?? 1500);
                settle(() => resolve({ kind: "fallback", reason: "the fast export stopped responding" }), false);
            }, 60_000);
        };
        const onAbort = () => {
            worker.postMessage({ type: "cancel" } satisfies PageToWorker);
            // The worker closes its decoders, encoder, and files on cancel; terminate it shortly after either way.
            setTimeout(() => worker.terminate(), host.cancelGraceMs ?? 1500);
            settle(() => reject(new ExportError("cancelled", "Export cancelled.")), false);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        worker.addEventListener("error", (event) => {
            // The worker script failed to load or crashed: the page can still run the GPU path itself.
            event.preventDefault?.();
            settle(() => resolve({ kind: "unavailable", reason: (event as ErrorEvent).message || "the GPU export worker stopped" }));
        });
        worker.addEventListener("message", (event: MessageEvent<WorkerToPage>) => {
            const message = event.data;
            if (settled) return;
            switch (message.type) {
                case "progress":
                    watch();
                    options.onProgress?.({ ...message.progress, engine: "gpu" });
                    break;
                case "mux": {
                    // Main's mux has its own progress/cancellation; it may outlive a frame timeout.
                    clearTimeout(watchdog);
                    const runner = options.runner;
                    const stepOptions = {
                        container: message.container, signal,
                        onProgress: (ratio: number) => {
                            if (!settled) options.onProgress?.({ phase: message.step, ratio, engine: "gpu" });
                        },
                    };
                    const step = message.step === "gif"
                        ? runner.gif?.(message.plan, message.video, stepOptions)
                        : runner.mux?.(message.plan, message.video, stepOptions);
                    if (!step) {
                        worker.postMessage({ type: "mux-error", id: message.id, code: "runner-unsupported", message: "This export runner cannot finish a GPU export." } satisfies PageToWorker);
                        break;
                    }
                    step.then(
                        (output) => {
                            if (!settled) worker.postMessage({ type: "mux-done", id: message.id, output } satisfies PageToWorker, bytesTransfer(output));
                        },
                        (error: unknown) => {
                            if (settled) return;
                            worker.postMessage({
                                type: "mux-error", id: message.id, code: error instanceof ExportError ? error.code : "unknown",
                                message: error instanceof Error ? error.message : String(error), detail: error instanceof ExportError ? error.detail : undefined,
                            } satisfies PageToWorker);
                        },
                    );
                    break;
                }
                case "done":
                    settle(() => resolve({ kind: "done", result: message.result }));
                    break;
                case "fallback":
                    settle(() => resolve({ kind: "fallback", reason: message.reason }));
                    break;
                case "unavailable":
                    settle(() => resolve({ kind: "unavailable", reason: message.reason }));
                    break;
                case "error":
                    settle(() => reject(message.code === "cancelled" ? new ExportError("cancelled", "Export cancelled.") : new ExportError(message.code === "unknown" ? "ffmpeg-failed" : message.code, message.message, message.detail)));
                    break;
            }
        });
        watch();
        worker.postMessage({
            type: "start", input, settings, media, fonts, opfs: Boolean(host.opfs), rasterPort: channel.port2,
            codecs: options.gpu.codecs as string[] | undefined,
        } satisfies PageToWorker, [channel.port2]);
    });
}
