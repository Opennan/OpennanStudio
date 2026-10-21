import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useContext } from "react";
import { createEditorStore } from "@opennan/timeline-core";
import { TimelineProvider } from "./timeline-provider";
import { TimelineContext } from "./context";
import { createLocalStorageMarkerStorage } from "./marker-storage";
import { useEditorStore, useEditorStoreApi } from "../hooks/use-editor-store";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { useTimelineToast } from "../hooks/use-timeline-toast";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { createTimelineTestRuntime, keyEcho, renderWithTimeline } from "../test-utils/render-with-timeline";
import { getActiveEditorStore } from "./registry";

function Probe() {
  const t = useTimelineMessages("timeline");
  const zoom = useEditorStore((s) => s.timelineZoom);
  const toast = useTimelineToast();
  const controller = useTimelineController();
  const api = useEditorStoreApi();
  return (
    <div>
      <span data-testid="label">{t("undo")}</span>
      <span data-testid="zoom">{zoom}</span>
      <button onClick={() => toast.warning(t("redo"))}>warn</button>
      <button onClick={() => void controller.execute({ type: "view.update", zoom: 99 })}>zoom</button>
      <span data-testid="same">{String(api === getActiveEditorStore())}</span>
    </div>
  );
}

describe("TimelineProvider", () => {
  it("provides messages, store, toasts, and the controller", async () => {
    const runtime = createTimelineTestRuntime();
    render(
      <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store} onToast={runtime.onToast}>
        <Probe />
      </TimelineProvider>,
    );
    expect(screen.getByTestId("label")).toHaveTextContent("Undo");
    await waitFor(() => expect(runtime.store.getState().timelineData).not.toBeNull());
    act(() => screen.getByText("warn").click());
    expect(runtime.onToast).toHaveBeenCalledWith({ kind: "warning", message: "Redo" });
    act(() => screen.getByText("zoom").click());
    expect(screen.getByTestId("zoom")).toHaveTextContent("99");
    expect(screen.getByTestId("same")).toHaveTextContent("true");
  });

  it("uses a host translate function when given", () => {
    const runtime = createTimelineTestRuntime();
    render(
      <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} translate={keyEcho} autoLoad={false}>
        <Probe />
      </TimelineProvider>,
    );
    expect(screen.getByTestId("label")).toHaveTextContent("undo");
  });

  it("localizes controller failure toasts", async () => {
    const runtime = createTimelineTestRuntime();
    runtime.recording.failNext("createClips");
    let controllerRef: ReturnType<typeof useTimelineController> | null = null;
    function Grab() {
      controllerRef = useTimelineController();
      return null;
    }
    render(
      <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store}
        onToast={runtime.onToast} messages={{ timeline: { clipCreateFailed: "Clip konnte nicht erstellt werden" } }}>
        <Grab />
      </TimelineProvider>,
    );
    await waitFor(() => expect(runtime.store.getState().timelineData).not.toBeNull());
    await act(async () => {
      await controllerRef!.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 } });
    });
    expect(runtime.onToast).toHaveBeenCalledWith({ kind: "error", message: "Clip konnte nicht erstellt werden" });
  });

  it("calls onInspect when the user selects something", async () => {
    const runtime = createTimelineTestRuntime();
    const onInspect = vi.fn();
    const store = createEditorStore();
    render(
      <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={store} onInspect={onInspect} autoLoad={false}>
        <span />
      </TimelineProvider>,
    );
    act(() => store.getState().selectClip("c1"));
    expect(onInspect).toHaveBeenCalledWith({ kind: "clip", id: "c1" });
  });

  it("creates a portal container with the scope classes", () => {
    const runtime = createTimelineTestRuntime();
    const { unmount } = render(
      <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} autoLoad={false}>
        <span />
      </TimelineProvider>,
    );
    const portal = document.body.querySelector(".opennan-studio-portal");
    expect(portal?.getAttribute("data-on-theme")).toBe("dark");
    unmount();
    expect(document.body.querySelector(".opennan-studio-portal")).toBeNull();
  });

  it("still executes commands under React.StrictMode", async () => {
    const runtime = createTimelineTestRuntime({ store: createEditorStore() });
    let controllerRef: ReturnType<typeof useTimelineController> | null = null;
    function Grab() {
      controllerRef = useTimelineController();
      return null;
    }
    render(
      <StrictMode>
        <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store} onToast={runtime.onToast}>
          <Grab />
        </TimelineProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(runtime.store.getState().timelineData).not.toBeNull());
    let ok = false;
    await act(async () => {
      ok = (await controllerRef!.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 } })).ok;
    });
    expect(ok).toBe(true);
  });

  it("keeps the provider across rerender() in renderWithTimeline", () => {
    function Probe2({ n }: { n: number }) {
      const inside = useContext(TimelineContext) !== null;
      return <span data-testid="probe">{`${inside ? "inside" : "outside"}-${n}`}</span>;
    }
    const view = renderWithTimeline(<Probe2 n={1} />);
    view.rerender(<Probe2 n={2} />);
    expect(screen.getByTestId("probe")).toHaveTextContent("inside-2");
  });

  it("loads and saves markers through markerStorage", () => {
    const runtime = createTimelineTestRuntime({ store: createEditorStore() });
    localStorage.setItem("test-markers:p1", JSON.stringify([{ id: "m1", time: 2, label: "M1" }]));
    const { unmount } = render(
      <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store}
        markerStorage={createLocalStorageMarkerStorage("test-markers:")} autoLoad={false}>
        <span />
      </TimelineProvider>,
    );
    expect(runtime.store.getState().timelineMarkers.map((m) => m.id)).toEqual(["m1"]);
    act(() => runtime.store.getState().addTimelineMarker(4));
    expect(JSON.parse(localStorage.getItem("test-markers:p1") ?? "[]").map((m: { time: number }) => m.time)).toEqual([2, 4]);
    unmount();
    expect(runtime.store.getState().timelineMarkers).toEqual([]);
    localStorage.removeItem("test-markers:p1");
  });
});
