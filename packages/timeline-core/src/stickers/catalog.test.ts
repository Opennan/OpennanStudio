import {
    STICKER_BASE_SIZE,
    STICKER_CATEGORIES,
    STICKER_CATEGORY_NAMES,
    STICKERS,
    TWEMOJI_ATTRIBUTION,
    searchStickers,
    stickerBox,
    stickerById,
    stickerDataUrl,
    stickerSvg,
} from "./catalog";
import { TWEMOJI_LICENSE, TWEMOJI_SOURCE_URL, TWEMOJI_VERSION } from "./twemoji-svgs";

/** Minimal XML well-formedness check: balanced tags, quoted attributes, one root element. */
function xmlProblems(svg: string): string[] {
    const problems: string[] = [];
    const stack: string[] = [];
    let roots = 0;
    let last = 0;
    const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*="[^"<]*")*)\s*(\/?)>/g;
    for (const match of svg.matchAll(tag)) {
        const between = svg.slice(last, match.index);
        if (between.includes("<") || between.includes(">")) problems.push(`stray markup before ${match[0].slice(0, 40)}`);
        last = match.index + match[0].length;
        const [, closing, name, , selfClosing] = match;
        if (closing) {
            if (stack.pop() !== name) problems.push(`unbalanced </${name}>`);
            continue;
        }
        if (stack.length === 0) roots += 1;
        if (!selfClosing) stack.push(name);
    }
    const tail = svg.slice(last);
    if (tail.includes("<") || tail.includes(">")) problems.push("stray markup at the end");
    if (stack.length > 0) problems.push(`unclosed <${stack.join(">, <")}>`);
    if (roots !== 1) problems.push(`${roots} root elements`);
    return problems;
}

