// Price estimates (phase 11): "≈ $x · Run" before a paid action, from the price blocks a provider publishes (OpenNan's
// GET /v1/tools and GET /v1/models) × the units Studio knows before it sends anything. The rule never shows less than
// the run settles at:
//   - money is integer micro-dollars (the server rounds prices to $0.000001), plus one micro-dollar per billed unit:
//     the block publishes the unit price rounded, the server rounds N × its unit cost once, so N units may bill up to
//     N micro-dollars more than N × the published price;
//   - lengths add a decoded-length margin (BILLING_SAFETY) before rounding up to started units, because the server
//     bills the length it decodes, which can run a few milliseconds past the container's;
//   - a tool's estimate is capped at the block's maximum: the server holds that much and never settles above it;
//   - the label rounds up (three decimals under $1, two from $1).

/** A tool's price block (GET /v1/tools `data[].price`). Unknown fields are ignored. */
export interface ToolPriceBlock {
    unit: string;
    per?: string;
    usd?: number;
    max_minutes?: number;
    max_seconds?: number;
    max_characters?: number;
    max_segments?: number;
    segment_overhead_characters?: number;
    tiers?: ReadonlyArray<{ resolution?: string; usd: number }>;
    max_usd?: number;
}

/** What Studio knows about a run before sending it. */
export interface PriceUnits {
    /** Source seconds Studio sends (the prepared file's length). */
    seconds?: number;
    /** Caption translation: billed characters (captionBilledCharacters); voice: characters spoken. */
    characters?: number;
    segments?: number;
    resolution?: string;
    images?: number;
}

export interface CostEstimate {
    /** Upper bound, in micro-dollars. */
    microUsd: number;
    usd: number;
    /** "≈ $0.005" */
    label: string;
    /** Billed units in the estimate (minutes, seconds, thousands of characters, blocks). */
    units: number;
    /** The estimate reached the tool's maximum (its hold). */
    capped: boolean;
    /**
     * Where the amount comes from (phase 11.1): "quote" is the server's own settle figure (POST /v1/quotes);
     * "estimate" (or absent) is the local upper bound from the price blocks.
     */
    source?: "quote" | "estimate";
    /** What the server holds while the run goes (a quote's hold_usd): the balance must cover it. */
    holdUsd?: number;
}

export interface OverLimit {
    kind: "seconds" | "characters" | "segments";
    max: number;
    actual: number;
}

/** Added to every decoded length before rounding up to started units: 0.25 s plus 0.5 % of the length. */
export const BILLING_SAFETY = Object.freeze({ seconds: 0.25, ratio: 0.005 });
/** Allowance for the server's rounding to $0.000001: per billed unit for unit prices, per call otherwise. */
const ROUNDING_MICRO_USD = 1;

export function isOverLimit(value: CostEstimate | OverLimit | null): value is OverLimit {
    return value !== null && "kind" in value && "max" in value;
}

/** Dollars (six decimals, as the API publishes them) → micro-dollars. */
export function toMicroUsd(usd: number): number {
    return Math.round(usd * 1_000_000);
}

/** Started units of `unitSeconds` in `seconds` of decoded media, with the safety margin (at least 1). */
export function startedUnits(seconds: number, unitSeconds: number): number {
    const padded = seconds + BILLING_SAFETY.seconds + seconds * BILLING_SAFETY.ratio;
    // Integer milliseconds keep 60.000 s from becoming 1.0000000001 minutes by float error (over is allowed, not under).
    const ms = Math.ceil(padded * 1000 - 1e-6);
    return Math.max(1, Math.ceil(ms / (unitSeconds * 1000)));
}

/**
 * The length a per-unit quote is asked for: the decoded-length margin added (the server settles on the length it
 * decodes), rounded up to the millisecond, capped at the tool's longest input (it never settles above that hold).
 */
export function paddedSeconds(seconds: number, maxSeconds?: number): number {
    const padded = Math.ceil((seconds + BILLING_SAFETY.seconds + seconds * BILLING_SAFETY.ratio) * 1000 - 1e-6) / 1000;
    return maxSeconds !== undefined && padded > maxSeconds ? maxSeconds : padded;
}

/** An estimate from a server quote: its settle amount (label rounded up) and its hold (never below the settle). */
export function quotedEstimate(quote: { priceUsd: number; holdUsd: number; units: number; capped?: boolean }): CostEstimate {
    const microUsd = Math.ceil(quote.priceUsd * 1_000_000 - 1e-6);
    return {
        microUsd, usd: microUsd / 1_000_000, label: formatUsdEstimate(microUsd), units: quote.units, capped: quote.capped ?? false,
        source: "quote", holdUsd: Math.max(quote.holdUsd, quote.priceUsd),
    };
}

