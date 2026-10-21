// Coordinates clip drag state, snapping, and final timeline update commits.
import type { DragState, DragMode, CanvasState, ClipCommit, SnapPoint } from "./types";
import { collectSnapPoints, snapMove, snapResize } from "./snap-engine";
import { resolveTimelineDropStart } from "../../lib/timeline-editing-shared";

function getDragSnapPoints(drag: DragState, state: CanvasState): SnapPoint[] {
  return drag.snapPoints ?? collectSnapPoints(state, new Set(drag.originals.keys()));
}

const DRAG_THRESHOLD = 4; // pixels before drag starts

function constrainMoveDelta(deltaTime: number, starts: number[]): number {
  if (deltaTime >= 0) return deltaTime;
  const minStart = starts.length > 0 ? Math.min(...starts) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(minStart)) return deltaTime;
  return Math.max(deltaTime, -minStart);
}

export function getMoveDragDelta(
  drag: DragState,
  state: CanvasState,
  extraStarts: number[] = [],
): number {
  const rawDt = (drag.currentX - drag.startX) / state.zoom;
  let finalDt = rawDt;

  if (state.snapEnabled && drag.clipId && drag.snapTime !== null) {
    const primary = drag.originals.get(drag.clipId);
    if (primary) {
      const { deltaTime } = snapMove(
        primary.startTime,
        primary.endTime,
        rawDt,
        getDragSnapPoints(drag, state),
        state.zoom,
      );
      finalDt = deltaTime;
    }
  }

  return constrainSameTrackCollisions(
    drag,
    state,
    constrainMoveDelta(
      finalDt,
      [
        ...extraStarts,
        ...[...drag.originals.values()].map((orig) => orig.startTime),
      ],
    ),
  );
}

function constrainSameTrackCollisions(drag: DragState, state: CanvasState, deltaTime: number): number {
  if (drag.mode !== "move") return deltaTime;
  // Single-clip moves slide FREELY past same-track neighbors (CapCut-style) —
  // the landing spot is resolved against neighbors on release in endDrag().
  // Clamping mid-drag made it impossible to drag a clip past its neighbor.
  if (drag.originals.size === 1) {
    const orig = drag.clipId ? drag.originals.get(drag.clipId) : null;
    return orig ? Math.max(deltaTime, -orig.startTime) : deltaTime;
  }

  let minDelta = Number.NEGATIVE_INFINITY;
  let maxDelta = Number.POSITIVE_INFINITY;

  for (const [id, orig] of drag.originals) {
    const trackKey = id === drag.clipId && drag.targetTrackKey
      ? drag.targetTrackKey
      : `${orig.trackType}-${orig.trackIndex}`;
    minDelta = Math.max(minDelta, -orig.startTime);

    for (const clip of state.clips) {
      if (drag.originals.has(clip.id)) continue;
      if (`${clip.trackType}-${clip.trackIndex}` !== trackKey) continue;

      if (clip.endTime <= orig.startTime + 0.001) {
        minDelta = Math.max(minDelta, clip.endTime - orig.startTime);
      } else if (clip.startTime >= orig.endTime - 0.001) {
        maxDelta = Math.min(maxDelta, clip.startTime - orig.endTime);
      }
    }
  }

  if (minDelta > maxDelta) return 0;
  return Math.min(Math.max(deltaTime, minDelta), maxDelta);
}

export function getResizeDragTime(drag: DragState, state: CanvasState): number | null {
  if ((drag.mode !== "resize-left" && drag.mode !== "resize-right") || !drag.clipId) return null;
  const orig = drag.originals.get(drag.clipId);
  if (!orig) return null;

  const dt = (drag.currentX - drag.startX) / state.zoom;
  let edgeTime = drag.mode === "resize-left"
    ? Math.max(0, Math.min(orig.endTime - 0.1, orig.startTime + dt))
    : Math.max(orig.startTime + 0.1, orig.endTime + dt);
  if (drag.snapTime !== null) edgeTime = drag.snapTime;

  const trackKey = `${orig.trackType}-${orig.trackIndex}`;
  const sameTrackNeighbors = state.clips
    .filter((clip) => clip.id !== drag.clipId)
    .filter((clip) => `${clip.trackType}-${clip.trackIndex}` === trackKey);
  if (drag.mode === "resize-left") {
    const previousEnds = sameTrackNeighbors
      .filter((clip) => clip.endTime <= orig.startTime + 0.001)
      .map((clip) => clip.endTime);
    if (previousEnds.length > 0) {
      edgeTime = Math.max(edgeTime, Math.max(...previousEnds));
    }
    // Can't reveal more head material than the source has: the start may move
    // left by at most the trimmed-off head (trimStart, timeline seconds). Only
    // enforced when the source length is actually measured, mirroring maxEnd.
    if (state.maxEndById?.has(drag.clipId)) {
      const liveClip = state.clips.find((clip) => clip.id === drag.clipId);
      if (typeof liveClip?.trimStart === "number") {
        edgeTime = Math.max(edgeTime, orig.startTime - Math.max(0, liveClip.trimStart));
      }
    }
  } else {
    const nextStarts = sameTrackNeighbors
      .filter((clip) => clip.startTime >= orig.endTime - 0.001)
      .map((clip) => clip.startTime);
    if (nextStarts.length > 0) {
      edgeTime = Math.min(edgeTime, Math.min(...nextStarts));
    }
    // Can't extend a clip past its real source footage.
    const maxEnd = state.maxEndById?.get(drag.clipId);
    if (maxEnd != null && Number.isFinite(maxEnd)) {
      edgeTime = Math.min(edgeTime, maxEnd);
    }
  }

  return drag.mode === "resize-left"
    ? Math.min(edgeTime, orig.endTime - 0.1)
    : Math.max(edgeTime, orig.startTime + 0.1);
}

