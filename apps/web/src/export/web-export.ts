// Local export for the web app: @opennan/export on ffmpeg.wasm (spec §5.8, §7.1). Replaces the phase 3
// interim export (flattened V-lanes, trim + concat).
import {
    createExportSession, gpuExportReadiness, type ExportFormatKind, type ExportInput, type ExportResolution, type ExportResult, type ExportSession, type ExportSessionState,
    type GpuExportOptions,
} from "@opennan/export";
import {
    DEFAULT_FFMPEG_CORE_BASE, createBrowserGpuExport, createBrowserRasterizer, createFetchMediaReader, createOpfsOutput, createWasmRunner, opfsAvailable,
    removeOpfsExport, sweepOpfsExports,
} from "@opennan/export/web";
import GpuExportWorker from "@opennan/export/gpu-worker?worker";
import type { ControllerSnapshot, ExportCommandOutcome, TimelineBackend } from "@opennan/timeline-core";
import type { MediaEnvironment } from "@opennan/timeline-media";
import type {
    ExportCommandHandler as PlatformCommandHandler, ExportDelivery, ExportEnginePreview, ExportPlatform, PlatformExporter,
} from "../platform/export-platform";
import { GIF_FORMAT_LABEL, exportFileNameFor, exportInputFromSnapshot, loadEffectCatalog } from "./export-input";

/**
 * The ffmpeg.wasm core (GPL-2.0-or-later) is served next to the app from ./ffmpeg-core/ (dev and preview:
 * vite-ffmpeg-core.ts; deploys: scripts/copy-ffmpeg-core.mjs), never copied into dist/ or the JS bundle,
 * and SHA-256-checked before it runs. VITE_FFMPEG_CORE_BASE may point elsewhere (UNPKG_FFMPEG_CORE_BASE
 * as an opt-in fallback that needs network).
 */
export const FFMPEG_CORE_BASE: string = import.meta.env.VITE_FFMPEG_CORE_BASE ?? `.${DEFAULT_FFMPEG_CORE_BASE}`;

/**
 * libx264 stays off until the spec §12 legal review: spec §3 only clears an LGPL ffmpeg, and x264 brings
 * GPL and H.264 patent obligations. A build opts in with VITE_WEB_EXPORT_ALLOW_GPL=true. Without it the
 * wasm core encodes MPEG-4 Part 2 in MP4 and the result carries an `encoder-fallback` warning.
 */
export const WEB_EXPORT_ALLOW_GPL: boolean = import.meta.env.VITE_WEB_EXPORT_ALLOW_GPL === "true";

/** ffmpeg.wasm keeps every input in memory; 4K belongs to the desktop app. */
export const WEB_EXPORT_RESOLUTIONS: readonly ExportResolution[] = ["720p", "1080p"];

/** The dialog's format line before an export runs. */
export function webExportFormatLabel(allowGpl: boolean = WEB_EXPORT_ALLOW_GPL): string {
    return allowGpl ? "MP4 (H.264, AAC)" : "MP4 (MPEG-4 Part 2, AAC)";
}

/** localStorage key of the developer engine override: "ffmpeg" forces the compatible export, "gpu" is the default. */
export const EXPORT_ENGINE_STORAGE_KEY = "opennan-studio:export-engine";

export function exportEngineOverride(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): "gpu" | "ffmpeg" | null {
    try {
        const value = storage?.getItem(EXPORT_ENGINE_STORAGE_KEY);
        return value === "gpu" || value === "ffmpeg" ? value : null;
    } catch {
        return null;
    }
}

/** localStorage key of the developer worker override: "off" runs the GPU export on the page (phase 10d default: a worker). */
export const EXPORT_WORKER_STORAGE_KEY = "opennan-studio:export-worker";

export function exportWorkerEnabled(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): boolean {
    try {
        return storage?.getItem(EXPORT_WORKER_STORAGE_KEY) !== "off";
    } catch {
        return true;
    }
}

/** The format line of a GPU export by codec. */
export function gpuFormatLabel(codec: string): string {
    return { avc: "MP4 (H.264, AAC)", vp9: "WebM (VP9, Opus)", av1: "WebM (AV1, Opus)", vp8: "WebM (VP8, Opus)" }[codec] ?? "MP4 (H.264, AAC)";
}

