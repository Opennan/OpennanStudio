// Built-in graphics on the compositor canvas (phase 11). While the compositor runs, it draws each built-in graphics
// clip itself — between V2+ media and text, like both exports — so the effect pass covers graphics too. As the
// exports do (export/src/raster/graphics-frame.ts), the template frame is drawn with the 10d renderer on a clear
// full-frame layer, then placed as one layer (graphicsLayerMatrix, group opacity) clipped to the project frame.
// The bounds the renderer returns frame the selection box. Custom-code (add-on) graphics cannot be drawn on a
// canvas: they keep their DOM layer.
import { graphicsLayerHidden, graphicsLayerMatrix, type GraphicsLayerPlacement } from "@opennan/timeline-core/graphics/layer";
import { drawGraphicsFrame, graphicsAssetUrls, graphicsFrameAt, isBuiltinGraphics } from "@opennan/timeline-core/graphics/render";
import type { GraphicsBounds, GraphicsContext } from "@opennan/timeline-core/graphics/types";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";

export interface GraphicsLayerSurface {
    width: number;
    height: number;
    getContext(id: "2d"): unknown;
}

export interface GraphicsLayerFrame {
    /** The full-frame layer (`width × height` device px) holding the template frame. */
    canvas: GraphicsLayerSurface;
    width: number;
    height: number;
    /** Painted bounds in layer px, or null when the frame paints nothing. */
    bounds: GraphicsBounds | null;
}

export interface GraphicsLayerCacheOptions {
    createCanvas(): GraphicsLayerSurface;
    /** A decoded template asset (logo) for `url`, or null while it loads or after it failed. */
    assetImage(url: string, owner: string): CanvasImageSource | null;
    /** True once the asset finished (loaded or failed): a frame drawn without it is final. */
    assetSettled(url: string): boolean;
}

interface Entry {
    canvas: GraphicsLayerSurface;
    key: string;
    bounds: GraphicsBounds | null;
}

/** One layer per graphics clip, redrawn only when its template frame, size, or parameters change. */
export class GraphicsLayerCache {
    private readonly layers = new Map<string, Entry>();

    constructor(private readonly options: GraphicsLayerCacheOptions) {}

    /** The clip's layer at clip-local `local` seconds, `width × height` px; null when this build does not draw it. */
    frame(clip: TimelineClip, local: number, width: number, height: number): GraphicsLayerFrame | null {
        if (!isBuiltinGraphics(clip)) return null;
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        const frame = graphicsFrameAt(clip, local);
        const key = `${frame}|${w}x${h}|${clip.remotionTemplateId}|${clip.remotionPropsJson ?? ""}|${clip.endTime - clip.startTime}`;
        let entry = this.layers.get(clip.id);
        if (!entry) {
            entry = { canvas: this.options.createCanvas(), key: "", bounds: null };
            this.layers.set(clip.id, entry);
        }
        if (entry.key !== key) {
            const canvas = entry.canvas;
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            const ctx = canvas.getContext("2d") as GraphicsContext | null;
            if (!ctx) return null;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.clearRect(0, 0, w, h);
            const urls = graphicsAssetUrls(clip);
            let pending = false;
            entry.bounds = drawGraphicsFrame(ctx, clip, {
                width: w, height: h, frame,
                assets: {
                    image: (url) => {
                        if (!urls.includes(url)) return null;
                        const image = this.options.assetImage(url, clip.id);
                        if (!image && !this.options.assetSettled(url)) pending = true;
                        return image;
                    },
                },
            });
            // A frame drawn while an asset loads is redrawn next time (the asset's load requests a draw).
            entry.key = pending ? "" : key;
        }
        return { canvas: entry.canvas, width: w, height: h, bounds: entry.bounds };
    }

    /** Forgets every drawn frame (the graphics fonts arrived). */
    invalidate(): void {
        for (const entry of this.layers.values()) entry.key = "";
    }

    /** Drops the layers of clips not in `ids`. */
    retain(ids: ReadonlySet<string>): void {
        for (const id of [...this.layers.keys()]) if (!ids.has(id)) this.layers.delete(id);
    }
}

/** The layer's painted bounds as fractions of the layer, or null when it paints nothing. */
export function graphicsBoundsFractions(frame: GraphicsLayerFrame): { x0: number; y0: number; x1: number; y1: number } | null {
    const b = frame.bounds;
    if (!b || !(b.width > 0) || !(b.height > 0)) return null;
    return { x0: b.x / frame.width, y0: b.y / frame.height, x1: (b.x + b.width) / frame.width, y1: (b.y + b.height) / frame.height };
}

/**
 * Places the layer on `ctx` over the project frame `rect` (the context's current units): clipped to the frame,
 * through the layer matrix, at the layer's opacity as a group — the DOM layer's CSS transform and opacity.
 */
export function paintGraphicsLayer(
    ctx: Pick<CanvasRenderingContext2D, "save" | "restore" | "beginPath" | "rect" | "clip" | "translate" | "transform" | "drawImage" | "globalAlpha">,
    frame: GraphicsLayerFrame,
    placement: GraphicsLayerPlacement,
    rect: { x: number; y: number; w: number; h: number },
): void {
    if (graphicsLayerHidden(placement) || !(rect.w > 0) || !(rect.h > 0)) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.translate(rect.x, rect.y);
    ctx.transform(...graphicsLayerMatrix(placement, rect.w, rect.h));
    ctx.globalAlpha = Math.min(1, Math.max(0, placement.opacity));
    ctx.drawImage(frame.canvas as unknown as CanvasImageSource, 0, 0, rect.w, rect.h);
    ctx.restore();
}
