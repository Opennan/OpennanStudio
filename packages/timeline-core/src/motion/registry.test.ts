import { describe, expect, it } from "vitest";
import { CLIP_ANIMATIONS } from "./animations";
import { animationById, animationsFor, stickerLoopAnimations } from "./registry";
import { TEXT_ANIMATIONS } from "./text-animations";

describe("animation registry", () => {
    it("lists clip animations by slot", () => {
        expect(animationsFor("clip", "in")).toHaveLength(12);
        expect(animationsFor("clip", "out")).toHaveLength(12);
        expect(animationsFor("clip", "combo")).toHaveLength(8);
        expect(animationsFor("clip", "loop")).toEqual([]);
        expect(animationsFor("clip", "in").every((def) => CLIP_ANIMATIONS.includes(def))).toBe(true);
    });

    it("lists text animations from the text catalog", () => {
        for (const slot of ["in", "out", "combo", "loop"] as const) {
            expect(animationsFor("text", slot)).toEqual(TEXT_ANIMATIONS.filter((def) => def.slot === slot));
        }
    });

    it("gives stickers clip in, out, and combo plus the text loops without a raster part", () => {
        expect(animationsFor("sticker", "in")).toEqual(animationsFor("clip", "in"));
        expect(animationsFor("sticker", "out")).toEqual(animationsFor("clip", "out"));
        expect(animationsFor("sticker", "combo")).toEqual(animationsFor("clip", "combo"));
        const loops = TEXT_ANIMATIONS.filter((def) => def.slot === "loop" && def.raster === undefined);
        expect(stickerLoopAnimations()).toEqual(loops);
        expect(animationsFor("sticker", "loop")).toEqual(loops);
    });

    it("finds animations by kind, slot, and id", () => {
        expect(animationById("clip", "in", "zoom_in")?.id).toBe("zoom_in");
        expect(animationById("clip", "out", "zoom_in")).toBeUndefined();
        expect(animationById("sticker", "combo", "combo_flip")?.id).toBe("combo_flip");
        expect(animationById("clip", "in", "nope")).toBeUndefined();
        const textIn = TEXT_ANIMATIONS.find((def) => def.slot === "in");
        if (textIn) expect(animationById("text", "in", textIn.id)).toBe(textIn);
    });
});
