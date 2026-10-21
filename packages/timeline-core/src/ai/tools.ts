// AI tools in the editor (phase 11): one plan per tool shared by the UI (inspector AI tab, AI library, context menu)
// and MCP, so both send the same ai.run / analysis command and an agent's run is undone like the user's. A plan names
// the capability, the input (media as source references, never bytes), where the result goes, and the units Studio
// knows before anything is sent (the price estimate reads them). Units are SOURCE seconds: what is uploaded.
import type { AiTargetRef } from "../controller/ai-run";
import type { BeatOptions, SilenceOptions } from "../analysis/host";
import { timelineDurationSeconds } from "../controller/frame-renderer";
import { captionStyleIdOf } from "../text/captions";
import { aiMediaSourceResult, type AiMediaSource, type AiSnapshot } from "./sources";

export const AI_TOOL_IDS = [
    "captions", "caption-translate", "voice-isolation", "video-upscale", "remove-background", "lipsync", "stems",
    "silences", "fillers", "beats", "stabilize",
] as const;
export type AiToolId = (typeof AI_TOOL_IDS)[number];

/** Tools that run on opennan.com (or another cloud provider) and cost money. captions is paid only with engine "cloud". */
export const PAID_AI_TOOLS: readonly AiToolId[] = ["caption-translate", "voice-isolation", "video-upscale", "remove-background", "lipsync", "stems"];

export type UpscaleResolution = "1080p" | "2k" | "4k";
export type MattingBackground = "transparent" | "green" | "blue" | "black" | "white";

export const UPSCALE_RESOLUTIONS: readonly UpscaleResolution[] = ["1080p", "2k", "4k"];
export const MATTING_BACKGROUNDS: readonly MattingBackground[] = ["transparent", "green", "blue", "black", "white"];

/** What the caller chose for one run. */
export interface AiToolParams extends AiTargetRef {
    /** captions / caption-translate: a text track (its index) instead of a clip. */
    trackIndex?: number;
    /** captions: "local" (on-device whisper) or "cloud" (OpenNan). Default: the routed provider. */
    engine?: "local" | "cloud";
    /** captions: spoken language ("auto" or a code); caption-translate: target language; fillers: the words' language. */
    language?: string;
    /** caption-translate: keep the source track (default true). */
    keepSource?: boolean;
    /** captions: caption style id. */
    style?: string;
    resolution?: UpscaleResolution;
    background?: MattingBackground;
    /** lipsync: the audio clip the mouth follows. */
    audioClipId?: string;
    /** stems: "vocals" (vocals + instrumental) or "all" (vocals, drums, bass, other). */
    stems?: "vocals" | "all";
    /** Over a tool's limit: send only the first N seconds of the used range ("Use the first 60 s"). */
    maxSeconds?: number;
    /** silences / beats: detector options passed to analysis.run. */
    analysisOptions?: SilenceOptions | BeatOptions;
}

/** Units known before a run (provider-sdk PriceUnits). */
export interface AiToolUnits {
    seconds?: number;
    characters?: number;
    segments?: number;
    resolution?: string;
    images?: number;
}

export interface AiToolLimit {
    maxSeconds?: number;
    maxCharacters?: number;
    maxSegments?: number;
}

export interface AiToolPlan {
    toolId: AiToolId;
    /** The provider capability (ai.run) or "local" analysis (analysis.run / analysis.fillers). */
    capability: string;
    input: Record<string, unknown>;
    placeAt?: Record<string, unknown>;
    units: AiToolUnits;
    /** The tool's own limit (from its server contract), when it has one. */
    limit?: AiToolLimit;
    /** Set when the used range is past the limit: the run needs maxSeconds (or fewer characters). */
    overLimit?: { kind: "seconds" | "characters" | "segments"; max: number; actual: number };
    target: AiTargetRef & { trackIndex?: number };
    /** A label for job rows and toasts ("Isolate voice · Interview.mp4"). */
    label: string;
}

export type AiToolPlanResult = { ok: true; plan: AiToolPlan } | { ok: false; error: string };

/** The tools' limits, as OpenNan's public API publishes them. */
export const AI_TOOL_LIMITS = {
    captions: { maxSeconds: 1800 },
    "caption-translate": { maxSegments: 2000, maxCharacters: 30_000, maxLineCharacters: 500 },
    "voice-isolation": { maxSeconds: 600 },
    "video-upscale": { maxSeconds: 60 },
    "remove-background": { maxSeconds: 120 },
    lipsync: { maxSeconds: 60, maxVideoSeconds: 120 },
    stems: { maxSeconds: 900 },
} as const;

/** Billed characters per caption line on top of its code points (the server's segment overhead). */
export const CAPTION_SEGMENT_OVERHEAD = 10;

