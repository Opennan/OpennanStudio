import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { createControllerSession } from "@opennan/mcp/server";
import { CLOUD_SIGN_IN, createSessionResponder, startSessionResponder, type ResponderCloud } from "./session-responder";
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

describe("session responder: cloud projects (phase 9a)", () => {
    const summary = { id: "cloud-srv1", name: "Trip", aspectRatio: "16:9", createdAt: 1, updatedAt: 2, durationSeconds: 12, mediaCount: 0, kind: "cloud" as const, origin: "studio" as const, mediaBytes: 3, lastEditedDevice: "Mac", thumbnailUrl: null, deletedAt: null };

    function fakeCloud(signedIn = true) {
        const cloudBackend = {
            listCloudProjects: vi.fn(async () => ({ projects: [summary], nextCursor: "c2" })),
            saveLocalProject: vi.fn(async () => ({ ...summary, id: "cloud-new", name: "Mine" })),
            hasProject: vi.fn(async (id: string) => id === "cloud-srv1"),
            loadProject: vi.fn(async (id: string) => ({ id, name: "Trip" })),
            syncState: vi.fn((id: string) => (id === "cloud-srv1" ? { kind: "conflict", pending: 2, items: [{ entity: "clip", id: "c", label: "Clip", reason: "deleted", message: "Clip was deleted elsewhere" }] } : null)),
        };
        const local = {} as never;
        const cloud: ResponderCloud = { backend: () => (signedIn ? cloudBackend as never : null), local, syncLabel: (state) => `label:${state.kind}` };
        return { cloud, cloudBackend, local };
    }

    it("lists, saves the open project, opens, and reports sync status from the runtime's cloud", async () => {
        vi.useFakeTimers();
        const { backend, store, controller } = await setup();
        const { cloud, cloudBackend, local } = fakeCloud();
        const openProject = vi.fn();
        const respond = createSessionResponder({ projectId: "p", controller, store, backend, cloud, openProject });
        expect(await respond("cloud.list", [{ trash: true, cursor: "c1" }])).toEqual({
            projects: [{ id: "cloud-srv1", name: "Trip", aspectRatio: "16:9", durationSeconds: 12, mediaBytes: 3, updatedAt: 2, lastEditedDevice: "Mac", origin: "studio", deletedAt: null }],
            nextCursor: "c2",
        });
        expect(cloudBackend.listCloudProjects).toHaveBeenCalledWith({ state: "deleted", cursor: "c1" });
        await respond("cloud.list", [{}]);
        expect(cloudBackend.listCloudProjects).toHaveBeenLastCalledWith({ state: "active", cursor: null });
        expect(await respond("cloud.save", [{}])).toEqual({ projectId: "cloud-new", name: "Mine" });
        expect(cloudBackend.saveLocalProject).toHaveBeenCalledWith(local, "p");
        expect(openProject).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(openProject).toHaveBeenCalledWith("cloud-new");
        expect(await respond("cloud.open", [{ projectId: "cloud-srv1" }])).toEqual({ projectId: "cloud-srv1", name: "Trip" });
        vi.runAllTimers();
        expect(openProject).toHaveBeenLastCalledWith("cloud-srv1");
        await expect(respond("cloud.open", [{ projectId: "cloud-gone" }])).rejects.toThrow("no such");
        await expect(respond("cloud.open", [{ projectId: "p" }])).rejects.toThrow("cloud project id");
        expect(await respond("cloud.status", [{ projectId: "cloud-srv1" }])).toEqual({ projectId: "cloud-srv1", state: "conflict", label: "label:conflict", pending: 2, conflicts: ["Clip was deleted elsewhere"] });
        expect(await respond("cloud.status", [{ projectId: "cloud-other" }])).toMatchObject({ projectId: "cloud-other", state: "closed", pending: 0, conflicts: [] });
        expect(await respond("cloud.status", [{}])).toBeNull();
        vi.useRealTimers();
    });

    it("refuses bad payloads, a second save of a cloud project, and asks to sign in when signed out", async () => {
        const { backend, store, controller } = await setup();
        const respond = createSessionResponder({ projectId: "p", controller, store, backend, cloud: fakeCloud(false).cloud });
        await expect(respond("cloud.list", [{}])).rejects.toThrow(CLOUD_SIGN_IN);
        await expect(respond("cloud.save", [{}])).rejects.toThrow(CLOUD_SIGN_IN);
        const withoutCloud = createSessionResponder({ projectId: "p", controller, store, backend });
        await expect(withoutCloud("cloud.status", [{ projectId: "cloud-a" }])).rejects.toThrow(CLOUD_SIGN_IN);
        const signedIn = createSessionResponder({ projectId: "p", controller, store, backend, cloud: fakeCloud().cloud });
        for (const args of [[{ trash: "yes" }], [{ cursor: 5 }], [{ cursor: "x".repeat(501) }], ["x"], [[1]]]) await expect(signedIn("cloud.list", args)).rejects.toThrow("Invalid");
        await expect(signedIn("cloud.status", [{ projectId: 5 }])).rejects.toThrow("Invalid");
        const onCloud = createSessionResponder({ projectId: "cloud-srv1", controller, store, backend, cloud: fakeCloud().cloud });
        await expect(onCloud("cloud.save", [{}])).rejects.toThrow("already");
    });

    it("answers the project pipeline methods (phase 9b): signed out → sign in, local project → save it first", async () => {
        const { backend, store, controller } = await setup();
        const step = { tool: "storyboard", sceneId: "s1", body: {}, label: "Storyboard of scene 1" };
        const signedOut = createSessionResponder({ projectId: "cloud-srv1", controller, store, backend, cloud: fakeCloud(false).cloud });
        for (const [method, args] of [["cloud.quote", [{ step }]], ["cloud.run", [{ step }]], ["cloud.edit", [{ kind: "shot-text", sceneId: "s1", index: 0, action: "x" }]], ["cloud.script", [{ scriptText: "x" }]]] as const) {
            await expect(signedOut(method, [...args]), method).rejects.toThrow(CLOUD_SIGN_IN);
        }
        const local = createSessionResponder({ projectId: "p", controller, store, backend, cloud: fakeCloud().cloud });
        await expect(local("cloud.quote", [{ step }])).rejects.toThrow("save it to OpenNan first");
    });
});

