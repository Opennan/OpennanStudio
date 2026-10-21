import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { createEditorStore } from "../store/editor-store";
import type { MotionTrackerHost, TrackingJob, TrackingRunOutput } from "../tracking/host";
import type { TrackingReport } from "../tracking/plan";
import { TimelineController } from "./timeline-controller";

async function setup(tracker?: MotionTrackerHost) {
    let n = 0;
    const local = new LocalBackend({ persistence: createMemoryPersistence(), idFactory: () => `id-${++n}` });
    const store = createEditorStore();
    const controller = new TimelineController({ backend: local, store, projectId: "p1", onToast: vi.fn(), motionTracker: tracker });
    await controller.load();
    const video = await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 1, endTime: 5, mediaType: "video", mediaUrl: "a.mp4" } });
    const text = await controller.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 6, textContent: "hi", positionX: 0.5, positionY: 0.5 } });
    const clips = () => store.getState().timelineData!.clips;
    return { local, store, controller, clips, videoId: video.createdClipIds![0], textId: text.createdClipIds![0] };
}

/** A tracker that moves the point right by 0.05 per second of item time. */
function fakeTracker(log: TrackingJob[] = []): MotionTrackerHost {
    return {
        async track(job, context) {
            log.push(job);
            context.onProgress?.(0.5);
            context.onProgress?.(1);
            const cx = job.region.x + job.region.width / 2;
            const cy = job.region.y + job.region.height / 2;
            const t0 = job.frames[job.startIndex].time;
            return {
                samples: job.frames.map((f) => ({ time: f.time, x: cx + 0.05 * (f.time - t0), y: cy, confidence: 0.95, lost: false })),
                source: { width: 1920, height: 1080 },
            };
        },
        anchors: (ids) => Object.fromEntries(ids.map((id) => [id, { width: 0.2, height: 0.1 }])),
    };
}

describe("tracking.run (controller)", () => {
    it("plans the frames, runs the host's tracker with progress, and changes nothing", async () => {
        const jobs: TrackingJob[] = [];
        const { controller, videoId, store } = await setup(fakeTracker(jobs));
        const before = controller.historyDepth().recorded;
        const progress: number[] = [];
        const result = await controller.execute(
            { type: "tracking.run", clipId: videoId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 1 },
            { onProgress: (p) => progress.push(p.progress ?? -1) },
        );
        expect(result.ok).toBe(true);
        const output = result.output as TrackingRunOutput;
        expect(jobs[0]).toMatchObject({ owner: { clipId: videoId }, mediaUrl: "a.mp4", fps: 30 });
        expect(jobs[0].frames[jobs[0].startIndex]).toEqual({ time: 1, media: 1 });
        expect(output.samples).toHaveLength(jobs[0].frames.length);
        expect(output).toMatchObject({ source: { width: 1920, height: 1080 }, fps: 30, lost: 0 });
        expect(progress).toEqual([0.5, 1]);
        expect(controller.historyDepth().recorded).toBe(before);
        expect(store.getState().canUndo).toBe(true);
    });

    it("is unavailable without a tracker and refuses bad requests", async () => {
        const bare = await setup();
        const none = await bare.controller.execute({ type: "tracking.run", clipId: bare.videoId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 1 });
        expect(none).toMatchObject({ ok: false, unavailable: true, error: expect.stringMatching(/motion tracker/) });
        const { controller, textId, videoId } = await setup(fakeTracker());
        expect((await controller.execute({ type: "tracking.run", clipId: textId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 1 })).ok).toBe(false);
        expect((await controller.execute({ type: "tracking.run", clipId: videoId, region: { x: 0.9, y: 0.4, width: 0.2, height: 0.2 }, time: 1 })).ok).toBe(false);
    });

    it("reports a cancelled job and a host error", async () => {
        const abort = new AbortController();
        const cancelling: MotionTrackerHost = {
            track: async (_job, context) => {
                abort.abort();
                return context.signal?.aborted ? { cancelled: true } : { error: "no" };
            },
        };
        const a = await setup(cancelling);
        const cancelled = await a.controller.execute({ type: "tracking.run", clipId: a.videoId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 0 }, { signal: abort.signal });
        expect(cancelled).toMatchObject({ ok: false, cancelled: true });
        const failing: MotionTrackerHost = { track: async () => { throw new Error("decoder exploded"); } };
        const b = await setup(failing);
        const failed = await b.controller.execute({ type: "tracking.run", clipId: b.videoId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 0 }, { toastOnError: false });
        expect(failed).toMatchObject({ ok: false, error: "decoder exploded" });
        const unavailable: MotionTrackerHost = { track: async () => ({ unavailable: true, error: "this browser cannot decode video" }) };
        const c = await setup(unavailable);
        expect(await c.controller.execute({ type: "tracking.run", clipId: c.videoId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 0 }))
            .toMatchObject({ ok: false, unavailable: true, error: "this browser cannot decode video" });
    });
});

describe("tracking.apply (controller)", () => {
    it("writes follower keyframes in one undo step, with the host's anchors, and persists them", async () => {
        const { controller, clips, videoId, textId, local } = await setup(fakeTracker());
        const run = await controller.execute({ type: "tracking.run", clipId: videoId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 0 });
        const output = run.output as TrackingRunOutput;
        const before = controller.historyDepth().recorded;
        const applied = await controller.execute({ type: "tracking.apply", clipId: videoId, samples: output.samples, source: output.source, followers: [{ clipId: textId }] });
        expect(applied.ok).toBe(true);
        expect(applied.output as TrackingReport).toEqual({ applied: [{ clipId: textId, keyframes: 2 }], skipped: [] });
        expect(controller.historyDepth().recorded).toBe(before + 1);
        const points = parseTimelineKeyframes(clips().find((c) => c.id === textId)!.keyframesJson);
        // The text spans 0-6; the track covers timeline 1-5 (text-local 1-5): 0.2 of the frame over a free space of 0.8.
        expect(points.map((p) => p.time)).toEqual([1, 4.999]);
        expect(points[0].position_x).toBe(0.5);
        expect(points[1].position_x).toBeCloseTo(0.5 + 0.2 / 0.8, 2);
        const stored = (await local.loadTimeline("p1")).clips.find((c) => c.id === textId)!;
        expect(parseTimelineKeyframes(stored.keyframesJson)).toEqual(points);
        await controller.execute({ type: "history.undo" });
        expect(clips().find((c) => c.id === textId)!.keyframesJson ?? null).toBeNull();
    });

    it("fails without an undo entry when no follower can follow", async () => {
        const { controller, videoId, textId, store } = await setup(fakeTracker());
        const tracks = [
            ...store.getState().timelineData!.tracks.filter((t) => t.type !== "text"),
            { type: "text" as const, index: 1, label: "T1", muted: false, locked: true, visible: true, volume: 1 },
        ];
        await controller.execute({ type: "track.update", tracks });
        const before = controller.historyDepth().recorded;
        const samples = [{ time: 0, x: 0.5, y: 0.5, confidence: 1, lost: false }, { time: 2, x: 0.6, y: 0.5, confidence: 1, lost: false }];
        const result = await controller.execute({ type: "tracking.apply", clipId: videoId, samples, followers: [{ clipId: textId }] }, { toastOnError: false });
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/locked/) });
        expect(controller.historyDepth().recorded).toBe(before);
    });
});
