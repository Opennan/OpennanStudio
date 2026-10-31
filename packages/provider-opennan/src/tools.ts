// The OpenNan media tools (phase 11): cloud captions, caption translation, voice isolation, video upscale, video
// background removal, lip sync, and stem separation. A media input is a MediaSourceRef (the host's MediaPreparer
// makes the file, then it is uploaded where the key lives) or an https URL passed straight through. Before a task is
// created, the price is checked again against the prepared file: when it is higher than the estimate the caller
// showed (input.expectedMaxUsd), nothing is sent. The re-check prices the prepared file the way the label was priced:
// the server's quote of its length with the decode margin when it answers, else the never-under estimate. Every task POST carries a fresh Idempotency-Key and is never
// retried.
import {
    CapabilityUnavailableError, JobFailedError, captionBilledCharacters, displayedUsd, parseMediaSourceRef,
    type CapabilityOutput, type CostEstimate, type GeneratedMedia, type JobContext, type MediaPrepareInput, type MediaPreparePurpose, type MediaPreparer, type PreparedMedia,
    type PriceUnits, type ProviderCapability, type TranscribeRequest, type Transcript, type TranscriptSegment, type TranscriptWord,
} from "@opennan/provider-sdk";
import type { OpenNanApi } from "./api";
import { OpenNanApiError, notChargedError } from "./errors";
import { allowedLink, oneOf, text, type Input } from "./inputs";
import { priceRun, type OpenNanCatalog } from "./prices";
import type { QuoteClient } from "./quotes";
import { costOf, runTask, type TaskBody } from "./tasks";
import { uploadMedia, type UploadCache } from "./uploads";

const MB = 1024 * 1024;
export const PREPARE_MEDIA_UNAVAILABLE = "This app cannot prepare local media for OpenNan yet: use an https link, or run this tool from OpenNan Studio's editor.";

/** What each tool's file must be (the server's limits). */
export const MEDIA_PURPOSES = {
    transcribe: { output: "audio", sampleRate: 16_000, maxBytes: 200 * MB, maxSeconds: 1800, contentTypes: ["audio/wav"] },
    isolate: { output: "audio", sampleRate: 44_100, maxBytes: 200 * MB, maxSeconds: 600, contentTypes: ["audio/wav"] },
    separate: { output: "audio", sampleRate: 44_100, maxBytes: 50 * MB, maxSeconds: 900, contentTypes: ["audio/mp4", "audio/wav"] },
    upscale: { output: "video", maxBytes: 200 * MB, maxSeconds: 60, contentTypes: ["video/mp4", "video/webm"] },
    matting: { output: "video", maxBytes: 200 * MB, maxSeconds: 120, contentTypes: ["video/mp4", "video/webm"] },
    lipsyncVideo: { output: "video", maxBytes: 200 * MB, maxSeconds: 120, contentTypes: ["video/mp4", "video/webm"] },
    lipsyncAudio: { output: "audio", sampleRate: 44_100, maxBytes: 200 * MB, maxSeconds: 60, contentTypes: ["audio/wav"] },
    image: { output: "image", maxBytes: 20 * MB, contentTypes: ["image/png", "image/jpeg", "image/webp"] },
} as const satisfies Record<string, MediaPreparePurpose>;

/** The media tools a provider runs through these helpers. */
export const MEDIA_TOOL_CAPABILITIES: readonly ProviderCapability[] = [
    "captions.translate", "audio.isolate-voice", "video.upscale", "video.remove-background", "video.lipsync", "audio.separate",
];

/**
 * The run stopped because its price went up after the file was prepared (nothing was sent). The message keeps the
 * "≈ $x" label hosts read to accept the new price on Retry; `newMaxUsd` is that amount (displayedUsd of the estimate).
 */
export class PriceChangedError extends JobFailedError {
    readonly newMaxUsd: number;

    constructor(estimate: Pick<CostEstimate, "label" | "microUsd">) {
        super(`The price changed: ${estimate.label}. Run again to accept.`, { code: "price_changed" });
        this.name = "PriceChangedError";
        this.newMaxUsd = displayedUsd(estimate.microUsd);
    }
}

