// The legacy clip controls (blur slider, chroma key, blend modes; the reference assembler's ffmpeg filters) as
// pixel math on RGBA frames: the JS references of the WebGL passes (timeline-media LookRenderer.boxBlur,
// chromaKey, eqYuv) that the GPU export and the preview run, checked against the ffmpeg filters the compatible
// export compiles (`avgblur`, `chromakey`, eq's 8-bit lookup as `lutyuv`) in packages/export/parity.
//
// ffmpeg runs these filters on YUV planes (or planar RGB for a lone blur on RGB input), so the references do too:
// RGB → 8-bit YUV (BT.601, limited range: ffmpeg's reading of video without a colour matrix and swscale's default
// for RGB input) → the filter's integer math → RGB. "yuv420" emulates 4:2:0 chroma (video decoded as yuv420p):
// a chroma sample per 2×2 block, the rounded mean of the block's pixels.

/** Which planes a legacy filter sees: planar RGB(A), 4:4:4 YUV(A), or 4:2:0 YUV(A) (chroma per 2×2 block). */
export type LegacyPlaneMode = "rgb" | "yuv444" | "yuv420";

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const roundByte = (v: number) => clampByte(Math.floor(v + 0.5));

/** 8-bit RGB → 8-bit BT.601 limited-range YUV (rounded). */
export function rgbToYuv601(r: number, g: number, b: number): [number, number, number] {
    return [
        roundByte(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255),
        roundByte(128 + (-37.797 * r - 74.203 * g + 112 * b) / 255),
        roundByte(128 + (112 * r - 93.786 * g - 18.214 * b) / 255),
    ];
}

/** 8-bit BT.601 limited-range YUV → 8-bit RGB (rounded, clamped). */
export function yuvToRgb601(y: number, u: number, v: number): [number, number, number] {
    const l = 1.164383 * (y - 16);
    return [
        roundByte(l + 1.596027 * (v - 128)),
        roundByte(l - 0.391762 * (u - 128) - 0.812968 * (v - 128)),
        roundByte(l + 2.017232 * (u - 128)),
    ];
}

// ── eq (blend modes) ─────────────────────────────────────

/** One plane of eq's 8-bit lookup: pel = clip(floor(val·c / 4096) + b, 0, 255). */
export type EqPlane = readonly [c: number, b: number];

/**
 * One plane of eq's process_c (libavfilter/vf_eq.h, used for gamma 1 and |contrast| < 7.9): [C, B] integers, or
 * null when eq copies the plane. eq stores its parameters through av_clipf, so they are floats: Math.fround keeps
 * (int)(100 * brightness + 100) on the same side of an integer as eq.
 */
export function eqPlane(contrast: number, brightness: number): EqPlane | null {
    const c32 = Math.fround(contrast);
    const b32 = Math.fround(brightness);
    if (c32 === 1 && b32 === 0) return null;
    const c = Math.trunc(c32 * 256 * 16);
    const b = Math.trunc((Math.trunc(100 * b32 + 100) * 511) / 200) - 128 - Math.trunc(c / 32);
    return [c, b];
}

/** eq's lookups for brightness/contrast/saturation (gamma 1): luma from contrast and brightness, chroma from saturation. */
export interface EqPlanes {
    luma: EqPlane | null;
    chroma: EqPlane | null;
}

export function eqPlanes(color: { brightness: number; contrast: number; saturation: number }): EqPlanes {
    const brightness = Math.min(1, Math.max(-1, color.brightness));
    const contrast = Math.min(1000, Math.max(-1000, color.contrast));
    const saturation = Math.min(3, Math.max(0, color.saturation));
    return { luma: eqPlane(contrast, brightness), chroma: eqPlane(saturation, 0) };
}

export const eqApply = (plane: EqPlane | null, value: number): number => (plane ? clampByte(Math.floor((value * plane[0]) / 4096) + plane[1]) : value);

