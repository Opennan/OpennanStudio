// The desktop MediaPreparer (phase 11, Decision 2): an AI tool names a range of the project's media, and main makes
// the file the tool's destination takes from the media library with the bundled LGPL ffmpeg. Only imported media
// (opennan-local:// / opennan-media://) resolves, through the export's source policy (real paths under the media
// root, local protocols and plain media demuxers only); the renderer cannot name https links or paths. Audio is
// decoded to mono WAV at the asked rate (or AAC when the destination prefers it or WAV would pass its size cap);
// video is always re-encoded with the working H.264 encoder: a stream copy starts at the previous key frame and
// would send (and bill) more than the range. The prepared bytes are read into memory and the temp folder is removed
// before they are returned, so nothing is left on disk whatever happens to the upload.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mixTimelineAudio, type EncoderChoice, type ExportInput, type ExportRunner, type MediaInfo } from "@opennan/export";
import { chooseWorkingEncoder, createNodeRunner, createSourcePolicy, probeFile, runProcess, type NodeRunnerOptions, type SourcePolicy } from "@opennan/export/node";
import { minPixelsSize, type MediaPrepareInput, type MediaPreparePurpose, type MediaPreparer, type MediaSourceRef, type PreparedMedia } from "@opennan/provider-sdk";
import type { ControllerSnapshot } from "@opennan/timeline-core";
import { SnapshotSchema } from "../../shared/ipc";
import { localMediaId } from "../../shared/media-policy";
import { MEDIA_EXTENSIONS } from "../../shared/media-types";
import type { FfmpegPaths } from "../export/ffmpeg-paths";
import type { MediaStore } from "../store/media-store";

export const MEDIA_SOURCE_REFUSED = "Only media imported into this project can be sent to an AI tool.";
export const MEDIA_SOURCE_MISSING = "This media is no longer in the media library.";
export const FFMPEG_MISSING_FOR_AI = "AI tools need the bundled ffmpeg, which is missing from this build.";
/** Prepared video for a cloud tool: enough for 1080p sources, well under the tools' 200 MB caps for their lengths. */
export const PREPARED_VIDEO_KBPS = 8000;
export const PREPARED_AUDIO_KBPS = 192;

const MB = 1024 * 1024;
const WAV_HEADER_BYTES = 44;

/** Where the range starts and how long it runs (absent: to the end of the media). */
export interface MediaRange {
    startSeconds: number;
    durationSeconds?: number;
}

/** A prepared file on disk (whisper reads a path); cleanup() removes its folder. */
export interface PreparedFile {
    path: string;
    contentType: string;
    filename: string;
    sizeBytes: number;
    durationSeconds?: number;
    width?: number;
    height?: number;
    cleanup(): Promise<void>;
}

export interface DesktopMediaPreparerOptions {
    ffmpeg: FfmpegPaths | null;
    mediaStore: Pick<MediaStore, "pathOf" | "root">;
    /** Where temp folders go (default the OS temp dir). */
    tempDir?: string;
    /** Tests: replace the ffmpeg process, the probe, the encoder choice, and the timeline runner. */
    run?: typeof runProcess;
    probe?(file: string, signal: AbortSignal): Promise<MediaInfo | null>;
    chooseEncoder?(): Promise<EncoderChoice>;
    createRunner?(options: NodeRunnerOptions): ExportRunner;
}