export interface ToolContext {
    api: OpenNanApi;
    key: string;
    job: JobContext;
    catalog: OpenNanCatalog;
    /** POST /v1/quotes: the re-check asks the same quote the label came from (the margin-padded prepared length). */
    quotes?: QuoteClient;
    cache: UploadCache;
    prepareMedia?: MediaPreparer;
    loopbackApi: boolean;
    pollIntervalMs?: number;
    /** Hosts an upload may PUT to besides the API's origin (uploads.ts DEFAULT_UPLOAD_HOSTS when absent). */
    uploadHosts?: readonly string[];
}

/** A media input, prepared and uploaded (or an https URL passed through). */
interface MediaInput {
    url: string;
    prepared?: PreparedMedia;
}

function mediaSource(value: unknown, name: string): MediaPrepareInput {
    const ref = parseMediaSourceRef(value);
    if (typeof ref === "string") throw new JobFailedError(`${name}: ${ref}`);
    return { kind: "media", source: ref };
}

export async function prepare(ctx: ToolContext, capability: ProviderCapability, input: MediaPrepareInput, purpose: MediaPreparePurpose): Promise<PreparedMedia> {
    if (!ctx.prepareMedia) {
        const error = new CapabilityUnavailableError(capability);
        error.message = PREPARE_MEDIA_UNAVAILABLE;
        throw error;
    }
    ctx.job.report(0, "Preparing");
    return ctx.prepareMedia(input, purpose, ctx.job.signal);
}

export async function upload(ctx: ToolContext, prepared: PreparedMedia): Promise<string> {
    ctx.job.report(null, "Uploading");
    try {
        return (await uploadMedia(ctx.api, ctx.key, prepared, { signal: ctx.job.signal, cache: ctx.cache, ...(ctx.uploadHosts ? { allowedHosts: ctx.uploadHosts } : {}) })).mediaUrl;
    } catch (error) {
        // An upload comes before any task: nothing was charged (a refused file, a storage failure, or a refusal).
        if (error instanceof OpenNanApiError) throw notChargedError(error, { upload: true });
        throw error;
    }
}

/** Reads one media input: a MediaSourceRef under `refName` (prepared, not yet uploaded) or an https URL under `urlName`. */
async function readMedia(ctx: ToolContext, capability: ProviderCapability, input: Input, refName: string, urlName: string, purpose: MediaPreparePurpose): Promise<{ url?: string; prepared?: PreparedMedia }> {
    if (input[refName] !== undefined && input[refName] !== null) return { prepared: await prepare(ctx, capability, mediaSource(input[refName], refName), purpose) };
    const url = text(input, urlName, false, 2048);
    if (url === undefined) throw new JobFailedError(`${refName} (a project media) or ${urlName} (an https link) is required.`);
    if (!allowedLink(url, ctx.loopbackApi)) throw new JobFailedError(`${urlName} must be an https URL.`);
    return { url };
}

async function finish(ctx: ToolContext, media: { url?: string; prepared?: PreparedMedia }): Promise<MediaInput> {
    if (media.url !== undefined) return { url: media.url };
    return { url: await upload(ctx, media.prepared!), prepared: media.prepared! };
}

export const PRICE_UNKNOWN_MESSAGE = "The price could not be checked: nothing was sent. Try again.";

/**
 * Stops the run (nothing sent) unless the prepared file still costs at most the estimate the caller showed
 * (input.expectedMaxUsd). With an estimate shown, the run goes only on an estimate computed from what is sent: a known
 * length (`units` is null when the file's length is unknown) or exact characters for captions.
 */
async function recheckPrice(ctx: ToolContext, capability: ProviderCapability, input: Input, units: PriceUnits | null): Promise<void> {
    const expected = input.expectedMaxUsd;
    if (expected === undefined || expected === null) return;
    if (typeof expected !== "number" || !Number.isFinite(expected) || expected < 0) throw new JobFailedError("expectedMaxUsd must be a number of dollars.");
    if (units === null) throw new JobFailedError(PRICE_UNKNOWN_MESSAGE, { code: "price_unknown" });
    const answer = await priceRun(ctx.catalog, { capability, input, units }, ctx.quotes);
    if (answer.kind === "over-limit") {
        throw new JobFailedError(`This is past the tool's limit (at most ${answer.limit.max} ${answer.limit.kind}). Nothing was sent.`, { code: "over_limit" });
    }
    if (answer.kind !== "estimate") throw new JobFailedError(PRICE_UNKNOWN_MESSAGE, { code: "price_unknown" });
    if (answer.estimate.microUsd > Math.round(expected * 1_000_000)) throw new PriceChangedError(answer.estimate);
}

