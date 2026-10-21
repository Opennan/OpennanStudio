// Timeline keyframe diamonds (phase 10c): select + seek, drag retime (one command), Escape, Delete, easing menu.
import { cleanup, createEvent, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineController, type EditorCommand } from "@opennan/timeline-core";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { renderWithTimeline, keyOnly } from "../../test-utils/render-with-timeline";
import { getActiveEditorStore } from "../../provider/registry";
import { CanvasTimeline } from "./canvas-timeline";

vi.mock("../../hooks/use-timeline-upload", () => ({
  useTimelineUpload: () => ({ upload: vi.fn(), reset: vi.fn() }),
}));

const keyed = JSON.stringify({ keyframes: [{ time: 1, scale: 1.2 }, { time: 3, scale: 1, easing: 2 }] });

function rect(): DOMRect {
  return { x: 100, y: 200, left: 100, top: 200, width: 900, height: 180, right: 1000, bottom: 380, toJSON: () => ({}) } as DOMRect;
}

function track(type: TimelineTrack["type"], index: number): TimelineTrack {
  return { type, index, label: `${type}${index}`, muted: false, locked: false, visible: true, volume: 1 };
}

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "c1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 6, mediaUrl: null, mediaType: "video", label: "c1", locked: false,
    transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, keyframesJson: keyed,
    ...overrides,
  } as TimelineClip;
}

let commands: EditorCommand[] = [];

function renderTimeline(overrides: Partial<React.ComponentProps<typeof CanvasTimeline>> = {}) {
  const props: React.ComponentProps<typeof CanvasTimeline> = {
    scenes: [], tracks: [track("video", 1), track("audio", 1)], clips: [clip()], selectedSceneId: null, zoom: 10, totalDuration: 10,
    musicUrl: null, musicVolume: 1, selectedAudioTarget: null, onSelectClip: vi.fn(), onSelectScene: vi.fn(), onUpdateClips: vi.fn(),
    onSeek: vi.fn(), onSelectMusic: vi.fn(), onSelectVoiceover: vi.fn(), onReorderScenes: vi.fn(), onDeleteClips: vi.fn(),
    ...overrides,
  };
  const result = renderWithTimeline(<CanvasTimeline {...props} />, { translate: keyOnly });
  const canvas = result.container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect());
  return { ...result, canvas, props };
}

function mouse(kind: "mouseDown" | "contextMenu", canvas: HTMLCanvasElement, clientX: number, clientY: number, button = 0) {
  const event = createEvent[kind](canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "button", { value: button });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(canvas, event);
}

// Clip c1 (2..6 s on V1) at 10 px/s: x 20, w 40, strip y 22..82; diamonds at y 75, x 30 (1 s) and 50 (3 s).
// The canvas sits at (100, 200) on the page.
const DIAMOND_1 = { x: 130, y: 275 };
const DIAMOND_3 = { x: 150, y: 275 };

const of = (type: EditorCommand["type"]) => commands.filter((c) => c.type === type);

