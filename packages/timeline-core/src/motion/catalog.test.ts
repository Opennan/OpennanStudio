import { describe, expect, it } from "vitest";
import { motionCatalog } from "./catalog";

describe("motion catalog", () => {
    it("lists every animation, easing, speed preset, template, font, caption style, and sticker category", () => {
        const c = motionCatalog();
        const count = (kind: string, slot: string) => c.animations.filter((a) => a.kind === kind && a.slot === slot).length;
        expect([count("clip", "in"), count("clip", "out"), count("clip", "combo")]).toEqual([12, 12, 8]);
        expect([count("text", "in"), count("text", "out"), count("text", "loop")]).toEqual([12, 12, 6]);
        expect(c.easings).toEqual(["linear", "ease_in", "ease_out", "ease_in_out", "hold", "bezier"]);
        expect(c.speedCurves.map((s) => s.id)).toEqual(["montage", "hero", "bullet", "jump_cut", "flash_in", "flash_out"]);
        expect(c.textTemplates).toHaveLength(20);
        expect(c.fonts).toHaveLength(12);
        expect(c.captionStyles).toHaveLength(8);
        expect(c.stickerCategories.length).toBeGreaterThan(5);
        expect(c.keyframeChannels).toContain("adj_exposure");
        expect(c.animations.every((a) => a.name.length > 0)).toBe(true);
        expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    });
});
