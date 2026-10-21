// Drawing helpers shared by the template draw functions (phase 10d).
import { fontStack, type TextFontFace } from "../../text/fonts";
import type { GraphicsBounds, GraphicsContext } from "../types";

/** The graphics font (Inter, bundled; hosts load its 400/500/600/700/800 faces' nearest bundled weights first). */
export const GRAPHICS_FONT_FAMILY = "Inter";

/** The bundled Inter faces graphics draw with (other weights resolve to the nearest of these). Hosts load them first. */
export const GRAPHICS_FONT_FACES: readonly TextFontFace[] = [400, 700, 900].map((weight) => ({ family: GRAPHICS_FONT_FAMILY, weight, style: "normal" as const }));

/** A canvas `font` string for the graphics font at `weight` and `size` composition px. */
export function graphicsFont(weight: number, size: number): string {
    return `${weight} ${Math.max(1, size)}px ${fontStack(GRAPHICS_FONT_FAMILY)}`;
}

/** Path of a rectangle with corner radius `r` (clamped to half the shorter side). */
export function roundedRectPath(ctx: GraphicsContext, x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    if (radius === 0) {
        ctx.rect(x, y, w, h);
        return;
    }
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
}

/** Fills a rounded rectangle. */
export function fillRoundedRect(ctx: GraphicsContext, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient): void {
    roundedRectPath(ctx, x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
}

/** Width of `text` in the current font. */
export function textWidth(ctx: GraphicsContext, text: string): number {
    return ctx.measureText(text).width;
}

/** Union of bounds (nulls ignored). */
export function unionBounds(...boxes: Array<GraphicsBounds | null | undefined>): GraphicsBounds | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const box of boxes) {
        if (!box || !(box.width > 0) || !(box.height > 0)) continue;
        x0 = Math.min(x0, box.x);
        y0 = Math.min(y0, box.y);
        x1 = Math.max(x1, box.x + box.width);
        y1 = Math.max(y1, box.y + box.height);
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Bounds of an axis-aligned box after translating by (dx, dy) and scaling by s about (cx, cy). */
export function transformBounds(box: GraphicsBounds, dx: number, dy: number, s = 1, cx = 0, cy = 0): GraphicsBounds {
    const x = cx + (box.x - cx) * s + dx;
    const y = cy + (box.y - cy) * s + dy;
    return { x: Math.min(x, x + box.width * s), y: Math.min(y, y + box.height * s), width: Math.abs(box.width * s), height: Math.abs(box.height * s) };
}

export const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value));

