// Transform handles of the preview (phase 10b): pure geometry for the selection box of a placed item.
// A box is its centre, its drawn size, and its clockwise rotation (radians) about the centre, in canvas
// pixels: the VISUAL box of motion/clip-motion.ts placedBox, or of a scene's scenePlacement.
//
//   corners       TL, TR, BL, BR (index 0..3), in the box's rotated frame
//   rotate knob   ROTATE_KNOB_OFFSET px above the top centre, on a stem (turns with the box)
//   corner scale  uniform, along the dragged corner's diagonal, the OPPOSITE corner fixed (CapCut);
//                 about the centre with Alt/Option
//   rotation      pointer angle about the centre; Shift snaps to 15°, else a 3° magnet to 0/90/180/270
import type { OverlayRect } from "./clip-motion";

export interface HandleBox {
    cx: number;
    cy: number;
    w: number;
    h: number;
    /** Radians, clockwise. */
    rotation: number;
}

export interface Point {
    x: number;
    y: number;
}

export type Corner = 0 | 1 | 2 | 3;

/** Signs of each corner in the box's local frame (TL, TR, BL, BR). */
export const CORNER_SIGNS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Distance of the rotate knob above the box's top edge. */
export const ROTATE_KNOB_OFFSET = 24;
export const ROTATE_KNOB_RADIUS = 7;
export const CORNER_HANDLE_RADIUS = 5;
export const CORNER_HIT_RADIUS = 10;
export const ROTATE_HIT_RADIUS = 12;

export function boxFromRect(rect: OverlayRect): HandleBox {
    return {
        cx: rect.px ?? rect.x + rect.w / 2,
        cy: rect.py ?? rect.y + rect.h / 2,
        w: rect.w,
        h: rect.h,
        rotation: rect.rot ?? 0,
    };
}

