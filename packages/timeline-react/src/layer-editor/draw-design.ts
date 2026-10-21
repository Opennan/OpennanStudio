// packages/timeline-react/src/layer-editor/draw-design.ts
// Draws a layered design on a 2D context in design pixels (the caller sets the view scale).
// Text: the original word, cells rebuilt from original glyphs, or the closest font (see design/glyphs.ts).
import { glyphLibrary, layoutText, type GlyphRef } from "@opennan/timeline-core/design/glyphs";
import { layerFrame, type DesignLayer, type LayerDesign, type TextLayer } from "@opennan/timeline-core/design/model";
import type { ImageSource } from "./image-cache";

export interface DrawOptions {
    /** Layer ids not to draw (the text being edited inline). */
    skip?: ReadonlySet<string>;
}

export function drawDesign(ctx: CanvasRenderingContext2D, design: LayerDesign, images: ImageSource, options: DrawOptions = {}): void {
    const lib = glyphLibrary(design);
    for (const layer of design.layers) {
        if (!layer.visible || layer.opacity <= 0 || options.skip?.has(layer.id)) continue;
        const f = layerFrame(layer);
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.translate(f.cx, f.cy);
        if (f.rotation) ctx.rotate(f.rotation);
        ctx.scale(layer.transform.scale, layer.transform.scale);
        if (layer.kind === "image") {
            const img = images.get(layer.src);
            if (img) ctx.drawImage(img, -layer.box.w / 2, -layer.box.h / 2, layer.box.w, layer.box.h);
        } else {
            drawText(ctx, layer, lib, images);
        }
        ctx.restore();
    }
}

/** Draws a text layer about its box centre (the context is already at the centre, scaled and rotated). */
function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer, lib: readonly GlyphRef[], images: ImageSource): void {
    const ox = -layer.box.w / 2, oy = -layer.box.h / 2;
    const out = layoutText(layer, lib);
    if (out.mode === "original" && layer.original.word) {
        const w = layer.original.word;
        const img = images.get(w.src);
        if (img) ctx.drawImage(img, ox + w.dx, oy + w.dy, w.w, w.h);
        return;
    }
    if (out.mode === "glyphs") {
        for (const c of out.cells) {
            if (!c.src) continue;
            const img = images.get(c.src);
            if (img) ctx.drawImage(img, ox + c.x, oy + c.y, c.w, c.h);
        }
        return;
    }
    drawFontText(ctx, layer, ox, oy);
}

export function fontOf(layer: TextLayer, size: number): string {
    return `${layer.style.weight} ${size}px "${layer.style.font}", system-ui, sans-serif`;
}

/** Font size whose ink height fills the box, and a horizontal squeeze (0.8–1.25) toward the box width. */
export function fitFont(ctx: CanvasRenderingContext2D, layer: TextLayer): { size: number; sx: number; left: number; ascent: number; width: number } {
    const probe = 100;
    ctx.font = fontOf(layer, probe);
    const m0 = ctx.measureText(layer.original.text || layer.text || " ");
    const inkH = Math.max(1, m0.actualBoundingBoxAscent + m0.actualBoundingBoxDescent);
    const size = Math.max(6, (probe * layer.box.h) / inkH);
    ctx.font = fontOf(layer, size);
    const ref = ctx.measureText(layer.original.text || layer.text || " ");
    const refW = Math.max(1, ref.actualBoundingBoxLeft + ref.actualBoundingBoxRight);
    const sx = Math.min(1.25, Math.max(0.8, layer.box.w / refW));
    const m = ctx.measureText(layer.text || " ");
    return { size, sx, left: m.actualBoundingBoxLeft, ascent: m.actualBoundingBoxAscent, width: (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) * sx };
}

function drawFontText(ctx: CanvasRenderingContext2D, layer: TextLayer, ox: number, oy: number): void {
    const s = layer.style;
    const fit = fitFont(ctx, layer);
    ctx.save();
    ctx.translate(ox + (layer.box.w - fit.width) / 2, oy);
    ctx.scale(fit.sx, 1);
    ctx.font = fontOf(layer, fit.size);
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    if (s.track) (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${s.track * fit.size}px`;
    if (s.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = layer.box.h * 0.08;
        ctx.shadowOffsetY = layer.box.h * 0.06;
    }
    if (s.stroke && s.strokeWidth > 0) {
        ctx.strokeStyle = s.stroke;
        ctx.lineWidth = (s.strokeWidth * 2) / fit.sx;
        ctx.strokeText(layer.text, fit.left, fit.ascent);
        ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = s.fill;
    ctx.fillText(layer.text, fit.left, fit.ascent);
    ctx.restore();
}

/** The layer under a design point, topmost first, using image alpha where known. */
export function layerAt(design: LayerDesign, x: number, y: number, alphaAt: (src: string, fx: number, fy: number) => number | null): DesignLayer | null {
    for (let i = design.layers.length - 1; i >= 0; i--) {
        const l = design.layers[i];
        if (!l.visible || l.locked || (l.kind === "image" && l.role === "shadow")) continue;
        const f = layerFrame(l);
        const dx = x - f.cx, dy = y - f.cy;
        const c = Math.cos(-f.rotation), s = Math.sin(-f.rotation);
        const lx = dx * c - dy * s, ly = dx * s + dy * c;
        if (Math.abs(lx) > f.w / 2 || Math.abs(ly) > f.h / 2) continue;
        if (l.kind === "text") return l;
        const a = alphaAt(l.src, lx / f.w + 0.5, ly / f.h + 0.5);
        if (a === null || a > 24) return l;
    }
    return null;
}
