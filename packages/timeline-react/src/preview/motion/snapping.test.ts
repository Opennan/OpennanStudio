import { boundsOfBox, frameSnapTargets, itemSnapTargets, mergeSnapTargets, snapMove, translateBounds, SNAP_THRESHOLD_PX } from "./snapping";

const frame = { x: 0, y: 0, w: 1000, h: 500 };

describe("boundsOfBox", () => {
    it("is the axis-aligned bounds of the rotated box", () => {
        expect(boundsOfBox({ cx: 100, cy: 50, w: 40, h: 20, rotation: 0 })).toEqual({ left: 80, right: 120, top: 40, bottom: 60 });
        const turned = boundsOfBox({ cx: 100, cy: 50, w: 40, h: 20, rotation: Math.PI / 2 });
        expect(turned.left).toBeCloseTo(90, 9);
        expect(turned.right).toBeCloseTo(110, 9);
        expect(turned.top).toBeCloseTo(30, 9);
        expect(turned.bottom).toBeCloseTo(70, 9);
    });
});

describe("snapMove", () => {
    const targets = frameSnapTargets(frame);

    it("snaps the box centre to the frame centre lines and reports both guides", () => {
        // Box 100×50 whose centre is (503, 247): 3 px and 3 px off the centre lines.
        const out = snapMove({ left: 453, right: 553, top: 222, bottom: 272 }, targets, SNAP_THRESHOLD_PX);
        expect(out.dx).toBeCloseTo(-3, 9);
        expect(out.dy).toBeCloseTo(3, 9);
        expect(out.guides).toEqual([{ axis: "x", pos: 500 }, { axis: "y", pos: 250 }]);
    });

    it("snaps box edges to frame edges, not centres to edges", () => {
        const out = snapMove({ left: 4, right: 104, top: 100, bottom: 150 }, targets, 6);
        expect(out.dx).toBeCloseTo(-4, 9);
        expect(out.dy).toBe(0);
        expect(out.guides).toEqual([{ axis: "x", pos: 0 }]);
        const right = snapMove({ left: 893, right: 995, top: 100, bottom: 150 }, targets, 6);
        expect(right.dx).toBeCloseTo(5, 9);
        expect(right.guides).toEqual([{ axis: "x", pos: 1000 }]);
        // A centre 4 px from the left edge does not snap to it.
        const centreNearEdge = snapMove({ left: -46, right: 54, top: 100, bottom: 150 }, targets, 6);
        expect(centreNearEdge.dx).toBe(0);
        expect(centreNearEdge.guides).toEqual([]);
    });

    it("stays free outside the threshold", () => {
        const out = snapMove({ left: 300, right: 400, top: 100, bottom: 150 }, targets, 6);
        expect(out).toEqual({ dx: 0, dy: 0, guides: [] });
    });

    it("picks the nearest feature and lights every line that matches after the snap", () => {
        // Item 200..300: the box's left edge (296) is 4 px from the item's right edge (300); its centre (346)
        // is 4 px from nothing on x. Width 100 also lines the right edge up with nothing.
        const items = itemSnapTargets([{ left: 200, right: 300, top: 0, bottom: 40 }]);
        const all = mergeSnapTargets(targets, items);
        const out = snapMove({ left: 296, right: 396, top: 300, bottom: 340 }, all, 6);
        expect(out.dx).toBeCloseTo(4, 9);
        expect(out.guides).toEqual([{ axis: "x", pos: 300 }]);
        // Equal widths: left↔left and right↔right both match: one snap, two guides.
        const same = snapMove({ left: 203, right: 303, top: 300, bottom: 340 }, all, 6);
        expect(same.dx).toBeCloseTo(-3, 9);
        expect(same.guides).toEqual([{ axis: "x", pos: 200 }, { axis: "x", pos: 250 }, { axis: "x", pos: 300 }]);
        const nearest = snapMove({ left: 2, right: 102, top: 300, bottom: 340 }, mergeSnapTargets(targets, itemSnapTargets([{ left: 105, right: 205, top: 0, bottom: 10 }])), 6);
        expect(nearest.dx).toBeCloseTo(-2, 9);
    });

    it("translates bounds", () => {
        expect(translateBounds({ left: 1, right: 2, top: 3, bottom: 4 }, 10, 20)).toEqual({ left: 11, right: 12, top: 23, bottom: 24 });
    });
});
