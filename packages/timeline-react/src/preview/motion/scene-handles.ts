// Transform handles for a scene in the preview (phase 10b): the scene's media rect on the frame, from the
// same placement contract the export and ScenePreview use (preview/scene-motion.ts scenePlacement: the
// fit rect of looks/fit.ts × scale, centred on the frame centre moved by the offsets in percent plus the
// animation's dx/dy, |scaleX|, rotation about the centre).
//
//   visual box   with the animation (what the viewer sees): hit tests, the selection box, handles
//   base box     keyframed/static offsets, scale, rotation only: what a gesture edits
//   animOffset   visual centre − base centre, in px (the animation's dx/dy), constant during a gesture
import type { SceneData } from "@opennan/timeline-core/timeline/canvas/types";
import { parseShotBreakdown } from "@opennan/timeline-core/lib/shot-utils";
import { sceneMotionAt, scenePlacement, IDENTITY_SCENE_MOTION, type SceneMotionSource } from "../scene-motion";
import { sceneBaseAt } from "./drag-commit";
import type { FrameRect } from "./clip-motion";
import type { HandleBox, Point } from "./handles";

export type SceneHandleSource = SceneMotionSource & Partial<Pick<SceneData, "fitMode">>;

export interface SceneHandleGeometry {
    visual: HandleBox;
    base: HandleBox;
    animOffset: Point;
    /** Keyframed or static transform at the time (offsets in percent, transformScale, degrees). */
    baseValues: { offsetX: number; offsetY: number; scale: number; rotation: number };
}

/** The scene's media rect and transform at scene-local `t` on `frame` (canvas px). */
export function sceneHandleGeometry(scene: SceneHandleSource, duration: number, t: number, frame: FrameRect, source: { width: number; height: number }): SceneHandleGeometry {
    const size = { width: frame.w, height: frame.h };
    const values = sceneMotionAt(scene, duration, t);
    const placed = scenePlacement(scene.fitMode, source, size, values);
    const baseValues = sceneBaseAt(scene, Math.min(Math.max(0, duration), Math.max(0, t)));
    const restPlaced = scenePlacement(scene.fitMode, source, size, {
        ...IDENTITY_SCENE_MOTION, posX: baseValues.offsetX, posY: baseValues.offsetY, scale: baseValues.scale, rotation: baseValues.rotation,
    });
    const visual: HandleBox = {
        cx: frame.x + placed.cx, cy: frame.y + placed.cy, w: placed.width * placed.scaleX, h: placed.height, rotation: (placed.rotation * Math.PI) / 180,
    };
    const base: HandleBox = {
        cx: frame.x + restPlaced.cx, cy: frame.y + restPlaced.cy, w: restPlaced.width, h: restPlaced.height, rotation: (restPlaced.rotation * Math.PI) / 180,
    };
    return { visual, base, animOffset: { x: visual.cx - base.cx, y: visual.cy - base.cy }, baseValues };
}

/** The offsets (percent of the frame) that put the visual centre at `centre` (animOffset: the animation's px offset). */
export function sceneOffsetForCentre(frame: FrameRect, centre: Point, animOffset: Point): { offsetX: number; offsetY: number } {
    const offsetX = frame.w > 0 ? ((centre.x - animOffset.x - frame.x - frame.w / 2) / frame.w) * 100 : 0;
    const offsetY = frame.h > 0 ? ((centre.y - animOffset.y - frame.y - frame.h / 2) / frame.h) * 100 : 0;
    return { offsetX: offsetX || 0, offsetY: offsetY || 0 };
}

/** Source pixel size: the stored dimensions (ScenePreview backfills them), the playing video, else the frame. */
export function sceneSourceSize(
    scene: Partial<Pick<SceneData, "sourceWidth" | "sourceHeight">>,
    video: { videoWidth: number; videoHeight: number } | null | undefined,
    frame: FrameRect,
): { width: number; height: number } {
    const sw = Number(scene.sourceWidth);
    const sh = Number(scene.sourceHeight);
    if (sw > 0 && sh > 0) return { width: sw, height: sh };
    if (video && video.videoWidth > 0 && video.videoHeight > 0) return { width: video.videoWidth, height: video.videoHeight };
    return { width: Math.max(1, frame.w), height: Math.max(1, frame.h) };
}

/** Scenes whose media can be transformed (the same rule as ScenePreview's transform chrome). */
export function sceneCanTransform(scene: Partial<Pick<SceneData, "cardType" | "videoUrl" | "sourceVideoUrl" | "shotBreakdown">>): boolean {
    if (scene.cardType === "image") return true;
    if (scene.videoUrl) return true;
    if ((scene.cardType === "source_clip" || scene.cardType === "podcast") && scene.sourceVideoUrl) return true;
    if (scene.shotBreakdown) {
        const shots = parseShotBreakdown<{ video_url?: string }>(scene.shotBreakdown);
        if (shots.length > 0 && shots.every((shot) => Boolean(shot.video_url))) return true;
    }
    return false;
}