export const AI_TOOL_NAMES: Record<AiToolId, string> = {
    captions: "Auto captions",
    "caption-translate": "Translate captions",
    "voice-isolation": "Isolate voice",
    "video-upscale": "Upscale video",
    "remove-background": "Remove background",
    lipsync: "Lip sync",
    stems: "Split vocals",
    silences: "Remove silences",
    fillers: "Remove filler words",
    beats: "Detect beats",
    stabilize: "Stabilize",
};

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;
const EPS = 1e-9;

const fail = (error: string): AiToolPlanResult => ({ ok: false, error });
const done = (plan: AiToolPlan): AiToolPlanResult => ({ ok: true, plan });
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface Span {
    startSeconds: number;
    endSeconds: number;
    seconds: number;
}

/** The used range, cut to the first `maxSeconds` when given. */
function usedSpan(source: Pick<AiMediaSource, "startSeconds" | "endSeconds">, maxSeconds: number | undefined): Span {
    let end = source.endSeconds;
    if (maxSeconds !== undefined && Number.isFinite(maxSeconds) && maxSeconds > 0) end = Math.min(end, source.startSeconds + maxSeconds);
    const startSeconds = round6(source.startSeconds);
    const endSeconds = round6(end);
    return { startSeconds, endSeconds, seconds: round6(Math.max(0, endSeconds - startSeconds)) };
}

const ref = (source: AiMediaSource, span: Span) => ({ mediaUrl: source.mediaUrl, startSeconds: span.startSeconds, endSeconds: span.endSeconds });
const range = (span: Span) => ({ startSeconds: span.startSeconds, endSeconds: span.endSeconds });

function overSeconds(seconds: number, max: number | undefined): AiToolPlan["overLimit"] | undefined {
    return max !== undefined && seconds > max + EPS ? { kind: "seconds", max, actual: seconds } : undefined;
}

const label = (toolId: AiToolId, name: string) => `${AI_TOOL_NAMES[toolId]} · ${name}`;

function resolve(snapshot: AiSnapshot, params: AiToolParams): { ok: true; source: AiMediaSource } | { ok: false; error: string } {
    if (!params.clipId && !params.sceneId) return { ok: false, error: "Select a clip or a scene" };
    return aiMediaSourceResult(snapshot, params);
}

const noAudio = (source: AiMediaSource) => (source.target.sceneId ? "This scene has no audio" : "This clip has no audio");

/** An item with sound (video or audio): voice isolation, stems, captions, local analysis. */
function audioSource(snapshot: AiSnapshot, params: AiToolParams): { ok: true; source: AiMediaSource } | { ok: false; error: string } {
    const resolved = resolve(snapshot, params);
    if (!resolved.ok) return resolved;
    if (resolved.source.kind === "image") return { ok: false, error: "Select a video or audio clip, or a scene with video" };
    if (!resolved.source.hasAudio) return { ok: false, error: noAudio(resolved.source) };
    return resolved;
}

/** A video item: upscale, background removal, lip sync, stabilize. */
function videoSource(snapshot: AiSnapshot, params: AiToolParams): { ok: true; source: AiMediaSource } | { ok: false; error: string } {
    const resolved = resolve(snapshot, params);
    if (!resolved.ok) return resolved;
    if (resolved.source.kind !== "video") return { ok: false, error: "Select a video clip or scene" };
    return resolved;
}

const targetOf = (source: AiMediaSource) => ({ ...source.target });

function planCaptions(snapshot: AiSnapshot, params: AiToolParams): AiToolPlanResult {
    const options = {
        ...(params.language ? { language: params.language } : {}),
        ...(params.engine ? { engine: params.engine } : {}),
    };
    const style = params.style ?? "caption";
    const max = AI_TOOL_LIMITS.captions.maxSeconds;
    if (!params.clipId && !params.sceneId) {
        const seconds = round6(timelineDurationSeconds(snapshot));
        if (!(seconds > 0)) return fail("The timeline is empty");
        const over = overSeconds(seconds, max);
        return done({
            toolId: "captions", capability: "audio.transcribe", input: { source: "timeline", ...options },
            placeAt: { kind: "captions-track", style }, units: { seconds }, limit: { maxSeconds: max }, ...(over ? { overLimit: over } : {}),
            target: {}, label: label("captions", "Timeline"),
        });
    }
    const resolved = audioSource(snapshot, params);
    if (!resolved.ok) return resolved;
    const source = resolved.source;
    const span = usedSpan(source, params.maxSeconds);
    const over = overSeconds(span.seconds, max);
    return done({
        toolId: "captions", capability: "audio.transcribe", input: { source: ref(source, span), ...options },
        placeAt: { kind: "captions-track", style, timeOffset: source.timelineStart, timeScale: source.speed },
        units: { seconds: span.seconds }, limit: { maxSeconds: max }, ...(over ? { overLimit: over } : {}),
        target: targetOf(source), label: label("captions", source.label),
    });
}

