// exportTimeline: probe → rasterize text → compile → choose encoder → run.
import { checkAborted, untilAborted } from "./abort";
import { compileExport, collectMediaUrls, exportFormat, exportLength } from "./compile";
import { containerMimeType, gifEncoder, type ExportContainer } from "./encoders";
import type { GlFrameProcessor } from "./gl";
import { resolutionWithin } from "./presets";
import type { OverlayRasterizer } from "./raster/canvas-rasterizer";
import { planGraphicsJobs, planRasterJobs } from "./raster/jobs";
import type { ExportOutput, ExportRunner } from "./runner";
import { playableClips } from "./timeline-model";
import { DEFAULT_AUDIO_BITRATE_KBPS, RESOLUTION_BITRATE_KBPS } from "./presets";
import { ExportError, type ExportInput, type ExportSettings, type ExportWarning, type RasterResult } from "./types";
import { exportTimelineGpu, type GpuExportOptions } from "./gpu/gpu-export";

export interface ExportProgress {
    /** ffmpeg path: probe → raster → encode. GPU path: probe → raster → render (frames) → mux (audio), or → gif (palette). */
    phase: "probe" | "raster" | "encode" | "render" | "mux" | "gif";
    /** 0..1 within the phase. */
    ratio: number;
    /** Seconds left in the long phase (encode or render), once there is enough progress to tell. */
    etaSeconds?: number;
    engine?: ExportEngine;
}

/** "gpu": WebGL2 compositor + WebCodecs (gpu/gpu-export.ts); "ffmpeg": the filter-graph export. */
export type ExportEngine = "gpu" | "ffmpeg";

export interface ExportTimelineOptions {
    runner: ExportRunner;
    /**
     * Draws text and emoji bitmaps. Optional: without one (a headless node host), text and emoji clips are
     * left out with a `text-unsupported` warning. In Electron main, pass createRemoteRasterizer (remote.ts).
     */
    rasterizer?: OverlayRasterizer;
    /** GL effects run only with a processor on a runner that supports them. */
    glProcessor?: GlFrameProcessor;
    /** Allow GPL encoders (libx264). Default false. */
    allowGpl?: boolean;
    /**
     * The GPU export path (browser hosts): used when the browser and the project allow it, else the ffmpeg path
     * runs with a `gpu-fallback` notice. `engine: "ffmpeg"` forces the ffmpeg path (a developer override).
     */
    gpu?: GpuExportOptions;
    engine?: ExportEngine;
    signal?: AbortSignal;
    onProgress?(progress: ExportProgress): void;
}

export interface ExportResult {
    output: ExportOutput;
    container: ExportContainer;
    mimeType: string;
    encoder: string;
    durationSeconds: number;
    width: number;
    height: number;
    warnings: ExportWarning[];
    engine: ExportEngine;
}

/** Adds an ETA to the long phases' progress (ratio over elapsed time), unless the path already gives one. */
function withEta(onProgress: ExportTimelineOptions["onProgress"]): ExportTimelineOptions["onProgress"] {
    if (!onProgress) return undefined;
    let phase: string | null = null;
    let started = 0;
    return (progress) => {
        const now = Date.now();
        if (progress.phase !== phase) {
            phase = progress.phase;
            started = now;
        }
        if (progress.etaSeconds !== undefined || (progress.phase !== "encode" && progress.phase !== "render")) return onProgress(progress);
        const elapsed = (now - started) / 1000;
        const etaSeconds = progress.ratio > 0.02 && elapsed > 1 ? (elapsed / progress.ratio) * (1 - progress.ratio) : undefined;
        onProgress({ ...progress, etaSeconds });
    };
}

export async function exportTimeline(input: ExportInput, settings: ExportSettings, given: ExportTimelineOptions): Promise<ExportResult> {
    const options: ExportTimelineOptions = { ...given, onProgress: withEta(given.onProgress) };
    const { runner, signal } = options;
    if (!resolutionWithin(settings.resolution, runner.maxResolution)) {
        throw new ExportError("resolution-unsupported", `This runner exports up to ${runner.maxResolution}.`);
    }
    let gpuFallback: string | null = null;
    if (options.gpu && options.engine !== "ffmpeg") {
        const outcome = await exportTimelineGpu(input, settings, { ...options, gpu: options.gpu });
        if (outcome.kind === "done") return outcome.result;
        gpuFallback = outcome.reason;
        checkAborted(signal);
    }
    const report = options.onProgress;
    options.onProgress = report ? (progress) => report({ ...progress, engine: "ffmpeg" }) : undefined;
    options.onProgress?.({ phase: "probe", ratio: 0 });
    const media = await runner.probe(collectMediaUrls(input), signal);
    checkAborted(signal);

    const format = exportFormat(input, settings);
    const rasters = new Map<string, RasterResult>();
    const { rasterizer } = options;
    if (rasterizer) {
        const clips = playableClips(input.clips, input.tracks);
        const jobs = [...planRasterJobs(clips, format), ...planGraphicsJobs(clips, format, exportLength(input, format).frameCount)];
        for (const [i, job] of jobs.entries()) {
            options.onProgress?.({ phase: "raster", ratio: i / Math.max(1, jobs.length) });
            rasters.set(job.id, await untilAborted(rasterizer.rasterize(job), signal));
            checkAborted(signal);
        }
    }

    const gl = runner.supportsGl && Boolean(options.glProcessor);
    // ffmpeg.wasm runs geq effects far slower than native ffmpeg: long ones warn (slow-web-effect).
    const plan = compileExport(input, settings, { media, rasters, gl, nativeSpeed: runner.kind !== "wasm" });
    // A GIF (phase 10d) is written by ffmpeg's own gif encoder after the palette filters; there is nothing to choose.
    const encoder = settings.format === "gif" ? gifEncoder(plan.format) : await runner.chooseEncoder({
        videoBitrateKbps: settings.videoBitrateKbps ?? RESOLUTION_BITRATE_KBPS[settings.resolution],
        audioBitrateKbps: settings.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS,
        allowGpl: options.allowGpl,
    }, signal);
    checkAborted(signal);
    const warnings = [...plan.warnings];
    if (gpuFallback) {
        warnings.unshift({ code: "gpu-fallback", message: `Fast export is not available for this project here (${gpuFallback}); it uses the compatible export, which is slower.` });
    }
    if (encoder.name === "mpeg4" || encoder.container === "webm") {
        warnings.push({
            code: "encoder-fallback",
            message: `No H.264 encoder is available here without GPL code, so this file is ${encoder.container === "webm" ? "VP9 WebM" : "MPEG-4 Part 2 in MP4"}. Export from the desktop app for H.264.`,
        });
    }
    options.onProgress?.({ phase: "encode", ratio: 0 });
    // Runners kill their work on abort; untilAborted is the backstop so a cancelled export always settles.
    const output = await untilAborted(runner.run(plan, encoder, {
        signal,
        glProcessor: gl ? options.glProcessor : undefined,
        onProgress: (ratio) => options.onProgress?.({ phase: "encode", ratio }),
    }), signal);
    return {
        output,
        container: encoder.container,
        mimeType: containerMimeType(encoder.container),
        encoder: encoder.name,
        durationSeconds: plan.durationSeconds,
        width: plan.format.width,
        height: plan.format.height,
        warnings,
        engine: "ffmpeg",
    };
}