/** eq's lookup on every pixel of an RGBA frame (alpha copied). */
export function eqReference(frame: Uint8Array, planes: EqPlanes): Uint8Array {
    const out = new Uint8Array(frame);
    if (!planes.luma && !planes.chroma) return out;
    for (let o = 0; o < frame.length; o += 4) {
        const [y, u, v] = rgbToYuv601(frame[o], frame[o + 1], frame[o + 2]);
        const rgb = yuvToRgb601(eqApply(planes.luma, y), eqApply(planes.chroma, u), eqApply(planes.chroma, v));
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
    }
    return out;
}

// ── chroma key ───────────────────────────────────────────

export interface ChromaKeyParams {
    /** The key colour's chroma as vf_chromakey computes it from RGB (chromaKeyUv). */
    u: number;
    v: number;
    similarity: number;
    blend: number;
}

const FIX = (x: number) => Math.round(x * 1024);

/** vf_chromakey's RGB_TO_U / RGB_TO_V (full-range JPEG coefficients in 10-bit fixed point) of "0xRRGGBB" / "#RRGGBB". */
export function chromaKeyUv(color: string): { u: number; v: number } {
    const match = String(color).trim().match(/^(?:#|0x)?([0-9a-fA-F]{6})$/);
    const hex = match ? Number.parseInt(match[1], 16) : 0x00ff00;
    const r = (hex >> 16) & 255;
    const g = (hex >> 8) & 255;
    const b = hex & 255;
    return {
        u: ((-FIX(0.16874) * r - FIX(0.33126) * g + FIX(0.5) * b + (1 << 9) - 1) >> 10) + 128,
        v: ((FIX(0.5) * r - FIX(0.41869) * g - FIX(0.08131) * b + (1 << 9) - 1) >> 10) + 128,
    };
}

/** vf_chromakey's per-pixel level from the mean chroma distance over the 3×3 neighbourhood. */
export function chromaKeyLevel(diff: number, similarity: number, blend: number): number {
    if (blend > 0.0001) return Math.trunc(Math.min(1, Math.max(0, (diff - similarity) / blend)) * 255);
    return diff > similarity ? 255 : 0;
}

/** Per-pixel (or, for "yuv420", per 2×2 block) U and V planes of an RGBA frame, at pixel resolution. */
function chromaPlanes(frame: Uint8Array, width: number, height: number, subsampled: boolean): { u: Uint8Array; v: Uint8Array } {
    const u = new Uint8Array(width * height);
    const v = new Uint8Array(width * height);
    for (let i = 0, o = 0; i < width * height; i += 1, o += 4) {
        const yuv = rgbToYuv601(frame[o], frame[o + 1], frame[o + 2]);
        u[i] = yuv[1];
        v[i] = yuv[2];
    }
    if (!subsampled) return { u, v };
    const bu = new Uint8Array(width * height);
    const bv = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const block = blockChroma(u, v, width, height, x >> 1, y >> 1);
            bu[y * width + x] = block[0];
            bv[y * width + x] = block[1];
        }
    }
    return { u: bu, v: bv };
}

/** The chroma sample of block (bx, by): the rounded mean of its four pixels (edge pixels repeat on odd sizes). */
function blockChroma(u: Uint8Array, v: Uint8Array, width: number, height: number, bx: number, by: number): [number, number] {
    let su = 0;
    let sv = 0;
    for (let j = 0; j < 2; j += 1) {
        for (let i = 0; i < 2; i += 1) {
            const x = Math.min(width - 1, bx * 2 + i);
            const y = Math.min(height - 1, by * 2 + j);
            su += u[y * width + x];
            sv += v[y * width + x];
        }
    }
    return [Math.floor((su + 2) / 4), Math.floor((sv + 2) / 4)];
}

const clampIndex = (x: number, size: number) => (x < 0 ? 0 : x >= size ? size - 1 : x);

/**
 * vf_chromakey: alpha = level of the mean distance sqrt((du² + dv²) / (2·255²)) over the 3×3 neighbourhood (edges
 * clamped; ffmpeg's border pixels read stale neighbours, which depends on its slice threading). The colour is kept;
 * the frame's own alpha is replaced, as ffmpeg's chromakey writes the alpha plane.
 */
