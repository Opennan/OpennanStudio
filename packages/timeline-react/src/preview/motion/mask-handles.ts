// Mask handles of the preview (phase 10c): pure geometry for a mask drawn over its item. The item is its
// VISUAL box on screen (the placed clip or the scene's media rect, motion/handles.ts HandleBox); the mask
// lives in the item's own pixel box (timeline-core looks/masks.ts): centre in item fractions, sizes in units
// of the item's short side, rotation relative to the item. The mask's own box on screen ("frame") is
//   centre   item box point (x − ½)·w, (y − ½)·h, turned with the item
//   size     2a × 2b with a = width·S/2, b = height·S/2, S = min(w, h) (the item's short side on screen)
//   rotation item rotation + mask rotation
// Handles, in the mask frame (v down): width (a, 0), height (0, −b), corner (a, b) for closed shapes; the
// band edge (0, −a) for mirror; a rotate knob MASK_ROTATE_OFFSET below the shape; a feather arrow
// FEATHER_HANDLE_GAP above it, moved out by the feather width. Drags resize about the mask centre (CapCut).
import { MASK_FEATHER_SCALE, maskParamValues, type MaskPatch, type MaskSpec } from "@opennan/timeline-core/looks/masks";
import type { KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import { pointerAngle, snapRotation, toLocal, toScreen, unwrapDelta, type HandleBox, type Point } from "./handles";

export const MASK_ROTATE_OFFSET = 22;
export const FEATHER_HANDLE_GAP = 14;
export const MASK_HANDLE_HIT_RADIUS = 10;

export type MaskHandleKind = "move" | "width" | "height" | "corner" | "rotate" | "feather";

export interface MaskOutline {
    points: Point[];
    closed: boolean;
}

export interface MaskScreenGeometry {
    item: HandleBox;
    shape: MaskSpec["shape"];
    /** The mask box on screen (2a × 2b; for linear and mirror the item's diagonal × the band). */
    frame: HandleBox;
    /** The item's short side on screen (the unit of the mask's sizes). */
    unit: number;
    outline: MaskOutline[];
    handles: Array<{ kind: Exclude<MaskHandleKind, "move">; x: number; y: number }>;
}

const SQRT2_4 = Math.SQRT2 / 4;
const HEART_X = 0.25 + SQRT2_4;
const HEART_Y = (0.75 + SQRT2_4) / 2;
const STAR_X = Math.sin((2 * Math.PI) / 5);
const STAR_Y = (1 + Math.cos(Math.PI / 5)) / 2;
const STAR_CY = (1 - Math.cos(Math.PI / 5)) / 2;
const STAR_INNER = 0.4;

/** Local outline points (mask frame, v down) of a closed shape with half sizes a, b. */
function closedOutline(mask: MaskSpec, a: number, b: number): Point[] {
    const points: Point[] = [];
    switch (mask.shape) {
        case "circle":
            for (let i = 0; i < 64; i += 1) {
                const t = (i / 64) * Math.PI * 2;
                points.push({ x: a * Math.cos(t), y: b * Math.sin(t) });
            }
            return points;
        case "rectangle": {
            const r = Math.max(0, Math.min(1, mask.roundness)) * Math.min(a, b);
            const corners: Array<[number, number, number]> = [[a - r, -b + r, -Math.PI / 2], [a - r, b - r, 0], [-a + r, b - r, Math.PI / 2], [-a + r, -b + r, Math.PI]];
            for (const [cx, cy, start] of corners) {
                for (let i = 0; i <= 8; i += 1) {
                    const t = start + (i / 8) * (Math.PI / 2);
                    points.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
                }
            }
            return points;
        }
        case "heart": {
            // Quilez's heart (y up, tip at 0): straight edges from the tip to (±0.5, 0.5), lobes of radius √2/4
            // about (±0.25, 0.75) from −45° over the top to 135° (the dip at (0, 1)).
            const toLocalPoint = (hx: number, hy: number): Point => ({ x: (hx / HEART_X) * a, y: ((HEART_Y - hy) / HEART_Y) * b });
            points.push(toLocalPoint(0, 0));
            for (let i = 0; i <= 24; i += 1) {
                const t = -Math.PI / 4 + (i / 24) * Math.PI;
                points.push(toLocalPoint(0.25 + SQRT2_4 * Math.cos(t), 0.75 + SQRT2_4 * Math.sin(t)));
            }
            for (let i = 24; i >= 0; i -= 1) {
                const t = -Math.PI / 4 + (i / 24) * Math.PI;
                points.push(toLocalPoint(-(0.25 + SQRT2_4 * Math.cos(t)), 0.75 + SQRT2_4 * Math.sin(t)));
            }
            return points;
        }
        case "star":
            for (let i = 0; i < 10; i += 1) {
                const r = i % 2 === 0 ? 1 : STAR_INNER;
                const t = (i * Math.PI) / 5;
                const px = r * Math.sin(t);
                const py = r * Math.cos(t);
                points.push({ x: (px / STAR_X) * a, y: ((STAR_CY - py) / STAR_Y) * b });
            }
            return points;
        default:
            return points;
    }
}

export function maskScreenGeometry(item: HandleBox, mask: MaskSpec): MaskScreenGeometry {
    const unit = Math.max(1, Math.min(Math.abs(item.w), Math.abs(item.h)));
    const centre = toScreen(item, (mask.x - 0.5) * item.w, (mask.y - 0.5) * item.h);
    const rotation = item.rotation + (mask.rotation * Math.PI) / 180;
    const a = Math.max(0.5, (mask.width * unit) / 2);
    const b = Math.max(0.5, (mask.height * unit) / 2);
    const feather = Math.max(0, Math.min(1, mask.feather)) * MASK_FEATHER_SCALE * unit;
    const span = Math.hypot(item.w, item.h);
    const frameSize = mask.shape === "linear" ? { w: span * 2, h: 0 } : mask.shape === "mirror" ? { w: span * 2, h: 2 * a } : { w: 2 * a, h: 2 * b };
    const frame: HandleBox = { cx: centre.x, cy: centre.y, w: frameSize.w, h: frameSize.h, rotation };
    const at = (x: number, y: number) => toScreen(frame, x, y);
    const outline: MaskOutline[] = [];
    if (mask.shape === "linear") outline.push({ points: [at(-span, 0), at(span, 0)], closed: false });
    else if (mask.shape === "mirror") outline.push({ points: [at(-span, -a), at(span, -a)], closed: false }, { points: [at(-span, a), at(span, a)], closed: false });
    else outline.push({ points: closedOutline(mask, a, b).map((p) => at(p.x, p.y)), closed: true });
    const half = mask.shape === "linear" ? 0 : mask.shape === "mirror" ? a : b;
    const handles: MaskScreenGeometry["handles"] = [];
    if (mask.shape === "mirror") handles.push({ kind: "width", ...at(0, -a) });
    else if (mask.shape !== "linear") handles.push({ kind: "width", ...at(a, 0) }, { kind: "height", ...at(0, -b) }, { kind: "corner", ...at(a, b) });
    handles.push({ kind: "rotate", ...at(0, half + MASK_ROTATE_OFFSET) }, { kind: "feather", ...at(0, -half - FEATHER_HANDLE_GAP - feather) });
    return { item, shape: mask.shape, frame, unit, outline, handles };
}

/** The handle under (x, y), else "move" inside the mask (anywhere on the item for linear and mirror), else null. */
export function hitTestMask(geometry: MaskScreenGeometry, x: number, y: number, radius = MASK_HANDLE_HIT_RADIUS): MaskHandleKind | null {
    // Size handles of a small mask would cover its middle: their hit areas shrink with it (never below 3 px).
    const closed = geometry.shape !== "linear" && geometry.shape !== "mirror";
    const sizeRadius = closed ? Math.min(radius, Math.max(3, Math.min(geometry.frame.w, geometry.frame.h) / 4)) : radius;
    for (const handle of geometry.handles) {
        const r = handle.kind === "rotate" || handle.kind === "feather" ? radius : sizeRadius;
        if ((handle.x - x) ** 2 + (handle.y - y) ** 2 <= r * r) return handle.kind;
    }
    if (geometry.shape === "linear" || geometry.shape === "mirror") {
        const p = toLocal(geometry.item, x, y);
        return Math.abs(p.x) <= Math.abs(geometry.item.w) / 2 && Math.abs(p.y) <= Math.abs(geometry.item.h) / 2 ? "move" : null;
    }
    const p = toLocal(geometry.frame, x, y);
    return Math.abs(p.x) <= geometry.frame.w / 2 && Math.abs(p.y) <= geometry.frame.h / 2 ? "move" : null;
}

export interface MaskDragStart {
    item: HandleBox;
    /** The mask's values at pointer-down (keyframes evaluated at the playhead). */
    mask: MaskSpec;
    kind: MaskHandleKind;
    pointer: Point;
}

const round4 = (value: number) => Math.round(value * 10000) / 10000 || 0;
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** The mask fields a drag sets with the pointer at `pointer` (screen px). */
export function maskDragPatch(start: MaskDragStart, pointer: Point, options: { shift?: boolean } = {}): MaskPatch {
    const geometry = maskScreenGeometry(start.item, start.mask);
    const { item, mask } = start;
    const unit = geometry.unit;
    switch (start.kind) {
        case "move": {
            const centre = { x: geometry.frame.cx + pointer.x - start.pointer.x, y: geometry.frame.cy + pointer.y - start.pointer.y };
            const local = toLocal(item, centre.x, centre.y);
            return { x: round4(clamp(local.x / item.w + 0.5, -2, 3)), y: round4(clamp(local.y / item.h + 0.5, -2, 3)) };
        }
        case "width": {
            const p = toLocal(geometry.frame, pointer.x, pointer.y);
            const half = mask.shape === "mirror" ? Math.abs(p.y) : Math.abs(p.x);
            return { width: round4(clamp((2 * half) / unit, 0.01, 5)) };
        }
        case "height": {
            const p = toLocal(geometry.frame, pointer.x, pointer.y);
            return { height: round4(clamp((2 * Math.abs(p.y)) / unit, 0.01, 5)) };
        }
        case "corner": {
            const p = toLocal(geometry.frame, pointer.x, pointer.y);
            const a = geometry.frame.w / 2;
            const b = geometry.frame.h / 2;
            const factor = Math.max(0.01, (p.x * a + p.y * b) / (a * a + b * b || 1));
            return { width: round4(clamp(mask.width * factor, 0.01, 5)), height: round4(clamp(mask.height * factor, 0.01, 5)) };
        }
        case "rotate": {
            const from = pointerAngle(geometry.frame.cx, geometry.frame.cy, start.pointer.x, start.pointer.y);
            const to = pointerAngle(geometry.frame.cx, geometry.frame.cy, pointer.x, pointer.y);
            const degrees = snapRotation(mask.rotation + unwrapDelta(from, to), { shift: options.shift }).degrees;
            return { rotation: Math.round(degrees * 100) / 100 };
        }
        case "feather": {
            const p = toLocal(geometry.frame, pointer.x, pointer.y);
            const half = mask.shape === "linear" ? 0 : mask.shape === "mirror" ? geometry.frame.h / 2 : geometry.frame.h / 2;
            const distance = -p.y - half - FEATHER_HANDLE_GAP;
            return { feather: round4(clamp(distance / (MASK_FEATHER_SCALE * unit), 0, 1)) };
        }
    }
}

// ── values at a time, drawing ────────────────────────────

/** The mask with its keyframed channels at item time `t` (the values the preview shows and the handles edit). */
export function maskSpecAt(spec: MaskSpec, points: KeyframePoints, t: number): MaskSpec {
    const values = maskParamValues(spec, points, t);
    return { ...spec, x: values.mx, y: values.my, width: values.mw, height: values.mh, rotation: values.mr, feather: values.mf, roundness: values.mo };
}

export interface MaskChromeColors {
    ring: string;
    handleFill: string;
    handleStroke: string;
}

type ChromeContext = Pick<CanvasRenderingContext2D,
    "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "closePath" | "stroke" | "fill" | "arc" | "setLineDash" | "translate" | "rotate" | "strokeRect"
> & { strokeStyle: unknown; fillStyle: unknown; lineWidth: number; globalAlpha: number };

/** The item box (dashed), the mask outline, and its handles (white per the theme; the feather handle is an arrow). */
export function drawMaskChrome(ctx: ChromeContext, geometry: MaskScreenGeometry, colors: MaskChromeColors): void {
    ctx.save();
    ctx.globalAlpha = 1;
    // The item: a quiet dashed box, so the mask reads as the thing being edited.
    ctx.save();
    ctx.translate(geometry.item.cx, geometry.item.cy);
    if (geometry.item.rotation) ctx.rotate(geometry.item.rotation);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(-geometry.item.w / 2, -geometry.item.h / 2, geometry.item.w, geometry.item.h);
    ctx.restore();
    ctx.setLineDash([]);
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1.5;
    for (const line of geometry.outline) {
        if (line.points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(line.points[0].x, line.points[0].y);
        for (const p of line.points.slice(1)) ctx.lineTo(p.x, p.y);
        if (line.closed) ctx.closePath();
        ctx.stroke();
    }
    for (const handle of geometry.handles) {
        if (handle.kind === "feather") {
            // A small arrow pointing away from the shape, on a stem from the outline.
            const { frame } = geometry;
            const local = toLocal(frame, handle.x, handle.y);
            ctx.save();
            ctx.translate(frame.cx, frame.cy);
            if (frame.rotation) ctx.rotate(frame.rotation);
            ctx.beginPath();
            ctx.moveTo(0, local.y + FEATHER_HANDLE_GAP - 2);
            ctx.lineTo(0, local.y + 4);
            ctx.strokeStyle = colors.ring;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, local.y - 6);
            ctx.lineTo(5, local.y + 3);
            ctx.lineTo(-5, local.y + 3);
            ctx.closePath();
            ctx.fillStyle = colors.handleFill;
            ctx.fill();
            ctx.restore();
            continue;
        }
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, handle.kind === "rotate" ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.handleFill;
        ctx.fill();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = colors.handleStroke;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}
