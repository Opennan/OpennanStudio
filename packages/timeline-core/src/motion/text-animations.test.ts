import { evaluateScalar, n } from "../looks/expr";
import { TEXT_ANIMATIONS, textAnimationById } from "./text-animations";
import type { MotionDelta } from "./types";

const IN = ["fade", "pop", "slide_up", "slide_down", "slide_left", "slide_right", "typewriter", "zoom", "blur_in", "bounce", "wipe", "letter_rise"];
const OUT = ["fade", "shrink", "slide_up", "slide_down", "slide_left", "slide_right", "typewriter_erase", "zoom", "blur_out", "bounce", "wipe", "letter_fall"];
const LOOP = ["pulse", "shake", "float", "glow", "flicker", "swing"];
const NEUTRAL = { opacity: 1, scale: 1, scaleX: 1, dx: 0, dy: 0, rotation: 0 } as const;

function valuesAt(delta: (u: ReturnType<typeof n>) => MotionDelta, u: number) {
    const d = delta(n(u));
    const out: Record<string, number> = { ...NEUTRAL };
    for (const [key, expr] of Object.entries(d)) out[key] = evaluateScalar(expr!, 0);
    return out;
}

describe("text animations", () => {
    it("has 12 in, 12 out, and 6 loop animations of kind text", () => {
        const bySlot = (slot: string) => TEXT_ANIMATIONS.filter((a) => a.slot === slot).map((a) => a.id);
        expect(bySlot("in")).toEqual(IN);
        expect(bySlot("out")).toEqual(OUT);
        expect(bySlot("loop")).toEqual(LOOP);
        expect(TEXT_ANIMATIONS).toHaveLength(30);
        expect(TEXT_ANIMATIONS.every((a) => a.kind === "text")).toBe(true);
        expect(textAnimationById("out", "fade")?.slot).toBe("out");
        expect(textAnimationById("in", "letter_fall")).toBeUndefined();
    });

    it("marks raster animations", () => {
        const raster = Object.fromEntries(TEXT_ANIMATIONS.filter((a) => a.raster).map((a) => [`${a.slot}:${a.id}`, a.raster]));
        expect(raster).toEqual({
            "in:typewriter": "typewriter", "in:blur_in": "blur", "in:wipe": "wipe", "in:letter_rise": "letter_rise",
            "out:typewriter_erase": "typewriter_erase", "out:blur_out": "blur", "out:wipe": "wipe", "out:letter_fall": "letter_fall",
            "loop:glow": "glow",
        });
    });

    it("rests at the window edge that touches the rest of the clip", () => {
        for (const a of TEXT_ANIMATIONS) {
            const u = a.slot === "in" ? 1 : 0;
            const values = valuesAt(a.delta, u);
            for (const [key, value] of Object.entries(NEUTRAL)) expect(values[key], `${a.slot}:${a.id}:${key}`).toBeCloseTo(value, 12);
        }
    });

    it("loops are continuous across the period and move inside it", () => {
        for (const a of TEXT_ANIMATIONS.filter((x) => x.slot === "loop" && !x.raster)) {
            const end = valuesAt(a.delta, 1 - 1e-9);
            for (const [key, value] of Object.entries(NEUTRAL)) expect(end[key], `${a.id}:${key}`).toBeCloseTo(value, 5);
            const moved = Array.from({ length: 100 }, (_, i) => i / 100).some((u) => Object.entries(valuesAt(a.delta, u)).some(([k, v]) => Math.abs(v - NEUTRAL[k as keyof typeof NEUTRAL]) > 1e-3));
            expect(moved, a.id).toBe(true);
        }
    });

    it("in and out transforms start away from rest, and evaluate finite everywhere", () => {
        for (const a of TEXT_ANIMATIONS) {
            for (let i = -2; i <= 52; i += 1) {
                const values = valuesAt(a.delta, i / 50);
                for (const value of Object.values(values)) expect(Number.isFinite(value), `${a.id} ${i}`).toBe(true);
            }
            if (a.slot === "loop" || ["typewriter", "wipe", "letter_rise", "typewriter_erase", "letter_fall"].includes(a.id)) continue;
            const edge = valuesAt(a.delta, a.slot === "in" ? 0 : 1);
            const away = Object.entries(edge).some(([k, v]) => Math.abs(v - NEUTRAL[k as keyof typeof NEUTRAL]) > 1e-3);
            expect(away, `${a.slot}:${a.id}`).toBe(true);
        }
    });

    it("keeps slides small (frame fractions) and fades with them", () => {
        for (const id of ["slide_up", "slide_down", "slide_left", "slide_right"]) {
            const start = valuesAt(textAnimationById("in", id)!.delta, 0);
            expect(Math.max(Math.abs(start.dx), Math.abs(start.dy)), id).toBeLessThanOrEqual(0.1);
            expect(start.opacity, id).toBe(0);
        }
        expect(valuesAt(textAnimationById("in", "slide_up")!.delta, 0).dy).toBeGreaterThan(0);
        expect(valuesAt(textAnimationById("out", "slide_up")!.delta, 1).dy).toBeLessThan(0);
        expect(valuesAt(textAnimationById("in", "slide_left")!.delta, 0).dx).toBeGreaterThan(0);
    });
});
