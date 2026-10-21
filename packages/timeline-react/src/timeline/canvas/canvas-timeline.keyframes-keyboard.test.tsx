// Keyboard keyframes (phase 10d): the selected item's diamonds as a roving-tabindex listbox of visually hidden
// options over the canvas; focus selects + seeks, arrows retime, Alt+arrows / Home / End move focus, Delete
// removes, Enter / Space open the easing menu (Escape returns focus); labels and live announcements.
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineController, type EditorCommand } from "@opennan/timeline-core";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { renderWithTimeline } from "../../test-utils/render-with-timeline";
import { DEFAULT_TRANSLATE } from "../../i18n/format";
import { getActiveEditorStore } from "../../provider/registry";
import { CanvasTimeline } from "./canvas-timeline";

vi.mock("../../hooks/use-timeline-upload", () => ({
  useTimelineUpload: () => ({ upload: vi.fn(), reset: vi.fn() }),
}));

const keyed = JSON.stringify({ keyframes: [{ time: 1, scale: 1.2, position_x: 0.4, position_y: 0.5 }, { time: 3, scale: 1, easing: 3 }] });

function track(type: TimelineTrack["type"], index: number): TimelineTrack {
  return { type, index, label: `${type}${index}`, muted: false, locked: false, visible: true, volume: 1 };
}

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "c1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 6, mediaUrl: null, mediaType: "video", label: "Title 1", locked: false,
    transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, keyframesJson: keyed,
    ...overrides,
  } as TimelineClip;
}

let commands: EditorCommand[] = [];
let result: { ok: boolean } = { ok: true };

function renderTimeline(overrides: Partial<React.ComponentProps<typeof CanvasTimeline>> = {}) {
  const props: React.ComponentProps<typeof CanvasTimeline> = {
    scenes: [], tracks: [track("video", 1), track("audio", 1)], clips: [clip()], selectedSceneId: null, zoom: 10, totalDuration: 10,
    musicUrl: null, musicVolume: 1, selectedAudioTarget: null, onSelectClip: vi.fn(), onSelectScene: vi.fn(), onUpdateClips: vi.fn(),
    onSeek: vi.fn(), onSelectMusic: vi.fn(), onSelectVoiceover: vi.fn(), onReorderScenes: vi.fn(), onDeleteClips: vi.fn(),
    ...overrides,
  };
  const rendered = renderWithTimeline(<CanvasTimeline {...props} />, { translate: DEFAULT_TRANSLATE });
  return { ...rendered, props };
}

const of = (type: EditorCommand["type"]) => commands.filter((c) => c.type === type);
const options = () => screen.getAllByRole("option");
const store = () => getActiveEditorStore().getState();

function focusOption(index: number) {
  act(() => options()[index].focus());
}

