// Unit tests for canvas timeline hit detection and cursor affordances.
import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../model/timeline";
import { getCursorForHit, getEffectLayerDropPreview, getTransitionDropTarget, hitDetect } from "./hit-detector";
import type { CanvasState, SceneData, TrackLayoutEntry } from "./types";

const makeClip = (
  clip: Pick<TimelineClip, "id" | "trackType" | "trackIndex" | "startTime" | "endTime">
    & Partial<Pick<TimelineClip, "locked">>,
): TimelineClip => ({
  id: clip.id,
  projectId: "project-1",
  trackType: clip.trackType,
  trackIndex: clip.trackIndex,
  startTime: clip.startTime,
  endTime: clip.endTime,
  mediaUrl: null,
  mediaType: "uploaded",
  sceneId: null,
  label: null,
  thumbnailUrl: null,
  locked: clip.locked ?? false,
  volume: 1,
  audioPan: 0,
  audioPitch: 0,
  audioEq: "none",
  audioDenoise: false,
  audioNormalize: false,
  playbackSpeed: 1,
  speedRamp: "none",
  reversePlayback: false,
  freezeFrame: false,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  transitionType: "none",
  transitionDuration: 0,
  opacity: 1,
  scale: 1,
  positionX: 0.5,
  positionY: 0.5,
  horizontalFlip: false,
  verticalFlip: false,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  visualFilter: "none",
  motionPreset: "none",
  blurStrength: 0,
  chromaKeyEnabled: false,
  chromaKeyColor: "#00ff00",
  chromaKeySimilarity: 0,
  chromaKeyBlend: 0,
  blendMode: "normal",
  mosaicStrength: 0,
  rotationDegrees: 0,
  keyframesJson: null,
  textContent: null,
  textStyle: null,
  trimStart: null,
  trimEnd: null,
});

const makeState = (clips: TimelineClip[], tracks: TrackLayoutEntry[]): CanvasState => ({
  scenes: [],
  tracks,
  clips,
  selectedClipIds: new Set(),
  selectedSceneIds: new Set(),
  selectedSceneId: null,
  selectedAudioTarget: null,
  zoom: 10,
  scrollLeft: 0,
  currentTime: 50,
  totalDuration: 60,
  musicUrl: null,
  musicVolume: 1,
  snapEnabled: true,
  hoveredClipId: null,
  containerWidth: 800,
  containerHeight: 300,
  toolMode: "select",
  bladeX: null,
  unlockedVoiceovers: new Set(),
  voiceoverOffsets: new Map(),
});

const makeScene = (
  scene: Pick<SceneData, "id" | "order" | "duration" | "timelinePositionSeconds">
    & Partial<Pick<SceneData, "cardConfig" | "cardType" | "sourceVideoUrl" | "trackIndex" | "videoUrl" | "visualTransition" | "visualTransitionDuration">>,
): SceneData => ({
  id: scene.id,
  order: scene.order,
  caption: scene.id,
  startTime: "0",
  endTime: String(scene.duration ?? 5),
  timelinePositionSeconds: scene.timelinePositionSeconds,
  trackIndex: scene.trackIndex ?? 1,
  startImageUrl: null,
  endImageUrl: null,
  videoUrl: scene.videoUrl ?? null,
  sourceVideoUrl: scene.sourceVideoUrl ?? null,
  status: "ready",
  transition: "none",
  visualTransition: scene.visualTransition ?? null,
  visualTransitionDuration: scene.visualTransitionDuration ?? null,
  cardType: scene.cardType ?? null,
  duration: scene.duration,
  frameConsistencyScore: null,
  audioUrl: null,
  audioText: null,
  cardConfig: scene.cardConfig ?? null,
});

