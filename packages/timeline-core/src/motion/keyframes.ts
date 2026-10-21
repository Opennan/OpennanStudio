// Keyframes v2 (phase 10b). Points stay `{ time, <channel>: number }` in `keyframesJson` (numbers only, so
// parseTimelineKeyframes and the server format are unchanged). A point may carry `easing` (easing.ts code)
// and `bx1 by1 bx2 by2` (bezier handles); the easing of a point shapes the segment from that point to the
// next point that defines the same channel. Values hold before the first and after the last point.
//
// Every channel curve is built once from the same folded constants as a JS function (channelValueAt, the
// preview) and as an expression (channelExpr, the export's scalar target), so both evaluate identically.
import { add, div, gte, iff, lt, lte, mul, n, sub, toExpr, v, type Expr } from "../looks/expr";
import { roundTimelineTime } from "../lib/timeline-editing-shared";
import type { TimelineKeyframePoint } from "../lib/timeline-editing-properties";
import { BEZIER_SEGMENTS, bezierTable, easeExpr, easeValue, easingCode, easingFromCode, normalizeBezier, type BezierHandles, type EasingId } from "./easing";

export const TRANSFORM_KEYFRAME_CHANNELS = [
    "position_x", "position_y", "scale", "rotation_degrees", "opacity", "volume", "filter_intensity",
] as const;

/** `adj_<key>` for the ten pointwise Adjust controls (looks/adjust.ts POINTWISE_ADJUSTMENTS; not sharpen, vignette, grain). */
export const ADJUST_KEYFRAME_CHANNELS = [
    "adj_brightness", "adj_contrast", "adj_saturation", "adj_exposure", "adj_temperature", "adj_tint",
    "adj_highlights", "adj_shadows", "adj_vibrance", "adj_fade",
] as const;

export const KEYFRAME_CHANNELS = [...TRANSFORM_KEYFRAME_CHANNELS, ...ADJUST_KEYFRAME_CHANNELS] as const;
export type KeyframeChannel = (typeof KEYFRAME_CHANNELS)[number];

/** Point keys that are not channels. */
export const KEYFRAME_META_KEYS: readonly string[] = ["time", "easing", "bx1", "by1", "bx2", "by2"];
const BEZIER_KEYS = ["bx1", "by1", "bx2", "by2"] as const;

/** Two points closer than this are the same keyframe (setKeyframe merges into it). */
export const KEYFRAME_MERGE_TOLERANCE = 0.001;

export type KeyframePoints = readonly TimelineKeyframePoint[];

const isChannelKey = (key: string) => !KEYFRAME_META_KEYS.includes(key);

/** The easing a point gives the segment it starts. */
export function pointEasing(point: TimelineKeyframePoint): { id: EasingId; bezier: BezierHandles | null } {
    const id = easingFromCode(point.easing);
    if (id !== "bezier") return { id, bezier: null };
    return { id, bezier: normalizeBezier(BEZIER_KEYS.map((key) => point[key])) };
}

export function hasChannel(points: KeyframePoints, channel: string): boolean {
    return points.some((point) => typeof point[channel] === "number");
}

/** One interpolated span between two consecutive points of a channel. */
interface Segment {
    t0: number;
    t1: number;
    v0: number;
    v1: number;
    easing: EasingId;
    bezier: BezierHandles | null;
}

/** Bezier segments as their 33-knot polyline in channel units: knots (t, value) and per-piece slopes. */
interface BezierPieces {
    times: number[];
    values: number[];
    slopes: number[];
}

const bezierCache = new WeakMap<Segment, BezierPieces>();

function bezierPieces(segment: Segment): BezierPieces {
    const cached = bezierCache.get(segment);
    if (cached) return cached;
    const table = bezierTable(segment.bezier);
    const span = segment.t1 - segment.t0;
    const dv = segment.v1 - segment.v0;
    const times = table.map(([x]) => segment.t0 + span * x);
    const values = table.map(([, y]) => segment.v0 + dv * y);
    const slopes: number[] = [];
    for (let i = 0; i < BEZIER_SEGMENTS; i += 1) slopes.push((values[i + 1] - values[i]) / (times[i + 1] - times[i]));
    const pieces = { times, values, slopes };
    bezierCache.set(segment, pieces);
    return pieces;
}

