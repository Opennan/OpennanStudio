// Behavior coverage for transition drops that mutate existing scene/clip state.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveEditorStore } from "../provider/registry";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { normalizeTimelineTransitionType } from "@opennan/timeline-core/lib/timeline-editing";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

type TestScene = {
  id: string;
  order: number;
  caption: string;
  startTime: string;
  endTime: string;
  startImageUrl: string | null;
  endImageUrl: string | null;
  videoUrl: string | null;
  status: string;
  transition: string;
  visualTransition?: string | null;
  visualTransitionDuration?: number | null;
  duration: number | null;
  frameConsistencyScore: number | null;
  audioUrl: string | null;
  audioText: string | null;
  cardConfig: string | null;
  timelinePositionSeconds?: number;
  trackIndex?: number;
};

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: ({
    onTrackDrop,
  }: {
    onTrackDrop?: (trackType: string, trackIndex: number, time: number, data: Record<string, unknown>) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => onTrackDrop?.("transition", 0, 5, {
          kind: "transition",
          transitionId: "crossfade",
          name: "Crossfade",
          sceneId: "scene-left",
        })}
      >
        drop transition on scene cut
      </button>
      <button
        type="button"
        onClick={() => onTrackDrop?.("transition", 0, 10, {
          kind: "transition",
          transitionId: "crossfade",
          name: "Crossfade",
          sceneId: "scene-last",
        })}
      >
        drop transition on last scene cut
      </button>
      <button
        type="button"
        onClick={() => onTrackDrop?.("transition", 0, 5, {
          kind: "transition",
          transitionId: "crossfade",
          name: "Crossfade",
          clipId: "clip-left",
        })}
      >
        drop transition on clip cut
      </button>
      <button
        type="button"
        onClick={() => onTrackDrop?.("transition", 0, 5, {
          kind: "transition",
          transitionId: "crossfade",
          name: "Crossfade",
          clipId: "locked-left",
        })}
      >
        drop transition on locked clip cut
      </button>
      <button
        type="button"
        onClick={() => onTrackDrop?.("transition", 0, 5, {
          kind: "transition",
          transitionId: "crossfade",
          name: "Crossfade",
          clipId: "audio-left",
        })}
      >
        drop transition on audio clip cut
      </button>
      <button
        type="button"
        onClick={() => onTrackDrop?.("transition", 0, 10, {
          kind: "transition",
          transitionId: "crossfade",
          name: "Crossfade",
          clipId: "clip-last",
        })}
      >
        drop transition on last clip cut
      </button>
    </>
  ),
}));

function track(type: TimelineTrack["type"], index: number): TimelineTrack {
  return {
    type,
    index,
    label: `${type[0]?.toUpperCase() || "T"}${index}`,
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  };
}

function scene(id: string, order: number, start: number): TestScene {
  return {
    id,
    order,
    caption: id,
    startTime: `00:00:${String(start).padStart(2, "0")},000`,
    endTime: `00:00:${String(start + 5).padStart(2, "0")},000`,
    timelinePositionSeconds: start,
    trackIndex: 1,
    startImageUrl: null,
    endImageUrl: null,
    videoUrl: null,
    status: "ready",
    transition: "none",
    visualTransition: "none",
    visualTransitionDuration: 0,
    duration: 5,
    frameConsistencyScore: null,
    audioUrl: null,
    audioText: null,
    cardConfig: null,
  };
}

