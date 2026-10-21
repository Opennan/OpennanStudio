// Masks (phase 10c): per-item shapes that cut the item's alpha, defined once as an expression of the 10a IR
// and run by every backend: the preview's LookRenderer (GLSL, parameters as uniforms evaluated at the
// item's keyframe time), the ffmpeg export (a generated gray PNG for a static mask — exactly this module's
// evaluation — or `geq` on alpha with the keyframed parameters as expressions of T), and the GPU export
// (LookRenderer again). The JS evaluator is the reference.
//
// Model: `maskJson` on a clip or scene holds a MaskSpec. Units are relative to the item's own pixel box
// (the pixels its look runs on), so the mask follows the item through fit, scale, rotation, and motion:
//   x, y        mask centre as fractions of the item's width and height (0.5, 0.5 = centre)
//   width,      sizes in units of the item's SHORTER side R = min(W, H) (a circle of 0.5 × 0.5 is round on
//   height      any aspect ratio). Circle, rectangle, heart, and star fill the width × height box; mirror
//               uses `width` as the band thickness; linear ignores both.
//   rotation    degrees, clockwise, about the mask centre
//   feather     0..1: the edge ramp is feather · MASK_FEATHER_SCALE · R pixels wide (centred on the edge)
//   roundness   0..1 (rectangle): corner radius as a fraction of the smaller half side
//   invert      keep the outside instead of the inside
// Text and sticker bitmaps (phase 10d) carry padding around the item's box (outlines, shadows, glyph bleed):
// a MaskBox places the item box inside the pixels the mask runs on, so X, Y, W, H above are the box's, and
// the padding takes the mask's continuation (pixel x of the bitmap is box pixel x − box.x).
// Keyframes: numeric channels mask_x mask_y mask_w mask_h mask_rotation mask_feather in keyframesJson
// (keyframes v2, same units); a keyframed channel overrides the static value.
//
// Math (item pixels, pixel centres at X + 0.5): signed distance d to the shape (negative inside), feather
// width f = max(feather · MASK_FEATHER_SCALE · R, 1 px) — a hard edge is a one-pixel ramp, so every backend
// draws the same antialiased edge instead of flipping pixels on rounding — m = clamp(0.5 − d / f, 0, 1),
// invert → 1 − m, level L = floor(255·m + 0.5). The item's alpha becomes floor(alpha · L / 255) (ffmpeg
// blend multiply, integer math in GLSL).
import {
    abs, add, bind, clip, compileExpr, cos, div, evaluate, floor, gt, hypot, iff, lt, max, min, mul, n, neg, param, sin, sqrt, sub, toExpr, v,
    type Expr,
} from "./expr";
import { channelExpr, channelValueAt, hasChannel, type KeyframePoints } from "../motion/keyframes";

export const MASK_SHAPES = ["linear", "mirror", "circle", "rectangle", "heart", "star"] as const;
export type MaskShape = (typeof MASK_SHAPES)[number];

export interface MaskSpec {
    shape: MaskShape;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    feather: number;
    roundness: number;
    invert: boolean;
}

export type MaskPatch = Partial<MaskSpec>;

/** Feather 1 is a ramp this many short sides wide. */
export const MASK_FEATHER_SCALE = 0.5;
export const MASK_POSITION_RANGE = [-2, 3] as const;
export const MASK_SIZE_RANGE = [0.01, 5] as const;
export const MASK_ROTATION_LIMIT = 3600;

export const MASK_KEYFRAME_CHANNELS = ["mask_x", "mask_y", "mask_w", "mask_h", "mask_rotation", "mask_feather"] as const;
export type MaskKeyframeChannel = (typeof MASK_KEYFRAME_CHANNELS)[number];

/** Keyframe channel → spec field. */
export const MASK_CHANNEL_FIELDS: Record<MaskKeyframeChannel, "x" | "y" | "width" | "height" | "rotation" | "feather"> = {
    mask_x: "x", mask_y: "y", mask_w: "width", mask_h: "height", mask_rotation: "rotation", mask_feather: "feather",
};

