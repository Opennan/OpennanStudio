// Exact prices (phase 11.1): POST /v1/quotes answers what a call would settle at (price_usd) and hold (hold_usd),
// worked out by the same function the server bills the call with. No key, free, limited per IP (120 a minute), so
// quotes are cached per canonical body for a minute and a request in flight is shared. The body is the call Studio is
// about to send, without its prompt (a price never depends on its words) and with a fixed placeholder link for each
// image input (the quote only counts that one is there). Per-unit tools are quoted with the decode margin (the server
// settles on the length it decodes). An older server (404) is not asked again for ten minutes; a 429 waits for its
// Retry-After; anything else that fails answers "fallback", and the caller shows the never-under local estimate.
import { paddedSeconds, type PriceUnits, type ProviderCapability } from "@opennan/provider-sdk";
import type { OpenNanApi } from "./api";
import { OpenNanApiError } from "./errors";

export const QUOTE_PATH = "/v1/quotes";
export const QUOTE_CACHE_MS = 60_000;
/** An older server without the route is asked again after this long. */
export const QUOTE_UNSUPPORTED_MS = 10 * 60_000;
/** A rate limit without Retry-After pauses quotes this long. */
export const QUOTE_RATE_LIMIT_MS = 60_000;
/** What an image input is in a quote body: the server prices that one is there, it never fetches it. */
export const QUOTE_IMAGE_PLACEHOLDER = "https://opennan.com/studio/quote-input.png";
/** What a reference video is in a quote body (counted, never fetched). */
export const QUOTE_VIDEO_PLACEHOLDER = "https://opennan.com/studio/quote-input.mp4";

/** The per-unit tools: their GET /v1/tools id and longest input (the most seconds its quote takes). */
const UNIT_TOOLS: Partial<Record<ProviderCapability, { tool: string; maxSeconds: number }>> = {
    "audio.transcribe": { tool: "transcribe", maxSeconds: 1800 },
    "audio.isolate-voice": { tool: "voice-isolation", maxSeconds: 600 },
    "video.remove-background": { tool: "remove-background", maxSeconds: 120 },
    "video.lipsync": { tool: "lipsync", maxSeconds: 60 },
    "video.upscale": { tool: "video-upscale", maxSeconds: 60 },
};
const SEPARATION_MAX_SECONDS = 900;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): number | undefined => (finite(value) && value > 0 ? value : undefined);
const present = (value: unknown) => value !== undefined && value !== null && value !== "";

/**
 * The quote body of one run, or null when it cannot be quoted (no length yet, not a priced call, a field the server
 * would refuse). `model` is the model the call runs on (the caller resolves the default).
 */
export function quoteBody(capability: ProviderCapability, input: Record<string, unknown>, units: PriceUnits, model?: string): Record<string, unknown> | null {
    const unitTool = UNIT_TOOLS[capability];
    if (unitTool) {
        const seconds = units.seconds;
        // Past the tool's limit nothing is quoted: the server refuses such a run (the padding must never hide it).
        if (!finite(seconds) || seconds < 0 || seconds > unitTool.maxSeconds) return null;
        const body: Record<string, unknown> = { tool: unitTool.tool, seconds: paddedSeconds(seconds, unitTool.maxSeconds) };
        if (capability === "video.upscale") body.resolution = units.resolution ?? (typeof input.resolution === "string" ? input.resolution : "1080p");
        return body;
    }
    switch (capability) {
        case "captions.translate": {
            const segments = input.segments;
            if (!Array.isArray(segments) || segments.length === 0 || !segments.every((s) => typeof (s as { text?: unknown })?.text === "string")) return null;
            return { tool: "caption-translate", segments: (segments as Array<{ start: number; end: number; text: string }>).map(({ start, end, text }) => ({ start, end, text })) };
        }
        case "audio.sfx": {
            // Exactly what the call sends (duration_seconds from the input); without it the quote is the longest one.
            const seconds = positive(input.durationSeconds);
            return seconds === undefined ? { tool: "sound-effects" } : { tool: "sound-effects", seconds };
        }
        default:
            break;
    }
    if (!model) return null;
    switch (capability) {
        case "video.text-to-video":
        case "video.image-to-video": {
            // The duration the call sends (none: the server's default length, which the quote prices the same way).
            const duration = positive(input.durationSeconds);
            if (duration !== undefined && !Number.isInteger(duration)) return null;
            const body: Record<string, unknown> = { model };
            if (duration !== undefined) body.duration = duration;
            if (typeof input.aspectRatio === "string") body.aspect_ratio = input.aspectRatio;
            const videos = Array.isArray(input.referenceVideos) ? input.referenceVideos : [];
            if (videos.length > 0) {
                // A remake: the references (counted, never fetched) and the seconds they bill; no first frame.
                body.reference_videos = videos.map(() => QUOTE_VIDEO_PLACEHOLDER);
                body.reference_mode = typeof input.referenceMode === "string" ? input.referenceMode : "reference";
                if (finite(units.referenceSeconds) && units.referenceSeconds > 0) body.seconds = Math.ceil(units.referenceSeconds - 1e-9);
            } else {
                if (capability === "video.image-to-video" || present(input.image)) body.image = QUOTE_IMAGE_PLACEHOLDER;
                if (present(input.endImage)) body.end_image = QUOTE_IMAGE_PLACEHOLDER;
            }
            if (Array.isArray(input.referenceImages) && input.referenceImages.length > 0) body.reference_images = input.referenceImages.map(() => QUOTE_IMAGE_PLACEHOLDER);
            if (typeof input.quality === "string") body.quality = input.quality;
            if (typeof input.generateAudio === "boolean") body.generate_audio = input.generateAudio;
            return body;
        }
        case "image.generate":
        case "image.edit": {
            const body: Record<string, unknown> = { model };
            if (typeof input.aspectRatio === "string") body.aspect_ratio = input.aspectRatio;
            if (capability === "image.edit" || present(input.image) || (units.images ?? 0) > 0) body.image = QUOTE_IMAGE_PLACEHOLDER;
            if (Array.isArray(input.images) && input.images.length > 0) body.images = input.images.map(() => QUOTE_IMAGE_PLACEHOLDER);
            if (typeof input.size === "string") body.size = input.size;
            if (typeof input.quality === "string") body.quality = input.quality;
            return body;
        }
        case "audio.tts": {
            // The text sent decides (the server counts its code points); a caller's count only without text.
            const characters = typeof input.text === "string" && input.text ? [...input.text].length : units.characters;
            return characters && characters > 0 ? { model, characters } : null;
        }
        case "audio.music": {
            const duration = positive(input.durationSeconds);
            return duration === undefined ? { model } : { model, duration };
        }
        case "audio.separate": {
            const seconds = units.seconds;
            if (!finite(seconds) || seconds < 0) return null;
            return { model, seconds: paddedSeconds(seconds, SEPARATION_MAX_SECONDS) };
        }
        default:
            return null;
    }
}