export function chromaKeyReference(frame: Uint8Array, width: number, height: number, key: ChromaKeyParams, subsampled: boolean): Uint8Array {
    const out = new Uint8Array(frame);
    const { u, v } = chromaPlanes(frame, width, height, subsampled);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            let diff = 0;
            for (let yo = -1; yo <= 1; yo += 1) {
                for (let xo = -1; xo <= 1; xo += 1) {
                    const i = clampIndex(y + yo, height) * width + clampIndex(x + xo, width);
                    const du = u[i] - key.u;
                    const dv = v[i] - key.v;
                    diff += Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
                }
            }
            out[(y * width + x) * 4 + 3] = chromaKeyLevel(diff / 9, key.similarity, key.blend);
        }
    }
    return out;
}

// ── avgblur (legacy blur slider) ─────────────────────────

/**
 * avgblur's radii on a w×h frame: the radius is limited to half of the smallest plane on each axis (4:2:0 chroma
 * planes are ceil(w/2) × ceil(h/2)), for every plane alike (measured on FFmpeg 7.1).
 */
export function avgBlurRadii(radius: number, width: number, height: number, mode: LegacyPlaneMode): { x: number; y: number } {
    const r = Math.max(0, Math.trunc(radius));
    const w = mode === "yuv420" ? Math.ceil(width / 2) : width;
    const h = mode === "yuv420" ? Math.ceil(height / 2) : height;
    return { x: Math.min(r, Math.floor(w / 2)), y: Math.min(r, Math.floor(h / 2)) };
}

/** Box mean of one plane: floor(Σ / area) over the (2rx+1)×(2ry+1) window with clamped edges (vf_avgblur). */
function boxPlane(src: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
    const out = new Uint8Array(w * h);
    const area = (2 * rx + 1) * (2 * ry + 1);
    const rows = new Float64Array(w * h);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            let sum = 0;
            for (let i = -rx; i <= rx; i += 1) sum += src[y * w + clampIndex(x + i, w)];
            rows[y * w + x] = sum;
        }
    }
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            let sum = 0;
            for (let j = -ry; j <= ry; j += 1) sum += rows[clampIndex(y + j, h) * w + x];
            out[y * w + x] = Math.floor(sum / area);
        }
    }
    return out;
}

/**
 * vf_avgblur with sizeX = sizeY = radius on every plane, in the planes ffmpeg runs it on: planar RGB(A) ("rgb"),
 * YUV(A) 4:4:4, or YUV(A) 4:2:0 (chroma blurred per 2×2 block and shown on the block's pixels).
 */
export function boxBlurReference(frame: Uint8Array, width: number, height: number, radius: number, mode: LegacyPlaneMode): Uint8Array {
    const { x: rx, y: ry } = avgBlurRadii(radius, width, height, mode);
    if (rx === 0 && ry === 0) return new Uint8Array(frame);
    const n = width * height;
    const planes = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    for (let i = 0, o = 0; i < n; i += 1, o += 4) {
        const c = mode === "rgb" ? [frame[o], frame[o + 1], frame[o + 2]] : rgbToYuv601(frame[o], frame[o + 1], frame[o + 2]);
        planes[0][i] = c[0];
        planes[1][i] = c[1];
        planes[2][i] = c[2];
        planes[3][i] = frame[o + 3];
    }
    const out = new Uint8Array(frame.length);
    const p0 = boxPlane(planes[0], width, height, rx, ry);
    const p3 = boxPlane(planes[3], width, height, rx, ry);
    let p1: Uint8Array;
    let p2: Uint8Array;
    if (mode === "yuv420") {
        const cw = Math.ceil(width / 2);
        const ch = Math.ceil(height / 2);
        const cu = new Uint8Array(cw * ch);
        const cv = new Uint8Array(cw * ch);
        for (let by = 0; by < ch; by += 1) {
            for (let bx = 0; bx < cw; bx += 1) {
                const block = blockChroma(planes[1], planes[2], width, height, bx, by);
                cu[by * cw + bx] = block[0];
                cv[by * cw + bx] = block[1];
            }
        }
        const bu = boxPlane(cu, cw, ch, rx, ry);
        const bv = boxPlane(cv, cw, ch, rx, ry);
        p1 = new Uint8Array(n);
        p2 = new Uint8Array(n);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                p1[y * width + x] = bu[(y >> 1) * cw + (x >> 1)];
                p2[y * width + x] = bv[(y >> 1) * cw + (x >> 1)];
            }
        }
    } else {
        p1 = boxPlane(planes[1], width, height, rx, ry);
        p2 = boxPlane(planes[2], width, height, rx, ry);
    }
    for (let i = 0, o = 0; i < n; i += 1, o += 4) {
        const rgb = mode === "rgb" ? [p0[i], p1[i], p2[i]] : yuvToRgb601(p0[i], p1[i], p2[i]);
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
        out[o + 3] = p3[i];
    }
    return out;
}