export function createIdleDrag(): DragState {
  return {
    mode: "idle",
    clipId: null,
    originals: new Map(),
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    snapTime: null,
    snapSource: null,
    snapEdge: null,
    snapDeltaTime: null,
    moveDeltaTime: null,
    resizeTime: null,
    targetTrackKey: null,
    committed: false,
    snapPoints: null,
  };
}

/** Resolve canvas Y → TrackLayoutEntry (accounting for ruler height). */
function trackAtY(y: number, state: CanvasState): import("./types").TrackLayoutEntry | null {
  const RULER_H = 20; // matches RULER_HEIGHT in timeline-renderer
  const relY = y - RULER_H;
  for (const t of state.tracks) {
    if (relY >= t.y && relY < t.y + t.height) return t;
  }
  return null;
}

export interface DragCallbacks {
  onSeek: (time: number) => void;
  onCommit: (commits: ClipCommit[]) => void;
  onRequestRender: () => void;
}

/**
 * Start a drag operation based on hit detection result.
 */
export function startDrag(
  mode: DragMode,
  clipId: string | null,
  selectedClipIds: Set<string>,
  state: CanvasState,
  canvasX: number,
  canvasY: number,
): DragState {
  const originals = new Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>();

  if (mode === "move" && clipId) {
    // Include all selected clips in the drag
    const idsToMove = selectedClipIds.has(clipId) ? selectedClipIds : new Set([clipId]);
    for (const id of idsToMove) {
      const clip = state.clips.find(c => c.id === id);
      if (clip) {
        originals.set(id, { startTime: clip.startTime, endTime: clip.endTime, trackType: clip.trackType, trackIndex: clip.trackIndex });
      }
    }
  } else if ((mode === "resize-left" || mode === "resize-right") && clipId) {
    const clip = state.clips.find(c => c.id === clipId);
    if (clip) {
      originals.set(clipId, { startTime: clip.startTime, endTime: clip.endTime, trackType: clip.trackType, trackIndex: clip.trackIndex });
    }
  }

  return {
    mode,
    clipId,
    originals,
    startX: canvasX,
    startY: canvasY,
    currentX: canvasX,
    currentY: canvasY,
    snapTime: null,
    snapSource: null,
    snapEdge: null,
    snapDeltaTime: null,
    moveDeltaTime: null,
    resizeTime: null,
    targetTrackKey: null,
    committed: false,
    snapPoints: collectSnapPoints(state, new Set(originals.keys())),
  };
}

/**
 * Update a drag operation on mouse move.
 * Returns the updated drag state (pure function, no side effects).
 */