function planTranslate(snapshot: AiSnapshot, params: AiToolParams): AiToolPlanResult {
    let trackIndex: number | undefined;
    if (params.clipId) {
        const clip = snapshot.clips.find((c) => c.id === params.clipId);
        if (!clip) return fail("No matching clip");
        if (clip.trackType !== "text") return fail("Select a caption clip or a captions track");
        trackIndex = clip.trackIndex;
    } else if (params.trackIndex !== undefined) {
        trackIndex = params.trackIndex;
        const exists = snapshot.tracks.some((t) => t.type === "text" && t.index === trackIndex) || snapshot.clips.some((c) => c.trackType === "text" && c.trackIndex === trackIndex);
        if (!exists) return fail("No matching text track");
    } else {
        return fail("Select a caption clip or a captions track");
    }
    const language = params.language?.trim();
    if (!language) return fail("Choose the language to translate into");
    if (!LANGUAGE.test(language)) return fail(`"${language}" is not a language code (like th, ja, zh-TW, pt-BR)`);
    const keepSource = params.keepSource ?? true;
    if (!keepSource && snapshot.tracks.some((t) => t.type === "text" && t.index === trackIndex && t.locked)) return fail("The captions track is locked");
    const clips = snapshot.clips
        .filter((c) => c.trackType === "text" && c.trackIndex === trackIndex && (c.textContent ?? "").trim().length > 0)
        .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    if (clips.length === 0) return fail("This track has no captions to translate");
    const segments = clips.map((c) => ({ start: c.startTime, end: c.endTime, text: c.textContent! }));
    const lengths = segments.map((s) => Array.from(s.text).length);
    const raw = lengths.reduce((sum, n) => sum + n, 0);
    const characters = raw + CAPTION_SEGMENT_OVERHEAD * segments.length;
    const limits = AI_TOOL_LIMITS["caption-translate"];
    const longest = Math.max(...lengths);
    const overLimit: AiToolPlan["overLimit"] = segments.length > limits.maxSegments
        ? { kind: "segments", max: limits.maxSegments, actual: segments.length }
        : raw > limits.maxCharacters
            ? { kind: "characters", max: limits.maxCharacters, actual: raw }
            : longest > limits.maxLineCharacters
                ? { kind: "characters", max: limits.maxLineCharacters, actual: longest }
                : undefined;
    const styleIds = new Set(clips.map((c) => captionStyleIdOf(c.textStyle)));
    const style = styleIds.size === 1 ? [...styleIds][0] : null;
    const trackLabel = snapshot.tracks.find((t) => t.type === "text" && t.index === trackIndex)?.label || `T${trackIndex}`;
    return done({
        toolId: "caption-translate", capability: "captions.translate",
        input: { segments, targetLanguage: language },
        placeAt: { kind: "captions-track-translated", sourceTrackIndex: trackIndex, language, keepSource, ...(style ? { style } : {}) },
        units: { characters, segments: segments.length },
        limit: { maxCharacters: limits.maxCharacters, maxSegments: limits.maxSegments },
        ...(overLimit ? { overLimit } : {}),
        target: { trackIndex, ...(params.clipId ? { clipId: params.clipId } : {}) },
        label: label("caption-translate", `${trackLabel} → ${language}`),
    });
}

