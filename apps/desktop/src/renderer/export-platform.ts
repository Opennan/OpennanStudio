// The desktop export platform for the editor shell. Exports started here (the dialog and the editor's own
// export.start) take the GPU path when they can (phase 10c): this window renders every frame with the preview's
// WebGL2 renderer and encodes it with WebCodecs (hardware H.264 in Electron), streams the encoded file to main in
// chunks, and main adds the audio with the bundled LGPL ffmpeg. Projects the GPU path cannot take run on main's
// native ffmpeg export, whose state this view mirrors. Agents' exports (MCP assemble_video → export.start) land
// here too, so they take the GPU path by the same rules; this window reports the job's progress and failures to
// main (numbers, enums, a short message), which answers get_export_status, and stops the job when main asks.
import {
    ExportError, exportTimelineGpu, gpuExportReadiness, type ExportFormatKind, type ExportInput, type ExportResolution, type ExportRunner, type ExportSessionState,
    type GlFrameProcessor, type GpuExportOptions, type MuxVideo,
} from "@opennan/export";
import { createBrowserGpuExport, createBrowserRasterizer } from "@opennan/export/web";
import GpuExportWorker from "@opennan/export/gpu-worker?worker";
import { createWebGlFrameProcessor } from "@opennan/export/web-gl";
import type { ExportEnginePreview, ExportPlatform, PlatformExporter } from "@opennan/web/studio";
import type { ControllerSnapshot, EffectDef, TimelineBackend } from "@opennan/timeline-core";
import type { MediaEnvironment } from "@opennan/timeline-media";
import type { DesktopBridge, GpuJobErrorReport, GpuJobProgressReport, GpuVideoCodec } from "../shared/bridge";

const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;

/** Slices of a worker-encoded video sent to main (bounded memory per IPC call). */
export const UPLOAD_SLICE_BYTES = 4 * 2 ** 20;

/** localStorage key of the developer worker override: "off" renders the GPU export in this window (the 10c path). */
export const EXPORT_WORKER_STORAGE_KEY = "opennan-studio:export-worker";

export function exportWorkerEnabled(storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): boolean {
    try {
        return typeof Worker !== "undefined" && storage?.getItem(EXPORT_WORKER_STORAGE_KEY) !== "off";
    } catch {
        return true;
    }
}

const FORMAT = { mp4: "MP4 (H.264, AAC)", webm: "WebM (VP9, Opus)" } as const;
const GIF_FORMAT = "GIF (no audio, loops)";

function inputOf(snapshot: ControllerSnapshot, effects: EffectDef[]): ExportInput {
    return {
        project: {
            aspectRatio: snapshot.project?.aspectRatio ?? "16:9",
            musicUrl: snapshot.project?.musicUrl ?? null,
            musicVolume: snapshot.project?.musicVolume ?? 1,
        },
        tracks: snapshot.tracks,
        clips: snapshot.clips,
        scenes: snapshot.scenes,
        effects,
    };
}

/**
 * Catalog GLSL effects on the GPU path (phase 10d): the regl processor main's native export uses, created in this
 * window on the first frame that needs it, so those projects no longer leave the fast path.
 */
function lazyGlProcessor(): GlFrameProcessor {
    let processor: GlFrameProcessor | null = null;
    return {
        process: (frame, effects) => (processor ??= createWebGlFrameProcessor()).process(frame, effects),
        dispose: () => processor?.dispose?.(),
    };
}

export interface DesktopExportPlatformOptions {
    /**
     * GPU export options for a media environment; null turns the GPU path off. Default createBrowserGpuExport, run in a
     * worker (phase 10d) so the editor stays responsive; the worker streams the encoded video to disk (OPFS) and this
     * window uploads it to main in slices before main adds the audio.
     */
    gpu?: ((media: MediaEnvironment) => GpuExportOptions) | null;
    /** The GPU export run (tests replace it). Default exportTimelineGpu. */
    exportGpu?: typeof exportTimelineGpu;
    /** At most one progress report to main per this many ms (phase changes always go). Default 250. */
    progressIntervalMs?: number;
}

const GPU_CODECS: readonly GpuVideoCodec[] = ["avc", "vp9", "av1", "vp8"];
const ERROR_CODES: ReadonlyArray<GpuJobErrorReport["code"]> = [
    "empty-timeline", "resolution-unsupported", "no-encoder", "media-read-failed", "ffmpeg-failed", "too-large", "core-unavailable", "no-audio",
    "runner-unsupported", "cancelled", "unknown",
];
/** Main's limit for the message (shared/ipc.ts MAX_GPU_ERROR_MESSAGE). */
const MAX_ERROR_MESSAGE = 2000;

