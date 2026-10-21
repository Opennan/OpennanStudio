// Text raster states in the preview (phase 10b): the current state (text/text-states.ts) is drawn once by
// the shared drawing code (lib/preview-text-draw.ts drawPreviewTextState, the export rasterizer's
// function) into an offscreen bitmap, cached, and the compositor draws the cached bitmap with the clip's
// transform (scale, |scaleX|, rotation, opacity), as the export overlays its atlas cell. Blur states run
// a box blur over the bitmap, so caching matters most there.
import {
    drawPreviewTextState, layoutPreviewTextBlock, previewTextBlockBleed,
    type PreviewTextBlock, type PreviewTextContext, type PreviewTextStateHelpers,
} from "@opennan/timeline-core/lib/preview-text-draw";
import { textStateAt, textStatePlan, type TextState, type TextStatePlan } from "@opennan/timeline-core/text/text-states";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import { LruCache } from "./lru-cache";

export interface CanvasLike {
    width: number;
    height: number;
    getContext(contextId: "2d"): unknown;
}

export type CreateCanvas = (width: number, height: number) => CanvasLike;

export interface TextBitmapRequest {
    clipId: string;
    text: string;
    textStyle: string | null;
    state: TextState;
    /** Clip scale the text is laid out at (textLayoutScale, or the live scale while a drag resizes static text). */
    layoutScale: number;
    /** Frame CSS px per export-reference px. */
    frameScale: number;
    /** Frame width in CSS px (the wrap width is a fraction of it). */
    frameWidth: number;
    /** Device px per CSS px to draw the bitmap at. */
    density: number;
}

export interface TextBitmap {
    canvas: CanvasLike;
    /** Layout box at `layoutScale`, CSS px (what the clip anchors and rotates by). */
    boxW: number;
    boxH: number;
    /** CSS px the bitmap extends beyond the box on every side. */
    bleed: number;
    /** CSS px per bitmap px (draw the canvas at canvas.width × pxSize). */
    pxSize: number;
    /** The layout scale the bitmap was drawn at (a reused drag bitmap differs from the request's). */
    layoutScale: number;
}

export interface TextBitmapOptions {
    /**
     * A resize drag is in progress: return the last bitmap of the same text and state, drawn at another
     * layout scale (within ×2 of the request), instead of drawing a new bitmap on every pointer move. The
     * caller places it by its own `layoutScale`; the exact scale is drawn on release.
     */
    reuseScaled?: boolean;
}

/** Largest bitmap side; bigger text lowers the density instead. */
export const MAX_TEXT_BITMAP_SIDE = 4096;
export const TEXT_BITMAP_CACHE_SIZE = 64;
/** Byte budget of the cached bitmaps (w·h·4 each). */
export const TEXT_BITMAP_CACHE_BYTES = 128 * 1024 * 1024;
/** A reused drag bitmap stays within this factor of the wanted layout scale. */
const MAX_REUSE_SCALE_RATIO = 2;

const SEP = "\u0001";

/**
 * Cache key: clip, style, text, state, layout scale, frame scale (the box is reported in CSS px), raster
 * resolution (device px per reference px), and the reference wrap width.
 */
export function textBitmapKey(request: TextBitmapRequest): string {
    return `${unscaledKey(request)}${SEP}${request.layoutScale.toFixed(4)}`;
}

/** The key without the layout scale (what a resize drag reuses across). */
function unscaledKey(request: TextBitmapRequest): string {
    const resolution = request.frameScale * request.density;
    const referenceWidth = request.frameScale > 0 ? request.frameWidth / request.frameScale : request.frameWidth;
    return [
        request.clipId, request.textStyle ?? "", request.text, JSON.stringify(request.state),
        request.frameScale.toFixed(5), resolution.toFixed(4), referenceWidth.toFixed(1),
    ].join(SEP);
}

export class TextStateBitmapCache {
    private readonly cache: LruCache<TextBitmap>;
    private measure: CanvasLike | null = null;
    /** Unscaled key → the key of the latest bitmap drawn for it (the bitmap a resize drag reuses). */
    private readonly latest = new Map<string, string>();

    constructor(private readonly createCanvas: CreateCanvas, max = TEXT_BITMAP_CACHE_SIZE, maxBytes = TEXT_BITMAP_CACHE_BYTES) {
        // Shrinking an evicted canvas frees its backing store right away (browsers keep it until GC otherwise).
        this.cache = new LruCache<TextBitmap>(max, (bitmap, key) => {
            bitmap.canvas.width = 0;
            bitmap.canvas.height = 0;
            for (const [unscaled, latestKey] of this.latest) {
                if (latestKey === key) this.latest.delete(unscaled);
            }
        }, { maxBytes, sizeOf: (bitmap) => bitmap.canvas.width * bitmap.canvas.height * 4 });
    }