/** The pixel size of a prepared video (the source's: the preparer never resizes), for stacking a resized result. */
function sizeOf(prepared: PreparedMedia | undefined): { sourceSize: { width: number; height: number } } | Record<string, never> {
    const { width, height } = prepared ?? {};
    return width && height && Number.isInteger(width) && Number.isInteger(height) ? { sourceSize: { width, height } } : {};
}

/** The prepared file's length as price units, or null when it is unknown (a link, or a file the host could not measure). */
function secondsOf(prepared: PreparedMedia | undefined): PriceUnits | null {
    const seconds = prepared?.durationSeconds;
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? { seconds } : null;
}

async function createTask(ctx: ToolContext, path: string, body: Record<string, unknown>): Promise<TaskBody> {
    return runTask(ctx.api, ctx.key, ctx.job, path, body, { pollIntervalMs: ctx.pollIntervalMs, runningLabel: "Running" });
}

function link(ctx: ToolContext, value: unknown, what: string): string {
    if (typeof value !== "string" || !allowedLink(value, ctx.loopbackApi)) throw new JobFailedError(`OpenNan returned no ${what}.`);
    return value;
}

function withCost(output: CapabilityOutput, task: TaskBody): CapabilityOutput {
    const cost = costOf(task);
    if (cost !== undefined) output.costUsd = cost;
    return output;
}

function segmentsOf(input: Input): Array<{ start: number; end: number; text: string }> {
    const segments = input.segments;
    if (!Array.isArray(segments) || segments.length === 0 || segments.length > 2000) throw new JobFailedError("segments must list 1 to 2,000 caption lines.");
    return segments.map((raw, index) => {
        const segment = raw as Record<string, unknown>;
        const { start, end } = segment;
        if (typeof segment !== "object" || segment === null || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
            throw new JobFailedError(`segments[${index}] must be { start, end, text } with end after start.`);
        }
        // The server counts Unicode code points, not UTF-16 units (an emoji is one character).
        if (typeof segment.text !== "string" || !segment.text.trim() || [...segment.text].length > 500) throw new JobFailedError(`segments[${index}].text must be 1 to 500 characters.`);
        return { start, end, text: segment.text };
    });
}

const CAPTION_LANGUAGE = /^[A-Za-z]{2,3}(-([A-Za-z]{2}|[0-9]{3}|[A-Za-z]{4}))?$/;

function captionLanguage(input: Input, name: string, required: boolean): string | undefined {
    const value = text(input, name, required, 16);
    if (value !== undefined && !CAPTION_LANGUAGE.test(value)) throw new JobFailedError(`${name} must be a language code, e.g. th, ja, zh-TW, pt-BR.`);
    return value;
}

