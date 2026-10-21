// A clip-cut transition window in the compositor (phase 10b): the export blends two full-frame transparent
// layers, each holding one clip placed with its overlay placement and motion (compile/clip-lanes.ts), with
// the shared transition expression on RGBA. Here each side is drawn the same way into a frame-sized clear
// canvas, both are uploaded to the LookRenderer, mixed by renderTransition (4 channels), and the result is
// drawn over the frame. Outside windows nothing changes.
import type { TransitionDef } from "@opennan/timeline-core/looks/transitions";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { placedBox, type ClipTransform, type FrameRect } from "./clip-motion";

export interface WindowSideDraw {
    /** The clip's box at scale 1 (frame pixels, as the compositor places overlays). */
    box: { w: number; h: number };
    transform: ClipTransform;
    /** Draws the clip's pixels into its placed rect (centre origin, already rotated; alpha set). */
    paint(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void;
}

/** Widest layer processed (as the look passes cap their work). */
const MAX_LAYER_WIDTH = 1920;

/**
 * Draws the window onto `target` (CSS pixels, `frame` the project frame) and returns true, or false when the
 * renderer cannot (lost context, GL error): the caller then draws the live clip alone.
 */
export function drawClipWindow(
    target: Pick<CanvasRenderingContext2D, "drawImage">, renderer: LookRenderer, frame: FrameRect, dpr: number, def: TransitionDef, p: number,
    a: WindowSideDraw, b: WindowSideDraw, layers: [HTMLCanvasElement, HTMLCanvasElement],
): boolean {
    if (renderer.isLost || frame.w < 1 || frame.h < 1) return false;
    try {
        const scale = dpr * Math.min(1, MAX_LAYER_WIDTH / (frame.w * dpr));
        const width = Math.max(2, Math.round(frame.w * scale));
        const height = Math.max(2, Math.round(frame.h * scale));
        [a, b].forEach((side, i) => {
            const canvas = layers[i];
            if (canvas.width !== width) canvas.width = width;
            if (canvas.height !== height) canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("no 2d context");
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, width, height);
            ctx.setTransform(scale, 0, 0, scale, -frame.x * scale, -frame.y * scale);
            const visual = placedBox(frame, side.box, side.transform);
            ctx.save();
            ctx.translate(visual.cx, visual.cy);
            if (visual.rotation) ctx.rotate(visual.rotation);
            ctx.globalAlpha = Math.min(1, Math.max(0, side.transform.opacity));
            if (side.transform.opacity > 0 && visual.w > 0 && visual.h > 0) side.paint(ctx, -visual.w / 2, -visual.h / 2, visual.w, visual.h);
            ctx.restore();
        });
        const out = renderer.transition(renderer.upload(layers[0], width, height), renderer.upload(layers[1], width, height), def, p, 4);
        const region = renderer.presentRegion(out, width, height);
        target.drawImage(renderer.canvas as CanvasImageSource, region.x, region.y, region.width, region.height, frame.x, frame.y, frame.w, frame.h);
        renderer.releaseAll();
        return true;
    } catch {
        renderer.releaseAll?.();
        return false;
    }
}
