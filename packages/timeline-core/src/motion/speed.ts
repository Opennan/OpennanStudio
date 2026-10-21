// Speed profiles (phase 10b). A clip or scene plays at a base speed `s` (0.1-100×) times an optional
// curve `y(u)` over OUTPUT-normalized time u ∈ [0, 1]: piecewise linear through 2-10 points [x, y]
// (x non-decreasing from 0 to 1, y ∈ [0.1, 10]; two points with the same x form a vertical step).
//
// For an item of timeline length D, output second t consumes source seconds
//     S(t) = s·D·∫₀^{t/D} y(w) dw,
// so the source span is s·D·mean(y) and the length that plays a source span is span / (s·mean(y)).
// Inside a linear segment S is quadratic, so the inverse has a closed form (one sqrt per segment).
// Both directions are written once in the expression IR (looks/expr.ts): the export remaps frames with
// `setpts='(outputTimeExpr)/TB'` and the preview evaluates the very same tree (and drives
// `playbackRate = speedAt(...)`), so frame picks agree. The JS functions below run the same operations
// in the same order as the expressions.
import type { TimelineClip } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { add, clip, div, iff, lt, mul, sqrt, sub, v, type Expr } from "../looks/expr";

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 100;
export const MIN_CURVE_SPEED = 0.1;
export const MAX_CURVE_SPEED = 10;
export const MIN_CURVE_POINTS = 2;
export const MAX_CURVE_POINTS = 10;
/** Sub-segments per item for the audio of sloped curves (atempo chains). */
export const AUDIO_CURVE_SEGMENTS = 16;

export interface SpeedCurve {
    /** A preset id (`montage`, …), a legacy ramp (`legacy_hero`, …), or `custom`. */
    id: string;
    /** [x, y]: x = output-normalized time in [0, 1], y = speed multiplier in [0.1, 10]. */
    points: Array<[number, number]>;
}

export interface SpeedProfile {
    /** Base speed, 0.1-100. */
    speed: number;
    curve: SpeedCurve | null;
    /** Keep the audio pitch (atempo) instead of letting it follow the speed (asetrate). */
    preservePitch: boolean;
}

function frozenCurve(id: string, points: Array<[number, number]>): SpeedCurve {
    points.forEach((point) => Object.freeze(point));
    return Object.freeze({ id, points: Object.freeze(points) as Array<[number, number]> });
}

/**
 * CapCut's curve presets. Smooth shapes (the ramps between levels are linear, so the preview's rate
 * never jumps except where a preset asks for a sudden change). Applying one changes the item length
 * by 1 / mean(y), as in CapCut.
 */
export const SPEED_CURVE_PRESETS: readonly SpeedCurve[] = Object.freeze([
    // Fast-slow-fast pulses.
    frozenCurve("montage", [[0, 1.2], [0.15, 3.2], [0.35, 0.55], [0.6, 3.2], [0.8, 0.55], [1, 1.6]]),
    // Normal, deep slow motion in the middle, normal.
    frozenCurve("hero", [[0, 1], [0.28, 1], [0.42, 0.25], [0.58, 0.25], [0.72, 1], [1, 1]]),
    // Fast, very slow middle, fast.
    frozenCurve("bullet", [[0, 3.5], [0.2, 2.5], [0.38, 0.15], [0.62, 0.15], [0.8, 2.5], [1, 3.5]]),
    // Sudden jumps: slow, fast, slow (2% ramps so the jump reads as a cut, not a glide).
    frozenCurve("jump_cut", [[0, 0.6], [0.3, 0.6], [0.32, 4.5], [0.68, 4.5], [0.7, 0.6], [1, 0.6]]),
    // Fast start easing into normal.
    frozenCurve("flash_in", [[0, 6], [0.12, 3.5], [0.3, 1.4], [0.5, 1], [1, 1]]),
    // Normal accelerating to fast at the end.
    frozenCurve("flash_out", [[0, 1], [0.5, 1], [0.7, 1.4], [0.88, 3.5], [1, 6]]),
]);

/**
 * The legacy `speedRamp` presets (export/src/filters/video.ts SPEED_RAMPS) as step curves: same
 * segment bounds and multipliers, so old projects keep their exported timing.
 */
