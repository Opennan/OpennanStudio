// Graphics clip placement (phase 10c). A graphics (Remotion) clip is a full-frame DOM layer above the preview canvas;
// its CSS transform comes from the shared motion model (clipMotionAt: keyframes, in/out/combo animations, rotation,
// opacity) so it moves, rotates, and animates like every other visual clip:
//   translate((posX − 0.5 + dx) · 100 %, (posY − 0.5 + dy) · 100 %) rotate(rotation) scale(scale · scaleX, scale)
// about the layer's centre. A live drag override replaces the base channels (the animation stays on top).
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import { applyDragOverride, clipMotionAt, type DragOverride } from "../preview/motion/clip-motion";
import type { RemotionTransformOverride } from "./registry";

export interface RemotionLayerPlacement {
    /** Translation of the layer centre from the frame centre, in frame fractions. */
    x: number;
    y: number;
    scale: number;
    scaleX: number;
    /** Degrees, clockwise. */
    rotation: number;
    opacity: number;
}

/** Drag override (base units) of `clip` from the live Remotion override, when it is this clip's. */
export function remotionDragOverride(clip: Pick<TimelineClip, "id">, override?: RemotionTransformOverride | null): DragOverride | null {
    if (!override || override.clipId !== clip.id) return null;
    return { posX: override.positionX, posY: override.positionY, scale: override.scale, rotation: override.rotation };
}

/** The layer placement at clip-local `localTime` seconds. */
export function remotionLayerPlacement(clip: TimelineClip, localTime: number, override?: RemotionTransformOverride | null): RemotionLayerPlacement {
    const t = applyDragOverride(clipMotionAt(clip, Number.isFinite(localTime) ? localTime : 0), remotionDragOverride(clip, override));
    return { x: t.posX - 0.5 + t.dx, y: t.posY - 0.5 + t.dy, scale: t.scale, scaleX: t.scaleX, rotation: t.rotation, opacity: t.opacity };
}

const f4 = (x: number) => (Object.is(x, -0) ? 0 : x).toFixed(4);

/** The layer's CSS transform at clip-local `localTime` (default 0). */
export function getRemotionLayerTransform(clip: TimelineClip, override?: RemotionTransformOverride | null, localTime = 0): string {
    const p = remotionLayerPlacement(clip, localTime, override);
    return `translate(${f4(p.x * 100)}%, ${f4(p.y * 100)}%) rotate(${f4(p.rotation)}deg) scale(${p.scale * p.scaleX}, ${p.scale})`;
}

/** Inline style for a graphics clip's layer (transform about the centre and opacity) at clip-local `localTime`. */
export function getRemotionLayerStyle(clip: TimelineClip, localTime: number, override?: RemotionTransformOverride | null): { transform: string; opacity: number; transformOrigin: string } {
    const p = remotionLayerPlacement(clip, localTime, override);
    return {
        transform: `translate(${f4(p.x * 100)}%, ${f4(p.y * 100)}%) rotate(${f4(p.rotation)}deg) scale(${p.scale * p.scaleX}, ${p.scale})`,
        opacity: p.opacity,
        transformOrigin: "50% 50%",
    };
}
