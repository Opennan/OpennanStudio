import { CloudApiError, type CloudApi, type CloudMethod, type CloudRequest, type RemoteStep } from "@opennan/cloud-backend";
import type { ProjectTasks, ProjectTaskState } from "@opennan/director-client";
import { BUDGET_STORAGE_KEY, DirectorHost, safeDetail, type DirectorHostDeps } from "./director-host";

const TURN_ID = "turn_0123456789abcdef01234567";
const OTHER_TURN = "turn_aaaaaaaaaaaaaaaaaaaaaaaa";

function turnJson(overrides: Record<string, unknown> = {}) {
    return {
        object: "director_turn", id: TURN_ID, project_id: "p1", status: "completed", message: "Make it shorter", reply: "Done: scene 2 is 4 s.",
        cards: [], proposals: [], changes: [{ revision: 8, label: "AI: shorter", scenes: ["s2"], clips: ["c1"], tracks: false, project: false }], tasks: [],
        revision_start: 7, revision_end: 8, hold_usd: 0.429, charged_usd: 0.052, limits: {}, finish: "stop", cancel_requested: false, error: null,
        created_at: null, finished_at: null, ...overrides,
    };
}

function sse(events: Array<[string, unknown]>): string {
    return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
}

interface Call { method: CloudMethod; path: string; request?: CloudRequest }

function harness(options: {
    stream?: (call: Call) => Promise<{ status: number; body: ReadableStream<Uint8Array> }>;
    request?: (call: Call) => unknown;
    balance?: number | null;
    signedIn?: boolean;
    tasks?: ProjectTasks;
    newest?: boolean;
    deps?: Partial<DirectorHostDeps>;
} = {}) {
    const calls: Call[] = [];
    const api: CloudApi = {
        baseUrl: "https://api.opennan.com",
        async request<T>(method: CloudMethod, path: string, request?: CloudRequest) {
            calls.push({ method, path, request });
            const body = options.request ? await options.request({ method, path, request }) : defaultRequest({ method, path, request });
            return { status: 200, body: body as T, etag: null };
        },
        async stream(method: CloudMethod, path: string, request?: CloudRequest) {
            calls.push({ method, path, request });
            return options.stream!({ method, path, request });
        },
    };
    function defaultRequest(call: Call): unknown {
        if (call.path === "/v1/quotes" && (call.request?.body as { tool: string }).tool === "director-turn") return { price_usd: 0.429, hold_usd: 0.429, priced: { typical_usd: 0.078 } };
        if (call.path === "/v1/quotes") return { price_usd: 0.31, hold_usd: 0.31 };
        if (call.path.endsWith("/director/turns")) return { data: [], has_more: false, next_cursor: null };
        if (call.path.endsWith("/cancel")) return turnJson({ status: "cancelled" });
        return {};
    }
    const empty = { meta: {} as never, tracks: [], clips: [], scenes: [], library: [] };
    const step: RemoteStep = { stepId: 41, label: "AI: Done: scene 2 is 4 s.", before: empty, after: empty, changed: { scenes: ["s2"], clips: ["c1"] } };
    const backend = {
        setAiActive: vi.fn(), pullSoon: vi.fn(), waitForRevision: vi.fn(async () => true),
        beginRemoteGroup: vi.fn(async () => 1), endRemoteGroup: vi.fn(async () => undefined),
        recordRemoteGroup: vi.fn(async () => step),
        isNewestRemoteStep: vi.fn(async () => options.newest ?? true),
        undoRemoteStep: vi.fn(async () => ({ ...step, stepId: 42 })),
        revision: vi.fn(async () => 7),
    };
    const controller = {
        recordExternalStep: vi.fn(async (record: () => Promise<unknown>) => Boolean(await record())),
        execute: vi.fn(async () => ({ ok: true })),
    };
    const notEnough = vi.fn();
    const highlight = vi.fn();
    const store = new Map<string, string>();
    let refreshCount = 0;
    const deps: DirectorHostDeps = {
        api, backend: backend as unknown as DirectorHostDeps["backend"], projectId: "cloud-p1", serverId: "p1", controller,
        selection: () => ({ sceneIds: ["s2"] }), highlight,
        account: { balance: () => (options.balance === undefined ? 10 : options.balance), refresh: async () => void (refreshCount += 1) },
        notEnoughCredits: notEnough, isSignedIn: () => options.signedIn ?? true, openSignIn: vi.fn(async () => false),
        storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
        ...(options.tasks ? { tasks: options.tasks } : {}),
        ...options.deps,
    };
    const host = new DirectorHost(deps);
    return { host, calls, backend, controller, notEnough, highlight, store, deps, refreshes: () => refreshCount };
}

function fakeTasks(outcome: Partial<ProjectTaskState> = {}) {
    const started: Array<{ path: string; body: unknown }> = [];
    const tasks: ProjectTasks = {
        start(request, options) {
            started.push({ path: request.path, body: request.body });
            const state: ProjectTaskState = { id: "task_1", status: "succeeded", priceUsd: 0.31, projectRevision: 12, ...outcome };
            options?.onUpdate?.({ id: "task_1", status: "running" });
            return { id: Promise.resolve("task_1"), done: Promise.resolve(state as never), cancel: async () => ({ accepted: true }), detach: () => undefined };
        },
        follow(taskId, options) {
            options?.onUpdate?.({ id: taskId, status: "running" });
            return { id: Promise.resolve(taskId), done: Promise.resolve({ id: taskId, status: "succeeded", projectRevision: 9 } as never), cancel: async () => ({ accepted: true }), detach: () => undefined };
        },
    };
    return { tasks, started };
}

