// Text clip drawing shared by the editor preview (timeline-react PreviewPanel) and the export
// rasterizer (@opennan/export), so exported text matches the preview. Moved from
// timeline-react src/preview/preview-panel.tsx (parseTextStyle :128-220, applyTextTransform :222-231,
// and the text branch of the compositor draw loop :1234-1356).
import { boxBlurRgba } from "../text/box-blur";
import type { TextState } from "../text/text-states";
import { layoutPreviewText, splitGraphemes, type PreviewTextLine } from "./preview-text-layout";
import { getTimelineCaptionMaxWidthRatio, getTimelineTextClipKind } from "./timeline-text-style";

export interface PreviewTextStyle {
    fontSize: number;
    fontFamily: string;
    fontWeight: string;
    fontStyle: string;
    textDecoration: string;
    textTransform: string;
    color: string;
    strokeWidth: number;
    strokeColor: string;
    bgColor: string;
    letterSpacing: number;
    shadowColor: string;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
    textAlign: "left" | "center" | "right";
    captionKind: "text" | "caption" | "subtitle";
    wordsPerLine: "single" | "multiple";
    maxWidthRatio: number | null;
    // Phase 10b fields (optional so older literals still type-check; parsing always fills them).
    /** Background box padding in reference px; null keeps the pre-10b box (2 px around the layout box). */
    bgPadding?: number | null;
    /** Background box corner radius in reference px (0 = square). */
    bgRadius?: number;
    /** Linear gradient fill; angle in degrees, 0 = left → right, 90 = top → bottom. */
    gradient?: PreviewTextGradient | null;
    glowColor?: string;
    /** Glow blur in reference px (0 = none). */
    glowSize?: number;
    /** Line height as a multiple of the font size. */
    lineHeight?: number;
    /** Karaoke current-word colour (highlight) or pill colour (box). */
    highlightColor?: string;
    karaoke?: "highlight" | "box" | null;
}

export interface PreviewTextGradient {
    from: string;
    to: string;
    angle: number;
}

export const DEFAULT_TEXT_LINE_HEIGHT = 1.3;

const DEFAULT_STYLE: PreviewTextStyle = {
    fontSize: 24,
    fontFamily: "Inter, sans-serif",
    fontWeight: "bold",
    fontStyle: "normal",
    textDecoration: "none",
    textTransform: "none",
    color: "#FFFFFF",
    strokeWidth: 0,
    strokeColor: "#000000",
    bgColor: "",
    letterSpacing: 0,
    shadowColor: "rgba(0,0,0,0.6)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    textAlign: "center",
    captionKind: "text",
    wordsPerLine: "multiple",
    maxWidthRatio: null,
    bgPadding: null,
    bgRadius: 0,
    gradient: null,
    glowColor: "",
    glowSize: 0,
    lineHeight: DEFAULT_TEXT_LINE_HEIGHT,
    highlightColor: "",
    karaoke: null,
};

