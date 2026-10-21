// Which projects the GPU export path renders. Phase 10c listed features it could not draw (the project then ran on
// the ffmpeg path with a `gpu-fallback` notice naming the first reason). Since phase 10d the GPU path draws every
// feature the ffmpeg path draws: the legacy blur slider, chroma key, and blend modes (LookRenderer legacy passes),
// reverse playback (bounded reverse reads), animated GIFs (ImageDecoder with ffmpeg's GIF timing), and catalog GLSL
// effects through the host's GlFrameProcessor — without one (the web), they are left out with the same
// `gl-effect-unsupported` warning ffmpeg.wasm gives, as that engine cannot draw them either. The ffmpeg fallback
// now only runs without WebGL2/WebCodecs, for media WebCodecs cannot decode, or after a failure (gpu-export.ts).
import type { ExportInput } from "../types";

/** A feature the GPU path cannot draw. None since phase 10d; kept so hosts that list reasons keep compiling. */
export type GpuFallbackCode = never;

export interface GpuFallbackReason {
    code: GpuFallbackCode;
    message: string;
    clipId?: string;
    sceneId?: string;
}

export interface GpuSupport {
    ok: boolean;
    reasons: GpuFallbackReason[];
}

export interface GpuSupportOptions {
    /** A GlFrameProcessor is available for legacy catalog (GLSL) effects (without one they are left out with a warning). */
    gl: boolean;
}

export function gpuExportSupport(_input: ExportInput, _options: GpuSupportOptions): GpuSupport {
    return { ok: true, reasons: [] };
}
