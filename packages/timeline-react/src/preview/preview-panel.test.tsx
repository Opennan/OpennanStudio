import { fireEvent, screen, waitFor } from "@testing-library/react";
import { PreviewPanel } from "./preview-panel";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";

// jsdom 29 has no ResizeObserver, which PreviewPanel constructs unguarded
// (preview-panel.tsx:958), and does not implement media playback. Same stubs as
// scene-preview.behavior.test.tsx:58-63. requestAnimationFrame exists (vitest's
// jsdom runs with pretendToBeVisual).
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("changes the aspect ratio through project.update", async () => {
  const runtime = createTimelineTestRuntime();
  await seedTimeline(runtime, { tracks: [] });
  runtime.store.getState().setProjectMeta(await runtime.local.loadProject(runtime.projectId));
  renderWithTimeline(<PreviewPanel />, { runtime });
  fireEvent.click(screen.getByRole("button", { name: "previewRatio" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /9:16/ }));
  await waitFor(() => expect(runtime.recording.callsTo("updateProject")[0].args).toEqual(["project-1", { aspectRatio: "9:16" }]));
});
