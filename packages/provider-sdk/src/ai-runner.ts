// createAiRunner: the host's handler for the editor's ai.run command (spec §5.1.1): validate the input, run the
// routed provider's Job, forward its progress, and return the output plus where to place it. The types are
// structural twins of @opennan/timeline-core's AiRun* types, so neither package imports the other.
// Phase 11: transcription of a media range with a per-run engine, placements for the media tools (validated before
// anything runs, so a bad placement never costs a run), and the AiJobBook that records every job.
import { capabilityUnavailableMessage, isProviderCapability, type ProviderCapability } from "./capabilities";
import { isCapabilityOutput, type CapabilityOutput, type GeneratedMedia } from "./capability-output";
import { CapabilityUnavailableError, JobCancelledError, JobFailedError } from "./errors";
import type { AiJobBook } from "./job-book";
import type { Job, JobStatus } from "./job";
import { parseMediaSourceRef } from "./media-source";
import type { ProviderRegistry } from "./registry";
import type { Provider } from "./types";
import { isTranscribeLanguage, transcriptToCaptionCues } from "./transcribe";
import type { AudioInput, Transcript } from "./transcribe-types";

export interface AiRunRequestLike {
    capability: string;
    input: unknown;
    placeAt?: Record<string, unknown>;
}

export interface AiRunProgressLike {
    jobId: string;
    status: JobStatus;
    progress?: number;
    message?: string;
    /** false once cancel can no longer stop the job (its paid step started): it will finish and be charged. */
    cancellable?: boolean;
}

export interface AiRunContextLike {
    snapshot: unknown;
    signal?: AbortSignal;
    onProgress?(progress: AiRunProgressLike): void;
}

export interface CaptionCueLike {
    startTime: number;
    endTime: number;
    text: string;
    /** words: absolute seconds, like the cue times (see CaptionCue). */
    words?: Array<{ start: number; end: number; text: string }>;
}

export interface CaptionsPlacementLike {
    kind: "captions-track";
    /** "caption", "subtitle", or a caption style id (timeline-core text/captions.ts, e.g. "karaoke_highlight"). */
    style: string;
    cues: CaptionCueLike[];
    label?: string;
}

/** The timeline item a tool ran on: a clip or a scene. */
export interface AiTargetRefLike {
    clipId?: string;
    sceneId?: string;
}

/** A result file after the host stored it in the project's media library. */
export interface AiMediaRefLike {
    url: string;
    name?: string;
    mimeType?: string;
    durationSeconds?: number;
    role?: string;
    width?: number;
    height?: number;
}

export interface PixelSizeLike {
    width: number;
    height: number;
}

export interface AiSourceRangeLike {
    startSeconds: number;
    endSeconds: number;
}

/** Twin of timeline-core's AiPlacement. */
export type AiPlacementLike =
    | CaptionsPlacementLike
    | { kind: "captions-track-translated"; sourceTrackIndex: number; language: string; keepSource: boolean; style?: string; cues: CaptionCueLike[]; untranslated?: number[] }
    | { kind: "replace-audio"; source: AiTargetRefLike; media: AiMediaRefLike[]; range?: AiSourceRangeLike }
    | { kind: "stack-video"; source: AiTargetRefLike; media: AiMediaRefLike; range?: AiSourceRangeLike; hideSource?: boolean; muteSource?: boolean; sourceSize?: PixelSizeLike; audioClipId?: string }
    | { kind: "insert-media"; at: number; media: AiMediaRefLike[] };

export interface AiRunOutcomeLike {
    jobId?: string;
    output?: unknown;
    placement?: AiPlacementLike;
    error?: string;
    unavailable?: boolean;
    cancelled?: boolean;
}

export type AiRunner = (request: AiRunRequestLike, context: AiRunContextLike) => Promise<AiRunOutcomeLike>;

/** A generated file after the host stored it in the project's media library. */
export interface ImportedMedia {
    url: string;
    name?: string;
    mimeType?: string;
    durationSeconds?: number;
    sizeBytes?: number;
    /** Pixel size of a stored video or image (the host probes it), so a stacked result keeps its on-screen size. */
    width?: number;
    height?: number;
}

