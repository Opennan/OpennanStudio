import { describe, expect, it } from "vitest";
import { channelOut, evaluate, paramsOf, type Channel } from "./expr";
import { EFFECT_CATEGORIES, EFFECTS, builtinEffectDefs, effectById, effectParams } from "./effects";

const W = 20;
const H = 12;
const frame = Uint8Array.from({ length: W * H * 4 }, (_, i) => (i * 37 + (i >> 5) * 11) % 256);

function runPass(id: string, params: Record<string, number>, T: number): Uint8Array {
    const effect = effectById(id)!;
    let input = frame;
    for (const pass of effect.passes ?? []) {
        const out = new Uint8Array(input.length);
        const src = input;
        for (let y = 0; y < H; y += 1) {
            for (let x = 0; x < W; x += 1) {
                for (let ch = 0; ch < 3; ch += 1) {
                    const value = evaluate(channelOut(pass.channel(ch as Channel)), { X: x, Y: y, W, H, T, params, read: (_s, c, xi, yi) => src[(yi * W + xi) * 4 + c] });
                    expect(Number.isFinite(value), `${id} ch${ch}`).toBe(true);
                    out[(y * W + x) * 4 + ch] = Math.trunc(value);
                }
                out[(y * W + x) * 4 + 3] = src[(y * W + x) * 4 + 3];
            }
        }
        input = out;
    }
    return input;
}

describe("effects", () => {
    it("ships 20 effects with unique ids in five categories", () => {
        expect(EFFECTS).toHaveLength(20);
        expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(20);
        for (const category of EFFECT_CATEGORIES) expect(EFFECTS.some((e) => e.category === category)).toBe(true);
        for (const effect of EFFECTS) expect(Boolean(effect.passes) !== Boolean(effect.lut), effect.id).toBe(true);
    });

    it("declares every parameter its passes read, with defaults inside the ranges", () => {
        for (const effect of EFFECTS) {
            const keys = effect.params.map((p) => p.key);
            for (const p of effect.params) expect(p.default >= p.min && p.default <= p.max, `${effect.id}.${p.key}`).toBe(true);
            for (const pass of effect.passes ?? []) {
                for (const ch of [0, 1, 2] as Channel[]) for (const name of paramsOf(pass.channel(ch))) expect(keys, effect.id).toContain(name);
            }
        }
    });

    for (const effect of EFFECTS.filter((e) => e.passes)) {
        it(`${effect.id} renders finite levels at several times`, () => {
            const params = effectParams(effect, null);
            for (const T of [0, 0.37, 2]) expect(runPass(effect.id, params, T).length).toBe(frame.length);
        });
    }

    it("is the identity at zero intensity where documented", () => {
        for (const id of ["fx_blur", "fx_zoom_blur", "fx_rgb_split", "fx_film_grain", "fx_flash", "fx_strobe", "fx_shake", "fx_zoom_pulse"]) {
            const effect = effectById(id)!;
            expect(runPass(id, { ...effectParams(effect, null), amount: 0 }, 0.5), id).toEqual(frame);
        }
    });

    it("clamps stack row params and falls back to defaults", () => {
        const effect = effectById("fx_kaleidoscope")!;
        expect(effectParams(effect, '{"segments":40,"speed":true}')).toEqual({ segments: 12, speed: 1 });
        expect(effectParams(effect, "not json")).toEqual({ segments: 6, speed: 0.2 });
    });

    it("bakes static color effects into LUT functions", () => {
        const bw = effectById("fx_black_white")!.lut!({ contrast: 0 });
        const [r, g, b] = bw([0.8, 0.2, 0.1]);
        expect(r).toBeCloseTo(g, 12);
        expect(g).toBeCloseTo(b, 12);
        const sepia = effectById("fx_sepia")!.lut!({ amount: 0 });
        expect(sepia([0.3, 0.4, 0.5])).toEqual([0.3, 0.4, 0.5]);
    });

    it("lists built-ins as effect catalog rows", () => {
        const defs = builtinEffectDefs();
        expect(defs).toHaveLength(20);
        expect(defs.every((d) => d.kind === "effect" && d.ownerScope === "builtin")).toBe(true);
    });
});