    get size(): number {
        return this.cache.size;
    }

    /** Bytes of bitmap backing stores held. */
    get bytes(): number {
        return this.cache.bytes;
    }

    keys(): string[] {
        return this.cache.keys();
    }

    /** Drops every bitmap (fonts finished loading, the document was hidden). */
    clear(): void {
        this.cache.clear();
        this.latest.clear();
    }

    /** The cached bitmap for the request, drawing it on a miss (see TextBitmapOptions for drags). */
    get(request: TextBitmapRequest, options: TextBitmapOptions = {}): TextBitmap | null {
        const key = textBitmapKey(request);
        const hit = this.cache.get(key);
        if (hit) return hit;
        const unscaled = unscaledKey(request);
        if (options.reuseScaled) {
            const latestKey = this.latest.get(unscaled);
            const reused = latestKey ? this.cache.get(latestKey) : undefined;
            if (reused && reused.layoutScale > 0 && request.layoutScale > 0) {
                const ratio = request.layoutScale / reused.layoutScale;
                if (ratio <= MAX_REUSE_SCALE_RATIO && ratio >= 1 / MAX_REUSE_SCALE_RATIO) return reused;
            }
        }
        const bitmap = this.render(request);
        if (bitmap) {
            this.cache.set(key, bitmap);
            if (this.cache.peek(key) === bitmap) this.latest.set(unscaled, key);
        }
        return bitmap;
    }

    /** Lays the text out in export-reference px (fixed paddings then scale with the frame, as in the export). */
    private layout(ctx: PreviewTextContext, request: TextBitmapRequest): PreviewTextBlock {
        return layoutPreviewTextBlock(ctx, {
            text: request.text,
            textStyle: request.textStyle,
            scale: request.layoutScale,
            frameScale: 1,
            frameWidth: request.frameScale > 0 ? request.frameWidth / request.frameScale : request.frameWidth,
        });
    }

    private render(request: TextBitmapRequest): TextBitmap | null {
        this.measure ??= this.createCanvas(1, 1);
        const measureCtx = this.measure.getContext("2d") as PreviewTextContext | null;
        if (!measureCtx) return null;
        const frameScale = request.frameScale > 0 ? request.frameScale : 1;
        let block = this.layout(measureCtx, request);
        const bleed = previewTextBlockBleed(block, [request.state]);
        // Device px per reference px, capped so the bitmap stays within MAX_TEXT_BITMAP_SIDE.
        const side = Math.max(block.width, block.height) + bleed * 2;
        const resolution = Math.max(1e-3, Math.min(frameScale * Math.max(0.01, request.density), MAX_TEXT_BITMAP_SIDE / Math.max(1, side)));
        const canvas = this.createCanvas(Math.max(1, Math.ceil((block.width + bleed * 2) * resolution)), Math.max(1, Math.ceil((block.height + bleed * 2) * resolution)));
        const ctx = canvas.getContext("2d") as (PreviewTextContext & { setTransform?(a: number, b: number, c: number, d: number, e: number, f: number): void }) | null;
        if (!ctx) return null;
        ctx.setTransform?.(resolution, 0, 0, resolution, 0, 0);
        // Layout again on the bitmap's own context: it sets the font, alignment, and baseline there.
        block = this.layout(ctx, request);
        const helpers: PreviewTextStateHelpers = { createCanvas: this.createCanvas };
        drawPreviewTextState(ctx, block, bleed, bleed, request.state, helpers);
        return { canvas, boxW: block.width * frameScale, boxH: block.height * frameScale, bleed: bleed * frameScale, pxSize: frameScale / resolution, layoutScale: request.layoutScale };
    }
}

const FULL_STATE: TextState = { kind: "full" };
const planMemo = new WeakMap<TimelineClip, TextStatePlan>();

/** The text clip's raster state at item-local `t` (the plan is memoized per clip object). */
export function clipTextStateAt(clip: TimelineClip, t: number): { state: TextState; index: number; animated: boolean } {
    let plan = planMemo.get(clip);
    if (!plan) {
        plan = textStatePlan(clip);
        planMemo.set(clip, plan);
    }
    if (!plan.animated) return { state: plan.states[0] ?? FULL_STATE, index: 0, animated: false };
    const state = textStateAt(plan, t);
    return { state, index: plan.states.indexOf(state), animated: true };
}
