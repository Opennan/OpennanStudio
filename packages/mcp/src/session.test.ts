import { createFixtureStudio } from "./testing/fixture";

describe("createControllerSession", () => {
    it("executes commands and reads the same state as the controller", async () => {
        const { session, controller } = await createFixtureStudio();
        expect(session.projectId).toBe("fixture");
        const result = await session.execute({ type: "clip.delete", clipIds: ["title"] });
        expect(result.ok).toBe(true);
        expect((await session.snapshot()).clips.map((c) => c.id)).toEqual(["music"]);
        expect(await session.describeTimeline()).toBe(controller.describeTimeline());
        await expect(session.historyDepth?.()).resolves.toEqual({ undo: 1, redo: 0, recorded: 1, limit: 50 });
    });

    it("reports editor UI state from the store", async () => {
        const { session } = await createFixtureStudio({ host: { activePanel: () => "audio" } });
        await session.execute({ type: "playhead.seek", seconds: 2 });
        await session.execute({ type: "selection.set", clipIds: ["title"] });
        await session.execute({ type: "marker.add", time: 1, label: "a" });
        await expect(session.uiState()).resolves.toMatchObject({
            currentTime: 2,
            isPlaying: false,
            toolMode: "select",
            snapEnabled: true,
            selection: { clipIds: ["title"], sceneId: null, markerId: null },
            markers: [expect.objectContaining({ time: 1, label: "a" })],
            activePanel: "audio",
        });
    });

    it("exposes the backend effect catalog and uploads into the media bin", async () => {
        const { session, backend } = await createFixtureStudio();
        expect((await session.listEffects?.("effect"))?.map((e) => e.id).slice(-1)).toEqual(["blur"]);
        const media = await session.uploadFile?.(new File([new Uint8Array([1])], "a.wav", { type: "audio/wav" }), "audio");
        expect(media).toMatchObject({ name: "a.wav", mimeType: "audio/wav" });
        expect(media?.url).toMatch(/^opennan-local:\/\/media\//);
        expect((await backend.listLibrary("fixture")).map((m) => m.url)).toEqual([media?.url]);
    });

    it("renders frames through the controller", async () => {
        const frame = { mimeType: "image/png" as const, data: new Uint8Array([1]), width: 1, height: 1 };
        const { session } = await createFixtureStudio({ frameRenderer: { renderFrame: async () => frame } });
        await expect(session.previewFrame(99)).resolves.toEqual({ ok: true, seconds: 15, frame });
    });
});