/** Expression parameter of each numeric spec field (GLSL uniforms u_mx…, ffmpeg constants or keyframe expressions). */
const PARAM_OF = { x: "mx", y: "my", width: "mw", height: "mh", rotation: "mr", feather: "mf", roundness: "mo" } as const;
type NumericField = keyof typeof PARAM_OF;
const NUMERIC_FIELDS = Object.keys(PARAM_OF) as NumericField[];
const CHANNEL_OF: Partial<Record<NumericField, MaskKeyframeChannel>> = {
    x: "mask_x", y: "mask_y", width: "mask_w", height: "mask_h", rotation: "mask_rotation", feather: "mask_feather",
};

const DEFAULT_SIZE: Record<MaskShape, [number, number]> = {
    linear: [1, 1], mirror: [0.5, 1], circle: [0.6, 0.6], rectangle: [0.8, 0.8], heart: [0.6, 0.6], star: [0.6, 0.6],
};

/** Clip tracks that take a mask (phase 10c video and image clips; phase 10d text and stickers). Scenes always do. */
export const MASKABLE_CLIP_TRACKS = ["video", "text", "sticker"] as const;

/** True when a clip of this track type takes a mask. */
export function clipTakesMask(clip: { trackType?: string | null }): boolean {
    return typeof clip.trackType === "string" && (MASKABLE_CLIP_TRACKS as readonly string[]).includes(clip.trackType);
}

/** The item's box inside the pixels a mask runs on (pixels; x, y of its top-left corner, may be fractional). */
export interface MaskBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** A box of size `inner` centred in `outer` (raster bitmaps pad their box equally on every side). */
export function centredMaskBox(outer: { width: number; height: number }, inner: { width: number; height: number }): MaskBox {
    return { x: (outer.width - inner.width) / 2, y: (outer.height - inner.height) / 2, width: inner.width, height: inner.height };
}

/** True when the box is the whole w×h frame (no shift: the plain clip path). */
function isFullBox(box: MaskBox | null | undefined, w: number, h: number): boolean {
    return !box || (box.x === 0 && box.y === 0 && box.width === w && box.height === h);
}

export function isMaskShape(value: unknown): value is MaskShape {
    return typeof value === "string" && (MASK_SHAPES as readonly string[]).includes(value);
}

/** CapCut-like starting values of a shape: centred, unrotated, hard-edged. */
export function defaultMask(shape: MaskShape): MaskSpec {
    const [width, height] = DEFAULT_SIZE[shape];
    return { shape, x: 0.5, y: 0.5, width, height, rotation: 0, feather: 0, roundness: 0, invert: false };
}

const clampTo = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const round4 = (value: number) => Math.round(value * 10000) / 10000 || 0;

function numberOr(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}

function clampField(field: NumericField, value: number): number {
    switch (field) {
        case "x":
        case "y": return clampTo(value, MASK_POSITION_RANGE[0], MASK_POSITION_RANGE[1]);
        case "width":
        case "height": return clampTo(value, MASK_SIZE_RANGE[0], MASK_SIZE_RANGE[1]);
        case "rotation": return clampTo(value, -MASK_ROTATION_LIMIT, MASK_ROTATION_LIMIT);
        default: return clampTo(value, 0, 1);
    }
}

/**
 * A mask channel value clamped to its field's range (parseMask's rules), or null when it is not a finite number.
 * Keyframe writes (keyframe.set / keyframe.retime) and every evaluation use it, so a huge value never reaches the
 * shader uniforms or the export expressions as Infinity or NaN.
 */
export function clampMaskChannelValue(channel: MaskKeyframeChannel, value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return round4(clampField(MASK_CHANNEL_FIELDS[channel], value));
}

/** `values` with each mask_* channel clamped (other channels as given). */
export function clampMaskKeyframeValues(values: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = { ...values };
    for (const channel of MASK_KEYFRAME_CHANNELS) {
        if (!(channel in out)) continue;
        const clamped = clampMaskChannelValue(channel, out[channel]);
        if (clamped === null) delete out[channel];
        else out[channel] = clamped;
    }
    return out;
}