// ── the legacy chain ─────────────────────────────────────

/** The legacy filters of one layer, in ffmpeg's order: blur, chroma key, eq (blend mode). */
export interface LegacyOps {
    blur: { radius: number; mode: LegacyPlaneMode } | null;
    chromaKey: { key: ChromaKeyParams; subsampled: boolean } | null;
    eq: EqPlanes | null;
}

/**
 * The planes ffmpeg's format negotiation gives the legacy filters of an overlay chain (measured on FFmpeg 7.1 with
 * -v verbose): `input` is what reaches them — "yuv420" for decoded video, JPEG, or WebP with no look before them,
 * "rgb" after a look (RGB) or for PNG/GIF/raster bitmaps. chromakey needs YUVA and the eq lookups are pinned to 8-bit
 * YUV, and a filter's input and output share one format, so either one pulls the blur into YUV too; a legacy alpha
 * fade's `format=yuva444p` does the same unless a mosaic (two `scale`s) sits in between. A lone blur keeps 4:2:0
 * YUV, or runs on planar RGB(A).
 */
export function legacyPlaneModes(input: "yuv420" | "rgb", uses: { chromaKey: boolean; eq: boolean; yuva444Fades: boolean }): { blur: LegacyPlaneMode; subsampled: boolean } {
    const yuv = uses.chromaKey || uses.eq || uses.yuva444Fades;
    const subsampled = input === "yuv420" && !uses.yuva444Fades;
    if (yuv) return { blur: subsampled ? "yuv420" : "yuv444", subsampled };
    return { blur: input === "yuv420" ? "yuv420" : "rgb", subsampled };
}

/** True when the ops change nothing. */
export const legacyOpsEmpty = (ops: LegacyOps | null | undefined): boolean =>
    !ops || (!ops.blur && !ops.chromaKey && (!ops.eq || (!ops.eq.luma && !ops.eq.chroma)));

/** Every legacy op on an RGBA frame, in order (the reference of the GPU passes). */
export function legacyReference(frame: Uint8Array, width: number, height: number, ops: LegacyOps): Uint8Array {
    let out: Uint8Array = new Uint8Array(frame);
    if (ops.blur && ops.blur.radius >= 1) out = boxBlurReference(out, width, height, ops.blur.radius, ops.blur.mode);
    if (ops.chromaKey) out = chromaKeyReference(out, width, height, ops.chromaKey.key, ops.chromaKey.subsampled);
    if (ops.eq) out = eqReference(out, ops.eq);
    return out;
}

// ── a clip's legacy controls ─────────────────────────────

/** The eq settings that approximate each legacy blend mode (reference assembler behavior). */
export const BLEND_MODE_ADJUSTMENTS = {
    multiply: { brightness: -0.08, contrast: 1.15, saturation: 1 },
    screen: { brightness: 0.08, contrast: 0.9, saturation: 1 },
    overlay: { brightness: 0, contrast: 1.25, saturation: 1.1 },
} as const;