function clip(id: string, startTime: number, endTime: number, overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id,
    projectId: "project-1",
    trackType: "video",
    trackIndex: 1,
    startTime,
    endTime,
    mediaUrl: null,
    mediaType: "video",
    sceneId: null,
    label: id,
    thumbnailUrl: null,
    locked: false,
    transitionType: "none",
    transitionDuration: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
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
    contrast: 1,
    saturation: 1,
    visualFilter: "none",
    motionPreset: "none",
    blurStrength: 0,
    chromaKeyEnabled: false,
    chromaKeyColor: "0x00FF00",
    chromaKeySimilarity: 0.1,
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

describe("NleTimeline transition drop behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveEditorStore().getState().resetForProject();
  });

  it("applies a scene transition drop without requiring clip creation capability", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], scenes: [scene("scene-left", 0, 0), scene("scene-right", 1, 5)] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on scene cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateScene").at(-1)?.args).toEqual(["project-1", "scene-left", { visualTransition: normalizeTimelineTransitionType("cross_dissolve"), visualTransitionDuration: Math.min(0.5, 5 / 2) }]);
    });
  });

  it("applies a scene transition drop between trimmed source-video scenes", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], scenes: [
      {
        ...scene("scene-left", 0, 0),
        duration: 26,
        cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 12.9 }),
      },
      {
        ...scene("scene-right", 1, 12.9),
        duration: 13.1,
        cardConfig: JSON.stringify({ timelineTrimStart: 12.9, timelineTrimEnd: 26 }),
      },
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on scene cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateScene").at(-1)?.args).toEqual(["project-1", "scene-left", { visualTransition: normalizeTimelineTransitionType("cross_dissolve"), visualTransitionDuration: Math.min(0.5, 12.9 / 2) }]);
    });
  });

  it("toolbar delete clears a selected scene transition without deleting media", async () => {
    getActiveEditorStore().getState().selectTransition({ kind: "scene", id: "scene-left" });

    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], scenes: [
      { ...scene("scene-left", 0, 0), visualTransition: "crossfade", visualTransitionDuration: 0.5 },
      scene("scene-right", 1, 5),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "deleteSelected (deleteShortcut)" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateScene").at(-1)?.args).toEqual(["project-1", "scene-left", { visualTransition: normalizeTimelineTransitionType("none"), visualTransitionDuration: 0 }]);
      expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
    });
  });

  it("toolbar delete ignores stale selected scene transitions on locked video tracks", async () => {
    getActiveEditorStore().getState().selectTransition({ kind: "scene", id: "scene-left" });

    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [{ ...track("video", 1), locked: true }, track("audio", 1)], scenes: [
      { ...scene("scene-left", 0, 0), visualTransition: "crossfade", visualTransitionDuration: 0.5 },
      scene("scene-right", 1, 5),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "deleteSelected (deleteShortcut)" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateScene")).toHaveLength(0);
      expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
    });
  });

  it("toolbar delete ignores stale selected scene transitions on final scenes", async () => {
    getActiveEditorStore().getState().selectTransition({ kind: "scene", id: "scene-last" });

    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], scenes: [
      scene("scene-left", 0, 0),
      { ...scene("scene-last", 1, 5), visualTransition: "crossfade", visualTransitionDuration: 0.5 },
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "deleteSelected (deleteShortcut)" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateScene")).toHaveLength(0);
      expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
    });
  });

  it("ignores scene transition drop payloads that reference the last scene", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], scenes: [scene("scene-left", 0, 0), scene("scene-last", 1, 5)] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on last scene cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateScene")).toHaveLength(0);
    });
  });

  it("ignores stale scene transition drop payloads on locked video tracks", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [{ ...track("video", 1), locked: true }, track("audio", 1)], scenes: [scene("scene-left", 0, 0), scene("scene-right", 1, 5)] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on scene cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateScene")).toHaveLength(0);
    });
  });

  it("toolbar delete clears a selected scene after deleting it", async () => {
    getActiveEditorStore().getState().selectScene("scene-left");

    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], scenes: [scene("scene-left", 0, 0), scene("scene-right", 1, 5)] });
    runtime.store.getState().selectScene("scene-left");
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "deleteSelected (deleteShortcut)" }));

    await waitFor(() => expect(runtime.recording.callsTo("deleteScene")[0].args).toEqual(["project-1", "scene-left"]));
    expect(getActiveEditorStore().getState().selectedSceneId).toBeNull();
    expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
  });

  it("toolbar delete clears a selected clip transition commit without deleting the clip", async () => {
    getActiveEditorStore().getState().selectTransition({ kind: "clip", id: "clip-left" });

    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [
      clip("clip-left", 0, 5, { transitionType: "cross_dissolve", transitionDuration: 0.5 }),
      clip("clip-right", 5, 10),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "deleteSelected (deleteShortcut)" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateClips")[0]?.args[1]).toEqual([
        {
          clipId: "clip-left",
          startTime: 0,
          endTime: 5,
          transitionType: "none",
          transitionDuration: 0,
          fadeInDuration: 0,
          fadeOutDuration: 0,
          transitionParamsJson: null,
        },
      ]);
      expect(runtime.recording.callsTo("deleteClips")).toHaveLength(0);
      expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
    });
  });

  it("ignores library transition drops on layer-clip cuts (main-track clips only, phase 10a)", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 2), track("audio", 1)], clips: [
      clip("clip-left", 0, 5),
      clip("clip-right", 5, 10),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on clip cut" }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.recording.callsTo("updateClips")).toHaveLength(0);
  });

  it("ignores transition drop payloads that reference an audio clip cut", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [
      clip("audio-left", 0, 5, { trackType: "audio", mediaType: "audio" }),
      clip("audio-right", 5, 10, { trackType: "audio", mediaType: "audio" }),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on audio clip cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateClips")).toHaveLength(0);
    });
  });

  it("ignores stale transition drop payloads that reference a locked video clip", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [
      clip("locked-left", 0, 5, { locked: true }),
      clip("clip-right", 5, 10),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on locked clip cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateClips")).toHaveLength(0);
    });
  });

  it("ignores transition drop payloads when the incoming adjacent clip is locked", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [
      clip("clip-left", 0, 5),
      clip("clip-right", 5, 10, { locked: true }),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on clip cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateClips")).toHaveLength(0);
    });
  });

  it("ignores transition drop payloads that reference the last video clip", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [
      clip("clip-first", 0, 5),
      clip("clip-last", 5, 10),
    ] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop transition on last clip cut" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateClips")).toHaveLength(0);
    });
  });
});