/** The points with mask channel values clamped (and non-finite ones dropped); the same array when nothing changes. */
function clampedMaskPoints(points: KeyframePoints): KeyframePoints {
    let changed = false;
    const out = points.map((point) => {
        let next: typeof point | null = null;
        for (const channel of MASK_KEYFRAME_CHANNELS) {
            if (!(channel in point)) continue;
            const value = point[channel];
            const clamped = clampMaskChannelValue(channel, value);
            if (clamped === value) continue;
            next ??= { ...point };
            if (clamped === null) delete (next as Record<string, number>)[channel];
            else (next as Record<string, number>)[channel] = clamped;
        }
        if (next) changed = true;
        return next ?? point;
    });
    return changed ? out : points;
}

function normalize(shape: MaskShape, raw: Record<string, unknown>, base: MaskSpec): MaskSpec {
    const out: MaskSpec = { ...base, shape };
    for (const field of NUMERIC_FIELDS) out[field] = round4(clampField(field, numberOr(raw[field], base[field])));
    if ("invert" in raw) out.invert = raw.invert === true || raw.invert === 1 || raw.invert === "true";
    return out;
}

/** A clip's or scene's mask, or null (absent, unreadable, unknown shape, or "none"). Fields are clamped. */
export function parseMask(raw: unknown): MaskSpec | null {
    if (!raw) return null;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!isMaskShape(record.shape)) return null;
    return normalize(record.shape, record, defaultMask(record.shape));
}

/** `maskJson` for a spec (fields in a stable order), or null for no mask. */
export function serializeMask(spec: MaskSpec | null | undefined): string | null {
    if (!spec || !isMaskShape(spec.shape)) return null;
    const clean = normalize(spec.shape, spec as unknown as Record<string, unknown>, defaultMask(spec.shape));
    return JSON.stringify({
        shape: clean.shape, x: clean.x, y: clean.y, width: clean.width, height: clean.height, rotation: clean.rotation,
        feather: clean.feather, roundness: clean.roundness, invert: clean.invert,
    });
}

/** The mask after a patch: fields merge into the current mask (a circle when there is none); a new shape keeps the geometry. */
export function applyMaskPatch(current: MaskSpec | null, patch: MaskPatch): MaskSpec | null {
    const shape = isMaskShape(patch.shape) ? patch.shape : current?.shape ?? "circle";
    const base = current ? { ...current, shape } : defaultMask(shape);
    return normalize(shape, patch as Record<string, unknown>, base);
}

// ── the expression ───────────────────────────────────────

const P = {
    x: () => param(PARAM_OF.x), y: () => param(PARAM_OF.y), width: () => param(PARAM_OF.width), height: () => param(PARAM_OF.height),
    rotation: () => param(PARAM_OF.rotation), feather: () => param(PARAM_OF.feather), roundness: () => param(PARAM_OF.roundness),
};

const shortSide = () => min(v("W"), v("H"));
/** Half sizes in pixels, at least half a pixel (a zero size keeps every backend finite). */
const halfSize = (size: Expr) => max(mul(clip(size, MASK_SIZE_RANGE[0], MASK_SIZE_RANGE[1]), shortSide(), 0.5), 0.5);
const sign = (x: Expr) => sub(gt(x, 0), lt(x, 0));