export function updateDrag(
  drag: DragState,
  canvasX: number,
  canvasY: number,
  state: CanvasState,
): DragState {
  const updated = { ...drag, currentX: canvasX, currentY: canvasY };

  // Track which track the primary clip is hovering over (for cross-track move)
  if (drag.mode === "move" && drag.clipId) {
    const hovered = trackAtY(canvasY, state);
    const orig = drag.originals.get(drag.clipId);
    if (hovered && orig) {
      // Only allow cross-track if same type (audio→audio, video→video, etc.)
      const sameType = hovered.type === orig.trackType;
      updated.targetTrackKey = sameType ? `${hovered.type}-${hovered.index}` : `${orig.trackType}-${orig.trackIndex}`;
    }
  }

  // Check drag threshold
  if (!drag.committed) {
    const dx = canvasX - drag.startX;
    const dy = canvasY - drag.startY;
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) {
      return updated;
    }
    updated.committed = true;
  }

  const { zoom } = state;

  // Compute snap
  if (state.snapEnabled && drag.clipId) {
    const snapPoints = getDragSnapPoints(drag, state);

    if (drag.mode === "move") {
      const primary = drag.originals.get(drag.clipId);
      if (primary) {
        const rawDt = (canvasX - drag.startX) / zoom;
        const { deltaTime, snapTime, snapSource, snapEdge } = snapMove(
          primary.startTime, primary.endTime, rawDt, snapPoints, zoom
        );
        updated.snapTime = snapTime;
        updated.snapSource = snapSource;
        updated.snapEdge = snapEdge;
        updated.snapDeltaTime = snapTime === null ? null : deltaTime;
      }
    } else if (drag.mode === "resize-left") {
      const orig = drag.originals.get(drag.clipId);
      if (orig) {
        const dt = (canvasX - drag.startX) / zoom;
        const candidateStart = Math.max(0, orig.startTime + dt);
        const { snapTime, snapSource } = snapResize(candidateStart, snapPoints, zoom);
        updated.snapTime = snapTime;
        updated.snapSource = snapSource;
        updated.snapEdge = snapTime === null ? null : "resize";
        updated.snapDeltaTime = null;
      }
    } else if (drag.mode === "resize-right") {
      const orig = drag.originals.get(drag.clipId);
      if (orig) {
        const dt = (canvasX - drag.startX) / zoom;
        const candidateEnd = orig.endTime + dt;
        const { snapTime, snapSource } = snapResize(candidateEnd, snapPoints, zoom);
        updated.snapTime = snapTime;
        updated.snapSource = snapSource;
        updated.snapEdge = snapTime === null ? null : "resize";
        updated.snapDeltaTime = null;
      }
    }
  } else {
    updated.snapTime = null;
    updated.snapSource = null;
    updated.snapEdge = null;
    updated.snapDeltaTime = null;
  }

  updated.moveDeltaTime = drag.mode === "move"
    ? getMoveDragDelta(updated, state)
    : null;
  updated.resizeTime = updated.mode === "resize-left" || updated.mode === "resize-right"
    ? getResizeDragTime(updated, state)
    : null;
  if (
    updated.mode === "move" &&
    updated.snapDeltaTime !== null &&
    updated.moveDeltaTime !== null &&
    Math.abs(updated.moveDeltaTime - updated.snapDeltaTime) > 0.001
  ) {
    updated.snapTime = null;
    updated.snapSource = null;
    updated.snapEdge = null;
    updated.snapDeltaTime = null;
  }
  if (
    (updated.mode === "resize-left" || updated.mode === "resize-right") &&
    updated.snapTime !== null &&
    updated.resizeTime !== null &&
    Math.abs(updated.resizeTime - updated.snapTime) > 0.001
  ) {
    updated.snapTime = null;
    updated.snapSource = null;
    updated.snapEdge = null;
  }

  return updated;
}

/** Resolve where a freely-dragged clip lands: if the requested spot overlaps a
 *  same-track neighbor, snap to the nearer side of the blocking clip (still
 *  checking the rest of the track). Returns null when nothing fits — the
 *  caller keeps the clip where it was. */
export const resolveDropStart = resolveTimelineDropStart;

function collectResizeRippleCommits(
  drag: DragState,
  state: CanvasState,
  resizedStart: number,
  resizedEnd: number,
): ClipCommit[] {
  if ((drag.mode !== "resize-left" && drag.mode !== "resize-right") || !drag.clipId) return [];
  const orig = drag.originals.get(drag.clipId);
  if (!orig) return [];

  const trackKey = `${orig.trackType}-${orig.trackIndex}`;
  const delta = drag.mode === "resize-right"
    ? resizedEnd - orig.endTime
    : resizedStart - orig.startTime;
  if (Math.abs(delta) <= 0.001) return [];

  const commits: ClipCommit[] = [];
  for (const clip of state.clips) {
    if (clip.id === drag.clipId) continue;
    if (`${clip.trackType}-${clip.trackIndex}` !== trackKey) continue;
    const shouldShift = drag.mode === "resize-right"
      ? clip.startTime >= orig.endTime - 0.001
      : clip.endTime <= orig.startTime + 0.001;
    if (!shouldShift) continue;

    commits.push({
      clipId: clip.id,
      startTime: Math.max(0, clip.startTime + delta),
      endTime: Math.max(0.1, clip.endTime + delta),
    });
  }
  return commits;
}

/**
 * Finalize a drag operation. Returns commits for clip position changes.
 */
