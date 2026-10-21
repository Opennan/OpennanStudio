import {
    defaultTrackRegion, hitTestTrackRegion, nudgeTrackRegion, screenToSource, sourceToScreen, trackRegionDrag, trackRegionGeometry, NO_FLIP,
} from "./track-region";
import type { HandleBox } from "./handles";

const ITEM: HandleBox = { cx: 200, cy: 150, w: 400, h: 300, rotation: 0 };
const REGION = { x: 0.25, y: 0.25, width: 0.25, height: 0.2 };

describe("track region geometry", () => {
    it("draws the region inside the item box and maps points both ways", () => {
        const g = trackRegionGeometry(ITEM, REGION);
        expect(g.frame).toMatchObject({ cx: 150, cy: 105, w: 100, h: 60 });
        expect(g.corners[0]).toEqual({ x: 100, y: 75 });
        expect(screenToSource(ITEM, NO_FLIP, 100, 75)).toEqual({ x: 0.25, y: 0.25 });
        const flipped = trackRegionGeometry(ITEM, REGION, { x: true, y: false });
        expect(flipped.frame.cx).toBe(250);
        const turned: HandleBox = { ...ITEM, rotation: Math.PI / 2 };
        const p = sourceToScreen(turned, NO_FLIP, { x: 1, y: 0.5 });
        expect(p.x).toBeCloseTo(200, 9);
        expect(p.y).toBeCloseTo(350, 9);
        expect(screenToSource(turned, NO_FLIP, p.x, p.y).x).toBeCloseTo(1, 9);
    });

    it("hits corners, the box, and the item around it", () => {
        const g = trackRegionGeometry(ITEM, REGION);
        expect(hitTestTrackRegion(g, 101, 76)).toEqual({ kind: "corner", corner: 0 });
        expect(hitTestTrackRegion(g, 199, 134)).toEqual({ kind: "corner", corner: 3 });
        expect(hitTestTrackRegion(g, 150, 105)).toEqual({ kind: "move" });
        expect(hitTestTrackRegion(g, 350, 250)).toEqual({ kind: "draw" });
        expect(hitTestTrackRegion(g, 450, 250)).toBeNull();
    });

    it("moves inside the picture, resizes against the opposite corner, and draws new boxes", () => {
        const start = { item: ITEM, flip: NO_FLIP, region: REGION, pointer: { x: 150, y: 105 } };
        expect(trackRegionDrag({ ...start, hit: { kind: "move" } }, { x: 190, y: 135 })).toEqual({ x: 0.35, y: 0.35, width: 0.25, height: 0.2 });
        expect(trackRegionDrag({ ...start, hit: { kind: "move" } }, { x: 1000, y: -1000 })).toEqual({ x: 0.75, y: 0, width: 0.25, height: 0.2 });
        // Dragging the bottom-right corner keeps the top-left one.
        expect(trackRegionDrag({ ...start, pointer: { x: 200, y: 135 }, hit: { kind: "corner", corner: 3 } }, { x: 280, y: 195 })).toEqual({ x: 0.25, y: 0.25, width: 0.45, height: 0.4 });
        // Past the opposite corner the box flips over it; it never shrinks below the minimum.
        expect(trackRegionDrag({ ...start, pointer: { x: 200, y: 135 }, hit: { kind: "corner", corner: 3 } }, { x: 100, y: 75 })).toEqual({ x: 0.25, y: 0.25, width: 0.02, height: 0.02 });
        expect(trackRegionDrag({ ...start, pointer: { x: 300, y: 225 }, hit: { kind: "draw" } }, { x: 340, y: 255 })).toEqual({ x: 0.75, y: 0.75, width: 0.1, height: 0.1 });
        // A flipped item: the screen's right edge is the source's left edge.
        const flipped = trackRegionDrag({ item: ITEM, flip: { x: true, y: false }, region: REGION, pointer: { x: 300, y: 135 }, hit: { kind: "corner", corner: 3 } }, { x: 320, y: 135 });
        expect(flipped.x).toBeCloseTo(0.2, 9);
        expect(flipped.x + flipped.width).toBeCloseTo(0.5, 9);
    });

    it("nudges and sizes a default box", () => {
        expect(nudgeTrackRegion(REGION, 0.8, -1)).toEqual({ x: 0.75, y: 0, width: 0.25, height: 0.2 });
        const box = defaultTrackRegion(16 / 9);
        expect(box.height).toBeCloseTo(0.2, 4);
        expect(box.width).toBeCloseTo(0.1125, 4);
        expect(box.x + box.width / 2).toBeCloseTo(0.5, 3);
    });
});
