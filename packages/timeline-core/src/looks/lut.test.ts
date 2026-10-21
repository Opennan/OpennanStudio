import { describe, expect, it } from "vitest";
import { HALD_LEVEL, applyHaldTrilinear, buildHaldClut, haldClutPng, haldIndex } from "./lut";

describe("Hald CLUT", () => {
    it("builds a level-8 table (512×512, red fastest)", () => {
        const clut = buildHaldClut((c) => c);
        expect(HALD_LEVEL).toBe(8);
        expect(clut.size).toBe(512);
        expect(clut.lutSize).toBe(64);
        expect(clut.rgb.length).toBe(512 * 512 * 3);
        // node (r=63, g=0, b=0) is pixel 63 of row 0
        expect([...clut.rgb.subarray(63 * 3, 63 * 3 + 3)]).toEqual([255, 0, 0]);
        // node (r=0, g=1, b=0) is pixel 64
        expect(haldIndex(0, 1, 0, 64)).toBe(64);
        expect([...clut.rgb.subarray(64 * 3, 64 * 3 + 3)]).toEqual([0, 4, 0]);
        expect(haldIndex(0, 0, 63, 64)).toBe(63 * 64 * 64);
    });

    it("maps every level through an identity table to itself or one below (lut3d truncates)", () => {
        const clut = buildHaldClut((c) => c);
        let exact = 0;
        for (let v = 0; v < 256; v += 1) {
            const [r, g, b] = applyHaldTrilinear(v, 255 - v, v, clut);
            expect(v - r).toBeGreaterThanOrEqual(0);
            expect(v - r).toBeLessThanOrEqual(1);
            expect(255 - v - g).toBeLessThanOrEqual(1);
            expect(b).toBe(r);
            if (r === v) exact += 1;
        }
        expect(exact).toBeGreaterThan(64);
    });

    it("interpolates linearly: half table equals half output", () => {
        const full = buildHaldClut((c) => [c[0] * 0.5, c[1] * 0.25 + 0.5, 1 - c[2]]);
        const [r, g, b] = applyHaldTrilinear(200, 100, 50, full);
        expect(Math.abs(r - 100)).toBeLessThanOrEqual(1);
        expect(Math.abs(g - (25 + 127.5))).toBeLessThanOrEqual(1.5);
        expect(Math.abs(b - 205)).toBeLessThanOrEqual(1);
    });

    it("encodes as a 512×512 RGB PNG", () => {
        const png = haldClutPng(buildHaldClut((c) => c));
        expect(png.length).toBeGreaterThan(512 * 512 * 3);
        expect([...png.subarray(1, 4)]).toEqual([80, 78, 71]);
    });
});
