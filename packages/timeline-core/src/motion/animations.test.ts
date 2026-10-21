import { describe, expect, it } from "vitest";
import { evaluateScalar, v, walk, type Expr } from "../looks/expr";
import { CLIP_ANIMATIONS } from "./animations";
import type { AnimationDef, MotionDelta } from "./types";

const IN_IDS = ["fade_in", "zoom_in", "zoom_out", "slide_left", "slide_right", "slide_up", "slide_down", "rotate_in", "spin_in", "bounce_in", "swing_in", "flip_in"];
const OUT_IDS = [
    "fade_out", "zoom_in_out", "zoom_out_out", "slide_left_out", "slide_right_out", "slide_up_out", "slide_down_out",
    "rotate_out", "spin_out", "bounce_out", "swing_out", "flip_out",
];
const COMBO_IDS = ["combo_zoom_pulse", "combo_rotate_zoom", "combo_swing", "combo_shake", "combo_wobble", "combo_spin_shrink", "combo_bounce", "combo_flip"];

const FACTORS = ["opacity", "scale", "scaleX"] as const;
const OFFSETS = ["dx", "dy", "rotation"] as const;

/** Delta values at progress u (missing channels neutral). */
function at(def: AnimationDef, u: number): Record<(typeof FACTORS)[number] | (typeof OFFSETS)[number], number> {
    const delta: MotionDelta = def.delta(v("T"));
    const value = (e: Expr | undefined, neutral: number) => (e ? evaluateScalar(e, u) : neutral);
    return {
        opacity: value(delta.opacity, 1), scale: value(delta.scale, 1), scaleX: value(delta.scaleX, 1),
        dx: value(delta.dx, 0), dy: value(delta.dy, 0), rotation: value(delta.rotation, 0),
    };
}

function expectNeutral(def: AnimationDef, u: number) {
    const values = at(def, u);
    for (const ch of FACTORS) expect(values[ch], `${def.id} ${ch} at ${u}`).toBeCloseTo(1, 9);
    expect(values.dx, `${def.id} dx at ${u}`).toBeCloseTo(0, 9);
    expect(values.dy, `${def.id} dy at ${u}`).toBeCloseTo(0, 9);
    // Full turns are at rest (spin combos end on a whole turn).
    const turn = ((values.rotation % 360) + 540) % 360 - 180;
    expect(turn, `${def.id} rotation at ${u}`).toBeCloseTo(0, 9);
}

const byId = (id: string) => CLIP_ANIMATIONS.find((def) => def.id === id)!;
const grid = Array.from({ length: 201 }, (_, i) => i / 200);

