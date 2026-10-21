// Hald CLUTs: one 3D lookup table per item that bakes its filter (at its intensity) and every
// pointwise adjustment. The export applies it with ffmpeg's `haldclut=interp=trilinear`; the preview
// samples the same bytes. `applyHaldTrilinear` is a float32 port of libavfilter/vf_lut3d.c
// (interp_8_trilinear_p8 + LOAD_CLUT), the reference both must match.
import type { Rgb } from "./color";
import { encodePng } from "./png";

/** Level 8: 64 entries per axis, a 512×512 image. */
export const HALD_LEVEL = 8;

export interface HaldClut {
    level: number;
    /** Entries per axis (level²). */
    lutSize: number;
    /** Image side (level³). */
    size: number;
    /** RGB bytes of the size×size image, rows top-first. */
    rgb: Uint8Array;
}

/** Pixel index of node (r, g, b) in the Hald image: red fastest, then green, then blue. */
export function haldIndex(r: number, g: number, b: number, lutSize: number): number {
    return b * lutSize * lutSize + g * lutSize + r;
}

const to8 = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));

export function buildHaldClut(fn: (c: Rgb) => Rgb, level = HALD_LEVEL): HaldClut {
    const lutSize = level * level;
    const size = lutSize * level;
    const rgb = new Uint8Array(size * size * 3);
    const max = lutSize - 1;
    for (let b = 0; b < lutSize; b += 1) {
        for (let g = 0; g < lutSize; g += 1) {
            for (let r = 0; r < lutSize; r += 1) {
                const out = fn([r / max, g / max, b / max]);
                const o = haldIndex(r, g, b, lutSize) * 3;
                rgb[o] = to8(out[0]);
                rgb[o + 1] = to8(out[1]);
                rgb[o + 2] = to8(out[2]);
            }
        }
    }
    return { level, lutSize, size, rgb };
}

export function haldClutPng(clut: HaldClut): Uint8Array {
    return encodePng({ width: clut.size, height: clut.size, channels: 3, data: clut.rgb });
}

const f32 = Math.fround;

/** vf_lut3d.c interp_8_trilinear_p8 on one 8-bit pixel, float32 throughout, truncating output. */
export function applyHaldTrilinear(r8: number, g8: number, b8: number, clut: HaldClut): Rgb {
    const { lutSize, rgb } = clut;
    const lutMax = f32(lutSize - 1);
    const scaleF = f32(1 / 255);
    const scaled = (v: number) => {
        const x = f32(f32(f32(v) * scaleF) * lutMax);
        return x < 0 ? 0 : x > lutMax ? lutMax : x;
    };
    const s = [scaled(r8), scaled(g8), scaled(b8)];
    const prev = s.map((x) => Math.trunc(x));
    const next = prev.map((p) => Math.min(p + 1, lutSize - 1));
    const d = s.map((x, i) => f32(x - prev[i]));
    const node = (ri: number, gi: number, bi: number, ch: number) => f32(rgb[haldIndex(ri, gi, bi, lutSize) * 3 + ch] / 255);
    const lerp = (a: number, b: number, t: number) => f32(a + f32(f32(b - a) * t));
    const out: number[] = [];
    for (let ch = 0; ch < 3; ch += 1) {
        const c000 = node(prev[0], prev[1], prev[2], ch);
        const c001 = node(prev[0], prev[1], next[2], ch);
        const c010 = node(prev[0], next[1], prev[2], ch);
        const c011 = node(prev[0], next[1], next[2], ch);
        const c100 = node(next[0], prev[1], prev[2], ch);
        const c101 = node(next[0], prev[1], next[2], ch);
        const c110 = node(next[0], next[1], prev[2], ch);
        const c111 = node(next[0], next[1], next[2], ch);
        const c00 = lerp(c000, c100, d[0]);
        const c10 = lerp(c010, c110, d[0]);
        const c01 = lerp(c001, c101, d[0]);
        const c11 = lerp(c011, c111, d[0]);
        const c0 = lerp(c00, c10, d[1]);
        const c1 = lerp(c01, c11, d[1]);
        const c = lerp(c0, c1, d[2]);
        const v = Math.trunc(f32(c * 255));
        out.push(v < 0 ? 0 : v > 255 ? 255 : v);
    }
    return [out[0], out[1], out[2]];
}

/** Applies a CLUT to an RGB(A) byte buffer in place-free fashion (test reference for whole frames). */
export function applyHaldToFrame(frame: Uint8Array, channels: 3 | 4, clut: HaldClut): Uint8Array {
    const out = new Uint8Array(frame.length);
    for (let i = 0; i < frame.length; i += channels) {
        const [r, g, b] = applyHaldTrilinear(frame[i], frame[i + 1], frame[i + 2], clut);
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        if (channels === 4) out[i + 3] = frame[i + 3];
    }
    return out;
}
