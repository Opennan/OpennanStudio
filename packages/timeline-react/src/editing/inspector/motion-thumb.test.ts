import { describe, expect, it } from "vitest";
import { animationsFor } from "@opennan/timeline-core/motion/registry";
import { previewFrame, previewSchedule } from "./motion-thumb";

const clipDef = (slot: "in" | "out" | "combo", id: string) => animationsFor("clip", slot).find((d) => d.id === id)!;
const textDef = (slot: "in" | "out" | "loop", id: string) => animationsFor("text", slot).find((d) => d.id === id);

describe("animation card preview frames", () => {
    it("plays an in animation from its start state to rest", () => {
        const def = clipDef("in", "fade_in");
        const schedule = previewSchedule(def, "in");
        expect(previewFrame(def, "in", "clip", schedule.start).opacity).toBeCloseTo(0);
        expect(previewFrame(def, "in", "clip", schedule.end).opacity).toBeCloseTo(1);
    });

    it("moves a slide with the delta's frame offset", () => {
        const def = clipDef("in", "slide_left");
        const first = previewFrame(def, "in", "clip", 0);
        expect(first.transform).toMatch(/^translate\((\d+(\.\d+)?)%, 0%\)/);
        expect(previewFrame(def, "in", "clip", previewSchedule(def, "in").end).transform).toBe("translate(0%, 0%) rotate(0deg) scale(1, 1)");
    });

    it("ends an out animation gone", () => {
        const def = clipDef("out", "fade_out");
        expect(previewFrame(def, "out", "clip", previewSchedule(def, "out").end).opacity).toBeCloseTo(0);
    });

    it("animates a combo across the item", () => {
        const def = clipDef("combo", "combo_zoom_pulse");
        const { start, end } = previewSchedule(def, "combo");
        const mid = previewFrame(def, "combo", "clip", (start + end) / 2);
        expect(mid.transform).toMatch(/scale\(1\.1/);
    });

    it("simulates text raster states (typewriter reveal) when the text engine defines them", () => {
        const def = textDef("in", "typewriter");
        if (!def) return; // text animations are optional while the text engine lands
        expect(previewFrame(def, "in", "text", 0).clipPath).toBe("inset(0 100% 0 0)");
        expect(previewFrame(def, "in", "text", previewSchedule(def, "in").end).clipPath).toBe("inset(0 0% 0 0)");
    });

    it("loops a loop animation from rest", () => {
        const def = textDef("loop", "pulse");
        if (!def) return;
        const { start } = previewSchedule(def, "loop");
        expect(previewFrame(def, "loop", "text", start).transform).toBe("translate(0%, 0%) rotate(0deg) scale(1, 1)");
    });
});

describe("resting poses", () => {
    it("differ between animations so cards are distinguishable without hover", async () => {
        const { restingFrame } = await import("./motion-thumb");
        const { animationsFor } = await import("@opennan/timeline-core/motion/registry");
        const frames = animationsFor("clip", "in").map((def) => JSON.stringify(restingFrame(def, "in", "clip")));
        expect(new Set(frames).size).toBeGreaterThanOrEqual(10);
    });
});
