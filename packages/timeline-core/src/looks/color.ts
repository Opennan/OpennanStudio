// Pointwise color helpers for filters and adjustments. Channels are gamma-encoded floats in [0, 1].

export type Rgb = [number, number, number];

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const mixN = (a: number, b: number, t: number): number => a + (b - a) * t;
export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [mixN(a[0], b[0], t), mixN(a[1], b[1], t), mixN(a[2], b[2], t)];
export const clampRgb = (c: Rgb): Rgb => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];

/** Rec. 709 luma of gamma-encoded values (the weights CapCut-style tools use). */
export const luma = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function smoothstepN(e0: number, e1: number, x: number): number {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
}

/** Moves each channel away from (k > 0) or toward (k < 0) luma. k = -1 is gray. */
export function saturate(c: Rgb, k: number): Rgb {
    const l = luma(c);
    return [l + (c[0] - l) * (1 + k), l + (c[1] - l) * (1 + k), l + (c[2] - l) * (1 + k)];
}

/** Contrast around a pivot: factor > 1 expands. */
export function contrastAround(c: Rgb, factor: number, pivot = 0.5): Rgb {
    return [pivot + (c[0] - pivot) * factor, pivot + (c[1] - pivot) * factor, pivot + (c[2] - pivot) * factor];
}

/** S-curve per channel; amount 0 is identity, 1 is a strong curve. Monotonic for amount in [0, 1]. */
export function sCurve(x: number, amount: number): number {
    const s = x * x * (3 - 2 * x);
    return mixN(x, s, amount);
}

/** Lift (shadows), gamma (mids), gain (highlights) per channel, ASC-CDL-like. */
export function liftGammaGain(c: Rgb, lift: Rgb, gamma: Rgb, gain: Rgb): Rgb {
    const one = (x: number, i: number) => {
        const lifted = clamp01(x * gain[i] + lift[i] * (1 - x));
        return Math.pow(lifted, 1 / gamma[i]);
    };
    return [one(c[0], 0), one(c[1], 1), one(c[2], 2)];
}

/** Adds `shadow` tint to dark tones and `highlight` tint to bright tones (offsets in [-1, 1]). */
export function splitTone(c: Rgb, shadow: Rgb, highlight: Rgb, strength = 1): Rgb {
    const l = luma(c);
    const ws = (1 - smoothstepN(0, 0.6, l)) * strength;
    const wh = smoothstepN(0.4, 1, l) * strength;
    return [c[0] + shadow[0] * ws + highlight[0] * wh, c[1] + shadow[1] * ws + highlight[1] * wh, c[2] + shadow[2] * ws + highlight[2] * wh];
}

/** Gray with chosen channel weights (black and white "film" response). */
export function mono(c: Rgb, weights: Rgb = [0.2126, 0.7152, 0.0722]): Rgb {
    const l = c[0] * weights[0] + c[1] * weights[1] + c[2] * weights[2];
    return [l, l, l];
}

/** Maps luma onto a two-color gradient (duotone, sepia-like tones). */
export function gradientMap(c: Rgb, dark: Rgb, light: Rgb): Rgb {
    const l = clamp01(luma(c));
    return mixRgb(dark, light, l);
}

/** Channel gains (white balance style). */
export const gains = (c: Rgb, g: Rgb): Rgb => [c[0] * g[0], c[1] * g[1], c[2] * g[2]];

/** Lifts blacks and lowers whites: the "faded film" response. */
export function fadeBlacks(c: Rgb, black: number, white = 1): Rgb {
    return [black + c[0] * (white - black), black + c[1] * (white - black), black + c[2] * (white - black)];
}

export const hex = (value: string): Rgb => {
    const n = parseInt(value.replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
