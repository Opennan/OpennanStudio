// Prices (phase 11): Provider.price() from the price blocks OpenNan publishes, through the provider-sdk estimate
// rule (never below what a run settles at). Tools come from GET /v1/tools, models from GET /v1/models?category=,
// voices from GET /v1/audio/voices; none needs a key, each list is cached for ten minutes per provider, and a list
// that cannot be read answers { kind: "unknown" } (the run may still ask the server). Phase 11.1: the amount is the
// server's own quote (POST /v1/quotes, quotes.ts) whenever it answers; the tools list still decides status and
// limits; without a quote (an older server, 429, 503) the local estimate answers, never under.
import {
    captionBilledCharacters, estimateImageCost, estimateMusicCost, estimateReferenceVideoCost, referenceBilledSeconds, type ReferenceVideoPriceRow, estimateStemsCost, estimateTextCost, estimateToolCost, estimateVideoModelCost, estimateVoiceCost, isOverLimit,
    promptTokenBound, type CostEstimate, type ImageModelPrice, type TextModelPrice, type OverLimit, type PriceAnswer, type PriceRequest, type PriceUnits, type ProviderCapability, type ProviderModel,
    type ProviderVoice, type StemsModelPrice, type ToolPriceBlock, type VideoModelPrice, type VoiceModelPrice, quotedEstimate,
} from "@opennan/provider-sdk";
import type { OpenNanApi } from "./api";
import { TIER_NOT_OFFERED_MESSAGE } from "./errors";
import { quoteBody, type QuoteClient } from "./quotes";
import { parseReferenceLimits, referenceSecondsOf } from "./references";

/** The output cap a text call sends when the input names none. */
export const DEFAULT_TEXT_MAX_TOKENS = 8_000;

export const CATALOG_CACHE_MS = 10 * 60_000;
export const PRICES_UNAVAILABLE = "OpenNan prices are not available right now.";
const SEPARATION_ENDPOINT = "/v1/audio/separations";

/** The OpenNan tool each media capability runs on (GET /v1/tools ids), with the name its status message uses. */
export const OPENNAN_TOOLS: Partial<Record<ProviderCapability, { id: string; name: string }>> = {
    "audio.transcribe": { id: "transcribe", name: "Cloud captions" },
    "captions.translate": { id: "caption-translate", name: "Caption translation" },
    "audio.isolate-voice": { id: "voice-isolation", name: "Voice isolation" },
    "video.upscale": { id: "video-upscale", name: "Video upscale" },
    "video.remove-background": { id: "remove-background", name: "Background removal" },
    "video.lipsync": { id: "lipsync", name: "Lip sync" },
    "audio.sfx": { id: "sound-effects", name: "Sound effects" },
};

/** The GET /v1/models category of each model capability. */
export const MODEL_CATEGORY: Partial<Record<ProviderCapability, string>> = {
    "image.generate": "image", "image.edit": "image",
    "video.text-to-video": "video", "video.image-to-video": "video",
    "audio.tts": "voice", "audio.music": "music", "audio.separate": "music",
    "text.generate": "text",
};

export interface ToolRow {
    id: string;
    status: string;
    price: ToolPriceBlock | null;
}

interface ModelRow {
    id?: unknown;
    name?: unknown;
    endpoint?: unknown;
    price?: unknown;
    durations?: unknown;
    qualities?: unknown;
    sizes?: unknown;
    vision?: unknown;
    inputs?: unknown;
    reference_videos?: unknown;
}

interface Cached<T> {
    at: number;
    value: T;
}

export interface OpenNanCatalog {
    /** Throws when the list cannot be read. */
    tools(): Promise<ToolRow[]>;
    /** A capability's models (the first is the default). Throws when the list cannot be read. */
    models(capability: ProviderCapability): Promise<ProviderModel[]>;
    voices(): Promise<ProviderVoice[]>;
}

/** A price list read never waits longer than this (a run's price re-check reads it too). */
export const CATALOG_TIMEOUT_MS = 10_000;