export interface WebExporter {
    session: ExportSession;
    /** The engine the next export of `input` will use (the dialog's engine line). */
    engine?(input: ExportInput, resolution: ExportResolution, format?: ExportFormatKind): Promise<ExportEnginePreview>;
    dispose(): void;
}

export interface WebExporterOptions {
    /** GPU export options; null turns the GPU path off. Default createBrowserGpuExport(media) in a worker, streaming through OPFS. */
    gpu?: GpuExportOptions | null;
    /** Default exportEngineOverride(). */
    engineOverride?: "gpu" | "ffmpeg" | null;
    /** Run the GPU export in a worker. Default exportWorkerEnabled() where module workers exist. */
    worker?: boolean;
    /** Stream the encoded video and the final file through the origin private file system. Default opfsAvailable(). */
    opfs?: boolean;
}

export function createWebExporter(media: MediaEnvironment, coreBaseUrl: string = FFMPEG_CORE_BASE, options: WebExporterOptions = {}): WebExporter {
    const opfs = options.opfs ?? opfsAvailable();
    const useWorker = (options.worker ?? exportWorkerEnabled()) && typeof Worker !== "undefined";
    // The fast path: WebGL2 compositing (the preview's renderer) and WebCodecs encoding in a worker, the encoded video
    // streamed to disk (OPFS); ffmpeg.wasm only renders the audio, and mediabunny writes the final file to disk too.
    const override = options.engineOverride === undefined ? exportEngineOverride() : options.engineOverride;
    const gpu = override === "ffmpeg" ? null : options.gpu === undefined
        ? createBrowserGpuExport(media, { opfs, ...(useWorker ? { worker: { create: () => new GpuExportWorker(), opfs } } : {}) })
        : options.gpu;
    const runner = createWasmRunner({
        // Auth headers only for the media environment's own origin; unfetchable URLs become media-unreadable.
        readMedia: createFetchMediaReader(media),
        coreBaseUrl,
        ...(opfs && gpu ? { streamMux: { loadMediabunny: () => gpu.loadMediabunny(), createOutput: createOpfsOutput } } : {}),
    });
    // Files a closed tab or a crash left in the exports folder.
    if (opfs) void sweepOpfsExports();
    const session = createExportSession({ runner, rasterizer: createBrowserRasterizer({ media }), allowGpl: WEB_EXPORT_ALLOW_GPL, ...(gpu ? { gpu } : { engine: "ffmpeg" as const }) });
    const compatible = (reason?: string): ExportEnginePreview => ({ engine: "ffmpeg", formatLabel: webExportFormatLabel(), reason, nativeSpeed: false, gl: false });
    return {
        session,
        async engine(input, resolution, format = "video") {
            if (!gpu) return compatible(override === "ffmpeg" ? "the compatible export is selected" : undefined);
            const ready = await gpuExportReadiness(input, { resolution, format }, gpu);
            if (!ready.ok) return compatible(ready.reason);
            return { engine: "gpu", formatLabel: format === "gif" ? GIF_FORMAT_LABEL : gpuFormatLabel(ready.choice.codec), nativeSpeed: true, gl: false };
        },
        dispose: () => disposeExporter(session, runner),
    };
}

/** Leaving the editor mid-export stops it (the worker, its decoders, and its files), then frees ffmpeg.wasm. */
export function disposeExporter(session: Pick<ExportSession, "getState" | "cancel">, runner: { dispose(): void }): void {
    if (session.getState().status === "running") session.cancel();
    runner.dispose();
}

/** How long a delivered export's OPFS file outlives the dialog (a download may still be reading it). */
export const DELIVERED_FILE_GRACE_MS = 10 * 60 * 1000;

export function exportBlob(result: ExportResult): Blob {
    // A streamed export is already a file on disk (OPFS): hand it over without copying it into memory.
    if (result.output.kind === "blob") return result.output.blob.type === result.mimeType ? result.output.blob : new Blob([result.output.blob], { type: result.mimeType });
    if (result.output.kind !== "bytes") throw new Error("web exports are returned as bytes");
    return new Blob([new Uint8Array(result.output.data)], { type: result.mimeType });
}

export interface ExportCommandHandler extends PlatformCommandHandler {
    (options: Record<string, unknown>, snapshot: ControllerSnapshot): Promise<ExportCommandOutcome>;
    /** State of a job started through export.start; null for unknown ids (phase 5 exposes this as a read tool). */
    status(jobId: string): ExportSessionState | null;
}