/** Runs one media tool capability. */
export async function runMediaTool(ctx: ToolContext, capability: ProviderCapability, input: Input): Promise<CapabilityOutput> {
    switch (capability) {
        case "captions.translate": {
            const segments = segmentsOf(input);
            const target = captionLanguage(input, "targetLanguage", true)!;
            const source = captionLanguage(input, "sourceLanguage", false);
            await recheckPrice(ctx, capability, input, { characters: captionBilledCharacters(segments), segments: segments.length });
            const task = await createTask(ctx, "/v1/captions/translations", { segments, target_language: target, ...(source ? { source_language: source } : {}) });
            const result = task.result as { segments?: unknown } | null | undefined;
            if (typeof result !== "object" || result === null || !Array.isArray(result.segments)) throw new JobFailedError("OpenNan returned no translation.");
            return withCost({ media: [], result }, task);
        }
        case "audio.isolate-voice": {
            const media = await readMedia(ctx, capability, input, "source", "audioUrl", MEDIA_PURPOSES.isolate);
            await recheckPrice(ctx, capability, input, secondsOf(media.prepared));
            const audio = await finish(ctx, media);
            const task = await createTask(ctx, "/v1/audio/isolations", { audio_url: audio.url });
            const result = (task.result ?? {}) as { audio_url?: unknown; duration_s?: unknown };
            const item: GeneratedMedia = { kind: "audio", url: link(ctx, result.audio_url, "audio") };
            if (typeof result.duration_s === "number" && Number.isFinite(result.duration_s)) item.durationSeconds = result.duration_s;
            return withCost({ media: [item] }, task);
        }
        case "video.upscale":
        case "video.remove-background": {
            const upscale = capability === "video.upscale";
            const resolution = upscale ? oneOf(input, "resolution", ["1080p", "2k", "4k"] as const, "1080p") : undefined;
            const background = upscale ? undefined : oneOf(input, "background", ["transparent", "green", "blue", "black", "white"] as const, "transparent");
            const media = await readMedia(ctx, capability, input, "source", "videoUrl", upscale ? MEDIA_PURPOSES.upscale : MEDIA_PURPOSES.matting);
            const seconds = secondsOf(media.prepared);
            await recheckPrice(ctx, capability, input, seconds && resolution ? { ...seconds, resolution } : seconds);
            const video = await finish(ctx, media);
            const task = upscale
                ? await createTask(ctx, "/v1/videos/upscales", { video_url: video.url, resolution })
                : await createTask(ctx, "/v1/videos/background-removals", { video_url: video.url, background });
            const result = (task.result ?? {}) as { video_url?: unknown };
            return withCost({ media: [{ kind: "video", url: link(ctx, result.video_url, "video") }], ...sizeOf(media.prepared) }, task);
        }
        case "video.lipsync": {
            const videoMedia = await readMedia(ctx, capability, input, "videoSource", "videoUrl", MEDIA_PURPOSES.lipsyncVideo);
            const audioMedia = await readMedia(ctx, capability, input, "audioSource", "audioUrl", MEDIA_PURPOSES.lipsyncAudio);
            // Lip sync is billed on the speech's seconds.
            await recheckPrice(ctx, capability, input, secondsOf(audioMedia.prepared));
            const video = await finish(ctx, videoMedia);
            const audio = await finish(ctx, audioMedia);
            const task = await createTask(ctx, "/v1/videos/lipsync", { video_url: video.url, audio_url: audio.url });
            const result = (task.result ?? {}) as { video_url?: unknown };
            return withCost({ media: [{ kind: "video", url: link(ctx, result.video_url, "video") }], ...sizeOf(videoMedia.prepared) }, task);
        }
        case "audio.separate": {
            const stems = oneOf(input, "stems", ["vocals", "all"] as const, "vocals");
            const media = await readMedia(ctx, capability, input, "source", "audioUrl", MEDIA_PURPOSES.separate);
            await recheckPrice(ctx, capability, input, secondsOf(media.prepared));
            const audio = await finish(ctx, media);
            const task = await createTask(ctx, "/v1/audio/separations", { model: "demucs", audio_url: audio.url, stems });
            const outputs = Array.isArray(task.outputs) ? (task.outputs as Array<Record<string, unknown>>) : [];
            const files: GeneratedMedia[] = [];
            for (const output of outputs) {
                if (typeof output?.url !== "string" || !allowedLink(output.url, ctx.loopbackApi)) continue;
                const stem = typeof output.stem === "string" && /^[a-z]{1,20}$/.test(output.stem) ? output.stem : `stem-${files.length + 1}`;
                const format = output.format === "wav" ? "wav" : "mp3";
                files.push({ kind: "audio", url: output.url, role: stem, name: `${stem}.${format}`, mimeType: format === "wav" ? "audio/wav" : "audio/mpeg" });
            }
            if (files.length === 0) throw new JobFailedError("OpenNan returned no stems.");
            return withCost({ media: files }, task);
        }
        default:
            throw new JobFailedError(`${capability} is not an OpenNan media tool.`);
    }
}