export interface AiRunnerOptions {
    /**
     * Stores one generated file in the project's media library (download or write the bytes) and returns its local
     * media. Without it, ai.run returns the provider's URLs and drops bytes.
     */
    importMedia?(media: GeneratedMedia, context: { projectId: string | null }): Promise<ImportedMedia>;
    /** Records every job and its updates (job tray, check_generation_status). */
    jobs?: AiJobBook;
}

/** Largest ai.run input for Provider.run (JSON characters): inputs are descriptions and ids, never media. */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

const MODEL_ID = /^[a-z0-9._-]{1,64}$/;
const STYLE_ID = /^[a-z][a-z0-9_]{0,40}$/;
const ITEM_ID_MAX = 128;
/** More caption clips than this would swamp the timeline (and its saved project); the run fails instead. */
export const MAX_CAPTION_CUES = 10_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ── input ─────────────────────────────────────────────────────────────────────

interface TranscribeInput { audio: AudioInput; language?: string; model?: string; expectedMaxUsd?: number }
type Engine = "local" | "cloud";

function transcribeInput(input: unknown, snapshot: unknown): { request: TranscribeInput; engine?: Engine } | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
    const value = input as Record<string, unknown>;
    for (const key of Object.keys(value)) if (!["source", "language", "model", "engine", "expectedMaxUsd"].includes(key)) return `unknown field ${key}`;
    let audio: AudioInput = { kind: "timeline", snapshot };
    if (value.source !== undefined && value.source !== "timeline") {
        const ref = parseMediaSourceRef(value.source);
        if (typeof ref === "string") return `source must be "timeline" or a media source: ${ref}`;
        audio = { kind: "media", url: ref.mediaUrl };
        if (ref.startSeconds !== undefined) audio.startSeconds = ref.startSeconds;
        if (ref.endSeconds !== undefined) audio.endSeconds = ref.endSeconds;
    }
    if (value.engine !== undefined && value.engine !== "local" && value.engine !== "cloud") return "engine must be \"local\" or \"cloud\"";
    if (value.language !== undefined && !isTranscribeLanguage(value.language)) return "language must be \"auto\" or a whisper language code";
    if (value.model !== undefined && (typeof value.model !== "string" || !MODEL_ID.test(value.model))) return "model must be a model id";
    if (value.expectedMaxUsd !== undefined && (typeof value.expectedMaxUsd !== "number" || !Number.isFinite(value.expectedMaxUsd) || value.expectedMaxUsd < 0)) {
        return "expectedMaxUsd must be a number of dollars";
    }
    const request: TranscribeInput = { audio };
    if (value.expectedMaxUsd !== undefined) request.expectedMaxUsd = value.expectedMaxUsd as number;
    if (value.language !== undefined) request.language = value.language as string;
    if (value.model !== undefined) request.model = value.model as string;
    return value.engine === undefined ? { request } : { request, engine: value.engine as Engine };
}

function runInput(input: unknown): Record<string, unknown> | string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
    let size: number;
    try {
        size = JSON.stringify(input).length;
    } catch {
        return "input must be JSON";
    }
    if (size > MAX_RUN_INPUT_BYTES) return `input is larger than ${MAX_RUN_INPUT_BYTES} bytes`;
    return input as Record<string, unknown>;
}

// ── placeAt (checked before anything runs) ────────────────────────────────────

type PlaceAt =
    | { kind: "captions-track"; style: string; timeOffset: number; timeScale: number; label?: string }
    | { kind: "captions-track-translated"; sourceTrackIndex: number; language: string; keepSource: boolean; style?: string }
    | { kind: "replace-audio"; source: AiTargetRefLike; range?: AiSourceRangeLike }
    | { kind: "stack-video"; source: AiTargetRefLike; range?: AiSourceRangeLike; hideSource?: boolean; muteSource?: boolean; sourceSize?: PixelSizeLike; audioClipId?: string }
    | { kind: "insert-media"; at: number };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function target(value: unknown): AiTargetRefLike | string {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "source must be { clipId } or { sceneId }";
    const raw = value as Record<string, unknown>;
    for (const key of Object.keys(raw)) if (key !== "clipId" && key !== "sceneId") return `source has an unknown field ${key}`;
    const ids = (["clipId", "sceneId"] as const).filter((key) => raw[key] !== undefined);
    if (ids.length !== 1) return "source must name exactly one of clipId or sceneId";
    const id = raw[ids[0]!];
    if (typeof id !== "string" || id.length === 0 || id.length > ITEM_ID_MAX) return `source ${ids[0]} must be an item id`;
    return { [ids[0]!]: id };
}