describe("DirectorHost", () => {
    it("streams a turn into its view, pulls on each change, polls fast meanwhile, and records one undo step", async () => {
        const text = sse([
            ["turn.started", { turn_id: TURN_ID, hold_usd: 0.429, revision_start: 7 }],
            ["turn.thinking", { round: 1 }],
            ["tool.started", { call_id: "c1", tool: "edit_project_timeline", label: "Edit: shorter", args: {} }],
            ["project.revision", { revision: 8, change: { revision: 8, label: "AI: shorter", scenes: ["s2"], clips: ["c1"], tracks: false, project: false } }],
            ["tool.finished", { call_id: "c1", tool: "edit_project_timeline", ok: true, summary: "1 scene changed", revision: 8 }],
            ["message", { round: 1, text: "Done: scene 2 is 4 s." }],
            ["turn.finished", turnJson()],
        ]);
        const { host, calls, backend, controller, highlight } = harness({ stream: async () => ({ status: 200, body: streamOf(text) }) });
        await host.open();
        expect(await host.send("Make it shorter")).toBe(true);
        const turn = host.snapshot().turns.at(-1)!;
        expect(turn).toMatchObject({ turnId: TURN_ID, status: "completed", texts: ["Done: scene 2 is 4 s."], chargedUsd: 0.052, step: { stepId: 41, label: "AI: Done: scene 2 is 4 s.", undone: false } });
        expect(turn.cards).toEqual([expect.objectContaining({ label: "Edit: shorter", done: true, ok: true, summary: "1 scene changed", revision: 8 })]);
        const post = calls.find((c) => c.path === "/v1/projects/p1/director/turns" && c.method === "POST")!;
        expect(post.request!.body).toMatchObject({ message: "Make it shorter", max_tool_usd: 0, stream: true, client_revision: 7, selection: { scene_ids: ["s2"] } });
        expect(backend.pullSoon).toHaveBeenCalledWith("cloud-p1");
        expect(backend.setAiActive.mock.calls).toEqual([["cloud-p1", 1], ["cloud-p1", -1]]);
        expect(backend.recordRemoteGroup).toHaveBeenCalledWith("cloud-p1", 1, { label: "AI: Done: scene 2 is 4 s.", toRevision: 8, entities: { scenes: ["s2"], clips: ["c1"], tracks: false, project: false } }, { timeoutMs: 0 });
        expect(backend.waitForRevision).toHaveBeenCalledWith("cloud-p1", 8);
        expect(controller.recordExternalStep).toHaveBeenCalledTimes(1);
        expect(highlight).toHaveBeenCalledWith({ scenes: ["s2"], clips: ["c1"] }, true);
        expect(host.snapshot().running).toBe(false);
    });

    it("shows the price of a message and checks the balance before sending anything", async () => {
        const { host, calls, notEnough } = harness({ balance: 0.2, stream: async () => { throw new Error("not sent"); } });
        await host.open();
        expect(host.snapshot().quote).toMatchObject({ holdUsd: 0.429, typicalUsd: 0.078 });
        expect(await host.send("Hi")).toBe(false);
        expect(notEnough).toHaveBeenCalledWith(0.429, "message");
        expect(calls.some((c) => c.path.endsWith("/director/turns") && c.method === "POST")).toBe(false);
    });

    it("a 402 shows Buy credits; turn_in_progress offers Stop it, which cancels the other device's turn", async () => {
        let refusal: CloudApiError = new CloudApiError(402, "insufficient_balance", "low");
        const { host, calls, notEnough, refreshes } = harness({ stream: async () => { throw refusal; } });
        await host.send("Hi");
        expect(notEnough).toHaveBeenCalled();
        expect(refreshes()).toBe(1);
        expect(host.snapshot().turns.at(-1)!.error).toEqual({ code: "insufficient_balance" });
        refusal = new CloudApiError(409, "turn_in_progress", "busy", { details: { turn_id: OTHER_TURN } });
        await host.send("Again");
        expect(host.snapshot().busyElsewhere).toBe(OTHER_TURN);
        await host.stopOther();
        expect(calls.some((c) => c.path === `/v1/projects/p1/director/turns/${OTHER_TURN}/cancel`)).toBe(true);
        expect(host.snapshot().busyElsewhere).toBeNull();
    });

    it("signed out: opens Sign in with OpenNan and sends nothing when it is dismissed", async () => {
        const { host, calls, deps } = harness({ signedIn: false, stream: async () => { throw new Error("not sent"); } });
        expect(await host.send("Hi")).toBe(false);
        expect(deps.openSignIn).toHaveBeenCalled();
        expect(calls).toHaveLength(0);
    });

    it("Stop asks the server to cancel the running turn and keeps reading its end and charge", async () => {
        let push!: (text: string) => void;
        let close!: () => void;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                push = (text) => c.enqueue(new TextEncoder().encode(text));
                close = () => c.close();
            },
        });
        const { host, calls } = harness({ stream: async () => ({ status: 200, body }) });
        const sending = host.send("Long one");
        push(sse([["turn.started", { turn_id: TURN_ID, hold_usd: 0.429, revision_start: 7 }]]));
        await vi.waitFor(() => expect(host.snapshot().turns.at(-1)!.turnId).toBe(TURN_ID));
        await host.stop();
        expect(calls.some((c) => c.path === `/v1/projects/p1/director/turns/${TURN_ID}/cancel`)).toBe(true);
        push(sse([["turn.finished", turnJson({ status: "cancelled", charged_usd: 0.026, changes: [] })]]));
        close();
        await sending;
        expect(host.snapshot().turns.at(-1)).toMatchObject({ status: "cancelled", chargedUsd: 0.026, stopping: false, step: null });
    });

    it("proposals: another project's request is blocked; Run prices again, checks the hold and sends the exact request", async () => {
        const { tasks, started } = fakeTasks();
        const text = sse([
            ["turn.started", { turn_id: TURN_ID, hold_usd: 0.429, revision_start: 7 }],
            ["proposal", { call_id: "c1", tool: "generate_storyboard", label: "Draw a storyboard", args: { scene: 2 }, quote: { price_usd: 0.25, hold_usd: 0.25 }, request: { method: "POST", path: "/v1/projects/p1/scenes/s2/storyboard", body: { model: "auto" } } }],
            ["proposal", { call_id: "c2", tool: "generate_storyboard", label: "Elsewhere", args: {}, quote: { price_usd: 0.1, hold_usd: 0.1 }, request: { method: "POST", path: "/v1/projects/other/scenes/s2/storyboard", body: {} } }],
            ["turn.finished", turnJson({ changes: [] })],
        ]);
        const { host, calls, backend, notEnough } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(text) }) });
        await host.send("Draw scene 2");
        const turn = host.snapshot().turns.at(-1)!;
        expect(turn.proposals.map((p) => p.state)).toEqual(["ready", "blocked"]);
        expect(await host.runProposal(turn.key, "c2")).toBe(false);
        // The fresh quote (0.31) is above the proposal's (0.25): nothing runs, the card shows the new price.
        expect(await host.runProposal(turn.key, "c1")).toBe(false);
        expect(host.snapshot().turns.at(-1)!.proposals[0]).toMatchObject({ state: "ready", quote: { holdUsd: 0.31 }, error: { code: "price_changed" } });
        expect(started).toHaveLength(0);
        expect(await host.runProposal(turn.key, "c1")).toBe(true);
        expect(calls.find((c) => c.path === "/v1/quotes" && (c.request!.body as { tool: string }).tool === "storyboard")!.request!.body).toEqual({ tool: "storyboard", project_id: "p1", scene_id: "s2", inputs: { model: "auto" } });
        expect(started).toEqual([{ path: "/v1/projects/p1/scenes/s2/storyboard", body: { model: "auto" } }]);
        const proposal = host.snapshot().turns.at(-1)!.proposals[0]!;
        expect(proposal.task).toMatchObject({ status: "succeeded", holdUsd: 0.31, priceUsd: 0.31 });
        expect(proposal.state).toBe("done");
        expect(backend.recordRemoteGroup).toHaveBeenLastCalledWith("cloud-p1", 1, { label: "AI: Draw a storyboard", toRevision: 12, entities: { scenes: ["s2"], clips: [], tracks: false, project: false } }, { timeoutMs: 0 });
        expect(notEnough).not.toHaveBeenCalled();
    });

    it("a step the balance can't hold is not sent", async () => {
        const { tasks, started } = fakeTasks();
        const { host, notEnough } = harness({ tasks, balance: 0.05 });
        const { pipelineRequest } = await import("@opennan/director-client");
        expect((await host.runStep(pipelineRequest("storyboard", "p1", { sceneId: "s1" }), "Draw", { priceUsd: 0.31, holdUsd: 0.31 })).started).toBe(false);
        expect(notEnough).toHaveBeenCalledWith(0.31, "step");
        expect(started).toHaveLength(0);
    });

    it("a step without any price never runs", async () => {
        const { tasks, started } = fakeTasks();
        const { host } = harness({ tasks, request: (call) => {
            if (call.path === "/v1/quotes") throw new CloudApiError(503, "unavailable", "down");
            return {};
        } });
        const { pipelineRequest } = await import("@opennan/director-client");
        expect(await host.runStep(pipelineRequest("storyboard", "p1", { sceneId: "s1" }), "Draw", null)).toMatchObject({ started: false, error: { code: "price_unavailable" } });
        expect(started).toHaveLength(0);
    });

    it("a paid step inside the budget: its card follows the task and its result is its own undo step", async () => {
        const { tasks } = fakeTasks();
        const text = sse([
            ["turn.started", { turn_id: TURN_ID, hold_usd: 0.429, revision_start: 7 }],
            ["tool.started", { call_id: "c1", tool: "generate_storyboard", label: "Draw a storyboard", args: {} }],
            ["tool.finished", { call_id: "c1", tool: "generate_storyboard", ok: true, summary: "Started (holds $0.31)", task: { id: "task_5", tool: "storyboard", status: "queued", hold_usd: 0.31 } }],
            ["turn.finished", turnJson({ changes: [] })],
        ]);
        const { host, backend } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(text) }) });
        host.setBudget(5);
        await host.send("Draw it");
        await vi.waitFor(() => expect(host.snapshot().turns.at(-1)!.cards[0]!.task).toMatchObject({ id: "task_5", status: "succeeded" }));
        await vi.waitFor(() => expect(backend.recordRemoteGroup).toHaveBeenCalledWith("cloud-p1", 1, expect.objectContaining({ label: "AI: Draw a storyboard", toRevision: 9 }), { timeoutMs: 0 }));
    });

    it("Undo AI: the newest step is ⌘Z; an older one is undone as a new step", async () => {
        const text = sse([["turn.started", { turn_id: TURN_ID, hold_usd: 0.4, revision_start: 7 }], ["turn.finished", turnJson()]]);
        const newest = harness({ stream: async () => ({ status: 200, body: streamOf(text) }) });
        await newest.host.send("x");
        const key = newest.host.snapshot().turns.at(-1)!.key;
        expect(await newest.host.undoTurn(key)).toBe(true);
        expect(newest.controller.execute).toHaveBeenCalledWith({ type: "history.undo" });
        expect(newest.host.snapshot().turns.at(-1)!.step!.undone).toBe(true);
        expect(await newest.host.undoTurn(key)).toBe(false);

        const older = harness({ newest: false, stream: async () => ({ status: 200, body: streamOf(text) }) });
        await older.host.send("x");
        expect(await older.host.undoTurn(older.host.snapshot().turns.at(-1)!.key)).toBe(true);
        expect(older.backend.undoRemoteStep).toHaveBeenCalledWith("cloud-p1", 41, "Undo AI: Done: scene 2 is 4 s.");
        expect(older.controller.execute).not.toHaveBeenCalled();
    });

    it("remembers the paid tools budget per device", () => {
        const { host, store } = harness();
        expect(host.snapshot().budgetUsd).toBe(0);
        host.setBudget(5);
        expect(store.get(BUDGET_STORAGE_KEY)).toBe("5");
        expect(host.snapshot().budgetUsd).toBe(5);
    });

    it("loads the history oldest first, and a running turn there makes Send wait", async () => {
        const { host } = harness({ request: (call) => {
            if (call.path.endsWith("/director/turns")) return { data: [turnJson({ id: OTHER_TURN, status: "running" }), turnJson({ message: "first" })], has_more: true, next_cursor: TURN_ID };
            return { price_usd: 0.4, hold_usd: 0.4, priced: {} };
        } });
        await host.open();
        expect(host.snapshot().turns.map((t) => t.message)).toEqual(["first", "Make it shorter"]);
        expect(host.snapshot().turns[0]!.past).toBe(true);
        expect(host.snapshot().hasMore).toBe(true);
        expect(host.snapshot().busyElsewhere).toBe(OTHER_TURN);
    });

    it("shows a server field message only when it is one plain short line", () => {
        expect(safeDetail("message: at most 4,000 characters", true)).toBe("message: at most 4,000 characters");
        expect(safeDetail("see https://x", true)).toBeNull();
        expect(safeDetail("ok", false)).toBeNull();
        expect(safeDetail("Traceback (most recent call last)", true)).toBeNull();
    });

    it("reads the script and saves it with If-Match; a 412 saves over only when the script is still what was read", async () => {
        let patches = 0;
        let theirs = "Night.";
        const { host, calls } = harness({ request: (call) => {
            if (call.path === "/v1/projects/p1/script") return { object: "project_script", script_text: theirs, srt_content: null, cues: 0, revision: 9 };
            if (call.method === "PATCH") {
                patches += 1;
                if (patches % 2 === 1) throw new CloudApiError(412, "timeline_changed", "changed", { details: { revision: 9 } });
                return {};
            }
            return {};
        } });
        const read = await host.readScript();
        expect(read).toEqual({ scriptText: "Night.", srtContent: null, cues: 0, revision: 9 });
        const srt = "1\n00:00:00,000 --> 00:00:02,000\nDay.\n";
        expect(await host.saveScript({ scriptText: "Day.", srtContent: srt }, { ...read, revision: 7 })).toEqual({ saved: true });
        const sent = calls.filter((c) => c.method === "PATCH");
        expect(sent.map((c) => c.request!.headers)).toEqual([{ "If-Match": '"r7"' }, { "If-Match": '"r9"' }]);
        expect(sent[0]!.request!.body).toEqual({ script_text: "Day.", srt_content: srt });
        // Someone else changed the script meanwhile: nothing is saved over it.
        theirs = "Their night.";
        expect(await host.saveScript({ scriptText: "Day.", srtContent: srt }, { ...read, revision: 7 })).toEqual({ saved: false, conflict: expect.objectContaining({ scriptText: "Their night." }) });
        expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(3);
    });

    it("a failed paid step shows a failure toast with Retry (never retried on its own)", async () => {
        const { tasks, started } = fakeTasks({ status: "failed", error: { message: "The scene could not be drawn.", refunded: true } } as never);
        const failed = vi.fn();
        const { host } = harness({ tasks });
        (host as unknown as { deps: DirectorHostDeps }).deps.failed = failed;
        const { pipelineRequest } = await import("@opennan/director-client");
        const outcome = await host.runStep(pipelineRequest("storyboard", "p1", { sceneId: "s1" }), "Scene 1", { priceUsd: 0.31, holdUsd: 0.31 });
        expect(outcome).toMatchObject({ started: true, task: { status: "failed", error: { code: "task_failed", refunded: true } } });
        expect(started).toHaveLength(1);
        expect(failed).toHaveBeenCalledTimes(1);
        const [task, retry] = failed.mock.calls[0]!;
        expect(task).toMatchObject({ label: "Scene 1", status: "failed" });
        retry();
        await vi.waitFor(() => expect(started).toHaveLength(2));
    });

    it("checks the total hold of several steps before any of them runs", async () => {
        const { host, notEnough } = harness({ balance: 0.5 });
        expect(await host.checkHold(0.31)).toBe(true);
        expect(await host.checkHold(0.62)).toBe(false);
        expect(notEnough).toHaveBeenCalledWith(0.62, "step");
    });

    describe("never above the price shown", () => {
        it("a price that went up runs nothing: the card shows the new price, and the next click runs at it", async () => {
            const { tasks, started } = fakeTasks();
            const { host } = harness({ tasks, request: (call) => (call.path === "/v1/quotes" ? { price_usd: 0.4, hold_usd: 0.4 } : {}) });
            const { pipelineRequest } = await import("@opennan/director-client");
            const request = pipelineRequest("storyboard", "p1", { sceneId: "s1" });
            const first = await host.runStep(request, "Scene 1", { priceUsd: 0.31, holdUsd: 0.31 });
            expect(first).toMatchObject({ started: false, error: { code: "price_changed", priceUsd: 0.4 }, quote: { holdUsd: 0.4 } });
            expect(started).toHaveLength(0);
            expect((await host.runStep(request, "Scene 1", first.quote!)).started).toBe(true);
            expect(started).toHaveLength(1);
        });

        it("a task the server priced above what was shown is cancelled at once (refunded)", async () => {
            const cancel = vi.fn(async () => ({ accepted: true as const }));
            const tasks: ProjectTasks = {
                start(_request, options) {
                    options?.onUpdate?.({ id: "task_1", status: "queued", priceUsd: 0.5 });
                    return { id: Promise.resolve("task_1"), done: Promise.resolve({ id: "task_1", status: "cancelled", error: { message: "", refunded: true } } as never), cancel, detach: () => undefined };
                },
                follow: () => { throw new Error("unused"); },
            };
            const failed = vi.fn();
            const { host, deps } = harness({ tasks });
            deps.failed = failed;
            const { pipelineRequest } = await import("@opennan/director-client");
            const outcome = await host.runStep(pipelineRequest("storyboard", "p1", { sceneId: "s1" }), "Scene 1", { priceUsd: 0.31, holdUsd: 0.31 });
            expect(cancel).toHaveBeenCalledTimes(1);
            expect(outcome.task).toMatchObject({ status: "failed", error: { code: "price_changed", priceUsd: 0.5 } });
            expect(failed).toHaveBeenCalled();
        });

        it("a double click starts one paid task; a Retry after a lost POST answer reuses its Idempotency-Key", async () => {
            const keys: Array<string | undefined> = [];
            let lose = true;
            const tasks: ProjectTasks = {
                start(_request, options) {
                    keys.push(options?.idempotencyKey);
                    if (lose) {
                        lose = false;
                        const error = new CloudApiError(0, "network", "lost");
                        return { id: Promise.reject(error), done: Promise.reject(error), cancel: async () => ({ accepted: true }), detach: () => undefined };
                    }
                    return { id: Promise.resolve("task_1"), done: Promise.resolve({ id: "task_1", status: "succeeded", projectRevision: 3 } as never), cancel: async () => ({ accepted: true }), detach: () => undefined };
                },
                follow: () => { throw new Error("unused"); },
            };
            const { host } = harness({ tasks });
            const { pipelineRequest } = await import("@opennan/director-client");
            const request = pipelineRequest("storyboard", "p1", { sceneId: "s1" });
            const quote = { priceUsd: 0.31, holdUsd: 0.31 };
            const [a, b] = await Promise.all([host.runStep(request, "S", quote), host.runStep(request, "S", quote)]);
            expect([a.error?.code, b.started]).toEqual(["network", false]);
            expect(keys).toHaveLength(1);
            expect((await host.runStep(request, "S", quote)).started).toBe(true);
            expect(keys).toHaveLength(2);
            expect(keys[1]).toBe(keys[0]);
        });
    });

    describe("review fixes", () => {
        it("the busy banner clears by itself when the other device's turn ends", async () => {
            vi.useFakeTimers();
            try {
                let running = true;
                const { host } = harness({ request: (call) => {
                    if (call.path.endsWith("/director/turns")) return { data: [turnJson({ id: OTHER_TURN, status: "running" })], has_more: false, next_cursor: null };
                    if (call.path.endsWith(OTHER_TURN)) return turnJson({ id: OTHER_TURN, status: running ? "running" : "completed" });
                    return { price_usd: 0.4, hold_usd: 0.4, priced: {} };
                } });
                await host.open();
                expect(host.snapshot().busyElsewhere).toBe(OTHER_TURN);
                await vi.advanceTimersByTimeAsync(5_000);
                expect(host.snapshot().busyElsewhere).toBe(OTHER_TURN);
                running = false;
                await vi.advanceTimersByTimeAsync(5_000);
                expect(host.snapshot().busyElsewhere).toBeNull();
                host.dispose();
            } finally {
                vi.useRealTimers();
            }
        });

        it("a refused message returns false (the composer keeps its text)", async () => {
            const { host } = harness({ stream: async () => { throw new CloudApiError(429, "rate_limit_exceeded", "slow", { retryAfterSeconds: 20 }); } });
            expect(await host.send("Hi")).toBe(false);
            expect(host.snapshot().turns.at(-1)!.error).toEqual({ code: "rate_limit_exceeded", retryAfterSeconds: 20 });
        });

        it("a paid step the director ran inside the budget is undone for its own scene only", async () => {
            const { tasks } = fakeTasks();
            const text = sse([
                ["turn.started", { turn_id: TURN_ID, hold_usd: 0.429, revision_start: 7 }],
                ["tool.started", { call_id: "c1", tool: "generate_storyboard", label: "Draw a storyboard", args: { scene_id: "s9" } }],
                ["tool.finished", { call_id: "c1", tool: "generate_storyboard", ok: true, summary: "Started", task: { id: "task_5", tool: "storyboard", status: "queued", hold_usd: 0.31 } }],
                ["turn.finished", turnJson({ changes: [] })],
            ]);
            const { host, backend } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(text) }) });
            await host.send("Draw it");
            await vi.waitFor(() => expect(backend.recordRemoteGroup).toHaveBeenCalledWith("cloud-p1", 1, expect.objectContaining({ entities: { scenes: ["s9"], clips: [], tracks: false, project: false } }), { timeoutMs: 0 }));
        });
    });
});