export interface DesktopMediaPreparer {
    /** For the providers in main (OpenNan, fal): the prepared bytes, nothing left on disk. */
    prepareMedia: MediaPreparer;
    /** The prepared file itself (on-device whisper); the caller runs cleanup(). */
    prepareFile(input: MediaPrepareInput, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedFile>;
    /** The media-library path of a project media URL; throws for anything else. */
    resolveSource(mediaUrl: string): Promise<string>;
    /** Options placed before every ffmpeg input (the source policy's whitelists). */
    inputGuards: string[];
    /** The source's length (ffprobe), or null. */
    mediaDuration(file: string, signal: AbortSignal): Promise<number | null>;
    /** The source's facts (ffprobe: length, streams, pixel size), or null. */
    mediaInfo(file: string, signal: AbortSignal): Promise<MediaInfo | null>;
    /** The working video encoder (chosen once). */
    encoder(): Promise<EncoderChoice>;
}

/** The export input of a controller snapshot (apps/web exportInputFromSnapshot, without effects: audio only). */
export function audioInputFromSnapshot(snapshot: ControllerSnapshot): ExportInput {
    return {
        project: {
            aspectRatio: snapshot.project?.aspectRatio ?? "16:9",
            musicUrl: snapshot.project?.musicUrl ?? null,
            musicVolume: snapshot.project?.musicVolume ?? 1,
        },
        tracks: snapshot.tracks,
        clips: snapshot.clips,
        scenes: snapshot.scenes,
    };
}

const seconds = (value: number) => String(Math.round(value * 1e6) / 1e6);

/** The range to prepare: the asked one (or from its start to the media's end), cut to the destination's length. */
export function preparedRange(source: MediaSourceRef, mediaDuration: number | null, maxSeconds?: number): MediaRange {
    const start = source.startSeconds ?? 0;
    const end = source.endSeconds ?? mediaDuration ?? undefined;
    let duration = end === undefined ? undefined : end - start;
    if (maxSeconds !== undefined) duration = duration === undefined ? maxSeconds : Math.min(duration, maxSeconds);
    if (duration !== undefined && !(duration > 0)) throw new Error("The media range is empty.");
    return duration === undefined ? { startSeconds: start } : { startSeconds: start, durationSeconds: duration };
}

function rangeArgs(range: MediaRange): string[] {
    return [...(range.startSeconds > 0 ? ["-ss", seconds(range.startSeconds)] : []), ...(range.durationSeconds !== undefined ? ["-t", seconds(range.durationSeconds)] : [])];
}

const HEAD = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];

export interface AudioArgsOptions {
    input: string;
    inputGuards: string[];
    range: MediaRange;
    sampleRate: number;
    codec: "wav" | "aac";
    output: string;
}

/** The range's first audio stream as mono 16-bit WAV, or AAC in MP4 (stereo, for stem separation). */
export function audioArgs(options: AudioArgsOptions): string[] {
    const encode = options.codec === "wav"
        ? ["-ac", "1", "-ar", String(options.sampleRate), "-c:a", "pcm_s16le", "-f", "wav"]
        : ["-ac", "2", "-ar", String(options.sampleRate), "-c:a", "aac", "-b:a", `${PREPARED_AUDIO_KBPS}k`, "-movflags", "+faststart", "-f", "mp4"];
    return [
        ...HEAD, ...options.inputGuards, ...rangeArgs(options.range), "-i", options.input,
        "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", ...encode, options.output,
    ];
}

/** `filters`, then even sizes (4:2:0 encoders refuse odd ones), then the encoder's own filters (hardware upload). */
export function videoFilterGraph(filters: string[], encoder: EncoderChoice): string {
    return [...filters, "scale=trunc(iw/2)*2:trunc(ih/2)*2", ...encoder.videoFilters].join(",");
}

export interface VideoArgsOptions {
    input: string;
    inputGuards: string[];
    range: MediaRange;
    encoder: EncoderChoice;
    keepAudio: boolean;
    output: string;
    /** Filters before the size fix (stabilize: deshake). */
    filters?: string[];
    /** -progress pipe:1 key=value lines on stdout. */
    progress?: boolean;
}

