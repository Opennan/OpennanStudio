// packages/timeline-react/src/layer-editor/selection.test.ts
import { testDesign } from "@opennan/timeline-core/design/test-design";
import { selectionFrame, selectionLayers, type Selection } from "./selection";

describe("selection", () => {
    it("resolves a group to its members and frames their bounds", () => {
        const d = testDesign();
        const sel: Selection = { kind: "group", id: "coins" };
        expect(selectionLayers(d, sel).map((l) => l.id)).toEqual(["pill", "coins-text"]);
        expect(selectionFrame(d, sel)).toEqual({ cx: 150, cy: 40, w: 200, h: 60, rotation: 0 });
    });

    it("frames a single rotated layer in its own rotated frame", () => {
        const d = testDesign();
        d.layers[1].transform.rotation = 30;
        expect(selectionFrame(d, { kind: "layer", id: "pill" })?.rotation).toBeCloseTo(Math.PI / 6);
    });

    it("returns null for a selection that no longer exists", () => {
        expect(selectionFrame(testDesign(), { kind: "layer", id: "gone" })).toBeNull();
    });
});