/** The bezier piece holding `t`: the first i with t < times[i + 1] (the last piece past the end), by bisection. */
function bezierPieceIndex(times: readonly number[], t: number): number {
    let lo = 0;
    let hi = BEZIER_SEGMENTS - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t < times[mid + 1]) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

function segmentValue(segment: Segment, t: number): number {
    const { t0, t1, v0, v1 } = segment;
    if (v0 === v1) return v0;
    if (segment.easing === "hold") return t >= t1 ? v1 : v0;
    if (segment.easing === "bezier") {
        const { times, values, slopes } = bezierPieces(segment);
        const i = bezierPieceIndex(times, t);
        return values[i] + slopes[i] * (t - times[i]);
    }
    return v0 + (v1 - v0) * easeValue(segment.easing, (t - t0) / (t1 - t0));
}

function segmentExpr(segment: Segment, time: Expr): Expr {
    const { t0, t1, v0, v1 } = segment;
    if (v0 === v1) return n(v0);
    if (segment.easing === "hold") return iff(gte(time, t1), v1, v0);
    if (segment.easing === "bezier") {
        const { times, values, slopes } = bezierPieces(segment);
        const piece = (i: number) => add(values[i], mul(slopes[i], sub(time, times[i])));
        // The same bisection as bezierPieceIndex, as a balanced tree of tests (5 levels, not 31).
        const search = (lo: number, hi: number): Expr => {
            if (lo === hi) return piece(lo);
            const mid = (lo + hi) >> 1;
            return iff(lt(time, times[mid + 1]), search(lo, mid), search(mid + 1, hi));
        };
        return search(0, BEZIER_SEGMENTS - 1);
    }
    return add(v0, mul(v1 - v0, easeExpr(segment.easing, div(sub(time, t0), t1 - t0))));
}

interface ChannelCurve {
    first: { time: number; value: number };
    last: { time: number; value: number };
    /** Reachable segments in time order (zero-length spans dropped: a time inside them never selects them). */
    segments: Segment[];
}

/** Curves per points array and channel: the preview evaluates the same array every frame. */
const curveCache = new WeakMap<KeyframePoints, Map<string, ChannelCurve | null>>();

function channelCurve(points: KeyframePoints, channel: string): ChannelCurve | null {
    let byChannel = curveCache.get(points);
    if (!byChannel) {
        byChannel = new Map();
        curveCache.set(points, byChannel);
    }
    if (byChannel.has(channel)) return byChannel.get(channel)!;
    const curve = buildChannelCurve(points, channel);
    byChannel.set(channel, curve);
    return curve;
}

/** The segment holding `t` inside (first, last): the first i with t <= t1_i (the last one otherwise), by bisection. */
function segmentIndex(segments: readonly Segment[], t: number): number {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t <= segments[mid].t1) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

function buildChannelCurve(points: KeyframePoints, channel: string): ChannelCurve | null {
    const defined = points
        .filter((point) => typeof point[channel] === "number" && Number.isFinite(point[channel]))
        .slice()
        .sort((a, b) => a.time - b.time);
    if (defined.length === 0) return null;
    const segments: Segment[] = [];
    for (let i = 0; i < defined.length - 1; i += 1) {
        const a = defined[i];
        const b = defined[i + 1];
        if (!(b.time > a.time)) continue;
        const { id, bezier } = pointEasing(a);
        segments.push({ t0: a.time, t1: b.time, v0: a[channel], v1: b[channel], easing: id, bezier });
    }
    const last = defined[defined.length - 1];
    return { first: { time: defined[0].time, value: defined[0][channel] }, last: { time: last.time, value: last[channel] }, segments };
}