export function numberOr(value: unknown, fallback: number): number {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

/** A parsed JSON parameter (props may hold the JSON text or the value itself); `fallback` when unusable. */
export function jsonParam<T>(value: unknown, fallback: T): T {
    if (typeof value !== "string") return (value ?? fallback) as T;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

/** A colour parameter, or `fallback` for empty/"transparent" (callers decide whether transparent paints). */
export function color(value: unknown, fallback: string): string {
    const text = str(value).trim();
    return text || fallback;
}

export const isTransparent = (value: string) => value.trim().toLowerCase() === "transparent" || value.trim() === "";

/** CSS `line-height: normal` of Inter (ascent 0.96875 + descent 0.2421875), as a multiple of the font size. */
export const INTER_LINE_HEIGHT = 1.21;
/** Inter's ascent as a multiple of the font size (where CSS puts the alphabetic baseline below the line top). */
export const INTER_ASCENT = 0.96875;

/** Offset of the alphabetic baseline below the top of a CSS line box `lineHeight` px tall at font `size` px. */
export function baselineOffset(lineHeight: number, size: number): number {
    return (lineHeight - INTER_LINE_HEIGHT * size) / 2 + INTER_ASCENT * size;
}

export const clamp01 = (value: number): number => (value > 0 ? (value < 1 ? value : 1) : 0);

export interface WrappedText {
    lines: string[];
    widths: number[];
    /** Widest line. */
    width: number;
}

/**
 * Greedy line breaking in the current font, like CSS: "normal" collapses whitespace and breaks between words;
 * "pre-wrap" keeps spaces and newlines. Words wider than `maxWidth` break between characters (CSS
 * `overflow-wrap: break-word`), so text never runs past `maxWidth`.
 */
export function wrapText(ctx: GraphicsContext, text: string, maxWidth: number, mode: "normal" | "pre-wrap" = "normal"): WrappedText {
    const limit = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
    const paragraphs = mode === "pre-wrap" ? text.replace(/\r\n?/g, "\n").split("\n") : [text.replace(/\s+/g, " ").trim()];
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
        const tokens = mode === "pre-wrap" ? paragraph.split(/( +)/).filter((t) => t !== "") : paragraph.split(" ").filter(Boolean);
        const joiner = mode === "pre-wrap" ? "" : " ";
        let line = "";
        for (const token of tokens) {
            const candidate = line ? line + joiner + token : token;
            if (line === "" || textWidth(ctx, candidate.trimEnd()) <= limit) {
                line = candidate;
            } else {
                lines.push(line.trimEnd());
                line = token.trim() === "" ? "" : token;
            }
            // Break a word that alone is wider than the line between characters.
            while (line && textWidth(ctx, line.trimEnd()) > limit && line.trimEnd().length > 1) {
                let cut = line.length - 1;
                while (cut > 1 && textWidth(ctx, line.slice(0, cut)) > limit) cut -= 1;
                lines.push(line.slice(0, cut));
                line = line.slice(cut);
            }
        }
        lines.push(mode === "pre-wrap" ? line.trimEnd() : line);
    }
    const widths = lines.map((l) => textWidth(ctx, l));
    return { lines, widths, width: Math.max(0, ...widths) };
}

/** `box` intersected with the composition, or null when nothing of it is inside. */
export function clipBounds(box: GraphicsBounds | null, width: number, height: number): GraphicsBounds | null {
    if (!box) return null;
    const x0 = Math.max(0, box.x);
    const y0 = Math.max(0, box.y);
    const x1 = Math.min(width, box.x + box.width);
    const y1 = Math.min(height, box.y + box.height);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The full composition. */
export const fullFrame = (width: number, height: number): GraphicsBounds => ({ x: 0, y: 0, width, height });

/** Scale (≤ 1) that fits a `w × h` block into `maxW × maxH` (1 when it already fits). */
export function fitScale(w: number, h: number, maxW: number, maxH: number): number {
    const s = Math.min(1, w > 0 ? maxW / w : 1, h > 0 ? maxH / h : 1);
    return Number.isFinite(s) && s > 0 ? s : 1;
}

/** A CSS `linear-gradient(<angle>deg, …)` line over the box (stops are added by the caller). */
export function cssLinearGradient(ctx: GraphicsContext, angleDeg: number, x: number, y: number, w: number, h: number): CanvasGradient {
    const a = ((Number.isFinite(angleDeg) ? angleDeg : 180) * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    return ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
}

/**
 * Appends an SVG circular arc (`A r r 0 largeArc sweep x2 y2`) from the current point (x1, y1), converting the
 * endpoint form to a canvas arc (radius grown to reach the endpoint when too small, as SVG does).
 */
export function svgArc(ctx: GraphicsContext, x1: number, y1: number, r: number, largeArc: boolean, sweep: boolean, x2: number, y2: number): void {
    const mx = (x1 - x2) / 2;
    const my = (y1 - y2) / 2;
    const d2 = mx * mx + my * my;
    if (d2 === 0) return;
    let radius = Math.abs(r);
    if (radius * radius < d2) radius = Math.sqrt(d2);
    const k = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (radius * radius - d2) / d2));
    // Centre in the arc's frame (x' = mx, y' = my), rotated back (no x-axis rotation here).
    const cx = k * my + (x1 + x2) / 2;
    const cy = -k * mx + (y1 + y2) / 2;
    const a0 = Math.atan2(y1 - cy, x1 - cx);
    const a1 = Math.atan2(y2 - cy, x2 - cx);
    // SVG sweep 1 = positive angle direction = clockwise on a y-down canvas.
    ctx.arc(cx, cy, radius, a0, a1, !sweep);
}

/** `#rrggbb` plus a two-digit alpha as rgba(), or null for any other colour syntax (CSS would drop it too). */
export function hexWithAlpha(value: string, alphaHex: string): string | null {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
    if (!m) return null;
    const a = parseInt(alphaHex, 16) / 255;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/** 32-bit FNV-1a hash of a string (stable PRNG seeds). */
export function hashString(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** The first output in [0, 1) of mulberry32 seeded with `seed`: a stateless, integer-only hash (bit-identical everywhere). */
export function seededRandom(seed: number): number {
    let t = (seed + 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Fills wrapped lines in the current font, line boxes `lineHeight` tall from `top`, aligned inside `boxWidth`. */
export function fillLines(
    ctx: GraphicsContext, wrapped: WrappedText, x: number, top: number, boxWidth: number, lineHeight: number, size: number,
    align: "left" | "center" | "right" = "left",
): void {
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const base = baselineOffset(lineHeight, size);
    wrapped.lines.forEach((line, i) => {
        if (!line) return;
        const w = wrapped.widths[i];
        const lx = align === "center" ? x + (boxWidth - w) / 2 : align === "right" ? x + boxWidth - w : x;
        ctx.fillText(line, lx, top + i * lineHeight + base);
    });
}

/** A number parameter clamped to [min, max] (fallback when missing or not finite). */
export function clampedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = numberOr(value, fallback);
    return Math.min(max, Math.max(min, n));
}

/** Adds a gradient stop; an unparsable colour (canvases throw on those) becomes transparent instead. */
export function addStop(gradient: CanvasGradient, offset: number, value: string): void {
    try {
        gradient.addColorStop(offset, value);
    } catch {
        gradient.addColorStop(offset, "rgba(0,0,0,0)");
    }
}

/** Intersection of two boxes, or null when they do not overlap. */
export function intersectBounds(a: GraphicsBounds, b: GraphicsBounds): GraphicsBounds | null {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
