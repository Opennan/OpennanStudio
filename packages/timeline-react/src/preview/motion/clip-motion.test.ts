import { describe, expect, it } from "vitest";
import {
    applyDragOverride, baseTransform, clipBaseAt, clipMotionAt, overlayRectOf, overrideSettled, placedBox, textLayoutScale,
    type ClipTransform,
} from "./clip-motion";
import { testClip } from "./test-fixtures";

const json = (value: unknown) => JSON.stringify(value);

/**
 * The export's overlay placement, written independently: the layer of size boxW·s × boxH·s (× |scaleX|
 * horizontally) is centred at posX·(W − boxW·s) + boxW·s/2 + dx·W (same for y), rotated about that centre.
 */
function exportPlacement(W: number, H: number, boxW: number, boxH: number, c: ClipTransform) {
    const bw = boxW * c.scale;
    const bh = boxH * c.scale;
    return {
        cx: c.posX * (W - bw) + bw / 2 + c.dx * W,
        cy: c.posY * (H - bh) + bh / 2 + c.dy * H,
        w: bw * Math.abs(c.scaleX),
        h: bh,
    };
}

const rest: ClipTransform = { opacity: 1, scale: 1, scaleX: 1, posX: 0.5, posY: 0.5, dx: 0, dy: 0, rotation: 0 };

describe("placedBox", () => {
    const cases: Array<[string, Partial<ClipTransform>]> = [
        ["centred", {}],
        ["corner", { posX: 0, posY: 1 }],
        ["scaled", { scale: 1.7, posX: 0.2, posY: 0.9 }],
        ["slid", { dx: -0.35, dy: 0.12, posX: 0.8 }],
        ["flipping", { scaleX: -0.4, scale: 0.6 }],
        ["rotated", { rotation: 33, posX: 0.1, dx: 0.05 }],
    ];
    for (const [name, channels] of cases) {
        it(`matches the export formula (${name})`, () => {
            const c = { ...rest, ...channels };
            const frame = { x: 40, y: 12, w: 640, h: 360 };
            const got = placedBox(frame, { w: 120, h: 80 }, c);
            const want = exportPlacement(640, 360, 120, 80, c);
            expect(got.cx - frame.x).toBeCloseTo(want.cx, 9);
            expect(got.cy - frame.y).toBeCloseTo(want.cy, 9);
            expect(got.w).toBeCloseTo(want.w, 9);
            expect(got.h).toBeCloseTo(want.h, 9);
            expect(got.x).toBeCloseTo(got.cx - got.w / 2, 9);
            expect(got.rotation).toBeCloseTo((c.rotation * Math.PI) / 180, 12);
        });
    }

    it("pins boxes larger than the frame to the frame origin like the export's max(0, …)", () => {
        const got = placedBox({ x: 0, y: 0, w: 100, h: 100 }, { w: 80, h: 80 }, { ...rest, scale: 2, posX: 1, posY: 0.3 });
        expect(got.cx).toBe(80);
        expect(got.cy).toBe(80);
    });

    it("overlay rects carry the pivot and the anchor size", () => {
        const box = placedBox({ x: 0, y: 0, w: 200, h: 100 }, { w: 50, h: 20 }, { ...rest, scaleX: 0.5, rotation: 90 });
        expect(overlayRectOf(box)).toMatchObject({ w: 25, h: 20, px: box.cx, py: box.cy, anchorW: 50, anchorH: 20, rot: Math.PI / 2 });
    });
});

