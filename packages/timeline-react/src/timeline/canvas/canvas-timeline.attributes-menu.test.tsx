// The clip context menu's Copy attributes / Paste attributes… rows (phase 10c).
import { cleanup, createEvent, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { optimistic, snapshotAttributes } from "@opennan/timeline-core";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { createTimelineTestRuntime, keyEchoExcept, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { CanvasTimeline } from "./canvas-timeline";

vi.mock("../../hooks/use-timeline-upload", () => ({
  useTimelineUpload: () => ({ upload: vi.fn(), reset: vi.fn() }),
}));

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: `${type}${index}`, muted: false, locked: false, visible: true, volume: 1 });

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderTimeline(options: { selected?: string[]; clipboard?: boolean } = {}) {
  const runtime = createTimelineTestRuntime();
  runtime.store.getState().resetForProject();
  const first = { ...optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" }, runtime.projectId, "clip-1"), visualFilter: "warm", playbackSpeed: 2 };
  const second = optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 1, startTime: 4, endTime: 6, mediaType: "video", mediaUrl: "b.mp4" }, runtime.projectId, "clip-2");
  await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [first, second] });
  if (options.selected) runtime.store.getState().setSelectedClipIds(new Set(options.selected));
  if (options.clipboard) runtime.store.getState().setAttributeClipboard(snapshotAttributes({ kind: "clip", clip: first }));
  const timeline = runtime.store.getState().timelineData!;
  const result = renderWithTimeline(
    <CanvasTimeline
      scenes={[]} tracks={timeline.tracks} clips={timeline.clips} selectedSceneId={null} zoom={40} totalDuration={10} musicUrl={null} musicVolume={1}
      selectedAudioTarget={null} onSelectClip={vi.fn()} onSelectScene={vi.fn()} onUpdateClips={vi.fn()} onSeek={vi.fn()} onSelectMusic={vi.fn()}
      onSelectVoiceover={vi.fn()} onReorderScenes={vi.fn()} onDeleteClips={vi.fn()}
    />,
    { runtime, translate: keyEchoExcept(["ghostEffect", "ghostGraphic", "ghostTransition"]) },
  );
  const canvas = result.container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 100, y: 200, left: 100, top: 200, width: 900, height: 180, right: 1000, bottom: 380, toJSON: () => ({}) } as DOMRect);
  const openMenu = () => {
    const event = createEvent.contextMenu(canvas, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clientX", { value: 130 });
    Object.defineProperty(event, "clientY", { value: 252 });
    fireEvent(canvas, event);
  };
  return { runtime, openMenu };
}

it("Copy attributes copies the right-clicked clip; Paste attributes… is off until something is copied", async () => {
  const { runtime, openMenu } = await renderTimeline();
  openMenu();
  expect((screen.getByRole("button", { name: /pasteAttributes/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /copyAttributes/ }));
  expect(runtime.store.getState().attributeClipboard).toMatchObject({ source: { id: "clip-1" }, kinds: ["filter", "speed"] });
  expect(screen.queryByRole("button", { name: /copyAttributes/ })).toBeNull();
});

it("Paste attributes… opens the picker for the selection that holds the right-clicked clip", async () => {
  const { runtime, openMenu } = await renderTimeline({ selected: ["clip-1", "clip-2"], clipboard: true });
  openMenu();
  fireEvent.click(screen.getByRole("button", { name: /pasteAttributes/ }));
  expect(runtime.store.getState().attributePastePicker).toEqual({ targets: [{ clipId: "clip-1" }, { clipId: "clip-2" }] });
});