/** A screen point in the box's unrotated frame, relative to its centre. */
export function toLocal(box: HandleBox, x: number, y: number): Point {
    const dx = x - box.cx;
    const dy = y - box.cy;
    if (!box.rotation) return { x: dx, y: dy };
    const c = Math.cos(box.rotation);
    const s = Math.sin(box.rotation);
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/** A local point (relative to the centre, unrotated) on the screen. */
export function toScreen(box: HandleBox, lx: number, ly: number): Point {
    if (!box.rotation) return { x: box.cx + lx, y: box.cy + ly };
    const c = Math.cos(box.rotation);
    const s = Math.sin(box.rotation);
    return { x: box.cx + lx * c - ly * s, y: box.cy + lx * s + ly * c };
}

export function cornerPoints(box: HandleBox): Point[] {
    return CORNER_SIGNS.map(([sx, sy]) => toScreen(box, (sx * box.w) / 2, (sy * box.h) / 2));
}

/** The rotate knob and the top-centre point its stem starts from. */
export function rotateKnob(box: HandleBox, offset = ROTATE_KNOB_OFFSET): { base: Point; knob: Point } {
    return { base: toScreen(box, 0, -box.h / 2), knob: toScreen(box, 0, -box.h / 2 - offset) };
}

/**
 * The knob offset to use on a canvas of `view` size: above the top edge, or (when that point would leave
 * the canvas, e.g. a full-frame scene) the same distance inside the box below the top edge.
 */
export function rotateKnobOffset(box: HandleBox, view: { w: number; h: number }, offset = ROTATE_KNOB_OFFSET, margin = ROTATE_KNOB_RADIUS): number {
    const { knob } = rotateKnob(box, offset);
    const inside = knob.x >= margin && knob.y >= margin && knob.x <= view.w - margin && knob.y <= view.h - margin;
    return inside ? offset : -offset;
}

export type HandleHit = { kind: "rotate" } | { kind: "corner"; corner: Corner } | { kind: "body" } | null;

export interface HitOptions {
    /** Test the corners and the knob (the item is selected). Default true. */
    handles?: boolean;
    /** The item can rotate (shows a knob). Default true. */
    rotate?: boolean;
    cornerRadius?: number;
    rotateRadius?: number;
    /** Knob distance above the top edge (negative: inside the box, see rotateKnobOffset). */
    rotateOffset?: number;
}

/** Knob first (it sits outside the box), then corners, then the body, all in the box's rotated frame. */
export function hitTestHandles(box: HandleBox, x: number, y: number, options: HitOptions = {}): HandleHit {
    const handles = options.handles ?? true;
    const p = toLocal(box, x, y);
    if (handles) {
        if (options.rotate ?? true) {
            const r = options.rotateRadius ?? ROTATE_HIT_RADIUS;
            const ky = -box.h / 2 - (options.rotateOffset ?? ROTATE_KNOB_OFFSET);
            if (p.x * p.x + (p.y - ky) * (p.y - ky) <= r * r) return { kind: "rotate" };
        }
        const r = options.cornerRadius ?? CORNER_HIT_RADIUS;
        for (let i = 0; i < 4; i++) {
            const [sx, sy] = CORNER_SIGNS[i];
            const dx = p.x - (sx * box.w) / 2;
            const dy = p.y - (sy * box.h) / 2;
            if (dx * dx + dy * dy <= r * r) return { kind: "corner", corner: i as Corner };
        }
    }
    if (Math.abs(p.x) <= box.w / 2 && Math.abs(p.y) <= box.h / 2) return { kind: "body" };
    return null;
}

// ── rotation ─────────────────────────────────────────────

/** Angle of (x, y) about (cx, cy) in degrees, clockwise from +x (screen y points down). */
export function pointerAngle(cx: number, cy: number, x: number, y: number): number {
    return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
}

/** The signed shortest turn from `prev` to `next` degrees, in (−180, 180]. */
export function unwrapDelta(prev: number, next: number): number {
    let d = (next - prev) % 360;
    if (d <= -180) d += 360;
    if (d > 180) d -= 360;
    return d;
}

export interface RotationSnapOptions {
    /** Shift: snap to `step` degrees. */
    shift?: boolean;
    step?: number;
    /** Magnet to multiples of 90° within this many degrees (0 disables). */
    magnet?: number;
}

/** The rotation after snapping, and the angle it snapped to (null when free). */
export function snapRotation(degrees: number, options: RotationSnapOptions): { degrees: number; snapped: number | null } {
    const step = options.step ?? 15;
    if (options.shift && step > 0) {
        const snapped = Math.round(degrees / step) * step || 0;
        return { degrees: snapped, snapped };
    }
    const magnet = options.magnet ?? 3;
    if (magnet > 0) {
        const right = Math.round(degrees / 90) * 90 || 0;
        if (Math.abs(degrees - right) <= magnet) return { degrees: right, snapped: right };
    }
    return { degrees, snapped: null };
}

const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"] as const;

/** The resize cursor along a corner's diagonal as it appears on screen (follows the rotation). */
export function cornerCursor(corner: Corner, box: HandleBox): string {
    const [sx, sy] = CORNER_SIGNS[corner];
    const angle = Math.atan2(sy * Math.max(1, box.h), sx * Math.max(1, box.w)) + box.rotation;
    const degrees = (((angle * 180) / Math.PI) % 180 + 180) % 180;
    return RESIZE_CURSORS[Math.round(degrees / 45) % 4];
}

// ── corner scale ─────────────────────────────────────────

export interface AnchoredScaleInput {
    /** The box at pointer-down (visual box). */
    box: HandleBox;
    corner: Corner;
    pointer: Point;
    /** Alt/Option: scale about the centre instead of the opposite corner. */
    aboutCenter?: boolean;
    minFactor?: number;
    maxFactor?: number;
}

/**
 * Uniform scale factor (relative to `box`) and the new box centre: the pointer projected on the dragged
 * corner's diagonal, measured from the opposite corner (which stays put) or from the centre.
 */
export function anchoredCornerScale(input: AnchoredScaleInput): { factor: number; cx: number; cy: number } {
    const { box, corner, pointer } = input;
    const [sx, sy] = CORNER_SIGNS[corner];
    const half = { x: (sx * box.w) / 2, y: (sy * box.h) / 2 };
    const hh = half.x * half.x + half.y * half.y;
    const min = input.minFactor ?? 0.01;
    const max = input.maxFactor ?? Number.POSITIVE_INFINITY;
    const clampFactor = (f: number) => Math.min(max, Math.max(min, Number.isFinite(f) ? f : 1));
    const p = toLocal(box, pointer.x, pointer.y);
    if (hh <= 0) return { factor: 1, cx: box.cx, cy: box.cy };
    if (input.aboutCenter) {
        return { factor: clampFactor((p.x * half.x + p.y * half.y) / hh), cx: box.cx, cy: box.cy };
    }
    // Anchor = opposite corner (−half); diagonal = 2·half.
    const vx = p.x + half.x;
    const vy = p.y + half.y;
    const factor = clampFactor((vx * half.x + vy * half.y) / (2 * hh));
    // New centre: anchor + half · factor (local), mapped to the screen.
    const centre = toScreen(box, -half.x + half.x * factor, -half.y + half.y * factor);
    return { factor, cx: centre.x, cy: centre.y };
}

/**
 * The position fraction that puts a box's centre at `centre` on one axis, inverting the export placement
 * centre = start + pos · max(0, size − box) + box / 2 + offset (offset: animation dx/dy in px). Null when
 * the box covers the axis (the placement pins it there: no position moves it).
 */
export function solveAnchoredPosition(start: number, size: number, box: number, centre: number, offset: number): number | null {
    const span = size - box;
    if (!(span > 0.5)) return null;
    return (centre - offset - start - box / 2) / span;
}
