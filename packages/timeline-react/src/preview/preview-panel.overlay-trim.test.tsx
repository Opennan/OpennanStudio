// V2+ video overlays in the compositor (PreviewPanel) play from the clip's trimStart: the element's currentTime is
// trimStart + S(local), as both exports read it. jsdom media: readyState is stubbed, currentTime writes are recorded.
import { waitFor } from "@testing-library/react";
import { optimistic, type TimelineTrack } from "@opennan/timeline-core";
import { PreviewPanel } from "./preview-panel";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../test-utils/render-with-timeline";
import { RecordingContext } from "./motion/test-fixtures";

const seeks: Array<{ src: string; time: number }> = [];

beforeEach(() => {
    seeks.length = 0;
    vi.stubGlobal("ResizeObserver", class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockReturnValue(0);
    vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(function (this: HTMLMediaElement, time: number) {
        seeks.push({ src: this.dataset.srcKey ?? this.getAttribute("src") ?? "", time });
    });
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const VIDEO_1: TimelineTrack = { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 };
const VIDEO_2: TimelineTrack = { type: "video", index: 2, label: "V2", muted: false, locked: false, visible: true, volume: 1 };

/** The media second the compositor seeks the overlay's element to, paused at timeline `time`. */
async function overlaySeek(patch: Record<string, unknown>, time: number): Promise<number> {
    const runtime = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput(
        { trackType: "video", trackIndex: 2, startTime: 1, endTime: 3, mediaUrl: "/overlay.mp4", mediaType: "video", ...patch }, runtime.projectId, "o",
    );
    await seedTimeline(runtime, { tracks: [VIDEO_1, VIDEO_2], clips: [clip] });
    runtime.store.getState().setCurrentTime(time);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(seeks.some((s) => s.src === "/overlay.mp4")).toBe(true));
    return seeks.filter((s) => s.src === "/overlay.mp4").at(-1)!.time;
}

it("a trimmed overlay shows trimStart + local time", async () => {
    expect(await overlaySeek({ trimStart: 2, trimEnd: 4 }, 1.5)).toBeCloseTo(2.5, 6);
});

it("a trimmed overlay at 2× shows trimStart + 2 × local time", async () => {
    expect(await overlaySeek({ trimStart: 2, playbackSpeed: 2 }, 1.5)).toBeCloseTo(3, 6);
});

it("an untrimmed overlay still plays from media zero", async () => {
    expect(await overlaySeek({}, 1.5)).toBeCloseTo(0.5, 6);
});