describe("hitDetect", () => {
  it("uses half-open clip body bounds so an exact cut hits the incoming adjacent clip", () => {
    const state = makeState(
      [
        makeClip({ id: "outgoing", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5 }),
        makeClip({ id: "incoming", trackType: "audio", trackIndex: 2, startTime: 5, endTime: 10 }),
      ],
      [
        {
          key: "audio-2",
          type: "audio",
          index: 2,
          y: 0,
          height: 64,
          track: null,
          locked: false,
          muted: false,
          visible: true,
        },
      ],
    );

    expect(hitDetect(50, 30, state)).toEqual({
      type: "resize-left",
      clipId: "incoming",
      time: 5,
    });
  });

  it("keeps clips under the playhead clickable instead of returning the playhead grab", () => {
    const state = {
      ...makeState(
        [makeClip({ id: "clip-1", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 10 })],
        [{ key: "audio-2", type: "audio", index: 2, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
      ),
      currentTime: 5, // playhead at worldX 50, over the middle of clip-1
    };
    expect(hitDetect(50, 50, state)).toEqual({ type: "clip", clipId: "clip-1", time: 5 });
  });

  it("returns the playhead grab over empty timeline area near the playhead", () => {
    const state = {
      ...makeState(
        [makeClip({ id: "clip-1", trackType: "audio", trackIndex: 2, startTime: 20, endTime: 30 })],
        [{ key: "audio-2", type: "audio", index: 2, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
      ),
      currentTime: 5,
    };
    expect(hitDetect(50, 50, state)).toEqual({ type: "ruler", time: 5 });
  });

  const transitionState = () =>
    makeState(
      [
        { ...makeClip({ id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }), transitionType: "dissolve" },
        makeClip({ id: "incoming", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 }),
      ],
      [{ key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
    );

  it("returns a transition hit when clicking the bowtie marker at a clip's cut center", () => {
    // cut at worldX 50 (endTime 5 * zoom 10); track center localY 32 → canvasY 52.
    expect(hitDetect(50, 52, transitionState())).toEqual({ type: "transition", clipId: "outgoing", time: 5 });
  });

  it("does not hit the transition marker near the clip's top edge (resize still works there)", () => {
    // canvasY 24 → localY 4, far above the centered marker → falls through to resize.
    expect(hitDetect(50, 24, transitionState())).toEqual({ type: "resize-left", clipId: "incoming", time: 5 });
  });

  it("uses half-open scene bounds so an exact cut hits the incoming adjacent scene", () => {
    const state = {
      ...makeState([], [
        {
          key: "video-1",
          type: "video",
          index: 1,
          y: 0,
          height: 64,
          track: null,
          locked: false,
          muted: false,
          visible: true,
        },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "incoming", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    // Edge zones only engage on a SELECTED scene (fast flicks on unselected
    // scenes must move, not stretch) — so select "incoming" first.
    const selectedState = { ...state, selectedSceneId: "incoming" };
    expect(hitDetect(50, 30, selectedState)).toEqual({
      type: "resize-left",
      sceneId: "incoming",
      time: 5,
    });
    // Unselected: the same point is a plain move/select hit.
    expect(hitDetect(50, 30, state)).toEqual({
      type: "scene",
      sceneId: "incoming",
      time: 5,
    });
  });

  it("does not hit scenes on hidden video tracks", () => {
    const state = {
      ...makeState([], [
        {
          key: "video-1",
          type: "video",
          index: 1,
          y: 0,
          height: 64,
          track: null,
          locked: false,
          muted: false,
          visible: false,
        },
      ]),
      scenes: [
        makeScene({ id: "hidden-scene", order: 0, duration: 5, timelinePositionSeconds: 0 }),
      ],
    };

    expect(hitDetect(20, 30, state)).toBeNull();
  });

  it("does not select a stale DB transition marker on the final scene", () => {
    const state = {
      ...makeState([], [
        {
          key: "video-1",
          type: "video",
          index: 1,
          y: 0,
          height: 64,
          track: null,
          locked: false,
          muted: false,
          visible: true,
        },
      ]),
      scenes: [
        makeScene({ id: "first", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "last", order: 1, duration: 5, timelinePositionSeconds: 5, visualTransition: "crossfade" }),
      ],
    };

    expect(hitDetect(100, 52, state)).not.toMatchObject({ type: "transition", sceneId: "last" });
  });

  it("uses same-track legacy scene starts when hit-testing V2 scenes before migration", () => {
    const state = {
      ...makeState([], [
        {
          key: "video-2",
          type: "video",
          index: 2,
          y: 0,
          height: 64,
          track: null,
          locked: false,
          muted: false,
          visible: true,
        },
        {
          key: "video-1",
          type: "video",
          index: 1,
          y: 64,
          height: 64,
          track: null,
          locked: false,
          muted: false,
          visible: true,
        },
      ]),
      scenes: [
        makeScene({ id: "v1-first", order: 0, duration: 5, timelinePositionSeconds: 0, trackIndex: 1 }),
        makeScene({ id: "v2-first", order: 1, duration: 4, timelinePositionSeconds: 0, trackIndex: 2 }),
        makeScene({ id: "v2-second", order: 2, duration: 4, timelinePositionSeconds: 0, trackIndex: 2 }),
      ],
    };

    expect(hitDetect(20, 30, state)).toEqual({
      type: "scene",
      sceneId: "v2-first",
      time: 2,
    });
  });

  it("skips locked clips when resolving editable track hit targets", () => {
    const state = makeState(
      [
        makeClip({ id: "editable", trackType: "audio", trackIndex: 2, startTime: 2, endTime: 8 }),
        makeClip({ id: "locked", trackType: "audio", trackIndex: 2, startTime: 4, endTime: 9, locked: true }),
      ],
      [
        {
          key: "audio-2",
          type: "audio",
          index: 2,
          y: 0,
          height: 64,
          track: null,
          locked: false,
          muted: false,
          visible: true,
        },
      ],
    );

    expect(hitDetect(50, 30, state)).toEqual({
      type: "clip",
      clipId: "editable",
      time: 5,
    });
  });
});

describe("getTransitionDropTarget", () => {
  it("targets the outgoing clip when a transition is dropped on an adjacent clip cut", () => {
    const state = makeState(
      [
        makeClip({ id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }),
        makeClip({ id: "incoming", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 }),
      ],
      [{ key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
    );

    expect(getTransitionDropTarget(50, 52, state)).toEqual({
      type: "transition",
      clipId: "outgoing",
      trackKey: "video-1",
      time: 5,
    });
  });

  it("prefers an adjacent video clip cut over a scene cut at the same time", () => {
    const state = {
      ...makeState(
        [
          makeClip({ id: "clip-out", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }),
          makeClip({ id: "clip-in", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 }),
        ],
        [{ key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
      ),
      scenes: [
        makeScene({ id: "scene-out", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "scene-in", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    expect(getTransitionDropTarget(50, 52, state)).toEqual({
      type: "transition",
      clipId: "clip-out",
      trackKey: "video-1",
      time: 5,
    });
  });

  it("targets the outgoing scene when a transition is dropped on an adjacent scene cut", () => {
    const state = {
      ...makeState([], [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "incoming", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    expect(getTransitionDropTarget(50, 52, state)).toEqual({
      type: "transition",
      sceneId: "outgoing",
      trackKey: "video-1",
      time: 5,
    });
  });

  it("snaps transition drops to a nearby adjacent clip cut instead of requiring exact center", () => {
    const state = makeState(
      [
        makeClip({ id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }),
        makeClip({ id: "incoming", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 }),
      ],
      [{ key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
    );

    expect(getTransitionDropTarget(68, 52, state)).toMatchObject({
      type: "transition",
      clipId: "outgoing",
      time: 5,
    });
  });

  it("keeps long scene transition drops usable when the cursor is near the visible cut", () => {
    const state = {
      ...makeState([], [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 13, timelinePositionSeconds: 0 }),
        makeScene({ id: "incoming", order: 1, duration: 13, timelinePositionSeconds: 13 }),
      ],
    };

    expect(getTransitionDropTarget(170, 52, state)).toEqual({
      type: "transition",
      sceneId: "outgoing",
      trackKey: "video-1",
      time: 13,
    });
  });

  it("does not project a video transition placeholder from the adjacent audio row", () => {
    const state = {
      ...makeState([], [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
        { key: "audio-1", type: "audio", index: 1, y: 64, height: 40, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "incoming", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    expect(getTransitionDropTarget(50, 92, state)).toBeNull();
  });

  it("does not target transition drops directly on adjacent audio clip cuts", () => {
    const state = makeState(
      [
        makeClip({ id: "audio-out", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 }),
        makeClip({ id: "audio-in", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 10 }),
      ],
      [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
        { key: "audio-1", type: "audio", index: 1, y: 64, height: 40, track: null, locked: false, muted: false, visible: true },
      ],
    );

    expect(getTransitionDropTarget(50, 92, state)).toBeNull();
  });

  it("does not project a video transition placeholder onto a far audio row", () => {
    const state = {
      ...makeState([], [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
        { key: "audio-1", type: "audio", index: 1, y: 180, height: 40, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "incoming", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    expect(getTransitionDropTarget(50, 220, state)).toBeNull();
  });

  it("targets the nearest video cut when dragging a transition over the effect row", () => {
    const state = {
      ...makeState([], [
        { key: "effect-1", type: "effect", index: 1, y: 0, height: 40, track: null, locked: false, muted: false, visible: true },
        { key: "video-1", type: "video", index: 1, y: 40, height: 64, track: null, locked: false, muted: false, visible: true },
        { key: "audio-1", type: "audio", index: 1, y: 104, height: 40, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "incoming", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    expect(getTransitionDropTarget(50, 40, state)).toEqual({
      type: "transition",
      sceneId: "outgoing",
      trackKey: "video-1",
      time: 5,
    });
  });

  it("does not attach transition drops to effect-layer clip cuts", () => {
    const state = makeState(
      [
        makeClip({ id: "effect-out", trackType: "effect", trackIndex: 1, startTime: 6, endTime: 8 }),
        makeClip({ id: "effect-in", trackType: "effect", trackIndex: 1, startTime: 8, endTime: 11 }),
      ],
      [
        { key: "effect-1", type: "effect", index: 1, y: 0, height: 40, track: null, locked: false, muted: false, visible: true },
        { key: "video-1", type: "video", index: 1, y: 40, height: 64, track: null, locked: false, muted: false, visible: true },
        { key: "audio-1", type: "audio", index: 1, y: 104, height: 40, track: null, locked: false, muted: false, visible: true },
      ],
    );

    expect(getTransitionDropTarget(80, 40, state)).toBeNull();
  });

  it("targets the trimmed source-video scene cut even when the outgoing DB duration is stale", () => {
    const state = {
      ...makeState([], [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({
          id: "source-left",
          order: 0,
          duration: 26,
          timelinePositionSeconds: 0,
          cardType: "source_clip",
          videoUrl: "https://cdn.example.test/source.mp4",
          sourceVideoUrl: "https://cdn.example.test/source.mp4",
          cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 12.9 }),
        }),
        makeScene({
          id: "source-right",
          order: 1,
          duration: 13.1,
          timelinePositionSeconds: 12.9,
          cardType: "source_clip",
          videoUrl: "https://cdn.example.test/source.mp4",
          sourceVideoUrl: "https://cdn.example.test/source.mp4",
          cardConfig: JSON.stringify({ timelineTrimStart: 12.9, timelineTrimEnd: 26 }),
        }),
      ],
    };

    expect(getTransitionDropTarget(129, 52, state)).toEqual({
      type: "transition",
      sceneId: "source-left",
      trackKey: "video-1",
      time: 12.9,
    });
  });

  it("does not target a transition drop on a clip body away from an adjacent cut", () => {
    const state = makeState(
      [
        makeClip({ id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }),
        makeClip({ id: "incoming", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 }),
      ],
      [{ key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
    );

    expect(getTransitionDropTarget(20, 52, state)).toBeNull();
  });

  it("does not target a transition drop at the end of the last clip", () => {
    const state = makeState(
      [
        makeClip({ id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }),
        makeClip({ id: "last", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 }),
      ],
      [{ key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
    );

    expect(getTransitionDropTarget(100, 52, state)).toBeNull();
  });

  it("does not target a transition drop on a scene body away from an adjacent cut", () => {
    const state = {
      ...makeState([], [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "incoming", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    expect(getTransitionDropTarget(20, 52, state)).toBeNull();
  });

  it("does not target a transition drop at the end of the last scene", () => {
    const state = {
      ...makeState([], [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
      ]),
      scenes: [
        makeScene({ id: "outgoing", order: 0, duration: 5, timelinePositionSeconds: 0 }),
        makeScene({ id: "last", order: 1, duration: 5, timelinePositionSeconds: 5 }),
      ],
    };

    expect(getTransitionDropTarget(100, 52, state)).toBeNull();
  });
});

describe("getEffectLayerDropPreview", () => {
  it("uses cursor time directly and shows a virtual effects row above video when no effect track exists", () => {
    const state = makeState(
      [],
      [{ key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true }],
    );

    expect(getEffectLayerDropPreview(80, state)).toEqual({
      x: 80,
      y: 20,
      w: 30,
      h: 40,
      trackIndex: 1,
      trackMissing: true,
      time: 8,
    });
  });

  it("places a missing effects row preview above video and below text tracks", () => {
    const state = makeState(
      [],
      [
        { key: "text-1", type: "text", index: 1, y: 0, height: 40, track: null, locked: false, muted: false, visible: true },
        { key: "video-1", type: "video", index: 1, y: 40, height: 64, track: null, locked: false, muted: false, visible: true },
        { key: "audio-1", type: "audio", index: 1, y: 104, height: 44, track: null, locked: false, muted: false, visible: true },
      ],
    );

    expect(getEffectLayerDropPreview(80, state)).toMatchObject({
      y: 60,
      h: 40,
      trackMissing: true,
    });
  });

  it("uses the real effects track when one already exists", () => {
    const state = makeState(
      [],
      [
        { key: "effect-1", type: "effect", index: 1, y: 40, height: 40, track: null, locked: false, muted: false, visible: true },
      ],
    );

    expect(getEffectLayerDropPreview(80, state)).toMatchObject({
      x: 80,
      y: 60,
      h: 40,
      trackMissing: false,
      time: 8,
    });
  });

  it("uses any visible editable effects track instead of only effect-1", () => {
    const state = makeState(
      [],
      [
        { key: "video-1", type: "video", index: 1, y: 0, height: 64, track: null, locked: false, muted: false, visible: true },
        { key: "effect-2", type: "effect", index: 2, y: 64, height: 40, track: null, locked: false, muted: false, visible: true },
      ],
    );

    expect(getEffectLayerDropPreview(80, state)).toMatchObject({
      y: 84,
      h: 40,
      trackIndex: 2,
      trackMissing: false,
      time: 8,
    });
  });

  it("uses the effect track under the cursor when multiple editable effect rows exist", () => {
    const state = makeState(
      [],
      [
        { key: "effect-1", type: "effect", index: 1, y: 0, height: 40, track: null, locked: false, muted: false, visible: true },
        { key: "effect-2", type: "effect", index: 2, y: 40, height: 40, track: null, locked: false, muted: false, visible: true },
        { key: "video-1", type: "video", index: 1, y: 80, height: 64, track: null, locked: false, muted: false, visible: true },
      ],
    );

    expect(getEffectLayerDropPreview(80, state, 90)).toMatchObject({
      y: 60,
      h: 40,
      trackIndex: 2,
      trackMissing: false,
      time: 8,
    });
  });

  it("treats hidden or locked effects tracks as missing so drops do not ghost into them", () => {
    const state = makeState(
      [],
      [
        { key: "effect-1", type: "effect", index: 1, y: 0, height: 40, track: null, locked: false, muted: false, visible: false },
        { key: "effect-2", type: "effect", index: 2, y: 40, height: 40, track: null, locked: true, muted: false, visible: true },
        { key: "video-1", type: "video", index: 1, y: 80, height: 64, track: null, locked: false, muted: false, visible: true },
      ],
    );

    expect(getEffectLayerDropPreview(80, state)).toMatchObject({
      y: 100,
      h: 40,
      trackIndex: 3,
      trackMissing: true,
      time: 8,
    });
  });
});

describe("getCursorForHit", () => {
  it("uses grab cursors for the hand timeline pan tool", () => {
    expect(getCursorForHit(null, false, "hand")).toBe("grab");
    expect(getCursorForHit({ type: "track-empty", trackKey: "video-1", time: 3 }, false, "hand")).toBe("grab");
    expect(getCursorForHit({ type: "clip", clipId: "clip-1", time: 3 }, false, "hand")).toBe("grab");
    expect(getCursorForHit({ type: "clip", clipId: "clip-1", time: 3 }, true, "hand")).toBe("grabbing");
  });
});
