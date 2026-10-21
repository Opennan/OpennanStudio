// Timeline keyframe diamonds as hit targets (phase 10c): geometry, hit testing, retime snapping, and drawing.
import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../model/timeline";
import { getCursorForHit, hitDetect } from "./hit-detector";
import { hitKeyframeMarker, snapKeyframeTime } from "./keyframe-markers";
import { COLORS } from "./colors";
import { getKeyframeItemGeometry, KEYFRAME_MARKER_ACTIVE, renderTimeline } from "./timeline-renderer";
import type { CanvasState, DragState, SceneData, TrackLayoutEntry } from "./types";

const keyed = JSON.stringify({ keyframes: [{ time: 1, scale: 1.2 }, { time: 3, scale: 1 }] });

function clip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    id: "c1", projectId: "p", trackType: "video", trackIndex: 2, startTime: 2, endTime: 6, mediaUrl: null, mediaType: "uploaded",
    sceneId: null, label: null, thumbnailUrl: null, locked: false, volume: 1, audioPan: 0, audioPitch: 0, audioEq: "none",
    audioDenoise: false, audioNormalize: false, playbackSpeed: 1, speedRamp: "none", reversePlayback: false, freezeFrame: false,
    fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none", transitionDuration: 0, opacity: 1, scale: 1, positionX: 0.5,
    positionY: 0.5, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, brightness: 1,
    contrast: 1, saturation: 1, visualFilter: "none", motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false,
    chromaKeyColor: "#00ff00", chromaKeySimilarity: 0, chromaKeyBlend: 0, blendMode: "normal", mosaicStrength: 0, rotationDegrees: 0,
    keyframesJson: keyed, textContent: null, textStyle: null, trimStart: null, trimEnd: null,
    ...overrides,
  };
}

function scene(overrides: Partial<SceneData>): SceneData {
  return {
    id: "s1", order: 0, caption: "Scene", startTime: "0", endTime: "4", trackIndex: 1, startImageUrl: null, endImageUrl: null,
    videoUrl: null, status: "ready", transition: "none", duration: 4, timelinePositionSeconds: 0.001, frameConsistencyScore: null,
    audioUrl: null, audioText: null, cardConfig: null, keyframesJson: keyed,
    ...overrides,
  };
}

function track(key: string, type: string, index: number, y: number, extra: Partial<TrackLayoutEntry> = {}): TrackLayoutEntry {
  return { key, type, index, y, height: 64, track: null, locked: false, muted: false, visible: true, ...extra };
}

const tracks = [track("video-1", "video", 1, 0), track("video-2", "video", 2, 64)];

function state(overrides: Partial<CanvasState>): CanvasState {
  return {
    scenes: [], tracks, clips: [], selectedClipIds: new Set(), selectedSceneIds: new Set(), selectedSceneId: null,
    selectedAudioTarget: null, zoom: 20, scrollLeft: 0, currentTime: 0, totalDuration: 30, musicUrl: null, musicVolume: 1,
    snapEnabled: true, hoveredClipId: null, containerWidth: 800, containerHeight: 300, toolMode: "select", bladeX: null,
    unlockedVoiceovers: new Set(), voiceoverOffsets: new Map(),
    ...overrides,
  };
}

function idleDrag(): DragState {
  return {
    mode: "idle", clipId: null, originals: new Map(), startX: 0, startY: 0, currentX: 0, currentY: 0, snapTime: null, snapSource: null,
    snapEdge: null, snapDeltaTime: null, moveDeltaTime: null, resizeTime: null, targetTrackKey: null, committed: false, snapPoints: null,
  };
}

// Clip c1 (2..6 s on V2) at 20 px/s: x 40, w 80, y 20 + 64 + 2 = 86, h 60; diamonds at y 139, x 60 (1 s) and 100 (3 s).
const selectedClip = () => state({ clips: [clip({})], selectedClipIds: new Set(["c1"]) });

