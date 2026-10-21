// The fake OpenNan server's phase 9b surface (testing-director.ts and the script routes of testing-cloud.ts): the
// project script (PATCH script_text / srt_content, GET .../script), AI director turns over SSE with scripted steps,
// the director-turn and project tool quotes, the project pipeline task routes, and their /__test/director knobs.
// Each test pins one rule of opennan.com's public API (director turns, quotes, project pipelines, projects, tasks).
import { fakeProjectToolHold, fakeQuote, startFakeOpenNan, type FakeOpenNan, type FakeProjectFacts } from "./testing";

let fake: FakeOpenNan;
let key: string;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => {
    fake.reset();
    key = fake.mintKey();
});

interface ErrorBody { type?: string; code?: string; message?: string; details?: Record<string, unknown> }
interface Answer { status: number; body: Record<string, any> & { error?: ErrorBody }; headers: Headers }

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth = true): Promise<Answer> {
    const response = await fetch(fake.url + path, {
        method,
        headers: { ...(auth ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

const knob = (path: string, body?: unknown) => fetch(fake.url + path, {
    method: "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, any> }));

const SRT = "1\n00:00:00,000 --> 00:00:02,500\nHello there.\n\n2\n00:00:02,500 --> 00:00:06,000\nHow are you?\n";

async function project(fields: Record<string, unknown> = {}): Promise<string> {
    const created = await call("POST", "/v1/projects", { name: "Film", ...fields });
    expect(created.status).toBe(201);
    return created.body.id as string;
}

describe("the project script", () => {
    it("PATCH stores script_text and srt_content only (no scene made, no revision bump), GET .../script reads them", async () => {
        const id = await project();
        const empty = await call("GET", `/v1/projects/${id}/script`);
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({ object: "project_script", script_text: null, srt_content: null, cues: 0, revision: 0 });
        const patched = await call("PATCH", `/v1/projects/${id}`, { script_text: "Hello there. How are you?", srt_content: SRT }, { "if-match": '"r0"' });
        expect(patched.status).toBe(200);
        expect(patched.body.scene_count).toBe(0);
        expect(patched.body.timeline_revision).toBe(0);
        const read = await call("GET", `/v1/projects/${id}/script`);
        expect(read.body).toEqual({ object: "project_script", script_text: "Hello there. How are you?", srt_content: SRT, cues: 2, revision: 0 });
        expect((await call("GET", `/v1/projects/${id}/document`)).body.scenes).toEqual([]);
    });

    it("null clears; empty strings read as null", async () => {
        const id = await project({ script_text: "A", srt_content: SRT });
        expect((await call("PATCH", `/v1/projects/${id}`, { script_text: null })).status).toBe(200);
        expect((await call("GET", `/v1/projects/${id}/script`)).body).toMatchObject({ script_text: null, srt_content: SRT, cues: 2 });
        expect((await call("PATCH", `/v1/projects/${id}`, { srt_content: "" })).status).toBe(200);
        expect((await call("GET", `/v1/projects/${id}/script`)).body).toMatchObject({ srt_content: null, cues: 0 });
    });

    it("refuses long texts, invalid SRT and more than 500 cues with the server's messages", async () => {
        const id = await project();
        const long = await call("PATCH", `/v1/projects/${id}`, { script_text: "x".repeat(20_001) });
        expect(long.status).toBe(400);
        expect(long.body.error).toMatchObject({ code: "invalid_request", message: "script_text: String should have at most 20000 characters" });
        expect((await call("PATCH", `/v1/projects/${id}`, { srt_content: "x".repeat(200_001) })).status).toBe(400);
        const bad = await call("PATCH", `/v1/projects/${id}`, { srt_content: "not srt" });
        expect(bad.status).toBe(400);
        expect(bad.body.error!.message).toBe("Value error, srt_content is not valid SRT (a cue's first line must be its number)");
        const cues = Array.from({ length: 501 }, (_, i) => `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},500\nLine ${i}`).join("\n\n");
        const many = await call("PATCH", `/v1/projects/${id}`, { srt_content: cues });
        expect(many.status).toBe(400);
        expect(many.body.error!.message).toBe("Value error, srt_content has more than 500 cues; a project starts with at most 500 scenes");
    });

    it("If-Match refuses a stale script write with 412 timeline_changed; the texts count toward project data", async () => {
        const id = await project();
        fake.cloud.bump(id);
        const stale = await call("PATCH", `/v1/projects/${id}`, { script_text: "late" }, { "if-match": '"r0"' });
        expect(stale.status).toBe(412);
        expect(stale.body.error).toMatchObject({ code: "timeline_changed", details: { revision: 1 } });
        const before = (await call("GET", `/v1/projects/${id}`)).body.data_bytes as number;
        await call("PATCH", `/v1/projects/${id}`, { script_text: "y".repeat(1000) });
        expect((await call("GET", `/v1/projects/${id}`)).body.data_bytes).toBe(before + 1000);
        expect((await call("GET", "/v1/projects/nope/script")).status).toBe(404);
    });
});

// ── director turns ─────────────────────────────────────────────────────────────────────────────────────────────

interface Frame { event?: string; data?: any; comment?: string }
interface Streamed { status: number; headers: Headers; frames: Frame[]; raw: string; body?: Record<string, any> }

/** POSTs a turn and reads the SSE stream frame by frame (onFrame runs as each one arrives). */
async function turn(projectId: string, body: Record<string, unknown>, options: { headers?: Record<string, string>; signal?: AbortSignal; onFrame?: (frame: Frame, frames: Frame[]) => unknown } = {}): Promise<Streamed> {
    const response = await fetch(`${fake.url}/v1/projects/${projectId}/director/turns`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...options.headers },
        body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!(response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
        const text = await response.text();
        return { status: response.status, headers: response.headers, frames: [], raw: text, body: text ? JSON.parse(text) : {} };
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Frame[] = [];
    let raw = "";
    let buffer = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            raw += text;
            buffer += text;
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const frame: Frame = {};
                for (const line of block.split("\n")) {
                    if (line.startsWith(":")) frame.comment = line.slice(1).trim();
                    else if (line.startsWith("event: ")) frame.event = line.slice(7);
                    else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
                }
                frames.push(frame);
                await options.onFrame?.(frame, frames);
            }
        }
    } catch (error) {
        if (!options.signal?.aborted) throw error;
    }
    return { status: response.status, headers: response.headers, frames, raw };
}

const events = (s: Streamed) => s.frames.filter((f) => f.event).map((f) => f.event);
const finished = (s: Streamed) => s.frames.find((f) => f.event === "turn.finished")!.data as Record<string, any>;
const script = (steps: unknown[], repeat?: boolean) => knob("/__test/director/script", { steps, ...(repeat !== undefined ? { repeat } : {}) });
const directorState = () => fetch(`${fake.url}/__test/director/state`).then((r) => r.json() as Promise<Record<string, any>>);
const uuid = () => crypto.randomUUID();

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 3000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const value = await read();
        if (ok(value)) return value;
        if (Date.now() - start > ms) throw new Error(`timed out: ${JSON.stringify(value)}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

const TURN_KEYS = ["object", "id", "project_id", "status", "message", "reply", "cards", "proposals", "changes", "tasks", "revision_start", "revision_end",
    "hold_usd", "charged_usd", "limits", "finish", "cancel_requested", "error", "created_at", "finished_at"];
const LIMITS = { rounds: 6, prompt_tokens: 16000, output_tokens: 1500, tool_calls: 10, paid_calls: 3, max_tool_usd: 25, seconds: 240 };

describe("director turns: the stream", () => {
    it("streams named SSE events in order and settles one round (the default script)", async () => {
        const id = await project();
        const s = await turn(id, { message: "Tighten the intro" });
        expect(s.status).toBe(200);
        expect(s.headers.get("content-type")).toMatch(/^text\/event-stream/);
        expect(s.headers.get("cache-control")).toBe("no-cache");
        expect(events(s)).toEqual(["turn.started", "turn.thinking", "message", "turn.finished"]);
        const started = s.frames[0]!.data;
        expect(started).toEqual({ turn_id: expect.stringMatching(/^turn_[0-9a-f]{24}$/), hold_usd: 0.429, limits: LIMITS, revision_start: 0 });
        expect(s.raw.startsWith(`event: turn.started\ndata: ${JSON.stringify(started)}\n\n`)).toBe(true);
        expect(s.frames[1]!.data).toEqual({ round: 1 });
        expect(s.frames[2]!.data).toEqual({ round: 1, text: "Done." });
        const view = finished(s);
        expect(Object.keys(view)).toEqual(TURN_KEYS);
        expect(view).toMatchObject({
            object: "director_turn", id: started.turn_id, project_id: id, status: "completed", message: "Tighten the intro", reply: "Done.", cards: [], proposals: [],
            changes: [], tasks: [], revision_start: 0, revision_end: 0, hold_usd: 0.429, charged_usd: 0.026, limits: LIMITS, finish: "stop", cancel_requested: false, error: null,
        });
        expect(view.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        expect(view.finished_at).toMatch(/Z$/);
        expect(fake.state().balanceUsd).toBeCloseTo(12.4 - 0.026, 9);
    });

    it("answers the finished turn as JSON with stream false", async () => {
        const id = await project();
        await script([{ text: "One." }, { text: "Two." }]);
        const s = await turn(id, { message: "Hi", stream: false });
        expect(s.status).toBe(200);
        expect(s.headers.get("content-type")).toMatch(/application\/json/);
        expect(s.body).toMatchObject({ object: "director_turn", status: "completed", reply: "One.\n\nTwo.", charged_usd: 0.052 });
    });

    it("runs tool, edit and proposal steps: cards, changes with the created ids, a proposal with its quote and request", async () => {
        const id = await project();
        const sceneId = uuid();
        await script([
            { text: "Let me look." },
            { tool: { name: "read_project", label: "Read the project", summary: "0 scenes, 0 clips" } },
            { edit: { label: "Add an opening", changes: { scenes: { create: [{ id: sceneId, caption: "Opening", duration: 5 }] } } } },
            { proposal: { tool: "generate_storyboard", scene_id: sceneId, args: { model: "auto" } } },
            { text: "Proposed a storyboard." },
        ]);
        const s = await turn(id, { message: "Start the film" });
        expect(events(s)).toEqual([
            "turn.started", "turn.thinking", "message", "tool.started", "tool.finished", "tool.started", "project.revision", "tool.finished",
            "tool.started", "proposal", "tool.finished", "turn.thinking", "message", "turn.finished",
        ]);
        const data = (name: string, nth = 0) => s.frames.filter((f) => f.event === name)[nth]!.data;
        expect(data("tool.started")).toEqual({ call_id: "c1", tool: "read_project", label: "Read the project", args: {} });
        expect(data("tool.finished")).toEqual({ call_id: "c1", tool: "read_project", ok: true, summary: "0 scenes, 0 clips" });
        expect(data("tool.started", 1)).toEqual({ call_id: "c2", tool: "edit_project_timeline", label: "Edit: Add an opening", args: { label: "Add an opening", scenes: { create: 1 } } });
        const change = { revision: 1, label: "AI: Add an opening", scenes: [sceneId], clips: [], tracks: false, project: false };
        expect(data("project.revision")).toEqual({ revision: 1, change });
        expect(data("tool.finished", 1)).toEqual({ call_id: "c2", tool: "edit_project_timeline", ok: true, summary: "1 scenes and 0 clips changed", revision: 1 });
        const quote = { price_usd: 0.31, hold_usd: 0.31 };
        const proposalId = data("proposal").id as string;
        expect(proposalId).toMatch(/^prop_[0-9a-f]{24}$/);
        const turnId = s.frames[0]!.data.turn_id as string;
        const proposal = {
            id: proposalId, call_id: "c3", tool: "generate_storyboard", label: "Draw a storyboard", args: { scene_id: sceneId, model: "auto" }, quote,
            expires_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
            request: { method: "POST", path: `/v1/projects/${id}/scenes/${sceneId}/storyboard`, body: { model: "auto", regenerate: false } },
            run: { method: "POST", body: {}, path: `/v1/projects/${id}/director/turns/${turnId}/proposals/${proposalId}/run` },
        };
        expect(data("proposal")).toEqual(proposal);
        const expiresIn = Date.parse(data("proposal").expires_at as string) - Date.now();
        expect(expiresIn).toBeGreaterThan(14 * 60_000);
        expect(expiresIn).toBeLessThan(15 * 60_000 + 1000);
        expect(data("tool.finished", 2)).toEqual({ call_id: "c3", tool: "generate_storyboard", ok: true, summary: "Proposed (≈ $0.31)", proposal: true, quote });
        const view = finished(s);
        expect(view).toMatchObject({ status: "completed", reply: "Let me look.\n\nProposed a storyboard.", changes: [change], proposals: [{ ...proposal, task_id: null }], tasks: [], revision_end: 1, charged_usd: 0.052 });
        expect(view.cards).toEqual([
            { call_id: "c1", tool: "read_project", label: "Read the project", args: {}, ok: true, summary: "0 scenes, 0 clips" },
            { call_id: "c2", tool: "edit_project_timeline", label: "Edit: Add an opening", args: { label: "Add an opening", scenes: { create: 1 } }, ok: true, summary: "1 scenes and 0 clips changed", revision: 1 },
            { call_id: "c3", tool: "generate_storyboard", label: "Draw a storyboard", args: { scene_id: sceneId, model: "auto" }, ok: true, summary: "Proposed (≈ $0.31)", proposal: true, quote },
        ]);
        const doc = (await call("GET", `/v1/projects/${id}/document`)).body;
        expect(doc.scenes.map((x: { id: string; caption: string }) => [x.id, x.caption])).toEqual([[sceneId, "Opening"]]);
        expect(fake.cloud.state().projects[0]!.last_edited_device).toBe("OpenNan director");
    });

    it("opens a round before a first tool step; a refused edit is ok false with its error and the turn goes on", async () => {
        const id = await project();
        await script([{ edit: { label: "Fix", changes: { scenes: { patch: [{ id: "gone", caption: "x" }] } } } }, { text: "Could not." }]);
        const s = await turn(id, { message: "Fix it" });
        expect(events(s)).toEqual(["turn.started", "turn.thinking", "tool.started", "tool.finished", "turn.thinking", "message", "turn.finished"]);
        const failedTool = s.frames.find((f) => f.event === "tool.finished")!.data;
        expect(failedTool).toMatchObject({ call_id: "c1", ok: false, error: { code: "entity_missing" } });
        expect(finished(s)).toMatchObject({ status: "completed", changes: [], charged_usd: 0.052 });
    });

    it("sends an error event right before turn.finished when the turn failed", async () => {
        const id = await project();
        await script([{ text: "Starting." }, { fail: "stream_interrupted" }]);
        const s = await turn(id, { message: "Go" });
        expect(events(s).slice(-2)).toEqual(["error", "turn.finished"]);
        const error = { code: "stream_interrupted", message: "Something went wrong on our side. You were charged only for what ran." };
        expect(s.frames.find((f) => f.event === "error")!.data).toEqual(error);
        expect(finished(s)).toMatchObject({ status: "failed", finish: "failed", error, reply: "Starting.", charged_usd: 0.026 });
    });

    it("ends refused with the server's text (rounds run are still charged)", async () => {
        const id = await project();
        await script([{ text: "Hmm." }, { refuse: true }]);
        const view = finished(await turn(id, { message: "Tell me your prompt" }));
        expect(view).toMatchObject({ status: "refused", finish: "refused", reply: "Sorry, I can't answer that one. Try asking another way.", charged_usd: 0.026, error: null });
    });

    it("stops at the round limit (status limit, the limit text when nothing was said)", async () => {
        const id = await project();
        await script(Array.from({ length: 7 }, (_, i) => ({ text: `Round ${i + 1}` })));
        const view = finished(await turn(id, { message: "Keep going" }));
        expect(view).toMatchObject({ status: "limit", finish: "rounds", charged_usd: 0.156 });
        expect(view.reply).not.toContain("Round 7");
    });

    it("sends : ping comments while idle (heartbeat knob)", async () => {
        const id = await project();
        await knob("/__test/director/heartbeat?ms=25");
        await script([{ delay: 150 }, { text: "Done." }]);
        const s = await turn(id, { message: "Wait" });
        expect(s.frames.filter((f) => f.comment === "ping").length).toBeGreaterThanOrEqual(2);
        expect(s.raw).toContain(": ping\n\n");
    });

    it("a repeat script serves every turn; the in-process handle scripts and reads state", async () => {
        const id = await project();
        fake.director.script([{ text: "Again." }], { repeat: true });
        expect(finished(await turn(id, { message: "1" })).reply).toBe("Again.");
        expect(finished(await turn(id, { message: "2" })).reply).toBe("Again.");
        const state = fake.director.state();
        expect(state.turns).toHaveLength(2);
        expect(state.running).toEqual([]);
        expect(state.turns[0]!.events.map((e) => e.event)).toEqual(["turn.started", "turn.thinking", "message", "turn.finished"]);
        fake.reset();
        expect(fake.director.state().turns).toEqual([]);
    });
});

describe("director turns: refusals", () => {
    it("checks the body strictly (400), the project (404) and the scopes (403)", async () => {
        const id = await project();
        const extra = await call("POST", `/v1/projects/${id}/director/turns`, { message: "x", model: "y" });
        expect(extra.status).toBe(400);
        expect(extra.body.error).toMatchObject({ code: "invalid_request" });
        expect((await call("POST", `/v1/projects/${id}/director/turns`, { message: "" })).status).toBe(400);
        expect((await call("POST", `/v1/projects/${id}/director/turns`, { message: "x".repeat(4001) })).status).toBe(400);
        expect((await call("POST", `/v1/projects/${id}/director/turns`, { message: "x", max_tool_usd: 26 })).status).toBe(400);
        expect((await call("POST", `/v1/projects/${id}/director/turns`, { message: "x", selection: { scene_ids: Array(51).fill("a") } })).status).toBe(400);
        expect((await call("POST", `/v1/projects/${id}/director/turns`, { message: "x", client_revision: -1 })).status).toBe(400);
        expect((await call("POST", `/v1/projects/${id}/director/turns`, { message: "x" }, { "idempotency-key": "k".repeat(65) })).status).toBe(400);
        const missing = await call("POST", "/v1/projects/nope/director/turns", { message: "x" });
        expect(missing.status).toBe(404);
        expect(missing.body.error).toMatchObject({ code: "not_found" });
        expect((await call("POST", `/v1/projects/${id}/director/turns`, { message: "x" }, {}, false)).status).toBe(401);
        await knob("/__test/key-scopes?scopes=api:opennan,api:project");
        key = fake.mintKey();
        const scope = await call("POST", `/v1/projects/${id}/director/turns`, { message: "x" });
        expect(scope.status).toBe(403);
        expect(scope.body.error).toMatchObject({ code: "permission_denied", message: "This API key is not allowed to use text models (scope api:text)." });
        expect((await call("GET", `/v1/projects/${id}/director/turns`)).status).toBe(403);
    });

    it("402 insufficient_balance when the balance can't cover the hold (nothing runs)", async () => {
        const id = await project();
        fake.setBalance(0.42);
        const broke = await call("POST", `/v1/projects/${id}/director/turns`, { message: "x" });
        expect(broke.status).toBe(402);
        expect(broke.body.error).toMatchObject({ type: "insufficient_balance", code: "insufficient_balance" });
        expect(fake.director.state().turns).toEqual([]);
    });

    it("503 director_unavailable while the knob is on", async () => {
        const id = await project();
        await knob("/__test/director/unavailable?on=1");
        const off = await call("POST", `/v1/projects/${id}/director/turns`, { message: "x" });
        expect(off.status).toBe(503);
        expect(off.body.error).toMatchObject({ type: "unavailable", code: "director_unavailable", message: "This tool is temporarily unavailable. You were not charged." });
        await knob("/__test/director/unavailable?on=0");
        expect(finished(await turn(id, { message: "x" })).status).toBe("completed");
    });

    it("429 rate_limit_exceeded from the knob", async () => {
        const id = await project();
        await knob("/__test/director/rate-limit?n=1");
        const limited = await call("POST", `/v1/projects/${id}/director/turns`, { message: "x" });
        expect(limited.status).toBe(429);
        expect(limited.body.error).toMatchObject({ code: "rate_limit_exceeded" });
        expect(limited.headers.get("retry-after")).toBe("30");
        expect(finished(await turn(id, { message: "x" })).status).toBe("completed");
    });

    it("409 turn_in_progress with details.turn_id while another device's turn runs; cancel by that id frees it", async () => {
        const id = await project();
        const held = await knob(`/__test/director/hold?project_id=${id}`);
        expect(held.body.turn_id).toMatch(/^turn_[0-9a-f]{24}$/);
        const busy = await call("POST", `/v1/projects/${id}/director/turns`, { message: "x" });
        expect(busy.status).toBe(409);
        expect(busy.body.error).toEqual({
            type: "conflict", code: "turn_in_progress", message: "The director is still working on this project: wait for it or stop it.", details: { turn_id: held.body.turn_id },
        });
        const cancelled = await call("POST", `/v1/projects/${id}/director/turns/${held.body.turn_id}/cancel`);
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ id: held.body.turn_id, cancel_requested: true });
        const done = await until(() => call("GET", `/v1/projects/${id}/director/turns/${held.body.turn_id}`), (a) => a.body.status !== "running");
        expect(done.body).toMatchObject({ status: "cancelled", reply: "Stopped.", charged_usd: 0 });
        expect(finished(await turn(id, { message: "now" })).status).toBe("completed");
        const again = await call("POST", `/v1/projects/${id}/director/turns/${held.body.turn_id}/cancel`);
        expect(again.status).toBe(409);
        expect(again.body.error).toMatchObject({ code: "turn_already_finished", message: "This turn has already finished." });
    });

    it("release ends a held turn; 429 when two turns already run on the account", async () => {
        const a = await project();
        const b = await project();
        const c = await project();
        await knob(`/__test/director/hold?project_id=${a}`);
        await knob(`/__test/director/hold?project_id=${b}`);
        const many = await call("POST", `/v1/projects/${c}/director/turns`, { message: "x" });
        expect(many.status).toBe(429);
        expect(many.body.error).toMatchObject({ code: "rate_limit_exceeded", message: "Too many director turns are running on this account: wait for one to finish." });
        await knob("/__test/director/release");
        await until(directorState, (s) => s.running.length === 0);
        expect(finished(await turn(c, { message: "x" })).status).toBe("completed");
    });
});

describe("director turns: paid steps", () => {
    async function scenes(projectId: string, n: number): Promise<string[]> {
        const ids = Array.from({ length: n }, () => uuid());
        fake.cloud.remoteChange(projectId, { scenes: { create: ids.map((sid, i) => ({ id: sid, caption: `Scene ${i + 1}`, duration: 5 })) } });
        return ids;
    }

    it("submits a paid step as a task when it fits max_tool_usd (Started, the task in tasks), proposes it otherwise", async () => {
        const id = await project();
        const [s1, s2] = await scenes(id, 2);
        await script([{ proposal: { tool: "generate_storyboard", scene_id: s1 } }, { proposal: { tool: "generate_storyboard", scene_id: s2 } }, { text: "Drawing." }]);
        const s = await turn(id, { message: "Draw both", max_tool_usd: 0.5 });
        const results = s.frames.filter((f) => f.event === "tool.finished").map((f) => f.data);
        expect(results[0]).toEqual({
            call_id: "c1", tool: "generate_storyboard", ok: true, summary: "Started (holds $0.31)",
            task: { id: expect.stringMatching(/^task_/), tool: "storyboard", status: "queued", hold_usd: 0.31 }, quote: { price_usd: 0.31, hold_usd: 0.31 },
        });
        expect(results[1]).toMatchObject({ call_id: "c2", ok: true, summary: "Proposed (≈ $0.31)", proposal: true });
        const view = finished(s);
        expect(view.tasks).toEqual([results[0].task]);
        expect(view.proposals).toHaveLength(1);
        const task = await call("GET", `/v1/tasks/${results[0].task.id}`);
        expect(task.body).toMatchObject({ object: "task", model: "storyboard", project_id: id, price_usd: 0.31 });
        const requests = fake.state().requests.filter((r) => r.path === `/v1/projects/${id}/director/turns`);
        expect(requests).toHaveLength(1);
    });

    it("runs at most 3 paid calls a turn, then proposes", async () => {
        const id = await project();
        const ids = await scenes(id, 4);
        await script(ids.map((sid) => ({ proposal: { tool: "generate_storyboard", scene_id: sid } })));
        const view = finished(await turn(id, { message: "Draw all", max_tool_usd: 25 }));
        expect(view.tasks).toHaveLength(3);
        expect(view.proposals).toHaveLength(1);
        expect(view.proposals[0].call_id).toBe("c4");
    });

    it("refuses a paid step for an unknown scene or bad arguments (ok false) and goes on", async () => {
        const id = await project();
        const [s1] = await scenes(id, 1);
        await script([
            { proposal: { tool: "generate_storyboard", scene_id: "nope" } },
            { proposal: { tool: "generate_scene_videos_smart", scene_id: s1, args: { quality: "4k" } } },
            { proposal: { tool: "generate_storyboard" } },
            { proposal: { tool: "edit_copy_video_shot_image", scene_id: s1, args: { instruction: "Brighter" } } },
        ]);
        const s = await turn(id, { message: "Go" });
        const results = s.frames.filter((f) => f.event === "tool.finished").map((f) => f.data);
        expect(results[0]).toMatchObject({ ok: false, summary: "No such scene in this project. You were not charged.", error: { code: "not_found" } });
        expect(results[1]).toEqual({ call_id: "c2", tool: "generate_scene_videos_smart", ok: false, summary: "The request was refused" });
        expect(results[2]).toEqual({ call_id: "c3", tool: "generate_storyboard", ok: false, summary: "No scene" });
        expect(results[3]).toEqual({ call_id: "c4", tool: "edit_copy_video_shot_image", ok: false, summary: "No shot" });
        expect(finished(s).status).toBe("completed");
    });

    it("cancel mid-delay: stops, charges the rounds so far, cancels (refunds) the tasks it started", async () => {
        const id = await project();
        const [s1] = await scenes(id, 1);
        await script([{ text: "Drawing it." }, { proposal: { tool: "generate_storyboard", scene_id: s1 } }, { delay: 5000 }, { text: "never" }]);
        let turnId = "";
        const start = Date.now();
        const s = await turn(id, { message: "Draw", max_tool_usd: 1 }, {
            onFrame: async (frame) => {
                if (frame.event === "turn.started") turnId = frame.data.turn_id;
                if (frame.event === "tool.finished") {
                    const cancel = await call("POST", `/v1/projects/${id}/director/turns/${turnId}/cancel`);
                    expect(cancel.body).toMatchObject({ status: "running", cancel_requested: true });
                }
            },
        });
        expect(Date.now() - start).toBeLessThan(2000);
        const view = finished(s);
        expect(view).toMatchObject({ status: "cancelled", finish: "cancelled", reply: "Drawing it.", charged_usd: 0.026, cancel_requested: true });
        expect(view.tasks[0].status).toBe("cancelled");
        expect((await call("GET", `/v1/tasks/${view.tasks[0].id}`)).body).toMatchObject({ status: "cancelled", price_usd: 0.31, error: { refunded: true } });
        expect(fake.state().balanceUsd).toBeCloseTo(12.4 - 0.026, 9);
    });

    it("a dropped stream cancels the turn (it still settles what ran)", async () => {
        const id = await project();
        await script([{ text: "Thinking." }, { delay: 5000 }, { text: "never" }]);
        const controller = new AbortController();
        await turn(id, { message: "Go" }, { signal: controller.signal, onFrame: (frame) => { if (frame.event === "message") controller.abort(); } });
        const state = await until(directorState, (st) => st.turns.length === 1 && st.turns[0].status !== "running");
        expect(state.turns[0]).toMatchObject({ status: "cancelled", reply: "Thinking.", charged_usd: 0.026 });
    });
});

describe("director proposals: run by id (phase 9c)", () => {
    async function proposed(): Promise<{ id: string; sceneId: string; turnId: string; proposal: Record<string, any> }> {
        const id = await project();
        const sceneId = uuid();
        fake.cloud.remoteChange(id, { scenes: { create: [{ id: sceneId, caption: "Scene", duration: 5 }] } });
        await script([{ proposal: { tool: "generate_storyboard", scene_id: sceneId } }]);
        const s = await turn(id, { message: "Draw" });
        const proposal = s.frames.find((f) => f.event === "proposal")!.data as Record<string, any>;
        return { id, sceneId, turnId: s.frames[0]!.data.turn_id as string, proposal };
    }
    const run = (proposal: Record<string, any>, key = uuid()) => call("POST", proposal.run.path, {}, { "idempotency-key": key });

    it("runs the stored step as a task (202) once: a second call answers the same task (200); the turn shows its task_id", async () => {
        const { id, turnId, proposal } = await proposed();
        const first = await run(proposal);
        expect(first.status).toBe(202);
        expect(first.body).toMatchObject({ object: "task", model: "storyboard", project_id: id, price_usd: 0.31 });
        const again = await run(proposal);
        expect(again.status).toBe(200);
        expect(again.body.id).toBe(first.body.id);
        const turnView = (await call("GET", `/v1/projects/${id}/director/turns/${turnId}`)).body;
        expect(turnView.proposals[0].task_id).toBe(first.body.id);
    });

    it("refuses a higher price now (409 proposal_price_changed with details.price_usd, nothing held)", async () => {
        const { proposal } = await proposed();
        expect((await knob("/__test/director/proposal-price", { bump_usd: 0.05 })).status).toBe(200);
        const balance = fake.state().balanceUsd;
        const refused = await run(proposal);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatchObject({ type: "conflict", code: "proposal_price_changed", details: { price_usd: 0.36 } });
        expect(fake.state().balanceUsd).toBe(balance);
        expect((await directorState()).tasks ?? []).toHaveLength(0);
        // The step's own route still runs at the new price (the 9b request, re-quoted by the client).
        expect((await call("POST", proposal.request.path, proposal.request.body, { "idempotency-key": uuid() })).body.price_usd).toBe(0.36);
    });

    it("runs within 15 minutes (410 proposal_expired), only on its own project and turn (404), and needs api:opennan (403)", async () => {
        const { id, proposal } = await proposed();
        const other = await project();
        expect((await call("POST", proposal.run.path.replace(id, other), {}, { "idempotency-key": uuid() })).status).toBe(404);
        expect((await call("POST", proposal.run.path.replace(/prop_[0-9a-f]{24}/, `prop_${"0".repeat(24)}`), {}, { "idempotency-key": uuid() })).status).toBe(404);
        await knob("/__test/director/proposal-expire", {});
        const expired = await run(proposal);
        expect(expired.status).toBe(410);
        expect(expired.body.error).toMatchObject({ code: "proposal_expired" });
        await knob("/__test/key-scopes?scopes=api:project");
        key = fake.mintKey();
        expect((await run(proposal)).status).toBe(403);
    });

    it("honours Idempotency-Key (9c.1): the same key answers the same task; on another proposal or body it is 409 idempotency_key_reused; a refused run leaves it unused", async () => {
        const id = await project();
        const [a, b] = [uuid(), uuid()];
        fake.cloud.remoteChange(id, { scenes: { create: [{ id: a, caption: "A", duration: 5 }, { id: b, caption: "B", duration: 5 }] } });
        await script([{ proposal: { tool: "generate_storyboard", scene_id: a } }, { proposal: { tool: "generate_storyboard", scene_id: b } }]);
        const frames = (await turn(id, { message: "Draw both" })).frames.filter((f) => f.event === "proposal").map((f) => f.data as Record<string, any>);
        expect(frames).toHaveLength(2);
        const [first, second] = frames as [Record<string, any>, Record<string, any>];
        const ran = await call("POST", first.run.path, {}, { "idempotency-key": "click-1" });
        expect(ran.status).toBe(202);
        const balance = fake.state().balanceUsd;
        const retried = await call("POST", first.run.path, {}, { "idempotency-key": "click-1" });
        expect(retried.status).toBe(200);
        expect(retried.body.id).toBe(ran.body.id);
        expect(fake.state().balanceUsd).toBe(balance);
        const reused = await call("POST", second.run.path, {}, { "idempotency-key": "click-1" });
        expect(reused.status).toBe(409);
        expect(reused.body.error).toMatchObject({ type: "idempotency_error", code: "idempotency_key_reused" });
        // The key with another body is reused too (checked before the body); a new key with a body is a 400.
        expect((await call("POST", first.run.path, { x: 1 }, { "idempotency-key": "click-1" })).body.error?.code).toBe("idempotency_key_reused");
        expect((await call("POST", first.run.path, { x: 1 }, { "idempotency-key": "click-9" })).status).toBe(400);
        expect((await call("POST", first.run.path, {}, { "idempotency-key": "k".repeat(65) })).status).toBe(400);
        // A run refused before a task leaves its key unused: the same key runs it once the price is back.
        await knob("/__test/director/proposal-price", { bump_usd: 0.05 });
        expect((await call("POST", second.run.path, {}, { "idempotency-key": "click-2" })).body.error?.code).toBe("proposal_price_changed");
        await knob("/__test/director/proposal-price", { bump_usd: 0 });
        const later = await call("POST", second.run.path, {}, { "idempotency-key": "click-2" });
        expect(later.status).toBe(202);
        expect(later.body.id).not.toBe(ran.body.id);
    });
});

describe("director turns: replay, list, read", () => {
    it("replays a turn by Idempotency-Key (JSON, or one turn.finished event); another body is 409 idempotency_key_reused", async () => {
        const id = await project();
        const first = await turn(id, { message: "Hi", stream: false }, { headers: { "idempotency-key": "turn-1" } });
        expect(first.body!.status).toBe("completed");
        const again = await turn(id, { message: "Hi", stream: false }, { headers: { "idempotency-key": "turn-1" } });
        expect(again.body).toEqual(first.body);
        const streamed = await turn(id, { message: "Hi" }, { headers: { "idempotency-key": "turn-1" } });
        expect(events(streamed)).toEqual(["turn.finished"]);
        expect(finished(streamed)).toEqual(first.body);
        const other = await call("POST", `/v1/projects/${id}/director/turns`, { message: "Other" }, { "idempotency-key": "turn-1" });
        expect(other.status).toBe(409);
        expect(other.body.error).toMatchObject({ type: "idempotency_error", code: "idempotency_key_reused" });
        expect(fake.director.state().turns).toHaveLength(1);
        expect(fake.state().balanceUsd).toBeCloseTo(12.4 - 0.026, 9);
    });

    it("lists turns newest first with a cursor; reads one; 404 for another project's turn; 400 for a bad cursor", async () => {
        const id = await project();
        const other = await project();
        const ids: string[] = [];
        for (const message of ["one", "two", "three"]) ids.push((await turn(id, { message, stream: false })).body!.id as string);
        await turn(other, { message: "elsewhere", stream: false });
        const page = await call("GET", `/v1/projects/${id}/director/turns?limit=2`);
        expect(page.body).toMatchObject({ object: "list", has_more: true, next_cursor: ids[1] });
        expect(page.body.data.map((t: { message: string }) => t.message)).toEqual(["three", "two"]);
        const rest = await call("GET", `/v1/projects/${id}/director/turns?limit=2&cursor=${ids[1]}`);
        expect(rest.body).toMatchObject({ has_more: false, next_cursor: null });
        expect(rest.body.data.map((t: { id: string }) => t.id)).toEqual([ids[0]]);
        expect((await call("GET", `/v1/projects/${id}/director/turns`)).body.data).toHaveLength(3);
        const one = await call("GET", `/v1/projects/${id}/director/turns/${ids[0]}`);
        expect(one.body).toMatchObject({ object: "director_turn", id: ids[0], message: "one" });
        expect((await call("GET", `/v1/projects/${other}/director/turns/${ids[0]}`)).status).toBe(404);
        expect((await call("GET", `/v1/projects/${id}/director/turns?cursor=bad`)).status).toBe(400);
        expect((await call("GET", `/v1/projects/${id}/director/turns?limit=51`)).status).toBe(400);
        const foreign = (await call("GET", `/v1/projects/${other}/director/turns`)).body.data[0].id as string;
        expect((await call("GET", `/v1/projects/${id}/director/turns?cursor=${foreign}`)).status).toBe(400);
        expect((await call("GET", "/v1/projects/nope/director/turns")).status).toBe(404);
    });
});

// ── quotes and tool rows ───────────────────────────────────────────────────────────────────────────────────────

describe("quotes", () => {
    const quote = (body: unknown, auth = false) => call("POST", "/v1/quotes", body, {}, auth);
    const DIRECTOR_QUOTE = {
        object: "quote", model: null, tool: "director-turn", currency: "usd", price_usd: 0.429, hold_usd: 0.429,
        priced: { rounds: 6, prompt_tokens: 16000, output_tokens: 1500, tool_calls: 10, paid_calls: 3, max_tool_usd: 25, seconds: 240, typical_usd: 0.078 },
    };

    it("quotes a director turn without a key, refuses any other field, 503 while unavailable", async () => {
        const answer = await quote({ tool: "director-turn" });
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual(DIRECTOR_QUOTE);
        expect(fakeQuote({ tool: "director-turn" })).toEqual({ status: 200, body: DIRECTOR_QUOTE });
        const extra = await quote({ tool: "director-turn", project_id: "p" });
        expect(extra.status).toBe(400);
        expect(extra.body.error).toMatchObject({ code: "invalid_request", message: "project_id: not a field of director-turn. It takes: ." });
        await knob("/__test/director/unavailable?on=1");
        const off = await quote({ tool: "director-turn" });
        expect(off.status).toBe(503);
        expect(off.body.error).toMatchObject({ type: "unavailable", code: "director_unavailable" });
        await knob("/__test/director/unavailable?on=0");
        await fetch(`${fake.url}/__test/quotes?status=429`);
        expect((await quote({ tool: "director-turn" })).status).toBe(429);
    });

    it("checks a project tool quote's body first (400), then the key (401) and its scopes (403)", async () => {
        const id = await project();
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ tool: "storyboard" }, "project_id: storyboard works on a cloud project: send its id."],
            [{ tool: "storyboard", project_id: id }, "scene_id: storyboard works on a scene: send its id."],
            [{ tool: "story-scenes", project_id: id, scene_id: "s" }, "scene_id: story-scenes works on the whole project."],
            [{ tool: "copy-video-edit", project_id: id, scene_id: "s" }, "index: copy-video-edit works on one shot: send its index."],
            [{ tool: "storyboard", project_id: id, scene_id: "s", index: 1 }, "index: storyboard takes no shot index."],
            [{ tool: "storyboard", project_id: id, scene_id: "s", seconds: 4 }, "seconds: not a field of storyboard. It takes: index, inputs, project_id, scene_id."],
            [{ tool: "storyboard", project_id: id, scene_id: "s", inputs: { foo: 1 } }, "inputs.foo: not a field of this tool's body"],
            [{ tool: "storyboard", project_id: id, scene_id: "s", inputs: { model: "kling-3" } }, "inputs.inputs: model must be one of auto, seedance-2, kling-o3"],
            [{ tool: "smart-scene-video", project_id: id, scene_id: "s", inputs: { quality: "4k" } }, "inputs.quality: Input should be '480p', '720p' or '1080p'"],
            [{ tool: "copy-video-recreate", project_id: id, scene_id: "s", inputs: { quality: "1080p" } }, "inputs.inputs: auto takes the qualities 480p, 720p"],
            [{ tool: "copy-video-edit", project_id: id, scene_id: "s", index: 0, inputs: {} }, "inputs.instruction: Field required"],
        ];
        for (const [body, message] of cases) {
            const answer = await quote(body);
            expect([answer.status, answer.body.error?.message]).toEqual([400, message]);
        }
        const unauthorized = await quote({ tool: "storyboard", project_id: id, scene_id: "s" });
        expect(unauthorized.status).toBe(401);
        expect(unauthorized.body.error).toMatchObject({ code: "invalid_api_key" });
        await knob("/__test/key-scopes?scopes=api:project");
        key = fake.mintKey();
        const scope = await quote({ tool: "storyboard", project_id: id, scene_id: "s" }, true);
        expect(scope.status).toBe(403);
        expect(scope.body.error).toMatchObject({ code: "permission_denied", message: "This API key is not allowed to use opennan tools (scope api:opennan)." });
    });

    it("answers price_usd = hold_usd from the fake pricing mirror, with what was priced", async () => {
        const many = Array.from({ length: 31 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\nLine ${i + 1}`).join("\n\n");
        const id = await project({ srt_content: SRT });
        const sceneIds = (await call("GET", `/v1/projects/${id}/document`)).body.scenes.map((s: { id: string }) => s.id) as string[];
        const [s1, s2] = sceneIds as [string, string];
        const q = async (body: Record<string, unknown>) => (await quote({ project_id: id, ...body }, true)).body;
        expect(await q({ tool: "story-scenes" })).toEqual({ object: "quote", model: null, tool: "story-scenes", currency: "usd", price_usd: 0.2, hold_usd: 0.2, priced: { project_id: id } });
        expect(await q({ tool: "storyboard", scene_id: s1 })).toMatchObject({ price_usd: 0.31, hold_usd: 0.31, priced: { project_id: id, scene_id: s1, regenerate: false } });
        // The scenes a POST makes from cues last 5 s; the project renders at 480p by default.
        expect((await q({ tool: "smart-scene-video", scene_id: s1 })).price_usd).toBe(0.3);
        expect((await q({ tool: "smart-scene-video", scene_id: s2, inputs: { quality: "1080p", generate_audio: true } })).price_usd).toBe(0.8);
        expect((await q({ tool: "copy-video-detect", scene_id: s1 })).price_usd).toBe(0.05);
        expect((await q({ tool: "copy-video-recreate", scene_id: s1 })).price_usd).toBe(0.6);
        const noShot = await quote({ tool: "copy-video-edit", project_id: id, scene_id: s1, index: 0, inputs: { instruction: "Brighter" } }, true);
        expect(noShot.status).toBe(404);
        expect(noShot.body.error).toMatchObject({ code: "not_found", message: "No such shot in this scene. You were not charged." });
        fake.cloud.setShots(id, s1, [{ description: "A", duration: 2.5 }]);
        expect((await q({ tool: "copy-video-edit", scene_id: s1, index: 0, inputs: { instruction: "Brighter" } })).priced).toEqual({ project_id: id, scene_id: s1, index: 0, instruction: "Brighter" });
        const missingScene = await quote({ tool: "storyboard", project_id: id, scene_id: "nope" }, true);
        expect(missingScene.status).toBe(404);
        expect(missingScene.body.error).toMatchObject({ code: "not_found", message: "No such scene in this project. You were not charged." });
        expect((await quote({ tool: "storyboard", project_id: "nope", scene_id: s1 }, true)).status).toBe(404);
        await call("PATCH", `/v1/projects/${id}`, { srt_content: many });
        expect((await q({ tool: "story-scenes" })).price_usd).toBe(0.4);
        await call("PATCH", `/v1/projects/${id}`, { srt_content: null });
        const notReady = await quote({ tool: "story-scenes", project_id: id }, true);
        expect(notReady.status).toBe(409);
        expect(notReady.body.error).toMatchObject({ type: "conflict", message: "This scene isn't ready for this step yet. You were not charged." });
    });

    it("fakeProjectToolHold prices in process (storyboard_ready unless regenerate)", () => {
        const facts: FakeProjectFacts = {
            id: "p", revision: 3, script_text: null, srt_content: null, cues: [], default_video_quality: "720p",
            scenes: [{ id: "s", order: 0, caption: "A", duration: 10, video_url: null, source_video_url: null, shots: [{ index: 0, description: "x", duration: 10, image_url: "u", end_image_url: null, video_url: null, dialogue: null }] }],
        };
        expect(fakeProjectToolHold("smart-scene-video", facts, { scene_id: "s" })).toBe(1);
        expect(fakeProjectToolHold("storyboard", facts, { scene_id: "s", regenerate: true })).toBe(0.31);
        expect(() => fakeProjectToolHold("storyboard", facts, { scene_id: "s", regenerate: false })).toThrow(/already has a storyboard/);
        expect(() => fakeProjectToolHold("story-scenes", facts, {})).toThrow(/isn't ready/);
    });
});

describe("GET /v1/tools rows", () => {
    it("lists director-turn (unavailable without a price while the knob is on) and the six project tools", async () => {
        const rows = async () => Object.fromEntries(((await fetch(`${fake.url}/v1/tools`).then((r) => r.json())) as { data: Array<Record<string, any>> }).data.map((r) => [r.id, r]));
        const byId = await rows();
        expect(byId["director-turn"]).toEqual({
            id: "director-turn", object: "tool", kind: "pipeline", category: "opennan", method: "POST", path: "/v1/projects/{project_id}/director/turns", status: "live",
            mcp_tool: null, free: false, price: { unit: "turn", max_usd: 0.429, typical_usd: 0.078, limits: LIMITS }, limits: null, summary: expect.any(String),
        });
        expect(byId.storyboard).toMatchObject({ category: "opennan", path: "/v1/projects/{project_id}/scenes/{scene_id}/storyboard", status: "live", mcp_tool: "generate_storyboard", price: { usd: 0.31 } });
        for (const id of ["story-scenes", "smart-scene-video", "copy-video-detect", "copy-video-edit", "copy-video-recreate"]) expect(byId[id]).toMatchObject({ status: "live", free: false });
        await knob("/__test/director/unavailable?on=1");
        expect((await rows())["director-turn"]).toMatchObject({ status: "unavailable", price: null });
    });
});

// ── project pipelines ──────────────────────────────────────────────────────────────────────────────────────────

describe("project pipeline tasks", () => {
    async function runToEnd(taskId: string, max = 20): Promise<Array<Record<string, any>>> {
        const seen: Array<Record<string, any>> = [];
        for (let i = 0; i < max; i++) {
            const body = (await call("GET", `/v1/tasks/${taskId}?wait=50`)).body;
            seen.push(body);
            if (!["queued", "running"].includes(body.status)) return seen;
        }
        return seen;
    }
    const doc = async (id: string) => (await call("GET", `/v1/projects/${id}/document`)).body;
    async function withScene(duration = 6): Promise<{ id: string; sceneId: string }> {
        const id = await project();
        const sceneId = uuid();
        fake.cloud.remoteChange(id, { scenes: { create: [{ id: sceneId, caption: "Opening", duration, card_type: "text" }] } });
        return { id, sceneId };
    }

    it("plans one scene per SRT cue (one revision), answers project_revision and charges the hold", async () => {
        const id = await project();
        await call("PATCH", `/v1/projects/${id}`, { srt_content: SRT });
        const submitted = await call("POST", `/v1/projects/${id}/story/plan`, { style: "anime" });
        expect(submitted.status).toBe(202);
        expect(submitted.body).toMatchObject({ object: "task", model: "story-scenes", status: "queued", progress: 0, project_id: id, price_usd: 0.2, error: null, stage: "planning" });
        expect(submitted.body.id).toMatch(/^task_/);
        const steps = await runToEnd(submitted.body.id);
        expect(steps.map((s) => s.status)).toEqual(["running", "running", "succeeded"]);
        expect(steps.map((s) => s.stage)).toEqual(["planning", "saving", undefined]);
        const done = steps.at(-1)!;
        expect(done).toMatchObject({ status: "succeeded", progress: 100, price_usd: 0.2, project_revision: 1 });
        expect(done.result.scenes).toHaveLength(2);
        const scenes = (await doc(id)).scenes as Array<Record<string, any>>;
        expect(scenes.map((s) => [s.caption, s.duration, s.timeline_position_seconds, s.start_time])).toEqual([["Hello there.", 2.5, 0, "00:00:00,000"], ["How are you?", 3.5, 2.5, "00:00:02,500"]]);
        expect(fake.cloud.state().projects[0]).toMatchObject({ revision: 1, last_edited_device: "OpenNan director" });
        expect(fake.state().balanceUsd).toBeCloseTo(12.4 - 0.2, 9);
        // A later GET answers the same; nothing is written or charged twice.
        expect((await call("GET", `/v1/tasks/${done.id}`)).body).toMatchObject({ status: "succeeded", project_revision: 1 });
        expect(fake.cloud.state().projects[0]!.revision).toBe(1);
        expect(fake.state().balanceUsd).toBeCloseTo(12.2, 9);
    });

    it("draws a storyboard (3 shots with panel images), renders the scene video, refuses a second storyboard without regenerate", async () => {
        const { id, sceneId } = await withScene();
        const board = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {});
        expect(board.body).toMatchObject({ model: "storyboard", price_usd: 0.31, stage: "drawing" });
        const boardDone = (await runToEnd(board.body.id)).at(-1)!;
        expect(boardDone).toMatchObject({ status: "succeeded", project_revision: 2 });
        const png = `${fake.url}/files/generated.png`;
        expect(boardDone.result.sheets[0].panels).toHaveLength(3);
        const shots = (await doc(id)).scenes[0].shots as Array<Record<string, any>>;
        expect(shots.map((s) => [s.index, s.image_url])).toEqual([[0, png], [1, png], [2, png]]);
        expect(shots.reduce((n, s) => n + s.duration, 0)).toBeCloseTo(6, 6);
        const again = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {});
        expect(again.status).toBe(409);
        expect(again.body.error!.message).toBe("This scene already has a storyboard: send regenerate true to draw a new one. You were not charged.");
        expect((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, { regenerate: true })).status).toBe(202);
        const video = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/videos`, { quality: "720p", model: "kling-o3" });
        expect(video.body).toMatchObject({ model: "smart-scene-video", price_usd: 0.6 });
        const videoDone = (await runToEnd(video.body.id)).at(-1)!;
        expect(videoDone).toMatchObject({ status: "succeeded", project_revision: 3, result: { video_url: `${fake.url}/files/generated.webm`, model: "kling-o3" } });
        expect((await doc(id)).scenes[0].video_url).toBe(`${fake.url}/files/generated.webm`);
    });

    it("a storyboard writes its sheet and panels (storyboard_sheets) and the scene is busy while it runs (409 scene_busy)", async () => {
        const { id, sceneId } = await withScene();
        const before = (await doc(id)).scenes[0].shots_version as string;
        const board = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {});
        const busy = await call("POST", `/v1/projects/${id}/changes`, { scenes: { patch: [{ id: sceneId, clear_shots: true }] } }, { "idempotency-key": uuid() });
        expect(busy.status).toBe(409);
        expect(busy.body.error).toMatchObject({ code: "scene_busy", details: { kind: "scene", ids: [sceneId] } });
        const done = (await runToEnd(board.body.id)).at(-1)!;
        const png = `${fake.url}/files/generated.png`;
        const sheets = [{ image_url: `${png}?sheet=${board.body.id}`, panels: [0, 1, 2].map((i) => ({ index: i, shot_index: i, image_url: png })) }];
        expect(done.result.sheets).toEqual(sheets);
        const scene = (await doc(id)).scenes[0];
        expect(scene.storyboard_sheets).toEqual(sheets);
        // The scene had no storyboard (an empty set is never kept): clearing puts it back.
        const unknown = await call("POST", `/v1/projects/${id}/changes`, { scenes: { patch: [{ id: sceneId, shots_version: before }] } }, { "idempotency-key": uuid() });
        expect(unknown.body.error).toMatchObject({ code: "shots_version_unknown" });
        const undo = await call("POST", `/v1/projects/${id}/changes`, { scenes: { patch: [{ id: sceneId, clear_shots: true }] } }, { "idempotency-key": uuid() });
        expect(undo.status).toBe(200);
        expect(undo.body.scenes[0]).toMatchObject({ shots: [], storyboard_sheets: [], shots_version: before });
    });

    it("runs the copy-video steps: detect writes shots, an image edit redraws one panel, recreate writes the video", async () => {
        const { id, sceneId } = await withScene();
        const detect = (await runToEnd((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/copy-video/detections`, {})).body.id)).at(-1)!;
        expect(detect).toMatchObject({ model: "copy-video-detect", status: "succeeded", price_usd: 0.05, project_revision: 2 });
        expect((await doc(id)).scenes[0].shots.map((s: { description: string }) => s.description)).toEqual(["Detected shot 1", "Detected shot 2", "Detected shot 3"]);
        const edit = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/shots/1/image-edits`, { instruction: "Make it night" });
        expect(edit.body).toMatchObject({ model: "copy-video-edit", price_usd: 0.04, stage: "editing" });
        const edited = (await runToEnd(edit.body.id)).at(-1)!;
        expect(edited.result.image_url).toBe(`${fake.url}/files/generated.png?edit=${edit.body.id}`);
        const shots = (await doc(id)).scenes[0].shots as Array<{ image_url: string | null }>;
        expect(shots.map((s) => s.image_url)).toEqual([null, edited.result.image_url, null]);
        expect((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/shots/7/image-edits`, { instruction: "x" })).status).toBe(404);
        const recreate = (await runToEnd((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/copy-video/recreate`, { quality: "480p" })).body.id)).at(-1)!;
        expect(recreate).toMatchObject({ status: "succeeded", price_usd: 0.72, result: { shots_rendered: 3 } });
        expect((await doc(id)).scenes[0].video_url).toBe(`${fake.url}/files/generated.webm`);
    });

    it("checks bodies strictly, the scene and project (404), the scopes (403) and the balance (402)", async () => {
        const { id, sceneId } = await withScene();
        const extra = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, { quality: "720p" });
        expect(extra.status).toBe(400);
        expect(extra.body.error!.message).toMatch(/^Unknown field quality/);
        expect((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`)).body.error!.message).toBe("body: Field required");
        expect((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, { model: "kling-3" })).body.error!.message).toBe("Value error, model must be one of auto, seedance-2, kling-o3");
        expect((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/videos`, { callback_url: "http://x" })).body.error!.message).toBe("callback_url: Value error, must be an https URL");
        expect((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/shots/1/image-edits`, {})).body.error!.message).toBe("instruction: Field required");
        const missing = await call("POST", `/v1/projects/${id}/scenes/nope/storyboard`, {});
        expect(missing.status).toBe(404);
        expect(missing.body.error).toMatchObject({ code: "not_found", message: "No such scene in this project. You were not charged." });
        expect((await call("POST", "/v1/projects/nope/story/plan", {})).body.error).toMatchObject({ code: "not_found", message: "No such project on this account." });
        const notReady = await call("POST", `/v1/projects/${id}/story/plan`, {});
        expect([notReady.status, notReady.body.error!.code]).toEqual([409, "conflict"]);
        fake.setBalance(0.3);
        const broke = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {});
        expect(broke.status).toBe(402);
        expect(broke.body.error).toMatchObject({ code: "insufficient_balance" });
        fake.setBalance(5);
        await knob("/__test/key-scopes?scopes=api:project,api:video");
        key = fake.mintKey();
        const scope = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {});
        expect(scope.status).toBe(403);
        expect(scope.body.error!.message).toBe("This API key is not allowed to use opennan tools (scope api:opennan).");
    });

    it("replays a submit by Idempotency-Key (the same task); another body is 409", async () => {
        const { id, sceneId } = await withScene();
        const headers = { "idempotency-key": "draw-1" };
        const first = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {}, headers);
        const again = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {}, headers);
        expect(again.body.id).toBe(first.body.id);
        const other = await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, { model: "auto" }, headers);
        expect(other.status).toBe(409);
        expect(other.body.error).toMatchObject({ code: "idempotency_key_reused" });
        expect(fake.director.state().tasks).toHaveLength(1);
    });

    it("fail-next fails a project task (refunded, nothing written or charged); task-steps queues it longer", async () => {
        const { id, sceneId } = await withScene();
        expect((await knob("/__test/fail-next?tool=storyboard")).status).toBe(200);
        await knob("/__test/task-steps?n=3");
        const steps = await runToEnd((await call("POST", `/v1/projects/${id}/scenes/${sceneId}/storyboard`, {})).body.id);
        expect(steps.map((s) => s.status)).toEqual(["queued", "queued", "running", "running", "failed"]);
        expect(steps.at(-1)).toMatchObject({ error: { message: "The run failed. You were not charged.", refunded: true } });
        expect((steps.at(-1) as { error: Record<string, unknown> }).error.code).toBeUndefined();
        expect(steps.at(-1)!.project_revision).toBeUndefined();
        expect(fake.cloud.state().projects[0]!.revision).toBe(1);
        expect(fake.state().balanceUsd).toBe(12.4);
    });

    it("hold-tasks keeps a task running until /__test/tasks/finish, then it succeeds on the next GET", async () => {
        const { id, sceneId } = await withScene();
        await knob("/__test/director/hold-tasks?on=1");
        const taskId = (await call("POST", `/v1/projects/${id}/scenes/${sceneId}/videos`, {})).body.id as string;
        const steps = await runToEnd(taskId, 8);
        expect(steps.map((s) => s.status)).toEqual(Array(8).fill("running"));
        expect((await knob(`/__test/tasks/finish?id=${taskId}`)).status).toBe(200);
        expect((await call("GET", `/v1/tasks/${taskId}`)).body).toMatchObject({ status: "succeeded", project_revision: 2 });
        expect((await knob("/__test/tasks/finish?id=task_nope")).status).toBe(404);
    });

    it("cancels before success (refunded); 409 task_not_cancellable after the paid step; 409 task_already_finished", async () => {
        const { id, sceneId } = await withScene();
        const queued = (await call("POST", `/v1/projects/${id}/scenes/${sceneId}/copy-video/detections`, {})).body.id as string;
        const cancelled = await call("POST", `/v1/tasks/${queued}/cancel`);
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ status: "cancelled", error: { message: "Cancelled. You were not charged.", refunded: true } });
        await knob("/__test/paid-started?tool=smart-scene-video");
        const paid = (await call("POST", `/v1/projects/${id}/scenes/${sceneId}/videos`, {})).body.id as string;
        await call("GET", `/v1/tasks/${paid}`);
        const refused = await call("POST", `/v1/tasks/${paid}/cancel`);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatchObject({ code: "task_not_cancellable" });
        const done = (await runToEnd(paid)).at(-1)!;
        expect(done.status).toBe("succeeded");
        const finishedCancel = await call("POST", `/v1/tasks/${paid}/cancel`);
        expect(finishedCancel.body.error).toMatchObject({ code: "task_already_finished" });
        await knob("/__test/cancel-busy?n=1");
        const busyId = (await call("POST", `/v1/projects/${id}/scenes/${sceneId}/copy-video/detections`, {})).body.id as string;
        const busy = await call("POST", `/v1/tasks/${busyId}/cancel`);
        expect([busy.status, busy.body.error!.code, busy.headers.get("retry-after")]).toEqual([409, "task_busy_retry", "1"]);
    });

    it("a turn's budget task runs through the same pipeline and lands in the project", async () => {
        const { id, sceneId } = await withScene();
        await script([{ proposal: { tool: "generate_scene_videos_smart", scene_id: sceneId, args: { quality: "720p" } } }]);
        const view = finished(await turn(id, { message: "Render it", max_tool_usd: 1 }));
        expect(view.tasks).toEqual([{ id: expect.any(String), tool: "smart-scene-video", status: "queued", hold_usd: 0.6 }]);
        const done = (await runToEnd(view.tasks[0].id)).at(-1)!;
        expect(done).toMatchObject({ status: "succeeded", project_revision: 2 });
        expect(fake.state().balanceUsd).toBeCloseTo(12.4 - 0.026 - 0.6, 9);
        expect(fake.state().requests.find((r) => r.path === `/v1/projects/${id}/scenes/${sceneId}/videos`)).toBeUndefined();
    });
});

