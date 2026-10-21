// Clip motion in the preview compositor (phase 10b). One sample per clip and frame from the shared
// transform model (timeline-core motion/transform.ts: keyframes ∘ animations ∘ legacy fades and motion
// preset), and the placement math the export uses for every overlay, shared by drawing and hit testing:
//
//   anchor box  = box(scale 1) · scale                    (box the position anchors across)
//   centre x    = frame.x + posX · max(0, W − anchorW) + anchorW / 2 + dx · W   (same for y)
//   drawn box   = anchorW · |scaleX|  ×  anchorH, centred, rotated about the centre.
//
// Two boxes per clip: the VISUAL box (everything above, what the viewer sees: hit tests, selection,
// handles) and the BASE box (position/scale/rotation from keyframes or static fields plus a live drag
// override, without animation deltas: where the item rests, for snapping and the drag model).
import { itemMotion, motionAt, type ItemMotion } from "@opennan/timeline-core/motion/transform";
import { channelValueAt, hasChannel, type KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";

/** Placed transform values (rotation in degrees, dx/dy in frame fractions). */
export interface ClipTransform {
    opacity: number;
    scale: number;
    scaleX: number;
    posX: number;
    posY: number;
    dx: number;
    dy: number;
    rotation: number;
}

/** Keyframed or static position, scale, and rotation (no animation): what a drag edits. */
export interface ClipBaseValues {
    posX: number;
    posY: number;
    scale: number;
    rotation: number;
}

export interface ClipMotionSample extends ClipTransform {
    /** Any channel varies over time (the compositor must redraw on every time change). */
    animated: boolean;
    base: ClipBaseValues;
}

/** Live drag values (base units), winning per channel over keyframes and static fields. */
export interface DragOverride {
    posX?: number;
    posY?: number;
    scale?: number;
    /** Base rotation in degrees (animation rotation still adds). */
    rotation?: number;
}

function num(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === "") return fallback;
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}

/** Field defaults of the transform model (motion/transform.ts baseFields). */
function staticBase(clip: TimelineClip): ClipBaseValues {
    const scale = num(clip.scale, 1);
    return {
        posX: num(clip.positionX, 0.5),
        posY: num(clip.positionY, 0.5),
        scale: scale > 0 ? scale : 1,
        rotation: num(clip.rotationDegrees, 0),
    };
}

const pointsMemo = new WeakMap<TimelineClip, KeyframePoints>();
/** The clip's keyframe points (memoized per clip object: clips are immutable store objects). */
export function clipKeyframePoints(clip: TimelineClip): KeyframePoints {
    let points = pointsMemo.get(clip);
    if (!points) {
        points = parseTimelineKeyframes(clip.keyframesJson);
        pointsMemo.set(clip, points);
    }
    return points;
}

/** Keyframed (or static) base values at item-local `t`. */
export function clipBaseAt(clip: TimelineClip, t: number): ClipBaseValues {
    const base = staticBase(clip);
    const points = clipKeyframePoints(clip);
    if (points.length === 0) return base;
    return {
        posX: channelValueAt(points, "position_x", t, base.posX),
        posY: channelValueAt(points, "position_y", t, base.posY),
        scale: channelValueAt(points, "scale", t, base.scale),
        rotation: channelValueAt(points, "rotation_degrees", t, base.rotation),
    };
}

const staticMemo = new WeakMap<ItemMotion, ClipMotionSample>();

/**
 * The clip's channels at item-local `t` seconds. Static clips (no keyframes, animation, fades, or
 * motion preset) return one memoized sample without evaluating anything.
 */
export function clipMotionAt(clip: TimelineClip, t: number): ClipMotionSample {
    const motion = itemMotion({ kind: "clip", clip });
    if (!motion.animated) {
        const cached = staticMemo.get(motion);
        if (cached) return cached;
        const values = motionAt(motion, 0);
        const sample: ClipMotionSample = {
            ...values,
            animated: false,
            base: { posX: values.posX, posY: values.posY, scale: values.scale, rotation: values.rotation },
        };
        staticMemo.set(motion, sample);
        return sample;
    }
    return { ...motionAt(motion, t), animated: true, base: clipBaseAt(clip, t) };
}

/**
 * The sample with a drag override applied per channel: an overridden position replaces the keyframed one
 * (animation offsets still add); an overridden scale replaces the base scale and keeps the animation and
 * motion-preset factor on top (sample.scale / base.scale).
 */
