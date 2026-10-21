// Behavior coverage for timeline dead-zone clicks clearing the editor selection.
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveEditorStore } from "../provider/registry";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: () => <canvas data-testid="canvas-surface" />,
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

async function renderTimeline() {
  const runtime = createTimelineTestRuntime();
  await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)] });
  return renderWithTimeline(<NleTimeline />, { runtime, translate: keyEcho });
}

describe("NleTimeline dead-zone deselection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveEditorStore().getState().resetForProject();
  });

  it("mousedown on the track label rail clears the editor selection", async () => {
    getActiveEditorStore().getState().selectScene("scene-1");
    await renderTimeline();

    fireEvent.mouseDown(screen.getByText("V1"), { button: 0 });

    const state = getActiveEditorStore().getState();
    expect(state.selectedSceneId).toBeNull();
    expect(state.selectedClipId).toBeNull();
    expect(state.selectedClipIds.size).toBe(0);
    expect(state.selectedTransition).toBeNull();
    expect(state.selectedAudioTarget).toBeNull();
  });

  it("mousedown on the audio track label clears a selected audio target", async () => {
    getActiveEditorStore().getState().selectAudioTarget("music");
    await renderTimeline();

    fireEvent.mouseDown(screen.getByText("A1"), { button: 0 });

    expect(getActiveEditorStore().getState().selectedAudioTarget).toBeNull();
  });

  it("mousedown on the area below the tracks clears the editor selection", async () => {
    getActiveEditorStore().getState().selectScene("scene-1");
    await renderTimeline();

    fireEvent.mouseDown(screen.getByTestId("timeline-tracks-scroll"), { button: 0 });

    const state = getActiveEditorStore().getState();
    expect(state.selectedSceneId).toBeNull();
    expect(state.selectedAudioTarget).toBeNull();
  });

  it("mousedown on a track control button does not clear the selection", async () => {
    getActiveEditorStore().getState().selectScene("scene-1");
    await renderTimeline();

    // Video and audio tracks both expose a sound button now — any of them works here.
    fireEvent.mouseDown(screen.getAllByRole("button", { name: "mute" })[0], { button: 0 });

    expect(getActiveEditorStore().getState().selectedSceneId).toBe("scene-1");
  });

  it("mousedown on the canvas surface is left to the canvas hit handling", async () => {
    getActiveEditorStore().getState().selectScene("scene-1");
    await renderTimeline();

    fireEvent.mouseDown(screen.getByTestId("canvas-surface"), { button: 0 });

    expect(getActiveEditorStore().getState().selectedSceneId).toBe("scene-1");
  });

  it("right-button mousedown on the rail does not clear the selection", async () => {
    getActiveEditorStore().getState().selectScene("scene-1");
    await renderTimeline();

    fireEvent.mouseDown(screen.getByText("V1"), { button: 2 });

    expect(getActiveEditorStore().getState().selectedSceneId).toBe("scene-1");
  });

  it("modifier mousedown on the rail does not clear the selection", async () => {
    getActiveEditorStore().getState().selectScene("scene-1");
    await renderTimeline();

    fireEvent.mouseDown(screen.getByText("V1"), { button: 0, shiftKey: true });

    expect(getActiveEditorStore().getState().selectedSceneId).toBe("scene-1");
  });
});
