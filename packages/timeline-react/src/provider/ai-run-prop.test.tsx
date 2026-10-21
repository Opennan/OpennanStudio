import { render, waitFor } from "@testing-library/react";
import { TimelineProvider } from "./timeline-provider";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { createTimelineTestRuntime } from "../test-utils/render-with-timeline";
import type { AiRunOutcome, TimelineController } from "@opennan/timeline-core";

function Capture({ onController }: { onController(controller: TimelineController): void }) {
    onController(useTimelineController());
    return null;
}

const RUN = { type: "ai.run", capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track" } } as const;

describe("TimelineProvider onAiRun", () => {
    it("routes ai.run to the latest onAiRun prop and places its captions", async () => {
        const runtime = createTimelineTestRuntime();
        let controller: TimelineController | null = null;
        const first = vi.fn(async (): Promise<AiRunOutcome> => ({
            jobId: "job-a", output: { language: "en" },
            placement: { kind: "captions-track", style: "caption", cues: [{ startTime: 0, endTime: 1.5, text: "Hello" }] },
        }));
        const second = vi.fn(async (): Promise<AiRunOutcome> => ({ jobId: "job-b", output: { language: "th" } }));
        const view = (onAiRun?: () => Promise<AiRunOutcome>) => (
            <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store} onAiRun={onAiRun}>
                <Capture onController={(c) => { controller = c; }} />
            </TimelineProvider>
        );
        const { rerender } = render(view(first));
        await waitFor(() => expect(runtime.store.getState().timelineData).not.toBeNull());
        const placed = await controller!.execute(RUN);
        expect(placed).toMatchObject({ ok: true, jobId: "job-a" });
        expect(runtime.store.getState().timelineData!.clips.filter((c) => c.trackType === "text").map((c) => c.textContent)).toEqual(["Hello"]);
        rerender(view(second));
        expect(await controller!.execute(RUN)).toMatchObject({ ok: true, jobId: "job-b", output: { language: "th" } });
        rerender(view(undefined));
        expect(await controller!.execute(RUN)).toMatchObject({ ok: false, unavailable: true, error: expect.stringMatching(/audio\.transcribe/) });
    });
});
