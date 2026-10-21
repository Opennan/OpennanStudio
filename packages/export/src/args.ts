// The ffmpeg command line for an ExportPlan. Runners write the filter graph to a script file
// (Windows command lines cap at 32 767 chars) and pass its path.
import { gifFrameFilters, type EncoderChoice } from "./encoders";
import { sec } from "./format";
import type { AudioMixPlan } from "./compile/audio-mix";
import type { MuxPlan } from "./compile/mux";
import type { ExportPlan } from "./types";

export type FilterScriptFlag = "-filter_complex_script" | "-/filter_complex";

/** ffmpeg 7+ reads `-/filter_complex <file>`; earlier releases (and ffmpeg.wasm 0.12) use -filter_complex_script. */
export function filterScriptFlag(ffmpegMajorVersion: number): FilterScriptFlag {
    return ffmpegMajorVersion >= 7 ? "-/filter_complex" : "-filter_complex_script";
}

/** The plan's graph plus the encoder's tail (hardware upload, GIF palette), if any; the audio sinks for outputs without it. */
export function filterScript(plan: ExportPlan, encoder: EncoderChoice): { script: string; videoPad: string } {
    const sink = encoder.noAudio ? `;\n[${plan.audioLabel}]anullsink` : "";
    if (encoder.videoFilters.length === 0) return { script: `${plan.filterGraph}${sink}`, videoPad: plan.videoLabel };
    return {
        script: `${plan.filterGraph};\n[${plan.videoLabel}]${encoder.videoFilters.join(",")}[venc]${sink}`,
        videoPad: "venc",
    };
}

export interface FfmpegArgsOptions {
    plan: ExportPlan;
    encoder: EncoderChoice;
    /** One path or URL per plan input, in order. */
    inputPaths: string[];
    filterScriptPath: string;
    scriptFlag: FilterScriptFlag;
    outputPath: string;
    /** Machine-readable progress on stdout (native ffmpeg). */
    progressPipe?: boolean;
    /** Input options placed before every input (the node runner's protocol and demuxer whitelists). */
    inputGuards?: string[];
    /** -filter_complex_threads (filterThreadCap); omitted = ffmpeg's default (one per core). */
    filterThreads?: number;
    /** Decoder threads per input (inputThreadCap); omitted = ffmpeg's default. */
    inputThreads?: number;
}

/** Threads ffmpeg may create for one export's scalers (each gets its own pool); macOS allows 4096 per process. */
const FILTER_THREAD_BUDGET = 2048;

/**
 * -filter_complex_threads for a graph: FFmpeg 7 gives every scale filter (including the auto-inserted format
 * converters, about one per input) a swscale pool of this many threads, so large projects ran out of threads
 * ("Failed to configure output pad on auto_scale_N"). Small graphs keep every core.
 */
export function filterThreadCap(filterGraph: string, inputCount: number, cpus: number): number {
    // Every `format=` may get an auto-inserted converter with its own pool too (a 40-scene graph has about 870).
    const scalers = (filterGraph.match(/(^|[,;\]])\s*scale=/g)?.length ?? 0) + (filterGraph.match(/(^|[,;\]])\s*format=/g)?.length ?? 0) + inputCount;
    return Math.max(1, Math.min(Math.max(1, cpus), Math.floor(FILTER_THREAD_BUDGET / Math.max(1, scalers))));
}

/** Decoder threads all inputs of one export may use together (each input's decoder has its own pool). */
const INPUT_THREAD_BUDGET = 1024;

/**
 * Decoder threads per input for a large graph, or undefined when ffmpeg's default (about one per core per decoder)
 * fits: a 40-scene project opens about 150 inputs, and their decoders' threads plus the scalers' pools passed
 * macOS's 4096 threads per process ("Resource temporarily unavailable").
 */
export function inputThreadCap(inputCount: number, cpus: number): number | undefined {
    if (inputCount * (Math.max(1, cpus) + 1) <= INPUT_THREAD_BUDGET) return undefined;
    return Math.max(1, Math.min(Math.max(1, cpus), Math.floor(INPUT_THREAD_BUDGET / Math.max(1, inputCount))));
}

