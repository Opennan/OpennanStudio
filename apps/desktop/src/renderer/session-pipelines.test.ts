// The renderer's answers to main's cloud.quote / cloud.run / cloud.edit / cloud.script (phase 9b): OpenNan project
// pipelines of the open cloud project over the runtime's CloudApi (the key stays in main), each priced step submitted
// once with an Idempotency-Key and followed to its end, its result pulled into the editor as one undo step.
import { CloudApiError, type CloudApi } from "@opennan/cloud-backend";
import { createResponderPipelines, type PipelineBackend } from "./session-pipelines";

type Call = { method: string; path: string; body?: unknown; headers?: Record<string, string> };

function fakeApi(options: { quote?: Record<string, unknown> | CloudApiError; submit?: Record<string, unknown> | CloudApiError; task?: Record<string, unknown> } = {}) {
    const calls: Call[] = [];
    const api: CloudApi = {
        baseUrl: "https://api.opennan.test",
        async request(method, path, request = {}) {
            calls.push({ method, path, ...(request.body !== undefined ? { body: request.body } : {}), ...(request.headers ? { headers: request.headers as Record<string, string> } : {}) });
            const answer = (value: unknown) => ({ status: 200, body: value, etag: null }) as never;
            if (path === "/v1/quotes") {
                if (options.quote instanceof CloudApiError) throw options.quote;
                return answer(options.quote ?? { price_usd: 0.31, hold_usd: 0.31 });
            }
            if (path.startsWith("/v1/tasks/")) return answer(options.task ?? { id: "task_1", status: "succeeded", price_usd: 0.31, project_revision: 7 });
            if (method === "POST") {
                if (options.submit instanceof CloudApiError) throw options.submit;
                return answer(options.submit ?? { id: "task_1", status: "queued" });
            }
            return answer({});
        },
    };
    return { api, calls };
}

function fakeBackend(api: CloudApi, revision = { value: 7 }) {
    const backend = {
        api,
        serverId: (id: string) => id.replace(/^cloud-/, ""),
        revision: vi.fn(async () => revision.value),
        waitForRevision: vi.fn(async (_id: string, wanted: number) => revision.value >= wanted),
        setAiActive: vi.fn(),
        beginRemoteGroup: vi.fn(async () => 4),
        endRemoteGroup: vi.fn(async () => undefined),
        recordRemoteGroup: vi.fn(async () => ({ stepId: 9, label: "AI: Storyboard of scene 2", before: { tracks: [], clips: [], scenes: [] }, after: { tracks: [], clips: [], scenes: [] }, changed: { scenes: ["s-b"], clips: [] } })),
    };
    return backend;
}

function setup(options: Parameters<typeof fakeApi>[0] & { signedOut?: boolean; recorded?: boolean } = {}) {
    const { api, calls } = fakeApi(options);
    const backend = fakeBackend(api);
    const recordExternalStep = vi.fn(async (record: () => Promise<unknown>) => (await record()) !== null && options.recorded !== false);
    const pipelines = createResponderPipelines({
        projectId: "cloud-srv1",
        backend: () => {
            if (options.signedOut) throw new Error("Sign in with OpenNan to use cloud projects.");
            return backend as unknown as PipelineBackend;
        },
        controller: { recordExternalStep } as never,
        tasks: { sleep: async () => undefined },
        waitMs: 50,
    });
    return { pipelines, calls, backend, recordExternalStep };
}

const STORYBOARD = { tool: "storyboard", sceneId: "s-b", body: { regenerate: true }, label: "Storyboard of scene 2" };

