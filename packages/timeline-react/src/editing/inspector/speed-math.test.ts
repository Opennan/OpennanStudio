import { describe, expect, it } from "vitest";
import {
    addCurvePoint, curvePolyline, isDragOut, moveCurvePoint, normToSpeed, removeCurvePoint, roundSpeed, sliderToSpeed, speedToNorm, speedToSlider,
} from "./speed-math";

describe("speed slider log scale", () => {
    it("maps 0..1 to 0.1x..100x logarithmically with 1x at one third", () => {
        expect(sliderToSpeed(0)).toBe(0.1);
        expect(sliderToSpeed(1)).toBe(100);
        expect(sliderToSpeed(1 / 3)).toBe(1);
        expect(sliderToSpeed(2 / 3)).toBe(10);
    });

    it("inverts and clamps", () => {
        for (const s of [0.1, 0.5, 1, 2, 10, 100]) expect(sliderToSpeed(speedToSlider(s))).toBeCloseTo(s, 5);
        expect(speedToSlider(0.01)).toBe(0);
        expect(speedToSlider(500)).toBe(1);
    });

    it("rounds to readable steps and snaps near 1x", () => {
        expect(roundSpeed(0.123)).toBe(0.12);
        expect(roundSpeed(3.456)).toBe(3.5);
        expect(roundSpeed(42.4)).toBe(42);
        expect(roundSpeed(1.02)).toBe(1);
        expect(roundSpeed(0.98)).toBe(1);
    });
});

describe("curve editor math", () => {
    const flat: Array<[number, number]> = [[0, 1], [0.5, 1], [1, 1]];

    it("maps speed to a log axis (0.1 → 0, 1 → 0.5, 10 → 1)", () => {
        expect(speedToNorm(0.1)).toBeCloseTo(0);
        expect(speedToNorm(1)).toBeCloseTo(0.5);
        expect(speedToNorm(10)).toBeCloseTo(1);
        expect(normToSpeed(0.75)).toBeCloseTo(Math.sqrt(10));
        expect(normToSpeed(2)).toBe(10);
    });

    it("adds a point in x order, up to 10", () => {
        expect(addCurvePoint(flat, 0.25, 2)).toEqual({ points: [[0, 1], [0.25, 2], [0.5, 1], [1, 1]], index: 1 });
        const ten = Array.from({ length: 10 }, (_, i) => [i / 9, 1] as [number, number]);
        expect(addCurvePoint(ten, 0.5, 2)).toBeNull();
        expect(addCurvePoint(flat, 0, 2)).toBeNull();
        expect(addCurvePoint(flat, 1, 2)).toBeNull();
    });

    it("removes interior points only, keeping at least 2", () => {
        expect(removeCurvePoint(flat, 1)).toEqual([[0, 1], [1, 1]]);
        expect(removeCurvePoint(flat, 0)).toBeNull();
        expect(removeCurvePoint(flat, 2)).toBeNull();
        expect(removeCurvePoint([[0, 1], [1, 1]], 1)).toBeNull();
    });

    it("pins the ends to x = 0 and 1 and keeps interior points between their neighbours", () => {
        expect(moveCurvePoint(flat, 0, 0.3, 4)).toEqual([[0, 4], [0.5, 1], [1, 1]]);
        expect(moveCurvePoint(flat, 2, 0.3, 0.05)).toEqual([[0, 1], [0.5, 1], [1, 0.1]]);
        expect(moveCurvePoint(flat, 1, 1.4, 20)).toEqual([[0, 1], [1, 10], [1, 1]]);
        expect(moveCurvePoint([[0, 1], [0.2, 1], [0.6, 1], [1, 1]], 2, 0.1, 1)[2][0]).toBe(0.2);
    });

    it("detects a drag out of the graph for interior points", () => {
        expect(isDragOut({ x: 50, y: -40 }, { width: 200, height: 100 })).toBe(true);
        expect(isDragOut({ x: 50, y: 50 }, { width: 200, height: 100 })).toBe(false);
        expect(isDragOut({ x: 250, y: 50 }, { width: 200, height: 100 })).toBe(true);
    });

    it("draws the polyline in a box with y on the log axis", () => {
        expect(curvePolyline([[0, 0.1], [1, 10]], 100, 50)).toBe("0,50 100,0");
        expect(curvePolyline([[0, 1], [1, 1]], 100, 50)).toBe("0,25 100,25");
    });
});
