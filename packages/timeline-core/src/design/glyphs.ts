// packages/timeline-core/src/design/glyphs.ts
// Text layout from the original lettering (see model.ts). Pure: returns cell geometry; the editor draws it.
import type { LayerDesign, TextLayer } from "./model";

export interface GlyphRef {
    ch: string;
    src: string;
    w: number;
    h: number;
    dy: number;
    /** Height of the text box the cell was cut from. */
    textH: number;
    fill: string;
    styleGroup?: string;
    owner: string;
    ink?: { x: number; w: number };
    /** Letter gap of the word the cell came from. */
    gap?: number;
}

export interface LayoutCell {
    /** Absent for a space. */
    src?: string;
    /** Offsets from the text box's top-left, design px. */
    x: number;
    y: number;
    w: number;
    h: number;
}

export type TextLayout =
    | { mode: "original" }
    | { mode: "glyphs"; cells: LayoutCell[]; width: number }
    | { mode: "font"; missing: string[] };

export const SPACE_WIDTH = 0.32;
const MAX_STYLE_DISTANCE = 70;

export function glyphLibrary(design: LayerDesign): GlyphRef[] {
    const lib: GlyphRef[] = [];
    for (const l of design.layers) {
        if (l.kind !== "text") continue;
        for (const g of l.original.glyphs ?? []) {
            lib.push({ ch: g.ch, src: g.src, w: g.w, h: g.h, dy: g.dy, textH: l.box.h, fill: l.style.fill, styleGroup: l.styleGroup, owner: l.id, ink: g.ink, gap: l.original.gap });
        }
    }
    return lib;
}

export function colourDistance(a: string, b: string): number {
    const rgb = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
    const [x, y] = [rgb(a), rgb(b)];
    if ([...x, ...y].some(Number.isNaN)) return Infinity;
    return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function findGlyph(layer: TextLayer, ch: string, lib: readonly GlyphRef[]): GlyphRef | null {
    const own = lib.find((g) => g.owner === layer.id && g.ch === ch);
    if (own) return own;
    let best: GlyphRef | null = null;
    let bestD = Infinity;
    for (const g of lib) {
        if (g.ch !== ch || !layer.styleGroup || g.styleGroup !== layer.styleGroup) continue;
        const ratio = layer.box.h / g.textH;
        if (ratio < 0.75 || ratio > 1.33) continue;
        const d = colourDistance(g.fill, layer.style.fill) + Math.abs(Math.log(ratio)) * 120;
        if (d < MAX_STYLE_DISTANCE && d < bestD) {
            best = g;
            bestD = d;
        }
    }
    return best;
}

export function layoutText(layer: TextLayer, lib: readonly GlyphRef[]): TextLayout {
    if (layer.lettering === "font") return { mode: "font", missing: [] };
    if (layer.text === layer.original.text && layer.original.word) return { mode: "original" };
    const picked: (GlyphRef | null)[] = [];
    const missing: string[] = [];
    for (const ch of layer.text) {
        if (ch === " ") {
            picked.push(null);
            continue;
        }
        const g = findGlyph(layer, ch, lib);
        if (!g) {
            if (!missing.includes(ch)) missing.push(ch);
            continue;
        }
        picked.push(g);
    }
    if (missing.length || !picked.some(Boolean)) return { mode: "font", missing };
    const space = layer.box.h * SPACE_WIDTH;
    const cells: LayoutCell[] = [];
    let x = 0;
    if (picked.every((g) => !g || g.ink)) {
        // ink spacing: letters sit one letter gap apart, whatever margins their cells carry
        const gap = layer.original.gap ?? picked.find((g) => g?.gap !== undefined)?.gap ?? layer.box.h * 0.08;
        let first = true;
        for (const g of picked) {
            if (!g) {
                cells.push({ x, y: 0, w: space, h: 0 });
                x += space;
                continue;
            }
            const k = layer.box.h / g.textH;
            if (!first) x += gap;
            cells.push({ src: g.src, x: x - g.ink!.x * k, y: g.dy * k, w: g.w * k, h: g.h * k });
            x += g.ink!.w * k;
            first = false;
        }
    } else {
        for (const g of picked) {
            if (!g) {
                cells.push({ x, y: 0, w: space, h: 0 });
                x += space;
                continue;
            }
            const k = layer.box.h / g.textH;
            cells.push({ src: g.src, x, y: g.dy * k, w: g.w * k, h: g.h * k });
            x += g.w * k;
        }
    }
    const start = (layer.box.w - x) / 2;
    return { mode: "glyphs", width: x, cells: cells.map((c) => ({ ...c, x: c.x + start })) };
}
