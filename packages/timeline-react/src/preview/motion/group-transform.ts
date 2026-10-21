// Group transforms in the preview (phase 10c multi-select). With two or more items selected the preview shows ONE box
// around all of them; a gesture maps the plane by a similarity about the group centre C, and every item follows it:
//   move   p' = p + d                       scale and rotation unchanged
//   scale  p' = C + k (p − C)               scale · k
//   rotate p' = C + R(θ) (p − C)            rotation + θ
// where p is the item's pivot (the point its own scale and rotation turn about: the box centre for clips and scenes,
// the layer centre for graphics). The new pivot is then written back in the item's units (clip positions are fractions
// of the free space, scene offsets percent of the frame, graphics positions fractions of the frame).
import type { FrameRect } from "./clip-motion";
import { cornerPoints, solveAnchoredPosition, type HandleBox, type Point } from "./handles";

export type GroupGesture =
    | { kind: "move"; dx: number; dy: number }
    | { kind: "scale"; center: Point; factor: number }
    | { kind: "rotate"; center: Point; degrees: number };

export interface GroupPose {
    pivot: Point;
    scale: number;
    /** Degrees, clockwise. */
    rotation: number;
}

/** One item of a group gesture, captured at pointer-down (base values: no animation). */
export interface GroupItem extends GroupPose {
    kind: "clip" | "graphics" | "scene";
    id: string;
    /** Clips: the box the position anchors across at `scale` (base box size × scale). */
    anchor?: { w: number; h: number };
    /** Base position (clips/graphics: posX/posY; scenes: offsets in percent) for axes the placement pins. */
    posX: number;
    posY: number;
}

export function applyGroupGesture(pose: GroupPose, gesture: GroupGesture): GroupPose {
    if (gesture.kind === "move") return { pivot: { x: pose.pivot.x + gesture.dx, y: pose.pivot.y + gesture.dy }, scale: pose.scale, rotation: pose.rotation };
    const { center } = gesture;
    const vx = pose.pivot.x - center.x;
    const vy = pose.pivot.y - center.y;
    if (gesture.kind === "scale") {
        return { pivot: { x: center.x + vx * gesture.factor, y: center.y + vy * gesture.factor }, scale: pose.scale * gesture.factor, rotation: pose.rotation };
    }
    const r = (gesture.degrees * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return { pivot: { x: center.x + vx * c - vy * s, y: center.y + vx * s + vy * c }, scale: pose.scale, rotation: pose.rotation + gesture.degrees };
}

/** The axis-aligned box around every (rotated) box, or null for none. */
export function unionBox(boxes: readonly HandleBox[]): HandleBox | null {
    if (boxes.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const box of boxes) {
        for (const p of cornerPoints(box)) {
            x0 = Math.min(x0, p.x);
            y0 = Math.min(y0, p.y);
            x1 = Math.max(x1, p.x);
            y1 = Math.max(y1, p.y);
        }
    }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, rotation: 0 };
}

/** The group box as the gesture moves, scales, or turns it (drawn while dragging). */
export function gestureBox(box: HandleBox, gesture: GroupGesture): HandleBox {
    const pose = applyGroupGesture({ pivot: { x: box.cx, y: box.cy }, scale: 1, rotation: (box.rotation * 180) / Math.PI }, gesture);
    return { cx: pose.pivot.x, cy: pose.pivot.y, w: box.w * pose.scale, h: box.h * pose.scale, rotation: (pose.rotation * Math.PI) / 180 };
}

/** The scale factor of a corner drag about the centre: pointer distance now over at pointer-down (1 when too close). */
export function groupScaleFactor(center: Point, start: Point, pointer: Point, minDistance = 5): number {
    const d0 = Math.hypot(start.x - center.x, start.y - center.y);
    if (!(d0 > minDistance)) return 1;
    return Math.hypot(pointer.x - center.x, pointer.y - center.y) / d0;
}

/** The factor clamped so every item's scale stays within [min, max]. */
export function clampGroupFactor(factor: number, scales: readonly number[], min: number, max: number): number {
    let lo = 0;
    let hi = Infinity;
    for (const scale of scales) {
        if (!(scale > 0)) continue;
        lo = Math.max(lo, min / scale);
        hi = Math.min(hi, max / scale);
    }
    if (lo > hi) return 1;
    const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
    return Math.min(hi, Math.max(lo, f));
}

const round = (value: number, digits: number) => {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
};

/** Transform values of an item after a gesture, in its units (`position_x` / `position_y` / `scale` / `rotation_degrees`). */
export interface GroupItemValues {
    position_x: number;
    position_y: number;
    scale: number;
    rotation_degrees: number;
}

/**
 * The item's values for a pose on `frame`: the position that puts its pivot there (export placement inverted; an axis a
 * clip's box covers keeps its position, as the placement pins it), its scale and rotation.
 */
export function groupItemValues(item: GroupItem, pose: GroupPose, frame: FrameRect, maxSceneOffset = 200): GroupItemValues {
    const scale = round(pose.scale, 4);
    const rotation_degrees = round(pose.rotation, 2);
    if (item.kind === "scene") {
        const clampOffset = (v: number) => Math.min(maxSceneOffset, Math.max(-maxSceneOffset, v));
        const x = frame.w > 0 ? ((pose.pivot.x - frame.x - frame.w / 2) / frame.w) * 100 : item.posX;
        const y = frame.h > 0 ? ((pose.pivot.y - frame.y - frame.h / 2) / frame.h) * 100 : item.posY;
        return { position_x: round(clampOffset(x || 0), 4), position_y: round(clampOffset(y || 0), 4), scale, rotation_degrees };
    }
    if (item.kind === "graphics") {
        const x = frame.w > 0 ? (pose.pivot.x - frame.x - frame.w / 2) / frame.w + 0.5 : item.posX;
        const y = frame.h > 0 ? (pose.pivot.y - frame.y - frame.h / 2) / frame.h + 0.5 : item.posY;
        return { position_x: round(x, 6), position_y: round(y, 6), scale, rotation_degrees };
    }
    const k = item.scale > 0 ? pose.scale / item.scale : 1;
    const aw = (item.anchor?.w ?? 0) * k;
    const ah = (item.anchor?.h ?? 0) * k;
    const x = solveAnchoredPosition(frame.x, frame.w, aw, pose.pivot.x, 0) ?? item.posX;
    const y = solveAnchoredPosition(frame.y, frame.h, ah, pose.pivot.y, 0) ?? item.posY;
    return { position_x: round(x, 6), position_y: round(y, 6), scale, rotation_degrees };
}
