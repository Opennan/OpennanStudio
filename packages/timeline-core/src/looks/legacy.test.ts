import { describe, expect, it } from "vitest";
import {
    avgBlurRadii, boxBlurReference, chromaKeyLevel, chromaKeyReference, chromaKeyUv, eqApply, eqPlane, eqPlanes, eqReference, legacyOpsEmpty,
    legacyPlaneModes, legacyReference, rgbToYuv601,
    yuvToRgb601,
} from "./legacy";

const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i += 1) out.set(rgba, i * 4);
    return out;
};

describe("legacy clip filters (references of the GPU passes)", () => {
    it("converts RGB and BT.601 limited-range YUV both ways", () => {
        expect(rgbToYuv601(255, 255, 255)).toEqual([235, 128, 128]);
        expect(rgbToYuv601(0, 0, 0)).toEqual([16, 128, 128]);
        expect(rgbToYuv601(255, 0, 0)).toEqual([81, 90, 240]);
        expect(yuvToRgb601(235, 128, 128)).toEqual([255, 255, 255]);
        expect(yuvToRgb601(16, 128, 128)).toEqual([0, 0, 0]);
        // A round trip moves a colour by at most a couple of levels.
        for (const c of [[12, 200, 77], [255, 128, 0], [90, 90, 90]] as const) {
            const back = yuvToRgb601(...rgbToYuv601(c[0], c[1], c[2]));
            back.forEach((v, i) => expect(Math.abs(v - c[i])).toBeLessThanOrEqual(2));
        }
    });

    it("computes eq's integer planes and applies them like lutyuv", () => {
        expect(eqPlane(1, 0)).toBeNull();
        // Multiply blend: brightness -0.08, contrast 1.15.
        expect(eqPlane(1.15, -0.08)).toEqual([4710, -40]);
        expect(eqPlanes({ brightness: 0, contrast: 1.25, saturation: 1.1 })).toEqual({ luma: [5120, -33], chroma: [4505, -13] });
        expect(eqApply(null, 77)).toBe(77);
        expect(eqApply([5120, -33], 200)).toBe(217);
        expect(eqApply([5120, -33], 250)).toBe(255);
        const frame = solid(2, 1, [40, 120, 200, 128]);
        expect(eqReference(frame, { luma: null, chroma: null })).toEqual(frame);
        const out = eqReference(frame, eqPlanes({ brightness: 0.08, contrast: 0.9, saturation: 1 }));
        expect(out[3]).toBe(128);
        expect(out[0]).toBeGreaterThan(40);
    });

    it("converts the key colour to chroma as vf_chromakey does", () => {
        expect(chromaKeyUv("0x00FF00")).toEqual({ u: 44, v: 21 });
        expect(chromaKeyUv("#00ff00")).toEqual({ u: 44, v: 21 });
        expect(chromaKeyUv("0x0000FF")).toEqual({ u: 255, v: 107 });
        // Unparsable colours key green (clip-params chromaKey's default).
        expect(chromaKeyUv("nope")).toEqual({ u: 44, v: 21 });
    });

    it("keys by the mean chroma distance with a hard edge or a blend ramp", () => {
        expect(chromaKeyLevel(0.05, 0.1, 0)).toBe(0);
        expect(chromaKeyLevel(0.15, 0.1, 0)).toBe(255);
        expect(chromaKeyLevel(0.15, 0.1, 0.1)).toBe(127);
        const key = { ...chromaKeyUv("0x00FF00"), similarity: 0.1, blend: 0 };
        const green = chromaKeyReference(solid(3, 3, [0, 255, 0, 255]), 3, 3, key, false);
        expect([...green].filter((_, i) => i % 4 === 3)).toEqual(Array(9).fill(0));
        const red = chromaKeyReference(solid(3, 3, [255, 0, 0, 10]), 3, 3, key, false);
        // The alpha is replaced (ffmpeg writes the alpha plane), the colour kept.
        expect([...red].filter((_, i) => i % 4 === 3)).toEqual(Array(9).fill(255));
        expect(red.subarray(0, 3)).toEqual(new Uint8Array([255, 0, 0]));
    });

    it("averages chroma over the 3×3 neighbourhood and per 2×2 block when subsampled", () => {
        // A 4×2 frame: left half green, right half red. Per pixel the boundary pixels mix; per block they do not.
        const w = 4;
        const h = 2;
        const frame = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) frame.set(x < 2 ? [0, 255, 0, 255] : [255, 0, 0, 255], (y * w + x) * 4);
        const key = { ...chromaKeyUv("0x00FF00"), similarity: 0.2, blend: 0.4 };
        const full = chromaKeyReference(frame, w, h, key, false);
        const sub = chromaKeyReference(frame, w, h, key, true);
        expect(full[3]).toBe(0);
        expect(full[1 * 4 + 3]).toBeGreaterThan(0);
        expect(sub[1 * 4 + 3]).toBe(full[1 * 4 + 3]);
        // A green/red split inside one block reads as one mixed chroma sample.
        const split = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) split.set(x % 2 === 0 ? [0, 255, 0, 255] : [255, 0, 0, 255], (y * w + x) * 4);
        const blocks = chromaKeyReference(split, w, h, key, true);
        expect(blocks[3]).toBe(blocks[4 + 3]);
    });

    it("limits the blur radius to half the smallest plane", () => {
        expect(avgBlurRadii(5, 16, 12, "rgb")).toEqual({ x: 5, y: 5 });
        expect(avgBlurRadii(7, 16, 12, "rgb")).toEqual({ x: 7, y: 6 });
        expect(avgBlurRadii(5, 16, 12, "yuv420")).toEqual({ x: 4, y: 3 });
        expect(avgBlurRadii(3.9, 31, 31, "yuv444")).toEqual({ x: 3, y: 3 });
    });

    it("blurs with a clamped box and a truncating mean (vf_avgblur)", () => {
        // One row of gray: the measured FFmpeg output for radius 1 and 2.
        const row = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 200];
        const frame = new Uint8Array(row.length * 4);
        row.forEach((v, i) => frame.set([v, v, v, 255], i * 4));
        const r1 = boxBlurReference(frame, row.length, 1, 1, "rgb");
        expect([...r1].filter((_, i) => i % 4 === 0)).toEqual([0, 0, 0, 0, 85, 85, 85, 0, 0, 0, 66, 133]);
        const r2 = boxBlurReference(frame, row.length, 1, 2, "rgb");
        expect([...r2].filter((_, i) => i % 4 === 0)).toEqual([0, 0, 0, 51, 51, 51, 51, 51, 0, 40, 80, 120]);
        // A corner impulse: 4 of the 9 clamped taps hit it.
        const corner = solid(6, 6, [0, 0, 0, 255]);
        corner.set([255, 255, 255, 255], 0);
        const out = boxBlurReference(corner, 6, 6, 1, "rgb");
        expect(out[0]).toBe(113);
        expect(out[4]).toBe(56);
        expect(out[3]).toBe(255);
    });

    it("blurs alpha too and keeps flat frames flat in every plane mode", () => {
        const frame = solid(8, 6, [30, 140, 220, 200]);
        for (const mode of ["rgb", "yuv444", "yuv420"] as const) {
            const out = boxBlurReference(frame, 8, 6, 2, mode);
            const first = [...out.subarray(0, 4)];
            for (let i = 0; i < 48; i += 1) expect([...out.subarray(i * 4, i * 4 + 4)]).toEqual(first);
            expect(first[3]).toBe(200);
        }
        const edge = solid(8, 2, [0, 0, 0, 0]);
        for (let y = 0; y < 2; y += 1) for (let x = 4; x < 8; x += 1) edge.set([0, 0, 0, 255], (y * 8 + x) * 4);
        const blurred = boxBlurReference(edge, 8, 2, 1, "rgb");
        expect(blurred[3 * 4 + 3]).toBe(85);
    });
});

