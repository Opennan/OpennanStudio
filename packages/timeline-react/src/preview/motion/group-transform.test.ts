import { applyGroupGesture, clampGroupFactor, gestureBox, groupItemValues, groupScaleFactor, unionBox, type GroupItem } from "./group-transform";

const frame = { x: 0, y: 0, w: 1000, h: 500 };
const close = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
};

describe("group gestures", () => {
    it("moves every pivot by the drag", () => {
        expect(applyGroupGesture({ pivot: { x: 10, y: 20 }, scale: 2, rotation: 15 }, { kind: "move", dx: 5, dy: -5 })).toEqual({ pivot: { x: 15, y: 15 }, scale: 2, rotation: 15 });
    });

    it("scales about the group centre: offsets and scales multiply", () => {
        const pose = applyGroupGesture({ pivot: { x: 300, y: 200 }, scale: 0.5, rotation: 0 }, { kind: "scale", center: { x: 200, y: 200 }, factor: 2 });
        close(pose.pivot, { x: 400, y: 200 });
        expect(pose.scale).toBe(1);
    });

    it("rotates centres about the group centre and adds the angle", () => {
        const pose = applyGroupGesture({ pivot: { x: 300, y: 200 }, scale: 1, rotation: 10 }, { kind: "rotate", center: { x: 200, y: 200 }, degrees: 90 });
        close(pose.pivot, { x: 200, y: 300 });
        expect(pose.rotation).toBe(100);
    });

    it("the union box encloses rotated boxes", () => {
        const box = unionBox([
            { cx: 100, cy: 100, w: 100, h: 50, rotation: 0 },
            { cx: 300, cy: 100, w: 100, h: 100, rotation: Math.PI / 4 },
        ])!;
        expect(box.cx - box.w / 2).toBeCloseTo(50, 6);
        expect(box.cx + box.w / 2).toBeCloseTo(300 + 50 * Math.SQRT2, 6);
        expect(box.cy - box.h / 2).toBeCloseTo(100 - 50 * Math.SQRT2, 6);
        expect(unionBox([])).toBeNull();
    });

    it("the group box follows the gesture", () => {
        const box = { cx: 100, cy: 100, w: 40, h: 20, rotation: 0 };
        expect(gestureBox(box, { kind: "scale", center: { x: 100, y: 100 }, factor: 1.5 })).toEqual({ cx: 100, cy: 100, w: 60, h: 30, rotation: 0 });
        expect(gestureBox(box, { kind: "rotate", center: { x: 100, y: 100 }, degrees: 30 }).rotation).toBeCloseTo(Math.PI / 6, 9);
    });

    it("scale factors come from the pointer distance and keep every item within limits", () => {
        expect(groupScaleFactor({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 })).toBe(2);
        expect(groupScaleFactor({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 50, y: 0 })).toBe(1);
        expect(clampGroupFactor(10, [0.5, 2], 0.1, 5)).toBe(2.5);
        expect(clampGroupFactor(0.01, [0.5, 2], 0.1, 5)).toBe(0.2);
    });
});

describe("group item values", () => {
    const clip: GroupItem = { kind: "clip", id: "c", pivot: { x: 500, y: 250 }, scale: 1, rotation: 0, anchor: { w: 200, h: 100 }, posX: 0.5, posY: 0.5 };

    it("clips: the position puts the pivot back in the free space", () => {
        const values = groupItemValues(clip, { pivot: { x: 600, y: 250 }, scale: 1, rotation: 0 }, frame);
        expect(values.position_x).toBeCloseTo((600 - 100) / 800, 6);
        expect(values.position_y).toBeCloseTo(0.5, 6);
    });

    it("clips: a scaled box anchors across its new size, a covered axis keeps its position", () => {
        const values = groupItemValues(clip, { pivot: { x: 500, y: 250 }, scale: 6, rotation: 45 }, frame);
        expect(values.position_y).toBe(0.5);
        expect(values.scale).toBe(6);
        expect(values.rotation_degrees).toBe(45);
    });

    it("scenes: offsets in percent of the frame, clamped", () => {
        const scene: GroupItem = { kind: "scene", id: "s", pivot: { x: 500, y: 250 }, scale: 1, rotation: 0, posX: 0, posY: 0 };
        expect(groupItemValues(scene, { pivot: { x: 750, y: 125 }, scale: 1, rotation: 0 }, frame)).toMatchObject({ position_x: 25, position_y: -25 });
        expect(groupItemValues(scene, { pivot: { x: 99999, y: 250 }, scale: 1, rotation: 0 }, frame).position_x).toBe(200);
    });

    it("graphics: positions are fractions of the whole frame", () => {
        const graphic: GroupItem = { kind: "graphics", id: "g", pivot: { x: 500, y: 250 }, scale: 1, rotation: 0, posX: 0.5, posY: 0.5 };
        expect(groupItemValues(graphic, { pivot: { x: 600, y: 300 }, scale: 1, rotation: 0 }, frame)).toMatchObject({ position_x: 0.6, position_y: 0.6 });
    });
});
