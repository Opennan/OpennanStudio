"use client";
// Text template and caption style thumbnails drawn with the preview's own text drawing
// (timeline-core lib/preview-text-draw.ts), so a card looks exactly like the clip it adds. The bundled
// faces a style uses are loaded first (document.fonts.load) and the card redraws when they arrive.
// Karaoke styles step the highlighted word while hovered; static under prefers-reduced-motion. The
// canvas stays transparent: the card's backdrop comes from editing.css tokens; the text colours are
// the template's own (content, not chrome).
import { useEffect, useRef, useState } from "react";
import {
    drawPreviewTextBlock, drawPreviewTextState, layoutPreviewTextBlock, parsePreviewTextStyle, previewTextBlockBleed,
    type PreviewTextBlock, type PreviewTextContext,
} from "@opennan/timeline-core/lib/preview-text-draw";
import { fontFacesForStyle } from "@opennan/timeline-core/text/fonts";
import { captionTokens } from "@opennan/timeline-core/text/captions";

export const TEXT_THUMB_W = 160;
export const TEXT_THUMB_H = 100;

/** CSS font shorthands to pass to document.fonts.load() before drawing this style. */
export function textThumbFontQueries(styleJson: string | null): string[] {
    return fontFacesForStyle(styleJson).map((f) => `${f.style === "italic" ? "italic " : ""}${f.weight} 32px "${f.family}"`);
}

export interface TextThumbSpec {
    text: string;
    styleJson: string | null;
    /** Karaoke styles: the highlighted word (null draws the plain block). */
    karaokeWord?: number | null;
    /** Pixels along the bottom edge the text stays clear of (a card badge drawn over the thumbnail). */
    reserveBottom?: number;
}

type ThumbContext = PreviewTextContext & { clearRect?(x: number, y: number, w: number, h: number): void };

/** Font size as a share of the thumbnail height before fitting. */
const FONT_SHARE = 0.3;

/**
 * Lays the text out to fit a width × height canvas (font about 30% of the height, shrunk until the
 * block plus most of its bleed fits) and draws it centred. Null without a 2D context (jsdom).
 */
export function drawTextThumb(ctx: ThumbContext | null | undefined, width: number, height: number, spec: TextThumbSpec): PreviewTextBlock | null {
    if (!ctx) return null;
    ctx.clearRect?.(0, 0, width, height);
    // The text fits and centres in the area above the reserved strip.
    height = Math.max(1, height - Math.max(0, spec.reserveBottom ?? 0));
    const style = parsePreviewTextStyle(spec.styleJson);
    let frameScale = (height * FONT_SHARE) / Math.max(1, style.fontSize);
    let block: PreviewTextBlock | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        block = layoutPreviewTextBlock(ctx, { text: spec.text, textStyle: spec.styleJson, scale: 1, frameScale, frameWidth: width });
        const bleed = previewTextBlockBleed(block) * 0.6;
        if (block.width + bleed * 2 <= width * 0.96 && block.height + bleed * 2 <= height * 0.92) break;
        frameScale *= 0.85;
    }
    if (!block) return null;
    const x = (width - block.width) / 2;
    const y = (height - block.height) / 2;
    ctx.save?.();
    if (spec.karaokeWord !== null && spec.karaokeWord !== undefined) drawPreviewTextState(ctx, block, x, y, { kind: "karaoke", word: spec.karaokeWord });
    else drawPreviewTextBlock(ctx, block, x, y);
    ctx.restore?.();
    return block;
}

function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The word a karaoke thumbnail highlights at rest (the second word reads as "highlighting"). */
export function restingKaraokeWord(text: string): number {
    return captionTokens(text).length > 1 ? 1 : 0;
}

/** Karaoke step while hovered, ms. */
const KARAOKE_STEP_MS = 420;

export interface TextThumbProps {
    text: string;
    styleJson: string | null;
    /** Karaoke style: highlight a word, stepping through the words while `active`. */
    karaoke?: boolean;
    active?: boolean;
    width?: number;
    height?: number;
    /** Pixels along the bottom edge the text stays clear of (drawTextThumb). */
    reserveBottom?: number;
}

/** A thumbnail canvas (device-pixel sharp) for a text style. */
export function TextThumb({ text, styleJson, karaoke = false, active = false, width = TEXT_THUMB_W, height = TEXT_THUMB_H, reserveBottom = 0 }: TextThumbProps) {
    const ref = useRef<HTMLCanvasElement>(null);
    const [fontsLoaded, setFontsLoaded] = useState(0);
    const [word, setWord] = useState(() => restingKaraokeWord(text));
    const dpr = typeof window !== "undefined" ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1;

    // Load the style's bundled faces, then redraw.
    useEffect(() => {
        const fonts = typeof document !== "undefined" ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
        const queries = textThumbFontQueries(styleJson);
        if (!fonts?.load || queries.length === 0) return;
        let live = true;
        void Promise.all(queries.map((q) => fonts.load(q)))
            .then(() => { if (live) setFontsLoaded((n) => n + 1); })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [styleJson]);

    // Karaoke: step the highlighted word while hovered (not under reduced motion).
    useEffect(() => {
        if (!karaoke) return;
        const rest = restingKaraokeWord(text);
        if (!active || prefersReducedMotion()) {
            setWord(rest);
            return;
        }
        const count = Math.max(1, captionTokens(text).length);
        setWord(0);
        const timer = window.setInterval(() => setWord((w) => (w + 1) % count), KARAOKE_STEP_MS);
        return () => window.clearInterval(timer);
    }, [karaoke, active, text]);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
            ctx = canvas.getContext("2d");
        } catch {
            ctx = null;
        }
        if (!ctx) return;
        try {
            ctx.setTransform?.(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.scale?.(dpr, dpr);
            drawTextThumb(ctx as unknown as ThumbContext, width, height, { text, styleJson, karaokeWord: karaoke ? word : null, reserveBottom });
        } catch {
            /* a broken style draws nothing rather than breaking the library */
        }
    }, [text, styleJson, karaoke, word, fontsLoaded, width, height, dpr, reserveBottom]);

    return <canvas ref={ref} width={Math.round(width * dpr)} height={Math.round(height * dpr)} aria-hidden="true" data-karaoke-word={karaoke ? word : undefined} />;
}
