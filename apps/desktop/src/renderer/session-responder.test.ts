import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { createControllerSession } from "@opennan/mcp/server";
import { createSessionResponder, startSessionResponder } from "./session-responder";
import { createTestBridge } from "./test-bridge";

async function setup(onAiRun?: ConstructorParameters<typeof TimelineController>[0]["onAiRun"]) {
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    await backend.seedProject("p", {});
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "p", onAiRun });
    await controller.load();
    return { backend, store, controller };
}

describe("session responder", () => {
    it("runs session methods on the editor's controller", async () => {
        const { backend, store, controller } = await setup();
        const respond = createSessionResponder({ projectId: "p", controller, store, backend });
        const result = await respond("execute", [{ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "hi" } }]) as { ok: boolean };
        expect(result.ok).toBe(true);
        const snapshot = await respond("snapshot", []) as { clips: unknown[]; projectId: string };
        expect(snapshot.projectId).toBe("p");
        expect(snapshot.clips).toHaveLength(1);
        expect(controller.snapshot().clips).toHaveLength(1);
        expect(await respond("historyDepth", [])).toMatchObject({ undo: 1 });
        expect(typeof await respond("describeTimeline", [])).toBe("string");
        expect(await respond("uiState", [])).toMatchObject({ currentTime: 0 });
        await respond("saveToLibrary", [{ url: "opennan-local://media/x", name: "a.mp4", size: 1, mimeType: "video/mp4" }]);
        expect(await backend.listLibrary("p")).toHaveLength(1);
        await expect(respond("deleteEverything", [])).rejects.toThrow("Unknown session method");
    });

    it("cancels agent ai.run jobs when main asks", async () => {
        const seen: AbortSignal[] = [];
        const { backend, store, controller } = await setup(async (_request, context) => {
            seen.push(context.signal!);
            await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
            return { jobId: "job-1", cancelled: true };
        });
        const respond = createSessionResponder({ projectId: "p", controller, store, backend });
        const running = respond("execute", [{ type: "ai.run", capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track" } }]);
        await vi.waitFor(() => expect(seen).toHaveLength(1));
        expect(await respond("cancelAiRun", [])).toBeUndefined();
        expect(seen[0].aborted).toBe(true);
        await expect(running).resolves.toMatchObject({ ok: false, cancelled: true });
        expect(controller.snapshot().clips).toEqual([]);
    });

    it("maps UI state exactly like @opennan/mcp's createControllerSession", async () => {
        const { backend, store, controller } = await setup();
        store.getState().setCurrentTime?.(1.5);
        const respond = createSessionResponder({ projectId: "p", controller, store, backend });
        expect(await respond("uiState", [])).toEqual(await createControllerSession({ controller, store, backend }).uiState());
    });

    it("attaches through the bridge", async () => {
        const { backend, store, controller } = await setup();
        const { bridge } = createTestBridge();
        await startSessionResponder({ bridge, projectId: "p", controller, store, backend });
        expect(bridge.session.attach).toHaveBeenCalledWith("p", expect.any(Function));
    });
});
