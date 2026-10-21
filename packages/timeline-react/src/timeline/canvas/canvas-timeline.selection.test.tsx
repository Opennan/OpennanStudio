// Behavior coverage for canvas timeline selection exclusivity.
import { cleanup, createEvent, fireEvent, screen } from "@testing-library/react";
import { renderWithTimeline, keyEchoExcept } from "../../test-utils/render-with-timeline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { getActiveEditorStore } from "../../provider/registry";
import { TimelineController } from "@opennan/timeline-core";
import { CanvasTimeline } from "./canvas-timeline";
import type { SceneData } from "@opennan/timeline-core/timeline/canvas/types";

vi.mock("../../hooks/use-timeline-upload", () => ({
  useTimelineUpload: () => ({ upload: vi.fn(), reset: vi.fn() }),
}));

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

function scene(id: string, order: number, start: number, overrides: Partial<SceneData> = {}): SceneData {
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
    ...overrides,
  };
}

function clip(id: string, startTime: number, endTime: number, overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id,
    trackType: "video",
    trackIndex: 1,
    startTime,
    endTime,
    mediaUrl: null,
    mediaType: "video",
    label: id,
    locked: false,
    transitionType: "none",
    transitionDuration: 0,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    ...overrides,
  } as TimelineClip;
}

