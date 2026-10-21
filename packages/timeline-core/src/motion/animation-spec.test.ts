import { describe, expect, it } from "vitest";
import { MIN_ANIMATION_SECONDS, parseAnimationSpec, resolveAnimationWindows, serializeAnimationSpec } from "./animation-spec";

describe("animation spec", () => {
    it("parses garbage as empty and keeps valid slots", () => {
        expect(parseAnimationSpec(null)).toEqual({});
        expect(parseAnimationSpec("not json")).toEqual({});
        expect(parseAnimationSpec("[1,2]")).toEqual({});
        expect(parseAnimationSpec('{"in":{"id":"fade_in","duration":0.4},"out":{"id":"","duration":1},"loop":{"id":"pulse","period":"x"}}')).toEqual({
            in: { id: "fade_in", duration: 0.4 },
            loop: { id: "pulse", period: 1 },
        });
    });

    it("drops in and out when a combo is set", () => {
        expect(parseAnimationSpec('{"in":{"id":"fade_in","duration":0.4},"combo":{"id":"combo_swing"}}')).toEqual({ combo: { id: "combo_swing" } });
    });

    it("serializes empty specs as null", () => {
        expect(serializeAnimationSpec({})).toBeNull();
        expect(serializeAnimationSpec({ in: { id: "fade_in", duration: 0.5 } })).toBe('{"in":{"id":"fade_in","duration":0.5}}');
    });

    it("clamps windows to the item so in and out never overlap", () => {
        const w = resolveAnimationWindows({ in: { id: "a", duration: 3 }, out: { id: "b", duration: 3 } }, 4);
        expect(w.in).toEqual({ id: "a", start: 0, end: 2 });
        expect(w.out).toEqual({ id: "b", start: 2, end: 4 });
        const short = resolveAnimationWindows({ in: { id: "a", duration: 0.01 } }, 4);
        expect(short.in!.end).toBe(MIN_ANIMATION_SECONDS);
        const combo = resolveAnimationWindows({ combo: { id: "c" } }, 4);
        expect(combo.combo).toEqual({ id: "c", start: 0, end: 4 });
        const loop = resolveAnimationWindows({ in: { id: "a", duration: 1 }, loop: { id: "l", period: 0.5 } }, 4);
        expect(loop.loop).toEqual({ id: "l", start: 1, end: 4, period: 0.5 });
    });
});