function range(value: unknown): AiSourceRangeLike | undefined | string {
    if (value === undefined) return undefined;
    const raw = value as Record<string, unknown> | null;
    if (typeof raw !== "object" || raw === null || !finite(raw.startSeconds) || !finite(raw.endSeconds) || raw.startSeconds < 0 || raw.endSeconds <= raw.startSeconds) {
        return "range must be { startSeconds, endSeconds } with 0 <= start < end";
    }
    return { startSeconds: raw.startSeconds, endSeconds: raw.endSeconds };
}

/** A pixel size: positive whole numbers up to 16384. */
function pixelSize(value: unknown): PixelSizeLike | undefined | string {
    if (value === undefined) return undefined;
    const raw = value as Record<string, unknown> | null;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 16384;
    if (typeof raw !== "object" || raw === null || !ok(raw.width) || !ok(raw.height)) return "must be { width, height } in pixels";
    return { width: raw.width, height: raw.height };
}

function optionalFlag(raw: Record<string, unknown>, name: string): boolean | undefined | string {
    const value = raw[name];
    if (value === undefined) return undefined;
    return typeof value === "boolean" ? value : `${name} must be true or false`;
}

function placeAtOf(capability: ProviderCapability, raw: Record<string, unknown> | undefined): PlaceAt | undefined | string {
    if (raw === undefined) return undefined;
    if (typeof raw !== "object" || raw === null) return "must be an object";
    const transcribe = capability === "audio.transcribe";
    if (transcribe && raw.kind !== "captions-track") return `kind ${String(raw.kind)} does not fit audio.transcribe (use captions-track)`;
    switch (raw.kind) {
        case "captions-track": {
            if (!transcribe) return "captions-track fits audio.transcribe only";
            const style = typeof raw.style === "string" && STYLE_ID.test(raw.style) ? raw.style : "caption";
            const timeOffset = raw.timeOffset ?? 0;
            if (!finite(timeOffset)) return "timeOffset must be a number of seconds";
            const timeScale = raw.timeScale ?? 1;
            if (!finite(timeScale) || timeScale <= 0) return "timeScale must be a number above 0";
            if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length > 200)) return "label must be text of at most 200 characters";
            return { kind: "captions-track", style, timeOffset, timeScale, ...(raw.label !== undefined ? { label: raw.label as string } : {}) };
        }
        case "captions-track-translated": {
            if (!Number.isInteger(raw.sourceTrackIndex) || (raw.sourceTrackIndex as number) < 0) return "sourceTrackIndex must be a track index";
            if (typeof raw.language !== "string" || raw.language.length === 0 || raw.language.length > 16) return "language must be a language code";
            if (typeof raw.keepSource !== "boolean") return "keepSource must be true or false";
            if (raw.style !== undefined && (typeof raw.style !== "string" || !STYLE_ID.test(raw.style))) return "style must be a caption style id";
            return {
                kind: "captions-track-translated", sourceTrackIndex: raw.sourceTrackIndex as number, language: raw.language, keepSource: raw.keepSource,
                ...(raw.style !== undefined ? { style: raw.style as string } : {}),
            };
        }
        case "replace-audio":
        case "stack-video": {
            const source = target(raw.source);
            if (typeof source === "string") return source;
            const window = range(raw.range);
            if (typeof window === "string") return window;
            const base = { source, ...(window ? { range: window } : {}) };
            if (raw.kind === "replace-audio") return { kind: "replace-audio", ...base };
            const hideSource = optionalFlag(raw, "hideSource");
            if (typeof hideSource === "string") return hideSource;
            const muteSource = optionalFlag(raw, "muteSource");
            if (typeof muteSource === "string") return muteSource;
            const size = pixelSize(raw.sourceSize);
            if (typeof size === "string") return `sourceSize ${size}`;
            if (raw.audioClipId !== undefined && (typeof raw.audioClipId !== "string" || raw.audioClipId.length === 0 || raw.audioClipId.length > ITEM_ID_MAX)) return "audioClipId must be a clip id";
            return {
                kind: "stack-video", ...base, ...(hideSource !== undefined ? { hideSource } : {}), ...(muteSource !== undefined ? { muteSource } : {}),
                ...(size ? { sourceSize: size } : {}), ...(raw.audioClipId !== undefined ? { audioClipId: raw.audioClipId as string } : {}),
            };
        }
        case "insert-media":
            if (!finite(raw.at) || raw.at < 0) return "at must be timeline seconds (0 or more)";
            return { kind: "insert-media", at: raw.at };
        default:
            return `unknown kind ${String(raw.kind)}`;
    }
}