export const LEGACY_RAMP_CURVES: Readonly<Record<"montage" | "hero" | "bullet", SpeedCurve>> = Object.freeze({
    montage: frozenCurve("legacy_montage", [[0, 0.55], [0.25, 0.55], [0.25, 1.85], [0.75, 1.85], [0.75, 0.75], [1, 0.75]]),
    hero: frozenCurve("legacy_hero", [[0, 0.45], [0.35, 0.45], [0.35, 1.35], [0.65, 1.35], [0.65, 0.65], [1, 0.65]]),
    bullet: frozenCurve("legacy_bullet", [[0, 1.5], [0.2, 1.5], [0.2, 0.35], [0.8, 0.35], [0.8, 1.25], [1, 1.25]]),
});

const KNOWN_CURVES = new Map<string, SpeedCurve>(
    [...SPEED_CURVE_PRESETS, ...Object.values(LEGACY_RAMP_CURVES)].map((curve) => [curve.id, curve]),
);

const copyCurve = (curve: SpeedCurve): SpeedCurve => ({ id: curve.id, points: curve.points.map(([x, y]): [number, number] => [x, y]) });

/** A fresh, editable copy of a preset or legacy curve; null for unknown ids. */
export function speedCurvePreset(id: string): SpeedCurve | null {
    const curve = KNOWN_CURVES.get(id);
    return curve ? copyCurve(curve) : null;
}

const clampTo = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

function readPoint(raw: unknown): [number, number] | null {
    let x: unknown;
    let y: unknown;
    if (Array.isArray(raw)) {
        if (raw.length !== 2) return null;
        [x, y] = raw;
    } else if (raw && typeof raw === "object") {
        ({ x, y } = raw as { x?: unknown; y?: unknown });
    } else {
        return null;
    }
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
}

/**
 * Validates a curve (a JSON string or an object `{ id, points }`, points as [x, y] or {x, y}).
 * Returns null for garbage: unparsable JSON, fewer than 2 or more than 10 points, non-finite values.
 * Otherwise clamps x to [0, 1] and y to [0.1, 10], sorts by x (stable, so steps keep their order),
 * snaps the first point to x = 0 and the last to x = 1, and maps unknown ids to `custom`.
 */
export function parseSpeedCurve(json: unknown): SpeedCurve | null {
    let value = json;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { id, points } = value as { id?: unknown; points?: unknown };
    if (!Array.isArray(points) || points.length < MIN_CURVE_POINTS || points.length > MAX_CURVE_POINTS) return null;
    const parsed: Array<[number, number]> = [];
    for (const raw of points) {
        const point = readPoint(raw);
        if (!point) return null;
        parsed.push([clampTo(point[0], 0, 1), clampTo(point[1], MIN_CURVE_SPEED, MAX_CURVE_SPEED)]);
    }
    // Array.prototype.sort is stable (ES2019).
    parsed.sort((a, b) => a[0] - b[0]);
    parsed[0][0] = 0;
    parsed[parsed.length - 1][0] = 1;
    const key = typeof id === "string" ? id.trim().toLowerCase() : "";
    return { id: KNOWN_CURVES.has(key) ? key : "custom", points: parsed };
}

/** The normalized curve as JSON (for `speedCurveJson`); null without a curve or for an invalid one. */
export function serializeSpeedCurve(curve: SpeedCurve | null | undefined): string | null {
    const normalized = curve ? parseSpeedCurve(curve) : null;
    return normalized ? JSON.stringify(normalized) : null;
}

/** Base speed: 0, negative, and missing mean 1×; otherwise clamped to [0.1, 100]. */
function baseSpeed(value: unknown): number {
    if (value === null || value === undefined || value === "") return 1;
    const speed = Number(value);
    if (!Number.isFinite(speed) || speed <= 0) return 1;
    return clampTo(speed, MIN_SPEED, MAX_SPEED);
}

/** Keep pitch unless explicitly turned off (false, 0, "false"). */
function keepPitch(value: unknown): boolean {
    return !(value === false || value === 0 || value === "false" || value === "0");
}

type ClipSpeedFields = Partial<Pick<TimelineClip, "playbackSpeed" | "speedRamp" | "speedCurveJson" | "preservePitch">>;
type SceneSpeedFields = Partial<Pick<SceneData, "playbackSpeed" | "speedCurveJson" | "preservePitch">>;

