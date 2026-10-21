// Synthetic luma frames for tracker tests: a textured square on static noise, rendered with 4×4 supersampling so
// sub-pixel motion moves the pixels exactly as a camera would see it.
import type { LumaFrame } from "../tracker";

/** Mulberry32: a small seeded PRNG, so every run draws the same noise. */
export function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface SceneSpec {
    width: number;
    height: number;
    /** The square's centre in pixels (continuous coordinates: pixel i spans [i, i + 1)). */
    cx: number;
    cy: number;
    side: number;
    /** Optional flat occluder (pixels, top-left + size) drawn over everything. */
    occluder?: { x: number; y: number; w: number; h: number; value: number };
    /** Optional flat patch drawn over the background (under the square). */
    flat?: { x: number; y: number; w: number; h: number; value: number };
    /** Per-frame sensor noise amplitude (± levels), seeded by `frameSeed`. */
    noise?: number;
    frameSeed?: number;
}

const backgrounds = new Map<string, Float32Array>();

/** Static background noise in 60..110 (cached per size). */
function background(width: number, height: number): Float32Array {
    const key = `${width}x${height}`;
    let bg = backgrounds.get(key);
    if (!bg) {
        const random = seeded(7);
        bg = new Float32Array(width * height);
        for (let i = 0; i < bg.length; i += 1) bg[i] = 60 + random() * 50;
        backgrounds.set(key, bg);
    }
    return bg;
}

/** The square's texture at (u, v) ∈ [0, 1]²: smooth stripes and blobs, distinct in every direction. */
function texture(u: number, v: number): number {
    return 130 + 55 * Math.sin(2 * Math.PI * (2.3 * u + 0.4)) * Math.cos(2 * Math.PI * (1.7 * v)) + 45 * Math.sin(2 * Math.PI * (u * v * 3 + v));
}

export function renderFrame(spec: SceneSpec): LumaFrame {
    const { width, height, cx, cy, side } = spec;
    const bg = background(width, height);
    const data = new Uint8ClampedArray(width * height);
    const half = side / 2;
    const x0 = cx - half;
    const y0 = cy - half;
    const random = spec.noise ? seeded(spec.frameSeed ?? 1) : null;
    const S = 4;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const i = y * width + x;
            let base = bg[i];
            if (spec.flat && x >= spec.flat.x && x < spec.flat.x + spec.flat.w && y >= spec.flat.y && y < spec.flat.y + spec.flat.h) base = spec.flat.value;
            let value: number;
            if (x + 1 < x0 || x > x0 + side || y + 1 < y0 || y > y0 + side) {
                value = base;
            } else {
                let sum = 0;
                for (let sy = 0; sy < S; sy += 1) {
                    for (let sx = 0; sx < S; sx += 1) {
                        const px = x + (sx + 0.5) / S;
                        const py = y + (sy + 0.5) / S;
                        const u = (px - x0) / side;
                        const v = (py - y0) / side;
                        sum += u >= 0 && u < 1 && v >= 0 && v < 1 ? texture(u, v) : base;
                    }
                }
                value = sum / (S * S);
            }
            const o = spec.occluder;
            if (o && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) value = o.value;
            if (random) value += (random() * 2 - 1) * spec.noise!;
            data[i] = value;
        }
    }
    return { width, height, data };
}

/** The region (frame fractions, top-left + size) around a square of `side` pixels centred at (cx, cy). */
export function regionOf(spec: Pick<SceneSpec, "width" | "height">, cx: number, cy: number, side: number) {
    return { x: (cx - side / 2) / spec.width, y: (cy - side / 2) / spec.height, width: side / spec.width, height: side / spec.height };
}
