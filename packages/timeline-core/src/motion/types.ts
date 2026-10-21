// Shared motion contract (phase 10b). Every moving value is an expression (looks/expr.ts) of the
// item-local time `T` in seconds, so the export (ffmpeg scalar target) and the preview
// (evaluateScalar) run the same function.
import type { Expr } from "../looks/expr";

/**
 * The placed transform of a visual item at item-local time T.
 * - posX/posY: the item's own position fields (clip: 0..1 fraction of the free space, x = posX·(W − boxW);
 *   scene: transformOffsetX/Y in percent of the frame).
 * - scale: the item's scale (clip `scale`, scene `transformScale`), already multiplied by animation scale.
 * - scaleX: horizontal factor on top of scale (flip animations; |scaleX| is used, 1 when static).
 * - dx/dy: center offset in fractions of the frame width/height (animations: slides, shakes).
 * - rotation: degrees, clockwise.
 * - opacity: 0..1.
 */
export interface MotionChannels<T = Expr> {
    opacity: T;
    scale: T;
    scaleX: T;
    posX: T;
    posY: T;
    dx: T;
    dy: T;
    rotation: T;
}

export type MotionChannel = keyof MotionChannels;

export const MOTION_CHANNELS: readonly MotionChannel[] = ["opacity", "scale", "scaleX", "posX", "posY", "dx", "dy", "rotation"];

/**
 * What an animation contributes at window progress u: opacity, scale, and scaleX multiply; dx, dy,
 * and rotation add. Missing channels are neutral (1 for factors, 0 for offsets).
 */
export type MotionDelta = Partial<Record<"opacity" | "scale" | "scaleX" | "dx" | "dy" | "rotation", Expr>>;

/** Which part of an item an animation occupies. */
export type AnimationSlot = "in" | "out" | "combo" | "loop";

/** Which items an animation applies to: clip animations (video, image, sticker clips, scenes) or text. */
export type AnimationKind = "clip" | "text";

export interface AnimationDef {
    id: string;
    kind: AnimationKind;
    slot: AnimationSlot;
    /** Seconds (in/out windows), or the loop period; combos default to the item's length. */
    defaultDuration: number;
    /**
     * The motion delta at progress `u` (an expression in [0, 1]):
     * - in: u = 0 at the item start (fully "out" state) → 1 at the end of the window (rest);
     * - out: u = 0 at the window start (rest) → 1 at the item end (gone);
     * - combo: u over the whole item, rest at u = 0 and u = 1;
     * - loop: u is the phase inside one period (repeats), rest at u = 0.
     */
    delta(u: Expr): MotionDelta;
    /** Text only: the raster part (typewriter, wipe, blur, glow, letter rise/fall). */
    raster?: TextRasterKind;
}

export type TextRasterKind = "typewriter" | "typewriter_erase" | "wipe" | "blur" | "glow" | "letter_rise" | "letter_fall";

/** The parsed `animationJson` of a clip or scene. */
export interface AnimationSpec {
    in?: { id: string; duration: number };
    out?: { id: string; duration: number };
    /** Clip animations only; excludes in/out. `duration` absent = the whole item. */
    combo?: { id: string; duration?: number };
    /** Text and sticker loops between in and out. */
    loop?: { id: string; period: number };
}
