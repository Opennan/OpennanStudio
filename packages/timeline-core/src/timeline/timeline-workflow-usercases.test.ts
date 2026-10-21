// User-case coverage for timeline workflows crossing canvas, properties, and backend sync boundaries.
import { describe, expect, it } from "vitest";
import { getEffectLayerDropPreview, getTransitionDropTarget } from "./canvas/hit-detector";
import type { CanvasState, TrackLayoutEntry } from "./canvas/types";


function track(entry: Pick<TrackLayoutEntry, "key" | "type" | "index" | "y" | "height">): TrackLayoutEntry {
  return {
    ...entry,
    track: null,
    locked: false,
    muted: false,
    visible: true,
  };
}

function state(tracks: TrackLayoutEntry[], overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    scenes: [],
    tracks,
    clips: [],
    selectedClipIds: new Set(),
    selectedSceneIds: new Set(),
    selectedSceneId: null,
    selectedAudioTarget: null,
    zoom: 10,
    scrollLeft: 0,
    currentTime: 0,
    totalDuration: 30,
    musicUrl: null,
    musicVolume: 1,
    snapEnabled: true,
    hoveredClipId: null,
    containerWidth: 800,
    containerHeight: 400,
    toolMode: "select",
    bladeX: null,
    unlockedVoiceovers: new Set(),
    voiceoverOffsets: new Map(),
    ...overrides,
  };
}

describe("timeline workflow user cases", () => {
  it("user drags an effect with no effects track and sees the new row above video where it will be created", () => {
    const preview = getEffectLayerDropPreview(120, state([
      track({ key: "video-1", type: "video", index: 1, y: 0, height: 64 }),
      track({ key: "audio-1", type: "audio", index: 1, y: 64, height: 44 }),
    ]));

    expect(preview).toMatchObject({
      y: 20,
      h: 40,
      trackIndex: 1,
      trackMissing: true,
      time: 12,
    });
  });

  it("user drags an effect over an existing effects track and does not see a fake new row", () => {
    const preview = getEffectLayerDropPreview(120, state([
      track({ key: "effect-1", type: "effect", index: 1, y: 0, height: 40 }),
      track({ key: "video-1", type: "video", index: 1, y: 40, height: 64 }),
      track({ key: "audio-1", type: "audio", index: 1, y: 104, height: 44 }),
    ]));

    expect(preview).toMatchObject({
      y: 20,
      h: 40,
      trackIndex: 1,
      trackMissing: false,
      time: 12,
    });
  });

  it("user drags a transition near a scene cut and gets no video placeholder from the audio row", () => {
    const canvasState = state([
      track({ key: "video-1", type: "video", index: 1, y: 0, height: 64 }),
      track({ key: "audio-1", type: "audio", index: 1, y: 64, height: 40 }),
    ], {
      scenes: [
        {
          id: "scene-left",
          order: 0,
          caption: "Left",
          startTime: "00:00:00,000",
          endTime: "00:00:05,000",
          timelinePositionSeconds: 0,
          trackIndex: 1,
          startImageUrl: null,
          endImageUrl: null,
          videoUrl: null,
          status: "ready",
          transition: "none",
          duration: 5,
          frameConsistencyScore: null,
          audioUrl: null,
          audioText: null,
          cardConfig: null,
        },
        {
          id: "scene-right",
          order: 1,
          caption: "Right",
          startTime: "00:00:05,000",
          endTime: "00:00:10,000",
          timelinePositionSeconds: 5,
          trackIndex: 1,
          startImageUrl: null,
          endImageUrl: null,
          videoUrl: null,
          status: "ready",
          transition: "none",
          duration: 5,
          frameConsistencyScore: null,
          audioUrl: null,
          audioText: null,
          cardConfig: null,
        },
      ],
    });

    expect(getTransitionDropTarget(50, 92, canvasState)).toBeNull();
  });

});
