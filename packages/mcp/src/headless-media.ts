// Headless media for the phase 11 AI tools (`mcp serve`, Node only): with an ffmpeg, OpenNan media tools get their
// file from a small ffmpeg trim of the project's own media into a temp folder (the provider uploads it), and the local
// analysis (remove_silences, detect_beats) decodes the used range to mono PCM for timeline-core's detectors. Only
// media imported into the project (opennan-local://media/…) is read: agents cannot point ffmpeg at other files or URLs.
// Every ffmpeg input carries the export's source-policy guards (local protocols, plain media demuxers), and the
// output keeps only the stream the tool needs, without metadata (like the desktop preparer).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chooseWorkingEncoder, createSourcePolicy, probeFile, runProcess } from "@opennan/export/node";
import { CapabilityUnavailableError, JobFailedError, type MediaPreparer, type MediaPreparePurpose, type PreparedMedia } from "@opennan/provider-sdk";
import {
    LOCAL_MEDIA_URL_PREFIX, detectBeats, detectSilences, type AnalysisJob, type AnalysisJobOutcome, type BeatOptions, type MediaAnalyzerHost, type SilenceOptions,
} from "@opennan/timeline-core";
import { blobPathFor } from "./project-file";

export const MEDIA_TOOLS_NEED_FFMPEG = "Media tools need ffmpeg (start mcp serve with --ffmpeg) or the desktop app.";
export const ONLY_PROJECT_MEDIA = "Only media imported into the project (opennan-local://media/…) can be prepared here: import the file first (publish_video_to_timeline or publish_audio_to_timeline).";
/** Sample rate of the PCM the detectors read (timeline-react's browser analyzer uses the same). */
export const ANALYSIS_SAMPLE_RATE = 16_000;
/** The longest range the headless analyzer decodes at once (an hour of 16 kHz mono float PCM is 230 MB). */
export const MAX_ANALYSIS_SECONDS = 3600;

export interface HeadlessMediaOptions {
    /** The project's media folder (mediaDirFor). */
    mediaDir: string;
    ffmpeg?: { ffmpegPath: string; ffprobePath: string };
    /** Temp folder parent (default: the OS temp folder). */
    tempDir?: string;
    /** Tests: replace the ffmpeg process and the encoder choice. */
    run?: typeof runProcess;
    chooseEncoder?(): ReturnType<typeof chooseWorkingEncoder>;
}

/** The source policy's options before every ffmpeg input: local protocols only, plain media demuxers only. */
const INPUT_GUARDS = createSourcePolicy({ mediaRoots: [] }).inputGuards;

/** The file behind a project media URL, or null for anything else. */
export function projectMediaPath(mediaDir: string, mediaUrl: string): string | null {
    if (!mediaUrl.startsWith(LOCAL_MEDIA_URL_PREFIX)) return null;
    const id = mediaUrl.slice(LOCAL_MEDIA_URL_PREFIX.length);
    return id ? blobPathFor(mediaDir, id) : null;
}

const QUIET = ["-hide_banner", "-nostdin", "-loglevel", "error"];

/** ffmpeg arguments that read only `[start, end)` of one local file (no network, no other protocols, no playlists). */
function inputArgs(file: string, start: number | undefined, end: number | undefined): string[] {
    const range = [
        ...(start !== undefined && start > 0 ? ["-ss", String(start)] : []),
        ...(end !== undefined ? ["-t", String(Math.max(0.001, end - (start ?? 0)))] : []),
    ];
    return [...INPUT_GUARDS, ...range, "-i", file];
}

function unavailableError(message: string): CapabilityUnavailableError {
    const error = new CapabilityUnavailableError("media.process");
    error.message = message;
    return error;
}

/**
 * The MediaPreparer `mcp serve` gives the OpenNan provider. Without an ffmpeg every call fails with
 * MEDIA_TOOLS_NEED_FFMPEG (shown to the agent as "unavailable").
 */
