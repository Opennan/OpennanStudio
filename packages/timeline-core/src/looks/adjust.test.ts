import { describe, expect, it } from "vitest";
import {
    ADJUSTMENT_KEYS, DEFAULT_ADJUSTMENTS, adjustPixel, applyAdjustmentPatch, isPointwiseNeutral, itemAdjustments, legacyClipFields,
    parseAdjustments, serializeAdjustments, type Adjustments,
} from "./adjust";

const close = (a: number[], b: number[], eps = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) <= eps);

describe("adjustments", () => {
    it("has 13 controls with neutral defaults", () => {
        expect(ADJUSTMENT_KEYS).toHaveLength(13);
        expect(Object.values(DEFAULT_ADJUSTMENTS).every((x) => x === 0)).toBe(true);
    });

    it("parses garbage as defaults and clamps ranges", () => {
        expect(parseAdjustments(null)).toEqual(DEFAULT_ADJUSTMENTS);
        expect(parseAdjustments("{not json")).toEqual(DEFAULT_ADJUSTMENTS);
        expect(parseAdjustments("[1,2]")).toEqual(DEFAULT_ADJUSTMENTS);
        const parsed = parseAdjustments(JSON.stringify({ exposure: 4, sharpen: -1, grain: 0.5, tint: "x", bogus: 3 }));
        expect(parsed.exposure).toBe(1);
        expect(parsed.sharpen).toBe(0);
        expect(parsed.grain).toBe(0.5);
        expect(parsed.tint).toBe(0);
        expect("bogus" in parsed).toBe(false);
    });

    it("serializes only non-default values and null when neutral", () => {
        expect(serializeAdjustments(DEFAULT_ADJUSTMENTS)).toBeNull();
        expect(serializeAdjustments({ ...DEFAULT_ADJUSTMENTS, vignette: 0.3 })).toBe('{"vignette":0.3}');
    });

    it("applies patches: a number sets, null resets one key", () => {
        const base: Adjustments = { ...DEFAULT_ADJUSTMENTS, exposure: 0.2, fade: 0.4 };
        expect(applyAdjustmentPatch(base, { exposure: null, shadows: -0.5 })).toEqual({ ...DEFAULT_ADJUSTMENTS, fade: 0.4, shadows: -0.5 });
    });

    it("reads clip brightness/contrast/saturation from the legacy fields and the rest from JSON", () => {
        const clip = { brightness: 0.1, contrast: 1.5, saturation: 0.5, adjustmentsJson: '{"contrast":-1,"exposure":0.25}' };
        const a = itemAdjustments(clip, "clip");
        expect(a.brightness).toBe(0.1);
        expect(a.contrast).toBe(0.5);
        expect(a.saturation).toBe(-0.5);
        expect(a.exposure).toBe(0.25);
        expect(itemAdjustments({ adjustmentsJson: '{"contrast":-0.25}' }, "scene").contrast).toBe(-0.25);
        expect(legacyClipFields({ ...DEFAULT_ADJUSTMENTS, contrast: 0.5, saturation: -1, brightness: 0.2 })).toEqual({ brightness: 0.2, contrast: 1.5, saturation: 0 });
    });

    it("is the identity when every pointwise control is neutral", () => {
        expect(isPointwiseNeutral(DEFAULT_ADJUSTMENTS)).toBe(true);
        expect(isPointwiseNeutral({ ...DEFAULT_ADJUSTMENTS, sharpen: 1, vignette: 1, grain: 1 })).toBe(true);
        expect(isPointwiseNeutral({ ...DEFAULT_ADJUSTMENTS, fade: 0.1 })).toBe(false);
        for (const rgb of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.9], [0.7, 0.1, 0.3]]) {
            expect(close(adjustPixel(rgb as [number, number, number], DEFAULT_ADJUSTMENTS), rgb)).toBe(true);
        }
    });

    it("moves pixels in the expected direction for each control", () => {
        const gray: [number, number, number] = [0.5, 0.5, 0.5];
        const color: [number, number, number] = [0.6, 0.4, 0.3];
        const at = (patch: Partial<Adjustments>, rgb = gray) => adjustPixel(rgb, { ...DEFAULT_ADJUSTMENTS, ...patch });
        expect(at({ exposure: 0.5 })[0]).toBeGreaterThan(0.5);
        expect(at({ brightness: -0.5 })[0]).toBeLessThan(0.5);
        expect(at({ contrast: 0.5 }, [0.8, 0.8, 0.8])[0]).toBeGreaterThan(0.8);
        expect(at({ temperature: 0.5 })[0]).toBeGreaterThan(at({ temperature: 0.5 })[2]);
        expect(at({ tint: 0.5 })[1]).toBeLessThan(0.5);
        expect(at({ highlights: -0.8 }, [0.9, 0.9, 0.9])[0]).toBeLessThan(0.9);
        expect(at({ shadows: 0.8 }, [0.1, 0.1, 0.1])[0]).toBeGreaterThan(0.1);
        const desat = at({ saturation: -1 }, color);
        expect(Math.abs(desat[0] - desat[2])).toBeLessThan(1e-9);
        expect(at({ vibrance: 1 }, color)[0] - at({ vibrance: 1 }, color)[2]).toBeGreaterThan(0.3);
        expect(at({ fade: 1 }, [0, 0, 0])[0]).toBeGreaterThan(0.05);
        for (const key of ADJUSTMENT_KEYS) {
            for (const value of [-1, 1]) {
                const out = at({ [key]: value } as Partial<Adjustments>, color);
                expect(out.every((x) => x >= 0 && x <= 1)).toBe(true);
            }
        }
    });
});
