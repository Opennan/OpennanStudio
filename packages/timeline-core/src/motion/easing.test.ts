import { describe, expect, it } from "vitest";
import { evaluateScalar, v } from "../looks/expr";
import { BEZIER_SEGMENTS, EASING_IDS, bezierTable, easeExpr, easeValue, easingCode, easingFromCode, normalizeBezier, type EasingId } from "./easing";

const U = v("T");

describe("easing", () => {
    it("has stable numeric codes for keyframe points", () => {
        expect(EASING_IDS).toEqual(["linear", "ease_in", "ease_out", "ease_in_out", "hold", "bezier"]);
        EASING_IDS.forEach((id, code) => {
            expect(easingCode(id)).toBe(code);
            expect(easingFromCode(code)).toBe(id);
        });
        expect(easingFromCode(undefined)).toBe("linear");
        expect(easingFromCode(99)).toBe("linear");
        expect(easingFromCode(2.4)).toBe("linear");
    });

    it("maps 0 to 0 and 1 to 1 for every easing but hold", () => {
        for (const id of EASING_IDS) {
            if (id === "hold") continue;
            expect(easeValue(id, 0)).toBeCloseTo(0, 12);
            expect(easeValue(id, 1)).toBeCloseTo(1, 12);
        }
        expect(easeValue("hold", 0)).toBe(0);
        expect(easeValue("hold", 0.999)).toBe(0);
        expect(easeValue("hold", 1)).toBe(1);
    });

    it("clamps progress outside 0..1", () => {
        expect(easeValue("ease_in", -1)).toBe(0);
        expect(easeValue("ease_out", 2)).toBe(1);
    });

    it("shapes in, out, and in-out like cubic curves", () => {
        expect(easeValue("ease_in", 0.5)).toBeCloseTo(0.125, 12);
        expect(easeValue("ease_out", 0.5)).toBeCloseTo(0.875, 12);
        expect(easeValue("ease_in_out", 0.5)).toBeCloseTo(0.5, 12);
        for (let i = 0; i <= 20; i += 1) {
            const u = i / 20;
            expect(easeValue("ease_in_out", u) + easeValue("ease_in_out", 1 - u)).toBeCloseTo(1, 12);
        }
    });

    it("tabulates bezier curves monotonically and evaluates the table exactly", () => {
        const table = bezierTable([0.42, 0, 0.58, 1]);
        expect(table).toHaveLength(BEZIER_SEGMENTS + 1);
        expect(table[0]).toEqual([0, 0]);
        expect(table[table.length - 1]).toEqual([1, 1]);
        for (let i = 1; i < table.length; i += 1) {
            expect(table[i][0]).toBeGreaterThan(table[i - 1][0]);
            expect(table[i][1]).toBeGreaterThanOrEqual(table[i - 1][1]);
        }
        // An ease-in-out bezier stays close to the cubic in-out.
        expect(Math.abs(easeValue("bezier", 0.25, [0.42, 0, 0.58, 1]) - 0.129)).toBeLessThan(0.02);
    });

    it("normalizes bezier handles into a valid range", () => {
        expect(normalizeBezier(undefined)).toEqual([0.25, 0.1, 0.25, 1]);
        expect(normalizeBezier([2, -3, -1, 5])).toEqual([1, -1, 0, 2]);
    });

    it("evaluates the same in JS and as an expression", () => {
        const cases: Array<[EasingId, [number, number, number, number] | undefined]> = [
            ["linear", undefined], ["ease_in", undefined], ["ease_out", undefined], ["ease_in_out", undefined], ["hold", undefined],
            ["bezier", [0.17, 0.67, 0.83, 0.67]], ["bezier", [0.68, -0.55, 0.27, 1.55]],
        ];
        for (const [id, handles] of cases) {
            const expr = easeExpr(id, U, handles);
            for (let i = -10; i <= 210; i += 1) {
                const u = i / 200;
                expect(evaluateScalar(expr, u)).toBeCloseTo(easeValue(id, u, handles), 12);
            }
        }
    });
});
