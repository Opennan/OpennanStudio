import {
    anchoredCornerScale, boxFromRect, cornerCursor, cornerPoints, hitTestHandles, pointerAngle, rotateKnob,
    rotateKnobOffset, snapRotation, solveAnchoredPosition, toLocal, toScreen, unwrapDelta, ROTATE_KNOB_OFFSET, type HandleBox,
} from "./handles";

const box = (over: Partial<HandleBox> = {}): HandleBox => ({ cx: 100, cy: 100, w: 80, h: 40, rotation: 0, ...over });
const deg = (d: number) => (d * Math.PI) / 180;

describe("box space", () => {
    it("maps screen points into the rotated box's local frame and back", () => {
        const b = box({ rotation: deg(90) });
        // Rotated 90° clockwise: local +x points down the screen.
        const local = toLocal(b, 100, 140);
        expect(local.x).toBeCloseTo(40, 9);
        expect(local.y).toBeCloseTo(0, 9);
        const back = toScreen(b, local.x, local.y);
        expect(back.x).toBeCloseTo(100, 9);
        expect(back.y).toBeCloseTo(140, 9);
    });

    it("builds a box from an overlay rect (pivot = centre)", () => {
        expect(boxFromRect({ x: 10, y: 20, w: 30, h: 40, rot: 0.5, px: 25, py: 40 })).toEqual({ cx: 25, cy: 40, w: 30, h: 40, rotation: 0.5 });
        expect(boxFromRect({ x: 10, y: 20, w: 30, h: 40 })).toEqual({ cx: 25, cy: 40, w: 30, h: 40, rotation: 0 });
    });

    it("places corners (TL, TR, BL, BR) and the rotate knob above the top centre, rotated with the box", () => {
        const corners = cornerPoints(box());
        expect(corners).toEqual([{ x: 60, y: 80 }, { x: 140, y: 80 }, { x: 60, y: 120 }, { x: 140, y: 120 }]);
        const knob = rotateKnob(box());
        expect(knob.base).toEqual({ x: 100, y: 80 });
        expect(knob.knob).toEqual({ x: 100, y: 80 - ROTATE_KNOB_OFFSET });
        const turned = rotateKnob(box({ rotation: deg(90) }));
        // Rotated 90° clockwise, "up" in the box points to the screen's +x.
        expect(turned.knob.x).toBeCloseTo(100 + 20 + ROTATE_KNOB_OFFSET, 9);
        expect(turned.knob.y).toBeCloseTo(100, 9);
    });
});

describe("rotateKnobOffset", () => {
    it("keeps the knob above the box unless it would leave the canvas, then tucks it inside below the top edge", () => {
        expect(rotateKnobOffset(box(), { w: 400, h: 400 })).toBe(ROTATE_KNOB_OFFSET);
        // A full-frame item: the knob above the top edge would sit at y < 0.
        const full = box({ cx: 200, cy: 100, w: 400, h: 200 });
        expect(rotateKnobOffset(full, { w: 400, h: 200 })).toBe(-ROTATE_KNOB_OFFSET);
        expect(rotateKnob(full, -ROTATE_KNOB_OFFSET).knob).toEqual({ x: 200, y: ROTATE_KNOB_OFFSET });
        const inside = hitTestHandles(full, 200, ROTATE_KNOB_OFFSET, { rotateOffset: -ROTATE_KNOB_OFFSET });
        expect(inside).toEqual({ kind: "rotate" });
        expect(hitTestHandles(full, 200, ROTATE_KNOB_OFFSET)).toEqual({ kind: "body" });
    });
});

describe("hitTestHandles", () => {
    it("finds the rotate knob, then corners, then the body, in rotated space", () => {
        const b = box({ rotation: deg(90) });
        const knob = rotateKnob(b).knob;
        expect(hitTestHandles(b, knob.x + 2, knob.y - 2)).toEqual({ kind: "rotate" });
        // TL corner of a box rotated 90° cw sits at the screen's top-right of the centre.
        const tl = cornerPoints(b)[0];
        expect(tl.x).toBeCloseTo(120, 9);
        expect(tl.y).toBeCloseTo(60, 9);
        expect(hitTestHandles(b, tl.x - 3, tl.y + 3)).toEqual({ kind: "corner", corner: 0 });
        // Inside the rotated box (40 wide on screen, 80 tall) but outside the unrotated one.
        expect(hitTestHandles(b, 100, 135)).toEqual({ kind: "body" });
        expect(hitTestHandles(b, 126, 100)).toBeNull();
        // Without handles (not selected) only the body hits.
        expect(hitTestHandles(b, knob.x, knob.y, { handles: false })).toBeNull();
        expect(hitTestHandles(b, 100, 100, { handles: false })).toEqual({ kind: "body" });
        expect(hitTestHandles(b, knob.x, knob.y, { rotate: false })).toBeNull();
    });
});

