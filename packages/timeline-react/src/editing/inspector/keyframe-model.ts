// Pure keyframe helpers for the inspector (phase 10b): which state a property's diamond shows, the values a
// keyframe row reads at the playhead, and prev / next navigation. Times are item-local seconds.
import { channelValueAt, hasChannel, keyframeTimes, type KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import type { TimelineKeyframePoint } from "@opennan/timeline-core/lib/timeline-editing-properties";

/** One frame at 30 fps: a keyframe this close to the playhead counts as "under" it. */
export const KEYFRAME_FRAME = 1 / 30;

export type KeyframeState = "on" | "keyed" | "off";

/** A keyframed channel and the item's static value for it (channel units). */
export interface ChannelSpec {
    channel: string;
    base: number;
}

const META = new Set(["time", "easing", "bx1", "by1", "bx2", "by2"]);

const definesAny = (point: TimelineKeyframePoint, channels?: readonly string[]) =>
    Object.keys(point).some((key) => !META.has(key) && typeof point[key] === "number" && (!channels || channels.includes(key)));

/** The point closest to `t` within one frame that defines any of `channels` (any channel when omitted). */
export function nearKeyframe(points: KeyframePoints, t: number, channels?: readonly string[]): TimelineKeyframePoint | undefined {
    let best: TimelineKeyframePoint | undefined;
    let distance = Infinity;
    for (const point of points) {
        const d = Math.abs(point.time - t);
        if (d <= KEYFRAME_FRAME + 1e-9 && d < distance && definesAny(point, channels)) {
            best = point;
            distance = d;
        }
    }
    return best;
}

/** filled ("on") at a keyframe of the channels, outlined ("keyed") when keyed elsewhere, empty ("off") otherwise. */
export function keyframeState(points: KeyframePoints, channels: readonly string[], t: number | null): { state: KeyframeState; point?: TimelineKeyframePoint } {
    if (!channels.some((channel) => hasChannel(points, channel))) return { state: "off" };
    const point = t === null ? undefined : nearKeyframe(points, t, channels);
    return point ? { state: "on", point } : { state: "keyed" };
}

/** Current values of a group of channels at `t`: the keyframe curve where keyed, else the static value. */
export function groupValuesAt(points: KeyframePoints, specs: readonly ChannelSpec[], t: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { channel, base } of specs) out[channel] = hasChannel(points, channel) ? channelValueAt(points, channel, t, base) : base;
    return out;
}

/** The item's previous (-1) or next (+1) keyframe time from `t`, ignoring the keyframe under the playhead; null at the end. */
export function adjacentKeyframeTime(points: KeyframePoints, t: number, direction: -1 | 1): number | null {
    const times = keyframeTimes(points);
    if (direction > 0) return times.find((time) => time > t + KEYFRAME_FRAME) ?? null;
    for (let i = times.length - 1; i >= 0; i -= 1) if (times[i] < t - KEYFRAME_FRAME) return times[i];
    return null;
}

/** Playhead seconds as item-local time, or null when the playhead is outside the item. */
export function localTime(playhead: number, start: number, duration: number): number | null {
    const t = playhead - start;
    if (t < -1e-6 || t > duration + 1e-6) return null;
    return Math.min(duration, Math.max(0, t));
}
