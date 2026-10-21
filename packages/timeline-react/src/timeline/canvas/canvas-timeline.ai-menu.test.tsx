// The clip context menu's AI group (phase 11): the tools that fit the clip with prices, Remove background enabled.
import { cleanup, createEvent, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { optimistic } from "@opennan/timeline-core";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { fakeAiHost } from "../../test-utils/fake-ai-host";
import { DEFAULT_TRANSLATE } from "../../i18n/format";
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

it("right-clicking a video clip shows the AI group with prices and runs Remove background through the host", async () => {
  const runtime = createTimelineTestRuntime();
  runtime.store.getState().resetForProject();
  const first = optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" }, runtime.projectId, "clip-1");
  await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [first] });
  const host = fakeAiHost({ "remove-background": { price: { kind: "estimate", label: "≈ $0.031", usd: 0.031 } } });
  const timeline = runtime.store.getState().timelineData!;
  const result = renderWithTimeline(
    <CanvasTimeline
      scenes={[]} tracks={timeline.tracks} clips={timeline.clips} selectedSceneId={null} zoom={40} totalDuration={10} musicUrl={null} musicVolume={1}
      selectedAudioTarget={null} onSelectClip={vi.fn()} onSelectScene={vi.fn()} onUpdateClips={vi.fn()} onSeek={vi.fn()} onSelectMusic={vi.fn()}
      onSelectVoiceover={vi.fn()} onReorderScenes={vi.fn()} onDeleteClips={vi.fn()}
    />,
    { runtime, translate: DEFAULT_TRANSLATE, ai: host },
  );
  const canvas = result.container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 100, y: 200, left: 100, top: 200, width: 900, height: 180, right: 1000, bottom: 380, toJSON: () => ({}) } as DOMRect);
  const event = createEvent.contextMenu(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: 130 });
  Object.defineProperty(event, "clientY", { value: 252 });
  fireEvent(canvas, event);
  const group = screen.getByRole("group", { name: "AI" });
  const remove = within(group).getByRole("button", { name: /Remove background/ }) as HTMLButtonElement;
  expect(remove.disabled).toBe(false);
  expect(remove.textContent).toBe("Remove background≈ $0.031");
  // The old hard-disabled row is gone: one Remove background in the whole menu.
  expect(screen.getAllByRole("button", { name: /Remove background/ })).toHaveLength(1);
  fireEvent.click(remove);
  expect(host.run).toHaveBeenCalledWith("remove-background", { clipId: "clip-1", background: "transparent" });
  expect(screen.queryByRole("group", { name: "AI" })).toBeNull();
});