/** The amount a label shows, rounded up the same way: the most a run the user accepted at that label may cost. */
export function displayedUsd(microUsd: number): number {
    const value = Math.max(0, Math.ceil(microUsd));
    const mills = Math.ceil(value / 1000) * 1000;
    if (mills < 1_000_000) return mills / 1_000_000;
    return (Math.ceil(value / 10_000) * 10_000) / 1_000_000;
}

/** "≈ $0.005": rounded up to $0.001 under $1, to $0.01 from $1. */
export function formatUsdEstimate(microUsd: number): string {
    const value = Math.max(0, Math.ceil(microUsd));
    const mills = Math.ceil(value / 1000) * 1000;
    if (mills < 1_000_000) return `≈ $${(mills / 1_000_000).toFixed(3)}`;
    const cents = Math.ceil(value / 10_000) * 10_000;
    return `≈ $${(cents / 1_000_000).toFixed(2)}`;
}

function result(unitMicro: number, units: number, capped: boolean): CostEstimate {
    const microUsd = (unitMicro + ROUNDING_MICRO_USD) * units;
    return { microUsd, usd: microUsd / 1_000_000, label: formatUsdEstimate(microUsd), units, capped };
}

function money(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? toMicroUsd(value) : null;
}

function positive(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Billed characters of caption lines: each line's Unicode code points plus the per-line overhead. */
export function captionBilledCharacters(segments: ReadonlyArray<{ text: string }>, overhead = 10): number {
    let total = 0;
    for (const segment of segments) total += [...segment.text].length + overhead;
    return total;
}

/** A tool's estimate, the limit it is past, or null when the block can't price these units. */
export function estimateToolCost(block: ToolPriceBlock | null | undefined, units: PriceUnits): CostEstimate | OverLimit | null {
    if (!block || typeof block !== "object") return null;
    switch (block.unit) {
        case "source_minute":
        case "audio_minute": {
            const unit = money(block.usd);
            const seconds = units.seconds;
            if (unit === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
            const maxMinutes = positive(block.max_minutes);
            if (maxMinutes !== null && seconds > maxMinutes * 60) return { kind: "seconds", max: maxMinutes * 60, actual: seconds };
            const started = startedUnits(seconds, 60);
            const billed = maxMinutes !== null ? Math.min(started, Math.ceil(maxMinutes)) : started;
            return result(unit, billed, billed < started || (maxMinutes !== null && billed === Math.ceil(maxMinutes)));
        }
        case "video_second":
        case "audio_second":
        case "sound_second": {
            let unit = money(block.usd);
            if (block.tiers && block.tiers.length > 0) {
                if (units.resolution === undefined) unit = money(block.usd);
                else {
                    const tier = block.tiers.find((t) => t.resolution === units.resolution);
                    if (!tier) return null;
                    unit = money(tier.usd);
                }
            }
            const seconds = units.seconds;
            if (unit === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
            const maxSeconds = positive(block.max_seconds);
            if (maxSeconds !== null && seconds > maxSeconds) return { kind: "seconds", max: maxSeconds, actual: seconds };
            const started = block.unit === "sound_second" ? Math.max(1, Math.ceil(seconds - 1e-9)) : startedUnits(seconds, 1);
            const billed = maxSeconds !== null ? Math.min(started, Math.ceil(maxSeconds)) : started;
            return result(unit, billed, maxSeconds !== null && billed === Math.ceil(maxSeconds));
        }
        case "thousand_characters": {
            const unit = money(block.usd);
            const characters = units.characters;
            if (unit === null || characters === undefined || !Number.isFinite(characters) || characters < 0) return null;
            const maxSegments = positive(block.max_segments);
            const segments = units.segments ?? 0;
            if (maxSegments !== null && segments > maxSegments) return { kind: "segments", max: maxSegments, actual: segments };
            const maxCharacters = positive(block.max_characters);
            const overhead = positive(block.segment_overhead_characters) ?? 0;
            const raw = characters - overhead * segments;
            if (maxCharacters !== null && raw > maxCharacters) return { kind: "characters", max: maxCharacters, actual: raw };
            const billed = Math.max(1, Math.ceil(characters / 1000));
            return result(unit, billed, false);
        }
        default:
            return null;
    }
}

/** A SFX run: started seconds of the asked duration (exact; nothing is decoded). */
export function estimateSoundEffectCost(block: ToolPriceBlock | null | undefined, seconds: number): CostEstimate | OverLimit | null {
    return estimateToolCost(block ? { ...block, unit: "sound_second" } : block, { seconds });
}

/** Image model price (GET /v1/models category image). */
export interface ImageModelPrice {
    from_usd?: number;
    per_input_image_usd?: number;
}

/** A call without quality or size is charged from_usd, plus per_input_image_usd for each input image. */
export function estimateImageCost(price: ImageModelPrice | null | undefined, inputImages: number): CostEstimate | null {
    const base = money(price?.from_usd);
    if (base === null) return null;
    const perImage = money(price?.per_input_image_usd) ?? 0;
    const microUsd = base + perImage * Math.max(0, inputImages) + ROUNDING_MICRO_USD;
    return { microUsd, usd: microUsd / 1_000_000, label: formatUsdEstimate(microUsd), units: 1, capped: false };
}

/** Video model price (GET /v1/models category video): one matrix row per quality × audio tier, priced for its length. */
export interface VideoModelPrice {
    from_usd?: number;
    matrix?: ReadonlyArray<{ ours_usd?: number; duration?: number; ours_usd_per_second?: number; quality?: string | null; audio?: boolean }>;
}

/**
 * The worst per-second price among the model's rows × the asked duration. Exact for the catalog's per-second and
 * flat-per-length video rows; a row priced above linear in length would need a quote (recorded owner item).
 */
export function estimateVideoModelCost(price: VideoModelPrice | null | undefined, seconds: number): CostEstimate | null {
    const rows = price?.matrix ?? [];
    // Micro-dollars per second, rounded up: from the row's own price and length when both are given (the published
    // per-second figure is rounded to the nearest micro-dollar), else the per-second figure itself.
    let worst = 0;
    for (const row of rows) {
        const own = positive(row.ours_usd) !== null && positive(row.duration) !== null ? Math.ceil((row.ours_usd! * 1_000_000) / row.duration! - 1e-6) : null;
        const published = positive(row.ours_usd_per_second) !== null ? Math.ceil(row.ours_usd_per_second! * 1_000_000 - 1e-6) : null;
        const perSecond = own !== null && published !== null ? Math.max(own, published) : own ?? published;
        if (perSecond !== null) worst = Math.max(worst, perSecond);
    }
    if (worst <= 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
    const microUsd = Math.ceil((worst + ROUNDING_MICRO_USD) * seconds - 1e-6);
    return { microUsd, usd: microUsd / 1_000_000, label: formatUsdEstimate(microUsd), units: seconds, capped: false };
}

/** Speech model price (Kokoro): per started block of billing_block_characters at minimum_usd a block. */
export interface VoiceModelPrice {
    billing_block_characters?: number;
    minimum_usd?: number | null;
}

export function estimateVoiceCost(price: VoiceModelPrice | null | undefined, characters: number): CostEstimate | null {
    const block = positive(price?.billing_block_characters);
    const unit = money(price?.minimum_usd);
    if (block === null || unit === null || !Number.isFinite(characters) || characters < 0) return null;
    const blocks = Math.max(1, Math.ceil(characters / block));
    return result(unit, blocks, false);
}

/** Music model price: from_usd is a 60-second track, charged exactly for the asked seconds. */
export function estimateMusicCost(price: { from_usd?: number } | null | undefined, seconds: number): CostEstimate | null {
    const minute = money(price?.from_usd);
    if (minute === null || !Number.isFinite(seconds) || seconds <= 0) return null;
    const microUsd = Math.ceil((minute * seconds) / 60 - 1e-9) + ROUNDING_MICRO_USD;
    return { microUsd, usd: microUsd / 1_000_000, label: formatUsdEstimate(microUsd), units: seconds, capped: false };
}

/** Stem separation price: max(minimum_usd, base_usd + per_minute_usd × minutes), at most (the server floors GPU seconds). */
export interface StemsModelPrice {
    minimum_usd?: number;
    base_usd?: number;
    per_minute_usd?: number;
}

export function estimateStemsCost(price: StemsModelPrice | null | undefined, seconds: number): CostEstimate | null {
    const minimum = money(price?.minimum_usd);
    const base = money(price?.base_usd);
    const perMinute = money(price?.per_minute_usd);
    if (minimum === null || base === null || perMinute === null || !Number.isFinite(seconds) || seconds < 0) return null;
    const minutes = (seconds + BILLING_SAFETY.seconds + seconds * BILLING_SAFETY.ratio) / 60;
    const linear = Math.ceil(base + perMinute * minutes - 1e-9) + 2 * ROUNDING_MICRO_USD;
    const microUsd = Math.max(minimum + ROUNDING_MICRO_USD, linear);
    return { microUsd, usd: microUsd / 1_000_000, label: formatUsdEstimate(microUsd), units: minutes, capped: false };
}