/**
 * The channel's value at item-local `t` seconds (the preview). Segments cover (t_i, t_{i+1}]; the first
 * value holds at and before the first point, the last value at and after the last point (the 10a rule).
 */
export function channelValueAt(points: KeyframePoints, channel: string, t: number, fallback: number): number {
    const curve = channelCurve(points, channel);
    if (!curve) return fallback;
    if (t <= curve.first.time) return curve.first.value;
    if (t >= curve.last.time) return curve.last.value;
    if (curve.segments.length === 0) return curve.last.value;
    return segmentValue(curve.segments[segmentIndex(curve.segments, t)], t);
}

/**
 * The same curve as an expression of `time` (default the item-local `T`); a constant channel is a single number.
 * Segments are chosen by a balanced tree of tests over their end times (the bisection channelValueAt runs), so a
 * channel of n keyframes nests about log2(n) levels, not n: ffmpeg's expression parser recurses per level.
 */
export function channelExpr(points: KeyframePoints, channel: string, fallback: number, time: Expr = v("T")): Expr {
    const curve = channelCurve(points, channel);
    if (!curve) return n(fallback);
    const value = curve.first.value;
    if (curve.last.value === value && curve.segments.every((segment) => segment.v0 === value && segment.v1 === value)) return n(value);
    const segments = curve.segments;
    const search = (lo: number, hi: number): Expr => {
        if (lo === hi) return segmentExpr(segments[lo], time);
        const mid = (lo + hi) >> 1;
        return iff(lte(time, segments[mid].t1), search(lo, mid), search(mid + 1, hi));
    };
    const expr: Expr = segments.length > 0 ? search(0, segments.length - 1) : n(curve.last.value);
    return toExpr(iff(lte(time, curve.first.time), curve.first.value, iff(gte(time, curve.last.time), curve.last.value, expr)));
}

/** The point within `tolerance` seconds of `t` (the closest one), if any. */
export function pointAt(points: KeyframePoints, t: number, tolerance = KEYFRAME_MERGE_TOLERANCE): TimelineKeyframePoint | undefined {
    let best: TimelineKeyframePoint | undefined;
    let bestDistance = Infinity;
    for (const point of points) {
        const distance = Math.abs(point.time - t);
        if (distance <= tolerance + 1e-9 && distance < bestDistance) {
            best = point;
            bestDistance = distance;
        }
    }
    return best;
}

/** Sorted, de-duplicated times of points that define any of `channels` (any channel when omitted). */
export function keyframeTimes(points: KeyframePoints, channels?: readonly string[]): number[] {
    const times = points
        .filter((point) => Object.keys(point).some((key) => isChannelKey(key) && typeof point[key] === "number" && (!channels || channels.includes(key))))
        .map((point) => point.time)
        .sort((a, b) => a - b);
    return times.filter((time, i) => i === 0 || time !== times[i - 1]);
}

export interface KeyframeEasingOptions {
    easing?: EasingId;
    bezier?: readonly number[] | null;
}

/** Writes the easing keys of a point in place (linear removes them, so legacy-shaped points stay legacy-shaped). */
function writeEasing(point: TimelineKeyframePoint, easing: EasingId, bezier?: readonly number[] | null): void {
    delete point.easing;
    for (const key of BEZIER_KEYS) delete point[key];
    if (easing === "linear") return;
    point.easing = easingCode(easing);
    if (easing === "bezier") {
        const handles = normalizeBezier(bezier);
        BEZIER_KEYS.forEach((key, i) => {
            point[key] = handles[i];
        });
    }
}

const byTime = (a: TimelineKeyframePoint, b: TimelineKeyframePoint) => a.time - b.time;

/**
 * Sets channel values at `t`: merged into the point within 1 ms of `t` when there is one, else a new point.
 * `options.easing` sets that point's easing. Returns new sorted points; the input is not changed.
 */