export function createOpenNanCatalog(api: OpenNanApi, options: { now?(): number; timeoutMs?: number } = {}): OpenNanCatalog {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
    const bounded = () => AbortSignal.timeout(timeoutMs);
    let tools: Cached<ToolRow[]> | null = null;
    let voices: Cached<ProviderVoice[]> | null = null;
    const categories = new Map<string, Cached<ModelRow[]>>();
    const fresh = <T>(entry: Cached<T> | null | undefined): entry is Cached<T> => Boolean(entry && now() - entry.at < CATALOG_CACHE_MS);

    async function rows(category: string): Promise<ModelRow[]> {
        const cached = categories.get(category);
        if (fresh(cached)) return cached.value;
        const answer = await api.request<{ data?: unknown }>("GET", "/v1/models", { query: { category }, signal: bounded() });
        const list = Array.isArray(answer.data) ? (answer.data as ModelRow[]).filter((row) => typeof row?.id === "string") : [];
        categories.set(category, { at: now(), value: list });
        return list;
    }

    return {
        async tools() {
            if (fresh(tools)) return tools.value;
            const answer = await api.request<{ data?: unknown }>("GET", "/v1/tools", { signal: bounded() });
            const list = (Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : [])
                .filter((row) => typeof row?.id === "string")
                .map((row) => ({
                    id: row.id as string, status: typeof row.status === "string" ? row.status : "unavailable",
                    price: typeof row.price === "object" && row.price !== null ? (row.price as ToolPriceBlock) : null,
                }));
            tools = { at: now(), value: list };
            return list;
        },
        async models(capability) {
            if (capability === "audio.transcribe") return [{ id: "cloud", label: "OpenNan cloud", default: true }];
            const category = MODEL_CATEGORY[capability];
            if (!category) return [];
            let list = await rows(category);
            if (capability === "audio.separate") list = list.filter((row) => row.endpoint === SEPARATION_ENDPOINT);
            else if (category === "music") list = list.filter((row) => row.endpoint !== SEPARATION_ENDPOINT);
            return list.map((row, index) => {
                const model: ProviderModel = { id: row.id as string, label: typeof row.name === "string" ? row.name : (row.id as string) };
                if (index === 0) model.default = true;
                if (row.price !== undefined && row.price !== null) model.price = row.price;
                if (Array.isArray(row.durations) && row.durations.every((d) => typeof d === "number")) model.durations = [...(row.durations as number[])];
                // Video models list their qualities, image models their sizes.
                const qualities = category === "image" ? row.sizes : row.qualities;
                if (Array.isArray(qualities) && qualities.length > 0 && qualities.every((q) => typeof q === "string")) model.qualities = [...(qualities as string[])];
                if (row.vision === true) model.vision = true;
                // A video model that takes reference videos lists the input and publishes their limits.
                const takesVideos = !Array.isArray(row.inputs) || row.inputs.includes("reference_videos");
                const limits = category === "video" && takesVideos ? parseReferenceLimits(row.reference_videos) : undefined;
                if (limits) model.referenceVideos = limits;
                return model;
            });
        },
        async voices() {
            if (fresh(voices)) return voices.value;
            try {
                const answer = await api.request<{ data?: unknown }>("GET", "/v1/audio/voices", { signal: bounded() });
                const list = (Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : [])
                    .filter((row) => typeof row?.id === "string" && typeof row.name === "string")
                    .map((row) => {
                        const voice: ProviderVoice = { id: row.id as string, name: row.name as string, language: typeof row.language === "string" ? row.language : "" };
                        if (typeof row.gender === "string") voice.gender = row.gender;
                        if (typeof row.model === "string") voice.model = row.model;
                        return voice;
                    });
                voices = { at: now(), value: list };
                return list;
            } catch {
                return [];
            }
        },
    };
}

const unknown = (reason?: string): PriceAnswer => (reason === undefined ? { kind: "unknown" } : { kind: "unknown", reason });

function answerOf(value: CostEstimate | OverLimit | null, missing: string): PriceAnswer {
    if (value === null) return unknown(missing);
    if (isOverLimit(value)) return { kind: "over-limit", limit: value };
    return { kind: "estimate", estimate: value };
}

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

function toolUnits(capability: ProviderCapability, input: Record<string, unknown>, units: PriceUnits): PriceUnits {
    switch (capability) {
        case "captions.translate": {
            const segments = input.segments;
            if (Array.isArray(segments) && segments.every((s) => typeof (s as { text?: unknown })?.text === "string")) {
                return { characters: captionBilledCharacters(segments as Array<{ text: string }>), segments: segments.length };
            }
            return units;
        }
        case "video.upscale":
            return { ...units, resolution: units.resolution ?? (typeof input.resolution === "string" ? input.resolution : "1080p") };
        case "audio.sfx":
            // The length the call sends wins over a caller's units.
            return { ...units, ...(positive(input.durationSeconds) !== undefined ? { seconds: input.durationSeconds as number } : {}) };
        default:
            return units;
    }
}