function captionCues(transcript: Transcript, timeOffset: number, timeScale: number): CaptionCueLike[] {
    const at = (t: number) => timeOffset + t / timeScale;
    return transcriptToCaptionCues(transcript).map((cue) => ({
        ...cue,
        startTime: at(cue.startTime),
        endTime: at(cue.endTime),
        ...(cue.words ? { words: cue.words.map((w) => ({ ...w, start: at(w.start), end: at(w.end) })) } : {}),
    }));
}

function translatedCues(result: unknown): { cues: CaptionCueLike[]; untranslated: number[] } | null {
    const value = result as { segments?: unknown; untranslated?: unknown } | null;
    if (typeof value !== "object" || value === null || !Array.isArray(value.segments)) return null;
    const cues: CaptionCueLike[] = [];
    for (const segment of value.segments as Array<Record<string, unknown>>) {
        if (typeof segment !== "object" || segment === null || !finite(segment.start) || !finite(segment.end) || typeof segment.text !== "string") return null;
        cues.push({ startTime: segment.start, endTime: segment.end, text: segment.text });
    }
    const untranslated = Array.isArray(value.untranslated) ? (value.untranslated as unknown[]).filter((i): i is number => Number.isInteger(i)) : [];
    return { cues, untranslated };
}

function mediaRef(media: GeneratedMedia): AiMediaRefLike | null {
    if (typeof media.url !== "string" || media.url === "") return null;
    const ref: AiMediaRefLike = { url: media.url };
    if (media.name !== undefined) ref.name = media.name;
    if (media.mimeType !== undefined) ref.mimeType = media.mimeType;
    if (media.durationSeconds !== undefined) ref.durationSeconds = media.durationSeconds;
    if (media.role !== undefined) ref.role = media.role;
    if (typeof media.width === "number" && typeof media.height === "number" && media.width > 0 && media.height > 0) {
        ref.width = media.width;
        ref.height = media.height;
    }
    return ref;
}

function mediaPlacement(placeAt: PlaceAt, output: CapabilityOutput): AiPlacementLike | string {
    const refs = (kind?: GeneratedMedia["kind"]) => output.media.filter((m) => kind === undefined || m.kind === kind).map(mediaRef).filter((r): r is AiMediaRefLike => r !== null);
    switch (placeAt.kind) {
        case "captions-track-translated": {
            const translated = translatedCues(output.result);
            if (!translated) return "The provider returned no translation to place.";
            if (translated.cues.length > MAX_CAPTION_CUES) return `The translation has ${translated.cues.length} caption lines, more than the ${MAX_CAPTION_CUES} the timeline takes at once.`;
            return { ...placeAt, cues: translated.cues, untranslated: translated.untranslated };
        }
        case "replace-audio": {
            const media = refs("audio");
            return media.length > 0 ? { ...placeAt, media } : "The provider returned no audio to place.";
        }
        case "stack-video": {
            const media = refs("video")[0];
            if (!media) return "The provider returned no video to place.";
            const reported = pixelSize(output.sourceSize);
            const sourceSize = placeAt.sourceSize ?? (reported && typeof reported !== "string" ? reported : undefined);
            return { ...placeAt, media, ...(sourceSize ? { sourceSize } : {}) };
        }
        case "insert-media": {
            const media = refs();
            return media.length > 0 ? { ...placeAt, media } : "The provider returned no media to place.";
        }
        default:
            return "This placement does not fit the result.";
    }
}

