import { describe, expect, it } from "vitest";
import { createMotionTracker, motionTrackerRuntime, trackFrames, type LumaFrame } from "./tracker";
import { regionOf, renderFrame } from "./__fixtures__/synthetic";

const W = 320;
const H = 180;
const SIDE = 32;

/** Error in analysis pixels between a sample (frame fractions) and the true centre. */
const errorPx = (sample: { x: number; y: number }, cx: number, cy: number, width = W, height = H) => Math.hypot(sample.x * width - cx, sample.y * height - cy);

describe("motion tracker", () => {
    it("follows a textured square moving by sub-pixel steps within half a pixel", () => {
        const path = Array.from({ length: 40 }, (_, k) => ({ cx: 80 + 1.37 * k, cy: 70 + 0.61 * k + 4 * Math.sin(k / 6) }));
        const frames = path.map((p, k) => renderFrame({ width: W, height: H, cx: p.cx, cy: p.cy, side: SIDE, noise: 2, frameSeed: k + 1 }));
        const tracker = createMotionTracker(frames[0], regionOf({ width: W, height: H }, path[0].cx, path[0].cy, SIDE));
        let worst = 0;
        for (let k = 1; k < frames.length; k += 1) {
            const sample = tracker.step(frames[k]);
            expect(sample.lost).toBe(false);
            expect(sample.confidence).toBeGreaterThan(0.9);
            worst = Math.max(worst, errorPx(sample, path[k].cx, path[k].cy));
        }
        expect(worst).toBeLessThan(0.2);
    });

    it("catches a sudden jump inside the pyramid's search range", () => {
        const path = [{ cx: 100, cy: 90 }, { cx: 102, cy: 90 }, { cx: 104, cy: 90 }, { cx: 128.4, cy: 75.3 }, { cx: 130.4, cy: 75.3 }];
        const frames = path.map((p) => renderFrame({ width: W, height: H, cx: p.cx, cy: p.cy, side: SIDE }));
        const tracker = createMotionTracker(frames[0], regionOf({ width: W, height: H }, 100, 90, SIDE));
        for (let k = 1; k < frames.length; k += 1) {
            const sample = tracker.step(frames[k]);
            expect(sample.lost).toBe(false);
            expect(errorPx(sample, path[k].cx, path[k].cy)).toBeLessThan(0.75);
        }
    });

    it("holds the last good position while occluded and recovers afterwards", () => {
        const path = Array.from({ length: 30 }, (_, k) => ({ cx: 60 + 2 * k, cy: 90 }));
        // Frames 10-15: a flat block covers the square's whole path there.
        const occluded = (k: number) => k >= 10 && k <= 15;
        const frames = path.map((p, k) => renderFrame({
            width: W, height: H, cx: p.cx, cy: p.cy, side: SIDE,
            ...(occluded(k) ? { occluder: { x: 70, y: 60, w: 70, h: 60, value: 90 } } : {}),
        }));
        const tracker = createMotionTracker(frames[0], regionOf({ width: W, height: H }, path[0].cx, path[0].cy, SIDE));
        const samples = frames.slice(1).map((frame) => tracker.step(frame));
        const at = (k: number) => samples[k - 1];
        const lastGood = at(9);
        expect(lastGood.lost).toBe(false);
        for (let k = 10; k <= 15; k += 1) {
            expect(at(k).lost).toBe(true);
            expect(at(k).confidence).toBeLessThan(0.5);
            expect(at(k).x).toBe(lastGood.x);
            expect(at(k).y).toBe(lastGood.y);
        }
        for (let k = 17; k < 30; k += 1) {
            expect(at(k).lost).toBe(false);
            expect(errorPx(at(k), path[k].cx, path[k].cy)).toBeLessThan(0.75);
        }
    });

    it("reports a flat region as lost with low confidence", () => {
        const flat = { x: 150, y: 20, w: 120, h: 80, value: 120 };
        const frames = Array.from({ length: 5 }, (_, k) => renderFrame({ width: W, height: H, cx: 60 + k, cy: 140, side: SIDE, flat }));
        const tracker = createMotionTracker(frames[0], regionOf({ width: W, height: H }, 210, 60, 30));
        for (let k = 1; k < frames.length; k += 1) {
            const sample = tracker.step(frames[k]);
            expect(sample.confidence).toBeLessThan(0.2);
            expect(sample.lost).toBe(true);
            expect(errorPx(sample, 210, 60)).toBeLessThan(1);
        }
    });

    it("tracks forward and backward from the start frame and returns time-ordered samples", () => {
        const path = Array.from({ length: 21 }, (_, k) => ({ cx: 70 + 1.5 * k, cy: 60 + k }));
        const frames = path.map((p, k) => ({ time: k / 15, frame: renderFrame({ width: W, height: H, cx: p.cx, cy: p.cy, side: SIDE }) }));
        const start = 10;
        const samples = trackFrames(frames, start, regionOf({ width: W, height: H }, path[start].cx, path[start].cy, SIDE));
        expect(samples.map((s) => s.time)).toEqual(frames.map((f) => f.time));
        expect(samples[start]).toMatchObject({ confidence: 1, lost: false });
        samples.forEach((sample, k) => expect(errorPx(sample, path[k].cx, path[k].cy)).toBeLessThan(0.5));
    });

    it("is fast enough on 640×360 analysis frames", () => {
        const width = 640;
        const height = 360;
        const path = Array.from({ length: 31 }, (_, k) => ({ cx: 200 + 3.1 * k, cy: 150 + 1.2 * k }));
        const frames: LumaFrame[] = path.map((p) => renderFrame({ width, height, cx: p.cx, cy: p.cy, side: 64 }));
        const tracker = createMotionTracker(frames[0], regionOf({ width, height }, path[0].cx, path[0].cy, 64));
        const started = performance.now();
        for (let k = 1; k < frames.length; k += 1) {
            const sample = tracker.step(frames[k]);
            expect(errorPx(sample, path[k].cx, path[k].cy, width, height)).toBeLessThan(0.5);
        }
        const perFrame = (performance.now() - started) / (frames.length - 1);
        // Typically a few ms per frame; the bound leaves room for a loaded CI machine.
        expect(perFrame).toBeLessThan(60);
    });

    it("rejects a region outside the frame or too small to track", () => {
        const frame = renderFrame({ width: W, height: H, cx: 100, cy: 90, side: SIDE });
        expect(() => createMotionTracker(frame, { x: 1.2, y: 0.1, width: 0.1, height: 0.1 })).toThrow(/region/);
        expect(() => createMotionTracker(frame, { x: 0.5, y: 0.5, width: 0.001, height: 0.001 })).toThrow(/region/);
    });

    it("is self-contained, so a worker can run it from its source text", () => {
        const runtime = new Function(`return (${motionTrackerRuntime.toString()})();`)() as ReturnType<typeof motionTrackerRuntime>;
        const frames = [0, 1, 2].map((k) => renderFrame({ width: W, height: H, cx: 100 + 2 * k, cy: 90, side: SIDE }));
        const tracker = runtime.createTracker(frames[0], regionOf({ width: W, height: H }, 100, 90, SIDE), {});
        tracker.step(frames[1]);
        expect(errorPx(tracker.step(frames[2]), 104, 90)).toBeLessThan(0.5);
    });
});
