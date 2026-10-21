// Masks on text and stickers in the preview (phase 10d). A text or sticker layer is drawn on the 2D compositor, not
// through the looks renderer, so a masked one takes a detour: its pixels (the padded text bitmap, a sticker image, an
// emoji glyph) are drawn into an offscreen canvas at device size, the shared LookRenderer runs the mask pass on them
// in the item box's coordinates (the box inside the bitmap: looks/masks.ts MaskBox, exactly as the GPU export's layer
// and the ffmpeg export's overlay do), and the result is drawn back where the layer goes. Without a renderer (no
// WebGL2, a lost context, a GL failure) the caller draws the layer unmasked, as video clips fall back to the raw frame.
import { maskLook, type LookPlan } from "@opennan/timeline-core/looks/look-plan";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";

/** A rectangle in the compositor's drawing units (CSS px, in the layer's placed frame). */
export interface LayerRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface LayerCanvas {
    width: number;
    height: number;
    getContext(contextId: "2d"): unknown;
}

/** Longest side of the offscreen layer in device px (larger layers are drawn at a lower density). */
export const MAX_MASKED_LAYER_SIDE = 2048;

/**
 * Paints a masked layer: `draw` paints the layer's pixels as it would on `ctx` (same coordinates), into an offscreen
 * canvas covering `outer` (the bitmap's rect, padding included) at `dpr`; the mask runs at keyframe time `t` in `box`
 * (the item's box, which sizes and places the mask); the masked pixels land on `outer` of `ctx` (its current transform
 * and globalAlpha apply). False when it cannot (no renderer or plan, a lost context, a GL failure): draw unmasked.
 */
export function paintMaskedLayer(
    ctx: Pick<CanvasRenderingContext2D, "drawImage">,
    renderer: Pick<LookRenderer, "isLost" | "canvas" | "upload" | "look" | "presentRegion" | "releaseAll"> | null,
    plan: LookPlan | null,
    t: number,
    dpr: number,
    outer: LayerRect,
    box: LayerRect,
    draw: (layer: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void,
    createCanvas: (width: number, height: number) => LayerCanvas,
): boolean {
    if (!renderer || !plan || renderer.isLost || !(outer.w > 0) || !(outer.h > 0)) return false;
    try {
        const width = Math.max(1, Math.round(Math.min(outer.w * Math.max(dpr, 0.01), MAX_MASKED_LAYER_SIDE)));
        const height = Math.max(1, Math.round(width * (outer.h / outer.w)));
        const sx = width / outer.w;
        const sy = height / outer.h;
        const canvas = createCanvas(width, height);
        const layer = canvas.getContext("2d") as CanvasRenderingContext2D | null;
        if (!layer) return false;
        layer.setTransform(sx, 0, 0, sy, -outer.x * sx, -outer.y * sy);
        draw(layer, outer.x, outer.y, outer.w, outer.h);
        const uploaded = renderer.upload(canvas as unknown as HTMLCanvasElement, width, height);
        const time = Math.max(0, t);
        const masked = renderer.look(uploaded, plan, time, time, { x: (box.x - outer.x) * sx, y: (box.y - outer.y) * sy, width: box.w * sx, height: box.h * sy });
        const region = renderer.presentRegion(masked, width, height);
        renderer.releaseAll();
        ctx.drawImage(renderer.canvas as CanvasImageSource, region.x, region.y, region.width, region.height, outer.x, outer.y, outer.w, outer.h);
        return true;
    } catch {
        renderer.releaseAll();
        return false;
    }
}

/** Per-clip mask-only plans (text and stickers draw their mask alone in the preview), memoized per clip object. */
export class LayerMaskCache {
    private byObject = new WeakMap<TimelineClip, LookPlan | null>();

    planFor(clip: TimelineClip): LookPlan | null {
        if (!clip.maskJson) return null;
        let plan = this.byObject.get(clip);
        if (plan === undefined) {
            plan = maskLook({ kind: "clip", ...clip });
            this.byObject.set(clip, plan);
        }
        return plan;
    }
}