// ── jobs ──────────────────────────────────────────────────────────────────────

async function runJob<T>(job: Job<T>, capability: string, context: AiRunContextLike, options: AiRunnerOptions): Promise<{ ok: true; value: T } | { ok: false; outcome: AiRunOutcomeLike }> {
    const book = options.jobs;
    book?.record({ jobId: job.id, capability });
    // A refused cancel (the provider's paid step started) keeps the job running: its result still counts.
    let refused = false;
    const stop = job.subscribe?.((update) => {
        if (update.cancellable === false) refused = true;
        const progress: AiRunProgressLike = { jobId: job.id, status: update.status };
        if (update.progress !== undefined) progress.progress = update.progress;
        if (update.message !== undefined) progress.message = update.message;
        if (update.cancellable !== undefined) progress.cancellable = update.cancellable;
        context.onProgress?.(progress);
        book?.update(job.id, {
            status: update.status, progress: update.progress, message: update.message, cancellable: update.cancellable,
            ...(update.status === "failed" && update.error !== undefined ? { error: update.error } : {}),
        });
    });
    const cancel = () => void job.cancel();
    if (context.signal?.aborted) cancel();
    else context.signal?.addEventListener("abort", cancel, { once: true });
    try {
        return { ok: true, value: await job.result() };
    } catch (error) {
        if (error instanceof JobCancelledError || (context.signal?.aborted && !refused)) {
            book?.update(job.id, { status: "cancelled" });
            return { ok: false, outcome: { jobId: job.id, cancelled: true } };
        }
        const refunded = error instanceof JobFailedError && error.refunded !== undefined ? error.refunded : undefined;
        book?.update(job.id, { status: "failed", error: errorText(error), refunded });
        if (error instanceof CapabilityUnavailableError) return { ok: false, outcome: { jobId: job.id, unavailable: true, error: error.message } };
        return { ok: false, outcome: { jobId: job.id, error: errorText(error) } };
    } finally {
        context.signal?.removeEventListener("abort", cancel);
        stop?.();
    }
}

function projectIdOf(snapshot: unknown): string | null {
    const id = (snapshot as { projectId?: unknown } | null)?.projectId;
    return typeof id === "string" ? id : null;
}

async function runCapability(
    provider: Provider,
    capability: ProviderCapability,
    request: AiRunRequestLike,
    context: AiRunContextLike,
    options: AiRunnerOptions,
): Promise<AiRunOutcomeLike> {
    const input = runInput(request.input);
    if (typeof input === "string") return { error: `ai.run ${capability}: ${input}` };
    const placeAt = placeAtOf(capability, request.placeAt);
    if (typeof placeAt === "string") return { error: `ai.run ${capability}: placeAt ${placeAt}` };
    if (!provider.run) return { error: `Provider "${provider.info.id}" declares ${capability} but has no run method.` };
    let job: Job<CapabilityOutput>;
    try {
        job = provider.run({ capability, input, projectId: projectIdOf(context.snapshot) });
    } catch (error) {
        if (error instanceof CapabilityUnavailableError) return { unavailable: true, error: error.message };
        return { error: errorText(error) };
    }
    const ran = await runJob(job, capability, context, options);
    if (!ran.ok) return ran.outcome;
    if (!isCapabilityOutput(ran.value)) return { jobId: job.id, error: `Provider "${provider.info.id}" returned no media list.` };
    if (ran.value.costUsd !== undefined) options.jobs?.update(job.id, { costUsd: ran.value.costUsd });
    const projectId = projectIdOf(context.snapshot);
    const media: GeneratedMedia[] = [];
    for (const item of ran.value.media) {
        if (options.importMedia) {
            try {
                const stored = await options.importMedia(item, { projectId });
                const size = item.width && item.height ? { width: item.width, height: item.height } : {};
                media.push({ kind: item.kind, ...size, ...stored, ...(item.role !== undefined ? { role: item.role } : {}) });
            } catch (error) {
                return { jobId: job.id, error: `The result could not be added to the media library: ${errorText(error)}` };
            }
        } else {
            const { bytes: _bytes, ...rest } = item;
            media.push(rest);
        }
    }
    const output: CapabilityOutput = { media };
    if (ran.value.result !== undefined) output.result = ran.value.result;
    if (ran.value.costUsd !== undefined) output.costUsd = ran.value.costUsd;
    if (ran.value.sourceSize !== undefined) output.sourceSize = ran.value.sourceSize;
    const outcome: AiRunOutcomeLike = { jobId: job.id, output };
    if (placeAt) {
        const placement = mediaPlacement(placeAt, output);
        if (typeof placement === "string") return { jobId: job.id, output, error: placement };
        outcome.placement = placement;
    }
    return outcome;
}