// Heart (Inigo Quilez's exact heart distance, y up, tip at the origin): lobes centred at (±0.25, 0.75) with
// radius √2/4, so the shape spans x ∈ ±HEART_X and y ∈ [0, 2·HEART_Y]; it is stretched to fill the box.
const SQRT2_4 = Math.SQRT2 / 4;
const HEART_X = 0.25 + SQRT2_4;
const HEART_Y = (0.75 + SQRT2_4) / 2;
// Five-point star (Quilez's sdStar5, a tip up, outer radius 1, inner radius STAR_INNER), stretched to fill the
// box: x ∈ ±sin 72°, y ∈ [−cos 36°, 1].
const STAR_INNER = 0.4;
const K1X = Math.cos(Math.PI / 5);
const K1Y = -Math.sin(Math.PI / 5);
const STAR_X = Math.sin((2 * Math.PI) / 5);
const STAR_BOTTOM = Math.cos(Math.PI / 5);
const STAR_Y = (1 + STAR_BOTTOM) / 2;
const STAR_CY = (1 - STAR_BOTTOM) / 2;
const BAX = STAR_INNER * -K1Y;
const BAY = STAR_INNER * K1X - 1;
const BA2 = BAX * BAX + BAY * BAY;

/** Signed distance (pixels, negative inside) at local coordinates (u, v) of the mask's unrotated frame. */
function shapeDistance(shape: MaskShape, u: Expr, w: Expr): Expr {
    switch (shape) {
        case "linear": return w;
        case "mirror": return sub(abs(w), halfSize(P.width()));
        case "circle":
            // First-order distance to the ellipse (k − 1)·k / |∇(k²)/2|: exact for circles and on both axes,
            // an even feather around ellipses. The very centre (no gradient) is deep inside.
            return bind(halfSize(P.width()), (a) => bind(halfSize(P.height()), (b) =>
                bind(hypot(div(u, a), div(w, b)), (k) => bind(hypot(div(u, mul(a, a)), div(w, mul(b, b))), (g) =>
                    iff(gt(g, 0), div(mul(sub(k, 1), k), g), neg(min(a, b)))))));
        case "rectangle":
            return bind(halfSize(P.width()), (a) => bind(halfSize(P.height()), (b) => bind(mul(clip(P.roundness(), 0, 1), min(a, b)), (r) =>
                bind(add(sub(abs(u), a), r), (qx) => bind(add(sub(abs(w), b), r), (qy) =>
                    sub(add(hypot(max(qx, 0), max(qy, 0)), min(max(qx, qy), 0)), r))))));
        case "heart":
            return bind(halfSize(P.width()), (a) => bind(halfSize(P.height()), (b) =>
                bind(mul(div(abs(u), a), HEART_X), (hx) => bind(sub(HEART_Y, mul(div(w, b), HEART_Y)), (hy) =>
                    bind(mul(0.5, max(add(hx, hy), 0)), (t) => mul(
                        iff(gt(add(hx, hy), 1),
                            sub(hypot(sub(hx, 0.25), sub(hy, 0.75)), SQRT2_4),
                            mul(sqrt(min(add(mul(hx, hx), mul(sub(hy, 1), sub(hy, 1))), add(mul(sub(hx, t), sub(hx, t)), mul(sub(hy, t), sub(hy, t))))), sign(sub(hx, hy)))),
                        min(div(a, HEART_X), div(b, HEART_Y))))))));
        case "star":
            return bind(halfSize(P.width()), (a) => bind(halfSize(P.height()), (b) =>
                bind(mul(div(abs(u), a), STAR_X), (px) => bind(add(STAR_CY, mul(neg(div(w, b)), STAR_Y)), (py) =>
                    // Fold into one arm: reflect across the two mirror lines k1 and k2 = (−k1x, k1y).
                    bind(mul(2, max(add(mul(K1X, px), mul(K1Y, py)), 0)), (w1) =>
                        bind(sub(px, mul(w1, K1X)), (px1) => bind(sub(py, mul(w1, K1Y)), (py1) =>
                            bind(mul(2, max(add(mul(-K1X, px1), mul(K1Y, py1)), 0)), (w2) =>
                                bind(abs(sub(px1, mul(w2, -K1X))), (qx) => bind(sub(sub(py1, mul(w2, K1Y)), 1), (qy) =>
                                    bind(clip(div(add(mul(qx, BAX), mul(qy, BAY)), BA2), 0, 1), (h) => mul(
                                        mul(hypot(sub(qx, mul(BAX, h)), sub(qy, mul(BAY, h))), sign(sub(mul(qy, BAX), mul(qx, BAY)))),
                                        min(div(a, STAR_X), div(b, STAR_Y))))))))))))));
    }
}