function errorReport(error: unknown): GpuJobErrorReport {
    const code = (error as { code?: unknown } | null)?.code;
    return {
        code: ERROR_CODES.includes(code as never) ? (code as GpuJobErrorReport["code"]) : "unknown",
        message: (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE),
    };
}

/** Progress as main accepts it: a finite ratio in 0..1 and a finite, non-negative ETA (else none). */
function progressReport(progress: { phase: string; ratio: number; etaSeconds?: number }): GpuJobProgressReport | null {
    if (progress.phase !== "probe" && progress.phase !== "raster" && progress.phase !== "render" && progress.phase !== "mux") return null;
    const ratio = Number.isFinite(progress.ratio) ? Math.min(1, Math.max(0, progress.ratio)) : 0;
    const eta = progress.etaSeconds;
    return { phase: progress.phase, ratio, ...(eta !== undefined && Number.isFinite(eta) && eta >= 0 ? { etaSeconds: eta } : {}) };
}

export function createDesktopExportPlatform(bridge: Pick<DesktopBridge, "exports">, options: DesktopExportPlatformOptions = {}): ExportPlatform {
    const gpuFor = options.gpu === undefined
        ? (media: MediaEnvironment) => createBrowserGpuExport(media, {
            glProcessor: lazyGlProcessor(),
            ...(exportWorkerEnabled() ? { worker: { create: () => new GpuExportWorker(), opfs: true } } : {}),
        })
        : options.gpu;
    const exportGpu = options.exportGpu ?? exportTimelineGpu;
    const progressInterval = options.progressIntervalMs ?? 250;
    return {
        resolutions: ["720p", "1080p", "4k"],
        formats: ["video", "gif"],
        formatLabel: "MP4 (H.264, AAC)",
        resolutionNote: null,
        gl: true,
        createExporter(media: MediaEnvironment): PlatformExporter {
            const gpu = gpuFor ? gpuFor(media) : null;
            let mainState: ExportSessionState = { status: "idle" };
            // The GPU job's state while this window owns the export; null: mirror main.
            let local: ExportSessionState | null = null;
            let controller: AbortController | null = null;
            // Main's id of the GPU job this window renders (its cancel requests name it).
            let gpuJob: string | null = null;
            // The id agents got for main's export this window started (an export.cancel naming another id is refused).
            let mainJob: string | null = null;
            const listeners = new Set<() => void>();
            const notify = () => listeners.forEach((listener) => listener());
            const stop = bridge.exports.onState((state) => {
                mainState = state;
                if (!local || local.status !== "running") {
                    if (state.status !== "idle") local = null;
                    notify();
                }
            });
            // A cancel that reached main (an agent host, main's cancel route) for the job this window renders.
            const stopCancel = bridge.exports.onGpuCancel((jobId) => {
                if (jobId && jobId === gpuJob) controller?.abort();
            });
            void bridge.exports.state().then((current) => {
                if (mainState.status === "idle") {
                    mainState = current;
                    notify();
                }
            }).catch(() => undefined);
            const setLocal = (next: ExportSessionState | null) => {
                local = next;
                notify();
            };
            const running = () => (local ?? mainState).status === "running";

            /** The GPU export of one job: render here, stream to main, main muxes. Falls back to main's export. */
            async function runGpu(jobId: string, input: ExportInput, resolution: ExportResolution, format: ExportFormatKind) {
                const abort = new AbortController();
                controller = abort;
                gpuJob = jobId;
                setLocal({ status: "running", progress: { phase: "probe", ratio: 0, engine: "gpu" } });
                // Main's job state (agents' get_export_status): every phase change, else one report per interval.
                let reported: { phase: string; at: number } | null = null;
                const report = (progress: { phase: string; ratio: number; etaSeconds?: number }) => {
                    const clean = progressReport(progress);
                    if (!clean) return;
                    const now = Date.now();
                    if (reported && reported.phase === clean.phase && now - reported.at < progressInterval) return;
                    reported = { phase: clean.phase, at: now };
                    void bridge.exports.gpuProgress(jobId, clean).catch(() => undefined);
                };
                /** Main finishes the job from its own snapshot (the audio mux, or the GIF step); Cancel ends it there too. */
                const finish = async (signal: AbortSignal | undefined): Promise<{ kind: "file"; path: string }> => {
                    if (signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                    // Cancel while main finishes: end the job there (its ffmpeg is stopped) and settle now.
                    const cancelled = new Promise<never>((_resolve, reject) => {
                        signal?.addEventListener("abort", () => {
                            void bridge.exports.gpuAbort(jobId).catch(() => undefined);
                            reject(new ExportError("cancelled", "Export cancelled."));
                        }, { once: true });
                    });
                    const { path } = await Promise.race([bridge.exports.gpuMux(jobId), cancelled]);
                    return { kind: "file", path };
                };
                /**
                 * A video the worker encoded (to disk, or in its memory) reaches main here, in slices, before main finishes
                 * the job; a video this window encoded was already streamed chunk by chunk ({ kind: "file", path: "main" }).
                 */
                const upload = async (video: MuxVideo, signal: AbortSignal | undefined) => {
                    if (video.kind === "file") return;
                    const size = video.kind === "bytes" ? video.data.byteLength : video.blob.size;
                    for (let position = 0; position < size; position += UPLOAD_SLICE_BYTES) {
                        if (signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                        const end = Math.min(size, position + UPLOAD_SLICE_BYTES);
                        // slice(), not subarray(): a cloned view would carry its whole buffer over IPC.
                        const bytes = video.kind === "bytes" ? video.data.slice(position, end) : new Uint8Array(await video.blob.slice(position, end).arrayBuffer());
                        await bridge.exports.gpuChunk(jobId, position, bytes);
                    }
                };
                // The runner here only finishes jobs, and main does that from the job's own snapshot.
                const runner: ExportRunner = {
                    kind: "node",
                    supportsGl: false,
                    maxResolution: "4k",
                    probe: async () => new Map(),
                    chooseEncoder: async () => {
                        throw new Error("the GPU export encodes in the window"); // i18n-ignore
                    },
                    run: async () => {
                        throw new Error("the GPU export encodes in the window"); // i18n-ignore
                    },
                    mux: async (_plan, video, mux) => {
                        await upload(video, mux.signal);
                        return finish(mux.signal);
                    },
                    // GIF jobs (phase 10d): main makes the GIF from the streamed video, sized from the job's own snapshot.
                    gif: async (_plan, video, gif) => {
                        await upload(video, gif.signal);
                        return finish(gif.signal);
                    },
                };
                const writable = new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
                    write: (chunk) => bridge.exports.gpuChunk(jobId, chunk.position, chunk.data),
                });
                try {
                    const outcome = await exportGpu(input, format === "gif" ? { resolution, format } : { resolution }, {
                        runner,
                        rasterizer: createBrowserRasterizer(),
                        signal: abort.signal,
                        onProgress: (progress) => {
                            if (controller !== abort) return;
                            setLocal({ status: "running", progress: { ...progress, engine: "gpu" } });
                            report(progress);
                        },
                        gpu: {
                            ...gpu!,
                            createVideoSink: () => ({
                                writable,
                                done: async () => ({ kind: "file", path: "main" }),
                                abort: async () => {
                                    await writable.abort().catch(() => undefined);
                                },
                            }),
                        },
                    });
                    if (outcome.kind === "done") {
                        setLocal({ status: "done", result: outcome.result });
                        return;
                    }
                    // The GPU path cannot take this project after all: main's native export runs it from the job's own
                    // snapshot (agents keep following the gpu- id), and Cancel goes there.
                    if (controller === abort) controller = null;
                    gpuJob = null;
                    setLocal(null);
                    const started = await bridge.exports.gpuFallback(jobId);
                    // Agents keep following the gpu- id while main runs it (export.cancel names it).
                    mainJob = `gpu-${jobId}`;
                    if ("error" in started && started.error) setLocal({ status: "error", code: "unknown", message: started.error });
                } catch (error) {
                    const cancelled = abort.signal.aborted || (error as { code?: string }).code === "cancelled";
                    const failure = cancelled ? null : errorReport(error);
                    await (failure ? bridge.exports.gpuAbort(jobId, failure) : bridge.exports.gpuAbort(jobId)).catch(() => undefined);
                    if (!failure) setLocal({ status: "cancelled" });
                    else setLocal({ status: "error", code: failure.code, message: error instanceof Error ? error.message : String(error) });
                } finally {
                    if (controller === abort) controller = null;
                    if (gpuJob === jobId) gpuJob = null;
                }
            }

            // Claimed before the first await, so a double click cannot open two jobs.
            let starting = false;
            async function startExport(options: Record<string, unknown>, snapshot: ControllerSnapshot, backend: TimelineBackend | null) {
                if (starting || running()) return { error: "An export is already running." };
                starting = true;
                try {
                    return await startExportNow(options, snapshot, backend);
                } finally {
                    starting = false;
                }
            }

            async function startExportNow(options: Record<string, unknown>, snapshot: ControllerSnapshot, backend: TimelineBackend | null) {
                const resolution = (options.resolution === "720p" || options.resolution === "4k" ? options.resolution : "1080p") as ExportResolution;
                // Phase 10d: an animated GIF instead of a video file (main validates the option again).
                if (options.format !== undefined && options.format !== "video" && options.format !== "gif") return { error: "format must be video or gif." };
                const format: ExportFormatKind = options.format === "gif" ? "gif" : "video";
                const request = format === "gif" ? { resolution, format } : { resolution };
                if (gpu) {
                    const effects = backend?.listEffects ? await backend.listEffects("effect").catch(() => []) : [];
                    const input = inputOf(snapshot, effects);
                    const ready = await gpuExportReadiness(input, request, gpu).catch(() => ({ ok: false as const, reason: "" }));
                    if (ready.ok) {
                        const codec = GPU_CODECS.find((name) => name === ready.choice.codec);
                        const begun = await bridge.exports.gpuBegin(request, snapshot, ready.choice.container, codec);
                        if ("error" in begun) return { error: begun.error };
                        void runGpu(begun.jobId, input, resolution, format);
                        return { jobId: `gpu-${begun.jobId}` };
                    }
                }
                const started = await bridge.exports.start(request, snapshot);
                if ("jobId" in started && started.jobId) mainJob = started.jobId;
                return started;
            }

            return {
                session: {
                    getState: () => local ?? mainState,
                    subscribe(listener) {
                        listeners.add(listener);
                        return () => listeners.delete(listener);
                    },
                    cancel: () => {
                        if (controller) controller.abort();
                        else void bridge.exports.cancel();
                    },
                    reset: () => {
                        if (local && local.status !== "running") setLocal(null);
                        void bridge.exports.reset();
                    },
                },
                async engine(input, resolution, format = "video"): Promise<ExportEnginePreview> {
                    const label = (video: string) => (format === "gif" ? GIF_FORMAT : video);
                    const compatible = (reason?: string): ExportEnginePreview => ({ engine: "ffmpeg", formatLabel: label("MP4 (H.264, AAC)"), reason, nativeSpeed: true, gl: true });
                    if (!gpu) return compatible();
                    const ready = await gpuExportReadiness(input, format === "gif" ? { resolution, format } : { resolution }, gpu);
                    // Catalog GLSL effects render on the GPU path when this window has a GL processor (phase 10d).
                    return ready.ok ? { engine: "gpu", formatLabel: label(FORMAT[ready.choice.container]), nativeSpeed: true, gl: Boolean(gpu.glProcessor) } : compatible(ready.reason);
                },
                async start({ controller: timeline, resolution, format }) {
                    const result = await timeline.execute({ type: "export.start", options: format === "gif" ? { resolution, format } : { resolution } });
                    if (!result.ok) throw new Error(result.error ?? "The export did not start.");
                },
                commandHandler: (backend, show) => Object.assign(async (options: Record<string, unknown>, snapshot: ControllerSnapshot) => {
                    show();
                    return startExport(options, snapshot, backend);
                }, {
                    /** export.cancel (phase 10d): this window's GPU job, else main's running export. */
                    async cancel(jobId: string | undefined) {
                        if (controller && gpuJob) {
                            const running = `gpu-${gpuJob}`;
                            if (jobId && jobId !== running) return { error: `Export ${jobId} is not the running export (${running}).` };
                            controller.abort();
                            return { jobId: running };
                        }
                        if (mainState.status !== "running") return { error: "No export is running." };
                        if (jobId && jobId !== mainJob) return { error: `Export ${jobId} is not the running export${mainJob ? ` (${mainJob})` : ""}.` };
                        await bridge.exports.cancel();
                        return mainJob ? { jobId: mainJob } : {};
                    },
                }),
                async deliver(result) {
                    if (result.output.kind !== "file") throw new Error("desktop exports are written to files");
                    const file = result.output.path;
                    const { size } = await bridge.exports.fileInfo(file);
                    return { fileName: baseName(file), path: file, size };
                },
                reveal(delivery) {
                    if (delivery.path) void bridge.exports.reveal(delivery.path);
                },
                dispose: () => {
                    controller?.abort();
                    stop();
                    stopCancel();
                },
            };
        },
    };
}
