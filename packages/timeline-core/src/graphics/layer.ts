// Where a graphics clip's full-frame layer lands (phase 10d), from the shared motion model (keyframes, in/out/combo
// animations, rotation, opacity): the same mapping as the preview's CSS transform
//   translate((posX − 0.5 + dx)·W, (posY − 0.5 + dy)·H) rotate(rotation) scale(scale·scaleX, scale)
// about the layer centre. Both export engines use these numbers for every output frame.
import type { TimelineClip } from "../model/timeline";
import { itemMotion, motionAt } from "../motion/transform";

export interface GraphicsLayerPlacement {
    /** Translation of the layer centre from the frame centre, in frame fractions. */
    x: number;
    y: number;
    scale: number;
    scaleX: number;
    /** Degrees, clockwise. */
    rotation: number;
    opacity: number;
}

/** The layer placement at clip-local `localSeconds`. */
export function graphicsLayerAt(clip: TimelineClip, localSeconds: number): GraphicsLayerPlacement {
    const t = motionAt(itemMotion({ kind: "clip", clip }), Number.isFinite(localSeconds) ? localSeconds : 0);
    return { x: t.posX - 0.5 + t.dx, y: t.posY - 0.5 + t.dy, scale: t.scale, scaleX: t.scaleX, rotation: t.rotation, opacity: t.opacity };
}

/** Canvas `setTransform` arguments [a, b, c, d, e, f] mapping layer px (0..W × 0..H) onto the frame. */
export function graphicsLayerMatrix(p: GraphicsLayerPlacement, width: number, height: number): [number, number, number, number, number, number] {
    const r = (p.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const sx = p.scale * p.scaleX;
    const sy = p.scale;
    const a = cos * sx;
    const b = sin * sx;
    const c = -sin * sy;
    const d = cos * sy;
    const cx = width / 2 + p.x * width;
    const cy = height / 2 + p.y * height;
    // M = T(cx, cy) · R · S · T(−W/2, −H/2)
    return [a, b, c, d, cx - a * (width / 2) - c * (height / 2), cy - b * (width / 2) - d * (height / 2)];
}

/** The layer draws nothing (scale or opacity zero). */
export function graphicsLayerHidden(p: GraphicsLayerPlacement): boolean {
    return !(p.opacity > 0) || p.scale * p.scaleX === 0 || p.scale === 0;
}

/**
 * Output frames on which the clip shows in an export at `fps`: k with start ≤ k/fps < end, clipped to
 * [0, frameCount). Both export engines draw exactly these frames.
 */
export function graphicsOutputFrames(clip: Pick<TimelineClip, "startTime" | "endTime">, fps: number, frameCount: number): { first: number; count: number } {
    const first = Math.max(0, Math.ceil(clip.startTime * fps - 1e-6));
    const end = Math.min(frameCount, Math.ceil(clip.endTime * fps - 1e-6));
    return { first, count: Math.max(0, end - first) };
}
