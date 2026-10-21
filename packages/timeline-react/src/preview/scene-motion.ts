// Scene motion in the preview (phase 10b): where a main-track or upper-track scene's media sits at a
// scene-local time, from the one motion definition (timeline-core motion/transform.ts itemMotion).
//
// Placement contract (shared with the export's footageSegment): the media is fitted with
// transformScale = motion.scale (fit.ts), centered on the frame center moved by (posX% + dx·100%) of the
// frame width and (posY% + dy·100%) of its height, scaled horizontally by |scaleX| about its center,
// rotated clockwise by `rotation` degrees about its center, and drawn with alpha × opacity (over black on
// V1, over clear on V2+). Static scenes without rotation or opacity keep today's sceneFitStyle path.
import type { SceneData } from "@opennan/timeline-core";
import { sceneFitRect } from "@opennan/timeline-core/looks/fit";
import { itemMotion, motionAt } from "@opennan/timeline-core/motion/transform";
import type { MotionChannels } from "@opennan/timeline-core/motion/types";

/** The scene fields motion reads (ScenePreview and the lane overlay keep their own scene types). */
export type SceneMotionSource = Pick<SceneData, "id"> & Partial<Pick<SceneData,
    "transformScale" | "transformOffsetX" | "transformOffsetY" | "rotationDegrees" | "opacity" | "keyframesJson" | "animationJson">>;

export type SceneMotionValues = MotionChannels<number>;

/** 2×3 affine matrix in CSS `matrix(a, b, c, d, e, f)` order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY_SCENE_MOTION: Readonly<SceneMotionValues> = Object.freeze({
    opacity: 1, scale: 1, scaleX: 1, posX: 0, posY: 0, dx: 0, dy: 0, rotation: 0,
});

const EPS = 1e-6;

function num(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === "") return fallback;
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}

/** The scale and offsets sceneFitStyle draws (transform.ts baseFields for scenes). */
function staticFields(scene: SceneMotionSource): { scale: number; posX: number; posY: number } {
    const scale = num(scene.transformScale, 1);
    return { scale: scale > 0 ? scale : 1, posX: num(scene.transformOffsetX, 0), posY: num(scene.transformOffsetY, 0) };
}

/** Nothing beyond the static fields: no keyframes, animation, rotation, or opacity (every pre-10b scene). */
function plainScene(scene: SceneMotionSource): boolean {
    return !scene.keyframesJson && !scene.animationJson && Math.abs(num(scene.rotationDegrees, 0) % 360) <= EPS && num(scene.opacity, 1) >= 1 - EPS;
}

function motionOf(scene: SceneMotionSource, duration: number) {
    // itemMotion reads only the motion fields; memoized per scene object and duration.
    return itemMotion({ kind: "scene", scene: scene as unknown as SceneData, duration: Math.max(0, duration) });
}

/** Channel values at scene-local `t` seconds (clamped to the scene). */
export function sceneMotionAt(scene: SceneMotionSource, duration: number, t: number): SceneMotionValues {
    if (plainScene(scene)) return { ...IDENTITY_SCENE_MOTION, ...staticFields(scene) };
    const local = Math.min(Math.max(0, duration), Math.max(0, t));
    return motionAt(motionOf(scene, duration), local);
}

/** True when `values` draw exactly what the scene's static fields draw (sceneFitStyle / the overlay's `place`). */
export function isIdentitySceneMotion(values: SceneMotionValues, scene: SceneMotionSource): boolean {
    const fields = staticFields(scene);
    return Math.abs(values.scale - fields.scale) <= EPS
        && Math.abs(values.posX - fields.posX) <= EPS
        && Math.abs(values.posY - fields.posY) <= EPS
        && Math.abs(values.dx) <= EPS && Math.abs(values.dy) <= EPS
        && Math.abs(Math.abs(values.scaleX) - 1) <= EPS
        && Math.abs(values.rotation % 360) <= EPS
        && values.opacity >= 1 - EPS;
}

/** The scene needs per-frame placement: it moves, or it rests somewhere sceneFitStyle cannot draw. */
export function sceneHasMotion(scene: SceneMotionSource, duration: number): boolean {
    if (plainScene(scene)) return false;
    const motion = motionOf(scene, duration);
    return motion.animated || !isIdentitySceneMotion(motionAt(motion, 0), scene);
}

export interface ScenePlacement {
    /** Center of the placed media on the frame, in frame pixels. */
    cx: number;
    cy: number;
    /** Size before the horizontal factor and the rotation. */
    width: number;
    height: number;
    /** |scaleX|. */
    scaleX: number;
    /** Degrees, clockwise. */
    rotation: number;
    /** 0..1. */
    opacity: number;
}

/** Where the media sits on a frame (the placement contract above). */
export function scenePlacement(
    fitMode: string | null | undefined,
    source: { width: number; height: number },
    frame: { width: number; height: number },
    values: SceneMotionValues,
): ScenePlacement {
    const base = sceneFitRect(fitMode, source, frame, 1, 0, 0);
    // fit.ts treats scale ≤ 0 as 1; a shrink animation must reach nothing instead.
    const scale = Math.max(0, values.scale);
    return {
        cx: frame.width / 2 + (values.posX / 100 + values.dx) * frame.width,
        cy: frame.height / 2 + (values.posY / 100 + values.dy) * frame.height,
        width: base.width * scale,
        height: base.height * scale,
        scaleX: Math.abs(values.scaleX),
        rotation: values.rotation,
        opacity: Math.min(1, Math.max(0, values.opacity)),
    };
}

/**
 * Forward matrix from pixels of a fitted media texture (`texture` px, the whole media) to frame pixels.
 * The lane overlay inverts it for LookRenderer.placeAffine.
 */
export function sceneMediaMatrix(
    fitMode: string | null | undefined,
    source: { width: number; height: number },
    frame: { width: number; height: number },
    values: SceneMotionValues,
    texture: { width: number; height: number },
): Affine {
    const placed = scenePlacement(fitMode, source, frame, values);
    const sx = (placed.width * placed.scaleX) / Math.max(1, texture.width);
    const sy = placed.height / Math.max(1, texture.height);
    const r = (placed.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const a = cos * sx;
    const b = sin * sx;
    const c = -sin * sy;
    const d = cos * sy;
    const hx = texture.width / 2;
    const hy = texture.height / 2;
    return [a, b, c, d, placed.cx - (a * hx + c * hy), placed.cy - (b * hx + d * hy)];
}

export function applyAffine(m: Affine, x: number, y: number): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The inverse matrix, or null when the media collapsed to nothing. */
export function invertAffine(m: Affine): Affine | null {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const ia = d / det;
    const ib = -b / det;
    const ic = -c / det;
    const id = a / det;
    return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

/** `fixed` without float noise (CSS strings stay short and stable). */
const css = (x: number) => String(Math.round(x * 1e4) / 1e4);

/**
 * CSS for a scene media element whose box is the frame (`absolute inset-0` + object-fit): object-fit
 * already draws the scale-1 fit rect centered, so the motion is a transform about the frame center.
 */
export function sceneMediaTransform(values: SceneMotionValues, frame: { w: number; h: number }): { transform: string; opacity: string } {
    const scale = Math.max(0, values.scale);
    const tx = (values.posX / 100 + values.dx) * frame.w;
    const ty = (values.posY / 100 + values.dy) * frame.h;
    return {
        transform: `translate(${css(tx)}px, ${css(ty)}px) rotate(${css(values.rotation)}deg) scale(${css(scale * Math.abs(values.scaleX))}, ${css(scale)})`,
        opacity: String(Math.min(1, Math.max(0, values.opacity))),
    };
}