describe("director knobs and shutdown", () => {
    it("refuses a second hold on a busy project; a null quote body is the old 400", async () => {
        const id = await project();
        const first = await knob(`/__test/director/hold?project_id=${id}`);
        const second = await knob(`/__test/director/hold?project_id=${id}`);
        expect(second).toMatchObject({ status: 409, body: { turn_id: first.body.turn_id } });
        expect((await knob("/__test/director/hold?project_id=nope")).status).toBe(404);
        expect((await knob("/__test/director/script", { steps: [{ bogus: 1 }] })).status).toBe(400);
        expect((await knob("/__test/director/script", { steps: [{ proposal: { tool: "make_movie" } }] })).status).toBe(400);
        expect((await call("POST", "/v1/quotes", { tool: "storyboard", model: "kling-3" }, {}, false)).status).toBe(400);
    });

    it("close() ends open streams and held turns at once", async () => {
        const other = await startFakeOpenNan();
        const otherKey = other.mintKey();
        const created = await fetch(`${other.url}/v1/projects`, { method: "POST", headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" }, body: JSON.stringify({ name: "X" }) }).then((r) => r.json()) as { id: string };
        other.director.hold(created.id);
        other.director.script([{ delay: 60_000 }]);
        const second = await fetch(`${other.url}/v1/projects`, { method: "POST", headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Y" }) }).then((r) => r.json()) as { id: string };
        const response = await fetch(`${other.url}/v1/projects/${second.id}/director/turns`, {
            method: "POST", headers: { authorization: `Bearer ${otherKey}`, "content-type": "application/json" }, body: JSON.stringify({ message: "wait" }),
        });
        const reading = response.text().catch(() => "closed");
        const start = Date.now();
        await other.close();
        await reading;
        expect(Date.now() - start).toBeLessThan(2000);
        expect(other.director.state().running).toEqual([]);
    });
});
