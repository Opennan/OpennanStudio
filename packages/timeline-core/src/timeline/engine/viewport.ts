// INVARIANTS: see ../TIMELINE_RULES.md before changing these semantics.
// Viewport math: pointer-anchored zoom, padded auto-expanding content, edge
// auto-scroll. All pure — the adapter owns requestAnimationFrame loops.

import type { Viewport } from "./types";

export const MIN_VISIBLE_SECONDS = 60;
export const EXPAND_PADDING = 1.25;
export const MAX_PX_PER_SECOND = 400;
const EDGE_ZONE_PX = 48;
const EDGE_MAX_VELOCITY = 24; // px per frame at the very edge

// Ctrl/cmd+wheel zoom gestures (mouse-wheel notches, trackpad pinches, and
// especially Chromium's synthesized ctrl+wheel "smooth page zoom", which
// splits a single physical gesture into a burst of several wheel events with
// smaller deltaY ticks) can deliver more than one wheel event per intended
// "step". If a caller applies a full discrete zoom-level step per wheel
// event, one gesture can silently consume two-or-more table levels while the
// opposing gesture only consumes one, so alternating in/out gestures don't
// invert each other and the zoom level drifts until it settles at a level
// boundary (e.g. the minimum) it can no longer escape symmetrically — this is
// the "zoom fixed point" bug. Callers should accumulate deltaY across all
// wheel events observed within one animation frame and resolve the *net*
// direction once via this function, instead of stepping once per event.
export function resolveWheelZoomStep(accumulatedDeltaY: number): -1 | 0 | 1 {
    if (accumulatedDeltaY === 0) return 0;
    return accumulatedDeltaY < 0 ? 1 : -1;
}

export function contentWidthPx(contentEndSeconds: number, pxPerSecond: number): number {
    const paddedSeconds = Math.max(MIN_VISIBLE_SECONDS, contentEndSeconds * EXPAND_PADDING);
    return paddedSeconds * pxPerSecond;
}

export function clampScroll(vp: Viewport, contentEndSeconds: number): Viewport {
    const maxScroll = Math.max(0, contentWidthPx(contentEndSeconds, vp.pxPerSecond) - vp.viewportWidthPx);
    return { ...vp, scrollX: Math.min(Math.max(0, vp.scrollX), maxScroll) };
}

export function zoomAt(vp: Viewport, factor: number, anchorPx: number, contentEndSeconds: number): Viewport {
    return zoomTo(vp, vp.pxPerSecond * factor, anchorPx, contentEndSeconds);
}

// Like zoomAt, but takes the desired pxPerSecond directly instead of a
// multiplicative factor. Callers stepping through a fixed table of named zoom
// levels (e.g. getNextTimelineZoom) already know the exact target value —
// routing that through zoomAt's `current * factor` would recompute it via a
// division-then-multiplication round trip that reintroduces floating-point
// error (e.g. landing on 24.999999999999996 instead of exactly 25). That
// error is invisible pixel-wise but poisons the *next* step: level-table
// comparisons use an epsilon tolerance, so a target that's a hair below its
// own level reads as "already there" and the next zoom-out silently no-ops —
// the timeline "zoom fixed point" bug. Passing the target through unchanged
// keeps it exactly on the table value, so repeated alternating zoom steps
// never drift.
export function zoomTo(vp: Viewport, targetPxPerSecond: number, anchorPx: number, contentEndSeconds: number): Viewport {
    const paddedSeconds = Math.max(MIN_VISIBLE_SECONDS, contentEndSeconds * EXPAND_PADDING);
    const minPps = vp.viewportWidthPx / paddedSeconds;
    const pxPerSecond = Math.min(MAX_PX_PER_SECOND, Math.max(minPps, targetPxPerSecond));
    const anchorTime = (vp.scrollX + anchorPx) / vp.pxPerSecond;
    const scrollX = anchorTime * pxPerSecond - anchorPx;
    return clampScroll({ ...vp, pxPerSecond, scrollX }, contentEndSeconds);
}

export function edgeScrollVelocity(pointerPx: number, viewportWidthPx: number): number {
    if (pointerPx < EDGE_ZONE_PX) {
        return -EDGE_MAX_VELOCITY * (1 - pointerPx / EDGE_ZONE_PX);
    }
    if (pointerPx > viewportWidthPx - EDGE_ZONE_PX) {
        return EDGE_MAX_VELOCITY * (1 - (viewportWidthPx - pointerPx) / EDGE_ZONE_PX);
    }
    return 0;
}