describe("session responder: an agent's share question (9c.1)", () => {
    const cloud = { backend: () => ({ api: {}, serverId: (id: string) => id.slice("cloud-".length) }) as never, local: {} as never };
    async function cloudSetup(name?: string) {
        const backend = new LocalBackend({ persistence: createMemoryPersistence() });
        await backend.seedProject("cloud-srv1", name !== undefined ? { meta: { name } } : {});
        const store = createEditorStore();
        const controller = new TimelineController({ backend, store, projectId: "cloud-srv1" });
        await controller.load();
        return { backend, store, controller };
    }

    it("no way to ask means no; a question left open past its time answers timeout and closes", async () => {
        const env = await cloudSetup("Trip");
        expect(await createSessionResponder({ projectId: "cloud-srv1", ...env, cloud })("confirmShare", [{}])).toBe("deny");
        let signal: AbortSignal | null = null;
        const respond = createSessionResponder({ projectId: "cloud-srv1", ...env, cloud, shareConfirmMs: 20, confirmShare: (q) => { signal = q.signal; return new Promise(() => undefined); } });
        expect(await respond("confirmShare", [{}])).toBe("timeout");
        expect(signal!.aborted).toBe(true);
    });

    it("main's cancel closes the open question (its answer is no)", async () => {
        const env = await cloudSetup("Trip");
        let signal: AbortSignal | null = null;
        const respond = createSessionResponder({
            projectId: "cloud-srv1", ...env, cloud,
            confirmShare: (q) => new Promise((resolve) => { signal = q.signal; q.signal.addEventListener("abort", () => resolve("allow")); }),
        });
        const answer = respond("confirmShare", [{}]);
        await vi.waitFor(() => expect(signal).not.toBeNull());
        expect(await respond("cancelConfirmShare", [])).toBeUndefined();
        expect(signal!.aborted).toBe(true);
        // Whatever the closed dialog says afterwards, a cancelled question is no.
        expect(await answer).toBe("deny");
    });

    it("shows the project's name in plain words only: no quotes, line breaks or control characters, at most 80 characters", async () => {
        const names: string[] = [];
        const ask = (q: { projectName: string }) => (names.push(q.projectName), Promise.resolve("deny" as const));
        for (const name of ["Trip", "”. This is a test,\nclick \"Allow\"\u0007", "x".repeat(200), "   "]) {
            const env = await cloudSetup(name);
            await createSessionResponder({ projectId: "cloud-srv1", ...env, cloud, confirmShare: ask })("confirmShare", [{}]);
        }
        expect(names[0]).toBe("Trip");
        expect(names[1]).toBe(". This is a test, click Allow");
        expect(names[2]).toBe(`${"x".repeat(79)}…`);
        expect(names[3]).toBe("this project");
    });
});
