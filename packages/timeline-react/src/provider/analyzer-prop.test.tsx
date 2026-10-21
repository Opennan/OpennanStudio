import { render, waitFor } from "@testing-library/react";
import { useContext } from "react";
import type { AnalysisJob, MediaAnalyzerHost } from "@opennan/timeline-core";
import { TimelineProvider } from "./timeline-provider";
import { TimelineContext, type TimelineContextValue } from "./context";
import { createTimelineTestRuntime } from "../test-utils/render-with-timeline";

function Capture({ onValue }: { onValue(value: TimelineContextValue): void }) {
    onValue(useContext(TimelineContext)!);
    return null;
}

describe("TimelineProvider analyzer", () => {
    it("routes analysis.run to the prop, defaults to the browser analyzer, and null turns it off", async () => {
        const runtime = createTimelineTestRuntime();
        let value: TimelineContextValue | null = null;
        const host: MediaAnalyzerHost = { analyze: vi.fn(async (job: AnalysisJob) => ({ silences: [{ start: job.startSeconds + 0.5, end: job.startSeconds + 1 }] })) };
        const view = (analyzer?: MediaAnalyzerHost | null) => (
            <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store} analyzer={analyzer}>
                <Capture onValue={(v) => { value = v; }} />
            </TimelineProvider>
        );
        const { rerender } = render(view(host));
        await waitFor(() => expect(runtime.store.getState().timelineData).not.toBeNull());
        const controller = value!.controller;
        const created = await controller.execute({ type: "clip.create", input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "audio", mediaUrl: "a.mp3" } });
        const run = { type: "analysis.run", kind: "silences", clipId: created.createdClipIds![0] } as const;
        expect(await controller.execute(run)).toMatchObject({ ok: true, output: { kind: "silences", ranges: [{ start: 0.5, end: 1 }] } });
        expect(host.analyze).toHaveBeenCalledTimes(1);
        // Undefined: the browser analyzer (jsdom cannot decode audio, so it answers unavailable or an error, never "needs an analyzer").
        rerender(view(undefined));
        const fallback = await controller.execute(run, { toastOnError: false });
        expect(fallback.ok).toBe(false);
        expect(fallback.error ?? "").not.toMatch(/needs an analyzer|turned off/);
        rerender(view(null));
        expect(await controller.execute(run)).toMatchObject({ ok: false, unavailable: true, error: "local analysis is turned off in this editor" });
    });
});