beforeEach(() => {
  store().resetForProject();
  store().selectClip("c1");
  commands = [];
  result = { ok: true };
  vi.spyOn(TimelineController.prototype, "execute").mockImplementation(async (command: EditorCommand) => {
    commands.push(command);
    return { ...result, changed: {} } as never;
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

describe("keyboard keyframe diamonds: structure and labels", () => {
  it("lists the selected clip's keyframes as one tab stop, labelled and placed over the drawn diamonds", () => {
    renderTimeline();
    const list = screen.getByRole("listbox", { name: "Keyframes of Title 1" });
    expect(list).toHaveAttribute("aria-orientation", "horizontal");
    expect(list).toHaveAccessibleDescription(/Left and Right arrows move the keyframe by one frame/);
    const [first, second] = within(list).getAllByRole("option");
    expect(first).toHaveAccessibleName("Keyframe at 1.00 s: Position, Scale; easing Linear");
    expect(second).toHaveAccessibleName("Keyframe at 3.00 s: Scale; easing Ease in-out");
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");
    // Clip c1 (2..6 s) at 10 px/s on V1: diamonds at world x 30 and 50, y 75; 14 x 16 hit boxes.
    expect(first.style.left).toBe("23px");
    expect(first.style.top).toBe("67px");
    expect(second.style.left).toBe("43px");
    // Mouse input stays the canvas's.
    expect(list.className).toContain("pointer-events-none");
  });

  it("follows zoom changes and drops the layer without a single keyframed selection", () => {
    const { rerender, props } = renderTimeline();
    rerender(<CanvasTimeline {...props} zoom={20} />);
    expect(options()[0].style.left).toBe(`${60 - 7}px`);
    act(() => store().setSelectedClipIds(new Set()));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("names a scene by its caption", () => {
    act(() => store().setSelectedClipIds(new Set()));
    renderTimeline({
      clips: [],
      selectedSceneId: "s1",
      scenes: [{
        id: "s1", order: 0, caption: "Opening shot", startTime: "0", endTime: "4", trackIndex: 1, startImageUrl: null, endImageUrl: null,
        videoUrl: null, status: "ready", transition: "none", duration: 4, timelinePositionSeconds: 0.001, frameConsistencyScore: null,
        audioUrl: null, audioText: null, cardConfig: null, keyframesJson: keyed,
      } as never],
    });
    expect(screen.getByRole("listbox", { name: "Keyframes of Opening shot" })).toBeInTheDocument();
    expect(options()).toHaveLength(2);
  });

  it("keeps the first selected keyframe as the tab stop", () => {
    act(() => store().selectKeyframe({ clipId: "c1", time: 3 }));
    renderTimeline();
    expect(options()[1]).toHaveAttribute("tabindex", "0");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(options()[0]).toHaveAttribute("aria-selected", "false");
  });
});

describe("keyboard keyframe diamonds: focus and keys", () => {
  it("selects the keyframe and seeks the playhead to it on focus", () => {
    renderTimeline();
    focusOption(1);
    expect(store().selectedKeyframe).toEqual({ clipId: "c1", time: 3 });
    expect(of("playhead.seek")).toEqual([{ type: "playhead.seek", seconds: 5 }]);
    expect(options()[1]).toHaveAttribute("tabindex", "0");
    expect(options()[0]).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with Alt+arrows, Home, and End", () => {
    renderTimeline();
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "ArrowRight", altKey: true });
    expect(document.activeElement).toBe(options()[1]);
    expect(store().selectedKeyframe).toEqual({ clipId: "c1", time: 3 });
    fireEvent.keyDown(options()[1], { key: "ArrowRight", altKey: true });
    expect(document.activeElement).toBe(options()[1]);
    fireEvent.keyDown(options()[1], { key: "Home" });
    expect(document.activeElement).toBe(options()[0]);
    fireEvent.keyDown(options()[0], { key: "End" });
    expect(document.activeElement).toBe(options()[1]);
    fireEvent.keyDown(options()[1], { key: "ArrowLeft", altKey: true });
    expect(document.activeElement).toBe(options()[0]);
    expect(of("keyframe.retime")).toHaveLength(0);
  });

  it("retimes by one frame with an arrow and ten with Shift, one command per press, and announces it", () => {
    renderTimeline();
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "ArrowRight" });
    expect(of("keyframe.retime")).toEqual([{ type: "keyframe.retime", clipId: "c1", from: 1, to: 1.033 }]);
    expect(store().selectedKeyframe).toEqual({ clipId: "c1", time: 1.033 });
    expect(of("playhead.seek").at(-1)).toEqual({ type: "playhead.seek", seconds: 3.033 });
    expect(screen.getByRole("status")).toHaveTextContent("Keyframe moved to 1.03 s");
    fireEvent.keyDown(options()[0], { key: "ArrowLeft", shiftKey: true });
    expect(of("keyframe.retime").at(-1)).toEqual({ type: "keyframe.retime", clipId: "c1", from: 1, to: 0.667 });
  });

  it("keeps focus on the moved keyframe when the timeline updates", () => {
    const { rerender, props } = renderTimeline({
      clips: [clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 1, scale: 1 }, { time: 1.2, scale: 2 }, { time: 3, scale: 1 }] }) })],
    });
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "ArrowRight", shiftKey: true });
    expect(of("keyframe.retime")).toEqual([{ type: "keyframe.retime", clipId: "c1", from: 1, to: 1.333 }]);
    // The keyframe passed its neighbour: it is now the second one.
    rerender(<CanvasTimeline {...props} clips={[clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 1.2, scale: 2 }, { time: 1.333, scale: 1 }, { time: 3, scale: 1 }] }) })]} />);
    expect(document.activeElement).toBe(options()[1]);
    expect(options()[1]).toHaveAccessibleName(/^Keyframe at 1\.33 s/);
  });

  it("never merges into a neighbour: an arrow hops over a keyframe one frame away", () => {
    renderTimeline({ clips: [clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 1, scale: 1 }, { time: 1.033, scale: 2 }] }) })] });
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "ArrowRight" });
    expect(of("keyframe.retime")).toEqual([{ type: "keyframe.retime", clipId: "c1", from: 1, to: 1.067 }]);
  });

  it("clamps to the item: nothing happens at its start", () => {
    renderTimeline({ clips: [clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 1 }, { time: 3, scale: 2 }] }) })] });
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "ArrowLeft" });
    expect(of("keyframe.retime")).toHaveLength(0);
  });

  it("puts the keyframe back when the retime is refused", async () => {
    result = { ok: false };
    renderTimeline();
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "ArrowRight" });
    await act(async () => {});
    expect(store().selectedKeyframe).toEqual({ clipId: "c1", time: 1 });
  });

  it("deletes with Delete and moves focus to the next keyframe (the clip stays)", () => {
    const { props } = renderTimeline();
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "Delete" });
    expect(of("keyframe.remove")).toEqual([{ type: "keyframe.remove", clipId: "c1", time: 1 }]);
    expect(props.onDeleteClips).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(options()[1]);
    expect(store().selectedKeyframe).toEqual({ clipId: "c1", time: 3 });
    expect(screen.getByRole("status")).toHaveTextContent("Keyframe at 1.00 s deleted");
  });

  it("moves focus to the previous keyframe after deleting the last one, and to the canvas after the only one", () => {
    const { container } = renderTimeline();
    focusOption(1);
    fireEvent.keyDown(options()[1], { key: "Backspace" });
    expect(of("keyframe.remove")).toEqual([{ type: "keyframe.remove", clipId: "c1", time: 3 }]);
    expect(document.activeElement).toBe(options()[0]);
    cleanup();
    commands = [];
    const single = renderTimeline({ clips: [clip({ keyframesJson: JSON.stringify({ keyframes: [{ time: 2, scale: 1 }] }) })] });
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "Delete" });
    expect(of("keyframe.remove")).toHaveLength(1);
    expect(document.activeElement).toBe(single.container.querySelector("canvas"));
    expect(store().selectedKeyframe).toBeNull();
    expect(container).toBeTruthy();
  });

  it("opens the easing menu with Enter or Space; Escape closes it and returns focus to the diamond", () => {
    renderTimeline();
    focusOption(1);
    fireEvent.keyDown(options()[1], { key: "Enter" });
    const menu = screen.getByRole("menu");
    expect(screen.getByTestId("keyframe-menu-ease-ease_in_out")).toHaveAttribute("aria-checked", "true");
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(options()[1]);
    fireEvent.keyDown(options()[1], { key: " " });
    fireEvent.click(screen.getByTestId("keyframe-menu-ease-hold"));
    expect(of("keyframe.easing")).toEqual([{ type: "keyframe.easing", clipId: "c1", time: 3, easing: "hold" }]);
    expect(document.activeElement).toBe(options()[1]);
  });

  it("deleting from a keyboard-opened menu moves focus to a neighbour", () => {
    renderTimeline();
    focusOption(0);
    fireEvent.keyDown(options()[0], { key: "Enter" });
    fireEvent.click(screen.getByTestId("keyframe-menu-delete"));
    expect(of("keyframe.remove")).toEqual([{ type: "keyframe.remove", clipId: "c1", time: 1 }]);
    expect(document.activeElement).toBe(options()[1]);
  });

  it("keeps handled keys from the editor shortcuts and lets others through", () => {
    renderTimeline();
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", listener);
    document.addEventListener("keydown", listener);
    try {
      focusOption(0);
      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Delete"]) fireEvent.keyDown(document.activeElement!, { key });
      expect(seen).toEqual([]);
      // Tab leaves the group natively: the editor's Tab (select the next clip) never sees it, nothing is prevented.
      expect(fireEvent.keyDown(document.activeElement!, { key: "Tab" })).toBe(true);
      expect(fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true })).toBe(true);
      expect(seen).toEqual([]);
      fireEvent.keyDown(document.activeElement!, { key: "z", metaKey: true });
      expect(seen).toContain("z");
      // The window Delete handler for a selected keyframe did not remove it a second time.
      expect(of("keyframe.remove")).toHaveLength(1);
    } finally {
      window.removeEventListener("keydown", listener);
      document.removeEventListener("keydown", listener);
    }
  });
});