export type LegacyBlendMode = "normal" | keyof typeof BLEND_MODE_ADJUSTMENTS;

/** The clip fields the legacy controls read. */
export interface LegacyClipFields {
    blurStrength?: unknown;
    chromaKeyEnabled?: unknown;
    chromaKeyColor?: unknown;
    chromaKeySimilarity?: unknown;
    chromaKeyBlend?: unknown;
    blendMode?: unknown;
}

const num = (value: unknown, fallback: number) => {
    if (value === null || value === undefined || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};
const truthy = (value: unknown) => (typeof value === "string" ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()) : Boolean(value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * The legacy controls normalized as the export reads them (export clip-params.ts blurStrength / chromaKey /
 * blendMode, the reference assembler's coercion): blur 0..20, key colour "0xRRGGBB" (green when unparsable),
 * similarity 0..1 (default 0.1), blend 0..1, blend mode one of four.
 */
export function legacyClipParams(clip: LegacyClipFields): {
    blurStrength: number;
    chromaKey: { enabled: boolean; color: string; similarity: number; blend: number };
    blendMode: LegacyBlendMode;
} {
    const match = String(clip.chromaKeyColor ?? "").trim().match(/^(?:#|0x)?([0-9a-fA-F]{6})$/);
    const mode = String(clip.blendMode ?? "").trim().toLowerCase();
    return {
        blurStrength: round3(clamp(num(clip.blurStrength, 0), 0, 20)),
        chromaKey: {
            enabled: truthy(clip.chromaKeyEnabled),
            color: match ? `0x${match[1]}` : "0x00FF00",
            similarity: round3(clamp(num(clip.chromaKeySimilarity, 0.1), 0, 1)),
            blend: round3(clamp(num(clip.chromaKeyBlend, 0), 0, 1)),
        },
        blendMode: mode === "multiply" || mode === "screen" || mode === "overlay" ? mode : "normal",
    };
}

/**
 * A clip's legacy ops (null: none): ffmpeg's `avgblur=sizeX=r:sizeY=r` with r = trunc(blur), chromakey, and the
 * blend mode's eq lookup, in the plane modes of legacyPlaneModes. `radiusScale` scales the blur radius for a layer
 * drawn at another size than the export's (the preview), keeping at least 1 px.
 */
export function clipLegacyOps(clip: LegacyClipFields, options: { input: "yuv420" | "rgb"; yuva444Fades?: boolean; radiusScale?: number }): LegacyOps | null {
    const params = legacyClipParams(clip);
    const radius = Math.trunc(params.blurStrength);
    const key = params.chromaKey;
    if (radius < 1 && !key.enabled && params.blendMode === "normal") return null;
    const modes = legacyPlaneModes(options.input, { chromaKey: key.enabled, eq: params.blendMode !== "normal", yuva444Fades: Boolean(options.yuva444Fades) });
    const scaled = options.radiusScale === undefined ? radius : Math.max(1, Math.round(radius * options.radiusScale));
    return {
        blur: radius >= 1 ? { radius: scaled, mode: modes.blur } : null,
        chromaKey: key.enabled ? { key: { ...chromaKeyUv(key.color), similarity: key.similarity, blend: key.blend }, subsampled: modes.subsampled } : null,
        eq: params.blendMode !== "normal" ? eqPlanes(BLEND_MODE_ADJUSTMENTS[params.blendMode]) : null,
    };
}

/**
 * What a media layer hands the legacy filters before any look: decoded video, JPEG, and WebP as 4:2:0 YUV; PNG and
 * GIF (and anything else) as RGB(A). A look before them always hands over RGB.
 */
export function legacyMediaInput(url: string, video: boolean): "yuv420" | "rgb" {
    if (/\.(?:gif|png)(?:[?#]|$)/i.test(url)) return "rgb";
    return video || /\.(?:jpe?g|webp)(?:[?#]|$)/i.test(url) ? "yuv420" : "rgb";
}
