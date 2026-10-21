// Unit coverage for canvas timeline rendering helpers.
import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../model/timeline";
import { getClipKeyframeMarkerTimes, getPreviousSameTrackEnd, getRemotionClipStatus, getSceneDuration, getSceneResizeBounds, KEYFRAME_MARKER_ACTIVE, planClipFilmstrip, planKeyframeMarkers, planSceneFilmstrip, renderTimeline, TRANSITION_MARKER_BG, TRANSITION_MARKER_BG_SELECTED } from "./timeline-renderer";
import { COLORS, getClipColors } from "./colors";
import type { CanvasState, DragState, SceneData, TrackLayoutEntry } from "./types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function clip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    id: "clip-1",
    projectId: "project-1",
    trackType: "video",
    trackIndex: 1,
    startTime: 10,
    endTime: 15,
    mediaUrl: null,
    mediaType: "uploaded",
    sceneId: null,
    label: null,
    thumbnailUrl: null,
    locked: false,
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
    brightness: 1,
    contrast: 1,
    saturation: 1,
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
    ...overrides,
  };
}

function scene(overrides: Partial<SceneData>): SceneData {
  return {
    id: "scene-1",
    order: 0,
    caption: "Scene",
    startTime: "00:00:00,000",
    endTime: "00:00:26,000",
    trackIndex: 1,
    startImageUrl: null,
    endImageUrl: null,
    videoUrl: null,
    status: "ready",
    transition: "none",
    duration: 26,
    frameConsistencyScore: null,
    audioUrl: null,
    audioText: null,
    cardConfig: null,
    ...overrides,
  };
}

function idleDrag(): DragState {
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

function track(
  entry: Pick<TrackLayoutEntry, "key" | "type" | "index" | "y" | "visible">
    & Partial<Pick<TrackLayoutEntry, "locked">>,
): TrackLayoutEntry {
  return {
    key: entry.key,
    type: entry.type,
    index: entry.index,
    y: entry.y,
    height: 64,
    track: null,
    locked: entry.locked ?? false,
    muted: false,
    visible: entry.visible,
  };
}

function state(overrides: Partial<CanvasState>): CanvasState {
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
    totalDuration: 10,
    musicUrl: null,
    musicVolume: 1,
    snapEnabled: true,
    hoveredClipId: null,
    containerWidth: 400,
    containerHeight: 180,
    toolMode: "select",
    bladeX: null,
    unlockedVoiceovers: new Set(),
    voiceoverOffsets: new Map(),
    ...overrides,
  };
}

function moveDrag(overrides: Partial<DragState>): DragState {
  return {
    ...idleDrag(),
    mode: "move",
    clipId: "clip-1",
    originals: new Map([
      ["clip-1", { startTime: 1, endTime: 5, trackType: "text", trackIndex: 1 }],
    ]),
    startX: 20,
    currentX: 40,
    committed: true,
    targetTrackKey: "text-2",
    ...overrides,
  };
}

