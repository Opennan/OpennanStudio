import { parsePreviewTextStyle } from "../lib/preview-text-draw";
import { parseTimelineTextStyle } from "../lib/timeline-text-style";
import { TEXT_ANIMATIONS } from "../motion/text-animations";
import { fontByFamily, nearestWeight, primaryFontFamily } from "./fonts";
import { TEXT_TEMPLATES, templateStyleJson, textTemplateById } from "./templates";

const IDS = [
    "plain", "title_bold", "subtitle_clean", "lower_third", "caption_pill", "tiktok_bold", "yellow_pop", "boxed_white",
    "neon_pink", "neon_cyan", "soft_glow", "outline_thick", "drop_shadow", "long_shadow", "gradient_sunset", "gradient_ocean",
    "handwritten_caveat", "script_dancing", "poster_bebas", "comic_bangers",
];

describe("text templates", () => {
    it("has the twenty catalog templates in order", () => {
        expect(TEXT_TEMPLATES.map((t) => t.id)).toEqual(IDS);
        expect(textTemplateById("neon_pink")?.category).toBe("neon");
        expect(textTemplateById("nope")).toBeUndefined();
    });

    it("covers every category", () => {
        expect(new Set(TEXT_TEMPLATES.map((t) => t.category))).toEqual(new Set(["basic", "social", "neon", "outline", "gradient", "handwritten", "display"]));
    });

    it("uses only bundled families at bundled weights", () => {
        for (const template of TEXT_TEMPLATES) {
            const family = primaryFontFamily(String(template.style.fontFamily));
            const font = fontByFamily(family);
            expect(font, template.id).toBeDefined();
            const weight = Number(template.style.fontWeight ?? 400);
            expect(nearestWeight(font!, weight), template.id).toBe(weight);
        }
    });

    it("parses to valid draw styles with default text", () => {
        for (const template of TEXT_TEMPLATES) {
            const style = parsePreviewTextStyle(JSON.stringify(template.style));
            expect(style.captionKind, template.id).toBe("text");
            expect(style.fontSize, template.id).toBeGreaterThanOrEqual(40);
            expect(template.defaultText.length, template.id).toBeGreaterThan(0);
            expect(template.style.captionKind, template.id).toBeUndefined();
        }
        expect(parsePreviewTextStyle(JSON.stringify(textTemplateById("neon_cyan")!.style)).glowSize).toBeGreaterThan(0);
        expect(parsePreviewTextStyle(JSON.stringify(textTemplateById("gradient_sunset")!.style)).gradient).not.toBeNull();
        expect(parsePreviewTextStyle(JSON.stringify(textTemplateById("caption_pill")!.style)).bgRadius).toBeGreaterThan(0);
        expect(parsePreviewTextStyle(JSON.stringify(textTemplateById("lower_third")!.style)).bgColor).not.toBe("");
    });

    it("references only known text animations", () => {
        const known = new Set(TEXT_ANIMATIONS.map((a) => `${a.slot}:${a.id}`));
        for (const template of TEXT_TEMPLATES) {
            const a = template.animation;
            if (!a) continue;
            if (a.in) expect(known.has(`in:${a.in.id}`), template.id).toBe(true);
            if (a.out) expect(known.has(`out:${a.out.id}`), template.id).toBe(true);
            if (a.loop) expect(known.has(`loop:${a.loop.id}`), template.id).toBe(true);
        }
    });

    it("applies a template keeping the prior caption kind and position", () => {
        const prior = JSON.stringify({ captionKind: "caption", textClipKind: "caption", captionPosition: "top", wordsPerLine: "single", maxWidthRatio: 0.7, fontSize: 10, color: "#123" });
        const applied = parseTimelineTextStyle(templateStyleJson("yellow_pop", prior));
        expect(applied).toMatchObject({ captionKind: "caption", textClipKind: "caption", captionPosition: "top", wordsPerLine: "single", maxWidthRatio: 0.7 });
        expect(applied.color).toBe(textTemplateById("yellow_pop")!.style.color);
        const plain = parseTimelineTextStyle(templateStyleJson("yellow_pop", JSON.stringify({ fontSize: 10, maxWidthRatio: 0.5 })));
        expect(plain.captionKind).toBeUndefined();
        expect(plain.maxWidthRatio).toBe(0.5);
        expect(templateStyleJson("missing")).toBeNull();
        expect(JSON.parse(templateStyleJson("plain")!)).toEqual(textTemplateById("plain")!.style);
    });
});
