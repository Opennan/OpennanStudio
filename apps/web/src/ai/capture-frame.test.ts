import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { frameTarget } from "./capture-frame";

async function controllerWithClips() {
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    const project = await backend.createProject({ name: "P", aspectRatio: "16:9" });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: project.id });
    await controller.load();
    return controller;
}

describe("frameTarget (From this frame)", () => {
    it("picks the topmost video under the playhead and maps the playhead into its media", async () => {
        const controller = await controllerWithClips();
        await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 2, startTime: 0, endTime: 10, mediaUrl: "opennan-local://media/low", mediaType: "video" } });
        await controller.execute({ type: "clip.create", input: { trackType: "video", trackIndex: 3, startTime: 4, endTime: 8, mediaUrl: "opennan-local://media/top", mediaType: "video", trimStart: 1, trimEnd: 5 } });
        await controller.execute({ type: "playhead.seek", seconds: 5 });
        expect(frameTarget(controller.snapshot())).toMatchObject({ mediaUrl: "opennan-local://media/top", sourceSeconds: 2 });
        await controller.execute({ type: "playhead.seek", seconds: 9 });
        expect(frameTarget(controller.snapshot())).toMatchObject({ mediaUrl: "opennan-local://media/low", sourceSeconds: 9 });
        await controller.execute({ type: "playhead.seek", seconds: 30 });
        expect(frameTarget(controller.snapshot())).toBeNull();
    });
});