export function endDrag(
  drag: DragState,
  state: CanvasState,
): ClipCommit[] {
  if (!drag.committed || drag.mode === "idle" || drag.mode === "ruler-scrub") {
    return [];
  }

  const { zoom } = state;
  const commits: ClipCommit[] = [];

  if (drag.mode === "move") {
    const finalDt = getMoveDragDelta(drag, state);

    // Resolve target track for the primary clip
    const targetTrack = drag.targetTrackKey
      ? state.tracks.find(t => `${t.type}-${t.index}` === drag.targetTrackKey)
      : null;

    for (const [id, orig] of drag.originals) {
      let newStart = Math.max(0, orig.startTime + finalDt);
      const duration = orig.endTime - orig.startTime;
      const commit: import("./types").ClipCommit = { clipId: id, startTime: newStart, endTime: newStart + duration };
      // Emit new track if primary clip moved tracks (multi-select: only move primary clip's track for now)
      if (id === drag.clipId && targetTrack && (targetTrack.type !== orig.trackType || targetTrack.index !== orig.trackIndex)) {
        commit.trackType = targetTrack.type;
        commit.trackIndex = targetTrack.index;
      }
      // Single-clip free move: land in the nearest free spot on the drop track.
      if (drag.originals.size === 1) {
        const dropTrackKey = commit.trackType
          ? `${commit.trackType}-${commit.trackIndex}`
          : `${orig.trackType}-${orig.trackIndex}`;
        const blockers = state.clips
          .filter((clip) => clip.id !== id)
          .filter((clip) => `${clip.trackType}-${clip.trackIndex}` === dropTrackKey);
        const resolvedStart = resolveDropStart(newStart, duration, blockers);
        if (resolvedStart === null) {
          // Nowhere to land on the drop track — keep the clip where it was.
          commit.startTime = orig.startTime;
          commit.endTime = orig.endTime;
          delete commit.trackType;
          delete commit.trackIndex;
        } else {
          newStart = resolvedStart;
          commit.startTime = newStart;
          commit.endTime = newStart + duration;
        }
      }
      commits.push(commit);
    }
  } else if (drag.mode === "resize-left" && drag.clipId) {
    const orig = drag.originals.get(drag.clipId);
    if (orig) {
      const dt = (drag.currentX - drag.startX) / zoom;
      const newStart = drag.resizeTime ?? Math.max(0, Math.min(orig.endTime - 0.1, orig.startTime + dt));
      commits.push({ clipId: drag.clipId, startTime: newStart, endTime: orig.endTime });
      commits.push(...collectResizeRippleCommits(drag, state, newStart, orig.endTime));
    }
  } else if (drag.mode === "resize-right" && drag.clipId) {
    const orig = drag.originals.get(drag.clipId);
    if (orig) {
      const dt = (drag.currentX - drag.startX) / zoom;
      const newEnd = drag.resizeTime ?? Math.max(orig.startTime + 0.1, orig.endTime + dt);
      commits.push({ clipId: drag.clipId, startTime: orig.startTime, endTime: newEnd });
      commits.push(...collectResizeRippleCommits(drag, state, orig.startTime, newEnd));
    }
  }

  return commits;
}

/**
 * Compute effective clip positions during a drag (for rendering).
 * Returns a map of clipId → { startTime, endTime }.
 */
export function getDragPositions(
  drag: DragState,
  state: CanvasState,
): Map<string, { startTime: number; endTime: number; trackKey?: string }> {
  const positions = new Map<string, { startTime: number; endTime: number; trackKey?: string }>();

  if (drag.mode === "idle" || !drag.committed) return positions;

  const { zoom } = state;

  if (drag.mode === "move") {
    const finalDt = getMoveDragDelta(drag, state);

    for (const [id, orig] of drag.originals) {
      const newStart = Math.max(0, orig.startTime + finalDt);
      const duration = orig.endTime - orig.startTime;
      const entry: { startTime: number; endTime: number; trackKey?: string } = { startTime: newStart, endTime: newStart + duration };
      // For the primary clip, show preview on the target track
      if (id === drag.clipId && drag.targetTrackKey) {
        entry.trackKey = drag.targetTrackKey;
      }
      positions.set(id, entry);
    }
  } else if (drag.mode === "resize-left" && drag.clipId) {
    const orig = drag.originals.get(drag.clipId);
    if (orig) {
      const dt = (drag.currentX - drag.startX) / zoom;
      const newStart = drag.resizeTime ?? Math.max(0, Math.min(orig.endTime - 0.1, orig.startTime + dt));
      positions.set(drag.clipId, { startTime: newStart, endTime: orig.endTime });
    }
  } else if (drag.mode === "resize-right" && drag.clipId) {
    const orig = drag.originals.get(drag.clipId);
    if (orig) {
      const dt = (drag.currentX - drag.startX) / zoom;
      const newEnd = drag.resizeTime ?? Math.max(orig.startTime + 0.1, orig.endTime + dt);
      positions.set(drag.clipId, { startTime: orig.startTime, endTime: newEnd });
    }
  }

  return positions;
}
