// The clip context menu's speed presets run speed.set (phase 10b review M4): the length follows the speed.
import { cleanup, createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { optimistic } from "@opennan/timeline-core";
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

async function openClipMenu() {
  const runtime = createTimelineTestRuntime();
  runtime.store.getState().resetForProject();
  const keyframes = JSON.stringify({ keyframes: [{ time: 2, scale: 2 }] });
  const first = { ...optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "video", mediaUrl: "a.mp4" }, runtime.projectId, "clip-1"), speedRamp: "hero", keyframesJson: keyframes };
  const second = optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 1, startTime: 4, endTime: 6, mediaType: "video", mediaUrl: "b.mp4" }, runtime.projectId, "clip-2");
  await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)], clips: [first, second] });
  const onUpdateClips = vi.fn();
  const timeline = runtime.store.getState().timelineData!;
  const result = renderWithTimeline(
    <CanvasTimeline
      scenes={[]} tracks={timeline.tracks} clips={timeline.clips} selectedSceneId={null} zoom={40} totalDuration={10} musicUrl={null} musicVolume={1}
      selectedAudioTarget={null} onSelectClip={vi.fn()} onSelectScene={vi.fn()} onUpdateClips={onUpdateClips} onSeek={vi.fn()} onSelectMusic={vi.fn()}
      onSelectVoiceover={vi.fn()} onReorderScenes={vi.fn()} onDeleteClips={vi.fn()}
    />,
    { runtime, translate: keyEchoExcept(["ghostEffect", "ghostGraphic", "ghostTransition"]) },
  );
  const canvas = result.container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 100, y: 200, left: 100, top: 200, width: 900, height: 180, right: 1000, bottom: 380, toJSON: () => ({}) } as DOMRect);
  const event = createEvent.contextMenu(canvas, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: 130 });
  Object.defineProperty(event, "clientY", { value: 252 });
  fireEvent(canvas, event);
  const clips = () => runtime.store.getState().timelineData!.clips;
  return { runtime, onUpdateClips, clips };
}

it("2x halves the clip's source-length, clears its ramp, and rescales its keyframes as one speed.set", async () => {
  const { runtime, onUpdateClips, clips } = await openClipMenu();
  fireEvent.click(screen.getByRole("button", { name: "setSpeedDouble" }));
  // The legacy hero ramp (mean speed 0.79) played 3.16 s of source in 4 s: at 2x that is 1.58 s.
  await waitFor(() => expect(clips()[0]).toMatchObject({ startTime: 0, endTime: 1.58, playbackSpeed: 2, speedRamp: "none" }));
  expect(clips()[0].speedCurveJson ?? null).toBeNull();
  expect(JSON.parse(clips()[0].keyframesJson!).keyframes[0].time).toBeLessThan(2);
  expect(onUpdateClips).not.toHaveBeenCalled();
  await waitFor(() => expect(runtime.recording.callsTo("updateClips")).toHaveLength(1));
});

it("a ramp preset applies the matching curve at 1x and pushes the next clip when the clip grows", async () => {
  const { onUpdateClips, clips } = await openClipMenu();
  fireEvent.click(screen.getByRole("button", { name: "setSpeedRampHero" }));
  await waitFor(() => expect(JSON.parse(clips()[0].speedCurveJson ?? "{}").id).toBe("hero"));
  const [first, second] = clips();
  expect(first.playbackSpeed).toBe(1);
  expect(second.startTime).toBeCloseTo(Math.max(4, first.endTime), 6);
  expect(onUpdateClips).not.toHaveBeenCalled();
});