function planMediaTool(snapshot: AiSnapshot, toolId: AiToolId, params: AiToolParams): AiToolPlanResult {
    switch (toolId) {
        case "voice-isolation":
        case "stems": {
            const resolved = audioSource(snapshot, params);
            if (!resolved.ok) return resolved;
            const source = resolved.source;
            const span = usedSpan(source, params.maxSeconds);
            const max = AI_TOOL_LIMITS[toolId].maxSeconds;
            const over = overSeconds(span.seconds, max);
            const stems = params.stems ?? "vocals";
            if (toolId === "stems" && stems !== "vocals" && stems !== "all") return fail(`Unknown stems choice "${String(stems)}"`);
            return done({
                toolId, capability: toolId === "stems" ? "audio.separate" : "audio.isolate-voice",
                input: toolId === "stems" ? { source: ref(source, span), stems } : { source: ref(source, span) },
                placeAt: { kind: "replace-audio", source: targetOf(source), range: range(span) },
                units: { seconds: span.seconds }, limit: { maxSeconds: max }, ...(over ? { overLimit: over } : {}),
                target: targetOf(source), label: label(toolId, source.label),
            });
        }
        case "video-upscale":
        case "remove-background":
        case "stabilize": {
            const resolved = videoSource(snapshot, params);
            if (!resolved.ok) return resolved;
            const source = resolved.source;
            const span = usedSpan(source, params.maxSeconds);
            const max = toolId === "stabilize" ? undefined : AI_TOOL_LIMITS[toolId].maxSeconds;
            const over = overSeconds(span.seconds, max);
            let input: Record<string, unknown> = { source: ref(source, span) };
            const units: AiToolUnits = { seconds: span.seconds };
            if (toolId === "video-upscale") {
                const resolution = params.resolution ?? "1080p";
                if (!UPSCALE_RESOLUTIONS.includes(resolution)) return fail(`Unknown resolution "${String(resolution)}" (1080p, 2k, or 4k)`);
                input = { ...input, resolution };
                units.resolution = resolution;
            } else if (toolId === "remove-background") {
                const background = params.background ?? "transparent";
                if (!MATTING_BACKGROUNDS.includes(background)) return fail(`Unknown background "${String(background)}"`);
                input = { ...input, background };
            }
            return done({
                toolId, capability: toolId === "video-upscale" ? "video.upscale" : toolId === "remove-background" ? "video.remove-background" : "media.stabilize",
                input, placeAt: { kind: "stack-video", source: targetOf(source), range: range(span) }, units,
                ...(max !== undefined ? { limit: { maxSeconds: max } } : {}), ...(over ? { overLimit: over } : {}),
                target: targetOf(source), label: label(toolId, source.label),
            });
        }
        case "lipsync": {
            const resolved = videoSource(snapshot, params);
            if (!resolved.ok) return resolved;
            const source = resolved.source;
            if (!params.audioClipId) return fail("Choose the audio clip the lips follow");
            const audioClip = snapshot.clips.find((c) => c.id === params.audioClipId);
            if (!audioClip || audioClip.trackType !== "audio") return fail("Choose the audio clip the lips follow");
            const audio = aiMediaSourceResult(snapshot, { clipId: audioClip.id });
            if (!audio.ok) return audio;
            const span = usedSpan(source, params.maxSeconds);
            const audioSpan = usedSpan(audio.source, params.maxSeconds);
            const limits = AI_TOOL_LIMITS.lipsync;
            const over = overSeconds(audioSpan.seconds, limits.maxSeconds) ?? overSeconds(span.seconds, limits.maxVideoSeconds);
            return done({
                toolId, capability: "video.lipsync",
                input: { videoSource: ref(source, span), audioSource: ref(audio.source, audioSpan) },
                placeAt: { kind: "stack-video", source: targetOf(source), range: range(span), muteSource: true, audioClipId: audioClip.id },
                units: { seconds: audioSpan.seconds }, limit: { maxSeconds: limits.maxSeconds }, ...(over ? { overLimit: over } : {}),
                target: targetOf(source), label: label(toolId, source.label),
            });
        }
        default:
            return fail(`${toolId} is not a media tool`);
    }
}

function planLocal(snapshot: AiSnapshot, toolId: "silences" | "beats" | "fillers", params: AiToolParams): AiToolPlanResult {
    const resolved = toolId === "fillers" ? resolve(snapshot, params) : audioSource(snapshot, params);
    if (!resolved.ok) return resolved;
    const source = resolved.source;
    if (toolId === "fillers" && source.kind === "image") return fail("Select a video or audio clip, or a scene with video");
    const item = source.target.clipId ? { clipId: source.target.clipId } : { sceneId: source.target.sceneId };
    const span = usedSpan(source, undefined);
    const input = toolId === "fillers"
        ? { kind: "fillers", ...item, ...(params.language ? { language: params.language } : {}) }
        : { kind: toolId, ...item, options: { ...(params.analysisOptions ?? {}) } };
    return done({ toolId, capability: "local", input, units: { seconds: span.seconds }, target: targetOf(source), label: label(toolId, source.label) });
}

/** Builds the run of one tool on the current timeline. */
export function planAiTool(snapshot: AiSnapshot, toolId: AiToolId, params: AiToolParams = {}): AiToolPlanResult {
    switch (toolId) {
        case "captions":
            return planCaptions(snapshot, params);
        case "caption-translate":
            return planTranslate(snapshot, params);
        case "silences":
        case "beats":
        case "fillers":
            return planLocal(snapshot, toolId, params);
        case "voice-isolation":
        case "stems":
        case "video-upscale":
        case "remove-background":
        case "stabilize":
        case "lipsync":
            return planMediaTool(snapshot, toolId, params);
        default:
            return fail(`Unknown AI tool "${String(toolId)}"`);
    }
}
