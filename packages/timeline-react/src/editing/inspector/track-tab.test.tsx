import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import type { MotionTrackerHost, SceneData, TimelineClip, TimelineTrack, TrackingJob, TrackingJobContext, TrackingJobOutcome } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../../test-utils/render-with-timeline";
import { Inspector } from "./inspector";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration: 4, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: 0.001, trackIndex: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);
const slider = (testId: string) => within(screen.getByTestId(testId)).getByRole("slider") as HTMLInputElement;

/** A tracker that moves the point right by 0.1 of the picture per second; `gate` holds it until released. */
function fakeTracker(gate?: Promise<void>): MotionTrackerHost & { jobs: TrackingJob[] } {
    const jobs: TrackingJob[] = [];
    return {
        jobs,
        async track(job: TrackingJob, context: TrackingJobContext): Promise<TrackingJobOutcome> {
            jobs.push(job);
            context.onProgress?.(0.4);
            if (gate) await gate;
            if (context.signal?.aborted) return { cancelled: true };
            const cx = job.region.x + job.region.width / 2;
            const t0 = job.frames[job.startIndex].time;
            return { samples: job.frames.map((f) => ({ time: f.time, x: cx + 0.1 * (f.time - t0), y: 0.5, confidence: 1, lost: false })), source: { width: 1920, height: 1080 } };
        },
    };
}

async function setup(select: { clip?: string; scene?: string }, tracker: MotionTrackerHost | null, extra: { mask?: boolean } = {}) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("text", 1), track("sticker", 1), track("effect", 1)],
        scenes: [scene("a"), scene("shots", { sourceVideoUrl: null, cardType: "ai_video", timelinePositionSeconds: 10 })],
        clips: [
            clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/m/v.mp4", mediaType: "video", ...(extra.mask ? { maskJson: '{"shape":"circle"}' } : {}) }),
            clip("img", { trackType: "video", trackIndex: 2, startTime: 5, endTime: 6, mediaUrl: "/m/i.png", mediaType: "image" }),
            clip("txt", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Hello", mediaType: "text", positionX: 0.5, positionY: 0.5 }),
            clip("fx", { trackType: "effect", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "effect", label: "Glow" }),
            clip("later", { trackType: "sticker", trackIndex: 1, startTime: 8, endTime: 9, mediaType: "image", mediaUrl: "/m/s.png" }),
        ],
    });
    const state = runtime.store.getState();
    // The shared test store keeps view state between tests.
    state.setTrackingResult(null);
    state.setTrackingRegion(null);
    state.setProjectMeta({ id: "project-1", name: "P", musicUrl: null, musicVolume: 1, aspectRatio: "16:9" });
    if (select.clip) state.setSelectedClipIds(new Set([select.clip]));
    if (select.scene) state.selectScene(select.scene);
    state.setCurrentTime(1);
    renderWithTimeline(<Inspector />, { runtime, motionTracker: tracker });
    return runtime;
}

const openTrack = () => fireEvent.click(screen.getByTestId("inspector-tab-track"));
const keyframesOf = (runtime: TimelineTestRuntime, id: string) => parseTimelineKeyframes(runtime.store.getState().timelineData!.clips.find((c) => c.id === id)!.keyframesJson);

