// Adjust keyframes (phase 10b): a clip or scene whose keyframes carry `adj_*` or `filter_intensity`
// channels is graded by a cross-fade between the CLUTs of its look keyframes, with the easing of the
// earlier point: out = trunc(LUT_k(x) + (LUT_k+1(x) − LUT_k(x))·w), the eased weight w quantized to
// k / 1024 (the 8-bit store of ffmpeg's blend all_expr, and the preview's LookRenderer.lutMix). The look
// of keyframe k is the item's look with every keyframed Adjust channel (and filter intensity) replaced by
// that channel's own curve value at t_k; a neutral keyframe is the identity CLUT. Sharpen, vignette,
// grain, and effects are not keyframable and run after the mix.
//
// Both backends use this module: the preview mixes the two CLUTs around the time (lookKeyframeMix); the
// export runs every keyframe's CLUT and blends them in sequence, acc_k = mix(acc_k−1, LUT_k, s_k(T)), with
// s_k the segment weight below (0 before the segment, eased inside, 1 after). Weight 0 keeps A and
// weight 1 gives B exactly on integer levels, so the sequence equals the two-CLUT mix at every time.
import { easeExpr, easeValue } from "./easing";
import { ADJUST_KEYFRAME_CHANNELS, channelValueAt, pointEasing, type KeyframePoints } from "./keyframes";
import { div, sub, v, type Expr } from "../looks/expr";
import { itemAdjustments, legacyClipFields, serializeAdjustments, POINTWISE_ADJUSTMENTS, type AdjustmentKey } from "../looks/adjust";
import { itemFilterIntensity, itemLook, type LookPlan, type LookSource, type LookStep } from "../looks/look-plan";
import type { TimelineKeyframePoint } from "../lib/timeline-editing-properties";

/** One CLUT of a look (a plan's `lut` step). */
export type LutStep = Extract<LookStep, { kind: "lut" }>;

/** The channels a look keyframe carries (motion/keyframes.ts). */
export const LOOK_KEYFRAME_CHANNELS: readonly string[] = [...ADJUST_KEYFRAME_CHANNELS, "filter_intensity"];

/** Key of the identity CLUT (a neutral keyframe; the same key itemLook would give a neutral look). */
export const IDENTITY_LUT_KEY = "flt:none@0|adj:";

const IDENTITY_LUT: LutStep = { kind: "lut", key: IDENTITY_LUT_KEY, fn: (c) => [c[0], c[1], c[2]] };

/** Most look keyframes the export blends (one CLUT input, haldclut, and blend each); later ones are dropped with a warning. */
export const LOOK_KEYFRAME_LIMIT = 8;

/** Weight steps of the cross-fade: both backends quantize the eased weight to k / 1024. */
export const LOOK_MIX_WEIGHT_STEPS = 1024;

const definesLookChannel = (point: TimelineKeyframePoint) => LOOK_KEYFRAME_CHANNELS.some((channel) => typeof point[channel] === "number" && Number.isFinite(point[channel]));

/** The filter + pointwise-adjust CLUT of a plan (itemLook puts it first; effect CLUTs are keyed `fx:`). */
export const isAdjustLut = (step: LookStep): step is LutStep => step.kind === "lut" && step.key.startsWith("flt:");

/** Sorted distinct times of the points that carry a look channel. */
export function lookKeyframeTimes(points: KeyframePoints): number[] {
    const times = points.filter(definesLookChannel).map((point) => point.time).sort((a, b) => a - b);
    return times.filter((time, i) => i === 0 || time !== times[i - 1]);
}

/** The look-carrying point at `time` (its easing shapes the segment that starts there). */
function lookPointAt(points: KeyframePoints, time: number): TimelineKeyframePoint {
    return points.find((point) => point.time === time && definesLookChannel(point))!;
}

/**
 * The keyframes around item-local `t` and the eased weight toward the later one (null without look
 * keyframes). Before the first keyframe and after the last, both are that keyframe. Segments cover
 * (t_k, t_k+1] as channelValueAt does; the easing is the one of the point at t_k.
 */
export function lookKeyframeMix(points: KeyframePoints, t: number): { from: number; to: number; w: number } | null {
    const times = lookKeyframeTimes(points);
    if (times.length === 0) return null;
    const first = times[0];
    const last = times[times.length - 1];
    if (t <= first) return { from: first, to: first, w: 0 };
    if (t >= last) return { from: last, to: last, w: 0 };
    let k = 0;
    while (k < times.length - 2 && t > times[k + 1]) k += 1;
    const from = times[k];
    const to = times[k + 1];
    const { id, bezier } = pointEasing(lookPointAt(points, from));
    return { from, to, w: easeValue(id, (t - from) / (to - from), bezier) };
}

