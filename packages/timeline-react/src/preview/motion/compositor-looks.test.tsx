// The compositor (PreviewPanel) grades V2+ clips through the shared looks renderer: Adjust keyframes
// cross-fade the keyframes' CLUTs (LookRenderer.lutMix) before the rest of the look, like the main track.
import { waitFor } from "@testing-library/react";
import { optimistic, type TimelineTrack } from "@opennan/timeline-core";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { keyframeLut } from "../lane-look-plan";
import { RecordingContext } from "./test-fixtures";

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

const VIDEO_2: TimelineTrack = { type: "video", index: 2, label: "V2", muted: false, locked: false, visible: true, volume: 1 };
const VIDEO_1: TimelineTrack = { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 };

it("an image clip on V2 with Adjust keyframes is drawn through the CLUT mix at the eased weight", async () => {
    const runtime = createTimelineTestRuntime();
    const clip = {
        ...optimistic.optimisticTimelineClipFromInput(
            { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/still.png", mediaType: "image" }, runtime.projectId, "v2",
        ),
        keyframesJson: JSON.stringify([{ time: 1, adj_contrast: 0 }, { time: 3, adj_contrast: 50, easing: 0 }]),
    };
    await seedTimeline(runtime, { tracks: [VIDEO_1, VIDEO_2], clips: [clip] });
    runtime.store.getState().setCurrentTime(1.5);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(fake.lutMix).toHaveBeenCalled());
    const [, a, b, w] = fake.lutMix.mock.calls.at(-1) as [unknown, { key: string }, { key: string }, number];
    const points = parseTimelineKeyframes(clip.keyframesJson);
    const saved = runtime.store.getState().timelineData!.clips.find((c) => c.id === "v2")!;
    const source = { kind: "clip" as const, ...saved };
    expect(a.key).toBe(keyframeLut(source, points, 1).key);
    expect(b.key).toBe(keyframeLut(source, points, 3).key);
    expect(a.key).not.toBe(b.key);
    expect(w).toBeCloseTo(0.25, 6);
    expect(fake.presentRegion).toHaveBeenCalled();
});
