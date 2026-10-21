// Timeline keyframe diamonds as hit targets (phase 10c): which diamond of the selected clip or scene is under
// the pointer, and where a dragged diamond lands (30 fps grid, the playhead). Pure; the renderer draws the
// same geometry (getKeyframeItemGeometry), so what is drawn is what is hit.
import type { CanvasState } from "./types";
import { getKeyframeItemGeometry, KEYFRAME_MARKER_INSET } from "./timeline-renderer";

/** Half sizes of a diamond's hit box (px): generous next to the 4 px drawn diamond. */
export const KEYFRAME_HIT_HALF_WIDTH = 7;
export const KEYFRAME_HIT_HALF_HEIGHT = 8;
/** Keyframes land on this frame grid (item-local seconds). */
export const KEYFRAME_FPS = 30;
/** A dragged diamond snaps to the playhead within this many pixels. */
export const KEYFRAME_PLAYHEAD_SNAP_PX = 8;

export interface KeyframeMarkerHit {
  clipId?: string;
  sceneId?: string;
  /** Item-local seconds. */
  time: number;
}

/** The selected item's diamond under canvas (x, y) (x before scrolling), the closest one; null when none. */
export function hitKeyframeMarker(canvasX: number, canvasY: number, state: CanvasState): KeyframeMarkerHit | null {
  const geometry = getKeyframeItemGeometry(state);
  if (!geometry) return null;
  const { x, y, w, h, times } = geometry;
  const cy = y + h - KEYFRAME_MARKER_INSET;
  if (Math.abs(canvasY - cy) > KEYFRAME_HIT_HALF_HEIGHT) return null;
  const worldX = canvasX + state.scrollLeft;
  const d = Math.max(0.001, geometry.duration);
  let best: number | null = null;
  let bestDistance = KEYFRAME_HIT_HALF_WIDTH + 1e-9;
  for (const time of times) {
    const cx = x + (time / d) * w;
    // The renderer skips diamonds under the item's edges (planKeyframeMarkers).
    if (cx < x + 3 || cx > x + w - 3) continue;
    const distance = Math.abs(worldX - cx);
    if (distance <= bestDistance) {
      best = time;
      bestDistance = distance;
    }
  }
  if (best === null) return null;
  return geometry.clipId ? { clipId: geometry.clipId, time: best } : { sceneId: geometry.sceneId, time: best };
}

export interface KeyframeSnapOptions {
  /** Item length (seconds): the result stays in [0, duration]. */
  duration: number;
  /** Playhead in item-local seconds (null when unknown). */
  localPlayhead: number | null;
  /** px per second. */
  zoom: number;
  /** The timeline's snap toggle (the playhead magnet); the frame grid always applies. */
  snapEnabled: boolean;
}

const roundMs = (t: number) => Math.round(t * 1000) / 1000;

/** Where a diamond dragged to item-local `raw` seconds lands: the playhead within 8 px (snap on), else the nearest frame. */
export function snapKeyframeTime(raw: number, options: KeyframeSnapOptions): { time: number; snapped: "playhead" | "frame" } {
  const duration = Math.max(0, options.duration);
  const t = Math.min(duration, Math.max(0, Number.isFinite(raw) ? raw : 0));
  const playhead = options.localPlayhead;
  if (options.snapEnabled && playhead !== null && playhead >= 0 && playhead <= duration
    && Math.abs(t - playhead) * options.zoom <= KEYFRAME_PLAYHEAD_SNAP_PX) {
    return { time: roundMs(playhead), snapped: "playhead" };
  }
  // The item's end is a valid landing spot even off the grid.
  if (duration - t < 0.5 / KEYFRAME_FPS && Math.abs(duration * KEYFRAME_FPS - Math.round(duration * KEYFRAME_FPS)) > 1e-6) {
    return { time: roundMs(duration), snapped: "frame" };
  }
  const frame = Math.round(t * KEYFRAME_FPS) / KEYFRAME_FPS;
  return { time: roundMs(Math.min(duration, frame)), snapped: "frame" };
}