describe("sticker catalog", () => {
    it("has 96 stickers with unique ids: 36 own, 60 Twemoji", () => {
        expect(STICKERS).toHaveLength(96);
        expect(new Set(STICKERS.map((s) => s.id)).size).toBe(96);
        expect(STICKERS.filter((s) => s.source === "opennan")).toHaveLength(36);
        expect(STICKERS.filter((s) => s.source === "twemoji")).toHaveLength(60);
    });

    it("uses the documented id schemes and known categories", () => {
        for (const sticker of STICKERS) {
            if (sticker.source === "opennan") expect(sticker.id).toMatch(/^opennan:[a-z0-9]+(-[a-z0-9]+)*$/);
            else expect(sticker.id).toMatch(/^twemoji:[0-9a-f]{4,5}(-[0-9a-f]{4,5})*$/);
            expect(STICKER_CATEGORIES).toContain(sticker.category);
            expect(sticker.category.startsWith("emoji-")).toBe(sticker.source === "twemoji");
            expect(sticker.name.trim()).not.toBe("");
            expect(sticker.keywords.length).toBeGreaterThan(0);
        }
        expect(stickerById("opennan:arrow-right")?.category).toBe("arrows");
        expect(stickerById("twemoji:1f525")?.source).toBe("twemoji");
        expect(stickerById("nope:1")).toBeUndefined();
    });

    it("fills every category with the planned counts", () => {
        const count = (category: string) => STICKERS.filter((s) => s.category === category).length;
        expect(STICKER_CATEGORIES).toEqual([
            "arrows", "shapes", "callouts", "badges", "sparkles", "marks",
            "emoji-faces", "emoji-hands", "emoji-symbols", "emoji-celebration", "emoji-things",
        ]);
        expect([count("arrows"), count("shapes"), count("callouts"), count("badges"), count("sparkles"), count("marks")]).toEqual([8, 8, 6, 6, 4, 4]);
        expect(count("emoji-faces")).toBe(16);
        expect(count("emoji-hands")).toBe(10);
        for (const category of STICKER_CATEGORIES) {
            expect(count(category)).toBeGreaterThan(0);
            expect(STICKER_CATEGORY_NAMES[category]).toBeTruthy();
        }
    });

    it("sizes every sticker so its longest side is STICKER_BASE_SIZE, matching its viewBox", () => {
        expect(STICKER_BASE_SIZE).toBe(240);
        for (const sticker of STICKERS) {
            expect(Math.max(sticker.width, sticker.height)).toBe(STICKER_BASE_SIZE);
            const viewBox = /viewBox="([^"]+)"/.exec(sticker.svg)?.[1].split(/[\s,]+/).map(Number) ?? [];
            expect(viewBox).toHaveLength(4);
            expect(Math.abs(sticker.width / sticker.height - viewBox[2] / viewBox[3])).toBeLessThan(0.01);
        }
        expect(stickerBox("opennan:star", 2160)).toEqual({ width: 480, height: 480 });
        expect(stickerBox("missing")).toBeNull();
    });

    it("every SVG is well-formed with one <svg> root that has a viewBox and its size", () => {
        for (const sticker of STICKERS) {
            expect(xmlProblems(sticker.svg), sticker.id).toEqual([]);
            expect(sticker.svg.startsWith("<svg "), sticker.id).toBe(true);
            expect(sticker.svg.endsWith("</svg>"), sticker.id).toBe(true);
            expect(sticker.svg.match(/<svg\b/g), sticker.id).toHaveLength(1);
            expect(sticker.svg).toMatch(/^<svg [^>]*viewBox="[^"]+"/);
            expect(sticker.svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
            expect(sticker.svg).toMatch(new RegExp(`^<svg [^>]*width="${sticker.width}" height="${sticker.height}"`));
            const doc = new DOMParser().parseFromString(sticker.svg, "image/svg+xml");
            expect(doc.getElementsByTagName("parsererror"), sticker.id).toHaveLength(0);
            expect(doc.documentElement.nodeName, sticker.id).toBe("svg");
        }
    });

    it("no SVG carries scripts, event handlers, embedded images, or external references", () => {
        for (const sticker of STICKERS) {
            const svg = sticker.svg;
            expect(svg, sticker.id).not.toMatch(/<script/i);
            expect(svg, sticker.id).not.toMatch(/<foreignObject/i);
            expect(svg, sticker.id).not.toMatch(/<image/i);
            expect(svg, sticker.id).not.toMatch(/\son\w+\s*=/i);
            expect(svg, sticker.id).not.toMatch(/javascript:/i);
            expect(svg, sticker.id).not.toMatch(/<style/i);
            expect(svg, sticker.id).not.toMatch(/@import/i);
            for (const ref of svg.matchAll(/(?:xlink:)?href\s*=\s*"([^"]*)"/g)) expect(ref[1], sticker.id).toMatch(/^#[\w-]+$/);
            for (const ref of svg.matchAll(/url\(([^)]*)\)/g)) expect(ref[1], sticker.id).toMatch(/^#[\w-]+$/);
            // The only URL allowed is the SVG namespace on the root.
            expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), sticker.id).not.toMatch(/https?:|data:/i);
        }
    });

    it("searches names and keywords, case- and diacritic-insensitively, optionally in one category", () => {
        expect(searchStickers("fire").map((s) => s.id)).toContain("twemoji:1f525");
        expect(searchStickers("LIT").map((s) => s.id)).toContain("twemoji:1f525");
        expect(searchStickers("Heart").map((s) => s.id)).toEqual(expect.arrayContaining(["opennan:heart", "twemoji:2764"]));
        expect(searchStickers("hEArt", "shapes").map((s) => s.id)).toEqual(["opennan:heart"]);
        expect(searchStickers("flèche").length).toBe(0);
        expect(searchStickers("árrow").length).toBeGreaterThanOrEqual(8);
        expect(searchStickers("arrow", "arrows")).toHaveLength(8);
        expect(searchStickers("speech bubble").map((s) => s.id)[0]).toBe("opennan:speech-bubble");
        expect(searchStickers("subscribe").map((s) => s.id)).toEqual(expect.arrayContaining(["opennan:badge-subscribe", "twemoji:1f514"]));
        expect(searchStickers("🔥").map((s) => s.id)).toEqual(["twemoji:1f525"]);
        expect(searchStickers("zzzz-no-match")).toEqual([]);
        expect(searchStickers("")).toHaveLength(96);
        expect(searchStickers("  ", "marks")).toHaveLength(4);
        // Name matches rank before keyword-only matches.
        const stars = searchStickers("star").map((s) => s.id);
        expect(stars.indexOf("opennan:star")).toBeLessThan(stars.indexOf("opennan:badge-rating"));
    });

    it("returns SVG markup and data URLs, optionally at another pixel size", () => {
        const svg = stickerSvg("opennan:arrow-right");
        expect(svg).toBe(stickerById("opennan:arrow-right")?.svg);
        expect(stickerSvg("missing")).toBeNull();
        const big = stickerSvg("twemoji:1f525", { width: 960, height: 960 });
        expect(big).toMatch(/^<svg [^>]*width="960" height="960"/);
        expect(big?.match(/\swidth="/g)).toHaveLength(1);
        const url = stickerDataUrl("twemoji:1f525");
        expect(url?.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
        expect(decodeURIComponent(url!.slice("data:image/svg+xml;charset=utf-8,".length))).toBe(stickerSvg("twemoji:1f525"));
        expect(url).not.toMatch(/[<>"#\s]/);
        expect(stickerDataUrl("missing")).toBeNull();
    });

    it("Twemoji entries carry their source, emoji, and CC-BY 4.0 attribution", () => {
        expect(TWEMOJI_ATTRIBUTION).toBe("Emoji graphics: Twemoji by Twitter, Inc. and contributors, licensed CC-BY 4.0");
        expect(TWEMOJI_VERSION).toBe("15.1.0");
        expect(TWEMOJI_LICENSE).toBe("CC-BY-4.0");
        expect(TWEMOJI_SOURCE_URL).toContain("jdecked/twemoji@15.1.0");
        for (const sticker of STICKERS.filter((s) => s.id.startsWith("twemoji:"))) {
            expect(sticker.source).toBe("twemoji");
            expect(sticker.emoji).toBeTruthy();
            expect(sticker.keywords).toContain(sticker.emoji);
            // Codepoints of the emoji without U+FE0F give the id (the Twemoji file name).
            const codepoints = [...sticker.emoji!].map((c) => c.codePointAt(0)!).filter((c) => c !== 0xfe0f).map((c) => c.toString(16));
            expect(sticker.id).toBe(`twemoji:${codepoints.join("-")}`);
            expect(sticker.svg).toMatch(/viewBox="0 0 36 36"/);
        }
        for (const sticker of STICKERS.filter((s) => s.source === "opennan")) expect(sticker.emoji).toBeUndefined();
    });
});