describe("DirectorHost proposals run by id (phase 9c)", () => {
    const PROP = "prop_89abcdef0123456789abcdef";
    const runPath = `/v1/projects/p1/director/turns/${TURN_ID}/proposals/${PROP}/run`;
    const proposalJson = (overrides: Record<string, unknown> = {}) => ({
        id: PROP, call_id: "c1", tool: "generate_storyboard", label: "Draw a storyboard", args: { scene: 2 }, quote: { price_usd: 0.31, hold_usd: 0.31 },
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        request: { method: "POST", path: "/v1/projects/p1/scenes/s2/storyboard", body: { model: "auto" } }, run: { method: "POST", path: runPath, body: {} }, ...overrides,
    });
    const turnWith = (proposal: Record<string, unknown>) => sse([
        ["turn.started", { turn_id: TURN_ID, hold_usd: 0.429, revision_start: 7 }],
        ["proposal", proposal],
        ["turn.finished", turnJson({ changes: [] })],
    ]);

    /** A task runner whose first start is refused with `refusal` (then starts normally). */
    function refusingTasks(refusal: CloudApiError | null) {
        const started: Array<{ path: string; body: unknown }> = [];
        const keys: Array<string | undefined> = [];
        let refuse = refusal;
        const tasks: ProjectTasks = {
            start(request, options) {
                started.push({ path: request.path, body: request.body });
                keys.push(options?.idempotencyKey);
                if (refuse) {
                    const error = refuse;
                    refuse = null;
                    const failed = Promise.reject(error);
                    failed.catch(() => undefined);
                    return { id: failed as Promise<string>, done: failed as never, cancel: async () => ({ accepted: true }), detach: () => undefined };
                }
                options?.onUpdate?.({ id: "task_1", status: "running", priceUsd: 0.31 });
                return { id: Promise.resolve("task_1"), done: Promise.resolve({ id: "task_1", status: "succeeded", priceUsd: 0.31, projectRevision: 12 } as never), cancel: async () => ({ accepted: true }), detach: () => undefined };
            },
            follow: () => { throw new Error("not used"); },
        };
        return { tasks, started, keys };
    }

    it("Run posts the proposal's opaque run request ({}), at the proposal's own price, and its result is one undo step of its scene", async () => {
        const { tasks, started } = refusingTasks(null);
        const { host, calls, backend } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }) });
        await host.send("Draw scene 2");
        const turn = host.snapshot().turns.at(-1)!;
        expect(turn.proposals[0]).toMatchObject({ state: "ready", quote: { holdUsd: 0.31 }, run: { path: runPath, tool: "storyboard" } });
        expect(await host.runProposal(turn.key, "c1")).toBe(true);
        expect(started).toEqual([{ path: runPath, body: {} }]);
        // The server locks the price: no tool quote is read for a run by id.
        expect(calls.filter((c) => c.path === "/v1/quotes" && (c.request!.body as { tool: string }).tool === "storyboard")).toHaveLength(0);
        expect(host.snapshot().turns.at(-1)!.proposals[0]).toMatchObject({ state: "done", task: { status: "succeeded", holdUsd: 0.31 } });
        expect(backend.recordRemoteGroup).toHaveBeenLastCalledWith("cloud-p1", 1, expect.objectContaining({ entities: { scenes: ["s2"], clips: [], tracks: false, project: false } }), { timeoutMs: 0 });
    });

    it("a price that rose (409 proposal_price_changed) is shown and runs nothing; the next click runs the step's own request at most at it", async () => {
        const changed = new CloudApiError(409, "proposal_price_changed", "costs more now", { details: { price_usd: 0.36 }, fromServer: true });
        const { tasks, started } = refusingTasks(changed);
        const { host } = harness({
            tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }),
            request: (call) => (call.path === "/v1/quotes" ? { price_usd: 0.36, hold_usd: 0.36 } : { data: [], has_more: false, next_cursor: null }),
        });
        await host.send("Draw scene 2");
        const key = host.snapshot().turns.at(-1)!.key;
        expect(await host.runProposal(key, "c1")).toBe(false);
        expect(host.snapshot().turns.at(-1)!.proposals[0]).toMatchObject({ state: "ready", quote: { holdUsd: 0.36 }, error: { code: "price_changed", priceUsd: 0.36 } });
        expect(started).toEqual([{ path: runPath, body: {} }]);
        expect(await host.runProposal(key, "c1")).toBe(true);
        expect(started[1]).toEqual({ path: "/v1/projects/p1/scenes/s2/storyboard", body: { model: "auto" } });
    });

    it("never runs a rose price on its own, and a fresh quote above the new price still runs nothing", async () => {
        const changed = new CloudApiError(409, "proposal_price_changed", "costs more now", { details: { price_usd: 0.36 }, fromServer: true });
        const { tasks, started } = refusingTasks(changed);
        const { host } = harness({
            tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }),
            request: (call) => (call.path === "/v1/quotes" ? { price_usd: 0.5, hold_usd: 0.5 } : { data: [], has_more: false, next_cursor: null }),
        });
        await host.send("Draw scene 2");
        const key = host.snapshot().turns.at(-1)!.key;
        await host.runProposal(key, "c1");
        expect(started).toHaveLength(1);
        expect(await host.runProposal(key, "c1")).toBe(false);
        expect(started).toHaveLength(1);
        expect(host.snapshot().turns.at(-1)!.proposals[0]).toMatchObject({ quote: { holdUsd: 0.5 }, error: { code: "price_changed", priceUsd: 0.5 } });
    });

    it("an expired proposal (410, or past expires_at) asks to ask the director again and sends nothing", async () => {
        const gone = new CloudApiError(410, "proposal_expired", "expired", { fromServer: true });
        const { tasks, started } = refusingTasks(gone);
        const { host } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }) });
        await host.send("Draw scene 2");
        const key = host.snapshot().turns.at(-1)!.key;
        expect(await host.runProposal(key, "c1")).toBe(false);
        expect(host.snapshot().turns.at(-1)!.proposals[0]).toMatchObject({ state: "expired" });
        expect(await host.runProposal(key, "c1")).toBe(false);
        expect(started).toHaveLength(1);

        const late = refusingTasks(null);
        const old = harness({ tasks: late.tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson({ expires_at: new Date(Date.now() - 1000).toISOString() }))) }) });
        await old.host.send("Draw scene 2");
        const turn = old.host.snapshot().turns.at(-1)!;
        expect(turn.proposals[0]!.state).toBe("expired");
        expect(await old.host.runProposal(turn.key, "c1")).toBe(false);
        expect(late.started).toHaveLength(0);
    });

    it("a run path that is not this project's falls back to the step's own request (9b rules); an older server's proposal too", async () => {
        const { tasks, started } = refusingTasks(null);
        const bad = proposalJson({ run: { method: "POST", path: runPath.replace("/p1/", "/other/"), body: {} } });
        const { host } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(bad)) }) });
        await host.send("Draw scene 2");
        const turn = host.snapshot().turns.at(-1)!;
        expect(turn.proposals[0]!.run).toBeNull();
        expect(await host.runProposal(turn.key, "c1")).toBe(true);
        expect(started).toEqual([{ path: "/v1/projects/p1/scenes/s2/storyboard", body: { model: "auto" } }]);
    });

    it("a past proposal that already ran shows Ran (never runs again)", async () => {
        const { tasks, started } = refusingTasks(null);
        const { host } = harness({
            tasks, request: (call) => (call.path.endsWith("/director/turns") ? { data: [turnJson({ changes: [], proposals: [{ ...proposalJson(), task_id: "task_9" }] })], has_more: false, next_cursor: null } : {}),
        });
        await host.open();
        const turn = host.snapshot().turns.at(-1)!;
        expect(turn.proposals[0]).toMatchObject({ state: "ran", taskId: "task_9" });
        expect(await host.runProposal(turn.key, "c1")).toBe(false);
        expect(started).toHaveLength(0);
    });

    describe("Idempotency-Key per click (9c.1)", () => {
        it("each click sends its own key; a Retry after a lost answer sends the same request with the same key", async () => {
            const lost = new CloudApiError(0, "network", "Can't reach OpenNan.");
            const { tasks, started, keys } = refusingTasks(lost);
            let retry: (() => void) | null = null;
            const { host } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }), deps: { failed: (_task, again) => void (retry = again) } });
            await host.send("Draw scene 2");
            await host.runProposal(host.snapshot().turns.at(-1)!.key, "c1");
            retry!();
            await vi.waitFor(() => expect(started).toHaveLength(2));
            expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
            expect(keys[1]).toBe(keys[0]);
        });

        it("a price that rose and the next click: two clicks, two keys", async () => {
            const changed = new CloudApiError(409, "proposal_price_changed", "costs more now", { details: { price_usd: 0.31 }, fromServer: true });
            const { tasks, keys } = refusingTasks(changed);
            const { host } = harness({
                tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }),
                request: (call) => (call.path === "/v1/quotes" ? { price_usd: 0.31, hold_usd: 0.31 } : { data: [], has_more: false, next_cursor: null }),
            });
            await host.send("Draw scene 2");
            const key = host.snapshot().turns.at(-1)!.key;
            await host.runProposal(key, "c1");
            await host.runProposal(key, "c1");
            expect(keys).toHaveLength(2);
            expect(keys[1]).not.toBe(keys[0]);
        });

        it("409 idempotency_key_reused runs nothing: the card says so, and the next click sends a fresh key", async () => {
            const reused = new CloudApiError(409, "idempotency_key_reused", "This Idempotency-Key was already used for another run request.", { fromServer: true });
            const { tasks, started, keys } = refusingTasks(reused);
            const { host, backend } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }) });
            await host.send("Draw scene 2");
            const key = host.snapshot().turns.at(-1)!.key;
            expect(await host.runProposal(key, "c1")).toBe(false);
            expect(host.snapshot().turns.at(-1)!.proposals[0]).toMatchObject({ state: "ready", error: { code: "idempotency_key_reused" } });
            expect(host.snapshot().tasks).toEqual([]);
            expect(backend.endRemoteGroup).toHaveBeenCalled();
            expect(await host.runProposal(key, "c1")).toBe(true);
            expect(started.map((s) => s.path)).toEqual([runPath, runPath]);
            expect(keys[1]).not.toBe(keys[0]);
        });

        it("a lost answer's key stays with its own run: another proposal of the same step gets a fresh one", async () => {
            const lost = new CloudApiError(0, "network", "Can't reach OpenNan.");
            const { tasks, started, keys } = refusingTasks(lost);
            const OTHER = "prop_00000000000000000000000f";
            let turns = 0;
            const { host } = harness({
                tasks,
                stream: async () => ({ status: 200, body: streamOf(turnWith(turns++ === 0 ? proposalJson() : proposalJson({ id: OTHER, call_id: "c2", run: { method: "POST", path: runPath.replace(PROP, OTHER), body: {} } }))) }),
            });
            await host.send("Draw scene 2");
            await host.runProposal(host.snapshot().turns.at(-1)!.key, "c1");
            await host.send("Draw scene 2 again");
            await host.runProposal(host.snapshot().turns.at(-1)!.key, "c2");
            expect(started.map((s) => s.path)).toEqual([runPath, runPath.replace(PROP, OTHER)]);
            expect(keys[1]).not.toBe(keys[0]);
        });
    });

    describe("review fixes (phase 9c)", () => {
        it("Retry after a run by id whose answer was lost sends the run request again (the server answers the same task), never the step's route", async () => {
            const lost = new CloudApiError(0, "network", "Can't reach OpenNan.");
            const { tasks, started } = refusingTasks(lost);
            let retry: (() => void) | null = null;
            const { host } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }), deps: { failed: (_task, again) => void (retry = again) } });
            await host.send("Draw scene 2");
            await host.runProposal(host.snapshot().turns.at(-1)!.key, "c1");
            expect(retry).not.toBeNull();
            retry!();
            await vi.waitFor(() => expect(started).toHaveLength(2));
            expect(started.map((s) => s.path)).toEqual([runPath, runPath]);
        });

        it("a proposal past its expiry sends nothing, even after its price rose", async () => {
            let now = Date.now();
            const changed = new CloudApiError(409, "proposal_price_changed", "x", { details: { price_usd: 0.36 }, fromServer: true });
            const { tasks, started } = refusingTasks(changed);
            const { host } = harness({ tasks, deps: { now: () => now }, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }) });
            await host.send("Draw scene 2");
            const key = host.snapshot().turns.at(-1)!.key;
            await host.runProposal(key, "c1");
            now += 20 * 60_000;
            expect(await host.runProposal(key, "c1")).toBe(false);
            expect(host.snapshot().turns.at(-1)!.proposals[0]!.state).toBe("expired");
            expect(started).toHaveLength(1);
        });

        it("a run path naming another proposal is never used (the step's own request is)", async () => {
            const { tasks, started } = refusingTasks(null);
            const other = proposalJson({ run: { method: "POST", path: runPath.replace(PROP, "prop_ffffffffffffffffffffffff"), body: {} } });
            const { host } = harness({ tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(other)) }) });
            await host.send("Draw scene 2");
            const turn = host.snapshot().turns.at(-1)!;
            expect(turn.proposals[0]!.run).toBeNull();
            await host.runProposal(turn.key, "c1");
            expect(started[0]!.path).toBe("/v1/projects/p1/scenes/s2/storyboard");
        });

        it("a price rise without the new price shows no figure, and the next click is priced again first", async () => {
            const changed = new CloudApiError(409, "proposal_price_changed", "x", { fromServer: true });
            const { tasks, started } = refusingTasks(changed);
            const { host } = harness({
                tasks, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }),
                request: (call) => (call.path === "/v1/quotes" ? { price_usd: 0.4, hold_usd: 0.4 } : { data: [], has_more: false, next_cursor: null }),
            });
            await host.send("Draw scene 2");
            const key = host.snapshot().turns.at(-1)!.key;
            await host.runProposal(key, "c1");
            const card = host.snapshot().turns.at(-1)!.proposals[0]!;
            expect(card).toMatchObject({ state: "ready", priceChanged: true, error: { code: "price_changed" } });
            expect(card.error!.priceUsd).toBeUndefined();
            expect(await host.runProposal(key, "c1")).toBe(false);
            expect(host.snapshot().turns.at(-1)!.proposals[0]).toMatchObject({ quote: { holdUsd: 0.4 }, error: { code: "price_changed", priceUsd: 0.4 } });
            expect(started).toHaveLength(1);
        });

        it("after a run by id failed, Retry runs the step's own request under the fresh-quote rule (the server answers a run only once)", async () => {
            const calls: string[] = [];
            const failing: ProjectTasks = {
                start(request, options) {
                    calls.push(request.path);
                    options?.onUpdate?.({ id: "task_1", status: "running" });
                    return { id: Promise.resolve("task_1"), done: Promise.resolve({ id: "task_1", status: "failed", error: { message: "", refunded: true } } as never), cancel: async () => ({ accepted: true }), detach: () => undefined };
                },
                follow: () => { throw new Error("not used"); },
            };
            const { host } = harness({ tasks: failing, stream: async () => ({ status: 200, body: streamOf(turnWith(proposalJson())) }) });
            await host.send("Draw scene 2");
            const key = host.snapshot().turns.at(-1)!.key;
            await host.runProposal(key, "c1");
            expect(host.snapshot().turns.at(-1)!.proposals[0]!.state).toBe("failed");
            await host.runProposal(key, "c1");
            expect(calls).toEqual([runPath, "/v1/projects/p1/scenes/s2/storyboard"]);
        });
    });
});
