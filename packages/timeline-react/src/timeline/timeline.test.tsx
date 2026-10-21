import { createRef } from "react";
import { screen } from "@testing-library/react";
import { Timeline } from "./timeline";
import type { TimelineHandle } from "./timeline-handle";
import { renderWithTimeline } from "../test-utils/render-with-timeline";

vi.mock("./canvas/canvas-timeline", () => ({ CanvasTimeline: () => <canvas data-testid="canvas" /> }));

it("renders the timeline inside the error boundary and forwards the handle", () => {
  const ref = createRef<TimelineHandle>();
  renderWithTimeline(<Timeline ref={ref} className="h-64" />);
  expect(screen.getByTestId("canvas")).toBeInTheDocument();
  expect(screen.getByTestId("timeline-tracks-scroll")).toBeInTheDocument();
  expect(typeof ref.current?.splitAtPlayhead).toBe("function");
});