export function buildFfmpegArgs(options: FfmpegArgsOptions): string[] {
    const { plan, encoder } = options;
    if (options.inputPaths.length !== plan.inputs.length) throw new Error("one input path per plan input");
    const { videoPad } = filterScript(plan, encoder);
    return [
        // ffmpeg.wasm reports progress only through log lines, which "error" would hide.
        "-hide_banner", "-y", "-loglevel", options.progressPipe ? "error" : "info",
        ...encoder.globalArgs,
        ...(options.filterThreads ? ["-filter_complex_threads", String(options.filterThreads)] : []),
        ...plan.inputs.flatMap((input, i) => [
            ...(options.inputGuards ?? []), ...(options.inputThreads ? ["-threads", String(options.inputThreads)] : []), ...input.options, "-i", options.inputPaths[i],
        ]),
        options.scriptFlag, options.filterScriptPath,
        "-map", `[${videoPad}]`,
        ...(encoder.noAudio ? [] : ["-map", `[${plan.audioLabel}]`]),
        ...encoder.videoArgs,
        "-r", String(plan.format.fps),
        ...(encoder.noAudio ? ["-an"] : encoder.audioArgs),
        "-t", sec(plan.durationSeconds),
        ...(encoder.container === "mp4" ? ["-movflags", "+faststart"] : []),
        ...(options.progressPipe ? ["-progress", "pipe:1", "-nostats"] : []),
        options.outputPath,
    ];
}

export interface FrameArgsOptions {
    plan: ExportPlan;
    inputPaths: string[];
    filterScriptPath: string;
    scriptFlag: FilterScriptFlag;
    outputPath: string;
    /** Timeline seconds of the frame. */
    seconds: number;
    /** Pad to write: frameFilterScript(...).videoPad. Default plan.videoLabel. */
    videoPad?: string;
    inputGuards?: string[];
}

/**
 * The filter script for a single frame: the plan's graph, an optional scale, and `[aout]anullsink`
 * (a frame has no audio output, and ffmpeg refuses a graph with an unconnected pad). Write `script`
 * to the file passed as filterScriptPath and map `videoPad`.
 */
export function frameFilterScript(plan: ExportPlan, size?: { width: number; height: number }): { script: string; videoPad: string } {
    const scale = size ? `;\n[${plan.videoLabel}]scale=${size.width}:${size.height}[frame]` : "";
    return { script: `${plan.filterGraph}${scale};\n[${plan.audioLabel}]anullsink`, videoPad: size ? "frame" : plan.videoLabel };
}

/** One PNG frame of the plan's video at `seconds` (output seek: frame-exact, decodes from the start). Use with frameFilterScript. */
export function buildFrameArgs(options: FrameArgsOptions): string[] {
    const { plan } = options;
    if (options.inputPaths.length !== plan.inputs.length) throw new Error("one input path per plan input");
    return [
        "-hide_banner", "-y", "-loglevel", "error",
        ...plan.inputs.flatMap((input, i) => [...(options.inputGuards ?? []), ...input.options, "-i", options.inputPaths[i]]),
        options.scriptFlag, options.filterScriptPath,
        "-map", `[${options.videoPad ?? plan.videoLabel}]`,
        "-ss", sec(options.seconds),
        "-frames:v", "1", "-an", "-c:v", "png", "-f", "image2", "-update", "1",
        options.outputPath,
    ];
}

export interface AudioMixArgsOptions {
    plan: AudioMixPlan;
    /** One path per plan input, in order. */
    inputPaths: string[];
    filterScriptPath: string;
    scriptFlag: FilterScriptFlag;
    outputPath: string;
    /** Default 16000 (what whisper.cpp reads). */
    sampleRate?: number;
    inputGuards?: string[];
    progressPipe?: boolean;
}

/** ffmpeg arguments that render an AudioMixPlan to mono 16-bit PCM WAV. */
export function buildAudioMixArgs(options: AudioMixArgsOptions): string[] {
    const { plan } = options;
    if (options.inputPaths.length !== plan.inputs.length) throw new Error("one input path per plan input");
    return [
        "-hide_banner", "-y", "-loglevel", "error",
        ...plan.inputs.flatMap((input, i) => [...(options.inputGuards ?? []), ...input.options, "-i", options.inputPaths[i]]),
        options.scriptFlag, options.filterScriptPath,
        "-map", `[${plan.audioLabel}]`,
        "-ac", "1", "-ar", String(options.sampleRate ?? 16000), "-c:a", "pcm_s16le",
        "-t", sec(plan.durationSeconds),
        ...(options.progressPipe ? ["-progress", "pipe:1", "-nostats"] : []),
        "-f", "wav", options.outputPath,
    ];
}

/**
 * Audio encoder arguments for a mux into `container`: AAC in MP4, Opus in WebM. FFmpeg's own Opus encoder first
 * (flagged experimental, hence -strict -2): libopus in the ffmpeg.wasm 0.12 core crashes ("memory access out of
 * bounds"), and the desktop's LGPL build has no libopus.
 */
export function muxAudioArgs(container: "mp4" | "webm" | "mkv", kbps: number, available?: ReadonlySet<string>): string[] {
    const rate = ["-b:a", `${kbps}k`, "-ar", "48000", "-ac", "2"];
    if (container !== "webm") return ["-c:a", "aac", ...rate];
    if (available && !available.has("opus") && available.has("libopus")) return ["-c:a", "libopus", ...rate];
    return ["-c:a", "opus", "-strict", "-2", ...rate];
}

