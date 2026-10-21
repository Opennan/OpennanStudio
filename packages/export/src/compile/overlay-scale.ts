// Whether a clip moves, and the clip scale its bitmap is prepared at (phase 10b: the transform model,
// timeline-core motion/transform.ts, so animation scale peaks are covered too).
import type { TimelineClip } from "@opennan/timeline-core";
import { evaluateScalar } from "@opennan/timeline-core/looks/expr";
import { itemMotion, type ItemMotion } from "@opennan/timeline-core/motion/transform";
import type { MotionChannel } from "@opennan/timeline-core/motion/types";
import { DEFAULT_FPS } from "../presets";
import { clipScale, motionPreset } from "../clip-params";
import { motionScalePeak } from "../filters/video";
import { VISUAL_CHANNELS, channelValues, clipKeyframes, hasChannel } from "../keyframes";

export interface OverlayScale {
    /** Any motion channel varies over time (keyframes, animations, legacy fades or motion preset). */
    animated: boolean;
    /**
     * The scale the bitmap is prepared at: the static scale, or the largest scale any frame reaches, so
     * bitmaps are only ever scaled down. At least `layout`.
     */
    reference: number;
    /**
     * The scale text is laid out (wrapped) at: the 10a rule the preview's textLayoutScale shares (the static
     * scale, or for keyframed / motion-preset clips the largest keyframed or preset scale). Animation peaks
     * do not change the wrap: a larger reference draws the same layout at reference / layout resolution.
     */
    layout: number;
    /** Largest |scaleX| any frame reaches (1 without flip animations): the layer's pad holds it. */
    scaleXPeak: number;
}

/** Item-local frame times n / fps over the clip, both ends included. */
function frameTimes(duration: number, fps: number): number[] {
    const frames = Math.max(0, Math.round(duration * fps));
    return Array.from({ length: frames + 1 }, (_, n) => n / fps);
}

/** Largest value of a channel at the clip's frame times (the times every per-frame filter evaluates). */
export function channelPeak(motion: ItemMotion, channel: MotionChannel, fps: number, map: (value: number) => number = (x) => x): number {
    const e = motion.channels[channel];
    if (e.k === "num") return map(e.v);
    let peak = -Infinity;
    for (const t of frameTimes(motion.duration, fps)) {
        const value = map(evaluateScalar(e, t));
        if (Number.isFinite(value) && value > peak) peak = value;
    }
    return peak;
}

/**
 * The smallest reference a bitmap is prepared at. A scale reference also divides the per-frame scale
 * expressions, and fmt() writes values below about 5e-7 as "0": the clamp keeps that division finite (the
 * relative scale stays ≤ 1, so nothing changes for real scales).
 */
export const MIN_REFERENCE_SCALE = 0.001;

/**
 * True when the scale channel is 0 or less at some frame time: the preview draws nothing there, while a
 * per-frame scale filter keeps at least 1 pixel, so the layer must be hidden on those frames.
 */
export function reachesNonPositiveScale(motion: ItemMotion, fps: number): boolean {
    return -channelPeak(motion, "scale", fps, (x) => -x) <= 0;
}

/** The 10a reference: keyframed visual channels or a motion preset size the bitmap by the keyframed (or preset) peak. */
function layoutScale(clip: Pick<TimelineClip, "keyframesJson" | "motionPreset" | "scale">): number {
    const points = clipKeyframes(clip.keyframesJson);
    const preset = motionPreset(clip);
    const base = clipScale(clip);
    const keyed = VISUAL_CHANNELS.some((channel) => hasChannel(points, channel)) || preset !== "none";
    if (!keyed) return base;
    const reached = hasChannel(points, "scale") ? channelValues(points, "scale") : [base * motionScalePeak(preset)];
    return Math.max(base, ...reached.filter((value) => value > 0));
}

export function overlayScale(clip: TimelineClip, fps: number = DEFAULT_FPS): OverlayScale {
    const motion = itemMotion({ kind: "clip", clip });
    const layout = layoutScale(clip);
    const peak = channelPeak(motion, "scale", fps);
    const scaleXPeak = Math.max(1, channelPeak(motion, "scaleX", fps, Math.abs));
    return { animated: motion.animated, reference: Math.max(MIN_REFERENCE_SCALE, peak > layout ? peak : layout), layout, scaleXPeak };
}
