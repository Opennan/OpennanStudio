// Snapping of a moved item in the preview (phase 10b): the item's box centre snaps to centre lines and
// its edges snap to edges (the frame's, and other visible items'), within a threshold in screen pixels.
// Pure: the panel passes the proposed axis-aligned bounds (the rotated visual box's bounds after the raw
// pointer delta), applies the returned correction, and draws the returned guides across the frame.
import type { HandleBox } from "./handles";

export const SNAP_THRESHOLD_PX = 6;

export interface SnapBounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

export type SnapKind = "edge" | "center";

export interface SnapLine {
    pos: number;
    kind: SnapKind;
}

export interface SnapTargets {
    x: SnapLine[];
    y: SnapLine[];
}

export interface SnapGuide {
    axis: "x" | "y";
    pos: number;
}

export interface SnapResult {
    /** Correction to add to the raw delta, in px. */
    dx: number;
    dy: number;
    /** The lines the snapped box touches (one entry per distinct line), x first. */
    guides: SnapGuide[];
}

/** Axis-aligned bounds of a rotated box. */
export function boundsOfBox(box: HandleBox): SnapBounds {
    const c = Math.abs(Math.cos(box.rotation));
    const s = Math.abs(Math.sin(box.rotation));
    const hw = (box.w * c + box.h * s) / 2;
    const hh = (box.w * s + box.h * c) / 2;
    return { left: box.cx - hw, right: box.cx + hw, top: box.cy - hh, bottom: box.cy + hh };
}

export function translateBounds(b: SnapBounds, dx: number, dy: number): SnapBounds {
    return { left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy };
}

function linesOf(lo: number, hi: number): SnapLine[] {
    return [{ pos: lo, kind: "edge" }, { pos: (lo + hi) / 2, kind: "center" }, { pos: hi, kind: "edge" }];
}

/** The frame's edges and centre lines. */
export function frameSnapTargets(frame: { x: number; y: number; w: number; h: number }): SnapTargets {
    return { x: linesOf(frame.x, frame.x + frame.w), y: linesOf(frame.y, frame.y + frame.h) };
}

/** Other items' edges and centres. */
export function itemSnapTargets(items: SnapBounds[]): SnapTargets {
    return {
        x: items.flatMap((b) => linesOf(b.left, b.right)),
        y: items.flatMap((b) => linesOf(b.top, b.bottom)),
    };
}

export function mergeSnapTargets(...all: SnapTargets[]): SnapTargets {
    return { x: all.flatMap((t) => t.x), y: all.flatMap((t) => t.y) };
}

const MATCH_EPS = 0.5;

function snapAxis(lo: number, hi: number, targets: SnapLine[], threshold: number): { delta: number; lines: number[] } {
    const features = linesOf(lo, hi);
    let best: number | null = null;
    for (const f of features) {
        for (const t of targets) {
            if (t.kind !== f.kind) continue;
            const d = t.pos - f.pos;
            if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
        }
    }
    if (best === null) return { delta: 0, lines: [] };
    const delta = best;
    const lines = new Set<number>();
    for (const f of features) {
        for (const t of targets) {
            if (t.kind === f.kind && Math.abs(t.pos - (f.pos + delta)) <= MATCH_EPS) lines.add(t.pos);
        }
    }
    return { delta, lines: [...lines].sort((a, b) => a - b) };
}

/** The correction that snaps `bounds` to the nearest target per axis (0 and no guide when none is in reach). */
export function snapMove(bounds: SnapBounds, targets: SnapTargets, threshold = SNAP_THRESHOLD_PX): SnapResult {
    const x = snapAxis(bounds.left, bounds.right, targets.x, threshold);
    const y = snapAxis(bounds.top, bounds.bottom, targets.y, threshold);
    return {
        dx: x.delta,
        dy: y.delta,
        guides: [...x.lines.map((pos) => ({ axis: "x" as const, pos })), ...y.lines.map((pos) => ({ axis: "y" as const, pos }))],
    };
}