/**
 * The weight with which keyframe k (k ≥ 1 of `times`) is blended over the result of keyframes 0..k−1, as
 * an expression of the item-local time T: easing_k−1((T − t_k−1) / (t_k − t_k−1)). Every easing is 0 at
 * progress ≤ 0 and 1 at progress ≥ 1 (easeExpr clamps), so the weight is 0 before the segment and 1 after.
 * Inside the segment it is the very value lookKeyframeMix computes (the same operations in the same order).
 */
export function lookSegmentWeight(points: KeyframePoints, times: readonly number[], k: number): Expr {
    const from = times[k - 1];
    const to = times[k];
    const { id, bezier } = pointEasing(lookPointAt(points, from));
    // (to − from) stays an expression: ffmpeg then computes it from the two written times exactly as JS does,
    // where a precomputed constant would be written rounded (1.6 − 1.37 is 0.22999999999999998, written
    // "0.23"), and a hold would switch a frame late on its own keyframe.
    return easeExpr(id, div(sub(v("T"), from), sub(to, from)), bezier);
}

/**
 * The cross-fade weight as both backends use it: clamp to [0, 1], round to k / 1024. With k / 1024 every
 * A + (B − A)·w on 8-bit levels is exact in float32 and in double, so the truncating store agrees bit for bit.
 * (timeline-media's lutMixWeight is the same rule; the export's parity tests check both.)
 */
export function lookMixWeight(weight: number): number {
    const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
    return Math.round(w * LOOK_MIX_WEIGHT_STEPS) / LOOK_MIX_WEIGHT_STEPS;
}

/** The mixed 8-bit level: trunc(A + (B − A)·w), as blend all_expr stores a double into a uint8 plane. */
export function lookMixLevel(a: number, b: number, weight: number): number {
    return Math.floor(a + (b - a) * lookMixWeight(weight));
}

/** The item with every keyframed look channel set to its curve value at `time` (the look of that keyframe). */
export function keyframeLookSource(item: LookSource, points: KeyframePoints, time: number): LookSource {
    const kind = item.kind;
    const adjust = itemAdjustments(item, kind);
    for (const key of POINTWISE_ADJUSTMENTS) adjust[key as AdjustmentKey] = channelValueAt(points, `adj_${key}`, time, adjust[key as AdjustmentKey]);
    const filterIntensity = Math.min(1, Math.max(0, channelValueAt(points, "filter_intensity", time, itemFilterIntensity(item))));
    const out: LookSource = { ...item, adjustmentsJson: serializeAdjustments(adjust), filterIntensity };
    // Clips keep brightness / contrast / saturation in their own fields (itemAdjustments reads them first).
    return kind === "clip" ? { ...out, ...legacyClipFields(adjust) } : out;
}

/** The adjust CLUT of the keyframe at `time` (identity when that look is neutral). */
export function keyframeLut(item: LookSource, points: KeyframePoints, time: number): LutStep {
    const plan = itemLook({ ...keyframeLookSource(item, points, time), effects: null });
    return plan?.steps.find(isAdjustLut) ?? IDENTITY_LUT;
}

/** The look's steps that run after the keyframed CLUT (spatial steps, effects), or null when there are none. */
export function lookAfterKeyframes(full: LookPlan | null): LookPlan | null {
    const steps = (full?.steps ?? []).filter((step) => !isAdjustLut(step));
    return full && (steps.length > 0 || full.unknownEffects.length > 0) ? { ...full, steps } : null;
}

export interface KeyframedLook {
    /** The look's steps after the keyframed CLUT, or null. */
    rest: LookPlan | null;
    /** Look keyframe times (at most LOOK_KEYFRAME_LIMIT) and one CLUT per time. */
    times: number[];
    luts: LutStep[];
    /** Look keyframes beyond the limit (the export holds the last kept keyframe's look after it). */
    dropped: number;
}

/** The export's keyframed look of an item, or null without look keyframes (then itemLook applies as before). */
export function keyframedLook(item: LookSource, points: KeyframePoints, limit = LOOK_KEYFRAME_LIMIT): KeyframedLook | null {
    const all = lookKeyframeTimes(points);
    if (all.length === 0) return null;
    const times = all.slice(0, Math.max(1, limit));
    return {
        rest: lookAfterKeyframes(itemLook(item)),
        times,
        luts: times.map((time) => keyframeLut(item, points, time)),
        dropped: all.length - times.length,
    };
}
