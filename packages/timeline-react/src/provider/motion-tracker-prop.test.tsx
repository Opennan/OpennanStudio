import { render, waitFor } from "@testing-library/react";
import { useContext } from "react";
import { TimelineProvider } from "./timeline-provider";
import { TimelineContext, type TimelineContextValue } from "./context";
import { createTimelineTestRuntime } from "../test-utils/render-with-timeline";
import type { MotionTrackerHost, TrackingJob } from "@opennan/timeline-core";

function Capture({ onValue }: { onValue(value: TimelineContextValue): void }) {
    onValue(useContext(TimelineContext)!);
    return null;
}

describe("TimelineProvider motionTracker", () => {
    it("routes tracking.run to the latest motionTracker prop and gives tracking.apply the preview's anchors", async () => {
        const runtime = createTimelineTestRuntime();
        let value: TimelineContextValue | null = null;
        const host: MotionTrackerHost = {
            track: vi.fn(async (job: TrackingJob) => ({ samples: job.frames.map((f) => ({ time: f.time, x: 0.5, y: 0.5, confidence: 1, lost: false })), source: { width: 640, height: 360 } })),
        };
        const view = (motionTracker?: MotionTrackerHost | null) => (
            <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store} motionTracker={motionTracker}>
                <Capture onValue={(v) => { value = v; }} />
            </TimelineProvider>
        );
        const { rerender } = render(view(host));
        await waitFor(() => expect(runtime.store.getState().timelineData).not.toBeNull());
        const controller = value!.controller;
        const created = await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaType: "video", mediaUrl: "a.mp4" } });
        const clipId = created.createdClipIds![0];
        const run = { type: "tracking.run", clipId, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, time: 0 } as const;
        expect(await controller.execute(run)).toMatchObject({ ok: true, output: { source: { width: 640, height: 360 } } });
        expect(host.track).toHaveBeenCalledTimes(1);
        // The preview registers the overlay boxes it laid out; the controller asks for followers without one.
        value!.overlayAnchors.current = (ids) => Object.fromEntries(ids.map((id) => [id, { width: 0.25, height: 0.1 }]));
        const text = await controller.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "hi" } });
        const samples = [{ time: 0, x: 0.5, y: 0.5, confidence: 1, lost: false }, { time: 1, x: 0.6, y: 0.5, confidence: 1, lost: false }];
        const applied = await controller.execute({ type: "tracking.apply", clipId, samples, followers: [{ clipId: text.createdClipIds![0] }] });
        expect(applied).toMatchObject({ ok: true, output: { applied: [{ clipId: text.createdClipIds![0], keyframes: 2 }] } });
        // null turns tracking off.
        rerender(view(null));
        expect(await controller.execute(run)).toMatchObject({ ok: false, unavailable: true });
    });
});
