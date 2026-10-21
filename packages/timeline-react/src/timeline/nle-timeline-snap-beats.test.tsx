// The toolbar's Snap to beats toggle (phase 11): view.update { snapToBeats }, aria-pressed, beside the snap magnet.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { getActiveEditorStore } from "../provider/registry";
import { DEFAULT_TRANSLATE } from "../i18n/format";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({
  scenesToEngineItems: () => [],
  CanvasTimeline: () => <canvas data-testid="canvas-surface" />,
}));

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: `${type}${index}`, muted: false, locked: false, visible: true, volume: 1 });

describe("Snap to beats toggle", () => {
  beforeEach(() => {
    getActiveEditorStore().getState().resetForProject();
    getActiveEditorStore().getState().setSnapToBeats(false);
  });

  it("turns beat snapping on and off through view.update and says its state", async () => {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [track("video", 1), track("audio", 1)] });
    renderWithTimeline(<NleTimeline />, { runtime, translate: DEFAULT_TRANSLATE });
    const toggle = screen.getByRole("button", { name: "Snap to beats" });
    expect(toggle).toBe(screen.getByTestId("toolbar-snap-to-beats"));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(runtime.store.getState().snapToBeats).toBe(true));
    expect(screen.getByTestId("toolbar-snap-to-beats").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("toolbar-snap-to-beats"));
    await waitFor(() => expect(runtime.store.getState().snapToBeats).toBe(false));
    // It sits right after the snap magnet.
    const magnet = screen.getByRole("button", { name: "Snap on" });
    expect(magnet.closest("span")?.nextElementSibling?.querySelector("[data-testid=toolbar-snap-to-beats]")).toBeTruthy();
  });
});
