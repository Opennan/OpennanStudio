// The GPU export worker (phase 10d), `@opennan/export/gpu-worker`: runs exportTimelineGpu off the page's main thread
// on an OffscreenCanvas WebGL2 renderer (the preview's LookRenderer), WebCodecs, and mediabunny. Text bitmaps come
// from the page (its fonts) over a message port; the audio and the final mux run on the page's ffmpeg.wasm runner;
// graphics draw here with the bundled faces the page lists. Hosts create it with their bundler's worker syntax, e.g.
// `new Worker(new URL("@opennan/export/gpu-worker", import.meta.url), { type: "module" })`.
import { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { ExportError } from "../../types";
import type { ExportRunner } from "../../runner";
import { createRemoteRasterizer } from "../../remote";
import { createOpfsVideoSink, opfsAvailable } from "../../web/opfs";
import { exportTimelineGpu, type GpuExportOptions } from "../gpu-export";
import { bytesTransfer, type PageToWorker, type WorkerFontSource, type WorkerMediaRequest, type WorkerToPage } from "./protocol";

type Scope = {
    postMessage(message: WorkerToPage, transfer?: Transferable[]): void;
    addEventListener(type: "message", listener: (event: MessageEvent<PageToWorker>) => void): void;
    fonts?: FontFaceSet;
};

/** WebGL2 on an OffscreenCanvas in this worker. */
export function workerWebGl2(): boolean {
    try {
        if (typeof OffscreenCanvas === "undefined") return false;
        const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
        (gl?.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
        return Boolean(gl);
    } catch {
        return false;
    }
}

/** Adds the page's bundled faces to this worker's FontFaceSet and loads them (failures draw with fallback fonts). */
export async function loadWorkerFonts(fonts: FontFaceSet | undefined, sources: WorkerFontSource[]): Promise<void> {
    if (!fonts || typeof FontFace === "undefined") return;
    await Promise.allSettled(sources.map(async (source) => {
        const face = new FontFace(source.family, source.src, { weight: source.weight, style: source.style, ...(source.unicodeRange ? { unicodeRange: source.unicodeRange } : {}) });
        fonts.add(face);
        await face.load();
    }));
}

function requestInit(request: WorkerMediaRequest, signal?: AbortSignal): RequestInit {
    return { headers: request.headers, credentials: request.credentials ?? "omit", signal };
}

/** The worker-side GPU export options built from the page's start message. */
export function workerGpuOptions(start: Extract<PageToWorker, { type: "start" }>, scope: Scope): GpuExportOptions {
    const lookup = (url: string): WorkerMediaRequest => {
        const request = start.media[url];
        if (!request) throw new Error(`This media cannot be read here: ${url}`); // i18n-ignore
        return request;
    };
    return {
        loadMediabunny: () => import("mediabunny"),
        async createSource(url, mb) {
            const request = lookup(url);
            const protocol = new URL(request.url, self.location.href).protocol;
            if (protocol === "blob:" || protocol === "data:") return new mb.BlobSource(await (await fetch(request.url)).blob());
            return new mb.UrlSource(request.url, { requestInit: requestInit(request), maxCacheSize: 16 * 2 ** 20 });
        },
        async fetchBlob(url, signal) {
            const request = lookup(url);
            const response = await fetch(request.url, requestInit(request, signal));
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`); // i18n-ignore
            return response.blob();
        },
        createRenderer: () => (workerWebGl2() ? new LookRenderer(new OffscreenCanvas(2, 2)) : null),
        isAvailable: workerWebGl2,
        createCanvas: (width, height) => new OffscreenCanvas(width, height),
        loadFonts: () => loadWorkerFonts(scope.fonts, start.fonts),
        createVideoSink: start.opfs && opfsAvailable() ? (container) => createOpfsVideoSink(container) : undefined,
        codecs: start.codecs as GpuExportOptions["codecs"],
    };
}

/** Wires the worker scope: one export per worker. Exported for tests (a fake scope). */
export function serveGpuExportWorker(scope: Scope): void {
    const abort = new AbortController();
    const pending = new Map<number, { resolve(output: unknown): void; reject(error: Error): void }>();
    let nextMux = 0;
    let started = false;
    scope.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "cancel") abort.abort();
        else if (message.type === "mux-done") pending.get(message.id)?.resolve(message.output);
        else if (message.type === "mux-error") pending.get(message.id)?.reject(new ExportError(message.code === "unknown" ? "ffmpeg-failed" : message.code, message.message, message.detail));
        else if (message.type === "start" && !started) {
            started = true;
            void run(message);
        }
    });

    /** Runs the export's last step on the page's runner and resolves with its output. */
    function pageStep(message: Extract<WorkerToPage, { type: "mux" }>, signal?: AbortSignal): Promise<never> {
        return new Promise((resolve, reject) => {
            const id = nextMux++;
            pending.set(id, {
                resolve: (output) => {
                    pending.delete(id);
                    resolve(output as never);
                },
                reject: (error) => {
                    pending.delete(id);
                    reject(error);
                },
            });
            signal?.addEventListener("abort", () => pending.get(id)?.reject(new ExportError("cancelled", "Export cancelled.")), { once: true });
            scope.postMessage({ ...message, id }, bytesTransfer(message.video));
        });
    }

    async function run(start: Extract<PageToWorker, { type: "start" }>): Promise<void> {
        if (typeof VideoEncoder === "undefined" || !workerWebGl2()) {
            scope.postMessage({ type: "unavailable", reason: "the GPU export cannot run in a worker in this browser" });
            return;
        }
        const rasterizer = createRemoteRasterizer(start.rasterPort as never);
        // The mux runs on the page (its ffmpeg.wasm runner); this proxy carries the plan and the encoded video there.
        const runner: ExportRunner = {
            kind: "wasm",
            supportsGl: false,
            maxResolution: "1080p",
            probe: async () => new Map(),
            chooseEncoder: async () => {
                throw new Error("the GPU export worker only muxes through the page"); // i18n-ignore
            },
            run: async () => {
                throw new Error("the GPU export worker only muxes through the page"); // i18n-ignore
            },
            mux: (plan, video, options) => pageStep({ type: "mux", id: 0, step: "mux", plan, video, container: options.container }, options.signal),
            gif: (plan, video, options) => pageStep({ type: "mux", id: 0, step: "gif", plan, video, container: options.container }, options.signal),
        };
        try {
            const outcome = await exportTimelineGpu(start.input, start.settings, {
                runner, rasterizer, signal: abort.signal,
                onProgress: (progress) => scope.postMessage({ type: "progress", progress }),
                gpu: workerGpuOptions(start, scope),
            });
            if (outcome.kind === "done") scope.postMessage({ type: "done", result: outcome.result }, bytesTransfer(outcome.result.output));
            else scope.postMessage({ type: "fallback", reason: outcome.reason });
        } catch (error) {
            const code = error instanceof ExportError ? error.code : "unknown";
            scope.postMessage({ type: "error", code, message: error instanceof Error ? error.message : String(error), detail: error instanceof ExportError ? error.detail : undefined });
        } finally {
            rasterizer.close();
        }
    }
}
