// Browser-style coverage for canvas timeline drag/drop placeholders and drop targets.
import { cleanup, createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTimeline, keyEchoExcept } from "../../test-utils/render-with-timeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { getActiveEditorStore } from "../../provider/registry";
import { CanvasTimeline } from "./canvas-timeline";
import type { SceneData } from "@opennan/timeline-core/timeline/canvas/types";

vi.mock("../../hooks/use-timeline-upload", () => ({
  useTimelineUpload: () => ({ upload: vi.fn(), reset: vi.fn() }),
}));

function dataTransfer(values: Record<string, string>): DataTransfer {
  const store = new Map(Object.entries(values));
  return {
    dropEffect: "",
    effectAllowed: "",
    types: Object.keys(values),
    getData: vi.fn((type: string) => store.get(type) ?? ""),
    setData: vi.fn((type: string, value: string) => store.set(type, value)),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function rect(left = 100, top = 200, width = 900, height = 180): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function track(type: TimelineTrack["type"], index: number): TimelineTrack {
  return {
    type,
    index,
    label: `${type[0].toUpperCase()}${index}`,
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  };
}

function sourceScene(overrides: Partial<SceneData>): SceneData {
  return {
    id: "scene-1",
    order: 0,
    caption: "Scene",
    startTime: "00:00:00,000",
    endTime: "00:00:26,000",
    timelinePositionSeconds: 0,
    trackIndex: 1,
    startImageUrl: null,
    endImageUrl: null,
    videoUrl: "https://cdn.example.test/source.mp4",
    sourceVideoUrl: "https://cdn.example.test/source.mp4",
    status: "ready",
    transition: "none",
    visualTransition: "none",
    visualTransitionDuration: 0,
    cardType: "source_clip",
    duration: 26,
    frameConsistencyScore: null,
    audioUrl: null,
    audioText: null,
    cardConfig: null,
    ...overrides,
  };
}

function clip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    id: "clip-1",
    projectId: "project-1",
    trackType: "video",
    trackIndex: 1,
    startTime: 0,
    endTime: 5,
    mediaUrl: null,
    mediaType: "video",
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

function renderCanvasTimeline(overrides: Partial<React.ComponentProps<typeof CanvasTimeline>> = {}) {
  const onTrackDrop = vi.fn();
  const props: React.ComponentProps<typeof CanvasTimeline> = {
    scenes: [],
    tracks: [track("video", 1), track("audio", 1)],
    clips: [],
    selectedSceneId: null,
    zoom: 10,
    totalDuration: 30,
    musicUrl: null,
    musicVolume: 1,
    selectedAudioTarget: null,
    onSelectClip: vi.fn(),
    onSelectScene: vi.fn(),
    onUpdateClips: vi.fn(),
    onSeek: vi.fn(),
    onSelectMusic: vi.fn(),
    onSelectVoiceover: vi.fn(),
    onReorderScenes: vi.fn(),
    onDeleteClips: vi.fn(),
    onTrackDrop,
    ...overrides,
  };
  const result = renderWithTimeline(<CanvasTimeline {...props} />, { translate: keyEchoExcept(["ghostEffect", "ghostGraphic", "ghostTransition"]) });
  const canvas = result.container.querySelector("canvas");
  if (!canvas) throw new Error("CanvasTimeline did not render a canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect());
  return { ...result, canvas, onTrackDrop };
}

function dispatchCanvasDrag(
  canvas: HTMLCanvasElement,
  type: "dragOver" | "drop",
  init: { clientX: number; clientY: number; dataTransfer: DataTransfer },
) {
  const event = type === "dragOver"
    ? createEvent.dragOver(canvas, { bubbles: true, cancelable: true })
    : createEvent.drop(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  Object.defineProperty(event, "clientY", { value: init.clientY });
  Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer });
  fireEvent(canvas, event);
}

beforeEach(() => {
  getActiveEditorStore().getState().resetForProject();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getActiveEditorStore().getState().resetForProject();
});

describe("CanvasTimeline drag/drop behavior", () => {
  it("shows a missing effect-track placeholder above video and drops onto the new E1 lane", async () => {
    const payload = JSON.stringify({ kind: "effect", effectId: "shake", name: "Shake" });
    const onEffectDropPreviewChange = vi.fn();
    const { canvas, onTrackDrop, container } = renderCanvasTimeline({
      tracks: [track("video", 1), track("audio", 1)],
      onEffectDropPreviewChange,
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 220,
      clientY: 312,
      dataTransfer: dataTransfer({
        "application/x-effect-layer": "Shake",
        "application/json": payload,
      }),
    });

    const ghost = (await screen.findByText("Effect")).closest("div");
    expect(ghost).toHaveStyle({ top: "20px", height: "40px" });
    // canvas → sticky viewport layer → content host (which owns track height)
    expect(canvas.parentElement?.parentElement).toHaveStyle({ height: "164px" });
    expect(onEffectDropPreviewChange).toHaveBeenLastCalledWith(expect.objectContaining({
      trackIndex: 1,
      trackMissing: true,
      y: 20,
      h: 40,
    }));
    expect(container.querySelectorAll("canvas")).toHaveLength(1);

    dispatchCanvasDrag(canvas, "drop", {
      clientX: 220,
      clientY: 312,
      dataTransfer: dataTransfer({ "application/json": payload }),
    });

    await waitFor(() => {
      expect(onTrackDrop).toHaveBeenCalledWith(
        "effect",
        1,
        12,
        { kind: "effect", effectId: "shake", name: "Shake" },
      );
      expect(onEffectDropPreviewChange).toHaveBeenLastCalledWith(null);
    });
  });

  it("drops an effect on the same editable effect track shown by the ghost", async () => {
    const payload = JSON.stringify({ kind: "effect", effectId: "shake", name: "Shake" });
    const { canvas, onTrackDrop } = renderCanvasTimeline({
      tracks: [track("video", 1), track("audio", 1), track("effect", 2)],
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 220,
      clientY: 312,
      dataTransfer: dataTransfer({
        "application/x-effect-layer": "Shake",
        "application/json": payload,
      }),
    });

    const ghost = (await screen.findByText("Effect")).closest("div");
    expect(ghost).toHaveStyle({ top: "20px", height: "40px" });

    dispatchCanvasDrag(canvas, "drop", {
      clientX: 220,
      clientY: 312,
      dataTransfer: dataTransfer({ "application/json": payload }),
    });

    await waitFor(() => {
      expect(onTrackDrop).toHaveBeenCalledWith(
        "effect",
        2,
        12,
        { kind: "effect", effectId: "shake", name: "Shake" },
      );
    });
  });

  it("drops an effect on E2 when the cursor is over the second editable effect row", async () => {
    const payload = JSON.stringify({ kind: "effect", effectId: "shake", name: "Shake" });
    const { canvas, onTrackDrop } = renderCanvasTimeline({
      tracks: [
        track("effect", 1),
        track("effect", 2),
        track("video", 1),
        track("audio", 1),
      ],
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 220,
      clientY: 280,
      dataTransfer: dataTransfer({
        "application/x-effect-layer": "Shake",
        "application/json": payload,
      }),
    });

    const ghost = (await screen.findByText("Effect")).closest("div");
    expect(ghost).toHaveStyle({ top: "60px", height: "40px" });

    dispatchCanvasDrag(canvas, "drop", {
      clientX: 220,
      clientY: 280,
      dataTransfer: dataTransfer({ "application/json": payload }),
    });

    await waitFor(() => {
      expect(onTrackDrop).toHaveBeenCalledWith(
        "effect",
        2,
        12,
        { kind: "effect", effectId: "shake", name: "Shake" },
      );
    });
  });

  it("applies a dropped filter or effect to the main-track clip under the cursor, but not onto a clip on a locked track", async () => {
    for (const locked of [false, true]) {
      const { canvas, onTrackDrop, unmount } = renderCanvasTimeline({
        scenes: [sourceScene({ id: "scene-1" })],
        tracks: [{ ...track("video", 1), locked }, track("audio", 1)],
      });
      for (const payload of [{ kind: "filter", filterId: "noir", name: "Noir" }, { kind: "effect", effectId: "fx_blur", name: "Blur" }]) {
        dispatchCanvasDrag(canvas, "drop", { clientX: 160, clientY: 252, dataTransfer: dataTransfer({ "application/json": JSON.stringify(payload) }) });
      }
      if (locked) {
        // Nothing lands on the locked clip; an effect card still makes an effect layer (its own track).
        expect(onTrackDrop.mock.calls.some(([kind]) => kind === "filter")).toBe(false);
        expect(onTrackDrop.mock.calls.some(([, , , data]) => data?.sceneId)).toBe(false);
      } else {
        expect(onTrackDrop).toHaveBeenCalledWith("filter", 0, expect.any(Number), expect.objectContaining({ filterId: "noir", sceneId: "scene-1" }));
        expect(onTrackDrop).toHaveBeenCalledWith("effect", 0, expect.any(Number), expect.objectContaining({ effectId: "fx_blur", sceneId: "scene-1" }));
      }
      unmount();
    }
  });

  it("shows and drops a transition placeholder at a trimmed source-video cut", async () => {
    const payload = JSON.stringify({ kind: "transition", transitionId: "crossfade", name: "Crossfade" });
    const { canvas, onTrackDrop } = renderCanvasTimeline({
      scenes: [
        sourceScene({
          id: "scene-left",
          order: 0,
          duration: 26,
          timelinePositionSeconds: 0,
          cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 12.9 }),
        }),
        sourceScene({
          id: "scene-right",
          order: 1,
          duration: 13.1,
          timelinePositionSeconds: 12.9,
          cardConfig: JSON.stringify({ timelineTrimStart: 12.9, timelineTrimEnd: 26 }),
        }),
      ],
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 229,
      clientY: 252,
      dataTransfer: dataTransfer({
        "application/x-transition-id": "crossfade",
        "application/json": payload,
      }),
    });

    const ghost = await screen.findByText("Transition");
    expect(ghost).toHaveStyle({ left: "85px", top: "41px", width: "88px", height: "22px" });
    expect(screen.getByTestId("transition-drop-placeholder")).toHaveStyle({
      left: "111px",
      top: "22px",
      width: "36px",
      height: "60px",
    });

    dispatchCanvasDrag(canvas, "drop", {
      clientX: 229,
      clientY: 252,
      dataTransfer: dataTransfer({ "application/json": payload }),
    });

    await waitFor(() => {
      expect(onTrackDrop).toHaveBeenCalledWith(
        "transition",
        0,
        12.9,
        expect.objectContaining({
          kind: "transition",
          transitionId: "crossfade",
          sceneId: "scene-left",
        }),
      );
    });
  });

  it("renders transition drags as a labeled drop box instead of a symbolic icon", async () => {
    const payload = JSON.stringify({ kind: "transition", transitionId: "crossfade", name: "Crossfade" });
    const { canvas } = renderCanvasTimeline({
      scenes: [
        sourceScene({
          id: "scene-left",
          order: 0,
          duration: 13,
          timelinePositionSeconds: 0,
        }),
        sourceScene({
          id: "scene-right",
          order: 1,
          duration: 13,
          timelinePositionSeconds: 13,
        }),
      ],
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 230,
      clientY: 252,
      dataTransfer: dataTransfer({
        "application/x-transition-id": "crossfade",
        "application/json": payload,
      }),
    });

    expect(await screen.findByText("Transition")).toBeInTheDocument();
    expect(screen.queryByText("⧓")).toBeNull();
    expect(screen.getByTestId("transition-drop-placeholder")).toBeInTheDocument();
  });

  it("does not show or drop a transition placeholder on adjacent audio clip cuts", async () => {
    const payload = JSON.stringify({ kind: "transition", transitionId: "crossfade", name: "Crossfade" });
    const { canvas, onTrackDrop } = renderCanvasTimeline({
      tracks: [track("video", 1), track("audio", 1)],
      clips: [
        clip({ id: "audio-out", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 }),
        clip({ id: "audio-in", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 10 }),
      ],
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 150,
      clientY: 286,
      dataTransfer: dataTransfer({
        "application/x-transition-id": "crossfade",
        "application/json": payload,
      }),
    });

    expect(screen.queryByTestId("transition-drop-placeholder")).toBeNull();

    dispatchCanvasDrag(canvas, "drop", {
      clientX: 150,
      clientY: 286,
      dataTransfer: dataTransfer({ "application/json": payload }),
    });

    expect(onTrackDrop).not.toHaveBeenCalled();
  });

  it("shows and drops a transition placeholder while dragging over the effect row", async () => {
    const payload = JSON.stringify({ kind: "transition", transitionId: "crossfade", name: "Crossfade" });
    const { canvas, onTrackDrop } = renderCanvasTimeline({
      tracks: [track("video", 1), track("audio", 1), track("effect", 1)],
      scenes: [
        sourceScene({
          id: "scene-left",
          order: 0,
          duration: 26,
          timelinePositionSeconds: 0,
          cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 12.9 }),
        }),
        sourceScene({
          id: "scene-right",
          order: 1,
          duration: 13.1,
          timelinePositionSeconds: 12.9,
          cardConfig: JSON.stringify({ timelineTrimStart: 12.9, timelineTrimEnd: 26 }),
        }),
      ],
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 229,
      clientY: 240,
      dataTransfer: dataTransfer({
        "application/x-transition-id": "crossfade",
        "application/json": payload,
      }),
    });

    const ghost = await screen.findByText("Transition");
    expect(ghost).toHaveStyle({ left: "85px", top: "81px", width: "88px", height: "22px" });
    expect(screen.getByTestId("transition-drop-placeholder")).toHaveStyle({
      left: "111px",
      top: "62px",
      width: "36px",
      height: "60px",
    });

    dispatchCanvasDrag(canvas, "drop", {
      clientX: 229,
      clientY: 240,
      dataTransfer: dataTransfer({ "application/json": payload }),
    });

    await waitFor(() => {
      expect(onTrackDrop).toHaveBeenCalledWith(
        "transition",
        0,
        12.9,
        expect.objectContaining({
          kind: "transition",
          transitionId: "crossfade",
          sceneId: "scene-left",
        }),
      );
    });
  });

  it("shows a transition placeholder when drag-over only exposes the JSON payload", async () => {
    const payload = JSON.stringify({ kind: "transition", transitionId: "crossfade", name: "Crossfade" });
    const { canvas } = renderCanvasTimeline({
      scenes: [
        sourceScene({
          id: "scene-left",
          order: 0,
          duration: 26,
          timelinePositionSeconds: 0,
          cardConfig: JSON.stringify({ timelineTrimStart: 0, timelineTrimEnd: 12.9 }),
        }),
        sourceScene({
          id: "scene-right",
          order: 1,
          duration: 13.1,
          timelinePositionSeconds: 12.9,
          cardConfig: JSON.stringify({ timelineTrimStart: 12.9, timelineTrimEnd: 26 }),
        }),
      ],
    });

    dispatchCanvasDrag(canvas, "dragOver", {
      clientX: 229,
      clientY: 252,
      dataTransfer: dataTransfer({
        "application/json": payload,
        "text/plain": payload,
      }),
    });

    const ghost = await screen.findByText("Transition");
    expect(ghost).toHaveStyle({ left: "85px", top: "41px", width: "88px", height: "22px" });
    expect(screen.getByTestId("transition-drop-placeholder")).toHaveStyle({
      left: "111px",
      top: "22px",
      width: "36px",
      height: "60px",
    });
  });
});
