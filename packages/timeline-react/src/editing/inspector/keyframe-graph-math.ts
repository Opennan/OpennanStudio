// Pure math for the keyframe graph editor (phase 10c): scales, ticks, the auto-scaled value axis, channel
// points and segments, the curve as an SVG path (the preview's own evaluation, channelValueAt), hit tests,
// bezier handle mapping, and where a dragged point lands (30 fps grid, the playhead, Shift locks an axis).
import type { TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { normalizeBezier, type BezierHandles, type EasingId } from "@opennan/timeline-core/motion/easing";
import { ADJUST_KEYFRAME_CHANNELS, KEYFRAME_CHANNELS, KEYFRAME_META_KEYS, channelValueAt, pointEasing, type KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import { snapKeyframeTime } from "@opennan/timeline-core/timeline/canvas/keyframe-markers";

export const GRAPH_PAD = { left: 40, right: 12, top: 10, bottom: 18 } as const;

export interface GraphLayout {
    width: number;
    height: number;
}

export interface GraphScale {
    duration: number;
    lo: number;
    hi: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
    x(t: number): number;
    y(v: number): number;
    t(x: number): number;
    v(y: number): number;
}

/** Item time (0..duration) across the plot width, values lo..hi up the plot height. */
export function makeGraphScale(layout: GraphLayout, duration: number, [lo, hi]: readonly [number, number]): GraphScale {
    const left = GRAPH_PAD.left;
    const right = Math.max(left + 1, layout.width - GRAPH_PAD.right);
    const top = GRAPH_PAD.top;
    const bottom = Math.max(top + 1, layout.height - GRAPH_PAD.bottom);
    const d = Math.max(0.001, duration);
    const span = hi - lo || 1;
    return {
        duration: d, lo, hi, left, right, top, bottom,
        x: (t) => left + (t / d) * (right - left),
        y: (v) => bottom - ((v - lo) / span) * (bottom - top),
        t: (x) => ((x - left) / (right - left)) * d,
        v: (y) => lo + ((bottom - y) / (bottom - top)) * span,
    };
}

/** The smallest 1, 2, 2.5, or 5 × 10^k step that gives at most `maxTicks` intervals over `span`. */
export function niceStep(span: number, maxTicks: number): number {
    const raw = Math.abs(span) / Math.max(1, maxTicks);
    if (!(raw > 0) || !Number.isFinite(raw)) return 1;
    const power = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) {
        const step = m * power;
        if (step >= raw * (1 - 1e-9)) return Number(step.toPrecision(12));
    }
    return 10 * power;
}

/** Tick values on nice steps inside [lo, hi]. */
export function ticks(lo: number, hi: number, maxTicks: number): number[] {
    const step = niceStep(hi - lo, maxTicks);
    const out: number[] = [];
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k += 1) out.push(Number((k * step).toPrecision(12)) + 0);
    return out;
}

export interface ChannelFormat {
    /** Channel units → displayed units (the inspector's sliders). */
    factor: number;
    suffix: string;
    /** One keyboard nudge, in channel units. */
    step: number;
    min?: number;
    max?: number;
}

const ADJUST_SET = new Set<string>(ADJUST_KEYFRAME_CHANNELS);

/** The units the inspector shows a channel in, its nudge step, and its valid range. */
export function channelFormat(channel: string, kind: "clip" | "scene"): ChannelFormat {
    switch (channel) {
        case "scale": return { factor: 100, suffix: "%", step: 0.01, min: 0.1, max: kind === "clip" ? 4 : 3 };
        case "position_x":
        case "position_y": return kind === "clip" ? { factor: 100, suffix: "%", step: 0.01, min: -1, max: 2 } : { factor: 1, suffix: "%", step: 1, min: -200, max: 200 };
        case "rotation_degrees": return { factor: 1, suffix: "°", step: 1, min: -360, max: 360 };
        case "opacity": return { factor: 100, suffix: "%", step: 0.01, min: 0, max: 1 };
        case "volume": return { factor: 100, suffix: "%", step: 0.01, min: 0, max: 2 };
        case "filter_intensity": return { factor: 100, suffix: "%", step: 0.01, min: 0, max: 1 };
        default:
            if (ADJUST_SET.has(channel)) return { factor: 100, suffix: "", step: 0.01, min: channel === "adj_fade" ? 0 : -1, max: 1 };
            return { factor: 1, suffix: "", step: 0.01 };
    }
}

/** A value in display units, to the precision of one nudge. */
export function formatValue(value: number, format: ChannelFormat): string {
    const shown = value * format.factor;
    const decimals = Math.max(0, Math.ceil(-Math.log10(format.step * format.factor) - 1e-9));
    const text = shown.toFixed(decimals);
    return `${text === "-0" ? "0" : text}${format.suffix}`;
}