/** The most a tool run holds while it goes: its block's estimate at the longest input (the amount for exact units). */
function toolHoldUsd(block: ToolPriceBlock, units: PriceUnits, estimate: CostEstimate): number {
    const maxSeconds = positive(block.max_seconds) ?? (positive(block.max_minutes) !== undefined ? block.max_minutes! * 60 : undefined);
    if (maxSeconds === undefined || units.seconds === undefined || block.unit === "sound_second") return estimate.usd;
    const hold = estimateToolCost(block, { ...units, seconds: maxSeconds });
    return hold && !isOverLimit(hold) ? Math.max(hold.usd, estimate.usd) : estimate.usd;
}

/** A local estimate as an answer: marked as the estimate, with the hold the balance must cover. */
function fallbackOf(value: CostEstimate | OverLimit | null, missing: string, hold?: (estimate: CostEstimate) => number): PriceAnswer {
    const answer = answerOf(value, missing);
    if (answer.kind !== "estimate") return answer;
    return { kind: "estimate", estimate: { ...answer.estimate, source: "estimate", holdUsd: hold ? hold(answer.estimate) : answer.estimate.usd } };
}

/**
 * The server's quote of this run when it answers, else the local answer. A quality the server does not sell is
 * unavailable; any other refusal or failure keeps the local estimate (never under).
 */
async function withQuote(quotes: QuoteClient | undefined, body: Record<string, unknown> | null, local: PriceAnswer): Promise<PriceAnswer> {
    if (!quotes || !body) return local;
    if (local.kind !== "estimate" && local.kind !== "unknown") return local;
    const result = await quotes.quote(body);
    if (result.kind === "quote") {
        const units = local.kind === "estimate" ? local.estimate.units : 1;
        const capped = local.kind === "estimate" ? local.estimate.capped : false;
        return { kind: "estimate", estimate: quotedEstimate({ priceUsd: result.priceUsd, holdUsd: result.holdUsd, units, capped }) };
    }
    if (result.kind === "refused" && result.code === "tier_not_offered") return { kind: "unavailable", reason: TIER_NOT_OFFERED_MESSAGE };
    return local;
}

const present = (value: unknown) => value !== undefined && value !== null && value !== "";

/** The tokens a text.generate input may bill: its prompt and instruction (each image at its most), and its output cap. */
export function textTokens(input: Record<string, unknown>): { promptTokens: number; maxTokens: number } {
    const texts = [input.instruction, input.prompt].filter((t): t is string => typeof t === "string" && t.length > 0);
    const images = Array.isArray(input.images) ? input.images.length : 0;
    const maxTokens = positive(input.maxTokens) ?? DEFAULT_TEXT_MAX_TOKENS;
    return { promptTokens: promptTokenBound(texts, images), maxTokens: Math.round(maxTokens) };
}