describe("clip animations", () => {
    it("has the catalog's 12 in, 12 out, and 8 combo animations", () => {
        const ids = (slot: string) => CLIP_ANIMATIONS.filter((def) => def.slot === slot).map((def) => def.id);
        expect(ids("in")).toEqual(IN_IDS);
        expect(ids("out")).toEqual(OUT_IDS);
        expect(ids("combo")).toEqual(COMBO_IDS);
        expect(ids("loop")).toEqual([]);
        expect(CLIP_ANIMATIONS.every((def) => def.kind === "clip" && def.raster === undefined)).toBe(true);
        expect(CLIP_ANIMATIONS.filter((def) => def.slot !== "combo").every((def) => def.defaultDuration === 0.5)).toBe(true);
    });

    it("in animations end at rest, out animations start at rest, combos rest at both ends", () => {
        for (const def of CLIP_ANIMATIONS) {
            if (def.slot === "in") expectNeutral(def, 1);
            if (def.slot === "out") expectNeutral(def, 0);
            if (def.slot === "combo") {
                expectNeutral(def, 0);
                expectNeutral(def, 1);
            }
        }
    });

    it("every animation moves and stays finite on a grid", () => {
        for (const def of CLIP_ANIMATIONS) {
            let moved = false;
            for (const u of grid) {
                const values = at(def, u);
                for (const value of Object.values(values)) expect(Number.isFinite(value), `${def.id} at ${u}`).toBe(true);
                if (FACTORS.some((ch) => Math.abs(values[ch] - 1) > 1e-3) || OFFSETS.some((ch) => Math.abs(values[ch]) > 1e-3)) moved = true;
            }
            expect(moved, def.id).toBe(true);
        }
    });

    it("uses only scalar IR (time, numbers, functions: no pixels, parameters, or bindings)", () => {
        for (const def of CLIP_ANIMATIONS) {
            const delta = def.delta(v("T"));
            for (const expr of Object.values(delta)) {
                walk(expr!, (node) => {
                    expect(["num", "var", "bin", "call", "if"], def.id).toContain(node.k);
                    if (node.k === "var") expect(node.name).toBe("T");
                });
            }
        }
    });

    it("looks like CapCut: start states and directions", () => {
        expect(at(byId("fade_in"), 0).opacity).toBe(0);
        expect(at(byId("zoom_in"), 0).scale).toBeCloseTo(0.4, 9);
        expect(at(byId("zoom_out"), 0).scale).toBeCloseTo(1.6, 9);
        expect(at(byId("slide_left"), 0).dx).toBeCloseTo(0.6, 9); // enters from the right, moving left
        expect(at(byId("slide_right"), 0).dx).toBeCloseTo(-0.6, 9);
        expect(at(byId("slide_up"), 0).dy).toBeCloseTo(0.6, 9); // from below, moving up
        expect(at(byId("slide_down"), 0).dy).toBeCloseTo(-0.6, 9);
        expect(at(byId("rotate_in"), 0).rotation).toBeCloseTo(-90, 9);
        expect(at(byId("rotate_in"), 0).opacity).toBe(0);
        expect(at(byId("spin_in"), 0).rotation).toBeCloseTo(-360, 9);
        expect(at(byId("spin_in"), 0).scale).toBeLessThan(0.5);
        expect(at(byId("flip_in"), 0).scaleX).toBeCloseTo(0, 9);
        expect(Math.max(...grid.map((u) => at(byId("bounce_in"), u).scale))).toBeGreaterThan(1.1);
        const swing = grid.map((u) => at(byId("swing_in"), u).rotation);
        expect(Math.min(...swing)).toBeLessThan(-10);
        expect(Math.max(...swing)).toBeGreaterThan(1);
        // In animations decelerate: more than half the travel is done at half the window.
        expect(at(byId("slide_left"), 0.5).dx).toBeLessThan(0.3);
    });

    it("out animations exit in the direction of their name", () => {
        expect(at(byId("fade_out"), 1).opacity).toBeCloseTo(0, 9);
        expect(at(byId("zoom_in_out"), 1).scale).toBeCloseTo(1.6, 9);
        expect(at(byId("zoom_in_out"), 1).opacity).toBeCloseTo(0, 9);
        expect(at(byId("zoom_out_out"), 1).scale).toBeCloseTo(0.4, 9);
        expect(at(byId("slide_left_out"), 1).dx).toBeCloseTo(-0.6, 9);
        expect(at(byId("slide_right_out"), 1).dx).toBeCloseTo(0.6, 9);
        expect(at(byId("slide_up_out"), 1).dy).toBeCloseTo(-0.6, 9);
        expect(at(byId("slide_down_out"), 1).dy).toBeCloseTo(0.6, 9);
        expect(at(byId("rotate_out"), 1).rotation).toBeCloseTo(90, 9);
        expect(at(byId("spin_out"), 1).rotation).toBeCloseTo(360, 9);
        expect(at(byId("flip_out"), 1).scaleX).toBeCloseTo(0, 9);
        // Out animations accelerate: less than half the travel is done at half the window.
        expect(at(byId("slide_left_out"), 0.5).dx).toBeGreaterThan(-0.3);
    });

    it("combos have the documented shapes", () => {
        const pulse = grid.map((u) => at(byId("combo_zoom_pulse"), u).scale);
        expect(Math.max(...pulse)).toBeCloseTo(1.15, 6);
        const swing = grid.map((u) => at(byId("combo_swing"), u).rotation);
        expect(Math.max(...swing)).toBeCloseTo(8, 2);
        expect(Math.min(...swing)).toBeCloseTo(-8, 2);
        const shake = grid.map((u) => at(byId("combo_shake"), u).dx);
        expect(Math.max(...shake.map(Math.abs))).toBeGreaterThan(0.01);
        expect(Math.max(...shake.map(Math.abs))).toBeLessThan(0.05);
        expect(Math.abs(at(byId("combo_shake"), 0.01).dx)).toBeLessThan(0.005); // decays toward the ends
        expect(Math.min(...grid.map((u) => at(byId("combo_flip"), u).scaleX))).toBeCloseTo(-1, 6);
        expect(Math.min(...grid.map((u) => at(byId("combo_bounce"), u).dy))).toBeLessThan(-0.04);
        expect(Math.min(...grid.map((u) => at(byId("combo_spin_shrink"), u).scale))).toBeCloseTo(0.5, 6);
    });
});
