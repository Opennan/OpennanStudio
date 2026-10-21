// packages/timeline-react/src/layer-editor/draw-design.test.ts
import { applyDesignOps } from "@opennan/timeline-core/design/ops";
import { testDesign } from "@opennan/timeline-core/design/test-design";
import { drawDesign } from "./draw-design";

function recorder() {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
        get(target, key: string) {
            if (key in target) return target[key];
            if (key === "measureText") return () => ({ width: 50, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 50, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 0 });
            return (...args: unknown[]) => calls.push(`${key}(${args.map((a) => (typeof a === "object" && a && "src" in a ? (a as { src: string }).src : String(a))).join(",")})`);
        },
        set(target, key: string, value) {
            target[key] = value;
            return true;
        },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const images = { get: (src: string) => ({ src }) as unknown as CanvasImageSource };

describe("drawDesign", () => {
    it("draws visible layers bottom first, text from the original word", () => {
        const { ctx, calls } = recorder();
        drawDesign(ctx, testDesign(), images);
        const draws = calls.filter((c) => c.startsWith("drawImage"));
        expect(draws[0]).toBe("drawImage(bg.png,-200,-150,400,300)");
        expect(draws[1]).toBe("drawImage(pill.png,-100,-30,200,60)");
        expect(draws[2]).toBe("drawImage(w0.png,-54,-19,108,38)");
    });

    it("rebuilds edited text from cells and falls back to the font", () => {
        const d = applyDesignOps(testDesign(), [
            { op: "set_text", target: "12,450", text: "21" },
            { op: "set_text", target: "385", text: "9" },
        ]).design;
        const { ctx, calls } = recorder();
        drawDesign(ctx, d, images);
        // "21" = cells "2","1" (17 px each), centred in the 100 px box: start 33, box left −50 → x −17; y = −15 − 4
        expect(calls).toContain("drawImage(g0_1.png,-17,-19,17,38)");
        expect(calls).toContain("drawImage(g0_0.png,0,-19,17,38)");
        expect(calls.some((c) => c.startsWith("fillText(9,"))).toBe(true);
    });

    it("skips hidden layers and the layer being edited", () => {
        const d = applyDesignOps(testDesign(), [{ op: "set_visible", target: "pill", visible: false }]).design;
        const { ctx, calls } = recorder();
        drawDesign(ctx, d, images, { skip: new Set(["coins-text"]) });
        expect(calls.some((c) => c.includes("pill.png"))).toBe(false);
        expect(calls.some((c) => c.includes("w0.png"))).toBe(false);
    });
});
