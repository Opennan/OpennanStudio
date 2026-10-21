// Speed planning shared by speed.set (controller) and the legacy speed helpers (lib/timeline-editing-navigation):
// one rule for lengths, keyframe times, and pushed clips. Kept free of controller and scene imports so the
// editing helpers can use it without an import cycle.
import type { TimelineClip } from "../model/timeline";
import type { TimelineClipUpdate } from "../backend/types";
import { parseTimelineKeyframes, type TimelineKeyframePoint } from "../lib/timeline-editing-properties";
import { roundTimelineTime } from "../lib/timeline-editing-shared";
import {
    MAX_SPEED, MIN_SPEED, clipSpeedProfile, meanCurveSpeed, parseSpeedCurve, rescaleTimes, serializeSpeedCurve, sourceSpan, timelineDuration,
    type SpeedProfile,
} from "../motion/speed";

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Plan<T> => ({ ok: true, value });
export const fail = <T>(error: string): Plan<T> => ({ ok: false, error });

export interface SpeedRequest {
    speed?: number;
    curve?: { id: string; points: Array<[number, number]> } | null;
    preservePitch?: boolean;
}

export function nextProfile(current: SpeedProfile, request: SpeedRequest): Plan<SpeedProfile> {
    let speed = current.speed;
    if (request.speed !== undefined) {
        if (!Number.isFinite(request.speed)) return fail("speed must be a number");
        speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, request.speed));
    }
    let curve = current.curve;
    if (request.curve !== undefined) {
        if (request.curve === null) curve = null;
        else {
            const parsed = parseSpeedCurve(request.curve);
            if (!parsed) return fail("the speed curve needs 2 to 10 points [x, y] with x from 0 to 1");
            curve = parsed;
        }
    }
    return ok({ speed, curve, preservePitch: request.preservePitch ?? current.preservePitch });
}

/** Shortest length speed.set makes: a faster request is clamped to the speed that gives this length. */
export const MIN_SPEED_LENGTH = 0.05;
/** Speed-derived times keep microseconds: ms rounding at high speeds would leak source span on every edit. */
export const roundSpeedTime = (t: number) => Math.round(t * 1e6) / 1e6;
const roundSpeedValue = (s: number) => Math.round(s * 10000) / 10000;

/**
 * The profile as it is stored (speed rounded to 4 decimals), slowed down when needed so `span` source
 * seconds last at least MIN_SPEED_LENGTH: the source span itself is never changed.
 */
export function storedProfile(profile: SpeedProfile, span: number): SpeedProfile {
    const mean = meanCurveSpeed(profile.curve);
    let speed = roundSpeedValue(profile.speed);
    if (span > 0 && span / (speed * mean) < MIN_SPEED_LENGTH) {
        speed = Math.max(MIN_SPEED, Math.floor((span / (MIN_SPEED_LENGTH * mean)) * 10000) / 10000);
    }
    return { ...profile, speed };
}

/**
 * Keyframe times follow the source moment they were set on when the speed changes. Keyframe times are
 * stored and read in milliseconds (parseTimelineKeyframes), so distinct keyframes are kept at least 1 ms
 * apart: a very fast clip never merges two of them (while the length leaves room for it).
 */
export function rescaleKeyframes(json: string | null | undefined, p0: SpeedProfile, d0: number, p1: SpeedProfile, d1: number): string | null | undefined {
    const points = parseTimelineKeyframes(json);
    if (points.length === 0) return undefined;
    const sorted = points.slice().sort((a, b) => a.time - b.time);
    const times = sorted.map((point) => roundTimelineTime(Math.min(d1, Math.max(0, rescaleTimes(p0, d0, p1, d1, point.time)))));
    const distinct = (i: number) => sorted[i].time > sorted[i - 1].time;
    for (let i = 1; i < times.length; i += 1) {
        if (distinct(i) && times[i] < times[i - 1] + 0.001) times[i] = roundTimelineTime(times[i - 1] + 0.001);
    }
    for (let i = times.length - 1; i >= 0; i -= 1) {
        const limit = i === times.length - 1 ? d1 : distinct(i + 1) ? times[i + 1] - 0.001 : times[i + 1];
        if (times[i] > limit) times[i] = Math.max(0, roundTimelineTime(Math.floor(limit * 1000 + 1e-6) / 1000));
    }
    return JSON.stringify({ keyframes: sorted.map((point, i) => ({ ...point, time: times[i] }) as TimelineKeyframePoint) });
}

export function speedFields(profile: SpeedProfile): { playbackSpeed: number; speedCurveJson: string | null; preservePitch: boolean } {
    return {
        playbackSpeed: roundSpeedValue(profile.speed),
        speedCurveJson: serializeSpeedCurve(profile.curve),
        preservePitch: profile.preservePitch,
    };
}