const levelCache = new Map<string, Expr>();

/**
 * The mask level (0..255) of pixel (X, Y) of a W×H item as an expression of the seven mask parameters
 * (mx my mw mh mr mf mo: the spec's x y width height rotation feather roundness). One expression per shape and
 * invert, so the preview compiles at most twelve programs and feeds the values as uniforms.
 */
export function maskLevelExpr(shape: MaskShape, invert: boolean): Expr {
    const key = `${shape}|${invert ? 1 : 0}`;
    const cached = levelCache.get(key);
    if (cached) return cached;
    const theta = mul(P.rotation(), Math.PI / 180);
    const body = bind(cos(theta), (c) => bind(sin(theta), (s) =>
        bind(sub(add(v("X"), 0.5), mul(P.x(), v("W"))), (ex) => bind(sub(add(v("Y"), 0.5), mul(P.y(), v("H"))), (ey) =>
            bind(add(mul(ex, c), mul(ey, s)), (u) => bind(sub(mul(ey, c), mul(ex, s)), (w) => {
                const feather = max(mul(clip(P.feather(), 0, 1), MASK_FEATHER_SCALE, shortSide()), 1);
                const m = clip(sub(0.5, div(shapeDistance(shape, u, w), feather)), 0, 1);
                return floor(add(mul(invert ? sub(1, m) : m, 255), 0.5));
            }))))));
    levelCache.set(key, body);
    return body;
}

/** The spec's values with every keyframed channel at keyframe time `t`, as expression parameters. */
export function maskParamValues(spec: MaskSpec, points: KeyframePoints, t: number): Record<string, number> {
    const clamped = clampedMaskPoints(points);
    const out: Record<string, number> = {};
    for (const field of NUMERIC_FIELDS) {
        const channel = CHANNEL_OF[field];
        const value = channel ? channelValueAt(clamped, channel, t, spec[field]) : spec[field];
        out[PARAM_OF[field]] = Number.isFinite(value) ? value : spec[field];
    }
    return out;
}

/** The same parameters as expressions of `time` (keyframe curves where keyed, constants otherwise). */
export function maskParamExprs(spec: MaskSpec, points: KeyframePoints, time: Expr = v("T")): Record<string, Expr> {
    const clamped = clampedMaskPoints(points);
    const out: Record<string, Expr> = {};
    for (const field of NUMERIC_FIELDS) {
        const channel = CHANNEL_OF[field];
        out[PARAM_OF[field]] = channel && hasChannel(clamped, channel) ? channelExpr(clamped, channel, spec[field], time) : n(spec[field]);
    }
    return out;
}

/** `e` with parameters replaced by expressions (bindings keep their ids). */
export function substituteParams(e: Expr, values: Record<string, Expr>): Expr {
    switch (e.k) {
        case "param": {
            const value = values[e.name];
            return value ?? e;
        }
        case "bin": return { ...e, a: substituteParams(e.a, values), b: substituteParams(e.b, values) };
        case "call": return { ...e, args: e.args.map((arg) => substituteParams(arg, values)) };
        case "if": return { ...e, c: substituteParams(e.c, values), a: substituteParams(e.a, values), b: substituteParams(e.b, values) };
        case "sample": return { ...e, x: substituteParams(e.x, values), y: substituteParams(e.y, values) };
        case "let": return { ...e, value: substituteParams(e.value, values), body: substituteParams(e.body, values) };
        default: return e;
    }
}

/** `e` with variables replaced by expressions. */
function substituteVars(e: Expr, values: Partial<Record<"X" | "Y" | "W" | "H", Expr>>): Expr {
    switch (e.k) {
        case "var": return values[e.name as "X"] ?? e;
        case "bin": return { ...e, a: substituteVars(e.a, values), b: substituteVars(e.b, values) };
        case "call": return { ...e, args: e.args.map((arg) => substituteVars(arg, values)) };
        case "if": return { ...e, c: substituteVars(e.c, values), a: substituteVars(e.a, values), b: substituteVars(e.b, values) };
        case "sample": return { ...e, x: substituteVars(e.x, values), y: substituteVars(e.y, values) };
        case "let": return { ...e, value: substituteVars(e.value, values), body: substituteVars(e.body, values) };
        default: return e;
    }
}

