// Spatial adjustments: sharpen (ffmpeg `convolution` on a replicated border), vignette (`blend=all_mode=multiply` with a mask),
// grain (`blend=all_mode=grainmerge` with a moving window of a noise image). Each has a byte-exact JS
// reference of the ffmpeg code path; the preview's shaders implement the same integer math.

/** Grain windows move this many times per second (independent of the export frame rate). */
export const GRAIN_RATE = 24;
/** The noise image is this many pixels larger than the item on each axis; the window moves inside it. */
export const GRAIN_MARGIN = 64;

// ── sharpen ──────────────────────────────────────────────

export interface Kernel3 {
    matrix: number[];
    rdiv: number;
}

/** amount 0..1 → integer kernel [0,-k,0,-k,16+4k,-k,0,-k,0] / 16 (an unsharp mask on the 4-neighbourhood). */
export function sharpenKernel(amount: number): Kernel3 | null {
    const k = Math.round(Math.max(0, Math.min(1, amount)) * 12);
    if (k === 0) return null;
    return { matrix: [0, -k, 0, -k, 16 + 4 * k, -k, 0, -k, 0], rdiv: 1 / 16 };
}

/** convolution filter options for planes 0-2 (gbrp/gbrap); alpha keeps convolution's identity copy. */
export function convolutionOptions(kernel: Kernel3): string {
    const m = kernel.matrix.join(" ");
    const rdiv = String(kernel.rdiv);
    return [0, 1, 2].map((p) => `${p}m='${m}':${p}rdiv=${rdiv}`).join(":");
}

/**
 * The sharpen filters on a gbrp/gbrap stream. FFmpeg 5.1 and 7.1 treat the right and bottom borders
 * differently inside `convolution`, so the frame gets a 1-pixel replicated border first and loses it
 * after: every version then sees the same neighbours (edges clamp).
 */
export function sharpenFilters(kernel: Kernel3): string[] {
    return [
        "pad=w=iw+2:h=ih+2:x=1:y=1",
        "fillborders=left=1:right=1:top=1:bottom=1:mode=smear",
        `convolution=${convolutionOptions(kernel)}`,
        "crop=w=iw-2:h=ih-2:x=1:y=1:exact=1",
    ];
}

const clampIndex = (x: number, size: number) => (x < 0 ? 0 : x >= size ? size - 1 : x);

/** vf_convolution.c filter_3x3 with clamped edges on each color channel of an RGB(A) frame (alpha copied). */
export function convolve3x3Reference(frame: Uint8Array, width: number, height: number, channels: 3 | 4, kernel: Kernel3): Uint8Array {
    const out = new Uint8Array(frame.length);
    const rdiv = Math.fround(kernel.rdiv);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const o = (y * width + x) * channels;
            for (let ch = 0; ch < 3; ch += 1) {
                let sum = 0;
                for (let i = 0; i < 9; i += 1) {
                    const xx = clampIndex(x + (i % 3) - 1, width);
                    const yy = clampIndex(y + Math.floor(i / 3) - 1, height);
                    sum += frame[(yy * width + xx) * channels + ch] * kernel.matrix[i];
                }
                const v = Math.trunc(Math.fround(Math.fround(sum * rdiv) + 0.5));
                out[o + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
            }
            if (channels === 4) out[o + 3] = frame[o + 3];
        }
    }
    return out;
}

// ── vignette ─────────────────────────────────────────────

const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
};

/** Mask level (0..255) at pixel (x, y) of a w×h item: 255 in the middle, darker toward the corners. */
export function vignetteLevel(x: number, y: number, w: number, h: number, amount: number): number {
    const dx = (x + 0.5) / w - 0.5;
    const dy = (y + 0.5) / h - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) / Math.SQRT1_2;
    const m = 1 - Math.max(0, Math.min(1, amount)) * 0.85 * smooth(0.25, 1.1, r);
    return Math.max(0, Math.min(255, Math.round(m * 255)));
}

export function vignetteMask(width: number, height: number, amount: number): Uint8Array {
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) mask[y * width + x] = vignetteLevel(x, y, width, height, amount);
    return mask;
}

/** blend all_mode=multiply, 8 bit: (A * B) / 255 in integers (blend_modes.c MULTIPLY). Alpha copied. */
export function multiplyReference(frame: Uint8Array, mask: Uint8Array, channels: 3 | 4): Uint8Array {
    const out = new Uint8Array(frame.length);
    for (let i = 0, p = 0; i < frame.length; i += channels, p += 1) {
        for (let ch = 0; ch < 3; ch += 1) out[i + ch] = Math.floor((frame[i + ch] * mask[p]) / 255);
        if (channels === 4) out[i + 3] = frame[i + 3];
    }
    return out;
}

// ── grain ────────────────────────────────────────────────

/** Deterministic noise image ((w + margin) × (h + margin), gray, centered on 128) for grain `amount` 0..1. */
export function grainImage(width: number, height: number, amount: number, seed = 0x5eed): { width: number; height: number; data: Uint8Array } {
    const gw = width + GRAIN_MARGIN;
    const gh = height + GRAIN_MARGIN;
    const data = new Uint8Array(gw * gh);
    const amp = Math.max(0, Math.min(1, amount)) * 34;
    let s = seed >>> 0 || 1;
    const next = () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 4294967296;
    };
    for (let i = 0; i < data.length; i += 1) {
        // Sum of three uniforms: a cheap bell-shaped grain.
        const g = (next() + next() + next() - 1.5) / 1.5;
        data[i] = Math.max(0, Math.min(255, Math.round(128 + g * amp)));
    }
    return { width: gw, height: gh, data };
}

/** Window offset into the grain image at item-local time t (seconds): crop x/y expressions use the same formula. */
export function grainOffset(t: number): { x: number; y: number } {
    // +0.37: the step never changes at a frame time (k/24, k/25, k/30, k/60 seconds).
    const step = Math.floor(t * GRAIN_RATE + 0.37);
    return { x: (step * 37) % GRAIN_MARGIN, y: (step * 23) % GRAIN_MARGIN };
}

/** crop options that pick the window grainOffset() describes; `offset` is the item time at the stream's t = 0. */
export function grainCropOptions(width: number, height: number, offset = 0): string {
    const time = offset ? `(t+${Number(offset.toFixed(6))})` : "t";
    const step = `floor(${time}*${GRAIN_RATE}+0.37)`;
    return `w=${width}:h=${height}:x='mod(${step}*37,${GRAIN_MARGIN})':y='mod(${step}*23,${GRAIN_MARGIN})':exact=1`;
}

/** blend all_mode=grainmerge, 8 bit: clip(A + B - 128). Alpha copied (c3_mode=normal). */
export function grainmergeReference(frame: Uint8Array, grain: Uint8Array, channels: 3 | 4): Uint8Array {
    const out = new Uint8Array(frame.length);
    for (let i = 0, p = 0; i < frame.length; i += channels, p += 1) {
        for (let ch = 0; ch < 3; ch += 1) {
            const v = frame[i + ch] + grain[p] - 128;
            out[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        if (channels === 4) out[i + 3] = frame[i + 3];
    }
    return out;
}

/** The grain window of a grain image (row-major gray) at item-local time t. */
export function grainWindow(image: { width: number; height: number; data: Uint8Array }, width: number, height: number, t: number): Uint8Array {
    const { x, y } = grainOffset(t);
    const out = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) out.set(image.data.subarray((row + y) * image.width + x, (row + y) * image.width + x + width), row * width);
    return out;
}
