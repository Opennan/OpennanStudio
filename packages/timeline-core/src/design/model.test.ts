// packages/timeline-core/src/design/model.test.ts
import { groupIds, groupMembers, layerBounds, layerFrame } from "./model";
import { testDesign } from "./test-design";

describe("design model", () => {
    it("frames a layer at its box centre plus its offset", () => {
        const d = testDesign();
        const pill = d.layers.find((l) => l.id === "pill")!;
        expect(layerFrame(pill)).toEqual({ cx: 150, cy: 40, w: 200, h: 60, rotation: 0 });
        const moved = { ...pill, transform: { dx: 10, dy: -5, scale: 2, rotation: 90 } };
        expect(layerFrame(moved)).toEqual({ cx: 160, cy: 35, w: 400, h: 120, rotation: Math.PI / 2 });
    });

    it("bounds a rotated layer by its rotated corners", () => {
        const d = testDesign();
        const pill = { ...d.layers.find((l) => l.id === "pill")!, transform: { dx: 0, dy: 0, scale: 1, rotation: 90 } };
        const b = layerBounds(pill);
        expect(b.x).toBeCloseTo(120);
        expect(b.y).toBeCloseTo(-60);
        expect(b.w).toBeCloseTo(60);
        expect(b.h).toBeCloseTo(200);
    });

    it("lists groups in z order and their members", () => {
        const d = testDesign();
        expect(groupIds(d)).toEqual(["coins"]);
        expect(groupMembers(d, "coins").map((l) => l.id)).toEqual(["pill", "coins-text"]);
    });
});
