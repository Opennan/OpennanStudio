// 30 filter presets (5 per category), each a pointwise color function written here. The export bakes
// them into a Hald CLUT; the preview samples the same table, so no third-party LUT files are used.
import {
    clampRgb, contrastAround, fadeBlacks, gains, gradientMap, hex, liftGammaGain, luma, mixRgb, mono, sCurve, saturate, splitTone,
    type Rgb,
} from "./color";

export const FILTER_CATEGORIES = ["life", "movies", "retro", "bw", "food", "landscape"] as const;
export type FilterCategory = (typeof FILTER_CATEGORIES)[number];

export interface FilterPreset {
    id: string;
    category: FilterCategory;
    apply(c: Rgb): Rgb;
}

const curve = (c: Rgb, amount: number): Rgb => [sCurve(c[0], amount), sCurve(c[1], amount), sCurve(c[2], amount)];
const f = (id: string, category: FilterCategory, apply: (c: Rgb) => Rgb): FilterPreset => ({ id, category, apply: (c) => clampRgb(apply(c)) });

export const FILTERS: readonly FilterPreset[] = [
    // ── Life ──
    f("fresh", "life", (c) => saturate(liftGammaGain(c, [0, 0.01, 0.02], [1.05, 1.06, 1.04], [1.02, 1.04, 1.03]), 0.12)),
    // warm/cool/cinematic keep the ids (and spirit) of the pre-10a presets.
    f("warm", "life", (c) => saturate(contrastAround(gains(c, [1.08, 1.02, 0.9]), 1.08), 0.12)),
    f("cool", "life", (c) => saturate(gains(c, [0.94, 1.0, 1.1]), -0.05)),
    f("soft", "life", (c) => saturate(fadeBlacks(contrastAround(c, 0.9), 0.05, 0.97), -0.12)),
    f("bright", "life", (c) => saturate(liftGammaGain(c, [0.03, 0.03, 0.03], [1.18, 1.18, 1.18], [1.04, 1.04, 1.04]), 0.06)),
    // ── Movies ──
    f("cinematic", "movies", (c) => saturate(contrastAround(splitTone(c, [-0.02, 0.01, 0.04], [0.03, 0.01, -0.03]), 1.18, 0.46), -0.08)),
    f("teal_orange", "movies", (c) => saturate(curve(splitTone(c, [-0.07, 0.02, 0.08], [0.08, 0.02, -0.07]), 0.25), 0.1)),
    f("blockbuster", "movies", (c) => saturate(curve(splitTone(gains(c, [1.03, 1.0, 0.98]), [-0.04, 0.03, 0.06], [0.05, 0.02, -0.04]), 0.45), 0.18)),
    f("moody", "movies", (c) => saturate(liftGammaGain(splitTone(c, [0.0, 0.02, 0.05], [0.02, 0.0, -0.02]), [0.03, 0.03, 0.04], [0.88, 0.9, 0.92], [0.92, 0.92, 0.94]), -0.3)),
    f("bleach_bypass", "movies", (c) => {
        const gray = mono(c);
        const blended = mixRgb(c, gray, 0.55);
        return curve(blended, 0.6);
    }),
    // ── Retro ──
    f("vintage", "retro", (c) => saturate(fadeBlacks(gains(curve(c, 0.15), [1.06, 1.0, 0.82]), 0.08, 0.95), -0.25)),
    f("instant", "retro", (c) => saturate(fadeBlacks(splitTone(c, [0.0, 0.03, 0.06], [0.06, 0.03, -0.04]), 0.07, 0.96), -0.1)),
    f("faded", "retro", (c) => saturate(fadeBlacks(c, 0.14, 0.92), -0.35)),
    f("seventies", "retro", (c) => saturate(fadeBlacks(gains(curve(c, 0.2), [1.1, 1.0, 0.78]), 0.05, 0.97), 0.05)),
    f("cross_process", "retro", (c) => [sCurve(c[0], 0.55), Math.pow(c[1], 0.9), c[2] * 0.7 + 0.12]),
    // ── B&W ──
    f("mono", "bw", (c) => mono(c)),
    f("noir", "bw", (c) => curve(curve(mono(c, [0.3, 0.6, 0.1]), 0.9), 0.5)),
    f("silver", "bw", (c) => fadeBlacks(curve(mono(c, [0.25, 0.65, 0.1]), 0.35), 0.04, 0.98)),
    f("selenium", "bw", (c) => gradientMap(curve(mono(c), 0.3), hex("#1a1416"), hex("#f2ece6"))),
    f("blue_tone", "bw", (c) => gradientMap(curve(mono(c), 0.25), hex("#0d1626"), hex("#e6eef7"))),
    // ── Food ──
    f("delicious", "food", (c) => saturate(contrastAround(gains(c, [1.07, 1.02, 0.94]), 1.06), 0.25)),
    f("crisp", "food", (c) => saturate(curve(liftGammaGain(c, [0, 0, 0], [1.08, 1.08, 1.08], [1.03, 1.03, 1.03]), 0.3), 0.15)),
    f("honey", "food", (c) => saturate(gains(liftGammaGain(c, [0.02, 0.01, 0], [1.08, 1.04, 0.98], [1, 1, 1]), [1.06, 1.01, 0.86]), 0.1)),
    f("fresh_greens", "food", (c) => {
        const out = saturate(c, 0.18);
        const l = luma(c);
        return [out[0] - 0.02 * l, out[1] + 0.05 * (1 - Math.abs(2 * l - 1)), out[2] - 0.01];
    }),
    f("rich", "food", (c) => saturate(curve(gains(c, [1.04, 1.0, 0.96]), 0.35), 0.3)),
    // ── Landscape ──
    f("vivid", "landscape", (c) => saturate(curve(c, 0.25), 0.4)),
    f("golden_hour", "landscape", (c) => saturate(splitTone(gains(c, [1.1, 1.02, 0.84]), [0.03, 0.0, -0.02], [0.06, 0.03, -0.05]), 0.12)),
    f("lush", "landscape", (c) => {
        const out = saturate(c, 0.25);
        return [out[0] * 0.97, out[1] * 1.06, out[2] * 0.98];
    }),
    f("azure", "landscape", (c) => saturate(splitTone(gains(c, [0.94, 1.0, 1.1]), [0.0, 0.02, 0.06], [0.0, 0.02, 0.05]), 0.2)),
    f("desert", "landscape", (c) => saturate(fadeBlacks(gains(curve(c, 0.2), [1.1, 1.0, 0.82]), 0.03, 0.98), -0.1)),
];

const BY_ID = new Map(FILTERS.map((preset) => [preset.id, preset]));

/** Canonical filter id: a known preset (case-insensitive, pre-10a warm/cool/cinematic included) or "none". */
export function normalizeFilterId(value: string | null | undefined): string {
    const id = String(value ?? "").trim().toLowerCase();
    return BY_ID.has(id) ? id : "none";
}

export function filterById(id: string | null | undefined): FilterPreset | null {
    return BY_ID.get(normalizeFilterId(id)) ?? null;
}

/** The filter at `intensity` (0..1) on one pixel: mix(c, filter(c), intensity). */
export function filterPixel(id: string | null | undefined, c: Rgb, intensity: number): Rgb {
    const preset = filterById(id);
    if (!preset || intensity <= 0) return [c[0], c[1], c[2]];
    const out = preset.apply(c);
    if (intensity >= 1) return out;
    return mixRgb(c, out, intensity);
}

export const DEFAULT_FILTER_INTENSITY = 0.8;
