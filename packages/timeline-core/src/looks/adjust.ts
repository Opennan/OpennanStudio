// The 13 Adjust controls. Ten are pointwise and are baked into the item's Hald CLUT (lut.ts);
// sharpen, vignette, and grain are spatial (spatial.ts). Values are normalized: -1..1 for signed
// controls, 0..1 for sharpen, vignette, fade, and grain (the UI shows them × 100).
import { clamp01, luma, smoothstepN, type Rgb } from "./color";

// Spelled out (not derived from the arrays) so schema generators read a plain union.
export type AdjustmentKey =
    | "brightness" | "contrast" | "saturation" | "exposure" | "temperature" | "tint" | "highlights" | "shadows" | "vibrance"
    | "fade" | "sharpen" | "vignette" | "grain";
export const SIGNED_ADJUSTMENTS: readonly AdjustmentKey[] = [
    "brightness", "contrast", "saturation", "exposure", "temperature", "tint", "highlights", "shadows", "vibrance",
];
export const UNSIGNED_ADJUSTMENTS: readonly AdjustmentKey[] = ["fade", "sharpen", "vignette", "grain"];
export const ADJUSTMENT_KEYS: readonly AdjustmentKey[] = [...SIGNED_ADJUSTMENTS, ...UNSIGNED_ADJUSTMENTS];
export type Adjustments = Record<AdjustmentKey, number>;
/** A partial update: a number sets the control, null resets it. */
export type AdjustmentPatch = Partial<Record<AdjustmentKey, number | null>>;

export const POINTWISE_ADJUSTMENTS: readonly AdjustmentKey[] = [...SIGNED_ADJUSTMENTS, "fade"];
export const SPATIAL_ADJUSTMENTS: readonly AdjustmentKey[] = ["sharpen", "vignette", "grain"];
/** Clip fields that already carried these controls before phase 10a (they stay the source of truth on clips). */
export const LEGACY_CLIP_ADJUSTMENTS = ["brightness", "contrast", "saturation"] as const;

export const DEFAULT_ADJUSTMENTS: Readonly<Adjustments> = Object.freeze(
    Object.fromEntries(ADJUSTMENT_KEYS.map((key) => [key, 0])) as Adjustments,
);

export function adjustmentRange(key: AdjustmentKey): [number, number] {
    return UNSIGNED_ADJUSTMENTS.includes(key) ? [0, 1] : [-1, 1];
}

function clampKey(key: AdjustmentKey, value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const [lo, hi] = adjustmentRange(key);
    return Math.min(hi, Math.max(lo, value));
}

export function parseAdjustments(json: string | null | undefined): Adjustments {
    const out: Adjustments = { ...DEFAULT_ADJUSTMENTS };
    if (!json) return out;
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const key of ADJUSTMENT_KEYS) {
        const value = clampKey(key, (parsed as Record<string, unknown>)[key]);
        if (value !== null) out[key] = value;
    }
    return out;
}

/** JSON with only non-default controls (rounded to 4 decimals), or null when everything is neutral. */
export function serializeAdjustments(values: Partial<Adjustments>, keys: readonly AdjustmentKey[] = ADJUSTMENT_KEYS): string | null {
    const out: Record<string, number> = {};
    for (const key of keys) {
        const value = clampKey(key, values[key]);
        if (value !== null && Math.abs(value) > 1e-6) out[key] = Math.round(value * 10000) / 10000;
    }
    return Object.keys(out).length ? JSON.stringify(out) : null;
}

export function applyAdjustmentPatch(base: Adjustments, patch: AdjustmentPatch): Adjustments {
    const out = { ...base };
    for (const key of ADJUSTMENT_KEYS) {
        if (!(key in patch)) continue;
        const value = patch[key];
        out[key] = value === null || value === undefined ? 0 : clampKey(key, value) ?? out[key];
    }
    return out;
}

export interface AdjustmentSource {
    adjustmentsJson?: string | null;
    brightness?: number | null;
    contrast?: number | null;
    saturation?: number | null;
}

const finite = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/**
 * The item's 13 controls. Clips keep brightness (−1..1), contrast and saturation (0..2, 1 neutral)
 * in their own fields, which agents and older projects already set; scenes keep all 13 in JSON.
 */
