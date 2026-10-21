import { LocalBackend } from "../backend/local-backend";
import { createMemoryPersistence } from "../backend/persistence";
import { optimisticTimelineClipFromInput } from "../lib/timeline-optimistic";
import { createEditorStore } from "../store/editor-store";
import type { SceneData } from "../timeline/canvas/types";
import { timelineDurationSeconds, type FrameRenderer, type FrameRequest } from "./frame-renderer";
import { TimelineController } from "./timeline-controller";

function scene(id: string, order: number, duration: number): SceneData {
    return {
        id, order, caption: "", startTime: "00:00:00", endTime: "00:00:00", startImageUrl: null, endImageUrl: null,
        videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null, duration,
    };
}

const textClip = (id: string, startTime: number, endTime: number) =>
    optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime, endTime, textContent: id }, "p1", id);

async function setup(frameRenderer?: FrameRenderer) {
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    await backend.seedProject("p1", { clips: [textClip("c1", 0, 4), textClip("c2", 2, 9)] });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "p1", frameRenderer });
    await controller.load();
    return controller;
}

describe("timelineDurationSeconds", () => {
    it("is the end of the last clip or scene", () => {
        expect(timelineDurationSeconds({ clips: [textClip("a", 0, 9)], scenes: [] })).toBe(9);
        expect(timelineDurationSeconds({ clips: [textClip("a", 0, 9)], scenes: [scene("s1", 0, 4), scene("s2", 1, 8)] })).toBe(12);
        expect(timelineDurationSeconds({ clips: [], scenes: [] })).toBe(0);
    });
});

describe("TimelineController.previewFrame", () => {
    it("is unavailable without a frame renderer", async () => {
        const controller = await setup();
        await expect(controller.previewFrame(3)).resolves.toEqual({
            ok: false, seconds: 3, unavailable: true, error: "previewFrame needs a frame renderer (@opennan/export)",
        });
    });

    it("renders the live snapshot at the clamped time", async () => {
        const frame = { mimeType: "image/png" as const, data: new Uint8Array([1, 2, 3]), width: 2, height: 1 };
        const renderFrame = vi.fn(async (_request: FrameRequest) => frame);
        const controller = await setup({ renderFrame });
        await expect(controller.previewFrame(50, { width: 2 })).resolves.toEqual({ ok: true, seconds: 9, frame });
        expect(renderFrame).toHaveBeenCalledWith(expect.objectContaining({ seconds: 9, width: 2 }));
        expect(renderFrame.mock.calls[0][0].snapshot.clips.map((c) => c.id)).toEqual(["c1", "c2"]);
        await expect(controller.previewFrame(-1)).resolves.toMatchObject({ ok: true, seconds: 0 });
    });

    it("returns the renderer error instead of throwing", async () => {
        const controller = await setup({ renderFrame: async () => { throw new Error("gpu lost"); } });
        await expect(controller.previewFrame(1)).resolves.toEqual({ ok: false, seconds: 1, error: "gpu lost" });
    });
});