export const clampToFormat = (value: number, format: ChannelFormat) =>
    Math.min(format.max ?? Infinity, Math.max(format.min ?? -Infinity, value));

const META = new Set(KEYFRAME_META_KEYS);
const ORDER = new Map<string, number>(KEYFRAME_CHANNELS.map((channel, i) => [channel, i]));

/** Channels that have at least one keyframe: the inspector's order first, others (new families) by name. */
export function graphChannels(points: KeyframePoints): string[] {
    const found = new Set<string>();
    for (const point of points) for (const key of Object.keys(point)) if (!META.has(key) && typeof point[key] === "number") found.add(key);
    return [...found].sort((a, b) => (ORDER.get(a) ?? 1e3) - (ORDER.get(b) ?? 1e3) || a.localeCompare(b));
}

/** The channels one inspector diamond keys together: position x/y, and Adjust with the filter intensity. */
export function channelGroup(channel: string): string[] {
    if (channel === "position_x" || channel === "position_y") return ["position_x", "position_y"];
    if (ADJUST_SET.has(channel) || channel === "filter_intensity") return [...ADJUST_KEYFRAME_CHANNELS, "filter_intensity"];
    return [channel];
}

export interface ChannelPoint {
    time: number;
    value: number;
    easing: EasingId;
    bezier: BezierHandles | null;
}

const defining = (points: KeyframePoints, channel: string) =>
    points.filter((p) => typeof p[channel] === "number" && Number.isFinite(p[channel])).slice().sort((a, b) => a.time - b.time);

/** The points that define `channel`, in time order. */
export function channelPoints(points: KeyframePoints, channel: string): ChannelPoint[] {
    return defining(points, channel).map((p: TimelineKeyframePoint) => {
        const { id, bezier } = pointEasing(p);
        return { time: p.time, value: p[channel], easing: id, bezier };
    });
}

export interface GraphSegment {
    index: number;
    t0: number;
    t1: number;
    v0: number;
    v1: number;
    easing: EasingId;
    bezier: BezierHandles | null;
}

/** Consecutive pairs of a channel's points, each with the easing of its left point. */
export function channelSegments(points: KeyframePoints, channel: string): GraphSegment[] {
    const cps = channelPoints(points, channel);
    const out: GraphSegment[] = [];
    for (let i = 0; i < cps.length - 1; i += 1) {
        if (!(cps[i + 1].time > cps[i].time)) continue;
        out.push({ index: out.length, t0: cps[i].time, t1: cps[i + 1].time, v0: cps[i].value, v1: cps[i + 1].value, easing: cps[i].easing, bezier: cps[i].bezier });
    }
    return out;
}

