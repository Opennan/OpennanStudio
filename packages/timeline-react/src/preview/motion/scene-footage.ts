// Scene footage in the compositor's full-frame effect pass (phase 10b). Without the main-track look
// overlay's canvas, the pass draws the scene's playing element itself. A still scene is drawn into the
// element's on-screen box (object-fit and the static offsets already put it there); a scene with motion
// (animation, keyframed transform, rotation, opacity) is placed with the shared placement contract
// (scene-motion.ts sceneMediaMatrix, the export's footageSegment) at its own local time, because a CSS
// transformed element's bounding box is not where its pixels are. The caller fills black behind (V1).
import { sceneHasMotion, sceneMediaMatrix, sceneMotionAt, type SceneMotionSource } from "../scene-motion";

export interface FootageSource {
    element: CanvasImageSource;
    /** Decoded size of the element's frame (videoWidth × videoHeight). */
    width: number;
    height: number;
}

export type FootageScene = SceneMotionSource & { fitMode?: string | null };

type FootageContext = Pick<CanvasRenderingContext2D, "save" | "restore" | "setTransform" | "drawImage" | "globalAlpha">;

/**
 * Draws the scene's frame onto a composite of `comp` device px (the project frame). `rect`: the element's
 * on-screen box in composite px, used for still scenes. False when nothing could be drawn (no decoded
 * frame, or a still scene without a usable box), so the caller can keep its own fallback.
 */
export function drawSceneFootage(
    ctx: FootageContext,
    source: FootageSource,
    scene: FootageScene,
    duration: number,
    local: number,
    comp: { width: number; height: number },
    rect: { x: number; y: number; w: number; h: number } | null,
): boolean {
    if (!(source.width > 0 && source.height > 0)) return false;
    if (!sceneHasMotion(scene, duration)) {
        if (!rect || rect.w <= 1 || rect.h <= 1) return false;
        ctx.drawImage(source.element, rect.x, rect.y, rect.w, rect.h);
        return true;
    }
    const values = sceneMotionAt(scene, duration, local);
    const size = { width: source.width, height: source.height };
    const [a, b, c, d, e, f] = sceneMediaMatrix(scene.fitMode, size, comp, values, size);
    const opacity = Math.min(1, Math.max(0, values.opacity));
    if (opacity <= 0) return true;
    ctx.save();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.globalAlpha = opacity;
    ctx.drawImage(source.element, 0, 0, source.width, source.height);
    ctx.restore();
    return true;
}