/** TimelineProvider onExport: `export.start` from agents opens the dialog and runs the same export. */
export function createExportCommandHandler(exporter: WebExporter, backend: TimelineBackend, show: () => void): ExportCommandHandler {
    const jobs = new Map<string, ExportSessionState>();
    let current: string | null = null;
    let starting = false;
    exporter.session.subscribe(() => {
        if (!current) return;
        const state = exporter.session.getState();
        jobs.set(current, state);
        if (state.status !== "running") current = null;
    });
    const handler = (async (options, snapshot) => {
        // Checked and claimed before the first await, so two quick calls cannot both start an export.
        if (starting || exporter.session.getState().status === "running") return { error: "An export is already running." };
        starting = true;
        try {
            const resolution: ExportResolution = options.resolution === "1080p" ? "1080p" : "720p";
            // Phase 10d: an animated GIF instead of a video file.
            const format = options.format ?? "video";
            if (format !== "video" && format !== "gif") return { error: "format must be video or gif." };
            const effects = await loadEffectCatalog(backend);
            const jobId = `local-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            current = jobId;
            show();
            // start() never rejects (session contract); it reports progress and the result through state.
            void exporter.session.start(exportInputFromSnapshot(snapshot, effects), format === "gif" ? { resolution, format } : { resolution });
            jobs.set(jobId, exporter.session.getState());
            return { jobId };
        } finally {
            starting = false;
        }
    }) as ExportCommandHandler;
    handler.status = (jobId) => jobs.get(jobId) ?? null;
    handler.cancel = async (jobId) => {
        if (exporter.session.getState().status !== "running") return { error: "No export is running." };
        // A job id must name the running export (one started from the dialog has none).
        if (jobId && jobId !== current) return { error: `Export ${jobId} is not the running export${current ? ` (${current})` : ""}.` };
        const running = current;
        exporter.session.cancel();
        return running ? { jobId: running } : {};
    };
    return handler;
}

export interface WebExportPlatformOptions {
    coreBaseUrl?: string;
    createObjectUrl?(blob: Blob): string;
    revokeObjectUrl?(url: string): void;
    /** Starts a download of `url` as `fileName` (an <a download> click by default). */
    click?(url: string, fileName: string): void;
}

function clickDownload(url: string, fileName: string): void {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
}

/** The web export platform: the GPU path (WebGL2 + WebCodecs) or ffmpeg.wasm in the tab, up to 1080p, a download at the end. */
export function createWebExportPlatform(options: WebExportPlatformOptions = {}): ExportPlatform {
    const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
    const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
    const click = options.click ?? clickDownload;
    return {
        resolutions: WEB_EXPORT_RESOLUTIONS,
        formats: ["video", "gif"],
        formatLabel: webExportFormatLabel(),
        resolutionNote: "4K needs the desktop app",
        gl: false,
        nativeSpeed: false,
        createExporter(media: MediaEnvironment): PlatformExporter {
            const exporter = createWebExporter(media, options.coreBaseUrl);
            return {
                session: exporter.session,
                engine: exporter.engine,
                async start({ controller, backend, resolution, format }) {
                    const input = exportInputFromSnapshot(controller.snapshot(), await loadEffectCatalog(backend));
                    await exporter.session.start(input, format === "gif" ? { resolution, format } : { resolution });
                },
                commandHandler: (backend, show) => createExportCommandHandler(exporter, backend, show),
                async deliver(result, projectName): Promise<ExportDelivery> {
                    const blob = exportBlob(result);
                    const delivery: ExportDelivery = {
                        fileName: exportFileNameFor(projectName, result), size: blob.size, url: createObjectUrl(blob),
                        ...(result.output.kind === "blob" && result.output.opfsName ? { opfsName: result.output.opfsName } : {}),
                    };
                    click(delivery.url!, delivery.fileName);
                    return delivery;
                },
                release(delivery) {
                    if (delivery.url) revokeObjectUrl(delivery.url);
                    // The streamed file outlives the dialog for a while: a download that started from it may still be
                    // reading it (browsers read disk-backed blobs lazily). The next exporter's sweep is the backstop.
                    const name = delivery.opfsName;
                    if (name) setTimeout(() => void removeOpfsExport(name), DELIVERED_FILE_GRACE_MS);
                },
                dispose: () => exporter.dispose(),
            };
        },
    };
}
