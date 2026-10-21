import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { optimisticTimelineClipFromInput } from "../lib/timeline-optimistic";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { channelValueAt } from "../motion/keyframes";
import {
    decimateTrack, frameAspect, planTrackingApply, planTrackingFrames, resolveTrackedItem, sourceToFrame, trackedMediaTime,
    type TrackedItem, type TrackingState,
} from "./plan";
import type { TrackSample } from "./tracker";

const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "p", id);
const track = (type: TimelineTrack["type"], index: number, patch: Partial<TimelineTrack> = {}): TimelineTrack => ({
    type, index, label: `${type}${index}`, muted: false, locked: false, visible: true, volume: 1, ...patch,
});
const scene = (id: string, fields: Partial<SceneData>): SceneData => ({
    id, order: 0, caption: "", startTime: "00:00:00", endTime: "00:00:00", startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready",
    transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, shotBreakdown: "[]", trackIndex: 1, ...fields,
} as SceneData);

const VIDEO = clip("v", { trackType: "video", trackIndex: 2, startTime: 2, endTime: 12, mediaUrl: "https://m.test/a.mp4", mediaType: "video" });
const TEXT = clip("t", { trackType: "text", trackIndex: 1, startTime: 3, endTime: 8, textContent: "Hi", positionX: 0.5, positionY: 0.5 });
const GFX = clip("g", { trackType: "remotion", trackIndex: 1, startTime: 2, endTime: 12, remotionTemplateId: "lower-third", positionX: 0.5, positionY: 0.5 });
const FX = clip("fx", { trackType: "effect", trackIndex: 1, startTime: 2, endTime: 12, mediaType: "effect" });
const AUDIO = clip("a", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 20, mediaUrl: "https://m.test/a.mp3" });

function state(patch: Partial<TrackingState> = {}): TrackingState {
    return {
        clips: [VIDEO, TEXT, GFX, FX, AUDIO],
        scenes: [scene("s1", { duration: 20, cardType: "source_clip", videoUrl: "https://m.test/s.mp4" })],
        tracks: [track("video", 1), track("video", 2), track("text", 1), track("remotion", 1), track("effect", 1), track("audio", 1)],
        aspectRatio: "16:9",
        ...patch,
    };
}

const item = (s: TrackingState, owner: { clipId?: string; sceneId?: string }): TrackedItem => {
    const resolved = resolveTrackedItem(s, owner);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
};

/** Samples every 1/15 s over the tracked clip's local span [from, to] with x(t), y(t) in source fractions. */
function samples(from: number, to: number, x: (t: number) => number, y: (t: number) => number): TrackSample[] {
    const out: TrackSample[] = [];
    for (let t = from; t <= to + 1e-9; t += 1 / 15) out.push({ time: Math.round(t * 1000) / 1000, x: x(t), y: y(t), confidence: 1, lost: false });
    return out;
}

const SOURCE = { width: 1920, height: 1080 };