/** Curve vertices (time, value) over [0, duration]: dense samples of channelValueAt, holds as steps. */
function curveVertices(points: KeyframePoints, channel: string, base: number, scale: GraphScale): Array<[number, number]> {
    const d = scale.duration;
    const value = (t: number) => channelValueAt(points, channel, t, base);
    const cps = channelPoints(points, channel);
    if (cps.length === 0) return [[0, base], [d, base]];
    const out: Array<[number, number]> = [[0, value(0)]];
    const segments = channelSegments(points, channel);
    out.push([Math.max(0, Math.min(d, cps[0].time)), cps[0].value]);
    const pxPerSecond = (scale.right - scale.left) / d;
    for (const s of segments) {
        if (s.easing === "hold") {
            out.push([s.t1, s.v0], [s.t1, s.v1]);
            continue;
        }
        const n = Math.max(2, Math.ceil(((s.t1 - s.t0) * pxPerSecond) / 2));
        for (let i = 1; i <= n; i += 1) {
            const t = i === n ? s.t1 : s.t0 + ((s.t1 - s.t0) * i) / n;
            out.push([t, i === n ? s.v1 : value(t)]);
        }
    }
    out.push([d, value(d)]);
    return out;
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** The channel's curve as an SVG path in graph pixels. */
export function curvePath(points: KeyframePoints, channel: string, base: number, scale: GraphScale): string {
    return `M${curveVertices(points, channel, base, scale).map(([t, v]) => `${fmt(scale.x(t))},${fmt(scale.y(v))}`).join(" L")}`;
}

/** The value axis: the curve's range (overshoot included) with a 10 % margin, at least 20 nudges tall. */
export function graphDomain(points: KeyframePoints, channel: string, base: number, duration: number, kind: "clip" | "scene" = "clip"): [number, number] {
    const d = Math.max(0.001, duration);
    const values = channelPoints(points, channel).map((p) => p.value);
    for (let i = 0; i <= 200; i += 1) values.push(channelValueAt(points, channel, (d * i) / 200, base));
    // Bezier handles stay inside the plot, where they can be grabbed.
    for (const s of channelSegments(points, channel)) {
        if (s.easing !== "bezier" || s.v0 === s.v1) continue;
        const [, y1, , y2] = s.bezier ?? normalizeBezier(null);
        values.push(s.v0 + y1 * (s.v1 - s.v0), s.v0 + y2 * (s.v1 - s.v0));
    }
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const minSpan = channelFormat(channel, kind).step * 20;
    if (hi - lo < minSpan) {
        const mid = (lo + hi) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
    }
    const margin = (hi - lo) * 0.1;
    return [lo - margin, hi + margin];
}

/** The point within `radius` px of (px, py), the closest; null when none. */
export function hitPoint(cps: readonly ChannelPoint[], scale: GraphScale, px: number, py: number, radius = 8): number | null {
    let best: number | null = null;
    let bestDistance = radius + 1e-9;
    cps.forEach((p, i) => {
        const distance = Math.hypot(scale.x(p.time) - px, scale.y(p.value) - py);
        if (distance <= bestDistance) {
            best = i;
            bestDistance = distance;
        }
    });
    return best;
}

/** The segment whose curve passes within `tolerance` px vertically of (px, py); null when none. */
export function hitSegment(
    points: KeyframePoints, channel: string, base: number, segments: readonly GraphSegment[], scale: GraphScale, px: number, py: number, tolerance = 6,
): number | null {
    const t = scale.t(px);
    const segment = segments.find((s) => t > s.t0 && t < s.t1);
    if (!segment) return null;
    return Math.abs(scale.y(channelValueAt(points, channel, t, base)) - py) <= tolerance ? segment.index : null;
}

/** Bezier handle positions (graph px) inside the segment's box; null for a flat segment (no visible effect). */
export function bezierHandlePositions(segment: GraphSegment, scale: GraphScale): [[number, number], [number, number]] | null {
    if (segment.v0 === segment.v1) return null;
    const [x1, y1, x2, y2] = segment.bezier ?? normalizeBezier(null);
    const at = (bx: number, by: number): [number, number] => [scale.x(segment.t0 + bx * (segment.t1 - segment.t0)), scale.y(segment.v0 + by * (segment.v1 - segment.v0))];
    return [at(x1, y1), at(x2, y2)];
}

/** A dragged handle (graph px) as new bezier numbers: x clamped to [0, 1], y to [-1, 2], two decimals. */
export function bezierFromPointer(segment: GraphSegment, scale: GraphScale, which: 0 | 1, px: number, py: number, current: BezierHandles): BezierHandles {
    const r = (v: number) => Math.round(v * 100) / 100;
    const bx = r((scale.t(px) - segment.t0) / (segment.t1 - segment.t0));
    const dv = segment.v1 - segment.v0;
    const by = r(dv === 0 ? 0 : (scale.v(py) - segment.v0) / dv);
    const next = which === 0 ? [bx, by, current[2], current[3]] : [current[0], current[1], bx, by];
    return normalizeBezier(next);
}

export interface DragOptions {
    duration: number;
    /** Playhead in item seconds (null outside the item). */
    playhead: number | null;
    format: ChannelFormat;
    /** Shift: keep only the larger of the two movements. */
    shift: boolean;
}

/** Where a point dragged by (dx, dy) px from `origin` lands: time on the 30 fps grid or the playhead, value clamped. */
export function dragTarget(origin: { time: number; value: number }, delta: { dx: number; dy: number }, scale: GraphScale, options: DragOptions): { time: number; value: number } {
    const lockValue = options.shift && Math.abs(delta.dx) >= Math.abs(delta.dy);
    const lockTime = options.shift && !lockValue;
    const pxPerSecond = (scale.right - scale.left) / scale.duration;
    const time = lockTime || delta.dx === 0 ? origin.time : snapKeyframeTime(origin.time + delta.dx / pxPerSecond, {
        duration: options.duration, localPlayhead: options.playhead, zoom: pxPerSecond, snapEnabled: true,
    }).time;
    const pxPerUnit = (scale.bottom - scale.top) / (scale.hi - scale.lo || 1);
    const precision = options.format.step / 100;
    if (lockValue || delta.dy === 0) return { time, value: origin.value };
    const value = Math.round(clampToFormat(origin.value - delta.dy / pxPerUnit, options.format) / precision) * precision;
    return { time, value: Number(value.toPrecision(12)) };
}
