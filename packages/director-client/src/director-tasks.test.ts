import { CloudApiError, type CloudApi, type CloudMethod, type CloudRequest } from "@opennan/cloud-backend";
import { pipelineRequest } from "./director-pipelines";
import { CANCEL_TOO_LATE, createProjectTasks, parseTaskState, type ProjectTaskState } from "./director-tasks";

interface Call { method: CloudMethod; path: string; request?: CloudRequest }

function fakeApi(handler: (call: Call) => unknown) {
    const calls: Call[] = [];
    const api: CloudApi = {
        baseUrl: "https://api.opennan.com",
        async request<T>(method: CloudMethod, path: string, request?: CloudRequest) {
            const call = { method, path, request };
            calls.push(call);
            await Promise.resolve();
            return { status: 200, body: (await handler(call)) as T, etag: null };
        },
    };
    return { api, calls };
}

let clock = 0;
const instant = { sleep: async (ms: number) => { clock += ms; }, now: () => clock };

describe("parseTaskState", () => {
    it("reads status, progress (0–100 or 0–1), price, project revision, and a refund", () => {
        expect(parseTaskState({ id: "task_1", status: "succeeded", progress: 100, price_usd: 0.31, project_revision: 12 })).toEqual({ id: "task_1", status: "succeeded", progress: 1, priceUsd: 0.31, projectRevision: 12 });
        expect(parseTaskState({ id: "task_1", status: "settling", progress: 50 })).toEqual({ id: "task_1", status: "running", progress: 0.5 });
        expect(parseTaskState({ id: "task_1", status: "running", progress: 1 })?.progress).toBe(0.01);
        expect(parseTaskState({ id: "task_1", status: "failed", error: { message: "x", refunded: true, code: "pipeline_failed" } })).toMatchObject({ error: { message: "x", refunded: true, code: "pipeline_failed" } });
        expect(parseTaskState({ status: "queued" })).toBeNull();
        expect(parseTaskState({ id: "../x", status: "queued" })).toBeNull();
    });
});

describe("createProjectTasks", () => {
    beforeEach(() => {
        clock = 0;
    });

    it("submits once with an Idempotency-Key, long polls until it finishes, and reports the project revision", async () => {
        let polls = 0;
        const { api, calls } = fakeApi(({ method }) => {
            if (method === "POST") return { id: "task_7", status: "queued", price_usd: 0.31 };
            polls += 1;
            return polls < 3 ? { id: "task_7", status: "running", progress: polls * 40 } : { id: "task_7", status: "succeeded", price_usd: 0.31, project_revision: 9 };
        });
        const updates: ProjectTaskState[] = [];
        const handle = createProjectTasks(api, instant).start(pipelineRequest("storyboard", "p1", { sceneId: "s1" }), { onUpdate: (s) => updates.push(s), idempotencyKey: "k1" });
        expect(await handle.id).toBe("task_7");
        const outcome = await handle.done;
        expect(outcome).toEqual({ id: "task_7", status: "succeeded", priceUsd: 0.31, projectRevision: 9 });
        expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/projects/p1/scenes/s1/storyboard", request: { body: {}, headers: { "Idempotency-Key": "k1" } } });
        expect(calls.slice(1).every((c) => c.method === "GET" && c.path === "/v1/tasks/task_7" && c.request?.query?.wait === 50)).toBe(true);
        expect(updates.map((u) => u.status)).toEqual(["queued", "running", "running", "succeeded"]);
    });

    it("a refused POST rejects done and id with the CloudApiError, nothing polled", async () => {
        const { api, calls } = fakeApi(() => {
            throw new CloudApiError(402, "insufficient_balance", "low");
        });
        const handle = createProjectTasks(api, instant).start(pipelineRequest("story-scenes", "p1"));
        await expect(handle.done).rejects.toMatchObject({ code: "insufficient_balance" });
        await expect(handle.id).rejects.toMatchObject({ status: 402 });
        expect(calls).toHaveLength(1);
    });

    it("backs off on network errors and keeps following", async () => {
        let polls = 0;
        const { api } = fakeApi(({ method }) => {
            if (method === "POST") return { id: "task_1", status: "queued" };
            polls += 1;
            if (polls <= 2) throw new CloudApiError(0, "network", "down");
            return { id: "task_1", status: "succeeded", project_revision: 3 };
        });
        const outcome = await createProjectTasks(api, instant).start(pipelineRequest("story-scenes", "p1")).done;
        expect(outcome.status).toBe("succeeded");
        expect(clock).toBeGreaterThanOrEqual(3_000);
    });

    it("cancel: 200 ends the task cancelled (refunded)", async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const { api } = fakeApi(async ({ method, path }) => {
            if (method === "POST" && path.endsWith("/cancel")) return { id: "task_2", status: "cancelled", error: { message: "Cancelled", refunded: true } };
            if (method === "POST") return { id: "task_2", status: "queued" };
            await gate;
            return { id: "task_2", status: "running" };
        });
        const handle = createProjectTasks(api, instant).start(pipelineRequest("storyboard", "p1", { sceneId: "s1" }));
        await handle.id;
        expect(await handle.cancel()).toEqual({ accepted: true });
        release();
        expect(await handle.done).toMatchObject({ status: "cancelled", error: { refunded: true } });
    });

    it("cancel: busy is asked again, not cancellable keeps it running, already finished ends in its real state", async () => {
        let cancels = 0;
        let mode: "busy" | "late" | "finished" = "busy";
        const { api } = fakeApi(({ method, path }) => {
            if (method === "POST" && path.endsWith("/cancel")) {
                cancels += 1;
                if (mode === "busy" && cancels < 3) throw new CloudApiError(409, "task_busy_retry", "busy", { retryAfterSeconds: 1 });
                if (mode === "late") throw new CloudApiError(409, "task_not_cancellable", "late");
                if (mode === "finished") throw new CloudApiError(409, "task_already_finished", "done");
                return { id: "task_3", status: "cancelled" };
            }
            if (method === "POST") return { id: "task_3", status: "running" };
            return mode === "finished" ? { id: "task_3", status: "succeeded", project_revision: 4 } : { id: "task_3", status: "running" };
        });
        const tasks = createProjectTasks(api, instant);
        const busy = tasks.start(pipelineRequest("storyboard", "p1", { sceneId: "s1" }));
        await busy.id;
        expect(await busy.cancel()).toEqual({ accepted: true });
        expect(cancels).toBe(3);
        busy.detach();
        mode = "late";
        const late = tasks.start(pipelineRequest("storyboard", "p1", { sceneId: "s1" }));
        await late.id;
        expect(await late.cancel()).toEqual({ accepted: false, message: CANCEL_TOO_LATE });
        late.detach();
        mode = "finished";
        const finished = tasks.start(pipelineRequest("storyboard", "p1", { sceneId: "s1" }));
        await finished.id;
        expect(await finished.cancel()).toMatchObject({ accepted: false });
        expect(await finished.done).toMatchObject({ status: "succeeded", projectRevision: 4 });
    });

    it("follows a task the director started", async () => {
        const { api, calls } = fakeApi(() => ({ id: "task_9", status: "succeeded", project_revision: 2 }));
        const outcome = await createProjectTasks(api, instant).follow("task_9").done;
        expect(outcome).toMatchObject({ status: "succeeded", projectRevision: 2 });
        expect(calls.every((c) => c.method === "GET")).toBe(true);
    });
});