describe("getKeyframeItemGeometry", () => {
  it("gives the single selected clip's box, start, length, and keyframe times", () => {
    expect(getKeyframeItemGeometry(selectedClip())).toEqual({ clipId: "c1", start: 2, duration: 4, times: [1, 3], x: 40, y: 86, w: 80, h: 60 });
  });

  it("gives the selected scene when no clip is selected", () => {
    const geometry = getKeyframeItemGeometry(state({ scenes: [scene({})], selectedSceneId: "s1" }));
    expect(geometry).toMatchObject({ sceneId: "s1", duration: 4, times: [1, 3], y: 22, h: 60 });
    expect(geometry!.start).toBeCloseTo(0.001, 6);
  });

  it("has nothing for several clips, locked or hidden tracks, and items without keyframes", () => {
    expect(getKeyframeItemGeometry(state({ clips: [clip({}), clip({ id: "c2" })], selectedClipIds: new Set(["c1", "c2"]) }))).toBeNull();
    expect(getKeyframeItemGeometry(state({ clips: [clip({})], selectedClipIds: new Set(["c1"]), tracks: [tracks[0], track("video-2", "video", 2, 64, { locked: true })] }))).toBeNull();
    expect(getKeyframeItemGeometry(state({ clips: [clip({})], selectedClipIds: new Set(["c1"]), tracks: [tracks[0], track("video-2", "video", 2, 64, { visible: false })] }))).toBeNull();
    expect(getKeyframeItemGeometry(state({ clips: [clip({ locked: true })], selectedClipIds: new Set(["c1"]) }))).toBeNull();
    expect(getKeyframeItemGeometry(state({ clips: [clip({ keyframesJson: null })], selectedClipIds: new Set(["c1"]) }))).toBeNull();
  });
});

describe("hitKeyframeMarker", () => {
  it("hits a diamond within a generous box and picks the closest", () => {
    expect(hitKeyframeMarker(60, 139, selectedClip())).toEqual({ clipId: "c1", time: 1 });
    expect(hitKeyframeMarker(66, 146, selectedClip())).toEqual({ clipId: "c1", time: 1 });
    expect(hitKeyframeMarker(97, 133, selectedClip())).toEqual({ clipId: "c1", time: 3 });
    expect(hitKeyframeMarker(80, 139, selectedClip())).toBeNull();
    expect(hitKeyframeMarker(60, 120, selectedClip())).toBeNull();
  });

  it("follows the horizontal scroll", () => {
    expect(hitKeyframeMarker(20, 139, { ...selectedClip(), scrollLeft: 40 })).toEqual({ clipId: "c1", time: 1 });
  });

  it("hits scene diamonds", () => {
    const s = state({ scenes: [scene({})], selectedSceneId: "s1" });
    // Scene at 0.001 s: x ≈ 0.02, w 80, diamonds at x ≈ 20 and 60, y 22 + 60 - 7 = 75.
    expect(hitKeyframeMarker(20, 75, s)).toEqual({ sceneId: "s1", time: 1 });
  });
});

describe("hitDetect with keyframes", () => {
  it("prefers the selected item's diamond over the clip body and its trim edges", () => {
    expect(hitDetect(60, 139, selectedClip())).toEqual({ type: "keyframe", clipId: "c1", keyframeTime: 1, time: 3 });
    expect(hitDetect(60, 110, selectedClip())).toMatchObject({ type: "clip", clipId: "c1" });
    // A diamond near the edge wins over the resize zone.
    const nearEdge = state({ clips: [clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 0.25, scale: 1 }] }) })], selectedClipIds: new Set(["c1"]) });
    expect(hitDetect(45, 139, nearEdge)).toMatchObject({ type: "keyframe", keyframeTime: 0.25 });
  });

  it("ignores diamonds of unselected items and outside the select tool", () => {
    expect(hitDetect(60, 139, state({ clips: [clip({})] }))).toMatchObject({ type: "clip" });
    expect(hitDetect(60, 139, { ...selectedClip(), toolMode: "blade" })).toMatchObject({ type: "clip" });
  });

  it("shows a grab cursor over a diamond", () => {
    expect(getCursorForHit({ type: "keyframe", clipId: "c1", keyframeTime: 1, time: 3 }, false, "select")).toBe("grab");
  });
});

describe("snapKeyframeTime", () => {
  const base = { duration: 4, localPlayhead: null as number | null, zoom: 100, snapEnabled: true };

  it("snaps to the 30 fps grid and clamps into the item", () => {
    expect(snapKeyframeTime(1.01, base)).toEqual({ time: 1, snapped: "frame" });
    expect(snapKeyframeTime(1.02, base).time).toBeCloseTo(1.033, 3);
    expect(snapKeyframeTime(-1, base)).toEqual({ time: 0, snapped: "frame" });
    expect(snapKeyframeTime(9, base)).toEqual({ time: 4, snapped: "frame" });
    expect(snapKeyframeTime(3.99, { ...base, duration: 3.99 }).time).toBe(3.99);
  });

  it("snaps to the playhead within 8 px when snapping is on", () => {
    expect(snapKeyframeTime(2.05, { ...base, localPlayhead: 2.1234 })).toEqual({ time: 2.123, snapped: "playhead" });
    expect(snapKeyframeTime(2.0, { ...base, localPlayhead: 2.1234 }).snapped).toBe("frame");
    expect(snapKeyframeTime(2.05, { ...base, localPlayhead: 2.1234, snapEnabled: false }).snapped).toBe("frame");
    expect(snapKeyframeTime(3.98, { ...base, localPlayhead: 5 }).snapped).toBe("frame");
  });
});

