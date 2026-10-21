// The bundled sticker catalog: 36 OpenNan stickers (own-svgs.ts, project licence) and 60 Twemoji graphics
// (twemoji-svgs.ts, CC-BY 4.0, shown with TWEMOJI_ATTRIBUTION). A sticker clip stores the catalog id in
// `stickerId`; the preview and the export draw `stickerSvg(id)`. Names are English fallbacks; the UI
// translates by id.
import { OWN_STICKERS, type OwnStickerCategory } from "./own-svgs";
import { TWEMOJI_STICKERS, type TwemojiCategory } from "./twemoji-svgs";

export type StickerCategory = OwnStickerCategory | TwemojiCategory;
export type StickerSource = "opennan" | "twemoji";

export const STICKER_CATEGORIES: readonly StickerCategory[] = [
    "arrows", "shapes", "callouts", "badges", "sparkles", "marks",
    "emoji-faces", "emoji-hands", "emoji-symbols", "emoji-celebration", "emoji-things",
];

export const STICKER_CATEGORY_NAMES: Readonly<Record<StickerCategory, string>> = {
    arrows: "Arrows",
    shapes: "Shapes",
    callouts: "Callouts",
    badges: "Badges",
    sparkles: "Sparkles",
    marks: "Marks",
    "emoji-faces": "Faces",
    "emoji-hands": "Hands",
    "emoji-symbols": "Hearts & symbols",
    "emoji-celebration": "Celebration",
    "emoji-things": "Nature & objects",
};

/**
 * Reference size in pixels of a sticker's longest side at clip scale 1 on a 1080-pixel-tall frame. Other
 * frame heights scale it proportionally (`stickerBox`): a sticker at scale 1 covers the same share of the
 * frame (240 / 1080, about 22 % of the height) at any export resolution.
 */
export const STICKER_BASE_SIZE = 240;

/** Shown wherever Twemoji stickers are offered (Stickers tab footer) and in the notices. */
export const TWEMOJI_ATTRIBUTION = "Emoji graphics: Twemoji by Twitter, Inc. and contributors, licensed CC-BY 4.0";

export interface Sticker {
    /** "opennan:<slug>" or "twemoji:<codepoint>". */
    id: string;
    source: StickerSource;
    category: StickerCategory;
    name: string;
    keywords: readonly string[];
    /** The emoji character (Twemoji stickers only). */
    emoji?: string;
    /** Standalone SVG markup; its root carries the viewBox and width/height equal to `width`/`height`. */
    svg: string;
    /** Size at scale 1 on a 1080-tall frame: the viewBox fitted so its longest side is STICKER_BASE_SIZE. */
    width: number;
    height: number;
}

const ROOT = /^<svg\b([^>]*)>/;

function viewBoxSize(svg: string): { width: number; height: number } {
    const values = /\sviewBox="([^"]+)"/.exec(ROOT.exec(svg)?.[1] ?? "")?.[1].trim().split(/[\s,]+/).map(Number) ?? [];
    const [width, height] = [values[2], values[3]];
    if (!(width > 0 && height > 0)) throw new Error("sticker SVG without a usable viewBox");
    return { width, height };
}

/** The SVG with its root width/height set (replacing any it had). */
function withSize(svg: string, width: number, height: number): string {
    return svg.replace(ROOT, (_root, attributes: string) => {
        const rest = attributes.replace(/\s(?:width|height)="[^"]*"/g, "");
        return `<svg${rest} width="${width}" height="${height}">`;
    });
}

function makeSticker(fields: Omit<Sticker, "width" | "height" | "svg">, rawSvg: string): Sticker {
    const box = viewBoxSize(rawSvg);
    const fit = STICKER_BASE_SIZE / Math.max(box.width, box.height);
    const width = Math.round(box.width * fit);
    const height = Math.round(box.height * fit);
    return { ...fields, svg: withSize(rawSvg, width, height), width, height };
}

export const STICKERS: readonly Sticker[] = [
    ...OWN_STICKERS.map((s) => makeSticker({ id: `opennan:${s.slug}`, source: "opennan", category: s.category, name: s.name, keywords: s.keywords }, s.svg)),
    ...TWEMOJI_STICKERS.map((s) => makeSticker({
        id: `twemoji:${s.codepoint}`,
        source: "twemoji",
        category: s.category,
        name: s.name,
        keywords: [...s.keywords, s.emoji],
        emoji: s.emoji,
    }, s.svg)),
];

const BY_ID = new Map(STICKERS.map((sticker) => [sticker.id, sticker]));

export function stickerById(id: string): Sticker | undefined {
    return BY_ID.get(id);
}

/** Lowercase, without diacritics (and without emoji variation selectors, which are marks too). */
function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

const words = (text: string): string[] => text.split(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/u).filter(Boolean);

const INDEX = STICKERS.map((sticker) => {
    const name = fold(sticker.name);
    const keywords = sticker.keywords.map(fold);
    return { sticker, name, nameWords: words(name), keywords, keywordWords: keywords.flatMap(words) };
});

/** 3 for a name word starting with the term, 2 for a keyword (word) starting with it, 1 for a substring, else 0. */
function termScore(entry: (typeof INDEX)[number], term: string): number {
    if (entry.name === term || entry.nameWords.some((word) => word.startsWith(term))) return 3;
    if (entry.keywords.some((keyword) => keyword === term || keyword.startsWith(term)) || entry.keywordWords.some((word) => word.startsWith(term))) return 2;
    if (entry.name.includes(term) || entry.keywords.some((keyword) => keyword.includes(term))) return 1;
    return 0;
}

/**
 * Stickers whose name or keywords match every word of `query` (case- and diacritic-insensitive, prefix or
 * substring), best matches first and catalog order otherwise; an empty query lists the category (or all).
 */
export function searchStickers(query: string, category?: StickerCategory): Sticker[] {
    const pool = INDEX.filter((entry) => !category || entry.sticker.category === category);
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return pool.map((entry) => entry.sticker);
    const scored: { sticker: Sticker; score: number; order: number }[] = [];
    pool.forEach((entry, order) => {
        let score = 0;
        for (const term of terms) {
            const termValue = termScore(entry, term);
            if (termValue === 0) return;
            score += termValue;
        }
        scored.push({ sticker: entry.sticker, score, order });
    });
    return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((entry) => entry.sticker);
}

/**
 * The sticker's SVG markup, or null for an unknown id. `size` sets the root width/height in pixels (the
 * rasterizer passes the largest size a clip reaches, so an `Image` decodes it sharp).
 */
export function stickerSvg(id: string, size?: { width: number; height: number }): string | null {
    const sticker = BY_ID.get(id);
    if (!sticker) return null;
    if (!size) return sticker.svg;
    return withSize(sticker.svg, Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height)));
}

/** A `data:` URL of the sticker's SVG for `<img>` / `Image` sources, or null for an unknown id. */
export function stickerDataUrl(id: string, size?: { width: number; height: number }): string | null {
    const svg = stickerSvg(id, size);
    return svg === null ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The sticker's box in pixels at clip scale 1 on a frame `frameHeight` tall, or null for an unknown id. */
export function stickerBox(id: string, frameHeight = 1080): { width: number; height: number } | null {
    const sticker = BY_ID.get(id);
    if (!sticker) return null;
    const scale = frameHeight / 1080;
    return { width: sticker.width * scale, height: sticker.height * scale };
}