describe("Track tab", () => {
    it("is offered for video clips and scenes with one video, not for images, text, or shot-by-shot scenes", async () => {
        const runtime = await setup({ clip: "v" }, fakeTracker());
        expect(screen.getByTestId("inspector-tab-track")).toBeTruthy();
        for (const id of ["img", "txt"]) {
            act(() => runtime.store.getState().setSelectedClipIds(new Set([id])));
            await waitFor(() => expect(screen.queryByTestId("inspector-tab-track")).toBeNull(), { timeout: 5000 });
        }
        act(() => runtime.store.getState().selectScene("a"));
        await waitFor(() => expect(screen.getByTestId("inspector-tab-track")).toBeTruthy(), { timeout: 5000 });
        act(() => runtime.store.getState().selectScene("shots"));
        await waitFor(() => expect(screen.queryByTestId("inspector-tab-track")).toBeNull(), { timeout: 5000 });
    });

    it("puts a region box on the preview while open and edits it from the keyboard", async () => {
        const runtime = await setup({ clip: "v" }, fakeTracker());
        expect(runtime.store.getState().trackingRegion).toBeNull();
        openTrack();
        const region = runtime.store.getState().trackingRegion!;
        expect(region.owner).toEqual({ clipId: "v" });
        expect(region.region.height).toBeCloseTo(0.2, 4);
        fireEvent.change(slider("track-region-x"), { target: { value: "10" } });
        expect(runtime.store.getState().trackingRegion!.region.x).toBeCloseTo(0.1, 6);
        fireEvent.change(slider("track-region-width"), { target: { value: "95" } });
        const after = runtime.store.getState().trackingRegion!.region;
        expect(after.width).toBeCloseTo(0.95, 6);
        expect(after.x).toBeCloseTo(0.05, 6);
        fireEvent.click(screen.getByTestId("inspector-tab-video"));
        expect(runtime.store.getState().trackingRegion).toBeNull();
    });

    it("tracks from the playhead, then applies the track to checked followers in one step", async () => {
        const tracker = fakeTracker();
        const runtime = await setup({ clip: "v" }, tracker);
        openTrack();
        // Followers: overlapping clips only; effect layers are listed but cannot follow; no mask yet.
        const list = screen.getByTestId("track-followers");
        expect(within(list).getByTestId("track-follower-txt")).toBeTruthy();
        expect((within(list).getByTestId("track-follower-fx") as HTMLInputElement).disabled).toBe(true);
        expect(within(list).queryByTestId("track-follower-later")).toBeNull();
        expect((within(list).getByTestId("track-follower-mask") as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId("track-apply") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId("track-run"));
        await waitFor(() => expect(screen.getByTestId("track-status").textContent).toMatch(/track_done/));
        expect(tracker.jobs[0].frames[tracker.jobs[0].startIndex].time).toBe(1);
        expect(runtime.store.getState().trackingResult?.samples.length).toBe(tracker.jobs[0].frames.length);
        fireEvent.click(screen.getByTestId("track-follower-txt"));
        fireEvent.click(screen.getByTestId("track-apply"));
        await waitFor(() => expect(screen.getByTestId("track-status").textContent).toMatch(/track_applied/));
        const points = keyframesOf(runtime, "txt");
        expect(points[0]).toMatchObject({ time: 0, position_y: 0.5 });
        expect(points[points.length - 1].position_x).toBeGreaterThan(points[0].position_x as number);
    });

    it("shows progress and cancels a running track", async () => {
        let release!: () => void;
        const tracker = fakeTracker(new Promise<void>((resolve) => { release = resolve; }));
        const runtime = await setup({ clip: "v" }, tracker);
        openTrack();
        fireEvent.click(screen.getByTestId("track-run"));
        await waitFor(() => expect(screen.getByTestId("track-progress").getAttribute("aria-valuenow")).toBe("40"));
        fireEvent.click(screen.getByTestId("track-cancel"));
        expect(screen.queryByTestId("track-progress")).toBeNull();
        release();
        await waitFor(() => expect(screen.getByTestId("track-run")).toBeTruthy());
        expect(runtime.store.getState().trackingResult).toBeNull();
    });

    it("explains when tracking is not available", async () => {
        await setup({ clip: "v" }, null);
        openTrack();
        fireEvent.click(screen.getByTestId("track-run"));
        await waitFor(() => expect(screen.getByTestId("track-status").textContent).toMatch(/track_unavailable/));
    });

    it("lets the clip's own mask follow", async () => {
        const runtime = await setup({ clip: "v" }, fakeTracker(), { mask: true });
        openTrack();
        fireEvent.click(screen.getByTestId("track-run"));
        await waitFor(() => expect(runtime.store.getState().trackingResult).not.toBeNull());
        fireEvent.click(screen.getByTestId("track-follower-mask"));
        fireEvent.click(screen.getByTestId("track-apply"));
        await waitFor(() => expect(keyframesOf(runtime, "v").some((p) => typeof p.mask_x === "number")).toBe(true));
    });
});