describe("tracked items and media time", () => {
    it("accepts video clips and main-track scenes with one video, and refuses the rest", () => {
        const s = state({
            clips: [
                VIDEO,
                clip("img", { trackType: "video", trackIndex: 3, startTime: 0, endTime: 5, mediaUrl: "https://m.test/a.png", mediaType: "image" }),
                clip("frozen", { trackType: "video", trackIndex: 4, startTime: 0, endTime: 5, mediaUrl: "https://m.test/b.mp4", freezeFrame: true }),
                AUDIO, TEXT,
            ],
            scenes: [
                scene("s1", { duration: 4, cardType: "source_clip", sourceVideoUrl: "https://m.test/src.mp4" }),
                scene("s2", { duration: 6, cardType: "ai_video", shotBreakdown: JSON.stringify([{ video_url: "https://m.test/1.mp4", duration: 3 }]) }),
            ],
        });
        expect(resolveTrackedItem(s, { clipId: "v" })).toMatchObject({ ok: true, value: { start: 2, duration: 10, mediaUrl: "https://m.test/a.mp4" } });
        expect(resolveTrackedItem(s, { sceneId: "s1" })).toMatchObject({ ok: true, value: { start: 0, duration: 4, mediaUrl: "https://m.test/src.mp4" } });
        expect(resolveTrackedItem(s, { clipId: "img" })).toMatchObject({ ok: false, error: expect.stringMatching(/only video clips/) });
        expect(resolveTrackedItem(s, { clipId: "a" })).toMatchObject({ ok: false });
        expect(resolveTrackedItem(s, { clipId: "t" })).toMatchObject({ ok: false });
        expect(resolveTrackedItem(s, { clipId: "frozen" })).toMatchObject({ ok: false, error: expect.stringMatching(/frozen/) });
        expect(resolveTrackedItem(s, { sceneId: "s2" })).toMatchObject({ ok: false, error: expect.stringMatching(/no single video/) });
        expect(resolveTrackedItem(s, { clipId: "nope" })).toMatchObject({ ok: false });
    });

    it("maps item-local time to media time with speed, reverse, and trims as the preview plays them", () => {
        const at = (patch: Record<string, unknown>, t: number) => trackedMediaTime(item(state({ clips: [clip("c", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 10, mediaUrl: "https://m.test/a.mp4", ...patch })] }), { clipId: "c" }), t);
        expect(at({}, 3)).toBe(3);
        expect(at({ playbackSpeed: 2 }, 3)).toBe(6);
        expect(at({ reversePlayback: true }, 3)).toBe(7);
        expect(at({ reversePlayback: true, playbackSpeed: 2 }, 3)).toBe(14);
        // Every clip plays from its trimStart (V2+ overlays in the preview and both exports, as V1 clips).
        expect(at({ trimStart: 4 }, 1)).toBe(5);
        expect(at({ trimStart: 4, trackIndex: 1 }, 1)).toBe(5);
        expect(at({ trimStart: 4, reversePlayback: true }, 3)).toBe(11);
        const sc = item(state({ scenes: [scene("s", { duration: 6, videoUrl: "https://m.test/s.mp4", cardConfig: JSON.stringify({ trimStart: 2, trimEnd: 8 }) })] }), { sceneId: "s" });
        expect(trackedMediaTime(sc, 1.5)).toBe(3.5);
    });
});

describe("planTrackingFrames", () => {
    const region = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
    it("steps outwards from the drawn frame at 15 fps over a long item", () => {
        const plan = planTrackingFrames(item(state(), { clipId: "v" }), { region, time: 4 });
        if (!plan.ok) throw new Error(plan.error);
        expect(plan.value.fps).toBe(15);
        const times = plan.value.frames.map((f) => f.time);
        expect(times[0]).toBe(0);
        expect(times[plan.value.startIndex]).toBe(4);
        // 0..9.933 every 1/15 s, plus the last decodable instant.
        expect(times.length).toBe(151);
        expect(times[times.length - 1]).toBe(9.999);
        expect(plan.value.frames[plan.value.startIndex].media).toBe(4);
        for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThan(times[i - 1]);
    });
    it("uses 30 fps for short spans and honours a range", () => {
        const plan = planTrackingFrames(item(state(), { clipId: "v" }), { region, time: 3, range: { start: 2, end: 5 } });
        if (!plan.ok) throw new Error(plan.error);
        expect(plan.value.fps).toBe(30);
        expect(plan.value.frames[0].time).toBe(2);
        expect(plan.value.frames[plan.value.frames.length - 1].time).toBe(5);
        expect(plan.value.frames).toHaveLength(91);
    });
    it("adds the span's first and last instants when the steps miss them", () => {
        const plan = planTrackingFrames(item(state(), { clipId: "v" }), { region, time: 0.02, range: { start: 0, end: 1 } });
        if (!plan.ok) throw new Error(plan.error);
        const times = plan.value.frames.map((f) => f.time);
        expect(times.slice(0, 3)).toEqual([0, 0.02, 0.053]);
        expect(times[times.length - 1]).toBe(1);
        expect(plan.value.startIndex).toBe(1);
    });

    it("refuses bad regions, times outside the range, and empty ranges", () => {
        const it2 = item(state(), { clipId: "v" });
        expect(planTrackingFrames(it2, { region: { x: 0.9, y: 0.1, width: 0.2, height: 0.1 }, time: 1 })).toMatchObject({ ok: false });
        expect(planTrackingFrames(it2, { region, time: 11 })).toMatchObject({ ok: false });
        expect(planTrackingFrames(it2, { region, time: 1, range: { start: 3, end: 3 } })).toMatchObject({ ok: false });
    });
});