describe("legacy plane modes (ffmpeg's format negotiation)", () => {
    it("keeps a lone blur on the input's planes", () => {
        expect(legacyPlaneModes("yuv420", { chromaKey: false, eq: false, yuva444Fades: false })).toEqual({ blur: "yuv420", subsampled: true });
        expect(legacyPlaneModes("rgb", { chromaKey: false, eq: false, yuva444Fades: false })).toEqual({ blur: "rgb", subsampled: false });
    });

    it("pulls the blur into YUV for chroma key, eq, and alpha fades", () => {
        expect(legacyPlaneModes("rgb", { chromaKey: true, eq: false, yuva444Fades: false })).toEqual({ blur: "yuv444", subsampled: false });
        expect(legacyPlaneModes("rgb", { chromaKey: false, eq: true, yuva444Fades: false })).toEqual({ blur: "yuv444", subsampled: false });
        expect(legacyPlaneModes("yuv420", { chromaKey: true, eq: true, yuva444Fades: false })).toEqual({ blur: "yuv420", subsampled: true });
        expect(legacyPlaneModes("yuv420", { chromaKey: false, eq: false, yuva444Fades: true })).toEqual({ blur: "yuv444", subsampled: false });
        expect(legacyPlaneModes("rgb", { chromaKey: false, eq: false, yuva444Fades: true })).toEqual({ blur: "yuv444", subsampled: false });
    });

    it("runs the chain in order and treats empty ops as nothing", () => {
        expect(legacyOpsEmpty(null)).toBe(true);
        expect(legacyOpsEmpty({ blur: null, chromaKey: null, eq: { luma: null, chroma: null } })).toBe(true);
        const frame = solid(4, 4, [0, 255, 0, 255]);
        const ops = { blur: { radius: 1, mode: "rgb" as const }, chromaKey: { key: { ...chromaKeyUv("0x00FF00"), similarity: 0.1, blend: 0 }, subsampled: false }, eq: null };
        expect(legacyOpsEmpty(ops)).toBe(false);
        expect(legacyReference(frame, 4, 4, ops)[3]).toBe(0);
    });
});

describe("a clip's legacy ops", () => {
    it("reads the clip fields as the export does and scales the blur for other draw sizes", async () => {
        const { clipLegacyOps, legacyMediaInput } = await import("./legacy");
        expect(clipLegacyOps({}, { input: "rgb" })).toBeNull();
        expect(clipLegacyOps({ blurStrength: 0.9 }, { input: "rgb" })).toBeNull();
        expect(clipLegacyOps({ blurStrength: "6.7", chromaKeyEnabled: "true", chromaKeyColor: "bad", blendMode: "Multiply" }, { input: "yuv420" })).toEqual({
            blur: { radius: 6, mode: "yuv420" },
            chromaKey: { key: { u: 44, v: 21, similarity: 0.1, blend: 0 }, subsampled: true },
            eq: { luma: [4710, -40], chroma: null },
        });
        expect(clipLegacyOps({ blurStrength: 6 }, { input: "rgb", radiusScale: 0.1 })!.blur).toEqual({ radius: 1, mode: "rgb" });
        expect(legacyMediaInput("/m/a.mp4?x=1", true)).toBe("yuv420");
        expect(legacyMediaInput("/m/a.gif", true)).toBe("rgb");
        expect(legacyMediaInput("/m/a.PNG", false)).toBe("rgb");
        expect(legacyMediaInput("/m/a.jpg", false)).toBe("yuv420");
    });
});
