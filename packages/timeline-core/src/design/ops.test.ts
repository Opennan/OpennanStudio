// packages/timeline-core/src/design/ops.test.ts
import { applyDesignOps } from "./ops";
import type { TextLayer } from "./model";
import { testDesign } from "./test-design";

const layer = (d: ReturnType<typeof testDesign>, id: string) => d.layers.find((l) => l.id === id)!;

describe("applyDesignOps", () => {
    it("sets text by id or by current text, without touching the input", () => {
        const d = testDesign();
        const out = applyDesignOps(d, [{ op: "set_text", target: "12,450", text: "15,420" }]);
        expect((layer(out.design, "coins-text") as TextLayer).text).toBe("15,420");
        expect((layer(d, "coins-text") as TextLayer).text).toBe("12,450");
        expect(out.results).toEqual([{ index: 0, ok: true, layers: ["coins-text"] }]);
        expect(out.changed).toBe(true);
    });

    it("moves a whole group by an offset or to a centre", () => {
        const d = testDesign();
        const by = applyDesignOps(d, [{ op: "move", target: "coins", dx: 10, dy: 5 }]).design;
        expect(layer(by, "pill").transform).toMatchObject({ dx: 10, dy: 5 });
        expect(layer(by, "coins-text").transform).toMatchObject({ dx: 10, dy: 5 });
        const to = applyDesignOps(d, [{ op: "move", target: "pill", x: 200, y: 100 }]).design;
        expect(layer(to, "pill").transform).toMatchObject({ dx: 50, dy: 60 });
    });

    it("scales and rotates a group about its centre", () => {
        const d = testDesign();
        const out = applyDesignOps(d, [{ op: "scale", target: "coins", factor: 2 }]).design;
        // group centre (150, 40); text centre (150, 40) stays, pill centre (150, 40) stays, both double
        expect(layer(out, "pill").transform.scale).toBe(2);
        expect(layer(out, "coins-text").transform).toMatchObject({ dx: 0, dy: 0, scale: 2 });
        const rot = applyDesignOps(d, [{ op: "rotate", target: "coins", degrees: 90 }]).design;
        expect(layer(rot, "pill").transform.rotation).toBe(90);
    });

    it("reorders a group as a block", () => {
        const d = testDesign();
        const out = applyDesignOps(d, [{ op: "reorder", target: "coins", to: "front" }]).design;
        expect(out.layers.map((l) => l.id)).toEqual(["bg", "level", "pill", "coins-text"]);
        const back = applyDesignOps(d, [{ op: "reorder", target: "level", to: "back" }]).design;
        expect(back.layers.map((l) => l.id)).toEqual(["bg", "level", "pill", "coins-text"]); // never below a locked background
    });

    it("styles text, hides and fades layers", () => {
        const d = testDesign();
        const out = applyDesignOps(d, [
            { op: "set_style", target: "level", style: { fill: "#ff0000", lettering: "font" } },
            { op: "set_visible", target: "pill", visible: false },
            { op: "set_opacity", target: "coins", opacity: 0.5 },
        ]).design;
        expect((layer(out, "level") as TextLayer).style.fill).toBe("#ff0000");
        expect((layer(out, "level") as TextLayer).lettering).toBe("font");
        expect(layer(out, "pill").visible).toBe(false);
        expect(layer(out, "coins-text").opacity).toBe(0.5);
    });

    it("reports bad ops and keeps going", () => {
        const d = testDesign();
        const out = applyDesignOps(d, [
            { op: "set_text", target: "nope", text: "x" },
            { op: "set_text", target: "pill", text: "x" },
            { op: "move", target: "bg", dx: 5 },
            { op: "scale", target: "pill", factor: 0 },
            { op: "move", target: "level", dx: 1 },
        ]);
        expect(out.results.map((r) => r.ok)).toEqual([false, false, false, false, true]);
        expect(out.results[0].error).toBe('no layer, group or text "nope"; groups: coins; layers: pill, coins-text, level');
        expect(out.results[1].error).toBe('"pill" is an image layer; set_text needs a text layer');
        expect(out.results[2].error).toBe('"bg" is locked');
        expect(out.results[3].error).toBe("factor must be a positive number");
    });
});
