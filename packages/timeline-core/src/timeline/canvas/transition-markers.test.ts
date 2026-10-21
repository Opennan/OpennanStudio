// Unit tests for transition-marker geometry and hit-testing. A transition lives
// on a clip's (or scene's) junction with the next item; the marker is a small
// square centered on the END (the cut), vertically centered on its track.
import { describe, expect, it } from "vitest";
import {
  TRANSITION_MARKER_SIZE,
  DEFAULT_TRANSITION_DURATION,
  isTransitionMarkerClip,
  getTransitionMarkers,
  getSceneTransitionMarkers,
  getTransitionJunctions,
  getSceneTransitionJunctions,
  hasTransitionMarker,
  hitTransitionMarker,
  hitTransitionEdge,
} from "./transition-markers";

const track = (over = {}) => ({
  key: "video-1",
  type: "video",
  index: 1,
  y: 100,
  height: 64,
  track: null,
  locked: false,
  muted: false,
  visible: true,
  ...over,
});

const clip = (over = {}) => ({
  id: "c1",
  trackType: "video",
  trackIndex: 1,
  startTime: 0,
  endTime: 5,
  transitionType: "none",
  ...over,
});

const scene = (over = {}) => ({
  id: "s1",
  trackIndex: 1,
  timelinePositionSeconds: 0,
  duration: 5,
  visualTransition: "none",
  ...over,
});
const sceneEnd = (s: { timelinePositionSeconds?: number; duration?: number | null }) =>
  (s.timelinePositionSeconds ?? 0) + (s.duration ?? 0);

describe("isTransitionMarkerClip", () => {
  it("is true for a fade-layer clip with a real transition", () => {
    expect(isTransitionMarkerClip(clip({ transitionType: "crossDissolve" }))).toBe(true);
    expect(isTransitionMarkerClip(clip({ trackType: "audio", transitionType: "crossfade" }))).toBe(true);
  });

  it("is false for 'none' / empty / effect-track", () => {
    expect(isTransitionMarkerClip(clip({ transitionType: "none" }))).toBe(false);
    expect(isTransitionMarkerClip(clip({ transitionType: "" }))).toBe(false);
    expect(isTransitionMarkerClip(clip({ trackType: "effect", transitionType: "dissolve" }))).toBe(false);
  });
});

describe("getTransitionMarkers (clips)", () => {
  it("emits a clip-kind marker at the clip END for each transition clip on a laid-out track", () => {
    const clips = [
      clip({ id: "c1", startTime: 0, endTime: 5, transitionType: "dissolve" }),
      clip({ id: "c2", startTime: 5, endTime: 10, transitionType: "none" }),
    ];
    expect(getTransitionMarkers(clips, [track()], 10)).toEqual([
      {
        id: "c1", kind: "clip", transitionType: "dissolve", worldX: 50, centerY: 132,
        durationSeconds: DEFAULT_TRANSITION_DURATION,
        widthPx: TRANSITION_MARKER_SIZE,
        maxDurationSeconds: 5,
      },
    ]);
  });

  it("spans the marker by the transition duration and clamps max to the shorter neighbor", () => {
    const clips = [
      clip({ id: "c1", startTime: 0, endTime: 5, transitionType: "dissolve", transitionDuration: 2 }),
      clip({ id: "c2", startTime: 5, endTime: 8, transitionType: "none" }),
    ];
    const [marker] = getTransitionMarkers(clips, [track()], 10);
    expect(marker.durationSeconds).toBe(2);
    expect(marker.widthPx).toBe(20); // 2s * zoom 10
    expect(marker.maxDurationSeconds).toBe(3); // min(5s, 3s)
  });

  it("does not emit a marker for a transition on the last clip", () => {
    const clips = [
      clip({ id: "c1", startTime: 0, endTime: 5, transitionType: "none" }),
      clip({ id: "last", startTime: 5, endTime: 10, transitionType: "dissolve" }),
    ];

    expect(getTransitionMarkers(clips, [track()], 10)).toEqual([]);
  });

  it("does not emit markers on hidden clip tracks", () => {
    const clips = [
      clip({ id: "hidden-left", startTime: 0, endTime: 5, transitionType: "dissolve" }),
      clip({ id: "hidden-right", startTime: 5, endTime: 10, transitionType: "none" }),
    ];

    expect(getTransitionMarkers(clips, [track({ visible: false })], 10)).toEqual([]);
  });

  it("does not emit editable-looking markers on locked clip tracks", () => {
    const clips = [
      clip({ id: "locked-left", startTime: 0, endTime: 5, transitionType: "dissolve" }),
      clip({ id: "locked-right", startTime: 5, endTime: 10, transitionType: "none" }),
    ];

    expect(getTransitionMarkers(clips, [track({ locked: true })], 10)).toEqual([]);
  });
});

