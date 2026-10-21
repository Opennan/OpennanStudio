// packages/timeline-core/src/design/summary.test.ts
import { describeDesign } from "./summary";
import { applyDesignOps } from "./ops";
import { testDesign } from "./test-design";

describe("describeDesign", () => {
    it("lists groups and layers with rounded bounds and lettering", () => {
        const d = applyDesignOps(testDesign(), [{ op: "set_text", target: "385", text: "97" }]).design;
        const s = describeDesign(d);
        expect(s.size).toEqual({ width: 400, height: 300 });
        expect(s.groups).toEqual([{ id: "coins", layers: ["pill", "coins-text"], bounds: { x: 50, y: 10, w: 200, h: 60 } }]);
        expect(s.layers.find((l) => l.id === "level")).toEqual({
            id: "level", kind: "text", text: "97", lettering: "font", missingGlyphs: ["9", "7"], bounds: { x: 300, y: 25, w: 60, h: 30 }, visible: true,
        });
        expect(s.layers.find((l) => l.id === "bg")).toMatchObject({ kind: "image", locked: true });
    });
});