/** A body as a stable cache key: keys sorted at every level. */
export function canonicalBody(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalBody).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalBody((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export type QuoteResult =
    | { kind: "quote"; priceUsd: number; holdUsd: number; priced: Record<string, unknown> }
    /** The server refused this call shape (400): its code says why (tier_not_offered: that quality isn't sold). */
    | { kind: "refused"; code: string }
    /** No quote now (an older server, rate limited, unavailable, unreadable): the local estimate answers. */
    | { kind: "fallback"; reason: "unsupported" | "rate-limited" | "unavailable" };

export interface QuoteClient {
    quote(body: Record<string, unknown>): Promise<QuoteResult>;
}

export interface QuoteClientOptions {
    now?(): number;
    /** A quote that takes longer is given up (the estimate answers); default QUOTE_TIMEOUT_MS. */
    timeoutMs?: number;
}

/** A price never waits longer than this for a quote. */
export const QUOTE_TIMEOUT_MS = 8_000;

export function createQuoteClient(api: OpenNanApi, options: QuoteClientOptions = {}): QuoteClient {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? QUOTE_TIMEOUT_MS;
    const cache = new Map<string, { at: number; result: QuoteResult }>();
    const inFlight = new Map<string, Promise<QuoteResult>>();
    let pausedUntil = 0;
    let pausedReason: "unsupported" | "rate-limited" = "unsupported";

    async function ask(body: Record<string, unknown>): Promise<QuoteResult> {
        let answer: { price_usd?: unknown; hold_usd?: unknown; priced?: unknown };
        try {
            answer = await api.request("POST", QUOTE_PATH, { body, signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            if (error instanceof OpenNanApiError && error.status === 404) {
                // An unknown model is a 404 in the error envelope; an older server without the route answers FastAPI's
                // bare {"detail": "Not Found"}.
                if (error.fromServer && "model" in body) return { kind: "refused", code: error.code };
                pausedUntil = now() + QUOTE_UNSUPPORTED_MS;
                pausedReason = "unsupported";
                return { kind: "fallback", reason: "unsupported" };
            }
            if (error instanceof OpenNanApiError && error.status === 429) {
                pausedUntil = now() + (error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : QUOTE_RATE_LIMIT_MS);
                pausedReason = "rate-limited";
                return { kind: "fallback", reason: "rate-limited" };
            }
            if (error instanceof OpenNanApiError && error.status === 400) return { kind: "refused", code: error.code };
            return { kind: "fallback", reason: "unavailable" };
        }
        const price = answer.price_usd;
        const hold = answer.hold_usd;
        // A paid call is never sold for nothing: a zero or unreadable quote is no quote.
        if (!finite(price) || price <= 0 || !finite(hold) || hold < 0) return { kind: "fallback", reason: "unavailable" };
        const priced = typeof answer.priced === "object" && answer.priced !== null ? (answer.priced as Record<string, unknown>) : {};
        return { kind: "quote", priceUsd: price, holdUsd: Math.max(hold, price), priced };
    }

    return {
        async quote(body) {
            const key = canonicalBody(body);
            const cached = cache.get(key);
            if (cached && now() - cached.at < QUOTE_CACHE_MS) return cached.result;
            if (now() < pausedUntil) return { kind: "fallback", reason: pausedReason };
            const pending = inFlight.get(key);
            if (pending) return pending;
            const request = ask(body).then((result) => {
                if (result.kind !== "fallback") cache.set(key, { at: now(), result });
                return result;
            }).finally(() => inFlight.delete(key));
            inFlight.set(key, request);
            return request;
        },
    };
}