export function itemAdjustments(item: AdjustmentSource, kind: "clip" | "scene"): Adjustments {
    const out = parseAdjustments(item.adjustmentsJson);
    if (kind === "clip") {
        out.brightness = Math.min(1, Math.max(-1, finite(item.brightness, 0)));
        out.contrast = Math.min(1, Math.max(-1, finite(item.contrast, 1) - 1));
        out.saturation = Math.min(1, Math.max(-1, finite(item.saturation, 1) - 1));
    }
    return out;
}

/** The clip fields for brightness/contrast/saturation in their stored ranges. */
export function legacyClipFields(values: Pick<Adjustments, "brightness" | "contrast" | "saturation">): { brightness: number; contrast: number; saturation: number } {
    const r = (x: number) => Math.round(x * 10000) / 10000;
    return { brightness: r(values.brightness), contrast: r(1 + values.contrast), saturation: r(1 + values.saturation) };
}

export function isPointwiseNeutral(values: Adjustments): boolean {
    return POINTWISE_ADJUSTMENTS.every((key) => Math.abs(values[key]) <= 1e-6);
}

export function isNeutral(values: Adjustments): boolean {
    return ADJUSTMENT_KEYS.every((key) => Math.abs(values[key]) <= 1e-6);
}

/**
 * The pointwise controls on one gamma-encoded pixel. Order: exposure → white balance → contrast →
 * brightness → highlights/shadows → saturation → vibrance → fade. Output clamped to [0, 1].
 */
export function adjustPixel(input: Rgb, a: Adjustments): Rgb {
    let [r, g, b] = input;
    if (a.exposure) {
        const k = Math.pow(2, a.exposure * 1.5);
        r *= k; g *= k; b *= k;
    }
    if (a.temperature || a.tint) {
        const t = a.temperature;
        const tn = a.tint;
        r *= 1 + 0.14 * t + 0.06 * tn;
        g *= 1 + 0.02 * t - 0.12 * tn;
        b *= 1 - 0.14 * t + 0.06 * tn;
    }
    r = clamp01(r); g = clamp01(g); b = clamp01(b);
    if (a.contrast) {
        const factor = a.contrast >= 0 ? 1 + a.contrast * 0.9 : 1 + a.contrast * 0.7;
        r = 0.5 + (r - 0.5) * factor; g = 0.5 + (g - 0.5) * factor; b = 0.5 + (b - 0.5) * factor;
        r = clamp01(r); g = clamp01(g); b = clamp01(b);
    }
    if (a.brightness) {
        const k = a.brightness * 0.45;
        const one = (x: number) => (k >= 0 ? x + (1 - x) * k : x * (1 + k));
        r = one(r); g = one(g); b = one(b);
    }
    if (a.highlights || a.shadows) {
        const l = luma([r, g, b]);
        const wh = smoothstepN(0.45, 1, l);
        const ws = 1 - smoothstepN(0, 0.55, l);
        const dh = a.highlights * 0.3 * wh;
        const ds = a.shadows * 0.3 * ws;
        const one = (x: number) => {
            let y = x;
            y += dh >= 0 ? (1 - y) * dh : y * dh;
            y += ds >= 0 ? (1 - y) * ds : y * ds;
            return y;
        };
        r = one(r); g = one(g); b = one(b);
    }
    if (a.saturation) {
        const l = luma([r, g, b]);
        const k = 1 + a.saturation;
        r = clamp01(l + (r - l) * k); g = clamp01(l + (g - l) * k); b = clamp01(l + (b - l) * k);
    }
    if (a.vibrance) {
        const l = luma([r, g, b]);
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        const k = 1 + a.vibrance * (1 - sat) * 1.2;
        r = clamp01(l + (r - l) * k); g = clamp01(l + (g - l) * k); b = clamp01(l + (b - l) * k);
    }
    if (a.fade) {
        const one = (x: number) => x + (0.12 + x * 0.78 - x) * a.fade;
        r = one(r); g = one(g); b = one(b);
    }
    return [clamp01(r), clamp01(g), clamp01(b)];
}
