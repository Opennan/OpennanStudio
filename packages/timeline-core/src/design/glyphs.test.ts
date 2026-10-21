// packages/timeline-core/src/design/glyphs.test.ts
import { glyphLibrary, layoutText } from "./glyphs";
import type { TextLayer } from "./model";
import { testDesign } from "./test-design";

const textOf = (id: string, patch: Partial<TextLayer> = {}) => {
    const d = testDesign();
    const l = d.layers.find((x) => x.id === id) as TextLayer;
    return { d, layer: { ...l, ...patch } as TextLayer };
};

describe("layoutText", () => {
    it("draws unchanged text as the original word", () => {
        const { d, layer } = textOf("coins-text");
        expect(layoutText(layer, glyphLibrary(d))).toEqual({ mode: "original" });
    });

    it("rebuilds edited text from its own cells, centred in the box", () => {
        const { d, layer } = textOf("coins-text", { text: "15,420" });
        const out = layoutText(layer, glyphLibrary(d));
        expect(out.mode).toBe("glyphs");
        if (out.mode !== "glyphs") return;
        expect(out.cells.map((c) => c.src)).toEqual(["g0_0.png", "g0_4.png", "g0_2.png", "g0_3.png", "g0_1.png", "g0_5.png"]);
        expect(out.width).toBe(102);
        expect(out.cells[0].x).toBe(-1); // (100 − 102) / 2
    });

    it("borrows a cell from the same style group", () => {
        const { d, layer } = textOf("coins-text", { text: "38" });
        const out = layoutText(layer, glyphLibrary(d));
        expect(out.mode === "glyphs" && out.cells.map((c) => c.src)).toEqual(["g1_0.png", "g1_1.png"]);
    });

    it("falls back to the font and names missing characters", () => {
        const { d, layer } = textOf("coins-text", { text: "97" });
        expect(layoutText(layer, glyphLibrary(d))).toEqual({ mode: "font", missing: ["9", "7"] });
    });

    it("spaces cells by their ink and the word's letter gap when known", () => {
        const { d, layer } = textOf("coins-text", { text: "21" });
        // each 17 px cell holds 9 px of ink starting 4 px in; the word's letter gap is 3 px
        layer.original = { ...layer.original, gap: 3, glyphs: layer.original.glyphs!.map((g) => ({ ...g, ink: { x: 4, w: 9 } })) };
        d.layers[2] = layer;
        const out = layoutText(layer, glyphLibrary(d));
        expect(out.mode).toBe("glyphs");
        if (out.mode !== "glyphs") return;
        expect(out.width).toBe(21); // 9 + 3 + 9
        // ink starts at (100 − 21) / 2 = 39.5; the cell is drawn 4 px left of its ink
        expect(out.cells.map((c) => c.x)).toEqual([35.5, 47.5]);
    });

    it("uses the font when lettering is forced", () => {
        const { d, layer } = textOf("coins-text", { lettering: "font" });
        expect(layoutText(layer, glyphLibrary(d))).toEqual({ mode: "font", missing: [] });
    });

    it("does not borrow across a different colour", () => {
        const { d } = textOf("coins-text");
        (d.layers[3] as TextLayer).style.fill = "#d4a017";
        const layer = { ...(d.layers[2] as TextLayer), text: "8" };
        expect(layoutText(layer, glyphLibrary(d))).toEqual({ mode: "font", missing: ["8"] });
    });
});
