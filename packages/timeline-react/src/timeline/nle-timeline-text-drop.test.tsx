// A text template card dropped on the timeline becomes the template's text clip at the drop time and track.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAnimationSpec } from "@opennan/timeline-core/motion/animation-spec";
import { textTemplateById } from "@opennan/timeline-core/text/templates";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { getActiveEditorStore } from "../provider/registry";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: ({ onTrackDrop }: { onTrackDrop?: (trackType: string, trackIndex: number, time: number, data: Record<string, unknown>) => void }) => (
    <div>
      <button type="button" onClick={() => onTrackDrop?.("text", 2, 3.25, { kind: "text-template", templateId: "yellow_pop", name: "Yellow pop" })}>
        drop template on T2
      </button>
      <button type="button" onClick={() => onTrackDrop?.("video", 1, 1, { kind: "text-template", templateId: "plain", name: "Plain" })}>
        drop template off-track
      </button>
    </div>
  ),
}));

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({
  type, index, label: `${type[0]?.toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1,
});

describe("NleTimeline text template drop", () => {
  beforeEach(() => {
    getActiveEditorStore().getState().resetForProject();
  });

  it("creates the template's text clip on the text track under the drop, at the drop time", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1), track("text", 1), track("text", 2)] });
    renderWithTimeline(<NleTimeline />, { runtime, translate: keyEcho });
    fireEvent.click(screen.getByRole("button", { name: "drop template on T2" }));
    await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
    const tpl = textTemplateById("yellow_pop")!;
    expect(runtime.recording.callsTo("createClips")[0].args[1][0]).toMatchObject({
      trackType: "text", trackIndex: 2, startTime: 3.25, textContent: tpl.defaultText, textStyle: JSON.stringify(tpl.style), animationJson: serializeAnimationSpec(tpl.animation!),
    });
  });

  it("adds a text track when the drop is not on one and the project has none", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)] });
    renderWithTimeline(<NleTimeline />, { runtime, translate: keyEcho });
    fireEvent.click(screen.getByRole("button", { name: "drop template off-track" }));
    await waitFor(() => expect(runtime.recording.callsTo("createClips")).toHaveLength(1));
    expect(runtime.store.getState().timelineData!.tracks.some((t) => t.type === "text" && t.index === 1)).toBe(true);
  });
});