function nonNegative(value: unknown, max: number): number | null {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

function colorString(value: unknown): string {
    return typeof value === "string" && value.trim() && value.length <= 64 ? value.trim() : "";
}

function parseGradient(value: unknown): PreviewTextGradient | null {
    if (!value || typeof value !== "object") return null;
    const g = value as Record<string, unknown>;
    const from = colorString(g.from);
    const to = colorString(g.to);
    if (!from || !to) return null;
    const angle = Number(g.angle);
    return { from, to, angle: g.angle !== undefined && Number.isFinite(angle) ? angle : 90 };
}

function parseLineHeight(value: unknown): number {
    const n = Number(value);
    return value !== undefined && value !== null && Number.isFinite(n) && n >= 0.5 && n <= 4 ? n : DEFAULT_TEXT_LINE_HEIGHT;
}

// The preview draw loop runs at ~60 Hz; parsed styles are cached by their JSON text and read-only.
const styleCache = new Map<string, PreviewTextStyle>();
const STYLE_CACHE_MAX = 200;

function parseUncached(json: string | null): PreviewTextStyle {
    try {
        const s = json ? JSON.parse(json) : {};
        return {
            fontSize: s.fontSize || 24,
            fontFamily: s.fontFamily || "Inter, sans-serif",
            fontWeight: s.fontWeight || "bold",
            fontStyle: s.fontStyle || "normal",
            textDecoration: s.textDecoration || "none",
            textTransform: s.textTransform || "none",
            color: s.color || "#FFFFFF",
            strokeWidth: s.strokeWidth || 0,
            strokeColor: s.strokeColor || "#000000",
            bgColor: s.bgColor || "",
            letterSpacing: s.letterSpacing || 0,
            shadowColor: s.shadowColor || "rgba(0,0,0,0.6)",
            shadowBlur: s.shadowBlur || 0,
            shadowOffsetX: s.shadowOffsetX || 0,
            shadowOffsetY: s.shadowOffsetY || 0,
            textAlign: (s.textAlign || "center") as PreviewTextStyle["textAlign"],
            captionKind: getTimelineTextClipKind(json),
            wordsPerLine: s.wordsPerLine === "single" ? "single" : "multiple",
            // Plain text clips carry their own wrap-box ratio; caption/subtitle kinds fall back to kind defaults.
            maxWidthRatio: Number.isFinite(Number(s.maxWidthRatio)) && Number(s.maxWidthRatio) >= 0.2 && Number(s.maxWidthRatio) <= 1
                ? Number(s.maxWidthRatio)
                : getTimelineCaptionMaxWidthRatio(json),
            bgPadding: nonNegative(s.bgPadding, 400),
            bgRadius: nonNegative(s.bgRadius, 10000) ?? 0,
            gradient: parseGradient(s.gradient),
            glowColor: colorString(s.glowColor),
            glowSize: nonNegative(s.glowSize, 400) ?? 0,
            lineHeight: parseLineHeight(s.lineHeight),
            highlightColor: colorString(s.highlightColor),
            karaoke: s.karaoke === "highlight" || s.karaoke === "box" ? s.karaoke : null,
        };
    } catch {
        return { ...DEFAULT_STYLE };
    }
}

export function parsePreviewTextStyle(json: string | null): PreviewTextStyle {
    const key = json ?? "";
    const cached = styleCache.get(key);
    if (cached) return cached;
    const style = parseUncached(json);
    if (styleCache.size >= STYLE_CACHE_MAX) {
        const first = styleCache.keys().next().value;
        if (first !== undefined) styleCache.delete(first);
    }
    styleCache.set(key, style);
    return style;
}

export function applyPreviewTextTransform(text: string, textTransform: string): string {
    if (textTransform === "uppercase") return text.toUpperCase();
    if (textTransform === "lowercase") return text.toLowerCase();
    if (textTransform === "capitalize") {
        return text.replace(/\p{L}[\p{L}\p{N}'-]*/gu, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    }
    return text;
}

/**
 * Wrap width: plain text uses its maxWidthRatio (else 0.9) of the frame, like the reference
 * assembler's text wrap ratio; captions and subtitles use their kind defaults.
 */
export function previewTextWrapWidth(style: PreviewTextStyle, frameWidth: number): number {
    const ratioValid = typeof style.maxWidthRatio === "number" && style.maxWidthRatio >= 0.2 && style.maxWidthRatio <= 1;
    if (style.captionKind === "text") return frameWidth * (ratioValid ? style.maxWidthRatio! : 0.9);
    return frameWidth * (style.wordsPerLine === "single" ? Math.min(style.maxWidthRatio ?? 0.72, 0.72) : style.maxWidthRatio ?? 0.86);
}

/** Pixels of a canvas region (ImageData or a compatible stub). */
export interface PreviewTextImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

/**
 * Optional context members used by phase 10b styles and text states. Each feature degrades when its
 * member is missing (square box, flat colour, no clipping/blur), so minimal contexts keep working.
 */
export interface PreviewTextContextExtras {
    globalAlpha?: number;
    save?(): void;
    restore?(): void;
    fill?(): void;
    closePath?(): void;
    arcTo?(x1: number, y1: number, x2: number, y2: number, radius: number): void;
    roundRect?(x: number, y: number, w: number, h: number, radii?: number): void;
    rect?(x: number, y: number, w: number, h: number): void;
    clip?(): void;
    createLinearGradient?(x0: number, y0: number, x1: number, y1: number): { addColorStop(offset: number, color: string): void };
    drawImage?(image: unknown, dx: number, dy: number): void;
    getImageData?(sx: number, sy: number, sw: number, sh: number): PreviewTextImageData;
    putImageData?(imageData: PreviewTextImageData, dx: number, dy: number): void;
}

/** The 2D context members text drawing uses (browser canvases and @napi-rs/canvas both satisfy it). */
export type PreviewTextContext = Pick<CanvasRenderingContext2D,
    | "font" | "textAlign" | "textBaseline" | "fillStyle" | "strokeStyle" | "lineWidth" | "lineJoin"
    | "shadowColor" | "shadowBlur" | "shadowOffsetX" | "shadowOffsetY"
    | "measureText" | "fillText" | "strokeText" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "stroke"> & PreviewTextContextExtras;

export interface PreviewTextBlockInput {
    text: string;
    textStyle: string | null;
    /** Clip scale (keyframed value when animated). */
    scale: number;
    /** Frame px per export-reference px. */
    frameScale: number;
    /** Frame width in px (the wrap width is a fraction of it). */
    frameWidth: number;
}

export interface PreviewTextBlock {
    style: PreviewTextStyle;
    lines: PreviewTextLine[];
    lineHeight: number;
    /** Box size: the text is anchored and rotated by this box. */
    width: number;
    height: number;
    fontSize: number;
    letterSpacing: number;
    /** scale × frameScale, for stroke and shadow sizes. */
    pixelScale: number;
    /** The drawn text (after textTransform), for word-level states. */
    text?: string;
}

/** Sets the font on `ctx` and lays the text out. */
export function layoutPreviewTextBlock(ctx: PreviewTextContext, input: PreviewTextBlockInput): PreviewTextBlock {
    const style = parsePreviewTextStyle(input.textStyle);
    const pixelScale = input.scale * input.frameScale;
    const fontSize = style.fontSize * pixelScale;
    const letterSpacing = style.letterSpacing * pixelScale;
    const text = applyPreviewTextTransform(input.text || "Text", style.textTransform);
    ctx.font = `${style.fontStyle === "italic" ? "italic " : ""}${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
    ctx.textAlign = style.textAlign;
    ctx.textBaseline = "middle";
    const layout = layoutPreviewText({
        text,
        maxWidth: previewTextWrapWidth(style, input.frameWidth),
        fontSize,
        letterSpacing,
        measureText: (value) => ctx.measureText(value).width,
        lineHeight: style.lineHeight ?? DEFAULT_TEXT_LINE_HEIGHT,
    });
    return {
        style, lines: layout.lines, lineHeight: layout.lineHeight, width: layout.boxWidth, height: layout.boxHeight,
        fontSize, letterSpacing, pixelScale, text,
    };
}

/** The background box: the pre-10b 2 px inset, or bgPadding (reference px) at the pixel scale. */
function backgroundRect(block: PreviewTextBlock, x: number, y: number): { x: number; y: number; w: number; h: number } {
    const pad = block.style.bgPadding;
    if (pad === null || pad === undefined) return { x: x - 2, y: y - 2, w: block.width + 4, h: block.height + 4 };
    const p = pad * block.pixelScale;
    return { x: x - p, y: y - p, w: block.width + p * 2, h: block.height + p * 2 };
}

/** Fills a rounded rectangle (roundRect when available, else arcTo; square without a fill method). */
function fillRoundRect(ctx: PreviewTextContext, x: number, y: number, w: number, h: number, radius: number): void {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    if (r <= 0 || !ctx.fill) {
        ctx.fillRect(x, y, w, h);
        return;
    }
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, r);
    } else if (ctx.arcTo) {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath?.();
    } else {
        ctx.fillRect(x, y, w, h);
        return;
    }
    ctx.fill();
}

function drawBackground(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number): void {
    const { style } = block;
    if (!style.bgColor) return;
    const box = backgroundRect(block, x, y);
    ctx.fillStyle = style.bgColor;
    const radius = (style.bgRadius ?? 0) * block.pixelScale;
    if (radius > 0) fillRoundRect(ctx, box.x, box.y, box.w, box.h, radius);
    else ctx.fillRect(box.x, box.y, box.w, box.h);
}

/**
 * The fill paint: the style colour, or a linear gradient across the box when the context can make one. A
 * gradient the context rejects (addColorStop throws on an unparsable colour, createLinearGradient on non-finite
 * coordinates) falls back to the style colour, so a bad style never stops the preview loop or an export.
 */
function textPaint(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number): string | CanvasGradient {
    const g = block.style.gradient;
    if (!g || !ctx.createLinearGradient) return block.style.color;
    const radians = (g.angle * Math.PI) / 180;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);
    const half = (Math.abs(block.width * dx) + Math.abs(block.height * dy)) / 2;
    const cx = x + block.width / 2;
    const cy = y + block.height / 2;
    const clean = (value: number) => (Math.abs(value) < 1e-9 ? 0 : value);
    try {
        const gradient = ctx.createLinearGradient(clean(cx - dx * half), clean(cy - dy * half), clean(cx + dx * half), clean(cy + dy * half));
        gradient.addColorStop(0, g.from);
        gradient.addColorStop(1, g.to);
        return gradient as unknown as CanvasGradient;
    } catch {
        return block.style.color;
    }
}

/** One text run at a position (a line, a prefix, a word, or a glyph). */
interface TextRun {
    text: string;
    x: number;
    y: number;
    align: CanvasTextAlign;
    /** Extra alpha factor (letter states). */
    alpha?: number;
    /** Fill override (karaoke highlight). */
    fill?: string;
}

/** Glow blur in px for a block: the style glow, or `override` (glow states). */
function glowPx(block: PreviewTextBlock, override?: number): number {
    const size = override ?? block.style.glowSize ?? 0;
    return size > 0 ? size * block.pixelScale : 0;
}

/** Glow: two filled passes in the glow colour with a zero-offset shadow (full and half blur), then the shadow is cleared. */
function drawGlowPasses(ctx: PreviewTextContext, block: PreviewTextBlock, runs: TextRun[], blur: number): void {
    if (blur <= 0 || runs.length === 0) return;
    const color = block.style.glowColor || block.style.color;
    const baseAlpha = ctx.globalAlpha ?? 1;
    for (const factor of [1, 0.5]) {
        ctx.shadowColor = color;
        ctx.shadowBlur = blur * factor;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = color;
        for (const run of runs) {
            if (run.alpha !== undefined) ctx.globalAlpha = baseAlpha * run.alpha;
            ctx.textAlign = run.align;
            ctx.fillText(run.text, run.x, run.y);
        }
        if (runs.some((run) => run.alpha !== undefined)) ctx.globalAlpha = baseAlpha;
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = "rgba(0,0,0,0)";
}

/** Horizontal geometry of a block's lines. */
function lineGeometry(block: PreviewTextBlock, x: number) {
    const { style } = block;
    const tw = block.width;
    const anchorX = style.textAlign === "left" ? x + 8 : style.textAlign === "right" ? x + tw - 8 : x + tw / 2;
    const lineStart = (lineWidth: number) => (style.textAlign === "left" ? anchorX : style.textAlign === "right" ? anchorX - lineWidth : anchorX - lineWidth / 2);
    return { anchorX, lineStart };
}

/** The runs the full block paints: whole lines, or single characters when letter-spaced (the pre-10b loop). */
function fullRuns(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number): TextRun[] {
    const { anchorX, lineStart } = lineGeometry(block, x);
    const runs: TextRun[] = [];
    block.lines.forEach((line, index) => {
        const lineY = y + block.lineHeight * (index + 0.5);
        if (block.letterSpacing !== 0) {
            let cx = lineStart(line.width);
            for (const ch of line.text) {
                runs.push({ text: ch, x: cx, y: lineY, align: "left" });
                cx += ctx.measureText(ch).width + block.letterSpacing;
            }
            return;
        }
        runs.push({ text: line.text, x: anchorX, y: lineY, align: block.style.textAlign });
    });
    return runs;
}

function applyStyleShadow(ctx: PreviewTextContext, block: PreviewTextBlock): void {
    const { style, pixelScale } = block;
    if (style.shadowBlur > 0) {
        ctx.shadowColor = style.shadowColor;
        ctx.shadowBlur = style.shadowBlur * pixelScale;
        ctx.shadowOffsetX = style.shadowOffsetX * pixelScale;
        ctx.shadowOffsetY = style.shadowOffsetY * pixelScale;
    }
}

/** The full block; `glowOverride` replaces the style glow size (glow states). */
function drawFullBlock(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, glowOverride?: number): void {
    const { style, fontSize, letterSpacing, pixelScale } = block;
    drawBackground(ctx, block, x, y);
    const glow = glowPx(block, glowOverride);
    if (glow > 0) drawGlowPasses(ctx, block, fullRuns(ctx, block, x, y), glow);
    applyStyleShadow(ctx, block);
    const paint = textPaint(ctx, block, x, y);
    const { anchorX, lineStart } = lineGeometry(block, x);
    const underline = (lineWidth: number, lineY: number) => {
        if (style.textDecoration !== "underline") return;
        const startX = lineStart(lineWidth);
        const underlineY = lineY + fontSize * 0.34;
        ctx.beginPath();
        ctx.strokeStyle = paint;
        ctx.lineWidth = Math.max(1, fontSize * 0.07);
        ctx.moveTo(startX, underlineY);
        ctx.lineTo(startX + lineWidth, underlineY);
        ctx.stroke();
    };
    const stroke = (value: string, px: number, py: number) => {
        if (style.strokeWidth <= 0) return;
        ctx.strokeStyle = style.strokeColor;
        ctx.lineWidth = style.strokeWidth * pixelScale;
        ctx.lineJoin = "round";
        ctx.strokeText(value, px, py);
    };
    block.lines.forEach((line, index) => {
        const lineY = y + block.lineHeight * (index + 0.5);
        if (letterSpacing !== 0) {
            ctx.textAlign = "left";
            let cx = lineStart(line.width);
            for (const ch of line.text) {
                stroke(ch, cx, lineY);
                ctx.fillStyle = paint;
                ctx.fillText(ch, cx, lineY);
                cx += ctx.measureText(ch).width + letterSpacing;
            }
            underline(line.width, lineY);
            return;
        }
        ctx.textAlign = style.textAlign;
        stroke(line.text, anchorX, lineY);
        ctx.fillStyle = paint;
        ctx.fillText(line.text, anchorX, lineY);
        underline(line.width, lineY);
    });
}

/**
 * Paints background, glow, shadow, stroke, fill and underline with the box's top-left at (x, y). The
 * caller owns save/restore, alpha and rotation, and must have called layoutPreviewTextBlock on `ctx`.
 */
export function drawPreviewTextBlock(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number): void {
    drawFullBlock(ctx, block, x, y);
}

/** Glow size (reference px) of a glow state: the style glow plus `level` × max(style glow, 0.3 × font size). */
function glowStateSize(block: PreviewTextBlock, level: number): number {
    const base = block.style.glowSize ?? 0;
    return base + Math.max(0, level) * Math.max(base, block.style.fontSize * 0.3);
}

/** Letter states: each glyph animates over this fraction of the progress, staggered left to right. */
const LETTER_WINDOW = 0.4;
/** Letter states: travel below the rest position, in font sizes. */
const LETTER_TRAVEL = 0.5;

/** Pixels a block may paint outside its box (background, stroke, shadow, glow; with `states`, their blur, glow, and letter travel). */
export function previewTextBlockBleed(block: PreviewTextBlock, states?: readonly TextState[]): number {
    const { style, pixelScale } = block;
    const stroke = style.strokeWidth * pixelScale;
    const shadow = style.shadowBlur > 0
        ? style.shadowBlur * pixelScale * 2 + Math.max(Math.abs(style.shadowOffsetX), Math.abs(style.shadowOffsetY)) * pixelScale
        : 0;
    const pad = (style.bgPadding ?? 0) * pixelScale;
    let glow = glowPx(block);
    let blur = 0;
    let travel = 0;
    for (const state of states ?? []) {
        if (state.kind === "glow") glow = Math.max(glow, glowPx(block, glowStateSize(block, state.level)));
        if (state.kind === "blur") blur = Math.max(blur, Math.round(state.radius * pixelScale) * 3);
        if (state.kind === "letters") travel = block.fontSize * LETTER_TRAVEL;
    }
    return Math.ceil(4 + stroke + shadow + pad + glow * 2 + blur + travel);
}

/** Canvas factory for blur states (an offscreen or @napi-rs canvas). */
export interface PreviewTextStateHelpers {
    createCanvas(width: number, height: number): { width: number; height: number; getContext(contextId: "2d"): unknown };
}

const isSpace = (glyph: string) => /^\s+$/u.test(glyph);

/** A glyph of a line: its text, x offset from the line start, and advance. */
interface LineGlyph {
    text: string;
    /** UTF-16 index in the line. */
    index: number;
    offset: number;
}

/**
 * Glyph positions matching the full drawing: prefix widths for plain lines (the line is one fillText),
 * per-character advances plus letter spacing for spaced lines (the pre-10b per-character loop).
 */
function lineGlyphs(ctx: PreviewTextContext, block: PreviewTextBlock, line: PreviewTextLine): LineGlyph[] {
    const glyphs: LineGlyph[] = [];
    let index = 0;
    let spaced = 0;
    for (const text of splitGraphemes(line.text)) {
        const offset = block.letterSpacing !== 0 ? spaced : ctx.measureText(line.text.slice(0, index)).width;
        glyphs.push({ text, index, offset });
        if (block.letterSpacing !== 0) for (const ch of text) spaced += ctx.measureText(ch).width + block.letterSpacing;
        index += text.length;
    }
    return glyphs;
}

interface Underline {
    x: number;
    y: number;
    width: number;
}

/** Glow passes, style shadow, then stroke and fill per run (the full drawing's order), then underlines. */
function paintRuns(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, runs: TextRun[], underlines: Underline[], glowOverride?: number): void {
    const { style, fontSize, pixelScale } = block;
    const glow = glowPx(block, glowOverride);
    if (glow > 0) drawGlowPasses(ctx, block, runs, glow);
    applyStyleShadow(ctx, block);
    const paint = textPaint(ctx, block, x, y);
    const baseAlpha = ctx.globalAlpha ?? 1;
    for (const run of runs) {
        if (run.alpha !== undefined) ctx.globalAlpha = baseAlpha * run.alpha;
        ctx.textAlign = run.align;
        if (style.strokeWidth > 0) {
            ctx.strokeStyle = style.strokeColor;
            ctx.lineWidth = style.strokeWidth * pixelScale;
            ctx.lineJoin = "round";
            ctx.strokeText(run.text, run.x, run.y);
        }
        ctx.fillStyle = run.fill ?? paint;
        ctx.fillText(run.text, run.x, run.y);
    }
    if (runs.some((run) => run.alpha !== undefined)) ctx.globalAlpha = baseAlpha;
    if (style.textDecoration !== "underline") return;
    for (const u of underlines) {
        if (u.width <= 0) continue;
        const underlineY = u.y + fontSize * 0.34;
        ctx.beginPath();
        ctx.strokeStyle = paint;
        ctx.lineWidth = Math.max(1, fontSize * 0.07);
        ctx.moveTo(u.x, underlineY);
        ctx.lineTo(u.x + u.width, underlineY);
        ctx.stroke();
    }
}

function glyphCount(block: PreviewTextBlock): number {
    return block.lines.reduce((sum, line) => sum + splitGraphemes(line.text).filter((g) => !isSpace(g)).length, 0);
}

/** Width of a run of glyphs in a line, from glyph `from` (inclusive) to `to` (exclusive). */
function glyphSpan(ctx: PreviewTextContext, block: PreviewTextBlock, line: PreviewTextLine, glyphs: LineGlyph[], from: number, to: number): number {
    if (to <= from) return 0;
    const end = to < glyphs.length ? glyphs[to].offset - (block.letterSpacing !== 0 ? block.letterSpacing : 0) : block.letterSpacing !== 0 ? line.width : ctx.measureText(line.text).width;
    return end - glyphs[from].offset;
}

function drawTypewriter(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, visible: number): void {
    drawBackground(ctx, block, x, y);
    const { lineStart } = lineGeometry(block, x);
    const runs: TextRun[] = [];
    const underlines: Underline[] = [];
    let left = Math.max(0, Math.floor(visible));
    block.lines.forEach((line, lineIndex) => {
        if (left <= 0) return;
        const lineY = y + block.lineHeight * (lineIndex + 0.5);
        const glyphs = lineGlyphs(ctx, block, line);
        let take = 0;
        while (take < glyphs.length && left > 0) {
            if (!isSpace(glyphs[take].text)) left -= 1;
            take += 1;
        }
        if (take === 0) return;
        const startX = lineStart(line.width);
        if (block.letterSpacing !== 0) {
            for (const glyph of glyphs.slice(0, take)) if (!isSpace(glyph.text)) runs.push({ text: glyph.text, x: startX + glyph.offset, y: lineY, align: "left" });
        } else {
            runs.push({ text: line.text.slice(0, take < glyphs.length ? glyphs[take].index : line.text.length), x: startX, y: lineY, align: "left" });
        }
        underlines.push({ x: startX, y: lineY, width: glyphSpan(ctx, block, line, glyphs, 0, take) });
    });
    paintRuns(ctx, block, x, y, runs, underlines);
}

function drawLetters(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, progress: number, direction: "rise" | "fall"): void {
    drawBackground(ctx, block, x, y);
    const { lineStart } = lineGeometry(block, x);
    const total = glyphCount(block);
    const runs: TextRun[] = [];
    const underlines: Underline[] = [];
    let glyphIndex = 0;
    block.lines.forEach((line, lineIndex) => {
        const lineY = y + block.lineHeight * (lineIndex + 0.5);
        const startX = lineStart(line.width);
        let allAtRest = true;
        for (const glyph of lineGlyphs(ctx, block, line)) {
            if (isSpace(glyph.text)) continue;
            const offset = total > 1 ? (glyphIndex / (total - 1)) * (1 - LETTER_WINDOW) : 0;
            glyphIndex += 1;
            const local = Math.min(1, Math.max(0, (progress - offset) / LETTER_WINDOW));
            let alpha: number;
            let drop: number;
            if (direction === "rise") {
                const r = 1 - local;
                const eased = 1 - r * r * r;
                alpha = eased;
                drop = (1 - eased) * LETTER_TRAVEL * block.fontSize;
            } else {
                const eased = local * local;
                alpha = 1 - local;
                drop = eased * LETTER_TRAVEL * block.fontSize;
            }
            if (alpha < 1 || drop !== 0) allAtRest = false;
            if (alpha <= 0) continue;
            runs.push({ text: glyph.text, x: startX + glyph.offset, y: lineY + drop, align: "left", alpha });
        }
        if (allAtRest) underlines.push({ x: startX, y: lineY, width: line.width });
    });
    paintRuns(ctx, block, x, y, runs, underlines);
}

/** Word index of every space-separated piece of every line (long words split across lines keep one index). */
function lineWordPieces(block: PreviewTextBlock): Array<Array<{ text: string; index: number; word: number }>> {
    const tokens = (block.text ?? block.lines.map((l) => l.text).join(" ")).split(/\s+/).filter(Boolean);
    let word = 0;
    let rest = tokens[0] ?? "";
    return block.lines.map((line) => {
        const pieces: Array<{ text: string; index: number; word: number }> = [];
        const re = /\S+/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(line.text))) {
            const text = match[0];
            pieces.push({ text, index: match.index, word });
            if (rest.startsWith(text) && rest.length > text.length) {
                rest = rest.slice(text.length);
            } else {
                word += 1;
                rest = tokens[word] ?? "";
            }
        }
        return pieces;
    });
}

function drawKaraoke(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, first: number, last: number): void {
    const { style, fontSize } = block;
    drawBackground(ctx, block, x, y);
    const { lineStart } = lineGeometry(block, x);
    const box = style.karaoke === "box";
    const highlight = style.highlightColor || (box ? "#7C3AED" : "#FFE14D");
    const runs: TextRun[] = [];
    const underlines: Underline[] = [];
    const pills: Array<[number, number, number, number]> = [];
    const pieces = lineWordPieces(block);
    block.lines.forEach((line, lineIndex) => {
        const lineY = y + block.lineHeight * (lineIndex + 0.5);
        const startX = lineStart(line.width);
        const glyphs = block.letterSpacing !== 0 ? lineGlyphs(ctx, block, line) : [];
        for (const piece of pieces[lineIndex]) {
            const current = piece.word >= first && piece.word <= last;
            const fill = current && !box ? highlight : undefined;
            let px: number;
            let width: number;
            if (block.letterSpacing !== 0) {
                const from = glyphs.findIndex((g) => g.index === piece.index);
                const to = glyphs.findIndex((g) => g.index >= piece.index + piece.text.length);
                const end = to < 0 ? glyphs.length : to;
                px = startX + glyphs[from].offset;
                width = glyphSpan(ctx, block, line, glyphs, from, end);
                for (const glyph of glyphs.slice(from, end)) runs.push({ text: glyph.text, x: startX + glyph.offset, y: lineY, align: "left", fill });
            } else {
                px = startX + ctx.measureText(line.text.slice(0, piece.index)).width;
                width = ctx.measureText(piece.text).width;
                runs.push({ text: piece.text, x: px, y: lineY, align: "left", fill });
            }
            if (current && box) {
                const padX = fontSize * 0.12;
                const h = fontSize * 1.2;
                pills.push([px - padX, lineY - h / 2, width + padX * 2, h]);
            }
        }
        underlines.push({ x: startX, y: lineY, width: line.width });
    });
    for (const [px, py, pw, ph] of pills) {
        ctx.fillStyle = highlight;
        fillRoundRect(ctx, px, py, pw, ph, fontSize * 0.25);
    }
    paintRuns(ctx, block, x, y, runs, underlines);
}

function drawWipe(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, fraction: number): void {
    if (fraction <= 0) return;
    if (fraction >= 1 || !ctx.save || !ctx.restore || !ctx.rect || !ctx.clip) {
        drawFullBlock(ctx, block, x, y);
        return;
    }
    const bleed = previewTextBlockBleed(block);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - bleed, y - bleed, (block.width + bleed * 2) * fraction, block.height + bleed * 2);
    ctx.clip();
    drawFullBlock(ctx, block, x, y);
    ctx.restore();
}

function drawBlur(ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, state: Extract<TextState, { kind: "blur" }>, helpers?: PreviewTextStateHelpers): void {
    const radius = Math.round(state.radius * block.pixelScale);
    if (radius <= 0 || !helpers || !ctx.drawImage) {
        drawFullBlock(ctx, block, x, y);
        return;
    }
    const pad = previewTextBlockBleed(block, [state]);
    const width = Math.max(1, Math.ceil(block.width + pad * 2));
    const height = Math.max(1, Math.ceil(block.height + pad * 2));
    const canvas = helpers.createCanvas(width, height);
    const temp = canvas.getContext("2d") as PreviewTextContext | null;
    if (!temp || !temp.getImageData || !temp.putImageData) {
        drawFullBlock(ctx, block, x, y);
        return;
    }
    temp.font = ctx.font;
    temp.textAlign = ctx.textAlign;
    temp.textBaseline = ctx.textBaseline;
    drawFullBlock(temp, block, pad, pad);
    const image = temp.getImageData(0, 0, width, height);
    image.data.set(boxBlurRgba(image.data, width, height, radius));
    temp.putImageData(image, 0, 0);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowColor = "rgba(0,0,0,0)";
    ctx.drawImage(canvas, x - pad, y - pad);
}

/**
 * Draws one text state (text/text-states.ts) with the box's top-left at (x, y); the caller owns
 * save/restore, alpha, and transforms, as for drawPreviewTextBlock. `full` draws exactly what
 * drawPreviewTextBlock draws; typewriter and letters place glyphs where the full layout has them (no
 * reflow); blur needs `helpers` (else it draws sharp).
 */
export function drawPreviewTextState(
    ctx: PreviewTextContext, block: PreviewTextBlock, x: number, y: number, state: TextState, helpers?: PreviewTextStateHelpers,
): void {
    switch (state.kind) {
        case "full":
            drawFullBlock(ctx, block, x, y);
            return;
        case "typewriter":
            if (state.visible >= glyphCount(block)) drawFullBlock(ctx, block, x, y);
            else drawTypewriter(ctx, block, x, y, state.visible);
            return;
        case "wipe":
            drawWipe(ctx, block, x, y, state.fraction);
            return;
        case "blur":
            drawBlur(ctx, block, x, y, state, helpers);
            return;
        case "glow":
            drawFullBlock(ctx, block, x, y, state.level > 0 ? glowStateSize(block, state.level) : undefined);
            return;
        case "letters":
            if (state.direction === "rise" ? state.progress >= 1 : state.progress <= 0) drawFullBlock(ctx, block, x, y);
            else drawLetters(ctx, block, x, y, state.progress, state.direction);
            return;
        case "karaoke":
            if (state.word < 0) drawFullBlock(ctx, block, x, y);
            else drawKaraoke(ctx, block, x, y, state.word, state.through ?? state.word);
            return;
    }
}
