import { describe, expect, it } from "vitest";
import { itemLook, lookFunctionPixel, maskLook, type LookSource } from "./look-plan";

const clip = (over: Partial<LookSource> = {}): LookSource => ({ kind: "clip", brightness: 0, contrast: 1, saturation: 1, ...over });

describe("itemLook", () => {
    it("is null for a neutral item", () => {
        expect(itemLook(clip())).toBeNull();
        expect(itemLook({ kind: "scene" })).toBeNull();
        expect(itemLook(clip({ visualFilter: "none", adjustmentsJson: "{}" }))).toBeNull();
    });

    it("bakes filter and pointwise adjustments into one LUT step, keyed by their values", () => {
        const plan = itemLook(clip({ visualFilter: "teal_orange", filterIntensity: 0.5, contrast: 1.2 }))!;
        expect(plan.steps.map((s) => s.kind)).toEqual(["lut"]);
        const other = itemLook(clip({ visualFilter: "teal_orange", filterIntensity: 0.6, contrast: 1.2 }))!;
        expect(plan.steps[0].kind === "lut" && other.steps[0].kind === "lut" && plan.steps[0].key !== other.steps[0].key).toBe(true);
    });

    it("treats a legacy filter without intensity as full strength", () => {
        const plan = itemLook(clip({ visualFilter: "cinematic" }))!;
        const step = plan.steps[0];
        expect(step.kind).toBe("lut");
        expect(step.kind === "lut" && step.key).toContain("cinematic@1");
    });

    it("orders lut, sharpen, vignette, grain, then enabled effects by order", () => {
        const plan = itemLook({
            kind: "scene",
            adjustmentsJson: JSON.stringify({ exposure: 0.2, sharpen: 0.5, vignette: 0.4, grain: 0.3 }),
            effects: [
                { id: "e2", effectId: "fx_blur", order: 2, paramsJson: null, enabled: true },
                { id: "e1", effectId: "fx_sepia", order: 1, paramsJson: '{"amount":0.5}', enabled: true },
                { id: "e3", effectId: "fx_glitch", order: 0, paramsJson: null, enabled: false },
                { id: "e4", effectId: "cloud_only_effect", order: 3, paramsJson: null, enabled: true },
            ],
        })!;
        expect(plan.steps.map((s) => s.kind)).toEqual(["lut", "sharpen", "vignette", "grain", "lut", "pass", "pass"]);
        expect(plan.unknownEffects).toEqual(["cloud_only_effect"]);
        expect(plan.animated).toBe(true);
    });

    it("composes filter then adjust in the LUT function", () => {
        const plan = itemLook(clip({ visualFilter: "mono", filterIntensity: 1, brightness: 0.5 }))!;
        const step = plan.steps[0];
        if (step.kind !== "lut") throw new Error("expected lut");
        const out = lookFunctionPixel(step, [0.2, 0.5, 0.8]);
        expect(out[0]).toBeCloseTo(out[1], 9);
        expect(out[0]).toBeGreaterThan(0.45);
    });
});

describe("itemLook masks (phase 10c)", () => {
    const circle = '{"shape":"circle","x":0.4,"width":0.5,"height":0.5}';

    it("a neutral look with a mask is a plan of one mask step (every pipeline renders it)", () => {
        const plan = itemLook({ kind: "scene", maskJson: circle })!;
        expect(plan.steps.map((s) => s.kind)).toEqual(["mask"]);
        const step = plan.steps[0];
        expect(step.kind === "mask" && step.mask.shape).toBe("circle");
        expect(step.kind === "mask" && step.animated).toBe(false);
        expect(plan.animated).toBe(false);
    });

    it("the mask runs last, after the look and the effects", () => {
        const plan = itemLook({
            kind: "clip", trackType: "video", visualFilter: "teal_orange", adjustmentsJson: '{"vignette":0.4}', maskJson: circle,
            effects: [{ id: "e", effectId: "fx_rgb_split", order: 0, paramsJson: null, enabled: true }],
        })!;
        expect(plan.steps.map((s) => s.kind)).toEqual(["lut", "vignette", "pass", "mask"]);
    });

    it("mask keyframes make the step (and the plan) animated and are part of its key; other keyframes are not", () => {
        const keyframesJson = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2, scale: 1 }, { time: 1, mask_x: 0.8, scale: 2 }] });
        const plan = itemLook({ kind: "scene", maskJson: circle, keyframesJson })!;
        const step = plan.steps[0];
        expect(step.kind === "mask" && step.animated).toBe(true);
        expect(plan.animated).toBe(true);
        const scaleOnly = itemLook({ kind: "scene", maskJson: circle, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 1 }, { time: 1, scale: 3 }] }) })!;
        const still = itemLook({ kind: "scene", maskJson: circle })!;
        expect(scaleOnly.steps[0].kind === "mask" && still.steps[0].kind === "mask" && scaleOnly.steps[0].key === still.steps[0].key).toBe(true);
        expect(step.kind === "mask" && still.steps[0].kind === "mask" && step.key !== still.steps[0].key).toBe(true);
    });

    it("audio, effect, and graphics clips take no mask; garbage is no mask", () => {
        for (const trackType of ["audio", "effect", "remotion"]) expect(itemLook({ kind: "clip", trackType, maskJson: circle })).toBeNull();
        expect(itemLook({ kind: "clip", trackType: "video", maskJson: "{oops" })).toBeNull();
        expect(itemLook({ kind: "clip", trackType: "video", maskJson: circle })!.steps.map((s) => s.kind)).toEqual(["mask"]);
    });

    it("text and stickers take a mask (phase 10d); maskLook is the mask alone (text draws no look)", () => {
        for (const trackType of ["text", "sticker"]) expect(itemLook({ kind: "clip", trackType, maskJson: circle })!.steps.map((s) => s.kind)).toEqual(["mask"]);
        const text = { kind: "clip" as const, trackType: "text", visualFilter: "teal_orange", maskJson: circle, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.1 }, { time: 1, mask_x: 0.9 }] }) };
        const only = maskLook(text)!;
        expect(only.steps.map((s) => s.kind)).toEqual(["mask"]);
        expect(only.animated).toBe(true);
        expect(only.unknownEffects).toEqual([]);
        expect(maskLook({ kind: "clip", trackType: "text", visualFilter: "teal_orange" })).toBeNull();
        expect(maskLook({ kind: "clip", trackType: "audio", maskJson: circle })).toBeNull();
    });
});
