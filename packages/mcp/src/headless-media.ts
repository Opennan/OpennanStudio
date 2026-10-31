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
import { SCENE_SCORE_CUTS, findCuts, splitShots, type ShotRange } from "@opennan/story-film";
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

/** An ffmpeg scale filter: the source's size (even sides), or scaled up until it has `minPixels` pixels. */
export function minPixelsScale(minPixels: number): string {
    const min = Math.ceil(minPixels);
    // Quoted, so the commas stay inside the expression.
    const side = (dim: "iw" | "ih") => `'if(lt(iw*ih,${min}),ceil(${dim}*sqrt(${min}/(iw*ih))/2)*2,trunc(${dim}/2)*2)'`;
    return `scale=${side("iw")}:${side("ih")}`;
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
        // Even dimensions: H.264 encoders refuse odd ones. A picture under the destination's smallest (a reference
        // video's minimum pixels) is scaled up to it, its shape kept.
        const filters = [purpose.minPixels ? minPixelsScale(purpose.minPixels) : "scale=trunc(iw/2)*2:trunc(ih/2)*2", ...choice.videoFilters];
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

/** The select filter that keeps the first frame at or after each time (seconds). */
export function framesAtTimes(times: readonly number[]): string {
    // The first frame has no previous time (NaN): it counts as "before" every time.
    return `select='${times.map((t) => `gte(t,${t.toFixed(3)})*(isnan(prev_t)+lt(prev_t,${t.toFixed(3)}))`).join("+")}'`;
}

/**
 * Story film's copy step on `mcp serve --ffmpeg`: evenly spaced frames of a project video (or the frames at `times`,
 * a copy's shots) tiled 4 across on one JPEG.
 */
export function createStorySheetMaker(options: StorySheetOptions) {
    const run = options.run ?? runProcess;
    return async (mediaUrl: string, frames: number, signal?: AbortSignal, times?: readonly number[]) => {
        const file = projectMediaPath(options.mediaDir, mediaUrl);
        if (!file) throw new Error(ONLY_PROJECT_MEDIA);
        const info = await probeFile(options.ffmpeg.ffprobePath, file, signal, INPUT_GUARDS).catch(() => null);
        const duration = info?.durationSeconds;
        if (!duration || !(duration > 0)) throw new Error("The video's length could not be read.");
        const picked = times && times.length > 0 ? [...times].map((t) => Math.min(duration - 0.05, Math.max(0, t))).sort((a, b) => a - b) : null;
        const count = picked ? picked.length : Math.max(4, Math.min(24, Math.round(frames)));
        const rows = Math.ceil(count / 4);
        const dir = await fs.mkdtemp(path.join(tmpdir(), "opennan-sheet-"));
        try {
            const out = path.join(dir, "sheet.jpg");
            const cell = "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2";
            const filter = picked ? `${framesAtTimes(picked)},${cell},tile=4x${rows}` : `fps=${count}/${duration.toFixed(3)},scale=480:-2,tile=4x${rows}`;
            const sync = picked ? ["-fps_mode", "passthrough"] : [];
            const result = await run(options.ffmpeg.ffmpegPath, [...QUIET, ...inputArgs(file, undefined, undefined), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filter, ...sync, "-frames:v", "1", "-q:v", "3", "-y", out], { signal });
            if (result.code !== 0) throw new Error(`ffmpeg could not sample the frames: ${result.stderr.trim().split("\n").pop() ?? "unknown error"}`);
            const bytes = await fs.readFile(out);
            const url = await options.save(new Blob([bytes], { type: "image/jpeg" }), "story-frames.jpg");
            return { url, frames: count, everySeconds: duration / count, durationSeconds: duration };
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    };
}

export interface StoryShotsOptions extends StorySheetOptions {
    /** Cuts a shot out (the headless MediaPreparer: an H.264 MP4 of the range). */
    prepare: MediaPreparer;
}

/** The scene score of every frame, from ffmpeg's metadata print (each frame's pts_time line, then its score line). */
export function parseSceneScores(log: string): { times: number[]; scores: number[] } {
    const times: number[] = [];
    const scores: number[] = [];
    let time: number | null = null;
    for (const line of log.split("\n")) {
        const at = /pts_time:\s*(-?[0-9.]+)/.exec(line);
        if (at) time = Number(at[1]);
        const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
        if (score && time !== null && Number.isFinite(time)) {
            times.push(time);
            scores.push(Number(score[1]));
            time = null;
        }
    }
    return { times, scores };
}

/**
 * The video's cuts: ffmpeg's scene score of every frame (on a small picture), then @opennan/story-film's adaptive
 * rule (a frame that stands out from the second around it; a fixed threshold missed faint cuts of old films).
 */
export async function findSceneCuts(ffmpegPath: string, file: string, signal?: AbortSignal, run: typeof runProcess = runProcess): Promise<number[]> {
    // Printed to stdout (kept whole; stderr is cut to its tail). The colon of pipe:1 is escaped twice: once for the
    // filter graph, once for the filter's options.
    const filter = "scale=160:-2,select='gte(scene,0)',metadata=print:file=pipe\\\\:1";
    const result = await run(ffmpegPath, [...QUIET, ...inputArgs(file, undefined, undefined), "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filter, "-f", "null", "-"], { signal });
    if (result.code !== 0) throw new Error(`ffmpeg could not find the shots: ${result.stderr.trim().split("\n").pop() ?? "unknown error"}`);
    const { times, scores } = parseSceneScores(result.stdout);
    return findCuts(times, scores, SCENE_SCORE_CUTS);
}

/**
 * Story film's "Remake from your video" on `mcp serve --ffmpeg`: the video's cuts (findSceneCuts), made into
 * shots of 2-15 s by @opennan/story-film, and (with `cut`) each shot cut out as its own project video.
 */
export function createStoryShotsMaker(options: StoryShotsOptions) {
    const run = options.run ?? runProcess;
    return async (mediaUrl: string, cut: boolean, signal?: AbortSignal): Promise<{ durationSeconds: number; shots: Array<ShotRange & { clip?: string }>; truncated: boolean }> => {
        const file = projectMediaPath(options.mediaDir, mediaUrl);
        if (!file) throw new Error(ONLY_PROJECT_MEDIA);
        const info = await probeFile(options.ffmpeg.ffprobePath, file, signal, INPUT_GUARDS).catch(() => null);
        const duration = info?.durationSeconds;
        if (!duration || !(duration > 0) || !info?.hasVideo) throw new Error("The video's length could not be read.");
        const cuts = await findSceneCuts(options.ffmpeg.ffmpegPath, file, signal, run);
        const split = splitShots(cuts, duration);
        const shots: Array<ShotRange & { clip?: string }> = split.shots.map((shot) => ({ ...shot }));
        if (cut) {
            for (const [index, shot] of shots.entries()) {
                const prepared = await options.prepare({ kind: "media", source: { mediaUrl, startSeconds: shot.start, endSeconds: shot.end } }, { output: "video", maxBytes: 1024 * 1024 * 1024, contentTypes: ["video/mp4"] }, signal ?? new AbortController().signal);
                const data = prepared.data instanceof Blob ? prepared.data : new Blob([prepared.data as Uint8Array<ArrayBuffer>], { type: prepared.contentType });
                shot.clip = await options.save(data, `story-shot-${String(index + 1).padStart(2, "0")}.mp4`);
            }
        }
        return { durationSeconds: duration, shots, truncated: split.truncated };
    };
}
