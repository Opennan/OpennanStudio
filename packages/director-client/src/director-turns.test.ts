import { CloudApiError, type CloudApi, type CloudMethod, type CloudRequest } from "@opennan/cloud-backend";
import { cancelTurn, getTurn, listTurns, streamTurn, turnBody } from "./director-turns";
import type { DirectorEvent } from "./director-types";

const TURN = {
    object: "director_turn", id: "turn_0123456789abcdef01234567", project_id: "p1", status: "completed", message: "shorter", reply: "Done.",
    cards: [{ call_id: "c1", tool: "edit_project_timeline", label: "Edit: shorter", args: {}, ok: true, summary: "1 scene changed", revision: 8 }],
    proposals: [], changes: [{ revision: 8, label: "AI: shorter", scenes: ["s1"], clips: [], tracks: false, project: false }], tasks: [],
    revision_start: 7, revision_end: 8, hold_usd: 0.429, charged_usd: 0.026, limits: { rounds: 6 }, finish: "stop", cancel_requested: false, error: null,
    created_at: "2026-10-21T10:00:00Z", finished_at: "2026-10-21T10:00:05Z",
};

function sse(events: Array<[string, unknown]>): string {
    return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function bodyOf(text: string, options: { failAfter?: boolean } = {}): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    let sent = false;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(bytes);
                return;
            }
            if (options.failAfter) controller.error(new TypeError("network error"));
            else controller.close();
        },
    });
}

interface Call { method: CloudMethod; path: string; request?: CloudRequest }

function fakeApi(handlers: {
    stream?: (call: Call) => Promise<{ status: number; body: ReadableStream<Uint8Array> }>;
    request?: (call: Call) => unknown;
    noStream?: boolean;
}) {
    const calls: Call[] = [];
    const api: CloudApi = {
        baseUrl: "https://api.opennan.com",
        async request<T>(method: CloudMethod, path: string, request?: CloudRequest) {
            calls.push({ method, path, request });
            const body = await handlers.request?.({ method, path, request });
            return { status: 200, body: body as T, etag: null };
        },
        ...(handlers.noStream ? {} : {
            async stream(method: CloudMethod, path: string, request?: CloudRequest) {
                calls.push({ method, path, request });
                return handlers.stream!({ method, path, request });
            },
        }),
    };
    return { api, calls };
}

async function all(iterable: AsyncIterable<DirectorEvent>): Promise<DirectorEvent[]> {
    const out: DirectorEvent[] = [];
    for await (const event of iterable) out.push(event);
    return out;
}

describe("turnBody", () => {
    it("writes the server's snake_case body and caps the selection to what it takes", () => {
        const body = turnBody({ message: "hi", maxToolUsd: 5, clientRevision: 3, selection: { sceneIds: Array.from({ length: 60 }, (_, i) => `s${i}`), clipIds: ["c1"], timeSeconds: 2.5 } }, true);
        expect(body).toMatchObject({ message: "hi", max_tool_usd: 5, stream: true, client_revision: 3, selection: { clip_ids: ["c1"], time_seconds: 2.5 } });
        expect((body.selection as { scene_ids: string[] }).scene_ids).toHaveLength(50);
        expect(turnBody({ message: "x" }, false)).toEqual({ message: "x", max_tool_usd: 0, stream: false });
    });

    it("refuses an empty or too long message and a budget outside 0–25", () => {
        expect(() => turnBody({ message: "  " }, true)).toThrow();
        expect(() => turnBody({ message: "a".repeat(4_001) }, true)).toThrow();
        expect(() => turnBody({ message: "a", maxToolUsd: 26 }, true)).toThrow();
        expect(() => turnBody({ message: "a", maxToolUsd: -1 }, true)).toThrow();
    });
});