describe("drawing the selected keyframe and the retime ghost", () => {
  function recorder() {
    const fills: string[] = [];
    const strokes: string[] = [];
    const texts: string[] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(obj, prop) {
        if (prop === "fill") return () => fills.push(String(obj.fillStyle));
        if (prop === "stroke") return () => strokes.push(String(obj.strokeStyle));
        if (prop === "fillText") return (text: string) => texts.push(text);
        if (prop === "measureText") return (text: string) => ({ width: text.length * 6 });
        if (prop === "createLinearGradient") return () => ({ addColorStop: () => undefined });
        if (prop in obj) return obj[prop as string];
        return () => undefined;
      },
      set(obj, prop, value) {
        obj[prop as string] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, fills, strokes, texts };
  }

  it("fills the selected diamond white with a ring", () => {
    const plain = recorder();
    renderTimeline(plain.ctx, { ...selectedClip(), currentTime: 0 }, idleDrag());
    const selected = recorder();
    renderTimeline(selected.ctx, { ...selectedClip(), currentTime: 0, selectedKeyframe: { clipId: "c1", time: 3 } }, idleDrag());
    expect(plain.fills.filter((f) => f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(0);
    expect(selected.fills.filter((f) => f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(1);
    expect(selected.strokes.filter((s) => s === COLORS.selectionRing).length).toBeGreaterThan(plain.strokes.filter((s) => s === COLORS.selectionRing).length);
  });

  it("rings the keyboard-focused diamond in the focus ring color (phase 10d)", () => {
    const plain = recorder();
    renderTimeline(plain.ctx, { ...selectedClip(), selectedKeyframe: { clipId: "c1", time: 3 } }, idleDrag());
    expect(plain.strokes).not.toContain(COLORS.focusRing);
    const focused = recorder();
    renderTimeline(focused.ctx, { ...selectedClip(), selectedKeyframe: { clipId: "c1", time: 3 }, focusedKeyframe: { clipId: "c1", time: 3 } }, idleDrag());
    expect(focused.strokes.filter((s) => s === COLORS.focusRing)).toHaveLength(1);
    // Another item's keyframe, or a time without a keyframe, draws no ring.
    const other = recorder();
    renderTimeline(other.ctx, { ...selectedClip(), focusedKeyframe: { clipId: "c2", time: 3 } }, idleDrag());
    expect(other.strokes).not.toContain(COLORS.focusRing);
    const missing = recorder();
    renderTimeline(missing.ctx, { ...selectedClip(), focusedKeyframe: { clipId: "c1", time: 2 } }, idleDrag());
    expect(missing.strokes).not.toContain(COLORS.focusRing);
  });

  it("shows a focused keyframe under the item's edge (not drawn otherwise) with its ring", () => {
    const edge = state({ clips: [clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 1 }, { time: 3, scale: 2 }] }) })], selectedClipIds: new Set(["c1"]) });
    const r = recorder();
    renderTimeline(r.ctx, { ...edge, currentTime: 9, selectedKeyframe: { clipId: "c1", time: 0 }, focusedKeyframe: { clipId: "c1", time: 0 } }, idleDrag());
    expect(r.fills.filter((f) => f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(1);
    expect(r.strokes.filter((s) => s === COLORS.focusRing)).toHaveLength(1);
  });

  it("reads the focus ring color from the --on-ring theme value", () => {
    expect(COLORS.focusRing).toBe("rgba(125, 211, 252, 0.4)");
  });

  it("draws a ghost diamond and the new time while a keyframe is dragged", () => {
    const r = recorder();
    renderTimeline(r.ctx, { ...selectedClip(), keyframeDrag: { clipId: "c1", from: 1, to: 2.5 } }, idleDrag());
    expect(r.fills.filter((f) => f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(1);
    expect(r.texts).toContain("2.50s");
  });
});
