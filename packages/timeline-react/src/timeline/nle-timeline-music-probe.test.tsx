import { waitFor } from "@testing-library/react";
import { NleTimeline } from "./nle-timeline";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline } from "../test-utils/render-with-timeline";

const probe = vi.hoisted(() => vi.fn((_url: string, _options?: { resolveUrl?: (u: string) => string; signal?: AbortSignal }) => new Promise<number>(() => {})));
vi.mock("@opennan/timeline-media/audio-duration", () => ({ loadAudioDuration: probe }));
vi.mock("./canvas/canvas-timeline", () => ({ scenesToEngineItems: () => [], CanvasTimeline: () => <canvas /> }));

it("probes music duration through the media environment and aborts on unmount", async () => {
  const runtime = createTimelineTestRuntime();
  await runtime.local.updateProject(runtime.projectId, { musicUrl: "https://cdn.test/m.mp3" });
  runtime.store.getState().setProjectMeta(await runtime.local.loadProject(runtime.projectId));
  const { unmount } = renderWithTimeline(
    <NleTimeline />,
    { runtime, translate: keyEcho, media: { resolveMediaUrl: (u) => `resolved:${u}` } },
  );
  await waitFor(() => expect(probe).toHaveBeenCalled());
  const [url, options] = probe.mock.calls[0];
  expect(url).toBe("https://cdn.test/m.mp3");
  expect(options?.resolveUrl?.("x")).toBe("resolved:x");
  unmount();
  expect(options?.signal?.aborted).toBe(true);
});