function renderCanvasTimeline(overrides: Partial<React.ComponentProps<typeof CanvasTimeline>> = {}) {
  const props: React.ComponentProps<typeof CanvasTimeline> = {
    scenes: [
      scene("scene-left", 0, 0, { visualTransition: "crossfade", visualTransitionDuration: 0.5 }),
      scene("scene-right", 1, 5),
    ],
    tracks: [track("video", 1), track("audio", 1)],
    clips: [],
    selectedSceneId: null,
    zoom: 10,
    totalDuration: 10,
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
    ...overrides,
  };
  const result = renderWithTimeline(<CanvasTimeline {...props} />, { translate: keyEchoExcept(["ghostEffect", "ghostGraphic", "ghostTransition"]) });
  const canvas = result.container.querySelector("canvas");
  if (!canvas) throw new Error("CanvasTimeline did not render a canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect());
  const rerenderCanvasTimeline = (nextOverrides: Partial<React.ComponentProps<typeof CanvasTimeline>>) => {
    const nextProps = { ...props, ...nextOverrides };
    result.rerender(<CanvasTimeline {...nextProps} />);
    const nextCanvas = result.container.querySelector("canvas");
    if (!nextCanvas) throw new Error("CanvasTimeline did not render a canvas");
    vi.spyOn(nextCanvas, "getBoundingClientRect").mockReturnValue(rect());
    return nextCanvas;
  };
  return { ...result, canvas, props, rerenderCanvasTimeline };
}

function dispatchCanvasContextMenu(
  canvas: HTMLCanvasElement,
  init: { clientX: number; clientY: number },
) {
  const event = createEvent.contextMenu(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  Object.defineProperty(event, "clientY", { value: init.clientY });
  fireEvent(canvas, event);
}

function dispatchCanvasMouseDown(
  canvas: HTMLCanvasElement,
  init: { clientX: number; clientY: number; shiftKey?: boolean },
) {
  const event = createEvent.mouseDown(canvas, { bubbles: true, cancelable: true, shiftKey: init.shiftKey === true });
  Object.defineProperty(event, "button", { value: 0 });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  Object.defineProperty(event, "clientY", { value: init.clientY });
  fireEvent(canvas, event);
}

function dispatchCanvasMouseMove(
  canvas: HTMLCanvasElement,
  init: { clientX: number; clientY: number },
) {
  const event = createEvent.mouseMove(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  Object.defineProperty(event, "clientY", { value: init.clientY });
  fireEvent(canvas, event);
}

function dispatchCanvasMouseUp(
  canvas: HTMLCanvasElement,
  init: { clientX: number; clientY: number },
) {
  const event = createEvent.mouseUp(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  Object.defineProperty(event, "clientY", { value: init.clientY });
  fireEvent(canvas, event);
}

function dispatchCanvasDoubleClick(
  canvas: HTMLCanvasElement,
  init: { clientX: number; clientY: number },
) {
  const event = createEvent.dblClick(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  Object.defineProperty(event, "clientY", { value: init.clientY });
  fireEvent(canvas, event);
}

function dispatchDeleteKey() {
  fireEvent.keyDown(window, { key: "Delete" });
}

beforeEach(() => {
  getActiveEditorStore().getState().resetForProject();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getActiveEditorStore().getState().resetForProject();
});

describe("CanvasTimeline selection exclusivity", () => {
  it("does not expose audio creation actions from a locked empty audio track menu", () => {
    const { canvas } = renderCanvasTimeline({
      tracks: [
        track("video", 1),
        { ...track("audio", 1), locked: true },
      ],
    });

    dispatchCanvasContextMenu(canvas, {
      clientX: 150,
      clientY: 286,
    });

    expect(screen.queryByRole("button", { name: "importAudioFile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "generateMusic" })).toBeNull();
    expect(screen.queryByRole("button", { name: "generateSoundEffect" })).toBeNull();
  });

  it("removes stale music actions when A1 becomes locked after the menu opens", () => {
    const onSelectMusic = vi.fn();
    const { canvas, rerenderCanvasTimeline } = renderCanvasTimeline({
      musicUrl: "https://example.com/music.mp3",
      onSelectMusic,
    });

    dispatchCanvasContextMenu(canvas, {
      clientX: 150,
      clientY: 286,
    });
    expect(screen.getByRole("button", { name: "generateMusic" })).toBeInTheDocument();

    rerenderCanvasTimeline({
      tracks: [
        track("video", 1),
        { ...track("audio", 1), locked: true },
      ],
    });

    expect(screen.queryByRole("button", { name: "importAudioClip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "generateMusic" })).toBeNull();
    expect(screen.queryByRole("button", { name: "generateSoundEffect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "musicProperties" })).toBeNull();
    expect(onSelectMusic).not.toHaveBeenCalled();
  });

  it("removes stale voiceover actions when A1 becomes locked after the menu opens", () => {
    const onRemoveVoiceover = vi.fn();
    const { canvas, rerenderCanvasTimeline } = renderCanvasTimeline({
      scenes: [
        scene("scene-left", 0, 0, {
          audioUrl: "https://example.com/voiceover.mp3",
          audioText: "voiceover",
        }),
      ],
      onRemoveVoiceover,
    });

    dispatchCanvasContextMenu(canvas, {
      clientX: 120,
      clientY: 286,
    });
    expect(screen.getByRole("button", { name: "importAudioClip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "removeVoiceover" })).toBeInTheDocument();

    rerenderCanvasTimeline({
      tracks: [
        track("video", 1),
        { ...track("audio", 1), locked: true },
      ],
    });

    expect(screen.queryByRole("button", { name: "importAudioClip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "removeVoiceover" })).toBeNull();
    expect(onRemoveVoiceover).not.toHaveBeenCalled();
  });

  it("removes stale clip actions when the clip track becomes locked after the menu opens", () => {
    const onDeleteClips = vi.fn();
    const { canvas, rerenderCanvasTimeline } = renderCanvasTimeline({
      scenes: [],
      clips: [clip("clip-1", 0, 5)],
      onDeleteClips,
    });

    dispatchCanvasContextMenu(canvas, {
      clientX: 130,
      clientY: 252,
    });
    expect(screen.getByRole("button", { name: "duplicateClip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deleteClip/ })).toBeInTheDocument();

    rerenderCanvasTimeline({
      scenes: [],
      clips: [clip("clip-1", 0, 5)],
      tracks: [
        { ...track("video", 1), locked: true },
        track("audio", 1),
      ],
    });

    expect(screen.queryByRole("button", { name: "duplicateClip" })).toBeNull();
    expect(screen.queryByRole("button", { name: /deleteClip/ })).toBeNull();
    expect(onDeleteClips).not.toHaveBeenCalled();
  });

  it("removes stale scene actions when the scene track becomes locked after the menu opens", () => {
    const onDeleteScene = vi.fn();
    const onDuplicateScene = vi.fn();
    const { canvas, rerenderCanvasTimeline } = renderCanvasTimeline({
      onDeleteScene,
      onDuplicateScene,
    });

    dispatchCanvasContextMenu(canvas, {
      clientX: 120,
      clientY: 252,
    });
    expect(screen.getByRole("button", { name: "duplicateScene" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "deleteScene" })).toBeInTheDocument();

    rerenderCanvasTimeline({
      tracks: [
        { ...track("video", 1), locked: true },
        track("audio", 1),
      ],
    });

    expect(screen.queryByRole("button", { name: "duplicateScene" })).toBeNull();
    expect(screen.queryByRole("button", { name: "deleteScene" })).toBeNull();
    expect(onDuplicateScene).not.toHaveBeenCalled();
    expect(onDeleteScene).not.toHaveBeenCalled();
  });

  it("removes stale transition actions when the scene track becomes locked after the menu opens", () => {
    const onSetSceneTransition = vi.fn();
    const { canvas, rerenderCanvasTimeline } = renderCanvasTimeline({
      onSetSceneTransition,
    });

    dispatchCanvasContextMenu(canvas, {
      clientX: 150,
      clientY: 252,
    });
    expect(screen.getByRole("button", { name: "deleteTransition" })).toBeInTheDocument();

    rerenderCanvasTimeline({
      tracks: [
        { ...track("video", 1), locked: true },
        track("audio", 1),
      ],
    });

    expect(screen.queryByRole("button", { name: "deleteTransition" })).toBeNull();
    expect(onSetSceneTransition).not.toHaveBeenCalled();
  });

  it("does not delete a stale selected scene with Delete after the scene track becomes locked", () => {
    const onDeleteScene = vi.fn();
    const { rerenderCanvasTimeline } = renderCanvasTimeline({
      selectedSceneId: "scene-left",
      onDeleteScene,
    });

    rerenderCanvasTimeline({
      selectedSceneId: "scene-left",
      tracks: [
        { ...track("video", 1), locked: true },
        track("audio", 1),
      ],
    });
    dispatchDeleteKey();

    expect(onDeleteScene).not.toHaveBeenCalled();
  });

  it("does not delete a stale selected shot with Delete after the scene track becomes locked", () => {
    const onDeleteShot = vi.fn();
    const { canvas, rerenderCanvasTimeline } = renderCanvasTimeline({
      scenes: [
        scene("scene-left", 0, 0, {
          shotBreakdown: JSON.stringify([
            { duration: 2, prompt: "first" },
            { duration: 3, prompt: "second" },
          ]),
        }),
      ],
      onDeleteShot,
    });

    dispatchCanvasDoubleClick(canvas, {
      clientX: 120,
      clientY: 252,
    });

    rerenderCanvasTimeline({
      tracks: [
        { ...track("video", 1), locked: true },
        track("audio", 1),
      ],
    });
    dispatchDeleteKey();

    expect(onDeleteShot).not.toHaveBeenCalled();
  });

  it("double-click and Delete never pick a shot made on opennan.com (read only, 9a.1); a Studio shot still deletes", () => {
    const onDeleteShot = vi.fn();
    const shots = (readOnly: boolean) => JSON.stringify([
      { duration: 2, prompt: "first", ...(readOnly ? { readOnly: true } : {}) },
      { duration: 3, prompt: "second", ...(readOnly ? { readOnly: true } : {}) },
    ]);
    const { canvas, rerenderCanvasTimeline } = renderCanvasTimeline({
      scenes: [scene("scene-left", 0, 0, { shotBreakdown: shots(true) })],
      onDeleteShot,
    });
    dispatchCanvasDoubleClick(canvas, { clientX: 120, clientY: 252 });
    dispatchDeleteKey();
    expect(onDeleteShot).not.toHaveBeenCalled();

    rerenderCanvasTimeline({ scenes: [scene("scene-left", 0, 0, { shotBreakdown: shots(false) })] });
    dispatchCanvasDoubleClick(canvas, { clientX: 120, clientY: 252 });
    dispatchDeleteKey();
    expect(onDeleteShot).toHaveBeenCalledTimes(1);
  });

  it("left-clicking a scene transition marker selects transition properties without selecting the scene", () => {
    const onSelectScene = vi.fn();
    getActiveEditorStore().getState().selectScene("scene-right");
    const { canvas } = renderCanvasTimeline({ onSelectScene });

    dispatchCanvasMouseDown(canvas, {
      clientX: 150,
      clientY: 252,
    });

    const state = getActiveEditorStore().getState();
    expect(state.selectedTransition).toEqual({ kind: "scene", id: "scene-left" });
    expect(state.selectedSceneId).toBeNull();
    expect(state.selectedClipId).toBeNull();
    expect(state.selectedClipIds.size).toBe(0);
    expect(onSelectScene).not.toHaveBeenCalled();
  });

  it("dragging from a transition marker does not move scenes or create transition state", () => {
    const onMoveSceneTime = vi.fn();
    const onUpdateClips = vi.fn();
    const onSetSceneTransition = vi.fn();
    const onSelectScene = vi.fn();
    const { canvas } = renderCanvasTimeline({
      onMoveSceneTime,
      onUpdateClips,
      onSetSceneTransition,
      onSelectScene,
    });

    dispatchCanvasMouseDown(canvas, {
      clientX: 150,
      clientY: 252,
    });
    dispatchCanvasMouseMove(canvas, {
      clientX: 260,
      clientY: 252,
    });
    dispatchCanvasMouseUp(canvas, {
      clientX: 260,
      clientY: 252,
    });

    expect(getActiveEditorStore().getState().selectedTransition).toEqual({ kind: "scene", id: "scene-left" });
    expect(onMoveSceneTime).not.toHaveBeenCalled();
    expect(onUpdateClips).not.toHaveBeenCalled();
    expect(onSetSceneTransition).not.toHaveBeenCalled();
    expect(onSelectScene).not.toHaveBeenCalled();
  });

  it("pressing Delete on a selected scene transition clears only that transition", () => {
    const onSetSceneTransition = vi.fn();
    const onDeleteScene = vi.fn();
    const { canvas } = renderCanvasTimeline({
      onSetSceneTransition,
      onDeleteScene,
    });

    dispatchCanvasMouseDown(canvas, {
      clientX: 150,
      clientY: 252,
    });
    dispatchDeleteKey();

    expect(onSetSceneTransition).toHaveBeenCalledWith("scene-left", "none", 0);
    expect(onDeleteScene).not.toHaveBeenCalled();
    expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
  });

  it("pressing Delete on a selected clip transition clears the clip transition commit", () => {
    const execute = vi.spyOn(TimelineController.prototype, "execute").mockResolvedValue({ ok: true, changed: {} });
    const onUpdateClips = vi.fn();
    const onDeleteScene = vi.fn();
    const { canvas } = renderCanvasTimeline({
      scenes: [],
      clips: [
        clip("clip-left", 0, 5, { transitionType: "cross_dissolve", transitionDuration: 0.5 }),
        clip("clip-right", 5, 10),
      ],
      onUpdateClips,
      onDeleteScene,
    });

    dispatchCanvasMouseDown(canvas, {
      clientX: 150,
      clientY: 252,
    });
    dispatchDeleteKey();

    // transition.set (phase 10b): one command, which also clears fades an old preset wrote.
    expect(execute).toHaveBeenCalledWith({ type: "transition.set", clipId: "clip-left", transition: "none" });
    expect(onUpdateClips).not.toHaveBeenCalled();
    expect(onDeleteScene).not.toHaveBeenCalled();
    expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
  });

  it("context-menu delete clears a scene transition marker", () => {
    const onSetSceneTransition = vi.fn();
    const { canvas } = renderCanvasTimeline({ onSetSceneTransition });

    dispatchCanvasContextMenu(canvas, {
      clientX: 150,
      clientY: 252,
    });

    expect(getActiveEditorStore().getState().selectedTransition).toEqual({ kind: "scene", id: "scene-left" });

    fireEvent.click(screen.getByRole("button", { name: "deleteTransition" }));

    expect(onSetSceneTransition).toHaveBeenCalledWith("scene-left", "none", 0);
    expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
    expect(screen.queryByRole("button", { name: "deleteTransition" })).toBeNull();
  });

  it("context-menu delete clears a clip transition marker commit", () => {
    const execute = vi.spyOn(TimelineController.prototype, "execute").mockResolvedValue({ ok: true, changed: {} });
    const onUpdateClips = vi.fn();
    const { canvas } = renderCanvasTimeline({
      scenes: [],
      clips: [
        clip("clip-left", 0, 5, { transitionType: "cross_dissolve", transitionDuration: 0.5 }),
        clip("clip-right", 5, 10),
      ],
      onUpdateClips,
    });

    dispatchCanvasContextMenu(canvas, {
      clientX: 150,
      clientY: 252,
    });

    expect(getActiveEditorStore().getState().selectedTransition).toEqual({ kind: "clip", id: "clip-left" });

    fireEvent.click(screen.getByRole("button", { name: "deleteTransition" }));

    // transition.set (phase 10b): one command, which also clears fades an old preset wrote.
    expect(execute).toHaveBeenCalledWith({ type: "transition.set", clipId: "clip-left", transition: "none" });
    expect(onUpdateClips).not.toHaveBeenCalled();
    expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
    expect(screen.queryByRole("button", { name: "deleteTransition" })).toBeNull();
  });

  it("does not select a stale transition marker from a final scene DB field", () => {
    const { canvas } = renderCanvasTimeline({
      scenes: [
        scene("scene-left", 0, 0),
        scene("scene-final", 1, 5, { visualTransition: "crossfade", visualTransitionDuration: 0.5 }),
      ],
    });

    dispatchCanvasMouseDown(canvas, {
      clientX: 200,
      clientY: 252,
    });

    expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
  });

  it("clears a selected transition when the user opens a scene context menu", () => {
    getActiveEditorStore().getState().selectTransition({ kind: "scene", id: "scene-left" });
    const { canvas } = renderCanvasTimeline();

    dispatchCanvasContextMenu(canvas, {
      clientX: 120,
      clientY: 252,
    });

    expect(getActiveEditorStore().getState().selectedTransition).toBeNull();
  });
});

describe("CanvasTimeline empty-space deselection", () => {
  // Default layout: ruler 0-20, V1 row 20-84, A1 row 84-124 (canvas-local Y).
  // Mocked canvas rect sits at left=100/top=200, scenes span 0-10s at zoom 10
  // (world 0-100px), so clientX=400 → world x=300 → 30s = empty lane space.

  it("clicking empty lane space past the last scene clears the scene selection", () => {
    getActiveEditorStore().getState().selectScene("scene-left");
    const { canvas } = renderCanvasTimeline();

    dispatchCanvasMouseDown(canvas, { clientX: 400, clientY: 252 });
    dispatchCanvasMouseUp(canvas, { clientX: 400, clientY: 252 });

    const state = getActiveEditorStore().getState();
    expect(state.selectedSceneId).toBeNull();
    expect(state.selectedClipId).toBeNull();
    expect(state.selectedClipIds.size).toBe(0);
    expect(state.selectedTransition).toBeNull();
    expect(state.selectedAudioTarget).toBeNull();
  });

  it("clicking empty lane space clears a selected audio target", () => {
    getActiveEditorStore().getState().selectAudioTarget("music");
    const { canvas } = renderCanvasTimeline();

    dispatchCanvasMouseDown(canvas, { clientX: 400, clientY: 252 });
    dispatchCanvasMouseUp(canvas, { clientX: 400, clientY: 252 });

    const state = getActiveEditorStore().getState();
    expect(state.selectedAudioTarget).toBeNull();
    expect(state.selectedSceneId).toBeNull();
  });

  it("clicking below the last track clears the selection", () => {
    getActiveEditorStore().getState().selectScene("scene-left");
    const { canvas } = renderCanvasTimeline();

    dispatchCanvasMouseDown(canvas, { clientX: 150, clientY: 340 });
    dispatchCanvasMouseUp(canvas, { clientX: 150, clientY: 340 });

    const state = getActiveEditorStore().getState();
    expect(state.selectedSceneId).toBeNull();
    expect(state.selectedClipIds.size).toBe(0);
    expect(state.selectedAudioTarget).toBeNull();
  });

  it("shift-clicking empty lane space keeps the selection for additive marquee", () => {
    getActiveEditorStore().getState().selectScene("scene-left");
    const { canvas } = renderCanvasTimeline();

    dispatchCanvasMouseDown(canvas, { clientX: 400, clientY: 252, shiftKey: true });
    dispatchCanvasMouseUp(canvas, { clientX: 400, clientY: 252 });

    expect(getActiveEditorStore().getState().selectedSceneId).toBe("scene-left");
  });
});
