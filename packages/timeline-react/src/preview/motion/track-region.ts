// The motion tracking region box of the preview (phase 10d): pure geometry for the box the inspector's Track tab
// edits. The region lives in the tracked item's own picture (source fractions, top-left + size — what the tracker
// sees); on screen it is drawn inside the item's VISUAL box (motion/handles.ts HandleBox: the placed clip, or the
// scene's media rect), turned with the item, mirrored with its flips. Drags: inside the box moves it, a corner
// resizes it against the opposite corner, anywhere else on the item draws a new box.
import type { TrackRegion } from "@opennan/timeline-core/tracking/tracker";
import { CORNER_SIGNS, toLocal, toScreen, type Corner, type HandleBox, type Point } from "./handles";

export const TRACK_REGION_MIN = 0.02;
export const TRACK_REGION_HIT_RADIUS = 10;

export interface Flip {
    x: boolean;
    y: boolean;
}

export const NO_FLIP: Flip = { x: false, y: false };

export interface TrackRegionGeometry {
    item: HandleBox;
    flip: Flip;
    /** The region's box on screen (turned with the item). */
    frame: HandleBox;
    /** TL, TR, BL, BR on screen (the frame's own corners). */
    corners: Point[];
}

export type TrackRegionHit = { kind: "move" } | { kind: "corner"; corner: Corner } | { kind: "draw" };

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const round4 = (value: number) => Math.round(value * 10000) / 10000 || 0;

/** A screen point as source fractions of the item (may fall outside 0..1). */
export function screenToSource(item: HandleBox, flip: Flip, x: number, y: number): Point {
    const local = toLocal(item, x, y);
    const fx = local.x / (item.w || 1) + 0.5;
    const fy = local.y / (item.h || 1) + 0.5;
    return { x: flip.x ? 1 - fx : fx, y: flip.y ? 1 - fy : fy };
}

/** Source fractions of the item on screen. */
export function sourceToScreen(item: HandleBox, flip: Flip, point: Point): Point {
    const fx = flip.x ? 1 - point.x : point.x;
    const fy = flip.y ? 1 - point.y : point.y;
    return toScreen(item, (fx - 0.5) * item.w, (fy - 0.5) * item.h);
}

export function trackRegionGeometry(item: HandleBox, region: TrackRegion, flip: Flip = NO_FLIP): TrackRegionGeometry {
    const centre = sourceToScreen(item, flip, { x: region.x + region.width / 2, y: region.y + region.height / 2 });
    const frame: HandleBox = { cx: centre.x, cy: centre.y, w: region.width * Math.abs(item.w), h: region.height * Math.abs(item.h), rotation: item.rotation };
    const corners = CORNER_SIGNS.map(([sx, sy]) => toScreen(frame, (sx * frame.w) / 2, (sy * frame.h) / 2));
    return { item, flip, frame, corners };
}

/** What a pointer-down at (x, y) grabs: a corner, the box, the item around it (draw), or nothing. */
export function hitTestTrackRegion(geometry: TrackRegionGeometry, x: number, y: number, radius = TRACK_REGION_HIT_RADIUS): TrackRegionHit | null {
    // Small boxes: corner hit areas shrink so the middle stays movable.
    const r = Math.min(radius, Math.max(4, Math.min(geometry.frame.w, geometry.frame.h) / 3));
    for (let i = 0; i < 4; i += 1) {
        const corner = geometry.corners[i];
        if ((corner.x - x) ** 2 + (corner.y - y) ** 2 <= r * r) return { kind: "corner", corner: i as Corner };
    }
    const inFrame = toLocal(geometry.frame, x, y);
    if (Math.abs(inFrame.x) <= geometry.frame.w / 2 && Math.abs(inFrame.y) <= geometry.frame.h / 2) return { kind: "move" };
    const inItem = toLocal(geometry.item, x, y);
    if (Math.abs(inItem.x) <= Math.abs(geometry.item.w) / 2 && Math.abs(inItem.y) <= Math.abs(geometry.item.h) / 2) return { kind: "draw" };
    return null;
}

export interface TrackRegionDragStart {
    item: HandleBox;
    flip: Flip;
    region: TrackRegion;
    hit: TrackRegionHit;
    /** Screen px at pointer-down. */
    pointer: Point;
}