describe("rotation", () => {
    it("measures pointer angles clockwise from +x and unwraps across ±180°", () => {
        expect(pointerAngle(0, 0, 10, 0)).toBeCloseTo(0, 9);
        expect(pointerAngle(0, 0, 0, 10)).toBeCloseTo(90, 9);
        expect(unwrapDelta(170, -170)).toBeCloseTo(20, 9);
        expect(unwrapDelta(-170, 170)).toBeCloseTo(-20, 9);
        expect(unwrapDelta(10, 40)).toBeCloseTo(30, 9);
    });

    it("snaps to 15° with Shift and magnetically to the right angles within 3°", () => {
        expect(snapRotation(22, { shift: true })).toEqual({ degrees: 15, snapped: 15 });
        expect(snapRotation(23, { shift: true })).toEqual({ degrees: 30, snapped: 30 });
        expect(snapRotation(-7.4, { shift: true })).toEqual({ degrees: 0, snapped: 0 });
        expect(Object.is(snapRotation(-7.4, { shift: true }).degrees, -0)).toBe(false);
        expect(snapRotation(88, {})).toEqual({ degrees: 90, snapped: 90 });
        expect(snapRotation(-2.5, {})).toEqual({ degrees: 0, snapped: 0 });
        expect(snapRotation(362, {})).toEqual({ degrees: 360, snapped: 360 });
        expect(snapRotation(-268, {})).toEqual({ degrees: -270, snapped: -270 });
        expect(snapRotation(84, {})).toEqual({ degrees: 84, snapped: null });
        expect(snapRotation(84, { magnet: 0 })).toEqual({ degrees: 84, snapped: null });
    });

    it("picks resize cursors that follow the box rotation", () => {
        expect(cornerCursor(0, box({ w: 40, h: 40 }))).toBe("nwse-resize");
        expect(cornerCursor(1, box({ w: 40, h: 40 }))).toBe("nesw-resize");
        expect(cornerCursor(3, box({ w: 40, h: 40, rotation: deg(45) }))).toBe("ns-resize");
        expect(cornerCursor(1, box({ w: 40, h: 40, rotation: deg(45) }))).toBe("ew-resize");
        expect(cornerCursor(0, box({ w: 40, h: 40, rotation: deg(90) }))).toBe("nesw-resize");
    });
});

describe("anchoredCornerScale", () => {
    it("keeps the opposite corner in place (uniform scale along the diagonal)", () => {
        const b = box();
        // Drag the BR corner (140, 120) to (180, 140): the diagonal doubles.
        const out = anchoredCornerScale({ box: b, corner: 3, pointer: { x: 180, y: 140 } });
        expect(out.factor).toBeCloseTo(1.5, 9);
        // TL stays at (60, 80); the new box is 120×60, so its centre is (120, 110).
        expect(out.cx).toBeCloseTo(120, 9);
        expect(out.cy).toBeCloseTo(110, 9);
    });

    it("projects off-diagonal pointers onto the diagonal and works on rotated boxes", () => {
        const b = box({ w: 40, h: 40, rotation: deg(90) });
        const corners = cornerPoints(b);
        const anchor = corners[0];
        // Pointer exactly on the BR corner keeps scale 1.
        const same = anchoredCornerScale({ box: b, corner: 3, pointer: corners[3] });
        expect(same.factor).toBeCloseTo(1, 9);
        // Twice as far from the anchor along the diagonal: factor 2, anchor kept.
        const far = { x: anchor.x + (corners[3].x - anchor.x) * 2, y: anchor.y + (corners[3].y - anchor.y) * 2 };
        const out = anchoredCornerScale({ box: b, corner: 3, pointer: far });
        expect(out.factor).toBeCloseTo(2, 9);
        const scaled = { ...b, cx: out.cx, cy: out.cy, w: 80, h: 80 };
        const kept = cornerPoints(scaled)[0];
        expect(kept.x).toBeCloseTo(anchor.x, 9);
        expect(kept.y).toBeCloseTo(anchor.y, 9);
    });

    it("scales about the centre with Alt and clamps the factor", () => {
        const b = box();
        const out = anchoredCornerScale({ box: b, corner: 1, pointer: { x: 180, y: 60 }, aboutCenter: true });
        expect(out.factor).toBeCloseTo(2, 9);
        expect(out.cx).toBe(100);
        expect(out.cy).toBe(100);
        const tiny = anchoredCornerScale({ box: b, corner: 3, pointer: { x: 0, y: 0 }, minFactor: 0.25, maxFactor: 3 });
        expect(tiny.factor).toBe(0.25);
        const huge = anchoredCornerScale({ box: b, corner: 3, pointer: { x: 9000, y: 4600 }, minFactor: 0.25, maxFactor: 3 });
        expect(huge.factor).toBe(3);
    });
});

describe("solveAnchoredPosition", () => {
    it("inverts the export placement centre = start + pos·(size − box) + box/2 + offset", () => {
        // frame 0..1000, box 200: pos 0.25 puts the centre at 0.25·800 + 100 = 300.
        expect(solveAnchoredPosition(0, 1000, 200, 300, 0)).toBeCloseTo(0.25, 12);
        expect(solveAnchoredPosition(50, 1000, 200, 350 + 30, 30)).toBeCloseTo(0.25, 12);
        // Outside [0, 1] when the box pokes out of the frame (the export does not clamp).
        expect(solveAnchoredPosition(0, 1000, 200, 50, 0)).toBeCloseTo(-0.0625, 12);
        // A box that covers the axis is pinned by the placement: no position can move it.
        expect(solveAnchoredPosition(0, 1000, 1000, 500, 0)).toBeNull();
        expect(solveAnchoredPosition(0, 1000, 1400, 500, 0)).toBeNull();
    });
});