describe("streamTurn", () => {
    it("posts the turn with its Idempotency-Key and yields the typed events in order", async () => {
        const text = ": ping\n\n" + sse([
            ["turn.started", { turn_id: TURN.id, hold_usd: 0.429, limits: { rounds: 6 }, revision_start: 7 }],
            ["turn.thinking", { round: 1 }],
            ["tool.started", { call_id: "c1", tool: "edit_project_timeline", label: "Edit: shorter", args: { n: 1 } }],
            ["project.revision", { revision: 8, change: { revision: 8, label: "AI: shorter", scenes: ["s1"], clips: [], tracks: false, project: false } }],
            ["tool.finished", { call_id: "c1", tool: "edit_project_timeline", ok: true, summary: "1 scene changed", revision: 8 }],
            ["proposal", { call_id: "c2", tool: "generate_storyboard", label: "Draw a storyboard", args: {}, quote: { price_usd: 0.31, hold_usd: 0.31 }, request: { method: "POST", path: "/v1/projects/p1/scenes/s1/storyboard", body: {} } }],
            ["mystery", { x: 1 }],
            ["message", { round: 1, text: "Done." }],
            ["turn.finished", TURN],
        ]);
        const { api, calls } = fakeApi({ stream: async () => ({ status: 200, body: bodyOf(text) }) });
        const events = await all(streamTurn(api, "p1", { message: "shorter" }, { idempotencyKey: "key-1" }));
        expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/projects/p1/director/turns", request: { body: { message: "shorter", max_tool_usd: 0, stream: true }, headers: { "Idempotency-Key": "key-1" } } });
        expect(events.map((e) => e.type)).toEqual(["turn.started", "turn.thinking", "tool.started", "project.revision", "tool.finished", "proposal", "message", "turn.finished"]);
        expect(events[0]).toEqual({ type: "turn.started", turnId: TURN.id, holdUsd: 0.429, limits: expect.objectContaining({ rounds: 6, toolCalls: 10 }), revisionStart: 7 });
        expect(events[3]).toMatchObject({ type: "project.revision", revision: 8, change: { scenes: ["s1"], label: "AI: shorter" } });
        expect(events[5]).toMatchObject({ proposal: { quote: { priceUsd: 0.31, holdUsd: 0.31 }, request: { path: "/v1/projects/p1/scenes/s1/storyboard" } } });
        expect(events[7]).toMatchObject({ turn: { id: TURN.id, chargedUsd: 0.026, status: "completed", changes: [{ revision: 8 }] } });
    });

    it("a refusal before the stream throws its CloudApiError (code and details)", async () => {
        const { api } = fakeApi({ stream: async () => { throw new CloudApiError(409, "turn_in_progress", "busy", { details: { turn_id: "turn_x" } }); } });
        await expect(all(streamTurn(api, "p1", { message: "x" }))).rejects.toMatchObject({ code: "turn_in_progress", details: { turn_id: "turn_x" } });
    });

    it("an abort asks the server to cancel the started turn once and ends the stream", async () => {
        const controller = new AbortController();
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new TextEncoder().encode(sse([["turn.started", { turn_id: TURN.id, hold_usd: 0.4, revision_start: 1 }]])));
            },
            cancel() {
                cancelled = true;
            },
        });
        const { api, calls } = fakeApi({ stream: async () => ({ status: 200, body }), request: () => ({ ...TURN, status: "cancelled" }) });
        const seen: DirectorEvent[] = [];
        await expect((async () => {
            for await (const event of streamTurn(api, "p1", { message: "x" }, { signal: controller.signal })) {
                seen.push(event);
                controller.abort();
            }
        })()).rejects.toMatchObject({ name: "AbortError" });
        expect(cancelled).toBe(true);
        expect(seen.map((e) => e.type)).toEqual(["turn.started"]);
        expect(calls.filter((c) => c.path.endsWith("/cancel"))).toEqual([expect.objectContaining({ method: "POST", path: `/v1/projects/p1/director/turns/${TURN.id}/cancel` })]);
    });

    it("a stream that drops after the turn started reports it and reads the final turn", async () => {
        const text = sse([["turn.started", { turn_id: TURN.id, hold_usd: 0.4, revision_start: 1 }], ["turn.thinking", { round: 1 }]]);
        let reads = 0;
        const { api } = fakeApi({
            stream: async () => ({ status: 200, body: bodyOf(text, { failAfter: true }) }),
            request: () => (++reads < 2 ? { ...TURN, status: "running" } : { ...TURN, status: "cancelled", charged_usd: 0.01 }),
        });
        const events = await all(streamTurn(api, "p1", { message: "x" }, { pollMs: 1 }));
        expect(events.map((e) => e.type)).toEqual(["turn.started", "turn.thinking", "error", "turn.finished"]);
        expect(events[2]).toMatchObject({ code: "stream_interrupted" });
        expect(events[3]).toMatchObject({ turn: { status: "cancelled", chargedUsd: 0.01 } });
    });

    it("a stream that ends without turn.finished reads the final turn too", async () => {
        const text = sse([["turn.started", { turn_id: TURN.id, hold_usd: 0.4, revision_start: 1 }]]);
        const { api } = fakeApi({ stream: async () => ({ status: 200, body: bodyOf(text) }), request: () => TURN });
        const events = await all(streamTurn(api, "p1", { message: "x" }, { pollMs: 1 }));
        expect(events.map((e) => e.type)).toEqual(["turn.started", "error", "turn.finished"]);
    });

    it("a stream that drops before the turn started throws (nothing to read)", async () => {
        const { api } = fakeApi({ stream: async () => ({ status: 200, body: bodyOf("", { failAfter: true }) }) });
        await expect(all(streamTurn(api, "p1", { message: "x" }))).rejects.toBeDefined();
    });

    it("without streaming it runs the turn as JSON and synthesizes the events", async () => {
        const { api, calls } = fakeApi({ noStream: true, request: () => TURN });
        const events = await all(streamTurn(api, "p1", { message: "x" }));
        expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/projects/p1/director/turns", request: { body: { stream: false } } });
        expect(events.map((e) => e.type)).toEqual(["turn.started", "tool.started", "tool.finished", "project.revision", "message", "turn.finished"]);
    });

    it("a replay (only turn.finished) still yields the turn", async () => {
        const { api } = fakeApi({ stream: async () => ({ status: 200, body: bodyOf(sse([["turn.finished", TURN]])) }) });
        const events = await all(streamTurn(api, "p1", { message: "x" }));
        expect(events.map((e) => e.type)).toEqual(["turn.finished"]);
    });

    it("refuses a project id that is not a server id", async () => {
        const { api } = fakeApi({ noStream: true, request: () => TURN });
        await expect(all(streamTurn(api, "cloud-p1/../x", { message: "x" }))).rejects.toThrow();
    });
});

describe("turn reads", () => {
    it("lists newest first with paging", async () => {
        const { api, calls } = fakeApi({ request: () => ({ object: "list", data: [TURN], has_more: true, next_cursor: "turn_1" }) });
        const page = await listTurns(api, "p1", { limit: 20, cursor: "turn_aaaaaaaaaaaaaaaaaaaaaaaa" });
        expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/projects/p1/director/turns", request: { query: { limit: 20, cursor: "turn_aaaaaaaaaaaaaaaaaaaaaaaa" } } });
        expect(page).toMatchObject({ turns: [{ id: TURN.id }], hasMore: true, nextCursor: "turn_1" });
    });

    it("gets one turn and cancels one (already finished answers null)", async () => {
        const { api } = fakeApi({ request: ({ path }) => {
            if (path.endsWith("/cancel")) throw new CloudApiError(409, "turn_already_finished", "done");
            return TURN;
        } });
        expect(await getTurn(api, "p1", TURN.id)).toMatchObject({ id: TURN.id });
        expect(await cancelTurn(api, "p1", TURN.id)).toBeNull();
    });
});