/** A clip's profile: `speedCurveJson` wins over the legacy `speedRamp` (which maps to its step curve). */
export function clipSpeedProfile(clip: ClipSpeedFields): SpeedProfile {
    let curve = parseSpeedCurve(clip.speedCurveJson);
    if (!curve) {
        const ramp = String(clip.speedRamp ?? "").trim().toLowerCase();
        if (ramp === "montage" || ramp === "hero" || ramp === "bullet") curve = copyCurve(LEGACY_RAMP_CURVES[ramp]);
    }
    return { speed: baseSpeed(clip.playbackSpeed), curve, preservePitch: keepPitch(clip.preservePitch) };
}

/**
 * Media seconds where a clip's used range starts: its trimStart (null or negative: media zero). The clip shows media
 * second clipMediaStart + S(local) at item-local second `local` (S = sourceTimeAt); reversed clips play
 * [clipMediaStart, clipMediaStart + sourceSpan] backwards and frozen ones hold its first frame. Clip edits (split,
 * cuts.apply) write it; audio clips, V2+ video overlays (preview and both exports) and the timeline's thumbnails and
 * waveforms read it.
 */
export function clipMediaStart(clip: Partial<Pick<TimelineClip, "trimStart">>): number {
    const value = Number(clip.trimStart ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A main-track scene's profile (scenes have no legacy ramp). */
export function sceneSpeedProfile(scene: SceneSpeedFields): SpeedProfile {
    return { speed: baseSpeed(scene.playbackSpeed), curve: parseSpeedCurve(scene.speedCurveJson), preservePitch: keepPitch(scene.preservePitch) };
}

const EPSILON = 1e-9;

/** True when the item plays its source 1:1 (no remap, no audio stretch needed). */
export function isIdentitySpeed(profile: SpeedProfile): boolean {
    return Math.abs(profile.speed - 1) < EPSILON && (!profile.curve || profile.curve.points.every(([, y]) => Math.abs(y - 1) < EPSILON));
}

// ── compiled curves ──────────────────────────────────────

/** One positive-width linear segment of a curve: y = y0 + m·(u − u0) on [u0, u1]. */
interface Segment {
    u0: number;
    u1: number;
    y0: number;
    m: number;
    /** ∫₀^{u0} y and ∫₀^{u1} y. */
    a0: number;
    a1: number;
}

const compiled = new WeakMap<SpeedCurve, Segment[]>();

/** Positive-width segments with their cumulative areas; vertical steps contribute none. */
function segmentsOf(curve: SpeedCurve): Segment[] {
    const cached = compiled.get(curve);
    if (cached) return cached;
    const segments: Segment[] = [];
    let area = 0;
    for (let i = 0; i + 1 < curve.points.length; i += 1) {
        const [u0, y0] = curve.points[i];
        const [u1, y1] = curve.points[i + 1];
        const width = u1 - u0;
        if (!(width > 0)) continue;
        const next = area + (width * (y0 + y1)) / 2;
        segments.push({ u0, u1, y0, m: (y1 - y0) / width, a0: area, a1: next });
        area = next;
    }
    compiled.set(curve, segments);
    return segments;
}

/** The curve's mean multiplier (its area, since x spans [0, 1]); 1 without a curve. */
export function meanCurveSpeed(curve: SpeedCurve | null | undefined): number {
    if (!curve) return 1;
    const segments = segmentsOf(curve);
    return segments.length ? segments[segments.length - 1].a1 : 1;
}

/** y(u), clamped to the ends; at a vertical step the value after the step applies. */
function curveValue(curve: SpeedCurve, u: number): number {
    const points = curve.points;
    if (!(u > 0)) {
        // u ≤ 0: the value after any step at 0.
        let i = 0;
        while (i + 1 < points.length && points[i + 1][0] <= 0) i += 1;
        return points[i][1];
    }
    if (u >= 1) return points[points.length - 1][1];
    const segments = segmentsOf(curve);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (segment.u0 <= u) return segment.y0 + segment.m * (u - segment.u0);
    }
    return points[0][1];
}

/** True when the speed never changes over the item (no curve, or a flat one). */
function isConstant(profile: SpeedProfile): boolean {
    const curve = profile.curve;
    return !curve || curve.points.every(([, y]) => y === curve.points[0][1]);
}

// ── time maps ────────────────────────────────────────────

/** Instantaneous speed s·y(t/D) at output second t: the preview's playbackRate. */
export function speedAt(profile: SpeedProfile, t: number, D: number): number {
    if (!profile.curve) return profile.speed;
    return profile.speed * curveValue(profile.curve, D > 0 ? t / D : 0);
}

/** Source seconds the whole item consumes: s·D·mean(y). */
export function sourceSpan(profile: SpeedProfile, D: number): number {
    if (!(D > 0)) return 0;
    return profile.speed * D * meanCurveSpeed(profile.curve);
}

/** Timeline length that plays `span` source seconds: span / (s·mean(y)). */
export function timelineDuration(profile: SpeedProfile, span: number): number {
    if (!(span > 0)) return 0;
    return span / (profile.speed * meanCurveSpeed(profile.curve));
}

/** S(t): source seconds consumed by output second t (t clamped to [0, D]). */
export function sourceTimeAt(profile: SpeedProfile, t: number, D: number): number {
    if (!(D > 0)) return 0;
    const s = profile.speed;
    if (!profile.curve) return s * clampTo(t, 0, D);
    const sD = s * D;
    const segments = segmentsOf(profile.curve);
    let i = segments.length - 1;
    for (let k = 0; k < segments.length - 1; k += 1) {
        if (t < segments[k + 1].u0 * D) {
            i = k;
            break;
        }
    }
    const g = segments[i];
    // Same operations as sourceTimeExpr.
    const t0 = g.u0 * D;
    const du = clipValue(t - t0, 0, g.u1 * D - t0) / D;
    return clipValue(sD * g.a0 + sD * (du * (g.y0 + (g.m / 2) * du)), 0, sD * segments[segments.length - 1].a1);
}

/** The inverse of S: the output second at which source second `source` shows (clamped to [0, D]). */
export function outputTimeAt(profile: SpeedProfile, source: number, D: number): number {
    if (!(D > 0)) return 0;
    const s = profile.speed;
    if (!profile.curve) return clipValue(source, 0, s * D) / s;
    const sD = s * D;
    const segments = segmentsOf(profile.curve);
    let i = segments.length - 1;
    for (let k = 0; k < segments.length - 1; k += 1) {
        if (source < sD * segments[k].a1) {
            i = k;
            break;
        }
    }
    const g = segments[i];
    // Same operations as outputTimeExpr.
    const s0 = sD * g.a0;
    const q = clipValue(source - s0, 0, sD * g.a1 - s0) / sD;
    const du = g.m === 0 ? q / g.y0 : (2 * q) / (g.y0 + Math.sqrt(g.y0 * g.y0 + 2 * g.m * q));
    return clipValue(g.u0 * D + D * du, 0, D);
}

/** ffmpeg av_clipd, as the IR evaluates `clip`. */
function clipValue(x: number, lo: number, hi: number): number {
    return lo > x ? lo : hi < x ? hi : x;
}

/**
 * S as an expression of output time (default `T`): nested `if(lt(t, t_{i+1}), segment_i, …)`, one
 * quadratic per segment, no bindings. Clamped to [0, sourceSpan] like sourceTimeAt.
 */
export function sourceTimeExpr(profile: SpeedProfile, D: number, time: Expr = v("T")): Expr {
    const s = profile.speed;
    if (!(D > 0)) return { k: "num", v: 0 };
    if (!profile.curve) return s === 1 ? clip(time, 0, D) : mul(s, clip(time, 0, D));
    const sD = s * D;
    const segments = segmentsOf(profile.curve);
    const piece = (g: Segment): Expr => {
        const t0 = g.u0 * D;
        const du = div(clip(t0 === 0 ? time : sub(time, t0), 0, g.u1 * D - t0), D);
        const body = mul(sD, mul(du, add(g.y0, mul(g.m / 2, du))));
        return g.a0 === 0 ? body : add(sD * g.a0, body);
    };
    let expr = piece(segments[segments.length - 1]);
    for (let i = segments.length - 2; i >= 0; i -= 1) {
        expr = iff(lt(time, segments[i + 1].u0 * D), piece(segments[i]), expr);
    }
    return clip(expr, 0, sD * segments[segments.length - 1].a1);
}

/**
 * The inverse of S as an expression of source time (default `T`, as setpts sees it after
 * `setpts=PTS-STARTPTS`): use as `setpts='(expr)/TB'`. Inside a segment with normalized area
 * q = ΔS/(s·D), Δu = 2q / (y0 + sqrt(y0² + 2m·q)) — the stable root of the quadratic, valid for m = 0.
 * Vertical steps add no segment; no bindings, so the expression is safe on every ffmpeg thread.
 */
export function outputTimeExpr(profile: SpeedProfile, D: number, source: Expr = v("T")): Expr {
    const s = profile.speed;
    if (!(D > 0)) return { k: "num", v: 0 };
    if (!profile.curve) return div(clip(source, 0, s * D), s);
    const sD = s * D;
    const segments = segmentsOf(profile.curve);
    const piece = (g: Segment): Expr => {
        const s0 = sD * g.a0;
        const q = div(clip(s0 === 0 ? source : sub(source, s0), 0, sD * g.a1 - s0), sD);
        const du = g.m === 0 ? div(q, g.y0) : div(mul(2, q), add(g.y0, sqrt(add(g.y0 * g.y0, mul(2 * g.m, q)))));
        return g.u0 === 0 ? mul(D, du) : add(g.u0 * D, mul(D, du));
    };
    let expr = piece(segments[segments.length - 1]);
    for (let i = segments.length - 2; i >= 0; i -= 1) {
        expr = iff(lt(source, sD * segments[i].a1), piece(segments[i]), expr);
    }
    return clip(expr, 0, D);
}

// ── audio and rescaling ──────────────────────────────────

export interface AudioSegment {
    outputStart: number;
    outputEnd: number;
    sourceStart: number;
    sourceEnd: number;
    /** Source seconds per output second over the segment (its mean speed). */
    speed: number;
}

/**
 * Audio pieces for atempo / asetrate chains. Constant speed: one segment. Curves: split at every
 * breakpoint (flat parts and steps stay exact), and each sloped segment into ceil(n·width) equal slices,
 * each played at its mean speed (a documented approximation: slice ends land on the exact source time).
 * Adjacent pieces of equal speed merge. Boundaries are shared, so pieces are contiguous.
 */
export function audioSegments(profile: SpeedProfile, D: number, n = AUDIO_CURVE_SEGMENTS): AudioSegment[] {
    if (!(D > 0)) return [];
    if (isConstant(profile)) {
        const span = sourceSpan(profile, D);
        return [{ outputStart: 0, outputEnd: D, sourceStart: 0, sourceEnd: span, speed: span / D }];
    }
    const slices = Math.max(1, Math.floor(n));
    const cuts: number[] = [0];
    for (const g of segmentsOf(profile.curve!)) {
        const count = g.m === 0 ? 1 : Math.max(1, Math.ceil(slices * (g.u1 - g.u0) - EPSILON));
        for (let k = 1; k <= count; k += 1) cuts.push(k === count ? g.u1 * D : (g.u0 + ((g.u1 - g.u0) * k) / count) * D);
    }
    cuts[cuts.length - 1] = D;
    const sources = cuts.map((t) => sourceTimeAt(profile, t, D));
    const out: AudioSegment[] = [];
    for (let i = 0; i + 1 < cuts.length; i += 1) {
        const piece = { outputStart: cuts[i], outputEnd: cuts[i + 1], sourceStart: sources[i], sourceEnd: sources[i + 1], speed: 0 };
        if (!(piece.outputEnd > piece.outputStart)) continue;
        piece.speed = (piece.sourceEnd - piece.sourceStart) / (piece.outputEnd - piece.outputStart);
        const last = out[out.length - 1];
        if (last && Math.abs(last.speed - piece.speed) < EPSILON) {
            last.outputEnd = piece.outputEnd;
            last.sourceEnd = piece.sourceEnd;
            last.speed = (last.sourceEnd - last.sourceStart) / (last.outputEnd - last.outputStart);
        } else {
            out.push(piece);
        }
    }
    return out;
}

/**
 * Where item-local time `localTime` (under profile p0, length D0) lands after the speed changes to
 * p1 / D1, keeping the same source moment: for rescaling keyframes and animations on `speed.set`.
 */
export function rescaleTimes(p0: SpeedProfile, D0: number, p1: SpeedProfile, D1: number, localTime: number): number {
    return outputTimeAt(p1, sourceTimeAt(p0, localTime, D0), D1);
}
