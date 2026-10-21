import { channelValueAt, channelValues, clipKeyframes, hasChannel, keyframeExpression } from "./keyframes";

const json = JSON.stringify([
    { time: 2, opacity: 1, scale: 2 },
    { time: 0, opacity: 0 },
    { time: 4, opacity: 0.5 },
]);

// Evaluates the subset of ffmpeg expression syntax keyframeExpression emits.
function evaluate(expression: string, t: number): number {
    const js = expression
        .replace(/\blte\(/g, "LTE(")
        .replace(/\bgte\(/g, "GTE(")
        .replace(/\blt\(/g, "LT(")
        .replace(/\bif\(/g, "IF(")
        .replace(/\bclip\(/g, "CLIP(")
        .replace(/\bt\b/g, `(${t})`);
    const IF = (c: number, a: number, b: number) => (c ? a : b);
    const LT = (a: number, b: number) => (a < b ? 1 : 0);
    const LTE = (a: number, b: number) => (a <= b ? 1 : 0);
    const GTE = (a: number, b: number) => (a >= b ? 1 : 0);
    const CLIP = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
    return new Function("IF", "LT", "LTE", "GTE", "CLIP", `return ${js};`)(IF, LT, LTE, GTE, CLIP) as number;
}

describe("keyframes", () => {
    const points = clipKeyframes(json);

    it("sorts points and reports channels", () => {
        expect(points.map((p) => p.time)).toEqual([0, 2, 4]);
        expect(hasChannel(points, "scale")).toBe(true);
        expect(hasChannel(points, "rotation_degrees")).toBe(false);
        expect(channelValues(points, "opacity")).toEqual([0, 1, 0.5]);
    });

    it("interpolates like the preview", () => {
        expect(channelValueAt(points, "opacity", -1, 9)).toBe(0);
        expect(channelValueAt(points, "opacity", 1, 9)).toBeCloseTo(0.5);
        expect(channelValueAt(points, "opacity", 3, 9)).toBeCloseTo(0.75);
        expect(channelValueAt(points, "opacity", 10, 9)).toBe(0.5);
        expect(channelValueAt(points, "rotation_degrees", 1, 9)).toBe(9);
    });

    it("emits the documented expression shape", () => {
        expect(keyframeExpression(points, "opacity", 1)).toBe(
            "if(lte(t,0),0,if(gte(t,4),0.5,if(lte(t,2),(0+(1*clip(((t-0)/2),0,1))),(1+((-0.5)*clip(((t-2)/2),0,1))))))",
        );
        expect(keyframeExpression(points, "scale", 1)).toBe("2");
        expect(keyframeExpression(points, "position_x", 0.25)).toBe("0.25");
        expect(keyframeExpression(points, "opacity", 1, "(in/30)")).toContain("lte((in/30),2)");
    });

    it("expression values equal channelValueAt", () => {
        const expression = keyframeExpression(points, "opacity", 1);
        for (const t of [-1, 0, 0.5, 1, 1.9, 2, 2.5, 3.3, 4, 7]) {
            expect(evaluate(expression, t)).toBeCloseTo(channelValueAt(points, "opacity", t, 1));
        }
    });

    it("eases segments with the motion module's curves (keyframes v2)", () => {
        const eased = clipKeyframes(JSON.stringify([{ time: 0, scale: 1, easing: 1 }, { time: 2, scale: 3, easing: 4 }, { time: 3, scale: 2 }]));
        expect(channelValueAt(eased, "scale", 1, 0)).toBeCloseTo(1.25, 12);
        expect(channelValueAt(eased, "scale", 2.5, 0)).toBe(3);
        const expression = keyframeExpression(eased, "scale", 1, "t");
        expect(expression).not.toContain("st(");
        for (const t of [-1, 0, 0.4, 1, 1.7, 2, 2.5, 2.99, 3, 4]) {
            expect(evaluate(expression, t)).toBeCloseTo(channelValueAt(eased, "scale", t, 1), 9);
        }
    });
});