describe("sourceToFrame", () => {
    const at = (patch: Record<string, unknown>, point: { x: number; y: number }, source = SOURCE, aspect = 16 / 9) => sourceToFrame(
        item(state({ clips: [clip("c", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 10, mediaUrl: "https://m.test/a.mp4", ...patch })] }), { clipId: "c" }),
        1, point, source, aspect,
    );
    it("places a full-frame clip one to one and a smaller clip by its free space", () => {
        const full = at({}, { x: 0.25, y: 0.75 });
        expect(full.x).toBeCloseTo(0.25, 9);
        expect(full.y).toBeCloseTo(0.75, 9);
        // 960×540 on the 1920×1080 reference: half the frame, at the left edge.
        const small = at({ positionX: 0, positionY: 1 }, { x: 0.5, y: 0.5 }, { width: 960, height: 540 });
        expect(small.x).toBeCloseTo(0.25, 9);
        expect(small.y).toBeCloseTo(0.75, 9);
        const scaled = at({ scale: 0.5 }, { x: 1, y: 0 });
        expect(scaled.x).toBeCloseTo(0.75, 9);
        expect(scaled.y).toBeCloseTo(0.25, 9);
    });
    it("applies flips and rotation (in pixels, not fractions)", () => {
        const flipped = at({ horizontalFlip: true }, { x: 0.25, y: 0.5 });
        expect(flipped.x).toBeCloseTo(0.75, 9);
        // A quarter turn clockwise: the right edge's middle goes to the bottom, at half the frame width in height units.
        const turned = at({ scale: 0.5, rotationDegrees: 90 }, { x: 1, y: 0.5 });
        expect(turned.x).toBeCloseTo(0.5, 9);
        expect(turned.y).toBeCloseTo(0.5 + (0.25 * 16) / 9, 9);
    });
    it("places a main-track scene with its fit mode", () => {
        const s = state({ scenes: [scene("s", { duration: 5, videoUrl: "https://m.test/s.mp4", fitMode: "contain" })] });
        // A 4:3 source contained in 16:9: pillarboxed, its width is 0.75 of the frame.
        const point = sourceToFrame(item(s, { sceneId: "s" }), 0, { x: 0, y: 0.5 }, { width: 1440, height: 1080 }, 16 / 9);
        expect(point.x).toBeCloseTo(0.125, 9);
        expect(point.y).toBeCloseTo(0.5, 9);
    });
});