function makeMockContext(): {
  ctx: CanvasRenderingContext2D;
  fillStyles: string[];
  textCalls: string[];
  textPositions: Array<{ text: string; x: number; y: number }>;
} {
  const fillStyles: string[] = [];
  const textCalls: string[] = [];
  const textPositions: Array<{ text: string; x: number; y: number }> = [];
  const gradient = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {};

  const ctx = new Proxy(target, {
    get(obj, prop) {
      if (prop === "fillText") {
        return (text: string, x = 0, y = 0) => {
          textCalls.push(text);
          textPositions.push({ text, x, y });
        };
      }
      if (prop === "fillRect") {
        return () => {
          fillStyles.push(String(obj.fillStyle));
        };
      }
      if (prop === "measureText") {
        return (text: string) => ({ width: text.length * 6 });
      }
      if (prop === "createLinearGradient") return () => gradient;
      if (prop in obj) return obj[prop as string];
      return () => undefined;
    },
    set(obj, prop, value) {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;

  return { ctx, fillStyles, textCalls, textPositions };
}

function timelineRendererSource(): string {
  return readFileSync(resolve(__dirname, "timeline-renderer.ts"), "utf8");
}

describe("timeline renderer shot parsing", () => {
  it("uses cached shot breakdown parsing in high-frequency canvas render paths", () => {
    const source = timelineRendererSource();

    expect(source).toContain("parseCachedShotBreakdown");
    expect(source).toContain("const shots = parseCachedShotBreakdown(scene.shotBreakdown);");
    expect(source).toContain("const shots: ShotEntry[] = parseCachedShotBreakdown(scene.shotBreakdown);");
    expect(source).toContain("const tgtShots = parseCachedShotBreakdown<ShotEntry>(hoverScene.shotBreakdown);");
    expect(source).not.toContain("const shots = parseShotBreakdown(scene.shotBreakdown);");
  });
});

describe("timeline renderer selection colors (monochrome theme)", () => {
  it("draws selected scenes, dragged scenes, and the active marker with the theme selection ring, not a hard-coded blue", () => {
    const source = timelineRendererSource();

    expect(source).not.toContain('"rgba(59, 130, 246, 1)"');
    expect(source).not.toContain('"rgba(59, 130, 246, 0.95)"');
    expect(source).not.toContain('"rgba(59, 130, 246, 0.6)"');
    expect(COLORS.selectionRing).toBe("rgba(255, 255, 255, 0.9)");
  });
});

describe("timeline renderer JSON parsing", () => {
  it("uses cached timeline JSON helpers in repeated canvas render paths", () => {
    const source = timelineRendererSource();

    expect(source).toContain("import { getCachedClipKeyframeTimes, parseCachedSceneCardConfig, parseCachedTextStyle } from \"./timeline-json-cache\";");
    expect(source).toContain("return getCachedClipKeyframeTimes(clip.keyframesJson, duration);");
    expect(source).toContain("const config = parseCachedSceneCardConfig(scene.cardConfig);");
    expect(source).toContain("const style = parseCachedTextStyle(clip.textStyle);");
    expect(source).not.toContain("JSON.parse(clip.keyframesJson)");
    expect(source).not.toContain("JSON.parse(scene.cardConfig)");
    expect(source).not.toContain("JSON.parse(clip.textStyle)");
  });

  it("draws caption and subtitle identity badges for text clips", () => {
    const source = timelineRendererSource();

    expect(source).toContain('import { getTimelineTextClipKind } from "../../lib/timeline-text-style";');
    expect(source).toContain('textKind === "caption" ? "CC" : "SUB"');
    expect(source).toContain('textKind === "caption" ? "#00849a"');
  });
});

describe("getSceneDuration", () => {
  it("uses source-clip timeline trim range instead of stale full-video duration", () => {
    expect(getSceneDuration(scene({
      cardType: "source_clip",
      videoUrl: "https://cdn.example.test/source.mp4",
      sourceVideoUrl: "https://cdn.example.test/source.mp4",
      duration: 26,
      cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 12.9 }),
    }))).toBeCloseTo(12.9, 5);

    expect(getSceneDuration(scene({
      cardType: "source_clip",
      videoUrl: "https://cdn.example.test/source.mp4",
      sourceVideoUrl: "https://cdn.example.test/source.mp4",
      duration: 13.1,
      cardConfig: JSON.stringify({ timelineTrimStart: 12.9, timelineTrimEnd: 26 }),
    }))).toBeCloseTo(13.1, 5);
  });
});

describe("getSceneResizeBounds", () => {
  it("clamps an AI-video scene with a generated video to its content length", () => {
    // Stretching a scene past its real footage froze the last frame and
    // corrupted the project duration — every scene playing fixed video clamps.
    const bounds = getSceneResizeBounds(scene({
      cardType: "ai_video",
      videoUrl: "https://cdn.example.test/generated.mp4",
      duration: 10,
      cardConfig: null,
    }), 20);
    expect(bounds.maxDuration).toBe(10);
  });

  it("still leaves scenes with no media unclamped", () => {
    const bounds = getSceneResizeBounds(scene({ cardType: "ai_video", videoUrl: null, duration: 10 }), 20);
    expect(bounds.maxDuration).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("getPreviousSameTrackEnd", () => {
  const scenes = [
    scene({ id: "s1", trackIndex: 1, duration: 10 }),
    scene({ id: "s2", trackIndex: 1, duration: 10 }),
  ];
  const starts = new Map([["s1", 0], ["s2", 10]]);
  const resolveStart = (s2: SceneData) => starts.get(s2.id) ?? 0;

  it("returns the previous same-track scene end so left-edge expand cannot overlap it", () => {
    expect(getPreviousSameTrackEnd(scenes, [], "s2", 10, 1, resolveStart, getSceneDuration)).toBe(10);
  });

  it("returns 0 when nothing sits before the scene", () => {
    expect(getPreviousSameTrackEnd(scenes, [], "s1", 0, 1, resolveStart, getSceneDuration)).toBe(0);
  });

  it("considers same-track video clips too", () => {
    const clips = [clip({ id: "v1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8 })];
    expect(getPreviousSameTrackEnd(scenes, clips, "s2", 10, 1, resolveStart, getSceneDuration)).toBe(10);
    expect(getPreviousSameTrackEnd([scenes[1]], clips, "s2", 10, 1, resolveStart, getSceneDuration)).toBe(8);
  });
});

describe("scene shot thumbnails", () => {
  const vTrack = track({ key: "video-1", type: "video", index: 1, y: 0, visible: true });

  it("draws ai-video storyboard panel crops per shot instead of the full storyboard sheet", () => {
    const { ctx } = makeMockContext();
    const requested: Array<{ url: string; time: number }> = [];
    const bitmap = { width: 160, height: 90 } as ImageBitmap;
    const s = scene({
      cardType: "ai_video",
      duration: 7,
      videoStoryboardRawUrl: "master-sheet.jpg",
      shotBreakdown: JSON.stringify([
        {
          shot_index: 0,
          duration: 4,
          ai_video_storyboards: [
            {
              panel_crops: {
                "0": "panel-0.jpg",
                "1": "panel-1.jpg",
              },
            },
          ],
        },
        { shot_index: 1, duration: 3 },
      ]),
    });

    renderTimeline(
      ctx,
      state({ tracks: [vTrack], scenes: [s], selectedSceneIds: new Set([s.id]), totalDuration: 7 }),
      idleDrag(),
      {
        get(url: string, time: number) {
          requested.push({ url, time });
          return bitmap;
        },
      },
    );

    expect(requested.map((entry) => entry.url)).toEqual(["panel-0.jpg", "panel-1.jpg"]);
  });

  it("uses reviewed copy-video panel crops before unrelated regenerated keyframes", () => {
    const { ctx } = makeMockContext();
    const requested: Array<{ url: string; time: number }> = [];
    const bitmap = { width: 160, height: 90 } as ImageBitmap;
    const s = scene({
      cardType: "copy_video",
      duration: 3,
      shotBreakdown: JSON.stringify([
        {
          shot_index: 6,
          duration: 3,
          panel_url: "real-human-shot-7.jpg",
          keyframe_url: "cartoon-keyframe-shot-7.jpg",
          copy_video_master_panel_crops: {
            "6": "real-human-crop-shot-7.jpg",
          },
        },
      ]),
    });

    renderTimeline(
      ctx,
      state({ tracks: [vTrack], scenes: [s], selectedSceneIds: new Set([s.id]), totalDuration: 3 }),
      idleDrag(),
      {
        get(url: string, time: number) {
          requested.push({ url, time });
          return bitmap;
        },
      },
    );

    expect(requested.map((entry) => entry.url)).toEqual(["real-human-crop-shot-7.jpg"]);
  });
});

describe("transition markers", () => {
  const vTrack = track({ key: "video-1", type: "video", index: 1, y: 0, visible: true });

  it("draws a marker badge for a clip that has a transition", () => {
    const { ctx, fillStyles } = makeMockContext();
    renderTimeline(
      ctx,
      state({
        tracks: [vTrack],
        clips: [
          clip({ id: "c1", startTime: 0, endTime: 5, transitionType: "dissolve" }),
          clip({ id: "c2", startTime: 5, endTime: 10 }),
        ],
      }),
      idleDrag(),
    );
    expect(fillStyles).toContain(TRANSITION_MARKER_BG);
    expect(fillStyles).not.toContain(TRANSITION_MARKER_BG_SELECTED);
  });

  it("uses the selected color when that transition is selected", () => {
    const { ctx, fillStyles } = makeMockContext();
    renderTimeline(
      ctx,
      state({
        tracks: [vTrack],
        clips: [
          clip({ id: "c1", startTime: 0, endTime: 5, transitionType: "dissolve" }),
          clip({ id: "c2", startTime: 5, endTime: 10 }),
        ],
        selectedTransition: { kind: "clip", id: "c1" },
      }),
      idleDrag(),
    );
    expect(fillStyles).toContain(TRANSITION_MARKER_BG_SELECTED);
  });

  it("draws nothing when no clip has a transition", () => {
    const { ctx, fillStyles } = makeMockContext();
    renderTimeline(ctx, state({ tracks: [vTrack], clips: [clip({ id: "c1", endTime: 5, transitionType: "none" })] }), idleDrag());
    expect(fillStyles).not.toContain(TRANSITION_MARKER_BG);
    expect(fillStyles).not.toContain(TRANSITION_MARKER_BG_SELECTED);
  });
});

describe("getClipKeyframeMarkerTimes", () => {
  it("normalizes sorted in-range local keyframe times from list or object payloads", () => {
    expect(getClipKeyframeMarkerTimes(clip({
      keyframesJson: JSON.stringify({
        keyframes: [
          { time: 4.5, opacity: 0.5 },
          { time: -1, opacity: 0.2 },
          { time: 1.25, scale: 1.5 },
          { time: 5.5, scale: 2 },
        ],
      }),
    }))).toEqual([1.25, 4.5]);

    expect(getClipKeyframeMarkerTimes(clip({
      keyframesJson: JSON.stringify([{ time: 3 }, { time: 0 }]),
    }))).toEqual([0, 3]);
  });

  it("ignores malformed keyframe payloads", () => {
    expect(getClipKeyframeMarkerTimes(clip({ keyframesJson: "{bad json" }))).toEqual([]);
    expect(getClipKeyframeMarkerTimes(clip({ keyframesJson: JSON.stringify({ items: [{ time: 1 }] }) }))).toEqual([]);
  });
});

describe("remotion graphics clips", () => {
  it("gives every track type in the timeline union its own clip color", () => {
    const trackTypes = ["video", "audio", "text", "sticker", "effect", "remotion"] as const;
    for (const type of trackTypes) {
      expect(COLORS[type]).toBeTruthy();
      expect(getClipColors(type)).toBe(COLORS[type]);
    }
    expect(getClipColors("remotion")).not.toBe(getClipColors("video"));
  });

  it("derives the chip status treatment only for remotion clips", () => {
    expect(getRemotionClipStatus(clip({ trackType: "remotion", remotionStatus: "generating" }))).toBe("generating");
    expect(getRemotionClipStatus(clip({ trackType: "remotion", remotionStatus: "error" }))).toBe("error");
    expect(getRemotionClipStatus(clip({ trackType: "remotion", remotionStatus: "ready" }))).toBeNull();
    expect(getRemotionClipStatus(clip({ trackType: "remotion" }))).toBeNull();
    expect(getRemotionClipStatus(clip({ trackType: "video", remotionStatus: "error" }))).toBeNull();
  });
});

describe("renderTimeline", () => {
  it("draws unmigrated V2 scenes from their own track start instead of after V1 scenes", () => {
    const { ctx, textPositions } = makeMockContext();

    renderTimeline(
      ctx,
      state({
        tracks: [
          track({ key: "video-2", type: "video", index: 2, y: 0, visible: true }),
          track({ key: "video-1", type: "video", index: 1, y: 64, visible: true }),
        ],
        scenes: [
          scene({ id: "v1-first", caption: "V1 first", order: 0, duration: 5, trackIndex: 1, timelinePositionSeconds: 0 }),
          scene({ id: "v2-first", caption: "V2 first", order: 1, duration: 6, trackIndex: 2, timelinePositionSeconds: 0 }),
          scene({ id: "v2-second", caption: "V2 second", order: 2, duration: 6, trackIndex: 2, timelinePositionSeconds: 0 }),
        ],
        totalDuration: 12,
      }),
      idleDrag(),
    );

    const v2FirstLabel = textPositions.find((call) => call.text === "V2 first");
    expect(v2FirstLabel?.x).toBe(3);
  });

  it("does not draw clips on hidden tracks", () => {
    const { ctx, textCalls } = makeMockContext();

    renderTimeline(
      ctx,
      state({
        tracks: [
          track({ key: "text-1", type: "text", index: 1, y: 0, visible: true }),
          track({ key: "text-2", type: "text", index: 2, y: 64, visible: false }),
        ],
        clips: [
          clip({ id: "visible", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5, label: "Visible" }), // i18n-ignore
          clip({ id: "hidden", trackType: "text", trackIndex: 2, startTime: 1, endTime: 5, label: "Hidden" }), // i18n-ignore
        ],
      }),
      idleDrag(),
    );

    expect(textCalls).toContain("Visible");
    expect(textCalls).not.toContain("Hidden");
  });

  it("does not draw A1 music or voiceovers when the A1 track is hidden", () => {
    const { ctx, textCalls } = makeMockContext();

    renderTimeline(
      ctx,
      state({
        tracks: [
          track({ key: "audio-1", type: "audio", index: 1, y: 0, visible: false }),
        ],
        musicUrl: "https://example.test/music.mp3",
        scenes: [
          {
            id: "scene-1",
            order: 0,
            caption: "Scene",
            startTime: "0",
            endTime: "5",
            trackIndex: 1,
            startImageUrl: null,
            endImageUrl: null,
            videoUrl: null,
            status: "ready",
            transition: "none",
            duration: 5,
            frameConsistencyScore: null,
            audioUrl: "https://example.test/voice.mp3",
            audioText: "Narration",
            cardConfig: null,
          },
        ],
      }),
      idleDrag(),
    );

    expect(textCalls).not.toContain("100%");
    expect(textCalls).not.toContain("\u266A");
    expect(textCalls).not.toContain("VO");
    expect(textCalls).not.toContain("Narration");
  });

  it("does not draw valid drop-zone highlights on hidden or locked target tracks", () => {
    for (const targetTrack of [
      track({ key: "text-2", type: "text", index: 2, y: 64, visible: false }),
      track({ key: "text-2", type: "text", index: 2, y: 64, visible: true, locked: true }),
    ]) {
      const { ctx, fillStyles } = makeMockContext();

      renderTimeline(
        ctx,
        state({
          tracks: [
            track({ key: "text-1", type: "text", index: 1, y: 0, visible: true }),
            targetTrack,
          ],
          clips: [
            clip({ id: "clip-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5, label: "Dragged" }), // i18n-ignore
          ],
        }),
        moveDrag({ targetTrackKey: "text-2" }),
      );

      expect(fillStyles).not.toContain("rgba(52, 211, 153, 0.15)");
      expect(fillStyles).not.toContain("rgba(52, 211, 153, 0.12)");
    }
  });

  it("keeps the dragged clip preview on its origin row when the target track is hidden or locked", () => {
    for (const targetTrack of [
      track({ key: "text-2", type: "text", index: 2, y: 64, visible: false }),
      track({ key: "text-2", type: "text", index: 2, y: 64, visible: true, locked: true }),
    ]) {
      const { ctx, textPositions } = makeMockContext();

      renderTimeline(
        ctx,
        state({
          tracks: [
            track({ key: "text-1", type: "text", index: 1, y: 0, visible: true }),
            targetTrack,
          ],
          clips: [
            clip({ id: "clip-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5, label: "Dragged" }), // i18n-ignore
          ],
        }),
        moveDrag({ targetTrackKey: "text-2" }),
      );

      const draggedLabel = textPositions.find((call) => call.text === "Dragged");
      expect(draggedLabel?.y).toBe(52);
    }
  });
});

describe("planClipFilmstrip", () => {
  it("returns null for non-video/sticker tracks", () => {
    expect(planClipFilmstrip(clip({ trackType: "audio", mediaUrl: "a.mp3" }), 400)).toBeNull();
    expect(planClipFilmstrip(clip({ trackType: "text" }), 400)).toBeNull();
  });

  it("returns null when the clip has no media or thumbnail", () => {
    expect(planClipFilmstrip(clip({ trackType: "video", mediaUrl: null, thumbnailUrl: null }), 400)).toBeNull();
  });

  it("plans a single frame at time 0 for image clips", () => {
    const plan = planClipFilmstrip(
      clip({ trackType: "sticker", mediaType: "image", mediaUrl: "sticker.png", thumbnailUrl: "thumb.png" }),
      400,
    );
    expect(plan).toEqual({ url: "thumb.png", isVideo: false, times: [0] });
  });

  it("treats .mp4 urls as video even when mediaType is generic", () => {
    const plan = planClipFilmstrip(
      clip({ trackType: "video", mediaType: "uploaded", mediaUrl: "https://cdn.test/clip.mp4", startTime: 0, endTime: 8 }),
      800,
    );
    expect(plan?.isVideo).toBe(true);
    expect(plan?.times.length).toBeGreaterThan(1);
  });

  it("samples more frames for wider clips and caps the count at 10", () => {
    const base = clip({ trackType: "video", mediaType: "video", mediaUrl: "v.mov", startTime: 0, endTime: 30, trimStart: null, trimEnd: null });
    const narrow = planClipFilmstrip(base, 60);
    const wide = planClipFilmstrip(base, 5000);
    expect(narrow?.times.length).toBe(1);
    expect(wide?.times.length).toBe(10);
  });

  it("samples within the trimmed source span and rounds to 2 decimals", () => {
    const plan = planClipFilmstrip(
      clip({ trackType: "video", mediaType: "video", mediaUrl: "v.mp4", startTime: 0, endTime: 4, trimStart: 10, trimEnd: 14 }),
      80,
    );
    // Single slice → midpoint of [10, 14] = 12.
    expect(plan?.times).toEqual([12]);
    // All sample times must fall inside the trimmed span.
    const wide = planClipFilmstrip(
      clip({ trackType: "video", mediaType: "video", mediaUrl: "v.mp4", startTime: 0, endTime: 4, trimStart: 10, trimEnd: 14 }),
      400,
    );
    for (const t of wide?.times ?? []) {
      expect(t).toBeGreaterThanOrEqual(10);
      expect(t).toBeLessThanOrEqual(14);
      expect(Math.round(t * 100) / 100).toBe(t);
    }
  });

  it("falls back to clip duration × playback speed when trim is missing", () => {
    const plan = planClipFilmstrip(
      clip({ trackType: "video", mediaType: "video", mediaUrl: "v.mp4", startTime: 0, endTime: 5, trimStart: null, trimEnd: null, playbackSpeed: 2 }),
      80,
    );
    // span = 5s * 2 = 10s, single slice midpoint = 5.
    expect(plan?.times).toEqual([5]);
  });
});

describe("planSceneFilmstrip", () => {
  it("prefers a still image (single frame at 0) when present", () => {
    const plan = planSceneFilmstrip(
      scene({ startImageUrl: "still.jpg", videoUrl: "v.mp4" }),
      [],
      0,
      600,
    );
    expect(plan).toEqual({ url: "still.jpg", isVideo: false, times: [0] });
  });

  it("samples the generated video for ai_video scenes with no still image", () => {
    // This is the regression: ai_video scenes only have videoUrl.
    const s = scene({ cardType: "ai_video", status: "video_ready", videoUrl: "gen.mp4", duration: 12 });
    const plan = planSceneFilmstrip(s, [s], 0, 600);
    expect(plan?.url).toBe("gen.mp4");
    expect(plan?.isVideo).toBe(true);
    expect(plan?.times.length).toBeGreaterThan(1);
    // Sample times must lie inside the scene's [0, duration] span.
    for (const t of plan?.times ?? []) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(12);
    }
  });

  it("uses the storyboard sheet as a still thumbnail when ai_video has no normal scene media", () => {
    const s = scene({
      cardType: "ai_video",
      status: "images_ready",
      videoUrl: null,
      startImageUrl: null,
      videoStoryboardRawUrl: "storyboard-clean.jpg",
      videoStoryboardUrl: "storyboard-captioned.jpg",
    });
    expect(planSceneFilmstrip(s, [s], 0, 600)).toEqual({
      url: "storyboard-clean.jpg",
      isVideo: false,
      times: [0],
    });
  });

  it("uses the generated video filmstrip instead of the storyboard sheet after ai_video completes", () => {
    const s = scene({
      cardType: "ai_video",
      status: "video_ready",
      videoUrl: "generated-scene.mp4",
      startImageUrl: null,
      videoStoryboardRawUrl: "storyboard-clean.jpg",
      videoStoryboardUrl: "storyboard-captioned.jpg",
      duration: 12,
    });
    const plan = planSceneFilmstrip(s, [s], 0, 600);
    expect(plan?.url).toBe("generated-scene.mp4");
    expect(plan?.isVideo).toBe(true);
  });

  it("returns null when the scene has neither a still image nor a video", () => {
    const s = scene({ cardType: "ai_video", videoUrl: null, startImageUrl: null });
    expect(planSceneFilmstrip(s, [s], 0, 600)).toBeNull();
  });

  it("falls back to the previous scene's end image on a continue transition", () => {
    const prev = scene({ id: "s0", endImageUrl: "prev-end.jpg" });
    const cur = scene({ id: "s1", transition: "continue", videoUrl: null, startImageUrl: null });
    const plan = planSceneFilmstrip(cur, [prev, cur], 1, 600);
    expect(plan).toEqual({ url: "prev-end.jpg", isVideo: false, times: [0] });
  });
});

describe("keyframe markers (phase 10b)", () => {
  /** Records the fill style of every path fill (the diamonds). */
  function pathFills(): { ctx: CanvasRenderingContext2D; fills: string[] } {
    const fills: string[] = [];
    const target: Record<string, unknown> = {};
    const ctx = new Proxy(target, {
      get(obj, prop) {
        if (prop === "fill") return () => fills.push(String(obj.fillStyle));
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
    return { ctx, fills };
  }
  const vTrack = track({ key: "video-1", type: "video", index: 1, y: 0, visible: true });
  const keyed = JSON.stringify({ keyframes: [{ time: 1, scale: 1.2 }, { time: 3, scale: 1 }] });

  it("places markers along the item and flags the one under the playhead (within a frame)", () => {
    expect(planKeyframeMarkers([1, 3], 4, 100, 80, null)).toEqual([{ cx: 120, active: false }, { cx: 160, active: false }]);
    expect(planKeyframeMarkers([1, 3], 4, 100, 80, 3.02).map((m) => m.active)).toEqual([false, true]);
    expect(planKeyframeMarkers([1, 3], 4, 100, 80, 2).map((m) => m.active)).toEqual([false, false]);
    // Markers under the item's edges are skipped.
    expect(planKeyframeMarkers([0, 4], 4, 100, 80, 0)).toEqual([]);
  });

  it("draws the selected scene's keyframes, the one under the playhead filled white", () => {
    const drawScene = (selected: boolean, currentTime: number) => {
      const { ctx, fills } = pathFills();
      renderTimeline(ctx, state({
        tracks: [vTrack],
        scenes: [scene({ id: "s1", duration: 4, trackIndex: 1, timelinePositionSeconds: 0.001, keyframesJson: keyed })],
        selectedSceneId: selected ? "s1" : null,
        currentTime,
      }), idleDrag());
      return fills;
    };
    expect(drawScene(true, 2).filter((f) => f === COLORS.marker)).toHaveLength(2);
    const atKeyframe = drawScene(true, 1.001);
    expect(atKeyframe.filter((f) => f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(1);
    expect(atKeyframe.filter((f) => f === COLORS.marker)).toHaveLength(1);
    expect(drawScene(false, 1).filter((f) => f === COLORS.marker || f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(0);
  });

  it("fills the selected clip's keyframe under the playhead white", () => {
    const draw = (selected: boolean) => {
      const { ctx, fills } = pathFills();
      renderTimeline(ctx, state({
        tracks: [vTrack],
        clips: [clip({ id: "c1", startTime: 2, endTime: 6, keyframesJson: keyed })],
        selectedClipIds: new Set(selected ? ["c1"] : []),
        currentTime: 5,
      }), idleDrag());
      return fills;
    };
    expect(draw(true).filter((f) => f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(1);
    expect(draw(false).filter((f) => f === KEYFRAME_MARKER_ACTIVE)).toHaveLength(0);
  });
});

describe("AI overlays (phase 11)", () => {
  const aTrack = track({ key: "audio-2", type: "audio", index: 2, y: 0, visible: true });
  const vTrack = track({ key: "video-1", type: "video", index: 1, y: 64, visible: true });

  it("plans beat dots inside the clip box, thinned when they crowd", async () => {
    const { planBeatDots } = await import("./timeline-renderer");
    const music = clip({ id: "m", trackType: "audio", trackIndex: 2, startTime: 2, endTime: 6, trimStart: 1, beatsJson: "[1,1.5,2,9]" });
    expect(planBeatDots(music, 20, 40, 80)).toEqual([40, 50, 60]);
    // At 4 px per second the 0.5 s beats are 2 px apart: every other one is kept.
    expect(planBeatDots(music, 4, 8, 16)).toEqual([8, 12]);
  });

  it("draws beat dots, AI progress lines, and cut preview ghosts with the theme tokens", () => {
    const { ctx, fillStyles } = makeMockContext();
    renderTimeline(
      ctx,
      state({
        tracks: [aTrack, vTrack],
        clips: [clip({ id: "m", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 8, beatsJson: "[1,2,3]", mediaUrl: "https://x/m.mp3" })],
        scenes: [scene({ id: "s1", duration: 5, videoUrl: "https://x/v.mp4" })],
        aiActivity: { s1: { progress: 0.5 }, m: {} },
        cutPreview: { kind: "silences", ranges: [{ start: 1, end: 2 }] },
      }),
      idleDrag(),
    );
    expect(fillStyles).toContain(COLORS.beatDot);
    expect(fillStyles).toContain(COLORS.aiProgress);
    expect(fillStyles).toContain(COLORS.aiProgressTrack);
    expect(fillStyles).toContain(COLORS.cutPreviewFill);
    expect(fillStyles).toContain(COLORS.cutPreviewBorder);
  });

  it("marks clips and scenes the AI just changed with an outline and an AI tag (phase 9b)", () => {
    const { ctx, fillStyles, textCalls } = makeMockContext();
    renderTimeline(
      ctx,
      state({
        tracks: [aTrack, vTrack],
        clips: [clip({ id: "m", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 8, mediaUrl: "https://x/m.mp3" })],
        scenes: [scene({ id: "s1", duration: 5, videoUrl: "https://x/v.mp4" })],
        aiActivity: { s1: { changed: true }, m: { changed: true } },
      }),
      idleDrag(),
    );
    expect(textCalls.filter((t) => t === "AI")).toHaveLength(2);
    expect(fillStyles).toContain(COLORS.aiChangedTag);
    // No progress line for a finished change.
    expect(fillStyles).not.toContain(COLORS.aiProgressTrack);
  });

  it("draws the overlays after the cached clip body", () => {
    const source = timelineRendererSource();
    const body = source.indexOf("drawClipBody(ctx, clip, x, y, w, h, isSelected, isHovered, waveformCache, thumbnailCache);");
    expect(body).toBeGreaterThan(0);
    expect(source.indexOf("drawBeatDots(ctx, clip, x, y, w, h, zoom);")).toBeGreaterThan(body);
  });
});
