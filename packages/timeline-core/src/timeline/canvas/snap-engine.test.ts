// Unit coverage for timeline snap target collection.
import { describe, expect, it } from "vitest";
import { collectSnapPoints, findSnapGuide, snapMove, snapResize } from "./snap-engine";
import type { CanvasState } from "./types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function baseState(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    scenes: [],
    tracks: [],
    clips: [],
    selectedClipIds: new Set(),
    selectedSceneIds: new Set(),
    selectedSceneId: null,
    selectedAudioTarget: null,
    zoom: 20,
    scrollLeft: 0,
    currentTime: 0,
    totalDuration: 20,
    musicUrl: null,
    musicVolume: 1,
    snapEnabled: true,
    hoveredClipId: null,
    containerWidth: 800,
    containerHeight: 240,
    toolMode: "select",
    bladeX: null,
    unlockedVoiceovers: new Set(),
    voiceoverOffsets: new Map(),
    ...overrides,
  };
}

describe("collectSnapPoints", () => {
  it("uses cached keyframe parsing while collecting repeated snap targets", () => {
    const source = readFileSync(resolve(__dirname, "snap-engine.ts"), "utf8");

    expect(source).toContain("import { getCachedClipKeyframeTimes } from \"./timeline-json-cache\";");
    expect(source).toContain("for (const localTime of getCachedClipKeyframeTimes(clip.keyframesJson, clip.endTime - clip.startTime))");
    expect(source).not.toContain("JSON.parse(keyframesJson)");
  });

  it("uses same-track legacy starts for scene snap targets on V2", () => {
    const points = collectSnapPoints(
      baseState({
        scenes: [
          {
            id: "v1-first",
            order: 0,
            caption: "V1 first",
            startTime: "0",
            endTime: "5",
            trackIndex: 1,
            timelinePositionSeconds: 0,
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
            id: "v2-first",
            order: 1,
            caption: "V2 first",
            startTime: "0",
            endTime: "6",
            trackIndex: 2,
            timelinePositionSeconds: 0,
            startImageUrl: null,
            endImageUrl: null,
            videoUrl: null,
            status: "ready",
            transition: "none",
            duration: 6,
            frameConsistencyScore: null,
            audioUrl: null,
            audioText: null,
            cardConfig: null,
          },
          {
            id: "v2-second",
            order: 2,
            caption: "V2 second",
            startTime: "0",
            endTime: "6",
            trackIndex: 2,
            timelinePositionSeconds: 0,
            startImageUrl: null,
            endImageUrl: null,
            videoUrl: null,
            status: "ready",
            transition: "none",
            duration: 6,
            frameConsistencyScore: null,
            audioUrl: null,
            audioText: null,
            cardConfig: null,
          },
        ],
      }),
      new Set(),
    );

    expect(points).toEqual(expect.arrayContaining([
      { time: 0, source: "scene-boundary" },
      { time: 6, source: "scene-boundary" },
      { time: 12, source: "scene-boundary" },
    ]));
    expect(points).not.toContainEqual({ time: 11, source: "scene-boundary" });
    expect(points).not.toContainEqual({ time: 17, source: "scene-boundary" });
  });

  it("includes timeline markers as snap targets", () => {
    const points = collectSnapPoints(
      baseState({
        markers: [
          { id: "marker-1", time: 4.25, label: "Beat" }, // i18n-ignore
          { id: "marker-2", time: 7.5, label: "Cut" }, // i18n-ignore
        ],
      }),
      new Set(),
    );

    expect(points).toEqual(
      expect.arrayContaining([
        { time: 4.25, source: "marker" },
        { time: 7.5, source: "marker" },
      ]),
    );
  });

  it("includes non-dragged clip keyframes as absolute snap targets", () => {
    const points = collectSnapPoints(
      baseState({
        clips: [
          {
            id: "clip-1",
            startTime: 10,
            endTime: 15,
            keyframesJson: JSON.stringify({ keyframes: [{ time: 0 }, { time: 2.5 }, { time: 7 }] }),
          },
          {
            id: "dragged",
            startTime: 20,
            endTime: 25,
            keyframesJson: JSON.stringify([{ time: 1 }]),
          },
        ] as CanvasState["clips"],
      }),
      new Set(["dragged"]),
    );

    expect(points).toEqual(
      expect.arrayContaining([
        { time: 10, source: "clip-keyframe" },
        { time: 12.5, source: "clip-keyframe" },
      ]),
    );
    expect(points).not.toContainEqual({ time: 17, source: "clip-keyframe" });
    expect(points).not.toContainEqual({ time: 21, source: "clip-keyframe" });
  });
});

