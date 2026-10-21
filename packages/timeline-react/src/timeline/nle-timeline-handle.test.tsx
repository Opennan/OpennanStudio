import { createRef } from "react";
import { act } from "@testing-library/react";
import { NleTimeline } from "./nle-timeline";
import type { TimelineHandle } from "./timeline-handle";
import { keyEcho, renderWithTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({ scenesToEngineItems: () => [], CanvasTimeline: () => <canvas /> }));

it("exposes splitAtPlayhead, addEffectLayer, and addGraphic", () => {
  const ref = createRef<TimelineHandle>();
  renderWithTimeline(<NleTimeline ref={ref} />, { translate: keyEcho });
  expect(typeof ref.current?.splitAtPlayhead).toBe("function");
  act(() => ref.current?.splitAtPlayhead());
  expect(typeof ref.current?.addEffectLayer).toBe("function");
  expect(typeof ref.current?.addGraphic).toBe("function");
});
