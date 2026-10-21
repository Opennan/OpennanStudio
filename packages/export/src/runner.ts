// The contract every export runner implements (native ffmpeg in Node, ffmpeg.wasm in browsers).
import type { GifPlan } from "./args";
import type { EncoderChoice, EncoderOptions, ExportContainer } from "./encoders";
import type { MuxPlan } from "./compile/mux";
import type { GlFrameProcessor } from "./gl";
import type { AudioMixPlan } from "./compile/audio-mix";
import type { ExportPlan, ExportResolution, MediaInfo } from "./types";

export interface RunOptions {
    signal?: AbortSignal;
    /** 0..1 */
    onProgress?(ratio: number): void;
    /** Runs plan.glPasses (runners with supportsGl only). */
    glProcessor?: GlFrameProcessor;
}

/**
 * The finished file: a path (native runner), bytes in memory, or a Blob backed by disk (the web's streaming mux
 * writes to the origin private file system; `opfsName` names that file so the host can delete it once delivered).
 */
export type ExportOutput = { kind: "file"; path: string } | { kind: "bytes"; data: Uint8Array } | { kind: "blob"; blob: Blob; opfsName?: string };

/**
 * A video stream encoded elsewhere (the GPU export path): its bytes, or a file the HOST created (never a path
 * taken from project data or an untrusted caller; the node runner opens it without the media source policy).
 */
export type MuxVideo = { kind: "bytes"; data: Uint8Array } | { kind: "file"; path: string } | { kind: "blob"; blob: Blob; opfsName?: string };

export interface MuxOptions {
    /** The video's container; a mux output has the same one (a GIF step reads it). */
    container: Exclude<ExportContainer, "gif">;
    signal?: AbortSignal;
    /** 0..1 */
    onProgress?(ratio: number): void;
}

export interface ExportRunner {
    readonly kind: "node" | "wasm";
    /** Can run GL passes when given a GlFrameProcessor. */
    readonly supportsGl: boolean;
    readonly maxResolution: ExportResolution;
    /** Probe results by URL; unreadable media is left out of the map. */
    probe(urls: string[], signal?: AbortSignal): Promise<Map<string, MediaInfo>>;
    chooseEncoder(options: EncoderOptions, signal?: AbortSignal): Promise<EncoderChoice>;
    run(plan: ExportPlan, encoder: EncoderChoice, options?: RunOptions): Promise<ExportOutput>;
    /** One PNG frame of the plan at `seconds`, scaled to `size` when given (read API previewFrame). */
    renderFrame?(plan: ExportPlan, seconds: number, options?: { size?: { width: number; height: number }; signal?: AbortSignal }): Promise<Uint8Array>;
    /** Stream-copies `video` next to the plan's mixed audio (compileMux) into the final file (GPU export path). */
    mux?(plan: MuxPlan, video: MuxVideo, options: MuxOptions): Promise<ExportOutput>;
    /** Turns `video` (encoded elsewhere, in `options.container`) into the GIF (GPU export path, phase 10d). */
    gif?(plan: GifPlan, video: MuxVideo, options: MuxOptions): Promise<ExportOutput>;
    /** Renders an AudioMixPlan to a mono PCM WAV file at `outputPath` (native runners; transcription input). */
    renderAudio?(plan: AudioMixPlan, outputPath: string, options?: { sampleRate?: number; signal?: AbortSignal; onProgress?(ratio: number): void }): Promise<void>;
}