describe("findSnapGuide", () => {
  it("returns the closest snap target with its source and distance", () => {
    const guide = findSnapGuide(
      4.08,
      [
        { time: 3.95, source: "clip-end" },
        { time: 4.1, source: "marker" },
      ],
      100,
      8,
    );

    expect(guide).toEqual({
      time: 4.1,
      source: "marker",
      distanceSeconds: expect.closeTo(0.02, 5),
    });
  });
});

describe("snapMove", () => {
  it("reports which dragged edge snapped and what target source it used", () => {
    const result = snapMove(
      10,
      14,
      1.95,
      [
        { time: 11.9, source: "clip-start" },
        { time: 15.95, source: "playhead" },
      ],
      100,
      8,
    );

    expect(result.deltaTime).toBeCloseTo(1.95);
    expect(result).toMatchObject({
      snapTime: 15.95,
      snapSource: "playhead",
      snapEdge: "end",
    });
  });
});

describe("snapResize", () => {
  it("reports the source of the resize snap target", () => {
    const result = snapResize(
      8.05,
      [
        { time: 8, source: "marker" },
        { time: 8.2, source: "clip-end" },
      ],
      100,
      8,
    );

    expect(result).toEqual({
      time: 8,
      snapTime: 8,
      snapSource: "marker",
    });
  });
});

describe("snap to beats (phase 11)", () => {
  const music = {
    id: "m", projectId: "p", trackType: "audio", trackIndex: 2, startTime: 4, endTime: 8, mediaUrl: "https://x/m.mp3", mediaType: "audio", sceneId: null, label: null,
    thumbnailUrl: null, locked: false, volume: 1, audioPan: 0, audioPitch: 0, audioEq: "none", audioDenoise: false, audioNormalize: false, playbackSpeed: 1,
    speedRamp: "none", reversePlayback: false, freezeFrame: false, fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none", transitionDuration: 0,
    opacity: 1, scale: 1, positionX: 0.5, positionY: 0.5, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
    brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false, chromaKeyColor: "0x00FF00",
    chromaKeySimilarity: 0.1, chromaKeyBlend: 0, blendMode: "normal", mosaicStrength: 0, rotationDegrees: 0, keyframesJson: null, textContent: null, textStyle: null,
    trimStart: 0, trimEnd: null, beatsJson: "[0.5,1.5,2.5]",
  } as CanvasState["clips"][number];
  const beats = (state: CanvasState, exclude = new Set<string>()) => collectSnapPoints(state, exclude).filter((p) => p.source === "beat").map((p) => p.time);

  it("adds the audio clips' beats only while snap to beats is on", () => {
    expect(beats(baseState({ clips: [music] }))).toEqual([]);
    expect(beats(baseState({ clips: [music], snapToBeats: true }))).toEqual([4.5, 5.5, 6.5]);
    expect(beats(baseState({ clips: [music], snapToBeats: true, beatTimes: [1, 2] }))).toEqual([1, 2]);
  });

  it("does not snap a dragged music clip to its own beats", () => {
    expect(beats(baseState({ clips: [music], snapToBeats: true, beatTimes: [4.5] }), new Set(["m"]))).toEqual([]);
  });

  it("finds a beat within the threshold", () => {
    const points = collectSnapPoints(baseState({ clips: [music], snapToBeats: true, currentTime: 100 }), new Set());
    expect(findSnapGuide(5.52, points, 20)).toMatchObject({ time: 5.5, source: "beat" });
  });

  it("labels the beat guide", () => {
    const source = readFileSync(resolve(__dirname, "timeline-renderer.ts"), "utf8");
    expect(source).toContain('"beat": "Beat"');
  });
});