export function applyDragOverride(sample: ClipMotionSample, override: DragOverride | null | undefined): ClipTransform {
    const { opacity, scale, scaleX, posX, posY, dx, dy, rotation } = sample;
    if (!override) return { opacity, scale, scaleX, posX, posY, dx, dy, rotation };
    const factor = sample.base.scale > 0 ? scale / sample.base.scale : 1;
    return {
        opacity,
        scale: override.scale !== undefined ? override.scale * factor : scale,
        scaleX,
        posX: override.posX ?? posX,
        posY: override.posY ?? posY,
        dx,
        dy,
        rotation: override.rotation !== undefined ? override.rotation + (rotation - sample.base.rotation) : rotation,
    };
}

/** The base transform (no animation) with a drag override applied. */
export function baseTransform(sample: ClipMotionSample, override: DragOverride | null | undefined): ClipTransform {
    return {
        opacity: 1,
        scale: override?.scale ?? sample.base.scale,
        scaleX: 1,
        posX: override?.posX ?? sample.base.posX,
        posY: override?.posY ?? sample.base.posY,
        dx: 0,
        dy: 0,
        rotation: override?.rotation ?? sample.base.rotation,
    };
}

export interface FrameRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PlacedBox {
    /** Box centre (rotation pivot). */
    cx: number;
    cy: number;
    /** Drawn size (anchor width × |scaleX|, anchor height). */
    w: number;
    h: number;
    /** Size the position anchors across (box at scale 1 × scale). */
    anchorW: number;
    anchorH: number;
    /** Radians, clockwise. */
    rotation: number;
    /** Top-left of the drawn box before rotation. */
    x: number;
    y: number;
}

/** Where an overlay lands: the export's placement for every overlay (see the header). `box` is the box at clip scale 1. */
export function placedBox(frame: FrameRect, box: { w: number; h: number }, transform: Pick<ClipTransform, "posX" | "posY" | "scale" | "scaleX" | "dx" | "dy" | "rotation">): PlacedBox {
    const anchorW = box.w * transform.scale;
    const anchorH = box.h * transform.scale;
    const cx = frame.x + transform.posX * Math.max(0, frame.w - anchorW) + anchorW / 2 + transform.dx * frame.w;
    const cy = frame.y + transform.posY * Math.max(0, frame.h - anchorH) + anchorH / 2 + transform.dy * frame.h;
    const w = anchorW * Math.abs(transform.scaleX);
    const h = anchorH;
    return { cx, cy, w, h, anchorW, anchorH, rotation: (transform.rotation * Math.PI) / 180, x: cx - w / 2, y: cy - h / 2 };
}

/**
 * Axis-aligned box plus the rotation it was drawn with (rot/px/py let hit tests undo the rotation).
 * anchorW/anchorH: the size the position anchors across, so a move drag maps pointer pixels to
 * position fractions exactly (Δpos = Δpx / (frame − anchor)).
 */
export interface OverlayRect {
    x: number;
    y: number;
    w: number;
    h: number;
    rot?: number;
    px?: number;
    py?: number;
    anchorW?: number;
    anchorH?: number;
}

export function overlayRectOf(box: PlacedBox): OverlayRect {
    return { x: box.x, y: box.y, w: box.w, h: box.h, rot: box.rotation, px: box.cx, py: box.cy, anchorW: box.anchorW, anchorH: box.anchorH };
}

/** Whether a drag override has reached the clip's data (base values at item-local `t`), so it can be dropped. */
export function overrideSettled(clip: TimelineClip, override: DragOverride | null, t: number, epsilon = 0.0005): boolean {
    if (!override) return false;
    const base = clipBaseAt(clip, t);
    if (override.posX !== undefined && Math.abs(base.posX - override.posX) > epsilon) return false;
    if (override.posY !== undefined && Math.abs(base.posY - override.posY) > epsilon) return false;
    if (override.scale !== undefined && Math.abs(base.scale - override.scale) > epsilon) return false;
    if (override.rotation !== undefined && Math.abs(base.rotation - override.rotation) > epsilon) return false;
    return true;
}

/**
 * The clip scale text is laid out (rasterized) at, as the export's overlayScale: the static scale, or for
 * animated clips (keyframed transform/opacity or a motion preset) the largest scale reached, so the
 * bitmap only scales down and wraps exactly like the exported text.
 */
export function textLayoutScale(clip: TimelineClip): number {
    const base = staticBase(clip).scale;
    const points = clipKeyframePoints(clip);
    const preset = String(clip.motionPreset ?? "").trim().toLowerCase();
    const peak = preset === "zoom_in" || preset === "zoom_out" ? 1.08 : preset === "pulse" ? 1.04 : 1;
    const keyed = ["scale", "opacity", "position_x", "position_y", "rotation_degrees"].some((channel) => hasChannel(points, channel));
    if (!keyed && peak === 1) return base;
    const reached = hasChannel(points, "scale")
        ? points.map((point) => point.scale).filter((value): value is number => typeof value === "number" && value > 0)
        : [base * peak];
    return Math.max(base, ...reached);
}
