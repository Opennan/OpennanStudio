// The compositor (PreviewPanel) and motion tracking (phase 10d): with the Track tab open the region box replaces the
// tracked item's transform chrome; drags move, resize, or redraw it in the store (no command); the preview
// publishes the overlay boxes it laid out for tracking.apply.
import { fireEvent, waitFor } from "@testing-library/react";
import { optimistic, type TimelineTrack } from "@opennan/timeline-core";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { RecordingContext } from "./test-fixtures";
import { TimelineContext } from "../../provider/context";
import { useContext } from "react";

const fake = {
    isLost: false,
    canvas: { tag: "gl-canvas" },
    upload: vi.fn((_source: unknown, width: number, height: number) => ({ id: "u", width, height })),
    resize: vi.fn((_frame: unknown, width: number, height: number) => ({ id: "r", width, height })),
    lutMix: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    look: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    presentRegion: vi.fn((_frame: unknown, width: number, height: number) => ({ x: 0, y: 0, width, height })),
    releaseAll: vi.fn(),
    onContextLost: () => () => {},
};
vi.mock("../use-look-renderer", () => ({ useLookRenderer: () => fake, lookRendererSupported: () => false }));

const { PreviewPanel } = await import("../preview-panel");

class LoadedImage {
    complete = true;
    naturalWidth = 1280;
    naturalHeight = 720;
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
}

const contexts = new Map<HTMLCanvasElement, RecordingContext>();
beforeEach(() => {
    contexts.clear();
    vi.stubGlobal("ResizeObserver", class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    vi.stubGlobal("Image", LoadedImage);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
        let ctx = contexts.get(this);
        if (!ctx) {
            ctx = new RecordingContext(this);
            contexts.set(this, ctx);
        }
        return ctx as unknown as CanvasRenderingContext2D;
    } as never);
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const VIDEO_1: TimelineTrack = { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 };
const VIDEO_2: TimelineTrack = { type: "video", index: 2, label: "V2", muted: false, locked: false, visible: true, volume: 1 };


async function renderTracked() {
    const runtime = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput(
        { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/still.png", mediaType: "image", scale: 0.5 },
        runtime.projectId, "v2",
    );
    await seedTimeline(runtime, { tracks: [VIDEO_1, VIDEO_2], clips: [clip] });
    runtime.store.getState().setCurrentTime(1.5);
    runtime.store.getState().setSelectedClipIds(new Set(["v2"]));
    runtime.store.getState().setTrackingResult(null);
    runtime.store.getState().setTrackingRegion({ owner: { clipId: "v2" }, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } });
    let anchors: ((ids: string[]) => Record<string, { width: number; height: number } | undefined>) | null = null;
    function Probe() {
        const registry = useContext(TimelineContext)!.overlayAnchors;
        anchors = (ids) => registry.current?.(ids) ?? {};
        return null;
    }
    renderWithTimeline(<><PreviewPanel /><Probe /></>, { runtime });
    const main = () => [...contexts.entries()].find(([canvas]) => canvas.isConnected)?.[1];
    await waitFor(() => expect(main()?.named("setLineDash").some((c) => JSON.stringify(c.args[0]) === "[6,4]")).toBe(true));
    const canvas = [...contexts.keys()].find((c) => c.isConnected)!;
    canvas.setPointerCapture = () => {};
    canvas.hasPointerCapture = () => false;
    canvas.releasePointerCapture = () => {};
    // The region box: the last dashed strokeRect, after a translate to its centre.
    const calls = main()!.calls;
    const rectAt = calls.map((c) => c.name).lastIndexOf("strokeRect");
    const [cx, cy] = calls.slice(0, rectAt).reverse().find((c) => c.name === "translate")!.args as number[];
    const [, , bw, bh] = calls[rectAt].args as number[];
    return { runtime, canvas, cx, cy, bw, bh, anchors: () => anchors! };
}

afterEach(() => {
    window.dispatchEvent(new Event("pointerup"));
});

it("with the Track tab open, a drag inside the region moves it in the store without a command", async () => {
    const { runtime, canvas, cx, cy, bw } = await renderTracked();
    const controller = (await import("../../provider/registry")).getActiveRuntime()!.controller;
    const execute = vi.spyOn(controller, "execute");
    fireEvent.pointerDown(canvas, { clientX: cx, clientY: cy, pointerId: 1 });
    // The item box is five region widths wide: a move of half a region width is 0.1 of the picture.
    fireEvent.pointerMove(window, { clientX: cx + bw / 2, clientY: cy, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: cx + bw / 2, clientY: cy, pointerId: 1 });
    const region = runtime.store.getState().trackingRegion!.region;
    expect(region.x).toBeCloseTo(0.5, 3);
    expect(region.y).toBeCloseTo(0.4, 3);
    expect(execute).not.toHaveBeenCalled();
});

it("dragging on the item outside the region draws a new one; a corner resizes it", async () => {
    const { runtime, canvas, cx, cy, bw, bh } = await renderTracked();
    // From the item's top-left area: 1.5 region sizes left and up of the region centre is source (0.2, 0.2).
    fireEvent.pointerDown(canvas, { clientX: cx - 1.5 * bw, clientY: cy - 1.5 * bh, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: cx - bw, clientY: cy - bh, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: cx - bw, clientY: cy - bh, pointerId: 1 });
    const drawn = runtime.store.getState().trackingRegion!.region;
    expect(drawn.x).toBeCloseTo(0.2, 3);
    expect(drawn.width).toBeCloseTo(0.1, 3);
    expect(drawn.height).toBeCloseTo(0.1, 3);
});

it("publishes the boxes it laid out for tracking.apply", async () => {
    const { anchors } = await renderTracked();
    const box = anchors()(["v2", "missing"]);
    // 1280×720 on the 1920×1080 reference frame at scale 1: two thirds of the frame.
    expect(box.v2!.width).toBeCloseTo(2 / 3, 3);
    expect(box.v2!.height).toBeCloseTo(2 / 3, 3);
    expect(box.missing).toBeUndefined();
});
