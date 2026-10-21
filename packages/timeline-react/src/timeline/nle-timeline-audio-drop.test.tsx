// Behavior coverage for audio drops and base audio-track repair in the parent NLE timeline.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveEditorStore } from "../provider/registry";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: ({
    onTrackDrop,
  }: {
    onTrackDrop?: (trackType: string, trackIndex: number, time: number, data: Record<string, unknown>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onTrackDrop?.("audio", 1, 4, {
        mediaType: "audio",
        sourceType: "music",
        url: "/generated-music.mp3",
        name: "Generated Music",
        duration: 9,
      })}
    >
      drop audio on A1
    </button>
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

describe("NleTimeline audio drop behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveEditorStore().getState().resetForProject();
    vi.stubGlobal("Audio", class {
      duration = 9;
      preload = "";
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";

      constructor() {
        setTimeout(() => this.onloadedmetadata?.(), 0);
      }

      pause() {}
    });
  });

  it("repairs a partial persisted track list by adding missing A1 before inserting audio", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1)] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop audio on A1" }));

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateTracks")[0].args[1]).toEqual([
        expect.objectContaining({ type: "video", index: 1, label: "V1" }),
        expect.objectContaining({ type: "audio", index: 1, label: "A1" }),
      ]);
    });
    await waitFor(() => {
      expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({
        trackType: "audio",
        trackIndex: 1,
        startTime: 4,
        endTime: 13,
        mediaUrl: "/generated-music.mp3",
      });
    });
  });

  it("does not redirect an audio drop from locked A1 into an auto-created A2 lane", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [
      track("video", 1),
      { ...track("audio", 1), locked: true },
    ] });
    const { onToast } = renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.click(screen.getByRole("button", { name: "drop audio on A1" }));

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: "clipCreateFailed" }));
    });
    expect(runtime.recording.callsTo("updateTracks")).toHaveLength(0);
    expect(runtime.recording.callsTo("createClips")).toHaveLength(0);
  });

  it("persists context-menu changes for a repaired A1 track", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1)] });
    renderWithTimeline(
      <NleTimeline />,
      { runtime, translate: keyEcho },
    );

    fireEvent.contextMenu(screen.getByText("A1"));
    const muteButtons = await screen.findAllByRole("button", { name: "mute" });
    fireEvent.click(muteButtons[muteButtons.length - 1]);

    await waitFor(() => {
      expect(runtime.recording.callsTo("updateTracks")[0].args[1]).toEqual([
        expect.objectContaining({ type: "video", index: 1, label: "V1" }),
        expect.objectContaining({ type: "audio", index: 1, label: "A1", muted: true }),
      ]);
    });
  });
});