describe("session pipelines (phase 9b)", () => {
    it("quotes a step with POST /v1/quotes for the open project", async () => {
        const { pipelines, calls } = setup({ quote: { price_usd: 0.3, hold_usd: 0.4 } });
        expect(await pipelines.quote({ step: STORYBOARD })).toEqual({ kind: "quote", priceUsd: 0.3, holdUsd: 0.4 });
        expect(calls).toEqual([{ method: "POST", path: "/v1/quotes", body: { tool: "storyboard", project_id: "srv1", scene_id: "s-b", inputs: { regenerate: true } } }]);
    });

    it("answers refused and unavailable quotes as they are", async () => {
        expect(await setup({ quote: new CloudApiError(400, "invalid_request", "No such scene.") }).pipelines.quote({ step: STORYBOARD })).toEqual({ kind: "refused", code: "invalid_request", message: "No such scene." });
        expect(await setup({ quote: new CloudApiError(503, "unavailable", "Busy") }).pipelines.quote({ step: STORYBOARD })).toEqual({ kind: "unavailable" });
    });

    it("runs a step once with an Idempotency-Key, follows the task, and records its result as one undo step", async () => {
        const { pipelines, calls, backend, recordExternalStep } = setup();
        const result = await pipelines.run({ step: STORYBOARD });
        const submit = calls.find((c) => c.method === "POST" && c.path !== "/v1/quotes")!;
        expect(submit).toMatchObject({ path: "/v1/projects/srv1/scenes/s-b/storyboard", body: { regenerate: true }, headers: { "Idempotency-Key": expect.any(String) } });
        expect(calls.filter((c) => c === submit)).toHaveLength(1);
        expect(backend.beginRemoteGroup).toHaveBeenCalledWith("cloud-srv1");
        expect(backend.setAiActive).toHaveBeenNthCalledWith(1, "cloud-srv1", 1);
        expect(backend.setAiActive).toHaveBeenLastCalledWith("cloud-srv1", -1);
        expect(backend.waitForRevision).toHaveBeenCalledWith("cloud-srv1", 7, 50);
        expect(recordExternalStep).toHaveBeenCalledTimes(1);
        expect(backend.recordRemoteGroup).toHaveBeenCalledWith("cloud-srv1", 4, { label: "AI: Storyboard of scene 2", toRevision: 7, entities: { scenes: ["s-b"], clips: [], tracks: false, project: false } }, { timeoutMs: 0 });
        expect(result).toEqual({ taskId: "task_1", status: "succeeded", chargedUsd: 0.31, projectRevision: 7, synced: true, undoable: true, error: null });
    });

    it("a story plan's undo step covers every scene and the project", async () => {
        const { pipelines, backend, calls } = setup();
        await pipelines.run({ step: { tool: "story-scenes", body: { style: "Ink" }, label: "Scene plan" } });
        expect(calls.find((c) => c.path === "/v1/projects/srv1/story/plan")).toMatchObject({ body: { style: "Ink" } });
        expect(backend.recordRemoteGroup).toHaveBeenCalledWith("cloud-srv1", 4, expect.objectContaining({ entities: { scenes: "all", clips: [], tracks: false, project: true } }), { timeoutMs: 0 });
    });

    it("refuses before submitting when its own quote is above maxHoldUsd or missing", async () => {
        const over = setup({ quote: { price_usd: 0.5, hold_usd: 0.5 } });
        await expect(over.pipelines.run({ step: STORYBOARD, maxHoldUsd: 0.4 })).rejects.toThrow(/accept_max_usd/);
        expect(over.calls.filter((c) => c.path !== "/v1/quotes")).toEqual([]);
        const none = setup({ quote: new CloudApiError(503, "unavailable", "Busy") });
        await expect(none.pipelines.run({ step: STORYBOARD, maxHoldUsd: 1 })).rejects.toThrow("OpenNan can't price this right now");
        expect(none.calls.filter((c) => c.path !== "/v1/quotes")).toEqual([]);
    });

    it("reports a failed task with its refund, and records nothing", async () => {
        const { pipelines, backend, recordExternalStep } = setup({ task: { id: "task_1", status: "failed", error: { message: "Drawing failed.", code: "upstream", refunded: true } } });
        expect(await pipelines.run({ step: STORYBOARD })).toEqual({
            taskId: "task_1", status: "failed", chargedUsd: 0, projectRevision: null, synced: false, undoable: false, error: { message: "Drawing failed.", code: "upstream", refunded: true },
        });
        expect(recordExternalStep).not.toHaveBeenCalled();
        expect(backend.endRemoteGroup).toHaveBeenCalledWith("cloud-srv1", 4);
        expect(backend.setAiActive).toHaveBeenLastCalledWith("cloud-srv1", -1);
    });

    it("throws a refused submit with OpenNan's message", async () => {
        const { pipelines, backend } = setup({ submit: new CloudApiError(402, "insufficient_balance", "Not enough credits.") });
        await expect(pipelines.run({ step: STORYBOARD })).rejects.toThrow("Not enough credits.");
        expect(backend.endRemoteGroup).toHaveBeenCalled();
        expect(backend.setAiActive).toHaveBeenLastCalledWith("cloud-srv1", -1);
    });

    it("records nothing when the editor never reaches the task's revision, and says so", async () => {
        const { pipelines, backend, recordExternalStep } = setup({ task: { id: "task_1", status: "succeeded", price_usd: 0.31, project_revision: 9 } });
        const result = await pipelines.run({ step: STORYBOARD });
        expect(backend.waitForRevision).toHaveBeenCalledWith("cloud-srv1", 9, 50);
        expect(recordExternalStep).not.toHaveBeenCalled();
        expect(backend.endRemoteGroup).toHaveBeenCalledWith("cloud-srv1", 4);
        expect(result).toMatchObject({ status: "succeeded", projectRevision: 9, synced: false, undoable: false });
    });

    it("a synced result the controller can't record is reported as not undoable", async () => {
        const { pipelines } = setup({ recorded: false });
        expect(await pipelines.run({ step: STORYBOARD })).toMatchObject({ status: "succeeded", synced: true, undoable: false });
    });

    it("sets the copy-video source (PUT) and a shot's words (PATCH), then pulls", async () => {
        const { pipelines, calls, backend } = setup();
        expect(await pipelines.edit({ kind: "copy-video-source", sceneId: "s-b", videoUrl: "https://cdn.example.com/v.mp4", trimStart: 1, trimEnd: 9 })).toEqual({ synced: false });
        expect(calls.at(-1)).toEqual({ method: "PUT", path: "/v1/projects/srv1/scenes/s-b/copy-video/source", body: { video_url: "https://cdn.example.com/v.mp4", trim_start: 1, trim_end: 9 } });
        await pipelines.edit({ kind: "shot-text", sceneId: "s-a", index: 2, action: "A dog runs" });
        expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/v1/projects/srv1/scenes/s-a/shots/2", body: { action: "A dog runs" } });
        expect(backend.waitForRevision).toHaveBeenLastCalledWith("cloud-srv1", 8, 50);
    });

    it("stores the script with PATCH /v1/projects/{id}", async () => {
        const { pipelines, calls } = setup();
        expect(await pipelines.script({ scriptText: "Hello.", srtContent: null })).toBeNull();
        expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/v1/projects/srv1", body: { script_text: "Hello.", srt_content: null } });
    });

    it("refuses bad payloads, local projects, and asks to sign in when signed out", async () => {
        const { pipelines, calls } = setup();
        for (const step of [
            { ...STORYBOARD, tool: "export" }, { ...STORYBOARD, sceneId: "../x" }, { ...STORYBOARD, sceneId: undefined }, { ...STORYBOARD, body: [] },
            { ...STORYBOARD, label: "x".repeat(201) }, { ...STORYBOARD, body: { prompt: "x" } }, { tool: "copy-video-edit", sceneId: "s", index: 1000, body: { instruction: "x" }, label: "x" },
        ]) await expect(pipelines.run({ step }), JSON.stringify(step)).rejects.toThrow();
        await expect(pipelines.edit({ kind: "shot-text", sceneId: "s", index: 1, action: "" })).rejects.toThrow();
        await expect(pipelines.edit({ kind: "copy-video-source", sceneId: "s", videoUrl: "http://x" })).rejects.toThrow();
        await expect(pipelines.script({})).rejects.toThrow();
        await expect(pipelines.script({ scriptText: 5 })).rejects.toThrow();
        expect(calls).toEqual([]);
        const local = createResponderPipelines({ projectId: "p", backend: () => { throw new Error("unused"); }, controller: {} as never });
        await expect(local.quote({ step: STORYBOARD })).rejects.toThrow("cloud project");
        await expect(setup({ signedOut: true }).pipelines.quote({ step: STORYBOARD })).rejects.toThrow("Sign in");
    });

    it("a task OpenNan priced above the limit when it was sent is cancelled at once and reported not charged", async () => {
        const { pipelines, calls } = setup({ submit: { id: "task_1", status: "queued", price_usd: 0.5 }, task: { id: "task_1", status: "cancelled", error: { message: "Cancelled", refunded: true } } });
        const result = await pipelines.run({ step: STORYBOARD, maxHoldUsd: 0.31 });
        expect(calls.some((c) => c.method === "POST" && c.path === "/v1/tasks/task_1/cancel")).toBe(true);
        expect(result).toMatchObject({ status: "cancelled", chargedUsd: 0, error: { code: "price_changed", refunded: true } });
    });
});
