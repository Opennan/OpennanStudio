// Behavior coverage for selected-scene cut and one-step undo in the NLE timeline.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveEditorStore } from "../provider/registry";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyOnly, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../test-utils/render-with-timeline";

type TestScene = {
  id: string;
  order: number;
  caption: string;
  startTime: string;
  endTime: string;
  startImageUrl: string | null;
  endImageUrl: string | null;
  videoUrl: string | null;
  sourceVideoUrl?: string | null;
  status: string;
  transition: string;
  cardType?: string | null;
  duration?: number | null;
  frameConsistencyScore: number | null;
  audioUrl: string | null;
  audioText: string | null;
  cardConfig: string | null;
  shotBreakdown?: string | null;
  timelinePositionSeconds?: number;
  trackIndex?: number;
};

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: ({ scenes }: { scenes: TestScene[] }) => (
    <output data-testid="canvas-scenes">
      {JSON.stringify(scenes.map((scene) => ({
        id: scene.id,
        order: scene.order,
        duration: scene.duration,
        start: scene.timelinePositionSeconds,
        cardType: scene.cardType,
        audioUrl: scene.audioUrl,
        shotBreakdown: scene.shotBreakdown,
        cardConfig: scene.cardConfig,
      })))}
    </output>
  ),
}));

function originalScene(): TestScene {
  return {
    id: "scene-1",
    order: 0,
    caption: "Source clip",
    startTime: "00:00:00,000",
    endTime: "00:00:20,000",
    startImageUrl: null,
    endImageUrl: null,
    videoUrl: "https://cdn.example.com/source.mp4",
    sourceVideoUrl: "https://cdn.example.com/source.mp4",
    status: "video_ready",
    transition: "cut",
    cardType: "source_clip",
    duration: 20,
    frameConsistencyScore: null,
    audioUrl: "https://cdn.example.com/source.wav",
    audioText: "dialogue",
    cardConfig: JSON.stringify({ timelineTrimStart: 0 }),
    shotBreakdown: "[]",
    timelinePositionSeconds: 0,
    trackIndex: 1,
  };
}

function readCanvasScenes() {
  return JSON.parse(screen.getByTestId("canvas-scenes").textContent || "[]");
}

const V1 = { type: "video" as const, index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 };
let runtime: TimelineTestRuntime;

describe("NleTimeline selected scene split history behavior", () => {
  beforeEach(async () => {
    getActiveEditorStore().getState().resetForProject();
    getActiveEditorStore().getState().setCurrentTime(10);
    runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [V1], scenes: [originalScene()] });
    runtime.store.getState().selectScene("scene-1");
  });

  it("cuts the selected source scene immediately and sends one atomic split mutation", async () => {
    const release = runtime.recording.hold("splitScene");
    renderWithTimeline(<NleTimeline />, { runtime, translate: keyOnly });

    expect(readCanvasScenes()).toEqual([
      expect.objectContaining({ id: "scene-1", duration: 20, start: 0, cardType: "source_clip" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "splitAtPlayhead (⌘B)" }));

    await waitFor(() => {
      expect(readCanvasScenes()).toEqual([
        expect.objectContaining({ id: "scene-1", duration: 10, start: 0, cardType: "source_clip", shotBreakdown: "[]" }),
        expect.objectContaining({ duration: 10, start: 10, cardType: "source_clip", audioUrl: "https://cdn.example.com/source.wav", shotBreakdown: "[]" }),
      ]);
    });

    await waitFor(() => expect(runtime.recording.callsTo("splitScene")).toHaveLength(1));
    expect(runtime.recording.callsTo("splitScene")[0].args).toEqual(["project-1", "scene-1", 10]);

    release();
    await waitFor(() => {
      expect(readCanvasScenes()).toEqual([
        expect.objectContaining({ id: "scene-1", duration: 10, start: 0 }),
        expect.objectContaining({ id: "srv-1", duration: 10, start: 10 }),
      ]);
    });
  });

  it("restores the full source scene with one undo click after a cut", async () => {
    renderWithTimeline(<NleTimeline />, { runtime, translate: keyOnly });

    fireEvent.click(screen.getByRole("button", { name: "splitAtPlayhead (⌘B)" }));

    await waitFor(() => {
      expect(readCanvasScenes()).toEqual([
        expect.objectContaining({ id: "scene-1", duration: 10, start: 0 }),
        expect.objectContaining({ id: "srv-1", duration: 10, start: 10 }),
      ]);
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "undo (⌘Z)" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "undo (⌘Z)" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("undo")[0].args).toEqual(["project-1", 1]);
      expect(readCanvasScenes()).toEqual([
        expect.objectContaining({ id: "scene-1", duration: 20, start: 0, cardType: "source_clip", audioUrl: "https://cdn.example.com/source.wav" }),
      ]);
    });
  });
});
