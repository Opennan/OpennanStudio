// Bundled text fonts (phase 10b): twelve OFL-1.1 families shipped as `@fontsource/*` packages by the
// host app (apps/web/src/text-fonts.ts). This module only lists them (no assets): names exactly as
// fontsource names them, the bundled weights, a category for the UI, and the faces a style needs so
// rasterizers and the preview can `document.fonts.load()` them before drawing.
import { parsePreviewTextStyle } from "../lib/preview-text-draw";

export type TextFontCategory = "sans" | "serif" | "display" | "handwritten";

export interface TextFont {
    id: string;
    family: string;
    weights: readonly number[];
    category: TextFontCategory;
    packageName: string;
}

const font = (family: string, weights: number[], category: TextFontCategory): TextFont => {
    const slug = family.toLowerCase().replace(/\s+/g, "-");
    return { id: slug.replace(/-/g, "_"), family, weights, category, packageName: `@fontsource/${slug}` };
};

export const TEXT_FONTS: readonly TextFont[] = [
    font("Inter", [400, 700, 900], "sans"),
    font("Montserrat", [400, 700, 900], "sans"),
    font("Poppins", [400, 600, 800], "sans"),
    font("Bebas Neue", [400], "display"),
    font("Anton", [400], "display"),
    font("Oswald", [400, 700], "sans"),
    font("Playfair Display", [400, 700], "serif"),
    font("Lobster", [400], "display"),
    font("Pacifico", [400], "handwritten"),
    font("Caveat", [400, 700], "handwritten"),
    font("Dancing Script", [400, 700], "handwritten"),
    font("Bangers", [400], "display"),
];

const FALLBACKS: Record<TextFontCategory, string> = {
    sans: '"Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    display: 'Impact, "Arial Narrow", sans-serif',
    handwritten: '"Comic Sans MS", cursive',
};

export function fontById(id: string): TextFont | undefined {
    return TEXT_FONTS.find((f) => f.id === id);
}

/** Case-insensitive family lookup ("bebas neue" → Bebas Neue). */
export function fontByFamily(family: string): TextFont | undefined {
    const key = family.trim().toLowerCase();
    return TEXT_FONTS.find((f) => f.family.toLowerCase() === key);
}

function quoteFamily(family: string): string {
    return /^[A-Za-z][A-Za-z-]*$/.test(family) ? family : `"${family.replace(/"/g, "")}"`;
}

/** A CSS font-family list: the family, then fallbacks for its category (sans-serif for unknown families). */
export function fontStack(family: string): string {
    const bundled = fontByFamily(family);
    const name = quoteFamily(bundled?.family ?? family.trim());
    return `${name}, ${bundled ? FALLBACKS[bundled.category] : "sans-serif"}`;
}

/** The first family of a CSS font-family list, unquoted. */
export function primaryFontFamily(fontFamily: string): string {
    const first = fontFamily.split(",")[0] ?? "";
    return first.trim().replace(/^["']|["']$/g, "").trim();
}

function weightNumber(weight: number | string): number {
    if (typeof weight === "number") return Number.isFinite(weight) ? weight : 400;
    const value = weight.trim().toLowerCase();
    if (value === "bold" || value === "bolder") return 700;
    if (value === "normal" || value === "lighter" || value === "") return 400;
    const n = Number(value);
    return Number.isFinite(n) ? n : 400;
}

/** The bundled weight closest to `weight` (ties go to the heavier face, as CSS matching does above 500). */
export function nearestWeight(entry: TextFont, weight: number | string): number {
    const target = weightNumber(weight);
    let best = entry.weights[0];
    for (const w of entry.weights) {
        const d = Math.abs(w - target);
        const bestD = Math.abs(best - target);
        if (d < bestD || (d === bestD && w > best)) best = w;
    }
    return best;
}

export interface TextFontFace {
    family: string;
    weight: number;
    style: "normal" | "italic";
}

/** The bundled faces a host must load before drawing text with this style (empty for system fonts). */
export function fontFacesForStyle(styleJson: string | null): TextFontFace[] {
    const style = parsePreviewTextStyle(styleJson);
    const entry = fontByFamily(primaryFontFamily(style.fontFamily));
    if (!entry) return [];
    return [{ family: entry.family, weight: nearestWeight(entry, style.fontWeight), style: style.fontStyle === "italic" ? "italic" : "normal" }];
}