/** The range re-encoded with `encoder` (never a stream copy); the audio dropped unless kept. */
export function videoArgs(options: VideoArgsOptions): string[] {
    const { encoder } = options;
    const webm = encoder.container === "webm";
    // FFmpeg's own Opus encoder in WebM: the LGPL build has no libopus.
    const audio = webm ? ["-c:a", "opus", "-strict", "-2", "-b:a", `${PREPARED_AUDIO_KBPS}k`, "-ar", "48000", "-ac", "2"] : encoder.audioArgs;
    return [
        ...HEAD, ...encoder.globalArgs, ...options.inputGuards, ...rangeArgs(options.range), "-i", options.input,
        "-map", "0:v:0", ...(options.keepAudio ? ["-map", "0:a:0?"] : []),
        "-vf", videoFilterGraph(options.filters ?? [], encoder), ...encoder.videoArgs,
        ...(options.keepAudio ? audio : ["-an"]), "-sn", "-dn", "-map_metadata", "-1",
        ...(webm ? [] : ["-movflags", "+faststart"]),
        ...(options.progress ? ["-progress", "pipe:1", "-nostats"] : []),
        options.output,
    ];
}

/** One frame (at startSeconds) as PNG. */
export function imageArgs(options: { input: string; inputGuards: string[]; startSeconds?: number; output: string }): string[] {
    return [
        ...HEAD, ...options.inputGuards, ...(options.startSeconds ? ["-ss", seconds(options.startSeconds)] : []), "-i", options.input,
        "-frames:v", "1", "-map_metadata", "-1", "-c:v", "png", "-f", "image2", options.output,
    ];
}

const tooLarge = (maxBytes: number) => new Error(`The prepared file is larger than the ${Math.round(maxBytes / MB)} MB this tool takes.`);