describe("getSceneTransitionMarkers", () => {
  it("emits a scene-kind marker at the scene END for each scene with a visual transition", () => {
    const scenes = [
      scene({ id: "s1", timelinePositionSeconds: 0, duration: 5, visualTransition: "crossfade" }),
      scene({ id: "s2", timelinePositionSeconds: 5, duration: 5, visualTransition: "none" }),
      scene({ id: "s3", timelinePositionSeconds: 10, duration: 5, visualTransition: null }),
    ];
    expect(getSceneTransitionMarkers(scenes, [track()], 10, (i) => sceneEnd(scenes[i]), (i) => scenes[i].timelinePositionSeconds ?? 0)).toEqual([
      {
        id: "s1", kind: "scene", transitionType: "crossfade", worldX: 50, centerY: 132,
        durationSeconds: DEFAULT_TRANSITION_DURATION,
        widthPx: TRANSITION_MARKER_SIZE,
        maxDurationSeconds: 5,
      },
    ]);
  });

  it("does not emit a marker for a transition on the last scene", () => {
    const scenes = [
      scene({ id: "s1", timelinePositionSeconds: 0, duration: 5, visualTransition: "none" }),
      scene({ id: "last", timelinePositionSeconds: 5, duration: 5, visualTransition: "crossfade" }),
    ];

    expect(getSceneTransitionMarkers(scenes, [track()], 10, (i) => sceneEnd(scenes[i]), (i) => scenes[i].timelinePositionSeconds ?? 0)).toEqual([]);
  });

  it("does not emit markers on hidden scene tracks", () => {
    const scenes = [
      scene({ id: "hidden-left", timelinePositionSeconds: 0, duration: 5, visualTransition: "crossfade" }),
      scene({ id: "hidden-right", timelinePositionSeconds: 5, duration: 5, visualTransition: "none" }),
    ];

    expect(getSceneTransitionMarkers(scenes, [track({ visible: false })], 10, (i) => sceneEnd(scenes[i]), (i) => scenes[i].timelinePositionSeconds ?? 0)).toEqual([]);
  });

  it("does not emit editable-looking markers on locked scene tracks", () => {
    const scenes = [
      scene({ id: "locked-left", timelinePositionSeconds: 0, duration: 5, visualTransition: "crossfade" }),
      scene({ id: "locked-right", timelinePositionSeconds: 5, duration: 5, visualTransition: "none" }),
    ];

    expect(getSceneTransitionMarkers(scenes, [track({ locked: true })], 10, (i) => sceneEnd(scenes[i]), (i) => scenes[i].timelinePositionSeconds ?? 0)).toEqual([]);
  });
});

describe("getTransitionJunctions", () => {
  it("returns every adjacent same-track cut with a validity flag", () => {
    const clips = [
      clip({ id: "c1", startTime: 0, endTime: 5 }),
      clip({ id: "c2", startTime: 5, endTime: 10 }),
      clip({ id: "c3", startTime: 10, endTime: 10.3 }),
      clip({ id: "gap", startTime: 15, endTime: 20 }),
    ];
    const junctions = getTransitionJunctions(clips, [track()], 10, 0.5);
    expect(junctions).toHaveLength(2);
    expect(junctions[0]).toMatchObject({ id: "c1", kind: "clip", worldX: 50, valid: true });
    // c2→c3 junction: c3 is only 0.3s long, shorter than the 0.5s minimum.
    expect(junctions[1]).toMatchObject({ id: "c2", kind: "clip", worldX: 100, valid: false });
  });

  it("returns scene junctions with validity", () => {
    const scenes = [
      scene({ id: "s1", timelinePositionSeconds: 0, duration: 5 }),
      scene({ id: "s2", timelinePositionSeconds: 5, duration: 0.3 }),
      scene({ id: "s3", timelinePositionSeconds: 5.3, duration: 5 }),
    ];
    const junctions = getSceneTransitionJunctions(
      scenes, [track()], 10, 0.5,
      (i) => sceneEnd(scenes[i]),
      (i) => scenes[i].timelinePositionSeconds ?? 0,
    );
    expect(junctions).toHaveLength(2);
    expect(junctions[0]).toMatchObject({ id: "s1", kind: "scene", valid: false }); // s2 too short
    expect(junctions[1]).toMatchObject({ id: "s2", kind: "scene", valid: false }); // s2 too short
  });
});

