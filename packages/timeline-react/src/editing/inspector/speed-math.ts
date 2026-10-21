// Pure math for the Speed tab (phase 10b): the 0.1x-100x log slider, and the curve editor's point edits
// on a log speed axis (0.1x-10x). Curves follow motion/speed.ts: 2-10 points [x, y], x from 0 to 1.
import { MAX_CURVE_POINTS, MAX_CURVE_SPEED, MAX_SPEED, MIN_CURVE_POINTS, MIN_CURVE_SPEED, MIN_SPEED } from "@opennan/timeline-core/motion/speed";

export type CurvePoints = Array<[number, number]>;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const SPEED_DECADES = Math.log10(MAX_SPEED / MIN_SPEED);
const CURVE_DECADES = Math.log10(MAX_CURVE_SPEED / MIN_CURVE_SPEED);

/** Readable speeds: two decimals below 1x, one below 10x, whole numbers above; within 3 % of 1x snaps to 1x. */
export function roundSpeed(speed: number): number {
    const s = clamp(speed, MIN_SPEED, MAX_SPEED);
    if (Math.abs(s - 1) <= 0.03) return 1;
    if (s < 1) return Math.round(s * 100) / 100;
    if (s < 10) return Math.round(s * 10) / 10;
    return Math.round(s);
}

/** Slider position 0..1 → speed 0.1x..100x on a log scale (rounded with roundSpeed). */
export function sliderToSpeed(position: number): number {
    return roundSpeed(MIN_SPEED * 10 ** (clamp(position, 0, 1) * SPEED_DECADES));
}

/** Speed → slider position 0..1. */
export function speedToSlider(speed: number): number {
    return clamp(Math.log10(clamp(speed, MIN_SPEED, MAX_SPEED) / MIN_SPEED) / SPEED_DECADES, 0, 1);
}

/** Curve speed 0.1x..10x → 0..1 (log axis, 1x in the middle). */
export function speedToNorm(speed: number): number {
    return clamp(Math.log10(clamp(speed, MIN_CURVE_SPEED, MAX_CURVE_SPEED) / MIN_CURVE_SPEED) / CURVE_DECADES, 0, 1);
}

export function normToSpeed(norm: number): number {
    return MIN_CURVE_SPEED * 10 ** (clamp(norm, 0, 1) * CURVE_DECADES);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Inserts a point (x strictly inside 0..1) in x order; null when the curve is full. */
export function addCurvePoint(points: CurvePoints, x: number, y: number): { points: CurvePoints; index: number } | null {
    if (points.length >= MAX_CURVE_POINTS || !(x > 0 && x < 1)) return null;
    let index = points.findIndex(([px]) => px > x);
    if (index <= 0) index = points.length - 1;
    const next = points.map((p): [number, number] => [p[0], p[1]]);
    next.splice(index, 0, [round3(x), round3(clamp(y, MIN_CURVE_SPEED, MAX_CURVE_SPEED))]);
    return { points: next, index };
}

/** Removes an interior point; the two ends and the 2-point minimum stay (null when nothing can be removed). */
export function removeCurvePoint(points: CurvePoints, index: number): CurvePoints | null {
    if (points.length <= MIN_CURVE_POINTS || index <= 0 || index >= points.length - 1) return null;
    return points.filter((_, i) => i !== index).map((p): [number, number] => [p[0], p[1]]);
}

/** Moves a point: the ends keep x = 0 / 1, interior points stay between their neighbours (equal x makes a step). */
export function moveCurvePoint(points: CurvePoints, index: number, x: number, y: number): CurvePoints {
    const last = points.length - 1;
    const nx = index === 0 ? 0 : index === last ? 1 : clamp(x, points[index - 1][0], points[index + 1][0]);
    return points.map((p, i): [number, number] => (i === index ? [round3(nx), round3(clamp(y, MIN_CURVE_SPEED, MAX_CURVE_SPEED))] : [p[0], p[1]]));
}

/** A pointer this far outside the graph (px) while dragging an interior point removes it on release. */
export const DRAG_OUT_PX = 24;

export function isDragOut(local: { x: number; y: number }, box: { width: number; height: number }): boolean {
    return local.x < -DRAG_OUT_PX || local.y < -DRAG_OUT_PX || local.x > box.width + DRAG_OUT_PX || local.y > box.height + DRAG_OUT_PX;
}

/** SVG polyline points for a curve drawn in a width × height box (y up, log axis). */
export function curvePolyline(points: CurvePoints, width: number, height: number): string {
    const r = (v: number) => Math.round(v * 100) / 100;
    return points.map(([x, y]) => `${r(x * width)},${r((1 - speedToNorm(y)) * height)}`).join(" ");
}
