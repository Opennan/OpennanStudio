import { describe, expect, it } from "vitest";
import {
    GRAIN_MARGIN, convolutionOptions, convolve3x3Reference, grainImage, grainOffset, grainWindow, grainmergeReference, multiplyReference,
    sharpenFilters, sharpenKernel, vignetteLevel, vignetteMask,
} from "./spatial";

describe("spatial adjustments", () => {
    it("pads a replicated border around the convolution so every ffmpeg version sees the same edges", () => {
        expect(sharpenFilters(sharpenKernel(1)!)).toEqual([
            "pad=w=iw+2:h=ih+2:x=1:y=1",
            "fillborders=left=1:right=1:top=1:bottom=1:mode=smear",
            "convolution=0m='0 -12 0 -12 64 -12 0 -12 0':0rdiv=0.0625:1m='0 -12 0 -12 64 -12 0 -12 0':1rdiv=0.0625:2m='0 -12 0 -12 64 -12 0 -12 0':2rdiv=0.0625",
            "crop=w=iw-2:h=ih-2:x=1:y=1:exact=1",
        ]);
    });

    it("builds an integer sharpen kernel and its convolution options", () => {
        expect(sharpenKernel(0)).toBeNull();
        const k = sharpenKernel(0.5)!;
        expect(k.matrix).toEqual([0, -6, 0, -6, 40, -6, 0, -6, 0]);
        expect(k.matrix.reduce((a, b) => a + b, 0)).toBe(16);
        expect(convolutionOptions(k)).toBe("0m='0 -6 0 -6 40 -6 0 -6 0':0rdiv=0.0625:1m='0 -6 0 -6 40 -6 0 -6 0':1rdiv=0.0625:2m='0 -6 0 -6 40 -6 0 -6 0':2rdiv=0.0625");
    });

    it("leaves flat areas alone and boosts edges when sharpening", () => {
        const w = 6, h = 4;
        const frame = new Uint8Array(w * h * 3).fill(100);
        for (let y = 0; y < h; y += 1) for (let x = 3; x < w; x += 1) frame.fill(200, (y * w + x) * 3, (y * w + x) * 3 + 3);
        const out = convolve3x3Reference(frame, w, h, 3, sharpenKernel(1)!);
        expect(out[0]).toBe(100);
        expect(out[2 * 3]).toBeLessThan(100);
        expect(out[3 * 3]).toBeGreaterThan(200);
    });

    it("darkens corners more than the center", () => {
        expect(vignetteLevel(50, 50, 101, 101, 1)).toBe(255);
        expect(vignetteLevel(0, 0, 101, 101, 1)).toBeLessThan(80);
        expect(vignetteLevel(0, 0, 101, 101, 0)).toBe(255);
        const mask = vignetteMask(8, 6, 0.6);
        expect(mask.length).toBe(48);
        expect(multiplyReference(new Uint8Array([255, 128, 0]), new Uint8Array([128]), 3)).toEqual(new Uint8Array([128, 64, 0]));
    });

    it("makes deterministic grain centered on 128 and moves the window over time", () => {
        const a = grainImage(10, 8, 1);
        expect(a.width).toBe(10 + GRAIN_MARGIN);
        expect(grainImage(10, 8, 1).data).toEqual(a.data);
        const mean = a.data.reduce((s, x) => s + x, 0) / a.data.length;
        expect(Math.abs(mean - 128)).toBeLessThan(2);
        expect(grainImage(4, 4, 0).data.every((x) => x === 128)).toBe(true);
        expect(grainOffset(0)).toEqual({ x: 0, y: 0 });
        expect(grainOffset(1 / 24)).toEqual({ x: 37, y: 23 });
        expect(grainWindow(a, 10, 8, 0)).toEqual(Uint8Array.from({ length: 80 }, (_, i) => a.data[Math.floor(i / 10) * a.width + (i % 10)]));
        expect(grainmergeReference(new Uint8Array([250, 5, 100, 77]), new Uint8Array([140]), 4)).toEqual(new Uint8Array([255, 17, 112, 77]));
    });
});
