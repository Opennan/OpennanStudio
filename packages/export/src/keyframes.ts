// Clip keyframes as values (for sizing) and as ffmpeg expressions (for animation). The curves, easing
// included, are timeline-core's motion/keyframes.ts: the preview evaluates the same expressions.
import { emitFfmpeg } from "@opennan/timeline-core/looks/expr";
import { parseTimelineKeyframes, type TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";
import {
    channelExpr, channelValueAt as motionChannelValueAt, hasChannel as motionHasChannel,
    type KeyframeChannel as MotionKeyframeChannel,
} from "@opennan/timeline-core/motion/keyframes";

/** Transform, volume, filter intensity, and `adj_<key>` Adjust channels (motion/keyframes.ts KEYFRAME_CHANNELS). */
export type KeyframeChannel = MotionKeyframeChannel;
export type KeyframePoints = TimelineKeyframePoint[];

export const VISUAL_CHANNELS: readonly KeyframeChannel[] = ["scale", "opacity", "position_x", "position_y", "rotation_degrees"];

/** Parsed points sorted by time (timeline-editing-properties.ts parseTimelineKeyframes). */
export function clipKeyframes(keyframesJson: string | null | undefined): KeyframePoints {
    return parseTimelineKeyframes(keyframesJson).sort((a, b) => a.time - b.time);
}

export function hasChannel(points: KeyframePoints, channel: KeyframeChannel): boolean {
    return motionHasChannel(points, channel);
}

export function channelValues(points: KeyframePoints, channel: KeyframeChannel): number[] {
    return points
        .filter((point) => typeof point[channel] === "number")
        .sort((a, b) => a.time - b.time)
        .map((point) => point[channel]);
}

/** Channel value at clip-local `time`, with the points' easing (the preview's rule, motion/keyframes.ts). */
export function channelValueAt(points: KeyframePoints, channel: KeyframeChannel, time: number, fallback: number): number {
    return motionChannelValueAt(points, channel, time, fallback);
}

/**
 * The channel as a per-frame ffmpeg expression of `timeVar`, holding the first value before the first
 * point and the last value after the last point: motion/keyframes.ts channelExpr through the scalar target
 * (no st/ld state), so it evaluates exactly like channelValueAt.
 */
export function keyframeExpression(points: KeyframePoints, channel: KeyframeChannel, fallback: number, timeVar = "t"): string {
    return emitFfmpeg(channelExpr(points, channel, fallback), { target: "scalar", time: timeVar });
}