/**
 * The mask level as one expression of X, Y, W, H and the keyframe time `time` (the export's animated geq). With a
 * `box` the expression reads pixels of the padded bitmap: X − box.x, Y − box.y, and the box's size for W, H.
 */
export function maskExpr(spec: MaskSpec, points: KeyframePoints = [], time: Expr = v("T"), box?: MaskBox | null): Expr {
    const level = substituteParams(maskLevelExpr(spec.shape, spec.invert), maskParamExprs(spec, points, toExpr(time)));
    if (!box) return level;
    return substituteVars(level, { X: sub(v("X"), n(box.x)), Y: sub(v("Y"), n(box.y)), W: n(box.width), H: n(box.height) });
}

/** True when a mask channel is keyframed (the mask changes over time). */
export function isMaskAnimated(spec: MaskSpec | null, points: KeyframePoints): boolean {
    return Boolean(spec) && MASK_KEYFRAME_CHANNELS.some((channel) => hasChannel(points, channel));
}

/**
 * The reference level (0..255) of integer pixel (x, y) of a w×h item at keyframe time t. `box`: the item's box inside
 * the w×h pixels (a padded text or sticker bitmap); the level is the box's at (x − box.x, y − box.y).
 */
export function maskLevelAt(spec: MaskSpec, x: number, y: number, w: number, h: number, points: KeyframePoints = [], t = 0, box?: MaskBox | null): number {
    const b = isFullBox(box, w, h) ? null : box!;
    return evaluate(maskLevelExpr(spec.shape, spec.invert), {
        X: b ? x - b.x : x, Y: b ? y - b.y : y, W: b ? b.width : w, H: b ? b.height : h, T: t, params: maskParamValues(spec, points, t),
        read: () => {
            throw new Error("masks do not sample pixels");
        },
    });
}

/** The w×h gray mask image at keyframe time t (row-major levels): maskLevelAt at every pixel, compiled once. */
export function maskImage(spec: MaskSpec, width: number, height: number, points: KeyframePoints = [], t = 0, box?: MaskBox | null): Uint8Array {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const b = isFullBox(box, w, h) ? { x: 0, y: 0, width: w, height: h } : box!;
    const level = compileExpr(maskLevelExpr(spec.shape, spec.invert), maskParamValues(spec, points, t), { W: b.width, H: b.height, T: t });
    const out = new Uint8Array(w * h);
    for (let y = 0, i = 0; y < h; y += 1) for (let x = 0; x < w; x += 1, i += 1) out[i] = level(x - b.x, y - b.y, b.width, b.height, t);
    return out;
}

/** A cache key part for a box ("" for none). */
export function maskBoxKey(box: MaskBox | null | undefined): string {
    return box ? `@${box.x},${box.y},${box.width}x${box.height}` : "";
}

/** The masked alpha level: floor(alpha · level / 255), ffmpeg blend multiply's integer rule. */
export function maskedAlpha(alpha: number, level: number): number {
    return Math.floor((alpha * level) / 255);
}

/** Mask keyframe points only (other channels dropped), for cache keys. */
export function maskKeyframeKey(points: KeyframePoints): string {
    const kept = points
        .map((point) => {
            const out: Record<string, number> = {};
            for (const channel of MASK_KEYFRAME_CHANNELS) if (typeof point[channel] === "number") out[channel] = point[channel];
            if (Object.keys(out).length === 0) return null;
            for (const key of ["time", "easing", "bx1", "by1", "bx2", "by2"]) if (typeof point[key] === "number") out[key] = point[key];
            return out;
        })
        .filter(Boolean);
    return kept.length > 0 ? JSON.stringify(kept) : "";
}
