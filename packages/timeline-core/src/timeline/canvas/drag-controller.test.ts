// Unit tests for canvas drag and resize commit helpers.
import { describe, expect, it } from "vitest";
import { getResizeDragTime, getMoveDragDelta, resolveDropStart, startDrag, updateDrag } from "./drag-controller";
import type { CanvasState, DragState } from "./types";

const makeResizeDrag = (mode: "resize-left" | "resize-right", currentX: number): DragState => ({
  mode,
  clipId: "selected",
  originals: new Map([
    [
      "selected",
      {
        startTime: 8,
        endTime: 12,
        trackType: "text",
        trackIndex: 1,
      },
    ],
  ]),
  startX: 0,
  startY: 0,
  currentX,
  currentY: 0,
  snapTime: null,
  snapSource: null,
  snapEdge: null,
  snapDeltaTime: null,
  moveDeltaTime: null,
  resizeTime: null,
  targetTrackKey: null,
  committed: true,
  snapPoints: null,
});

const state = {
  zoom: 10,
  clips: [
    { id: "previous", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7 },
    { id: "selected", trackType: "text", trackIndex: 1, startTime: 8, endTime: 12 },
    { id: "next", trackType: "text", trackIndex: 1, startTime: 13, endTime: 15 },
    { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 14 },
  ],
} as CanvasState;

describe("getResizeDragTime", () => {
  it("clamps resize edges at same-track neighbors", () => {
    expect(getResizeDragTime(makeResizeDrag("resize-left", -30), state)).toBe(7);
    expect(getResizeDragTime(makeResizeDrag("resize-right", 30), state)).toBe(13);
  });

  it("clamps resize-right to the source footage limit (maxEndById)", () => {
    const stateWithLimit = {
      ...state,
      maxEndById: new Map([["selected", 12.5]]),
    } as CanvasState;
    // Without a limit +30 would reach the neighbor at 13; the 12.5 source limit wins.
    expect(getResizeDragTime(makeResizeDrag("resize-right", 30), stateWithLimit)).toBe(12.5);
    // resize-left is unaffected by the source-end limit.
    expect(getResizeDragTime(makeResizeDrag("resize-left", -30), stateWithLimit)).toBe(7);
  });

  it("clamps resize-left to the available trimmed-off head material", () => {
    const stateWithTrim = {
      ...state,
      clips: state.clips.map((clip) =>
        clip.id === "selected" ? { ...clip, trimStart: 0.5, trimEnd: 4.5 } : clip,
      ),
      maxEndById: new Map([["selected", 12.5]]),
    } as CanvasState;
    // Only 0.5s of head material exists: start can reach 7.5, not the neighbor at 7.
    expect(getResizeDragTime(makeResizeDrag("resize-left", -30), stateWithTrim)).toBe(7.5);
    // Without a measured source duration the trim clamp is not applied.
    const stateWithTrimNoLimit = { ...stateWithTrim, maxEndById: null } as CanvasState;
    expect(getResizeDragTime(makeResizeDrag("resize-left", -30), stateWithTrimNoLimit)).toBe(7);
  });
});

describe("single-clip free move", () => {
  const makeMoveDrag = (currentX: number): DragState => ({
    ...makeResizeDrag("resize-left", currentX),
    mode: "move",
  });

  it("does not clamp a single clip's move at same-track neighbors", () => {
    // +50px at zoom 10 = +5s: would previously clamp at the 'next' clip (13s).
    const drag = makeMoveDrag(50);
    expect(getMoveDragDelta(drag, { ...state, snapEnabled: false } as CanvasState)).toBe(5);
  });

  it("still clamps a move at the timeline start", () => {
    const drag = makeMoveDrag(-200);
    expect(getMoveDragDelta(drag, { ...state, snapEnabled: false } as CanvasState)).toBe(-8);
  });
});

describe("drag-session snap point cache", () => {
  const fullState = {
    ...state,
    scenes: [],
    markers: [],
    currentTime: 0,
    snapEnabled: true,
    tracks: [],
  } as unknown as CanvasState;

  it("startDrag collects snap points once, excluding the dragged clips", () => {
    const drag = startDrag("move", "selected", new Set(["selected"]), fullState, 80, 0);
    expect(drag.snapPoints).not.toBeNull();
    const times = drag.snapPoints!.map((p) => p.time);
    // Other clips' edges present, dragged clip's own edges absent.
    expect(times).toContain(13);
    expect(times).toContain(7);
    const clipEdgePoints = drag.snapPoints!.filter((p) => p.source === "clip-start" || p.source === "clip-end");
    expect(clipEdgePoints.some((p) => p.time === 8 || p.time === 12)).toBe(false);
  });

  it("updateDrag snaps against the cached list, not the live state", () => {
    const started = startDrag("move", "selected", new Set(["selected"]), fullState, 80, 0);
    // Replace the cache with a single marker at t=20; nothing in state snaps there.
    const cached: DragState = { ...started, committed: true, snapPoints: [{ time: 20, source: "marker" }] };
    // Move so the clip start (8s) lands at 19.95s — within 8px/zoom10 = 0.8s of 20.
    const updated = updateDrag(cached, 80 + 119.5, 0, { ...fullState, clips: [] } as CanvasState);
    expect(updated.snapTime).toBe(20);
    expect(updated.moveDeltaTime).toBe(12);
  });
});

describe("resolveDropStart", () => {
  const blockers = [
    { startTime: 10, endTime: 14 },
    { startTime: 14, endTime: 18 },
  ];

  it("keeps a non-overlapping request unchanged", () => {
    expect(resolveDropStart(4, 4, blockers)).toBe(4);
    expect(resolveDropStart(18, 4, blockers)).toBe(18);
  });

  it("snaps an overlapping drop to the nearer side of the blocking clip", () => {
    // Overlaps [10,14] near its left edge → land right before it.
    expect(resolveDropStart(8, 4, blockers)).toBe(6);
    // Overlaps [14,18] near its right edge → land right after it.
    expect(resolveDropStart(17, 4, blockers)).toBe(18);
  });

  it("falls back to the far side when the nearer side collides with the next blocker", () => {
    // Overlaps [10,14] leaning right; 'after' (14) collides with [14,18], so
    // the clip lands before [10,14] instead.
    expect(resolveDropStart(13, 4, blockers)).toBe(6);
  });

  it("returns null when the clip fits on neither side of the blocker", () => {
    expect(resolveDropStart(1, 4, [{ startTime: 0, endTime: 3 }, { startTime: 3, endTime: 6 }])).toBe(null);
  });
});
