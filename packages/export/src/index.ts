// Public API of @opennan/export: pure compile (no ffmpeg needed) plus the runner-agnostic pipeline.
// Runners: "@opennan/export/node" (native ffmpeg) and "@opennan/export/web" (ffmpeg.wasm).
export const EXPORT_VERSION = "0.8.0";

export * from "./types";
export {
    CANVAS_PRESETS, EXPORT_RESOLUTIONS, DEFAULT_FPS, DEFAULT_AUDIO_BITRATE_KBPS, RESOLUTION_BITRATE_KBPS,
    parseAspectRatio, resolveOutputFormat, resolutionWithin, GIF_DEFAULT_FPS, GIF_MAX_WIDTH, resolveGifFormat, type CanvasPreset,
} from "./presets";
export { compileExport, collectMediaUrls, staticExportWarnings, exportFormat, type CompileOptions } from "./compile";
export { GPL_ONLY_FILTERS, gplFiltersIn, eqLookup, EQ_PIXEL_FORMATS, pinEqFormats } from "./lgpl-filters";
export { planRasterJobs } from "./raster/jobs";
export { createCanvasRasterizer, type OverlayRasterizer, type CanvasRasterizerOptions, type RasterCanvas } from "./raster/canvas-rasterizer";
export {
    LGPL_H264_ENCODERS, INTERMEDIATE_ENCODER, parseEncoderList, encoderChoice, encoderCandidates, containerMimeType, gifEncoder, gifFrameFilters,
    type EncoderChoice, type EncoderOptions, type ExportContainer,
} from "./encoders";
export {
    buildFfmpegArgs, buildFrameArgs, buildAudioMixArgs, buildMuxArgs, buildGifArgs, buildGifPaletteArgs, type GifPlan, muxAudioArgs, filterThreadCap, inputThreadCap, filterScript, filterScriptFlag, frameFilterScript,
    type FfmpegArgsOptions, type FrameArgsOptions, type AudioMixArgsOptions, type MuxArgsOptions, type FilterScriptFlag,
} from "./args";
export { compileAudioMix, timelineAudioSources, type AudioMixPlan } from "./compile/audio-mix";
export type { AudioSource } from "./audio-model";
export { mixTimelineAudio, type MixTimelineAudioOptions, type MixTimelineAudioResult } from "./mix-audio";
export { parseProgressSeconds, progressRatio } from "./progress";
export { FFPROBE_ARGS, parseFfprobeJson } from "./probe-json";
export { collectGlLayers, planGlPasses, toGlEffectSpec, type GlFrame, type GlFrameProcessor, type GlLayer } from "./gl";
export type { ExportRunner, ExportOutput, MuxOptions, MuxVideo, RunOptions } from "./runner";
export { exportTimeline, type ExportEngine, type ExportProgress, type ExportResult, type ExportTimelineOptions } from "./export-timeline";
export { exportTimelineGpu, gpuExportReadiness, type GpuExportOptions, type GpuExportOutcome, type GpuReadiness } from "./gpu/gpu-export";
export { gpuExportSupport, type GpuFallbackCode, type GpuFallbackReason, type GpuSupport, type GpuSupportOptions } from "./gpu/support";
export { planGpuExport, type DrawOp, type GpuPlan, type LaneOp, type LayerOp, type VideoRead } from "./gpu/plan";
export { chooseGpuCodec, GPU_CODECS, type GpuCodecChoice, type GpuVideoSink } from "./gpu/encode";
export { audioOnlyPlan, compileMux, MUX_VIDEO_SOURCE, type MuxPlan } from "./compile/mux";
export { documentFontSources, exportTimelineGpuInWorker, type GpuWorkerHost, type WorkerOutcome } from "./gpu/worker/client";
export type { PageToWorker, WorkerFontSource, WorkerMediaRequest, WorkerToPage } from "./gpu/worker/protocol";
export { createExportSession, type ExportSession, type ExportSessionOptions, type ExportSessionState } from "./session";
export {
    MAX_FRAME_SIDE, createExportFrameRenderer, frameSize, type ExportFrame, type ExportFrameRequest, type ExportFrameRendererOptions, type FrameSnapshot,
} from "./frame-renderer";
export {
    createRemoteRasterizer, createRemoteGlFrameProcessor, serveOverlayRasterizer, serveGlFrameProcessor, type BridgePort,
} from "./remote";