describe("hitTransitionEdge", () => {
  const wide = {
    id: "c1", kind: "clip" as const, transitionType: "dissolve",
    worldX: 100, centerY: 132, durationSeconds: 4, widthPx: 40, maxDurationSeconds: 5,
  };
  const small = { ...wide, id: "c2", worldX: 300, durationSeconds: 0.5, widthPx: TRANSITION_MARKER_SIZE };

  it("hits the left/right ends of a wide transition", () => {
    expect(hitTransitionEdge([wide], 100 - 20, 132)).toMatchObject({ edge: "left" });
    expect(hitTransitionEdge([wide], 100 + 19, 132)).toMatchObject({ edge: "right" });
    expect(hitTransitionEdge([wide], 100, 132)).toBeNull(); // center = body, not edge
  });

  it("has no edge zones on an UNSELECTED minimum-size marker", () => {
    expect(hitTransitionEdge([small], 300 - TRANSITION_MARKER_SIZE / 2, 132)).toBeNull();
  });

  it("exposes OUTER edge zones on a selected minimum-size marker", () => {
    const selected = { kind: "clip" as const, id: "c2" };
    const half = TRANSITION_MARKER_SIZE / 2;
    // Just outside the left end.
    expect(hitTransitionEdge([small], 300 - half - 3, 132, selected)).toMatchObject({ edge: "left" });
    // Just outside the right end.
    expect(hitTransitionEdge([small], 300 + half + 3, 132, selected)).toMatchObject({ edge: "right" });
    // Center stays the selectable body.
    expect(hitTransitionEdge([small], 300, 132, selected)).toBeNull();
    // Not selected → no outer zones.
    expect(hitTransitionEdge([small], 300 - half - 3, 132, { kind: "clip", id: "other" })).toBeNull();
  });
});

describe("hitTransitionMarker", () => {
  const markers = [
    { id: "c1", kind: "clip" as const, transitionType: "dissolve", worldX: 50, centerY: 132, durationSeconds: 0.5, widthPx: TRANSITION_MARKER_SIZE, maxDurationSeconds: 5 },
    { id: "s1", kind: "scene" as const, transitionType: "crossfade", worldX: 120, centerY: 132, durationSeconds: 0.5, widthPx: TRANSITION_MARKER_SIZE, maxDurationSeconds: 5 },
  ];

  it("returns the marker (id + kind) under the centered square", () => {
    expect(hitTransitionMarker(markers, 50, 132)).toMatchObject({ id: "c1", kind: "clip" });
    expect(hitTransitionMarker(markers, 120, 132)).toMatchObject({ id: "s1", kind: "scene" });
  });

  it("misses outside the square", () => {
    expect(hitTransitionMarker(markers, 50, 132 + TRANSITION_MARKER_SIZE)).toBeNull();
    expect(hitTransitionMarker([], 50, 132)).toBeNull();
  });
});

describe("hasTransitionMarker", () => {
  const markers = [
    { id: "clip-a", kind: "clip" as const, transitionType: "dissolve", worldX: 50, centerY: 132, durationSeconds: 0.5, widthPx: TRANSITION_MARKER_SIZE, maxDurationSeconds: 5 },
    { id: "scene-a", kind: "scene" as const, transitionType: "crossfade", worldX: 120, centerY: 132, durationSeconds: 0.5, widthPx: TRANSITION_MARKER_SIZE, maxDurationSeconds: 5 },
  ];

  it("recognizes when the selected transition still has a visible marker", () => {
    expect(hasTransitionMarker(markers, { kind: "clip", id: "clip-a" })).toBe(true);
    expect(hasTransitionMarker(markers, { kind: "scene", id: "scene-a" })).toBe(true);
  });

  it("rejects stale selections whose marker disappeared", () => {
    expect(hasTransitionMarker(markers, { kind: "clip", id: "missing" })).toBe(false);
    expect(hasTransitionMarker(markers, { kind: "scene", id: "clip-a" })).toBe(false);
    expect(hasTransitionMarker(markers, null)).toBe(false);
  });
});
