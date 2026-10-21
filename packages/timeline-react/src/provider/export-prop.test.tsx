import { render, waitFor } from "@testing-library/react";
import { TimelineProvider } from "./timeline-provider";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { createTimelineTestRuntime } from "../test-utils/render-with-timeline";
import type { TimelineController } from "@opennan/timeline-core";

function Capture({ onController }: { onController(controller: TimelineController): void }) {
    onController(useTimelineController());
    return null;
}

describe("TimelineProvider onExport", () => {
    it("routes export.start to the latest onExport prop", async () => {
        const runtime = createTimelineTestRuntime();
        let controller: TimelineController | null = null;
        const first = vi.fn(async () => ({ jobId: "a" }));
        const second = vi.fn(async () => ({ jobId: "b" }));
        const view = (onExport?: typeof first) => (
            <TimelineProvider backend={runtime.backend} projectId="p1" media={{ resolveMediaUrl: (u) => u }} store={runtime.store} onExport={onExport}>
                <Capture onController={(c) => { controller = c; }} />
            </TimelineProvider>
        );
        const { rerender } = render(view(first));
        await waitFor(() => expect(runtime.store.getState().timelineData).not.toBeNull());
        expect(await controller!.execute({ type: "export.start", options: { resolution: "720p" } })).toMatchObject({ ok: true, jobId: "a" });
        rerender(view(second));
        expect(await controller!.execute({ type: "export.start", options: {} })).toMatchObject({ ok: true, jobId: "b" });
        rerender(view(undefined));
        expect(await controller!.execute({ type: "export.start", options: {} })).toMatchObject({ ok: false, unavailable: true });
    });
});
