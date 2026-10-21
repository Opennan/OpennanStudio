import {
    ATTRIBUTE_KINDS, MASK_KEYFRAME_CHANNELS, MASK_SHAPE_IDS, CAPTION_STYLE_IDS, EASING_IDS, KEYFRAME_CHANNELS, SPEED_CURVE_IDS, STICKER_CATEGORY_IDS, TEXT_FONT_FAMILIES, TEXT_TEMPLATE_CATEGORIES,
    TEXT_TEMPLATE_IDS,
} from "@opennan/mcp-schema";
import { ATTRIBUTE_KINDS as CORE_ATTRIBUTE_KINDS } from "@opennan/timeline-core/attributes/attributes";
import { MASK_KEYFRAME_CHANNELS as CORE_MASK_CHANNELS, MASK_SHAPES } from "@opennan/timeline-core/looks/masks";
import { motionCatalog } from "@opennan/timeline-core/motion/catalog";
import { createFixtureStudio } from "../testing/fixture";
import { MOTION_CASES } from "../testing/cases/motion";
import { isTextStyleColor, MOTION_HANDLERS } from "./motion";
import type { ToolContext } from "./types";
import { roundTrip } from "../testing/roundtrip";

describe("motion tool enums", () => {
    it("match the timeline-core motion catalog", () => {
        const catalog = motionCatalog();
        expect([...TEXT_TEMPLATE_IDS]).toEqual(catalog.textTemplates.map((t) => t.id));
        expect([...TEXT_TEMPLATE_CATEGORIES]).toEqual([...new Set(catalog.textTemplates.map((t) => t.category))]);
        expect([...TEXT_FONT_FAMILIES]).toEqual(catalog.fonts.map((f) => f.family));
        expect([...CAPTION_STYLE_IDS]).toEqual(catalog.captionStyles.map((s) => s.id));
        expect([...STICKER_CATEGORY_IDS]).toEqual(catalog.stickerCategories.map((c) => c.id));
        expect([...EASING_IDS]).toEqual(catalog.easings);
        expect([...KEYFRAME_CHANNELS]).toEqual([...catalog.keyframeChannels, ...CORE_MASK_CHANNELS]);
        expect([...MASK_KEYFRAME_CHANNELS]).toEqual([...CORE_MASK_CHANNELS]);
        expect([...MASK_SHAPE_IDS]).toEqual(["none", ...MASK_SHAPES]);
        expect([...ATTRIBUTE_KINDS]).toEqual([...CORE_ATTRIBUTE_KINDS]);
        expect([...SPEED_CURVE_IDS]).toEqual(["none", ...catalog.speedCurves.map((c) => c.id)]);
    });
});

describe("set_text_style validation", () => {
    it("accepts hex, numeric color functions, and basic names only", () => {
        for (const ok of ["#fff", "#FFFA", "#a1b2c3", "#a1b2c380", "rgb(255,0,0)", "rgb(100% 0% 0%)", "rgba(0, 0, 0, .5)", "rgb(0 0 0 / 50%)", "hsl(120, 50%, 50%)", "hsla(120deg 50% 50% / 0.3)", "white", "RED", "transparent"]) {
            expect(isTextStyleColor(ok), ok).toBe(true);
        }
        for (const bad of ["", "fff", "#ff", "#fffff", "#ggg", "red;", "rgb()", "rgb(a,b,c)", "rgb(1,2)", "hsl(1,2,3,4,5)", "url(x)", "var(--c)", "currentColor", "chartreuse-ish", "rgb(1,2,3) red"]) {
            expect(isTextStyleColor(bad), bad).toBe(false);
        }
    });

    it("enforces the size caps in the handler too (callers that skip the schema)", async () => {
        const studio = await createFixtureStudio();
        const context = { session: studio.session } as unknown as ToolContext;
        const call = (args: Record<string, unknown>) => MOTION_HANDLERS.set_text_style({ clip_id: "title", ...args }, context);
        for (const [arg, value] of [["font_size", 401], ["font_size", 0], ["stroke_width", 101], ["shadow_blur", 201], ["glow_size", 201], ["background_padding", 201], ["letter_spacing", -101], ["line_height", 5]] as const) {
            const outcome = await call({ [arg]: value });
            expect(outcome.ok, arg).toBe(false);
            expect(outcome.text, arg).toMatch(new RegExp(`${arg} must be`));
        }
        expect((await call({ color: "nope" })).ok).toBe(false);
        expect((await call({ font_size: 400, letter_spacing: -100 })).ok).toBe(true);
    });
});

roundTrip("text, animation, sticker, keyframe, keyframe retime, speed, and caption tools round-trip", MOTION_CASES);
