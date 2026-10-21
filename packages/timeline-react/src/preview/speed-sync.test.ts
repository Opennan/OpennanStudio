import { describe, expect, it } from "vitest";
import { clipSpeedProfile, sceneSpeedProfile, sourceTimeAt, type SpeedProfile } from "@opennan/timeline-core/motion/speed";
import {
    HARD_SEEK_DRIFT,
    MAX_ELEMENT_RATE,
    MIN_ELEMENT_RATE,
    NUDGE_FACTOR,
    RATE_WRITE_INTERVAL_MS,
    applyPitch,
    cachedClipSpeedProfile,
    driftAction,
    mediaTimeAt,
    syncMediaElement,
    targetRate,
} from "./speed-sync";

const identity: SpeedProfile = { speed: 1, curve: null, preservePitch: true };
const double: SpeedProfile = { speed: 2, curve: null, preservePitch: true };
const hero = clipSpeedProfile({ playbackSpeed: 1, speedCurveJson: JSON.stringify({ id: "hero", points: [[0, 1], [0.28, 1], [0.42, 0.25], [0.58, 0.25], [0.72, 1], [1, 1]] }) });

type PitchVideo = HTMLVideoElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };

function fakeVideo(init: { currentTime?: number; paused?: boolean; seeking?: boolean } = {}): PitchVideo {
    const el = document.createElement("video") as PitchVideo;
    let paused = init.paused ?? false;
    Object.defineProperty(el, "paused", { get: () => paused, configurable: true });
    Object.defineProperty(el, "seeking", { get: () => init.seeking ?? false, configurable: true });
    el.pause = () => { paused = true; };
    el.play = () => { paused = false; return Promise.resolve(); };
    el.currentTime = init.currentTime ?? 0;
    return el;
}

describe("mediaTimeAt", () => {
    it("is trimStart + local at 1×", () => {
        expect(mediaTimeAt(identity, 2, 5, 1.5)).toBe(3.5);
        expect(mediaTimeAt(identity, -1, 5, 1.5)).toBe(1.5);
    });
    it("doubles the local time at 2×", () => {
        expect(mediaTimeAt(double, 2, 5, 1)).toBe(5);
    });
    it("follows the exact time map of a curve", () => {
        const D = 10;
        for (const t of [0, 1, 3.5, 5, 7.2, 10]) expect(mediaTimeAt(hero, t, D, 2)).toBeCloseTo(2 + sourceTimeAt(hero, t, D), 12);
        // Slow middle: the source advances a quarter as fast as the timeline.
        expect(mediaTimeAt(hero, 5.1, D, 0) - mediaTimeAt(hero, 5, D, 0)).toBeCloseTo(0.025, 9);
    });
    it("falls back to the base speed without a length", () => {
        expect(mediaTimeAt(double, 3, 0, 0)).toBe(6);
    });
});

describe("targetRate", () => {
    it("is the base speed for constant profiles", () => {
        expect(targetRate(identity, 1, 5)).toEqual({ rate: 1, seek: false });
        expect(targetRate(double, 1, 5)).toEqual({ rate: 2, seek: false });
    });
    it("follows the curve", () => {
        expect(targetRate(hero, 1, 10).rate).toBeCloseTo(1, 9);
        expect(targetRate(hero, 5, 10).rate).toBeCloseTo(0.25, 9);
    });
    it("multiplies by the shuttle factor", () => {
        expect(targetRate(double, 1, 5, 2)).toEqual({ rate: 4, seek: false });
    });
    it("clamps to the browser range and asks for seeking outside it", () => {
        expect(targetRate({ speed: 50, curve: null, preservePitch: true }, 1, 5)).toEqual({ rate: MAX_ELEMENT_RATE, seek: true });
        expect(targetRate({ speed: 0.1, curve: { id: "custom", points: [[0, 0.1], [1, 0.1]] }, preservePitch: true }, 1, 5)).toEqual({ rate: MIN_ELEMENT_RATE, seek: true });
        expect(targetRate({ speed: 16, curve: null, preservePitch: true }, 1, 5)).toEqual({ rate: 16, seek: false });
    });
});

describe("driftAction", () => {
    it("hard-seeks past a second of drift", () => {
        expect(driftAction(5, 3.5, true, 1)).toEqual({ seek: 3.5, rate: 1 });
    });
    it("measures drift in timeline seconds (scaled by the rate)", () => {
        // 1.5 media seconds at 2× is 0.75 timeline seconds: a nudge, not a seek.
        expect(driftAction(5, 3.5, true, 2)).toEqual({ seek: null, rate: 2 * (1 - NUDGE_FACTOR) });
        expect(driftAction(5, 3.5 - 2 * HARD_SEEK_DRIFT, true, 2).seek).toBe(3.5 - 2 * HARD_SEEK_DRIFT);
    });
    it("nudges ±2% between the thresholds and keeps the current rate inside the band", () => {
        expect(driftAction(3, 3.3, true, 1)).toEqual({ seek: null, rate: 1 + NUDGE_FACTOR });
        expect(driftAction(3.3, 3, true, 1)).toEqual({ seek: null, rate: 1 - NUDGE_FACTOR });
        expect(driftAction(3.1, 3, true, 1)).toEqual({ seek: null, rate: null });
        expect(driftAction(3.01, 3, true, 1)).toEqual({ seek: null, rate: 1 });
    });
    it("snaps to the exact frame while paused", () => {
        expect(driftAction(3.1, 3, false, 1)).toEqual({ seek: 3, rate: 1 });
        expect(driftAction(3.01, 3, false, 2)).toEqual({ seek: null, rate: 2 });
    });
});

