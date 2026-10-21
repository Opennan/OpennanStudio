// ?harness=bench: the export benchmark page (scripts/bench-export.mjs). The bench script hands a project JSON
// (scripts/bench/projects.mjs) to window.__bench.run and serves its media under /bench-media/ and the ffmpeg.wasm
// core under /ffmpeg-core/ through Playwright routes. Progress goes to the console as `[bench-progress]` lines.
import { useEffect } from "react";
import { optimistic } from "@opennan/timeline-core";
import { exportTimeline, type ExportInput, type ExportProgress, type ExportResolution } from "@opennan/export";
import {
    createBrowserGpuExport, createBrowserRasterizer, createFetchMediaReader, createOpfsOutput, createWasmRunner, opfsAvailable, removeOpfsExport,
} from "@opennan/export/web";
import GpuExportWorker from "@opennan/export/gpu-worker?worker";

export interface BenchSpec {
    input: ExportInput;
    resolution: ExportResolution;
    engine: "ffmpeg" | "gpu";
    /** Return the exported file (base64) for frame checks. */
    keepOutput?: boolean;
    /** GPU codec preference (default avc, vp9, av1, vp8). */
    codecs?: Array<"avc" | "vp9" | "av1" | "vp8">;
    /** Phase 10d: run the GPU export in a worker and stream through OPFS (the web app's default). Default true. */
    worker?: boolean;
    /** Phase 10d: "gif" exports an animated GIF. */
    format?: "video" | "gif";
}

/** How busy the page's main thread was during the export (what the editor UI would feel). */
export interface BenchResponsiveness {
    /** Long tasks (> 50 ms) on the main thread. */
    longTasks: number;
    /** Total blocking time: the sum of every long task's time over 50 ms. */
    blockingMs: number;
    maxTaskMs: number;
    /** Longest gap between two animation frames. */
    maxFrameGapMs: number;
    /** Share of animation frames that came more than 50 ms after the previous one. */
    slowFrameShare: number;
}

/** Samples main-thread long tasks and animation-frame gaps until stop(). */
function sampleResponsiveness(): { stop(): BenchResponsiveness } {
    let longTasks = 0;
    let blockingMs = 0;
    let maxTaskMs = 0;
    const observer = typeof PerformanceObserver !== "undefined" ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            longTasks += 1;
            blockingMs += Math.max(0, entry.duration - 50);
            maxTaskMs = Math.max(maxTaskMs, entry.duration);
        }
    }) : null;
    try {
        observer?.observe({ type: "longtask", buffered: false });
    } catch {
        // No long-task timing in this browser: frame gaps still tell.
    }
    let frames = 0;
    let slow = 0;
    let maxGap = 0;
    let last = performance.now();
    let running = true;
    const tick = (now: number) => {
        if (!running) return;
        const gap = now - last;
        last = now;
        frames += 1;
        if (gap > 50) slow += 1;
        maxGap = Math.max(maxGap, gap);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return {
        stop() {
            running = false;
            observer?.disconnect();
            return { longTasks, blockingMs: Math.round(blockingMs), maxTaskMs: Math.round(maxTaskMs), maxFrameGapMs: Math.round(maxGap), slowFrameShare: frames > 0 ? slow / frames : 0 };
        },
    };
}

export interface BenchResult {
    engine: string;
    ui?: BenchResponsiveness;
    seconds: number;
    bytes: number;
    container: string;
    encoder: string;
    durationSeconds: number;
    warnings: string[];
    base64?: string;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function progressLogger(started: number) {
    let last = 0;
    return (progress: ExportProgress) => {
        const now = performance.now();
        if (now - last < 2000 && progress.ratio < 1) return;
        last = now;
        console.log(`[bench-progress] ${JSON.stringify({ phase: progress.phase, ratio: progress.ratio, elapsed: (now - started) / 1000 })}`);
    };
}

async function runExport(spec: BenchSpec, signal?: AbortSignal): Promise<BenchResult> {
    const started = performance.now();
    const ui = sampleResponsiveness();
    const media = { resolveMediaUrl: (url: string) => url };
    const streaming = spec.worker !== false && opfsAvailable();
    const gpu = createBrowserGpuExport(media, {
        codecs: spec.codecs, opfs: streaming, ...(spec.worker !== false ? { worker: { create: () => new GpuExportWorker(), opfs: streaming } } : {}),
    });
    const runner = createWasmRunner({
        readMedia: createFetchMediaReader(media), coreBaseUrl: `${location.origin}/ffmpeg-core`,
        ...(streaming ? { streamMux: { loadMediabunny: () => gpu.loadMediabunny(), createOutput: createOpfsOutput } } : {}),
    });
    try {
        const result = await exportTimeline(spec.input, { resolution: spec.resolution, ...(spec.format ? { format: spec.format } : {}) }, {
            runner, rasterizer: createBrowserRasterizer(), onProgress: progressLogger(started), signal,
            ...(spec.engine === "gpu" ? { gpu } : { engine: "ffmpeg" as const }),
        });
        const bytes = result.output.kind === "bytes" ? result.output.data : result.output.kind === "blob" && spec.keepOutput ? new Uint8Array(await result.output.blob.arrayBuffer()) : null;
        const size = result.output.kind === "bytes" ? result.output.data.byteLength : result.output.kind === "blob" ? result.output.blob.size : 0;
        if (result.output.kind === "blob" && result.output.opfsName) await removeOpfsExport(result.output.opfsName);
        return {
            engine: result.engine === "gpu" ? `gpu/${result.encoder}` : "ffmpeg.wasm", seconds: (performance.now() - started) / 1000, bytes: size, container: result.container,
            encoder: result.encoder, durationSeconds: result.durationSeconds, warnings: result.warnings.map((w) => w.code === "gpu-fallback" ? `gpu-fallback: ${w.message}` : w.code),
            base64: spec.keepOutput && bytes ? toBase64(bytes) : undefined,
            ui: ui.stop(),
        };
    } finally {
        ui.stop();
        runner.dispose();
    }
}

const bench = {
    /** mediabunny, for experiments in the bench page. */
    mediabunny: () => createBrowserGpuExport({ resolveMediaUrl: (url: string) => url }).loadMediabunny(),
    /** A full clip row from a create input (the optimistic constructor the editor uses). */
    clip(input: Record<string, unknown>, id: string) {
        return optimistic.optimisticTimelineClipFromInput(input, "bench", id);
    },
    /** Starts an export and cancels it after `ms`; resolves with the error code ("cancelled") or "finished". */
    async runCancelled(spec: BenchSpec, ms: number): Promise<string> {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        try {
            await runExport(spec, controller.signal);
            return "finished";
        } catch (error) {
            return (error as { code?: string }).code ?? String(error);
        }
    },
    async run(spec: BenchSpec): Promise<BenchResult> {
        try {
            return await runExport(spec);
        } catch (error) {
            // ExportError.detail holds the ffmpeg log tail.
            const detail = (error as { detail?: string }).detail;
            throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail.split("\n").slice(-12).join("\n")}` : ""}`);
        }
    },
};

export function BenchHarness() {
    useEffect(() => {
        Object.assign(window, { __bench: bench });
    }, []);
    return <p className="loading">bench harness ready</p>;
}