/** A rectangle between two source points, inside the picture, at least TRACK_REGION_MIN on each side. */
function between(a: Point, b: Point): TrackRegion {
    let x0 = clamp(Math.min(a.x, b.x), 0, 1);
    let x1 = clamp(Math.max(a.x, b.x), 0, 1);
    let y0 = clamp(Math.min(a.y, b.y), 0, 1);
    let y1 = clamp(Math.max(a.y, b.y), 0, 1);
    if (x1 - x0 < TRACK_REGION_MIN) {
        if (a.x <= b.x) x1 = Math.min(1, x0 + TRACK_REGION_MIN);
        else x0 = Math.max(0, x1 - TRACK_REGION_MIN);
        if (x1 - x0 < TRACK_REGION_MIN) x0 = x1 - TRACK_REGION_MIN;
    }
    if (y1 - y0 < TRACK_REGION_MIN) {
        if (a.y <= b.y) y1 = Math.min(1, y0 + TRACK_REGION_MIN);
        else y0 = Math.max(0, y1 - TRACK_REGION_MIN);
        if (y1 - y0 < TRACK_REGION_MIN) y0 = y1 - TRACK_REGION_MIN;
    }
    return { x: round4(x0), y: round4(y0), width: round4(x1 - x0), height: round4(y1 - y0) };
}

/** The region with the pointer at `pointer` (screen px) during a drag. */
export function trackRegionDrag(start: TrackRegionDragStart, pointer: Point): TrackRegion {
    const from = screenToSource(start.item, start.flip, start.pointer.x, start.pointer.y);
    const to = screenToSource(start.item, start.flip, pointer.x, pointer.y);
    const { region } = start;
    switch (start.hit.kind) {
        case "move":
            return {
                x: round4(clamp(region.x + to.x - from.x, 0, 1 - region.width)),
                y: round4(clamp(region.y + to.y - from.y, 0, 1 - region.height)),
                width: region.width,
                height: region.height,
            };
        case "corner": {
            // The corner's opposite, in source fractions (flips swap which source corner a screen corner is).
            const [sx, sy] = CORNER_SIGNS[start.hit.corner];
            const ox = (start.flip.x ? -sx : sx) > 0 ? region.x : region.x + region.width;
            const oy = (start.flip.y ? -sy : sy) > 0 ? region.y : region.y + region.height;
            return between({ x: ox, y: oy }, to);
        }
        case "draw":
            return between(from, to);
    }
}

/** A region nudged by keyboard steps (fractions), kept inside the picture. */
export function nudgeTrackRegion(region: TrackRegion, dx: number, dy: number): TrackRegion {
    return { ...region, x: round4(clamp(region.x + dx, 0, 1 - region.width)), y: round4(clamp(region.y + dy, 0, 1 - region.height)) };
}

/** The default region: a box of 20% of the short side around the picture's centre. */
export function defaultTrackRegion(aspect: number): TrackRegion {
    const h = 0.2 * Math.min(1, aspect);
    const w = h / Math.max(1e-6, aspect);
    return { x: round4(0.5 - w / 2), y: round4(0.5 - h / 2), width: round4(w), height: round4(h) };
}

export interface TrackChromeColors {
    ring: string;
    handleFill: string;
    handleStroke: string;
}

type ChromeContext = Pick<CanvasRenderingContext2D,
    "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "closePath" | "stroke" | "fill" | "arc" | "setLineDash" | "translate" | "rotate" | "strokeRect"
> & { strokeStyle: unknown; fillStyle: unknown; lineWidth: number; globalAlpha: number };

/** The item (quiet dashed box), the tracked path and point (if any), the region box, and its corner handles. */
export function drawTrackRegionChrome(ctx: ChromeContext, geometry: TrackRegionGeometry, colors: TrackChromeColors, path?: { points: Point[]; current: Point | null }): void {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(geometry.item.cx, geometry.item.cy);
    if (geometry.item.rotation) ctx.rotate(geometry.item.rotation);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(-geometry.item.w / 2, -geometry.item.h / 2, geometry.item.w, geometry.item.h);
    ctx.restore();
    if (path && path.points.length > 1) {
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = colors.ring;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(path.points[0].x, path.points[0].y);
        for (const p of path.points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.restore();
    }
    if (path?.current) {
        ctx.beginPath();
        ctx.arc(path.current.x, path.current.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = colors.handleFill;
        ctx.fill();
    }
    ctx.save();
    ctx.translate(geometry.frame.cx, geometry.frame.cy);
    if (geometry.frame.rotation) ctx.rotate(geometry.frame.rotation);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-geometry.frame.w / 2, -geometry.frame.h / 2, geometry.frame.w, geometry.frame.h);
    ctx.setLineDash([]);
    // A small crosshair at the centre: the point followers will follow.
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(5, 0);
    ctx.moveTo(0, -5);
    ctx.lineTo(0, 5);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    for (const corner of geometry.corners) {
        ctx.beginPath();
        ctx.arc(corner.x, corner.y, 4.5, 0, Math.PI * 2);
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