export function createDesktopMediaPreparer(options: DesktopMediaPreparerOptions): DesktopMediaPreparer {
    const run = options.run ?? runProcess;
    const policy: SourcePolicy = createSourcePolicy({
        mediaRoots: [options.mediaStore.root],
        resolveSource: (url) => {
            const id = localMediaId(url);
            return id ? options.mediaStore.pathOf(id) : null;
        },
    });
    const ffmpeg = () => {
        if (!options.ffmpeg) throw new Error(FFMPEG_MISSING_FOR_AI);
        return options.ffmpeg;
    };
    const probe = (file: string, signal: AbortSignal) => (options.probe ? options.probe(file, signal) : probeFile(ffmpeg().ffprobePath, file, signal, policy.inputGuards).catch(() => null));
    let chosen: Promise<EncoderChoice> | null = null;
    const encoder = () => {
        chosen ??= (options.chooseEncoder ?? (() => chooseWorkingEncoder(ffmpeg().ffmpegPath, { videoBitrateKbps: PREPARED_VIDEO_KBPS, audioBitrateKbps: PREPARED_AUDIO_KBPS })))()
            .catch((error: unknown) => {
                chosen = null;
                throw error;
            });
        return chosen;
    };

    async function resolveSource(mediaUrl: string): Promise<string> {
        const id = localMediaId(mediaUrl);
        if (!id) throw new Error(MEDIA_SOURCE_REFUSED);
        const file = await policy.resolve(mediaUrl);
        if (!file) throw new Error(MEDIA_SOURCE_MISSING);
        return file;
    }

    async function mediaDuration(file: string, signal: AbortSignal): Promise<number | null> {
        const info = await probe(file, signal);
        return info && info.durationSeconds > 0 ? info.durationSeconds : null;
    }

    async function ffmpegRun(args: string[], signal: AbortSignal) {
        const result = await run(ffmpeg().ffmpegPath, args, { signal });
        if (result.code !== 0) throw new Error("ffmpeg could not prepare the media for this tool.");
    }

    /** Runs `make` in a fresh temp folder; the folder goes away on any failure. */
    async function inTemp(make: (dir: string) => Promise<Omit<PreparedFile, "cleanup">>): Promise<PreparedFile> {
        const dir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-prepare-"));
        const cleanup = () => rm(dir, { recursive: true, force: true });
        try {
            return { ...(await make(dir)), cleanup };
        } catch (error) {
            await cleanup();
            throw error;
        }
    }

    async function measured(file: string, range: MediaRange | null, signal: AbortSignal, maxBytes: number) {
        const sizeBytes = (await stat(file)).size;
        if (sizeBytes > maxBytes) throw tooLarge(maxBytes);
        const info = await probe(file, signal);
        const length = Math.max(info?.durationSeconds ?? 0, range?.durationSeconds ?? 0);
        return {
            sizeBytes,
            ...(length > 0 ? { durationSeconds: length } : {}),
            ...(info?.width ? { width: info.width } : {}),
            ...(info?.height ? { height: info.height } : {}),
        };
    }

    async function prepareAudio(file: string, source: MediaSourceRef, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedFile> {
        const rate = purpose.sampleRate ?? 16_000;
        const range = preparedRange(source, source.endSeconds === undefined ? await mediaDuration(file, signal) : null, purpose.maxSeconds);
        const wavBytes = range.durationSeconds === undefined ? 0 : WAV_HEADER_BYTES + Math.ceil(range.durationSeconds * rate) * 2;
        const aacBytes = range.durationSeconds === undefined ? 0 : Math.ceil(((range.durationSeconds + 1) * PREPARED_AUDIO_KBPS * 1000) / 8 * 1.05);
        // The destination's preferred type that fits (WAV's size is known before anything runs).
        const codec = purpose.contentTypes.map((type) => (type === "audio/wav" ? "wav" : type === "audio/mp4" ? "aac" : null))
            .find((c) => c !== null && (c === "wav" ? wavBytes : aacBytes) <= purpose.maxBytes);
        if (!codec) throw tooLarge(purpose.maxBytes);
        return inTemp(async (dir) => {
            const output = path.join(dir, codec === "wav" ? "audio.wav" : "audio.m4a");
            await ffmpegRun(audioArgs({ input: file, inputGuards: policy.inputGuards, range, sampleRate: rate, codec, output }), signal);
            const { width: _w, height: _h, ...facts } = await measured(output, range, signal, purpose.maxBytes);
            return { path: output, contentType: codec === "wav" ? "audio/wav" : "audio/mp4", filename: path.basename(output), ...facts };
        });
    }

    async function prepareVideo(file: string, source: MediaSourceRef, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedFile> {
        // The source's own pixel size is reported (the preparer never resizes; odd sizes lose at most one pixel).
        const info = await probe(file, signal);
        const range = preparedRange(source, source.endSeconds === undefined && info && info.durationSeconds > 0 ? info.durationSeconds : null, purpose.maxSeconds);
        const own = info && info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null;
        // Scaled up only to the destination's smallest picture (a reference video's minimum pixels).
        const scaled = own ? minPixelsSize(own.width, own.height, purpose.minPixels) : null;
        const resize = own && scaled && (scaled.width !== own.width || scaled.height !== own.height) ? [`scale=${scaled.width}:${scaled.height}`] : [];
        const size = scaled ?? {};
        const choice = await encoder();
        const contentType = choice.container === "webm" ? "video/webm" : "video/mp4";
        if (!purpose.contentTypes.includes(contentType)) throw new Error(`This tool does not take ${contentType}, the only video this build's encoder (${choice.name}) makes.`);
        return inTemp(async (dir) => {
            const output = path.join(dir, choice.container === "webm" ? "video.webm" : "video.mp4");
            await ffmpegRun(videoArgs({ input: file, inputGuards: policy.inputGuards, range, encoder: choice, keepAudio: purpose.keepAudio === true, output, ...(resize.length > 0 ? { filters: resize } : {}) }), signal);
            return { path: output, contentType, filename: path.basename(output), ...(await measured(output, range, signal, purpose.maxBytes)), ...size };
        });
    }

    async function prepareImage(file: string, source: MediaSourceRef, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedFile> {
        const own = MEDIA_EXTENSIONS[path.extname(file).toLowerCase()];
        if (own?.kind === "image" && purpose.contentTypes.includes(own.mimeType) && (await stat(file)).size <= purpose.maxBytes) {
            const ext = path.extname(file).toLowerCase();
            // The library's own file, read as it is: nothing to clean up.
            const facts = await probe(file, signal);
            return {
                path: file, contentType: own.mimeType, filename: `image${ext === ".jpeg" ? ".jpg" : ext}`, sizeBytes: (await stat(file)).size,
                ...(facts?.width ? { width: facts.width } : {}), ...(facts?.height ? { height: facts.height } : {}),
                cleanup: async () => undefined,
            };
        }
        if (!purpose.contentTypes.includes("image/png")) throw new Error("This tool does not take this image type.");
        return inTemp(async (dir) => {
            const output = path.join(dir, "image.png");
            await ffmpegRun(imageArgs({ input: file, inputGuards: policy.inputGuards, ...(source.startSeconds ? { startSeconds: source.startSeconds } : {}), output }), signal);
            const { durationSeconds: _d, ...facts } = await measured(output, null, signal, purpose.maxBytes);
            return { path: output, contentType: "image/png", filename: "image.png", ...facts };
        });
    }

    async function prepareTimeline(snapshot: unknown, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedFile> {
        if (purpose.output !== "audio") throw new Error("A timeline is prepared as audio only.");
        const paths = ffmpeg();
        const parsed = SnapshotSchema.safeParse(snapshot);
        if (!parsed.success) throw new Error("The timeline snapshot is not valid");
        const runner = (options.createRunner ?? createNodeRunner)({
            ffmpegPath: paths.ffmpegPath,
            ffprobePath: paths.ffprobePath,
            mediaRoots: [options.mediaStore.root],
            resolveSource: (url) => {
                const id = localMediaId(url);
                return id ? options.mediaStore.pathOf(id) : null;
            },
            outputPath: () => {
                throw new Error("AI tools render the timeline's audio only");
            },
        });
        return inTemp(async (dir) => {
            const output = path.join(dir, "timeline.wav");
            const mixed = await mixTimelineAudio(audioInputFromSnapshot(parsed.data as unknown as ControllerSnapshot), { runner, outputPath: output, sampleRate: purpose.sampleRate ?? 16_000, signal });
            if (purpose.maxSeconds !== undefined && mixed.durationSeconds > purpose.maxSeconds) {
                throw new Error(`The timeline is longer than the ${Math.round(purpose.maxSeconds / 60)} minutes this tool takes.`);
            }
            const sizeBytes = (await stat(output)).size;
            if (sizeBytes > purpose.maxBytes) throw tooLarge(purpose.maxBytes);
            return { path: output, contentType: "audio/wav", filename: "timeline.wav", sizeBytes, durationSeconds: mixed.durationSeconds };
        });
    }

    async function prepareFile(input: MediaPrepareInput, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedFile> {
        if (input.kind === "timeline") return prepareTimeline(input.snapshot, purpose, signal);
        const file = await resolveSource(input.source.mediaUrl);
        ffmpeg();
        if (purpose.output === "audio") return prepareAudio(file, input.source, purpose, signal);
        if (purpose.output === "video") return prepareVideo(file, input.source, purpose, signal);
        return prepareImage(file, input.source, purpose, signal);
    }

    return {
        prepareFile,
        resolveSource,
        inputGuards: policy.inputGuards,
        mediaDuration,
        mediaInfo: probe,
        encoder,
        async prepareMedia(input, purpose, signal): Promise<PreparedMedia> {
            const prepared = await prepareFile(input, purpose, signal);
            try {
                const bytes = new Uint8Array(await readFile(prepared.path));
                const { path: _path, cleanup: _cleanup, ...facts } = prepared;
                return { ...facts, data: bytes, sizeBytes: bytes.byteLength };
            } finally {
                await prepared.cleanup();
            }
        },
    };
}
