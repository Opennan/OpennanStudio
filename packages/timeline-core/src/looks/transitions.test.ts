import { describe, expect, it } from "vitest";
import { channelOut, emitGlsl, evaluate, xfadeExpression, type Channel } from "./expr";
import { TRANSITION_CATEGORIES, TRANSITION_IDS, TRANSITIONS, clampTransitionSeconds, transitionById } from "./transitions";

const W = 24;
const H = 14;
function frame(seed: number): Uint8Array {
    const out = new Uint8Array(W * H * 4);
    let s = seed;
    for (let i = 0; i < out.length; i += 1) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        out[i] = s % 256;
    }
    return out;
}
const a = frame(1);
const b = frame(2);

function render(id: string, p: number): Uint8Array {
    const def = transitionById(id)!;
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            for (let ch = 0 as Channel; ch < 4; ch = (ch + 1) as Channel) {
                const value = evaluate(channelOut(def.channel(ch)), {
                    X: x, Y: y, W, H, p,
                    read: (src, c, xi, yi) => (src === 0 ? a : b)[(yi * W + xi) * 4 + c],
                });
                out[(y * W + x) * 4 + ch] = Math.trunc(value);
            }
        }
    }
    return out;
}

describe("transitions", () => {
    it("ships 25 transitions with unique ids in five categories, keeping the pre-10a ids", () => {
        expect(TRANSITIONS).toHaveLength(25);
        expect(new Set(TRANSITION_IDS).size).toBe(25);
        for (const category of TRANSITION_CATEGORIES) expect(TRANSITIONS.some((t) => t.category === category)).toBe(true);
        for (const legacy of ["cross_dissolve", "dip_black", "dip_white", "slide_left", "slide_right", "slide_up", "slide_down", "wipe_left", "zoom_in", "blur_dissolve"]) {
            expect(transitionById(legacy), legacy).not.toBeNull();
        }
    });

    for (const def of TRANSITIONS) {
        it(`${def.id} is exactly A at p=0 and exactly B at p=1`, () => {
            expect(render(def.id, 0)).toEqual(a);
            expect(render(def.id, 1)).toEqual(b);
            const mid = render(def.id, 0.5);
            expect(mid.length).toBe(a.length);
        });
    }

    it("emits compact xfade expressions (under 8000 characters) and GLSL for every channel", () => {
        for (const def of TRANSITIONS) {
            const expression = xfadeExpression((ch) => def.channel(ch), 4);
            expect(expression.length, def.id).toBeLessThan(8000);
            for (const ch of [0, 1, 2, 3] as Channel[]) expect(emitGlsl(def.channel(ch)).expr.length).toBeGreaterThan(0);
        }
    });

    it("clamps durations to 0.1–2 s", () => {
        expect(clampTransitionSeconds(0.01)).toBe(0.1);
        expect(clampTransitionSeconds(5)).toBe(2);
        expect(clampTransitionSeconds(Number.NaN)).toBe(0.5);
    });
});