describe("planTrackingApply", () => {
    // The tracked clip "v" covers timeline 2-12; the point moves right by 0.1 of the frame over its local 0-4 s.
    const linear = samples(0, 4, (t) => 0.4 + 0.025 * t, () => 0.5);
    const kf = (c: { keyframesJson?: string | null } | undefined) => parseTimelineKeyframes(c?.keyframesJson ?? null);

    it("moves a text clip with the point from its own position, in its local time, clamped to its span", () => {
        const plan = planTrackingApply(state(), { clipId: "v" }, { samples: linear, source: SOURCE, followers: [{ clipId: "t", anchor: { width: 0.2, height: 0.1 } }] });
        if (!plan.ok) throw new Error(plan.error);
        expect(plan.value.report).toEqual({ applied: [{ clipId: "t", keyframes: 2 }], skipped: [] });
        const update = plan.value.clipUpdates[0];
        expect(update.clipId).toBe("t");
        const points = kf(update);
        // The text starts at timeline 3 (tracked local 1): it keeps 0.5 there and moves until the track ends (local 3).
        expect(points.map((p) => p.time)).toEqual([0, 3]);
        expect(points[0].position_x).toBeCloseTo(0.5, 9);
        // 0.075 of the frame over a free space of 0.8: Δpos = 0.09375.
        expect(points[1].position_x).toBeCloseTo(0.5 + 0.075 / 0.8, 3);
        expect(points[1].position_y).toBeCloseTo(0.5, 9);
    });

    it("moves graphics layers linearly and marks unknown text boxes as approximate", () => {
        const plan = planTrackingApply(state(), { clipId: "v" }, { samples: linear, source: SOURCE, followers: [{ clipId: "g" }, { clipId: "t" }] });
        if (!plan.ok) throw new Error(plan.error);
        expect(plan.value.report.applied).toEqual([{ clipId: "g", keyframes: 2 }, { clipId: "t", keyframes: 2, approximate: true }]);
        const g = kf(plan.value.clipUpdates.find((u) => u.clipId === "g"));
        expect(g.map((p) => p.time)).toEqual([0, 4]);
        expect(g[1].position_x).toBeCloseTo(0.6, 9);
        const t = kf(plan.value.clipUpdates.find((u) => u.clipId === "t"));
        expect(t[1].position_x).toBeCloseTo(0.575, 9);
    });

    it("uses the host's anchors when the request has none", () => {
        const asked: string[][] = [];
        const plan = planTrackingApply(state(), { clipId: "v" }, { samples: linear, source: SOURCE, followers: [{ clipId: "t" }] }, (ids) => {
            asked.push(ids);
            return { t: { width: 0.5, height: 0.1 } };
        });
        if (!plan.ok) throw new Error(plan.error);
        expect(asked).toEqual([["t"]]);
        expect(kf(plan.value.clipUpdates[0])[1].position_x).toBeCloseTo(0.5 + 0.075 / 0.5, 3);
        expect(plan.value.report.applied[0].approximate).toBeUndefined();
    });

    it("keeps keyframes outside the tracked span and replaces position keyframes inside it", () => {
        const keyed = { ...GFX, keyframesJson: JSON.stringify({ keyframes: [{ time: 1, position_x: 0.2, opacity: 0.5 }, { time: 6, position_x: 0.9 }] }) };
        const plan = planTrackingApply(state({ clips: [VIDEO, keyed] }), { clipId: "v" }, { samples: samples(0, 4, (t) => 0.4 + 0.025 * t, () => 0.5), source: SOURCE, followers: [{ clipId: "g" }] });
        if (!plan.ok) throw new Error(plan.error);
        const points = kf(plan.value.clipUpdates[0]);
        // Opacity at 1 s stays (its position_x goes), the keyframe at 6 s is outside the span and stays.
        expect(points.find((p) => p.time === 1)).toEqual({ time: 1, opacity: 0.5 });
        expect(points.find((p) => p.time === 6)).toEqual({ time: 6, position_x: 0.9 });
        // The reference is the keyed position at the track start (local 0: 0.2, held before the first keyframe).
        expect(channelValueAt(points, "position_x", 0, 0)).toBeCloseTo(0.2, 9);
        expect(channelValueAt(points, "position_x", 4, 0)).toBeCloseTo(0.3, 9);
    });

    it("writes the tracked item's mask keyframes in its own source space", () => {
        const masked = { ...VIDEO, maskJson: JSON.stringify({ shape: "circle", x: 0.3, y: 0.6, width: 0.2, height: 0.2 }) };
        const plan = planTrackingApply(state({ clips: [masked, TEXT] }), { clipId: "v" }, {
            samples: samples(0, 2, (t) => 0.4 + 0.05 * t, (t) => 0.5 - 0.05 * t), source: SOURCE, followers: [{ mask: true }],
        });
        if (!plan.ok) throw new Error(plan.error);
        expect(plan.value.report.applied).toEqual([{ mask: true, keyframes: 2 }]);
        const points = kf(plan.value.clipUpdates[0]);
        expect(points[0]).toMatchObject({ time: 0, mask_x: 0.3, mask_y: 0.6 });
        expect(points[1].mask_x).toBeCloseTo(0.4, 6);
        expect(points[1].mask_y).toBeCloseTo(0.5, 6);
    });

    it("moves a main-track scene follower by its offsets in percent", () => {
        const plan = planTrackingApply(state(), { clipId: "v" }, { samples: linear, source: SOURCE, followers: [{ sceneId: "s1" }] });
        if (!plan.ok) throw new Error(plan.error);
        const points = kf(plan.value.scenePatches[0].patch);
        expect(points.map((p) => p.time)).toEqual([2, 6]);
        expect(points[1].position_x).toBeCloseTo(10, 6);
    });

    it("skips what cannot follow and fails when nothing can", () => {
        const s = state({ tracks: [track("video", 2), track("text", 1, { locked: true }), track("remotion", 1), track("effect", 1), track("audio", 1)] });
        const late = clip("late", { trackType: "sticker", trackIndex: 1, startTime: 30, endTime: 32, stickerId: "heart" });
        const plan = planTrackingApply({ ...s, clips: [...s.clips, late] }, { clipId: "v" }, {
            samples: linear, source: SOURCE,
            followers: [{ clipId: "t" }, { clipId: "fx" }, { clipId: "a" }, { clipId: "v" }, { clipId: "late" }, { clipId: "zzz" }, { mask: true }, { clipId: "g" }, { clipId: "g" }],
        });
        if (!plan.ok) throw new Error(plan.error);
        expect(plan.value.report.skipped).toEqual([
            { clipId: "t", reason: "locked" }, { clipId: "fx", reason: "no-position" }, { clipId: "a", reason: "not-visual" },
            { clipId: "v", reason: "tracked-item" }, { clipId: "late", reason: "no-overlap" }, { clipId: "zzz", reason: "not-found" },
            { mask: true, reason: "no-mask" }, { clipId: "g", reason: "duplicate" },
        ]);
        expect(plan.value.report.applied.map((a) => a.clipId)).toEqual(["g"]);
        const none = planTrackingApply(s, { clipId: "v" }, { samples: linear, source: SOURCE, followers: [{ clipId: "fx" }] });
        expect(none).toMatchObject({ ok: false, error: expect.stringMatching(/fx: no-position/) });
    });

    it("refuses a clip whose box leaves no room to move", () => {
        const plan = planTrackingApply(state(), { clipId: "v" }, { samples: linear, source: SOURCE, followers: [{ clipId: "t", anchor: { width: 1, height: 1 } }] });
        expect(plan).toMatchObject({ ok: false, error: expect.stringMatching(/no-room/) });
    });

    it("decimates a curved path within the tolerance and validates samples", () => {
        const wavy = samples(0, 9.9, (t) => 0.5 + 0.2 * Math.sin(t), (t) => 0.5 + 0.1 * Math.cos(t / 2));
        const plan = planTrackingApply(state(), { clipId: "v" }, { samples: wavy, source: SOURCE, followers: [{ clipId: "g" }] });
        if (!plan.ok) throw new Error(plan.error);
        const points = kf(plan.value.clipUpdates[0]);
        expect(points.length).toBeGreaterThan(5);
        expect(points.length).toBeLessThan(wavy.length / 2);
        for (const s of wavy) {
            expect(Math.abs(channelValueAt(points, "position_x", s.time, 0) - (0.5 + (s.x - wavy[0].x)))).toBeLessThan(0.002);
        }
        expect(planTrackingApply(state(), { clipId: "v" }, { samples: [], followers: [{ clipId: "g" }] })).toMatchObject({ ok: false });
        expect(planTrackingApply(state(), { clipId: "v" }, { samples: [{ time: 0, x: Number.NaN, y: 0, confidence: 1, lost: false }], followers: [{ clipId: "g" }] })).toMatchObject({ ok: false });
        expect(planTrackingApply(state(), { clipId: "v" }, { samples: linear, followers: [] })).toMatchObject({ ok: false });
    });

    it("decimateTrack keeps the ends and every corner", () => {
        const points = [0, 1, 2, 3, 4].map((t) => ({ t, a: t < 2 ? t : 4 - t, b: 0 }));
        expect(decimateTrack(points, 0.01).map((p) => p.t)).toEqual([0, 2, 4]);
    });

    it("parses aspect ratios", () => {
        expect(frameAspect("9:16")).toBeCloseTo(9 / 16, 9);
        expect(frameAspect("junk")).toBeCloseTo(16 / 9, 9);
    });
});