beforeEach(() => {
  const store = getActiveEditorStore();
  store.getState().resetForProject();
  store.getState().selectClip("c1");
  commands = [];
  vi.spyOn(TimelineController.prototype, "execute").mockImplementation(async (command: EditorCommand) => {
    commands.push(command);
    return { ok: true, changed: {} };
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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

describe("CanvasTimeline keyframe diamonds", () => {
  it("selects a diamond on press and seeks the playhead to it on click", () => {
    const { canvas } = renderTimeline();
    mouse("mouseDown", canvas, DIAMOND_1.x, DIAMOND_1.y);
    expect(getActiveEditorStore().getState().selectedKeyframe).toEqual({ clipId: "c1", time: 1 });
    fireEvent.mouseUp(window, { clientX: DIAMOND_1.x, clientY: DIAMOND_1.y });
    expect(of("playhead.seek")).toEqual([{ type: "playhead.seek", seconds: 3 }]);
    expect(of("keyframe.retime")).toHaveLength(0);
    // The clip stays selected (no clip drag or reselect).
    expect(getActiveEditorStore().getState().selectedClipIds).toEqual(new Set(["c1"]));
  });

  it("retimes a dragged diamond with one command on release, snapped to the frame grid", () => {
    const { canvas, props } = renderTimeline();
    mouse("mouseDown", canvas, DIAMOND_1.x, DIAMOND_1.y);
    fireEvent.mouseMove(window, { clientX: 135, clientY: 275 });
    fireEvent.mouseMove(window, { clientX: 140, clientY: 280 });
    expect(of("keyframe.retime")).toHaveLength(0);
    fireEvent.mouseUp(window, { clientX: 140, clientY: 280 });
    expect(of("keyframe.retime")).toEqual([{ type: "keyframe.retime", clipId: "c1", from: 1, to: 2 }]);
    expect(getActiveEditorStore().getState().selectedKeyframe).toEqual({ clipId: "c1", time: 2 });
    expect(of("playhead.seek")).toHaveLength(0);
    expect(props.onUpdateClips).not.toHaveBeenCalled();
  });

  it("cancels a retime with Escape", () => {
    const { canvas } = renderTimeline();
    mouse("mouseDown", canvas, DIAMOND_1.x, DIAMOND_1.y);
    fireEvent.mouseMove(window, { clientX: 145, clientY: 275 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseUp(window, { clientX: 145, clientY: 275 });
    expect(of("keyframe.retime")).toHaveLength(0);
    expect(getActiveEditorStore().getState().selectedClipIds).toEqual(new Set(["c1"]));
  });

  it("deletes the selected keyframe (not the clip) with Delete", () => {
    const { canvas, props } = renderTimeline();
    mouse("mouseDown", canvas, DIAMOND_3.x, DIAMOND_3.y);
    fireEvent.mouseUp(window, {});
    fireEvent.keyDown(window, { key: "Delete" });
    expect(of("keyframe.remove")).toEqual([{ type: "keyframe.remove", clipId: "c1", time: 3 }]);
    expect(props.onDeleteClips).not.toHaveBeenCalled();
    expect(getActiveEditorStore().getState().selectedKeyframe).toBeNull();
    // Without a selected keyframe Delete is left to the clip shortcuts.
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(of("keyframe.remove")).toHaveLength(1);
  });

  it("leaves Delete to the clip shortcuts when the selected keyframe no longer exists", () => {
    const { canvas, rerender, props } = renderTimeline();
    mouse("mouseDown", canvas, DIAMOND_3.x, DIAMOND_3.y);
    fireEvent.mouseUp(window, {});
    rerender(<CanvasTimeline {...props} clips={[clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 1, scale: 1 }] }) })]} />);
    const event = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(of("keyframe.remove")).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
    expect(getActiveEditorStore().getState().selectedKeyframe).toBeNull();
  });

  it("drops the keyframe selection when the clip body is pressed", () => {
    const { canvas } = renderTimeline();
    mouse("mouseDown", canvas, DIAMOND_1.x, DIAMOND_1.y);
    fireEvent.mouseUp(window, {});
    mouse("mouseDown", canvas, 140, 240);
    fireEvent.mouseUp(window, {});
    expect(getActiveEditorStore().getState().selectedKeyframe).toBeNull();
  });

  it("opens an easing menu on right-click with the current easing checked", () => {
    const { canvas } = renderTimeline();
    mouse("contextMenu", canvas, DIAMOND_3.x, DIAMOND_3.y, 2);
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId("keyframe-menu-ease-ease_out")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(screen.getByTestId("keyframe-menu-ease-linear"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("keyframe-menu-ease-ease_in"));
    fireEvent.click(screen.getByTestId("keyframe-menu-ease-ease_in"));
    expect(of("keyframe.easing")).toEqual([{ type: "keyframe.easing", clipId: "c1", time: 3, easing: "ease_in" }]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers custom bezier, delete, and the graph editor in the menu", () => {
    const { canvas } = renderTimeline();
    mouse("contextMenu", canvas, DIAMOND_1.x, DIAMOND_1.y, 2);
    fireEvent.click(screen.getByTestId("keyframe-menu-ease-bezier"));
    expect(of("keyframe.easing")[0]).toMatchObject({ easing: "bezier", bezier: [0.25, 0.1, 0.25, 1], time: 1 });
    expect(getActiveEditorStore().getState().keyframeGraph.open).toBe(true);
    expect(of("playhead.seek")).toEqual([{ type: "playhead.seek", seconds: 3 }]);
    getActiveEditorStore().getState().setKeyframeGraph({ open: false });
    mouse("contextMenu", canvas, DIAMOND_1.x, DIAMOND_1.y, 2);
    fireEvent.click(screen.getByTestId("keyframe-menu-graph"));
    expect(getActiveEditorStore().getState().keyframeGraph.open).toBe(true);
    mouse("contextMenu", canvas, DIAMOND_1.x, DIAMOND_1.y, 2);
    fireEvent.click(screen.getByTestId("keyframe-menu-delete"));
    expect(of("keyframe.remove")).toEqual([{ type: "keyframe.remove", clipId: "c1", time: 1 }]);
    // Escape closes the menu.
    mouse("contextMenu", canvas, DIAMOND_1.x, DIAMOND_1.y, 2);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