function transcriber(registry: ProviderRegistry, engine: Engine | undefined): Provider | string {
    if (engine === "local") return registry.providerFor("audio.transcribe", { onDevice: true }) ?? "Captions on this device are not available here (the desktop app makes them).";
    if (engine === "cloud") return registry.providerFor("audio.transcribe", { onDevice: false }) ?? "No cloud captions provider is connected: sign in with OpenNan to make captions in the cloud.";
    return registry.route("audio.transcribe") ?? capabilityUnavailableMessage("ai.run", "audio.transcribe");
}

async function runTranscribe(registry: ProviderRegistry, request: AiRunRequestLike, context: AiRunContextLike, options: AiRunnerOptions): Promise<AiRunOutcomeLike> {
    const parsed = transcribeInput(request.input, context.snapshot);
    if (typeof parsed === "string") return { error: `ai.run audio.transcribe: ${parsed}` };
    const placeAt = placeAtOf("audio.transcribe", request.placeAt);
    if (typeof placeAt === "string") return { error: `ai.run audio.transcribe: placeAt ${placeAt}` };
    const provider = transcriber(registry, parsed.engine);
    if (typeof provider === "string") return { unavailable: true, error: provider };
    const transcribe = provider.audio?.transcribe;
    if (!transcribe) return { error: `Provider "${provider.info.id}" declares audio.transcribe but has no transcribe method.` };
    let job: Job<Transcript>;
    try {
        job = transcribe.call(provider.audio, parsed.request);
    } catch (error) {
        if (error instanceof CapabilityUnavailableError) return { unavailable: true, error: error.message };
        return { error: errorText(error) };
    }
    const ran = await runJob(job, "audio.transcribe", context, options);
    if (!ran.ok) return ran.outcome;
    if (finite(ran.value.costUsd)) options.jobs?.update(job.id, { costUsd: ran.value.costUsd });
    const outcome: AiRunOutcomeLike = { jobId: job.id, output: ran.value };
    if (placeAt?.kind === "captions-track") {
        const cues = captionCues(ran.value, placeAt.timeOffset, placeAt.timeScale);
        if (cues.length > MAX_CAPTION_CUES) return { jobId: job.id, error: `The transcript has ${cues.length} caption lines, more than the ${MAX_CAPTION_CUES} the timeline takes at once.` };
        outcome.placement = { kind: "captions-track", style: placeAt.style, cues, ...(placeAt.label !== undefined ? { label: placeAt.label } : {}) };
    }
    return outcome;
}

export function createAiRunner(registry: ProviderRegistry, options: AiRunnerOptions = {}): AiRunner {
    return async (request, context) => {
        const { capability } = request;
        if (!isProviderCapability(capability)) return { error: `Unknown capability: ${capability}` };
        if (capability === "audio.transcribe") return runTranscribe(registry, request, context, options);
        const provider = registry.route(capability);
        if (!provider) return { unavailable: true, error: capabilityUnavailableMessage("ai.run", capability) };
        return runCapability(provider, capability, request, context, options);
    };
}
