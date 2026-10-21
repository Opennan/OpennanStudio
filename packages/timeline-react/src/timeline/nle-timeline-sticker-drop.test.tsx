// A sticker card dropped on the timeline becomes a bundled-sticker clip at the drop time and track.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveEditorStore } from "../provider/registry";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: ({ onTrackDrop }: { onTrackDrop?: (trackType: string, trackIndex: number, time: number, data: Record<string, unknown>) => void }) => (
    <div>
      <button type="button" onClick={() => onTrackDrop?.("sticker", 2, 4.5, { kind: "sticker", stickerId: "twemoji:1f60d", name: "Heart eyes" })}>
        drop sticker on S2
      </button>
      <button type="button" onClick={() => onTrackDrop?.("sticker", 0, 1.25, { kind: "sticker", stickerId: "opennan:arrow-right", name: "Arrow" })}>
        drop sticker off-track
      </button>
    </div>
  ),
}));

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({
  type, index, label: `${type[0]?.toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1,
});

describe("NleTimeline sticker drop", () => {
  beforeEach(() => {
    getActiveEditorStore().getState().resetForProject();
  });

  it("creates the sticker clip on the sticker track under the drop, at the drop time", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1), track("sticker", 1), track("sticker", 2)] });
    renderWithTimeline(<NleTimeline />, { runtime, translate: keyEcho });
    fireEvent.click(screen.getByRole("button", { name: "drop sticker on S2" }));
    await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
    expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({
      trackType: "sticker", trackIndex: 2, startTime: 4.5, endTime: 7.5, mediaType: "sticker", stickerId: "twemoji:1f60d",
    });
  });

  it("adds a sticker track when the drop is not on one and the project has none", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)] });
    renderWithTimeline(<NleTimeline />, { runtime, translate: keyEcho });
    fireEvent.click(screen.getByRole("button", { name: "drop sticker off-track" }));
    await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
    expect(runtime.store.getState().timelineData!.tracks.some((t) => t.type === "sticker" && t.index === 1)).toBe(true);
    expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({ trackType: "sticker", trackIndex: 1, startTime: 1.25, stickerId: "opennan:arrow-right" });
  });
});