export function createHeadlessMediaPreparer(options: HeadlessMediaOptions): MediaPreparer {
    // The trimmed file is a temporary upload, not a distributed export, so a GPL encoder of the user's own ffmpeg is fine.
    let encoder: ReturnType<typeof chooseWorkingEncoder> | null = null;
    const run = options.run ?? runProcess;
    return async (input, purpose, signal) => {
        const ffmpeg = options.ffmpeg;
        if (!ffmpeg) throw unavailableError(MEDIA_TOOLS_NEED_FFMPEG);
        if (input.kind !== "media") throw unavailableError("Captions of the whole timeline mix need the editor window here; pass clip_id or scene_id.");
        const file = projectMediaPath(options.mediaDir, input.source.mediaUrl);
        if (!file) throw new JobFailedError(ONLY_PROJECT_MEDIA);
        await fs.access(file).catch(() => {
            throw new JobFailedError("The clip's media file is missing from the project's media folder.");
        });
        const start = input.source.startSeconds;
        let end = input.source.endSeconds;
        if (purpose.maxSeconds !== undefined) end = Math.min(end ?? Infinity, (start ?? 0) + purpose.maxSeconds);
        if (end === Infinity) end = undefined;
        const dir = await fs.mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-prepare-"));
        try {
            const choose = options.chooseEncoder ?? (() => chooseWorkingEncoder(ffmpeg.ffmpegPath, { videoBitrateKbps: 8000, audioBitrateKbps: 192, allowGpl: true }));
            const { pre, args, contentType, name } = await outputFor(purpose, () => (encoder ??= choose().catch((error: unknown) => {
                encoder = null;
                throw error;
            })));
            const out = path.join(dir, name);
            const result = await run(ffmpeg.ffmpegPath, [...QUIET, ...pre, ...inputArgs(file, start, end), ...args, "-y", out], { signal });
            if (result.code !== 0) throw new JobFailedError(`ffmpeg could not prepare the media: ${result.stderr.trim().split("\n").pop() ?? "unknown error"}`);
            const data = new Uint8Array(await fs.readFile(out));
            if (data.byteLength > purpose.maxBytes) throw new JobFailedError(`The prepared file is ${Math.ceil(data.byteLength / 1048576)} MB, over the tool's ${Math.floor(purpose.maxBytes / 1048576)} MB limit. Use first_seconds to send less.`);
            const info = await probeFile(ffmpeg.ffprobePath, out, signal, INPUT_GUARDS).catch(() => null);
            const prepared: PreparedMedia = { data, contentType, filename: name, sizeBytes: data.byteLength };
            // The measured length, else the length of the range ffmpeg cut (what the tool is billed on).
            const cut = end !== undefined && purpose.output !== "image" ? end - (start ?? 0) : undefined;
            const length = info && info.durationSeconds > 0 ? info.durationSeconds : cut;
            if (length !== undefined && length > 0) prepared.durationSeconds = length;
            if (purpose.output === "video" && info?.hasVideo && info.width > 0 && info.height > 0) {
                prepared.width = info.width;
                prepared.height = info.height;
            }
            return prepared;
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    };
}

async function outputFor(
    purpose: MediaPreparePurpose,
    videoEncoder: () => ReturnType<typeof chooseWorkingEncoder>,
): Promise<{ pre: string[]; args: string[]; contentType: string; name: string }> {
    // Only the stream the tool takes (the first audio or video stream), no subtitles, data, or metadata.
    const strip = ["-sn", "-dn", "-map_metadata", "-1"];
    if (purpose.output === "audio") {
        const rate = String(purpose.sampleRate ?? 44_100);
        const channels = purpose.sampleRate === 16_000 ? "1" : "2";
        const audio = ["-map", "0:a:0", "-vn", ...strip, "-ac", channels, "-ar", rate];
        if (purpose.contentTypes[0] === "audio/mp4") {
            return { pre: [], args: [...audio, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4"], contentType: "audio/mp4", name: "audio.m4a" };
        }
        return { pre: [], args: [...audio, "-c:a", "pcm_s16le", "-f", "wav"], contentType: "audio/wav", name: "audio.wav" };
    }
    if (purpose.output === "video") {
        const choice = await videoEncoder();
        const audio = purpose.keepAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"];
        // Even dimensions: H.264 encoders refuse odd ones.
        const filters = ["scale=trunc(iw/2)*2:trunc(ih/2)*2", ...choice.videoFilters];
        return {
            pre: choice.globalArgs,
            args: ["-map", "0:v:0", ...(purpose.keepAudio ? ["-map", "0:a:0?"] : []), "-vf", filters.join(","), ...choice.videoArgs, ...audio, ...strip, "-movflags", "+faststart", "-f", "mp4"],
            contentType: "video/mp4", name: "video.mp4",
        };
    }
    return { pre: [], args: ["-map", "0:v:0", "-frames:v", "1", "-map_metadata", "-1", "-f", "image2", "-c:v", "png"], contentType: "image/png", name: "image.png" };
}

/** Decodes `[start, end)` of a project media file to mono float PCM at ANALYSIS_SAMPLE_RATE. */
async function decodePcm(ffmpegPath: string, file: string, start: number, end: number, signal?: AbortSignal): Promise<Float32Array> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "opennan-analyze-"));
    try {
        const out = path.join(dir, "audio.f32");
        const result = await runProcess(ffmpegPath, [...QUIET, ...inputArgs(file, start, end), "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(ANALYSIS_SAMPLE_RATE), "-f", "f32le", "-y", out], { signal });
        if (result.code !== 0) throw new Error(`ffmpeg could not decode the audio: ${result.stderr.trim().split("\n").pop() ?? "unknown error"}`);
        const bytes = await fs.readFile(out);
        const samples = new Float32Array(Math.floor(bytes.byteLength / 4));
        new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.length * 4));
        return samples;
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

/** analysis.run for headless `mcp serve --ffmpeg`: ffmpeg decodes, timeline-core's detectors find silences and beats. */
export function createFfmpegAnalyzer(options: { mediaDir: string; ffmpegPath: string }): MediaAnalyzerHost {
    return {
        async analyze(job: AnalysisJob, context): Promise<AnalysisJobOutcome> {
            const file = projectMediaPath(options.mediaDir, job.mediaUrl);
            if (!file) return { error: ONLY_PROJECT_MEDIA };
            const seconds = job.endSeconds - job.startSeconds;
            if (!(seconds > 0)) return { error: "The clip's used range is empty." };
            if (seconds > MAX_ANALYSIS_SECONDS) return { error: `The used range is ${Math.round(seconds)} s; the headless analyzer takes at most ${MAX_ANALYSIS_SECONDS} s at once. Split the clip first.` };
            let pcm: Float32Array;
            try {
                pcm = await decodePcm(options.ffmpegPath, file, job.startSeconds, job.endSeconds, context.signal);
            } catch (error) {
                if (context.signal?.aborted) return { cancelled: true };
                return { error: error instanceof Error ? error.message : String(error) };
            }
            context.onProgress?.(0.5);
            const shift = <T extends { start: number; end: number }>(r: T) => ({ start: r.start + job.startSeconds, end: r.end + job.startSeconds });
            if (job.kind === "silences") {
                const silences = detectSilences(pcm, ANALYSIS_SAMPLE_RATE, job.options as SilenceOptions).map(shift);
                context.onProgress?.(1);
                return { silences };
            }
            const beats = detectBeats(pcm, ANALYSIS_SAMPLE_RATE, job.options as BeatOptions);
            context.onProgress?.(1);
            return { beats: { bpm: beats.bpm, times: beats.times.map((t) => t + job.startSeconds) } };
        },
    };
}

export interface StorySheetOptions {
    mediaDir: string;
    ffmpeg: { ffmpegPath: string; ffprobePath: string };
    /** Stores the sheet in the project's media and answers its URL. */
    save(file: Blob, name: string): Promise<string>;
    run?: typeof runProcess;
}

/** Story film's copy step on `mcp serve --ffmpeg`: evenly spaced frames of a project video tiled 4 across on one JPEG. */
export function createStorySheetMaker(options: StorySheetOptions) {
    const run = options.run ?? runProcess;
    return async (mediaUrl: string, frames: number, signal?: AbortSignal) => {
        const file = projectMediaPath(options.mediaDir, mediaUrl);
        if (!file) throw new Error(ONLY_PROJECT_MEDIA);
        const info = await probeFile(options.ffmpeg.ffprobePath, file, signal, INPUT_GUARDS).catch(() => null);
        const duration = info?.durationSeconds;
        if (!duration || !(duration > 0)) throw new Error("The video's length could not be read.");
        const count = Math.max(4, Math.min(24, Math.round(frames)));
        const rows = Math.ceil(count / 4);
        const dir = await fs.mkdtemp(path.join(tmpdir(), "opennan-sheet-"));
        try {
            const out = path.join(dir, "sheet.jpg");
            const filter = `fps=${count}/${duration.toFixed(3)},scale=480:-2,tile=4x${rows}`;
            const result = await run(options.ffmpeg.ffmpegPath, [...QUIET, ...inputArgs(file, undefined, undefined), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filter, "-frames:v", "1", "-q:v", "3", "-y", out], { signal });
            if (result.code !== 0) throw new Error(`ffmpeg could not sample the frames: ${result.stderr.trim().split("\n").pop() ?? "unknown error"}`);
            const bytes = await fs.readFile(out);
            const url = await options.save(new Blob([bytes], { type: "image/jpeg" }), "story-frames.jpg");
            return { url, frames: count, everySeconds: duration / count, durationSeconds: duration };
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    };
}