/** An image input of image.edit / image-to-video: a project image (prepared and uploaded) or an https link. */
export async function imageInput(ctx: ToolContext, capability: ProviderCapability, input: Input, name: string, required: boolean): Promise<string | undefined> {
    const value = input[name];
    if (value === undefined || value === null || value === "") {
        if (required) throw new JobFailedError(`${name} is required.`);
        return undefined;
    }
    if (typeof value === "string") {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            throw new JobFailedError(`${name} must be an https URL or a project image.`);
        }
        if (url.protocol !== "https:" || url.username || url.password || value.length > 4096) throw new JobFailedError(`${name} must be an https URL or a project image.`);
        return value;
    }
    const prepared = await prepare(ctx, capability, mediaSource(value, name), MEDIA_PURPOSES.image);
    return upload(ctx, prepared);
}

// ── cloud captions ────────────────────────────────────────────────────────────

/** The language to send: a 2–3 letter code, never "auto" (the server detects it when none is sent). */
export function transcribeLanguage(language: string | undefined): string | undefined {
    return language && language !== "auto" && /^[A-Za-z]{2,3}$/.test(language) ? language.toLowerCase() : undefined;
}

interface TranscriptionResult {
    language?: unknown;
    duration_s?: unknown;
    segments?: unknown;
    words?: unknown;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** OpenNan's transcription result as a Transcript: each word goes to the segment holding its midpoint (else the nearest). */
export function transcriptOf(result: TranscriptionResult, requested: string | undefined): Transcript {
    const segments: TranscriptSegment[] = (Array.isArray(result.segments) ? (result.segments as Array<Record<string, unknown>>) : [])
        .filter((s) => finite(s?.start) && finite(s.end) && typeof s.text === "string")
        .map((s) => ({ start: s.start as number, end: s.end as number, text: s.text as string }));
    const words: TranscriptWord[] = (Array.isArray(result.words) ? (result.words as Array<Record<string, unknown>>) : [])
        .filter((w) => finite(w?.start) && finite(w.end) && typeof w.text === "string")
        .map((w) => ({ start: w.start as number, end: w.end as number, text: w.text as string }));
    for (const word of words) {
        if (segments.length === 0) break;
        const middle = (word.start + word.end) / 2;
        let best = segments.find((s) => middle >= s.start && middle <= s.end);
        if (!best) {
            best = segments.reduce((a, b) => (Math.min(Math.abs(middle - a.start), Math.abs(middle - a.end)) <= Math.min(Math.abs(middle - b.start), Math.abs(middle - b.end)) ? a : b));
        }
        (best.words ??= []).push(word);
    }
    const transcript: Transcript = { language: typeof result.language === "string" && result.language ? result.language : (requested ?? "und"), segments };
    if (finite(result.duration_s)) transcript.durationSeconds = result.duration_s;
    return transcript;
}

/** audio.transcribe on OpenNan: prepare the audio (16 kHz WAV), upload it, POST /v1/audio/transcriptions. */
export async function runTranscription(ctx: ToolContext, request: TranscribeRequest): Promise<Transcript> {
    const audio = request.audio;
    let url: string | undefined;
    let prepared: PreparedMedia | undefined;
    if (audio.kind === "media" && audio.startSeconds === undefined && audio.endSeconds === undefined && /^https:\/\//.test(audio.url)) {
        url = audio.url;
    } else {
        const source: MediaPrepareInput = audio.kind === "timeline"
            ? { kind: "timeline", snapshot: audio.snapshot }
            : mediaSource({ mediaUrl: audio.url, ...(audio.startSeconds !== undefined ? { startSeconds: audio.startSeconds } : {}), ...(audio.endSeconds !== undefined ? { endSeconds: audio.endSeconds } : {}) }, "audio");
        prepared = await prepare(ctx, "audio.transcribe", source, MEDIA_PURPOSES.transcribe);
    }
    await recheckPrice(ctx, "audio.transcribe", { expectedMaxUsd: request.expectedMaxUsd }, secondsOf(prepared));
    if (prepared) url = await upload(ctx, prepared);
    const language = transcribeLanguage(request.language);
    const task = await createTask(ctx, "/v1/audio/transcriptions", { audio_url: url, ...(language ? { language } : {}) });
    if (typeof task.result !== "object" || task.result === null) throw new JobFailedError("OpenNan returned no transcript.");
    const transcript = transcriptOf(task.result as TranscriptionResult, language);
    transcript.model = "cloud";
    const cost = costOf(task);
    if (cost !== undefined) transcript.costUsd = cost;
    return transcript;
}
