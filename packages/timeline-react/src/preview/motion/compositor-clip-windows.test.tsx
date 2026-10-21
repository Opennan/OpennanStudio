// The compositor (PreviewPanel) draws a transition window between touching V2 clips joined by a library
// transition: both clips placed on clear frame-sized layers, blended by the LookRenderer with 4 channels
// (motion/clip-window-draw.ts). Outside the window each clip draws alone, as before.
import { act, waitFor } from "@testing-library/react";
import { FrameSnapshots } from "@opennan/timeline-media/looks/frame-snapshots";
import { optimistic, type TimelineTrack } from "@opennan/timeline-core";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { RecordingContext } from "./test-fixtures";

const fake = {
    isLost: false,
    canvas: { tag: "gl-canvas" },
    upload: vi.fn((_source: unknown, width: number, height: number) => ({ id: "u", width, height })),
    resize: vi.fn((_frame: unknown, width: number, height: number) => ({ id: "r", width, height })),
    lutMix: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    look: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    transition: vi.fn((a: unknown, ..._rest: unknown[]) => a),
    presentRegion: vi.fn((_frame: unknown, width: number, height: number) => ({ x: 0, y: 0, width, height })),
    releaseAll: vi.fn(),
    onContextLost: () => () => {},
};
vi.mock("../use-look-renderer", () => ({ useLookRenderer: () => fake, lookRendererSupported: () => false }));

const { PreviewPanel } = await import("../preview-panel");

/** A decoded still (jsdom never loads images). */
class LoadedImage {
    complete = true;
    naturalWidth = 64;
    naturalHeight = 36;
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
}

beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    vi.stubGlobal("Image", LoadedImage);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const contexts = new Map<HTMLCanvasElement, RecordingContext>();
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

async function render(time: number) {
    const runtime = createTimelineTestRuntime();
    const image = (id: string, start: number, end: number, patch: Record<string, unknown> = {}) => optimistic.optimisticTimelineClipFromInput(
        { trackType: "video", trackIndex: 2, startTime: start, endTime: end, mediaUrl: `/${id}.png`, mediaType: "image", ...patch }, runtime.projectId, id,
    );
    await seedTimeline(runtime, { tracks: [VIDEO_1, VIDEO_2], clips: [image("a", 0, 2, { transitionType: "wipe_left", transitionDuration: 1 }), image("b", 2, 4)] });
    runtime.store.getState().setCurrentTime(time);
    renderWithTimeline(<PreviewPanel />, { runtime });
    return runtime;
}

it("inside the window both clips go onto clear layers and blend through the shared transition (RGBA)", async () => {
    await render(2.25);
    await waitFor(() => expect(fake.transition).toHaveBeenCalled());
    const [a, b, def, p, channels] = fake.transition.mock.calls.at(-1) as unknown as [{ width: number; height: number }, { width: number; height: number }, { id: string }, number, number];
    expect(def.id).toBe("wipe_left");
    expect(p).toBeCloseTo(0.75, 6);
    expect(channels).toBe(4);
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    expect(fake.presentRegion).toHaveBeenCalled();
});

it("outside the window each clip draws alone, without the transition", async () => {
    await render(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.transition).not.toHaveBeenCalled();
});

it("going hidden disposes the window decoders and snapshots (they stop buffering)", async () => {
    const dispose = vi.spyOn(FrameSnapshots.prototype, "dispose");
    const beginDraw = vi.spyOn(FrameSnapshots.prototype, "beginDraw");
    await render(2.25);
    await waitFor(() => expect(fake.transition).toHaveBeenCalled());
    // Every snapshot set that drew (the compositor's windows, the main-track overlay's) is released on hide.
    const drawing = new Set(beginDraw.mock.contexts);
    expect(drawing.size).toBeGreaterThan(0);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    const disposed = new Set(dispose.mock.contexts);
    for (const snapshots of drawing) expect(disposed.has(snapshots)).toBe(true);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
});