/** The clip fields the speed planner reads (timeline clips, or the lighter editing-helper rows). */
export type SpeedClip = Pick<TimelineClip, "id" | "startTime" | "endTime"> & Partial<Pick<TimelineClip,
    "trackType" | "trackIndex" | "playbackSpeed" | "speedRamp" | "speedCurveJson" | "preservePitch" | "keyframesJson">>;

export const samePlace = (a: { startTime: number; endTime: number }, b: { startTime: number; endTime: number }) => (
    Math.abs(a.startTime - b.startTime) < 1e-9 && Math.abs(a.endTime - b.endTime) < 1e-9
);

/**
 * speed.set on one clip of `clips`: its own update and where the clips after it on its track go. The clip
 * keeps its source span exactly, so its length becomes span / (speed · mean curve speed); a legacy ramp
 * becomes its curve. Later clips on the same track that the longer clip would overlap move right by the
 * overlap (a shorter clip leaves a gap, as CapCut does off the main track).
 */
function planOneClipSpeed(clips: SpeedClip[], clip: SpeedClip, request: SpeedRequest): Plan<{ own: TimelineClipUpdate; moved: Map<string, { startTime: number; endTime: number }> }> {
    const p0 = clipSpeedProfile(clip);
    const next = nextProfile(p0, request);
    if (!next.ok) return next;
    const d0 = Math.max(0, clip.endTime - clip.startTime);
    const span = sourceSpan(p0, d0);
    const p1 = storedProfile(next.value, span);
    const endTime = span > 0 ? roundSpeedTime(clip.startTime + timelineDuration(p1, span)) : clip.endTime;
    const keyframesJson = rescaleKeyframes(clip.keyframesJson, p0, d0, p1, endTime - clip.startTime);
    const own: TimelineClipUpdate = {
        clipId: clip.id,
        startTime: clip.startTime,
        endTime,
        ...speedFields(p1),
        speedRamp: "none",
        ...(keyframesJson !== undefined ? { keyframesJson } : {}),
    };
    const moved = new Map<string, { startTime: number; endTime: number }>();
    const later = clips
        .filter((c) => c.id !== clip.id && c.trackType === clip.trackType && c.trackIndex === clip.trackIndex && c.startTime >= clip.endTime - 0.001)
        .sort((a, b) => a.startTime - b.startTime);
    const overlap = later.length > 0 ? endTime - later[0].startTime : 0;
    if (overlap > 0.0005) {
        for (const c of later) moved.set(c.id, { startTime: roundSpeedTime(c.startTime + overlap), endTime: roundSpeedTime(c.endTime + overlap) });
    }
    return ok({ own, moved });
}

/**
 * speed.set on clips (one or several, one undo step), planned from `clips` — the timeline before the edit
 * or, during a slider gesture, before the gesture's first step, so every step is the whole gesture's edit and
 * nothing compounds. `current` is the timeline as shown now: any clip whose place differs between the plan and
 * either state is written, so the persisted write always equals the final local state (a later clip a slower
 * step pushed and a faster one released goes back on both sides).
 */
export function planClipSpeed(clips: SpeedClip[], clipIds: string | readonly string[], request: SpeedRequest, current: SpeedClip[] = clips): Plan<TimelineClipUpdate[]> {
    const ids = typeof clipIds === "string" ? [clipIds] : [...new Set(clipIds)];
    if (ids.length === 0) return fail("no matching clips");
    let working = clips.slice();
    const own = new Map<string, TimelineClipUpdate>();
    for (const id of ids) {
        const clip = working.find((c) => c.id === id);
        if (!clip) return fail("no matching clips");
        const step = planOneClipSpeed(working, clip, request);
        if (!step.ok) return step;
        const { own: update, moved } = step.value;
        own.set(id, update);
        working = working.map((c) => {
            if (c.id === id) return { ...c, ...update };
            const place = moved.get(c.id);
            return place ? { ...c, ...place } : c;
        });
    }
    const before = new Map(clips.map((c) => [c.id, c]));
    const shown = new Map(current.map((c) => [c.id, c]));
    // The speed changes first, in the order asked, then the clips they move.
    const placed = new Map(working.map((c) => [c.id, c]));
    const updates: TimelineClipUpdate[] = ids.map((id) => {
        const clip = placed.get(id)!;
        return { ...own.get(id)!, startTime: clip.startTime, endTime: clip.endTime };
    });
    for (const clip of working) {
        if (own.has(clip.id)) continue;
        const was = before.get(clip.id)!;
        const now = shown.get(clip.id);
        if (!samePlace(was, clip) || (now && !samePlace(now, clip))) updates.push({ clipId: clip.id, startTime: clip.startTime, endTime: clip.endTime });
    }
    return ok(updates);
}