describe("clipMotionAt", () => {
    it("returns one memoized sample for static clips", () => {
        const clip = testClip({ positionX: 0.2, scale: 1.5, rotationDegrees: 10, opacity: 0.4 });
        const a = clipMotionAt(clip, 0.1);
        expect(a).toBe(clipMotionAt(clip, 3));
        expect(a).toMatchObject({ animated: false, posX: 0.2, scale: 1.5, rotation: 10, opacity: 0.4, base: { posX: 0.2, scale: 1.5, rotation: 10 } });
    });

    it("previews legacy fades and the motion preset that the export applies", () => {
        const faded = testClip({ fadeInDuration: 1 });
        expect(clipMotionAt(faded, 0.25).opacity).toBeCloseTo(0.25, 9);
        expect(clipMotionAt(faded, 2).opacity).toBe(1);
        const zoom = testClip({ motionPreset: "zoom_in" });
        expect(clipMotionAt(zoom, 4).scale).toBeCloseTo(1.08, 6);
        expect(clipMotionAt(zoom, 4).base.scale).toBe(1);
    });

    it("applies clip animations on top of the base values", () => {
        const clip = testClip({ animationJson: json({ in: { id: "slide_left", duration: 1 } }) });
        const start = clipMotionAt(clip, 0);
        expect(start.animated).toBe(true);
        expect(start.dx).not.toBe(0);
        expect(start.base.posX).toBe(0.5);
        expect(clipMotionAt(clip, 2).dx).toBe(0);
    });

    it("keyframed base values come from the keyframes at the playhead", () => {
        const clip = testClip({ keyframesJson: json([{ time: 0, position_x: 0, scale: 1 }, { time: 2, position_x: 1, scale: 3 }]) });
        expect(clipBaseAt(clip, 1)).toMatchObject({ posX: 0.5, scale: 2, posY: 0.5 });
        expect(clipMotionAt(clip, 1).base).toMatchObject({ posX: 0.5, scale: 2 });
    });
});

describe("drag overrides", () => {
    const clip = testClip({ motionPreset: "zoom_in", animationJson: json({ in: { id: "slide_left", duration: 1 } }) });

    it("replace base channels and keep the animation on top", () => {
        const sample = clipMotionAt(clip, 0.5);
        const dragged = applyDragOverride(sample, { posX: 0.1, scale: 2 });
        expect(dragged.posX).toBe(0.1);
        expect(dragged.dx).toBe(sample.dx);
        expect(dragged.scale).toBeCloseTo(2 * (sample.scale / sample.base.scale), 12);
        expect(dragged.posY).toBe(sample.posY);
        expect(applyDragOverride(sample, null).scale).toBe(sample.scale);
    });

    it("the base transform drops animation deltas", () => {
        const sample = clipMotionAt(clip, 0.5);
        expect(baseTransform(sample, { posY: 0.9 })).toEqual({ opacity: 1, scale: 1, scaleX: 1, posX: 0.5, posY: 0.9, dx: 0, dy: 0, rotation: 0 });
    });

    it("a rotation override replaces the base rotation and keeps the animation's rotation on top", () => {
        const spinning = testClip({ trackType: "text", rotationDegrees: 10, animationJson: json({ loop: { id: "swing", period: 1 } }) });
        const sample = clipMotionAt(spinning, 0.3);
        const delta = sample.rotation - sample.base.rotation;
        expect(Math.abs(delta)).toBeGreaterThan(0.1);
        expect(applyDragOverride(sample, { rotation: 45 }).rotation).toBeCloseTo(45 + delta, 12);
        expect(baseTransform(sample, { rotation: 45 }).rotation).toBe(45);
        const keyed = testClip({ keyframesJson: json([{ time: 0, rotation_degrees: 0 }, { time: 2, rotation_degrees: 90 }]) });
        expect(overrideSettled(keyed, { rotation: 45 }, 1)).toBe(true);
        expect(overrideSettled(keyed, { rotation: 40 }, 1)).toBe(false);
    });

    it("settle against the keyframed value, not the static field (no snap-back on keyframed clips)", () => {
        const keyed = testClip({ positionX: 0.5, keyframesJson: json([{ time: 0, position_x: 0.2 }, { time: 2, position_x: 0.6 }]) });
        expect(overrideSettled(keyed, { posX: 0.4 }, 1)).toBe(true);
        expect(overrideSettled(keyed, { posX: 0.5 }, 1)).toBe(false);
        expect(overrideSettled(keyed, null, 1)).toBe(false);
    });
});

describe("textLayoutScale", () => {
    it("is the static scale, or the largest scale reached when animated (export overlayScale)", () => {
        expect(textLayoutScale(testClip({ scale: 1.3 }))).toBe(1.3);
        expect(textLayoutScale(testClip({ scale: 1, keyframesJson: json([{ time: 0, scale: 0.5 }, { time: 1, scale: 2.5 }]) }))).toBe(2.5);
        expect(textLayoutScale(testClip({ scale: 2, motionPreset: "pulse" }))).toBeCloseTo(2.08, 12);
        expect(textLayoutScale(testClip({ scale: 2, keyframesJson: json([{ time: 0, opacity: 0 }]) }))).toBe(2);
    });
});