/** The price of one run (PriceRequest) on OpenNan: its quote when the server gives one, else the estimate. Never rejects. */
export async function priceRun(catalog: OpenNanCatalog, request: PriceRequest, quotes?: QuoteClient): Promise<PriceAnswer> {
    const { capability, input, units } = request;
    try {
        // The video download is free (rate limited on the server).
        if (capability === "web.fetch") return { kind: "free" };
        const tool = OPENNAN_TOOLS[capability];
        if (tool) {
            const toolUnitsNow = toolUnits(capability, input, units);
            let rows: ToolRow[];
            try {
                rows = await catalog.tools();
            } catch {
                // The list could not be read: the quote alone can still price the run (it refuses a tool that can't run).
                return withQuote(quotes, quoteBody(capability, input, toolUnitsNow), unknown(PRICES_UNAVAILABLE));
            }
            const row = rows.find((r) => r.id === tool.id);
            if (!row) return unknown(`${tool.name} has no price on OpenNan.`);
            if (row.status === "soon") return { kind: "unavailable", reason: `${tool.name} is coming soon on OpenNan.` };
            if (row.status !== "live") return { kind: "unavailable", reason: `${tool.name} is unavailable on OpenNan right now.` };
            if (!row.price) return unknown(`${tool.name} has no price on OpenNan.`);
            const block = row.price;
            const local = fallbackOf(estimateToolCost(block, toolUnitsNow), `${tool.name} needs the length or size of what it runs on.`, (e) => toolHoldUsd(block, toolUnitsNow, e));
            return withQuote(quotes, quoteBody(capability, input, toolUnitsNow), local);
        }
        if (!MODEL_CATEGORY[capability]) return unknown();
        const models = await catalog.models(capability);
        // A text call that sends images without a model runs on the first that sees them: it is priced on that one.
        const sendsImages = capability === "text.generate" && Array.isArray(input.images) && input.images.length > 0;
        const chosen = typeof input.model === "string" ? models.find((m) => m.id === input.model) : sendsImages ? models.find((m) => m.vision) : models[0];
        if (!chosen) return unknown("OpenNan lists no such model.");
        const quoted = (local: PriceAnswer) => withQuote(quotes, quoteBody(capability, input, units, chosen.id), local);
        switch (capability) {
            case "image.generate":
            case "image.edit":
            {
                // The images the call sends count (image edit always sends one), whatever a caller's units say.
                const sent = (present(input.image) || capability === "image.edit" ? 1 : 0) + (Array.isArray(input.images) ? input.images.length : 0);
                const tier = { ...(typeof input.size === "string" ? { size: input.size } : {}), ...(typeof input.quality === "string" ? { quality: input.quality } : {}) };
                return quoted(fallbackOf(estimateImageCost(chosen.price as ImageModelPrice, Math.max(units.images ?? 0, sent), tier), "This model has no price for that size."));
            }
            case "video.text-to-video":
            case "video.image-to-video": {
                const seconds = positive(input.durationSeconds) ?? units.seconds ?? chosen.durations?.[0];
                const tier = { ...(typeof input.quality === "string" ? { quality: input.quality } : {}), ...(typeof input.generateAudio === "boolean" ? { audio: input.generateAudio } : {}) };
                if (Array.isArray(input.referenceVideos) && input.referenceVideos.length > 0) {
                    // A remake bills the reference seconds with the output's: the references' known length with the
                    // decode margin, rounded up (unknown: the most the model takes, which the server holds).
                    const limits = chosen.referenceVideos;
                    if (!limits) return { kind: "unavailable", reason: `${chosen.label} does not take reference videos.` };
                    const billed = referenceBilledSeconds(units.referenceSeconds ?? referenceSecondsOf(input), limits);
                    const rows = (chosen.price as { reference_videos?: ReferenceVideoPriceRow[] } | undefined)?.reference_videos;
                    // An edit is as long as its video, and billed so: its output seconds are the reference seconds.
                    const output = input.referenceMode === "editing" ? billed : seconds;
                    const local = fallbackOf(output === undefined ? null : estimateReferenceVideoCost(rows, output, billed, tier.quality), "This model has no price for reference videos at that quality.");
                    return withQuote(quotes, quoteBody(capability, input, { ...units, referenceSeconds: billed }, chosen.id), local);
                }
                return quoted(fallbackOf(seconds === undefined ? null : estimateVideoModelCost(chosen.price as VideoModelPrice, seconds, tier), "This model has no price for that length and quality."));
            }
            case "text.generate":
                // No quote for text: the never-under bound of the prompt and the output cap the call sends.
                return fallbackOf(estimateTextCost(chosen.price as TextModelPrice, textTokens(input)), "This model has no price.");
            case "audio.tts": {
                const characters = typeof input.text === "string" && input.text ? [...input.text].length : units.characters;
                return quoted(fallbackOf(characters === undefined ? null : estimateVoiceCost(chosen.price as VoiceModelPrice, characters), "Speech needs its text."));
            }
            case "audio.music": {
                const seconds = positive(input.durationSeconds) ?? units.seconds ?? 30;
                return quoted(fallbackOf(estimateMusicCost(chosen.price as { from_usd?: number }, seconds), "This model has no price."));
            }
            case "audio.separate":
                return quoted(fallbackOf(units.seconds === undefined ? null : estimateStemsCost(chosen.price as StemsModelPrice, units.seconds), "Splitting stems needs the length of the audio."));
            default:
                return unknown();
        }
    } catch {
        return unknown(PRICES_UNAVAILABLE);
    }
}