export function setKeyframe(
    points: KeyframePoints,
    t: number,
    values: Partial<Record<KeyframeChannel, number>> & Record<string, number>,
    options: KeyframeEasingOptions = {},
): TimelineKeyframePoint[] {
    const existing = pointAt(points, t);
    const next: TimelineKeyframePoint = existing ? { ...existing } : ({ time: roundTimelineTime(Math.max(0, t)) } as TimelineKeyframePoint);
    for (const [key, value] of Object.entries(values)) {
        if (isChannelKey(key) && typeof value === "number" && Number.isFinite(value)) next[key] = value;
    }
    if (options.easing) writeEasing(next, options.easing, options.bezier);
    const others = points.filter((point) => point !== existing);
    return [...others, next].sort(byTime);
}

/** Removes `channels` from the point at `t` (the whole point when omitted); points left without channels are dropped. */
export function removeKeyframe(points: KeyframePoints, t: number, channels?: readonly string[]): TimelineKeyframePoint[] {
    const target = pointAt(points, t);
    if (!target) return points.slice();
    if (!channels) return points.filter((point) => point !== target);
    const next = { ...target };
    for (const channel of channels) {
        if (isChannelKey(channel)) delete next[channel];
    }
    const keepsChannel = Object.keys(next).some(isChannelKey);
    return points.flatMap((point) => (point !== target ? [point] : keepsChannel ? [next] : []));
}

/** Sets the easing of the point at `t` (no point there: unchanged). */
export function setKeyframeEasing(points: KeyframePoints, t: number, easing: EasingId, bezier?: readonly number[] | null): TimelineKeyframePoint[] {
    const target = pointAt(points, t);
    if (!target) return points.slice();
    const next = { ...target };
    writeEasing(next, easing, bezier);
    return points.map((point) => (point === target ? next : point));
}

const EASING_KEYS = ["easing", ...BEZIER_KEYS] as const;

/**
 * Moves the point at `from` (within 1 ms) to `to` (rounded to the millisecond, never below 0). With `channels`,
 * only those channels move: the point splits, both halves keeping its easing. Landing within 1 ms of another
 * point merges into it (its time is kept); the moved values and the moved easing win. Returns new sorted
 * points (unchanged when there is no such point or it defines none of `channels`); the input is not changed.
 */
export function retimeKeyframe(points: KeyframePoints, from: number, to: number, channels?: readonly string[]): TimelineKeyframePoint[] {
    const source = pointAt(points, from);
    if (!source) return points.slice();
    const sourceChannels = Object.keys(source).filter((key) => isChannelKey(key) && typeof source[key] === "number");
    const moving = channels ? sourceChannels.filter((key) => channels.includes(key)) : sourceChannels;
    if (moving.length === 0) return points.slice();
    const time = roundTimelineTime(Math.max(0, to));
    const whole = moving.length === sourceChannels.length;
    const moved = { time } as TimelineKeyframePoint;
    for (const key of moving) moved[key] = source[key];
    for (const key of EASING_KEYS) if (typeof source[key] === "number") moved[key] = source[key];
    let rest: TimelineKeyframePoint[];
    if (whole) {
        rest = points.filter((point) => point !== source);
    } else {
        const left = { ...source };
        for (const key of moving) delete left[key];
        rest = points.map((point) => (point === source ? left : point));
    }
    const target = pointAt(rest, time);
    // A partial move back onto its own remainder rejoins it (same point, same easing).
    if (!target) return [...rest, moved].sort(byTime);
    const merged: TimelineKeyframePoint = { ...target };
    for (const key of EASING_KEYS) delete merged[key];
    for (const [key, value] of Object.entries(moved)) if (key !== "time") merged[key] = value;
    return rest.map((point) => (point === target ? merged : point)).sort(byTime);
}

/** `{"keyframes":[…]}` sorted by time, or null when there are no points. */
export function serializeKeyframes(points: KeyframePoints): string | null {
    if (points.length === 0) return null;
    return JSON.stringify({ keyframes: points.slice().sort(byTime) });
}