describe("applyPitch", () => {
    it("sets the standard and prefixed flags", () => {
        const el = fakeVideo();
        applyPitch(el, false);
        expect([el.preservesPitch, el.webkitPreservesPitch, el.mozPreservesPitch]).toEqual([false, false, false]);
        applyPitch(el, true);
        expect([el.preservesPitch, el.webkitPreservesPitch, el.mozPreservesPitch]).toEqual([true, true, true]);
    });
});

describe("syncMediaElement", () => {
    it("sets the base rate and pitch on a playing element in sync", () => {
        const el = fakeVideo({ currentTime: 4 });
        const result = syncMediaElement(el, { desired: 4, playing: true, target: { rate: 2, seek: false }, preservePitch: false, now: 0 });
        expect(result).toBe("rate");
        expect(el.playbackRate).toBe(2);
        expect(el.preservesPitch).toBe(false);
        // Already right: nothing is written again.
        expect(syncMediaElement(el, { desired: 4, playing: true, target: { rate: 2, seek: false }, preservePitch: false, now: 16 })).toBe("none");
    });

    it("hard-seeks on a large drift and resets the rate", () => {
        const el = fakeVideo({ currentTime: 0 });
        expect(syncMediaElement(el, { desired: 4, playing: true, target: { rate: 2, seek: false }, preservePitch: true, now: 0 })).toBe("seek");
        expect(el.currentTime).toBe(4);
        expect(el.playbackRate).toBe(2);
    });

    it("nudges with varispeed at 1× and restores the pitch flag afterwards (no sticky preservesPitch=false)", () => {
        const el = fakeVideo({ currentTime: 3 });
        syncMediaElement(el, { desired: 3.3, playing: true, target: { rate: 1, seek: false }, preservePitch: true, now: 1000 });
        expect(el.playbackRate).toBeCloseTo(1.02, 9);
        expect(el.preservesPitch).toBe(false);
        // Back in sync (after the write interval): rate 1 and the pitch flag back on.
        el.currentTime = 3.31;
        syncMediaElement(el, { desired: 3.3, playing: true, target: { rate: 1, seek: false }, preservePitch: true, now: 1000 + RATE_WRITE_INTERVAL_MS + 1 });
        expect(el.playbackRate).toBe(1);
        expect(el.preservesPitch).toBe(true);
    });

    it("keeps the time-stretcher on while nudging a sped-up element that keeps pitch", () => {
        const el = fakeVideo({ currentTime: 3 });
        syncMediaElement(el, { desired: 3.6, playing: true, target: { rate: 2, seek: false }, preservePitch: true, now: 0 });
        expect(el.playbackRate).toBeCloseTo(2.04, 9);
        expect(el.preservesPitch).toBe(true);
    });

    it("throttles nudge changes but follows a moving base rate at once", () => {
        const el = fakeVideo({ currentTime: 3 });
        syncMediaElement(el, { desired: 3.3, playing: true, target: { rate: 1, seek: false }, preservePitch: true, now: 5000 });
        expect(el.playbackRate).toBeCloseTo(1.02, 9);
        // Drift flips within the interval: the nudge holds.
        el.currentTime = 3.6;
        syncMediaElement(el, { desired: 3.3, playing: true, target: { rate: 1, seek: false }, preservePitch: true, now: 5100 });
        expect(el.playbackRate).toBeCloseTo(1.02, 9);
        // The curve drops the base rate: written immediately (nudge kept).
        syncMediaElement(el, { desired: 3.3, playing: true, target: { rate: 0.5, seek: false }, preservePitch: true, now: 5200 });
        expect(el.playbackRate).toBeCloseTo(0.51, 9);
    });

    it("steps by seeking outside the browser's rate range: pauses and lands on the exact time", () => {
        const el = fakeVideo({ currentTime: 1 });
        expect(syncMediaElement(el, { desired: 25, playing: true, target: { rate: 16, seek: true }, preservePitch: true, now: 0 })).toBe("step");
        expect(el.paused).toBe(true);
        expect(el.currentTime).toBe(25);
    });

    it("does not queue a step seek while the previous one is still decoding", () => {
        const el = fakeVideo({ currentTime: 1, seeking: true });
        syncMediaElement(el, { desired: 25, playing: true, target: { rate: 16, seek: true }, preservePitch: true, now: 0 });
        expect(el.currentTime).toBe(1);
    });

    it("snaps a paused element to the frame and leaves play state to the caller", () => {
        const el = fakeVideo({ currentTime: 0, paused: true });
        expect(syncMediaElement(el, { desired: 2.5, playing: false, target: { rate: 2, seek: false }, preservePitch: true, now: 0 })).toBe("seek");
        expect(el.currentTime).toBe(2.5);
        expect(el.paused).toBe(true);
        expect(el.playbackRate).toBe(2);
    });

    it("scene profiles default to keep-pitch", () => {
        expect(sceneSpeedProfile({ playbackSpeed: 2 }).preservePitch).toBe(true);
    });
});

describe("cachedClipSpeedProfile", () => {
    it("parses each clip object once (the compositor asks per overlay per frame)", () => {
        const clip = { playbackSpeed: 2, speedRamp: "none", speedCurveJson: null, preservePitch: true };
        const first = cachedClipSpeedProfile(clip);
        expect(first).toEqual(clipSpeedProfile(clip));
        expect(cachedClipSpeedProfile(clip)).toBe(first);
        // An edit makes a new clip object: a new profile.
        const edited = { ...clip, playbackSpeed: 3 };
        expect(cachedClipSpeedProfile(edited)).not.toBe(first);
        expect(cachedClipSpeedProfile(edited)).toEqual(clipSpeedProfile(edited));
    });
});