export interface MuxArgsOptions {
    plan: MuxPlan;
    container: "mp4" | "webm" | "mkv";
    /** muxAudioArgs(…) for the container. */
    audioArgs: string[];
    /** One path per plan input, in order; inputPaths[0] is the pre-encoded video. */
    inputPaths: string[];
    filterScriptPath: string;
    scriptFlag: FilterScriptFlag;
    outputPath: string;
    progressPipe?: boolean;
    inputGuards?: string[];
}

/**
 * ffmpeg arguments that put a pre-encoded video (input 0, stream-copied) next to the timeline's mixed audio:
 * the GPU export path's last step. The audio graph is compileMux's (the export's own audio chain).
 */
export function buildMuxArgs(options: MuxArgsOptions): string[] {
    const { plan } = options;
    if (options.inputPaths.length !== plan.inputs.length) throw new Error("one input path per plan input");
    return [
        "-hide_banner", "-y", "-loglevel", options.progressPipe ? "error" : "info",
        ...plan.inputs.flatMap((input, i) => [...(options.inputGuards ?? []), ...input.options, "-i", options.inputPaths[i]]),
        options.scriptFlag, options.filterScriptPath,
        "-map", "0:v:0", "-c:v", "copy",
        "-map", `[${plan.audioLabel}]`, ...options.audioArgs,
        "-t", sec(plan.durationSeconds),
        ...(options.container === "mp4" ? ["-movflags", "+faststart"] : []),
        ...(options.progressPipe ? ["-progress", "pipe:1", "-nostats"] : []),
        options.outputPath,
    ];
}

export interface AudioTrackArgsOptions {
    /** An audioOnlyPlan(…): every input is audio media. */
    plan: MuxPlan;
    audioArgs: string[];
    inputPaths: string[];
    filterScriptPath: string;
    scriptFlag: FilterScriptFlag;
    /** An .m4a (AAC) or .webm (Opus) path. */
    outputPath: string;
}

/** ffmpeg arguments that render the export's mixed audio alone (the streaming web mux adds the video packets). */
export function buildAudioTrackArgs(options: AudioTrackArgsOptions): string[] {
    const { plan } = options;
    if (options.inputPaths.length !== plan.inputs.length) throw new Error("one input path per plan input");
    return [
        "-hide_banner", "-y", "-loglevel", "info",
        ...plan.inputs.flatMap((input, i) => [...input.options, "-i", options.inputPaths[i]]),
        options.scriptFlag, options.filterScriptPath,
        "-map", `[${plan.audioLabel}]`, ...options.audioArgs, "-vn",
        "-t", sec(plan.durationSeconds),
        options.outputPath,
    ];
}

/** The GIF step of the GPU export path (phase 10d): a video encoded elsewhere becomes the GIF. */
export interface GifPlan {
    format: { width: number; height: number; fps: number };
    durationSeconds: number;
}

/**
 * Pass 1 of the GIF step: one palette for the whole clip (palettegen over every frame) as a PNG. Two passes over the
 * small intermediate keep memory bounded (a split graph would queue every frame until the palette is ready); the
 * palette and the dithered frames equal the one-graph chain the ffmpeg path runs (gifEncoder).
 */
export function buildGifPaletteArgs(options: { plan: GifPlan; inputPath: string; outputPath: string; progressPipe?: boolean; inputGuards?: string[] }): string[] {
    return [
        "-hide_banner", "-y", "-loglevel", options.progressPipe ? "error" : "info",
        ...(options.inputGuards ?? []), "-i", options.inputPath,
        "-vf", [...gifFrameFilters(options.plan.format), "palettegen"].join(","),
        "-t", sec(options.plan.durationSeconds),
        "-frames:v", "1", "-update", "1",
        ...(options.progressPipe ? ["-progress", "pipe:1", "-nostats"] : []),
        options.outputPath,
    ];
}

/** Pass 2 of the GIF step: the frames dithered with the palette, written by the gif muxer looping forever, no audio. */
export function buildGifArgs(options: { plan: GifPlan; inputPath: string; palettePath: string; outputPath: string; progressPipe?: boolean; inputGuards?: string[] }): string[] {
    const guards = options.inputGuards ?? [];
    return [
        "-hide_banner", "-y", "-loglevel", options.progressPipe ? "error" : "info",
        ...guards, "-i", options.inputPath, ...guards, "-i", options.palettePath,
        "-lavfi", `[0:v]${gifFrameFilters(options.plan.format).join(",")}[gifx];[gifx][1:v]paletteuse`,
        "-c:v", "gif", "-loop", "0", "-an",
        "-t", sec(options.plan.durationSeconds),
        ...(options.progressPipe ? ["-progress", "pipe:1", "-nostats"] : []),
        options.outputPath,
    ];
}
