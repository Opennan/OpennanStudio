// Cloud IPC: sender check and schemas before anything runs; refusals and server errors come back as CloudApiError
// JSON (rebuilt in the renderer); the file store round-trips; no answer ever carries the key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CloudApiError } from "@opennan/cloud-backend";
import { OpenNanSession, createOpenNanApi, memoryCredentialStore } from "@opennan/provider-opennan";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { EVENTS, IPC } from "../../shared/ipc";
import type { IpcEventLike, IpcMainLike } from "../ipc/handle";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore, type MediaStore } from "../store/media-store";
import { createCloudHost } from "./cloud-host";
import { registerCloudIpc } from "./cloud-ipc";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());

/** The fake's director knobs (FakeOpenNan.director, phase 9b), typed here so this file does not need a fresh provider-opennan build. */
interface FakeDirectorKnobs {
    script(steps: Array<Record<string, unknown>>, options?: { repeat?: boolean }): void;
    rateLimit(count: number): void;
    state(): { turns: Array<{ status: string }>; running: string[] };
}
const director = () => (fake as unknown as { director: FakeDirectorKnobs }).director;
beforeEach(() => fake.reset());

const PROJECT = "11111111-2222-4333-8444-555555555555";

describe("cloud IPC", () => {
    let dir: string;
    let db: DesktopDatabase;
    let media: MediaStore;
    let answers: unknown[];
    let invoke: (channel: string, payload?: unknown, frame?: unknown, sender?: unknown) => Promise<unknown>;
    let registered: Map<string, unknown>;
    let handlers: Map<string, (event: IpcEventLike, payload: unknown) => unknown>;
    let top: { url: string; top?: unknown };
    let key: string;
    let cleanup: () => void;

    beforeEach(async () => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-cloud-ipc-")));
        db = openDatabase(":memory:");
        media = createMediaStore({ db, root: path.join(dir, "media") });
        key = fake.mintKey();
        const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore({ apiKey: key, keyId: "key_1" }), deviceName: "Mac", client: "desktop" });
        await session.restore();
        const host = createCloudHost({ apiBase: fake.url, session, mediaStore: media, root: path.join(dir, "cloud") });
        handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        registered = handlers;
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
        cleanup = registerCloudIpc(ipc, { host, exportsDir: path.join(dir, "exports") });
        top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        answers = [];
        invoke = async (channel, payload = {}, frame = top) => {
            const answer = await handlers.get(channel)!({ senderFrame: frame as never }, payload);
            answers.push(answer);
            return answer;
        };
    });
    afterEach(() => {
        cleanup();
        for (const answer of answers) expect(JSON.stringify(answer ?? null)).not.toMatch(/sk-/);
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("registers every cloud channel", () => {
        const channels = [
            IPC.cloudRequest, IPC.cloudDescribe, IPC.cloudUpload, IPC.cloudCache, IPC.cloudDuplicate, IPC.cloudStoreGet, IPC.cloudStorePut, IPC.cloudStoreDelete, IPC.cloudStoreKeys,
            IPC.cloudCachePin, IPC.cloudCacheUsage, IPC.cloudCacheSetLimit, IPC.cloudCacheClear, IPC.cloudStreamStart, IPC.cloudStreamAbort, IPC.cloudUploadExport,
        ];
        expect(new Set(channels).size).toBe(16);
        expect(EVENTS.cloudStreamChunk).toMatch(/^opennan:cloud:/);
        expect(EVENTS.cloudStreamEnd).toMatch(/^opennan:cloud:/);
        for (const channel of channels) expect(channel).toMatch(/^opennan:cloud:/);
        for (const channel of channels) expect(registered.has(channel)).toBe(true);
    });

    it("answers API calls as {ok, value} and refusals as CloudApiError JSON", async () => {
        const created = await invoke(IPC.cloudRequest, { method: "POST", path: "/v1/projects", body: { name: "Trip" } }) as { ok: true; value: { status: number; body: { id: string } } };
        expect(created).toMatchObject({ ok: true, value: { status: 201, body: { id: expect.any(String) } } });
        const missing = await invoke(IPC.cloudRequest, { method: "GET", path: "/v1/projects/nope" }) as { ok: false; error: ReturnType<CloudApiError["toJSON"]> };
        expect(missing.ok).toBe(false);
        const rebuilt = CloudApiError.fromJSON(missing.error);
        expect(rebuilt).toBeInstanceOf(CloudApiError);
        expect(rebuilt).toMatchObject({ status: 404, fromServer: true });
    });

    it("uploads an export main wrote (phase 9c: Export and share) with the project's id; any other file is refused before any request", async () => {
        const created = await invoke(IPC.cloudRequest, { method: "POST", path: "/v1/projects", body: { name: "Trip" } }) as { ok: true; value: { body: { id: string } } };
        const serverId = created.value.body.id;
        const file = path.join(dir, "exports", "Trip-2026.mp4");
        fs.writeFileSync(file, randomBytes(3000));
        const uploaded = await invoke(IPC.cloudUploadExport, { path: file, serverProjectId: serverId }) as { ok: true; value: { mediaUrl: string; assetId: string } };
        expect(uploaded).toMatchObject({ ok: true, value: { contentType: "video/mp4", sizeBytes: 3000, mediaUrl: expect.stringContaining("/files/") } });
        expect(fake.cloud.state().assets.find((a) => a.id === uploaded.value.assetId)!.project_ids).toEqual([serverId]);
        const before = fake.state().requests.length;
        const outside = path.join(dir, "secret.mp4");
        fs.writeFileSync(outside, randomBytes(10));
        expect(await invoke(IPC.cloudUploadExport, { path: outside, serverProjectId: serverId })).toMatchObject({ ok: false, error: { code: "not_an_export" } });
        expect(await invoke(IPC.cloudUploadExport, { path: path.join(dir, "exports", "..", "secret.mp4"), serverProjectId: serverId })).toMatchObject({ ok: false, error: { code: "not_an_export" } });
        const mov = path.join(dir, "exports", "Trip.mov");
        fs.writeFileSync(mov, randomBytes(10));
        expect(await invoke(IPC.cloudUploadExport, { path: mov, serverProjectId: serverId })).toMatchObject({ ok: false, error: { code: "unsupported_type" } });
        const text = path.join(dir, "exports", "notes.txt");
        fs.writeFileSync(text, "hello");
        expect(await invoke(IPC.cloudUploadExport, { path: text, serverProjectId: serverId })).toMatchObject({ ok: false, error: { code: "unsupported_type" } });
        await expect(invoke(IPC.cloudUploadExport, { path: file, serverProjectId: "../x" })).rejects.toThrow();
        expect(fake.state().requests.slice(before)).toEqual([]);
    });

    it("uploads, caches and duplicates media-store files", async () => {
        const stored = await media.importBytes({ projectId: PROJECT, name: "clip.webm", mimeType: "video/webm", kind: "video", bytes: new Uint8Array(randomBytes(2000)) });
        expect(await invoke(IPC.cloudDescribe, { mediaId: stored.id })).toEqual({ filename: "clip.webm", contentType: "video/webm", sizeBytes: 2000 });
        const uploaded = await invoke(IPC.cloudUpload, { mediaId: stored.id, serverProjectId: null }) as { ok: true; value: { mediaUrl: string } };
        expect(uploaded).toMatchObject({ ok: true, value: { deduplicated: false, mediaUrl: expect.stringContaining("/files/") } });
        const cached = await invoke(IPC.cloudCache, { url: uploaded.value.mediaUrl, sizeBytes: 2000 }) as { ok: true; value: { url: string } };
        expect(cached).toMatchObject({ ok: true, value: { url: expect.stringMatching(/^opennan-local:\/\/media\//) } });
        const copy = await invoke(IPC.cloudDuplicate, { mediaId: stored.id, projectId: PROJECT }) as { ok: true; value: { url: string } };
        expect(copy).toMatchObject({ ok: true, value: { url: expect.stringMatching(/^opennan-local:\/\/media\//), name: "clip.webm" } });
        const refused = await invoke(IPC.cloudCache, { url: "https://evil.example/a.mp4", sizeBytes: null });
        expect(refused).toMatchObject({ ok: false, error: { code: "download_refused", status: 400 } });
        const unsupported = await invoke(IPC.cloudUpload, { mediaId: PROJECT, serverProjectId: "p1" });
        expect(unsupported).toMatchObject({ ok: false, error: { code: "missing_file" } });
    });

    it("pins cached files, reports usage, takes a limit and clears the cache", async () => {
        const GB = 1024 ** 3;
        const stored = await media.importBytes({ projectId: PROJECT, name: "clip.webm", mimeType: "video/webm", kind: "video", bytes: new Uint8Array(randomBytes(2000)) });
        const uploaded = await invoke(IPC.cloudUpload, { mediaId: stored.id, serverProjectId: null }) as { ok: true; value: { mediaUrl: string } };
        const cached = await invoke(IPC.cloudCache, { url: uploaded.value.mediaUrl, sizeBytes: 2000 }) as { ok: true; value: { url: string } };
        const id = cached.value.url.slice("opennan-local://media/".length);
        await vi.waitFor(() => expect(media.pathOf(id)).not.toBeNull());
        await vi.waitFor(async () => expect(await invoke(IPC.cloudCacheUsage, {})).toMatchObject({ ok: true, value: { usedBytes: 2000, entries: 1 } }));
        expect(await invoke(IPC.cloudCachePin, { ids: [id] })).toBeUndefined();
        expect(await invoke(IPC.cloudCacheUsage, {})).toEqual({
            ok: true, value: { usedBytes: 2000, entries: 1, limitBytes: 10 * GB, defaultLimitBytes: 10 * GB, maxLimitBytes: 1024 * GB, pinnedBytes: 2000, custom: false },
        });
        expect(await invoke(IPC.cloudCacheSetLimit, { bytes: 5 * GB })).toMatchObject({ ok: true, value: { limitBytes: 5 * GB, custom: true } });
        expect(await invoke(IPC.cloudCacheClear, {})).toEqual({ ok: true, value: { freedBytes: 0, keptBytes: 2000 } });
        expect(media.pathOf(id)).not.toBeNull();
        await invoke(IPC.cloudCachePin, { ids: [] });
        expect(await invoke(IPC.cloudCacheClear, {})).toEqual({ ok: true, value: { freedBytes: 2000, keptBytes: 0 } });
        expect(media.pathOf(id)).toBeNull();
        expect(media.pathOf(stored.id)).not.toBeNull();
    });

    it("round-trips the file store per account", async () => {
        await invoke(IPC.cloudStorePut, { account: "ada@example.com", namespace: "sync", key: "cloud-p1", value: { revision: 2 } });
        expect(await invoke(IPC.cloudStoreGet, { account: "ada@example.com", namespace: "sync", key: "cloud-p1" })).toEqual({ revision: 2 });
        expect(await invoke(IPC.cloudStoreKeys, { account: "ada@example.com", namespace: "sync" })).toEqual(["cloud-p1"]);
        expect(await invoke(IPC.cloudStoreGet, { account: "bob@example.com", namespace: "sync", key: "cloud-p1" })).toBeNull();
        await invoke(IPC.cloudStoreDelete, { account: "ada@example.com", namespace: "sync", key: "cloud-p1" });
        expect(await invoke(IPC.cloudStoreKeys, { account: "ada@example.com", namespace: "sync" })).toEqual([]);
    });

    it("refuses foreign senders and bad payloads before anything runs", async () => {
        const before = fake.state().requests.length;
        const foreign = { url: "https://evil.example/" };
        await expect(invoke(IPC.cloudRequest, { method: "GET", path: "/v1/projects" }, foreign)).rejects.toThrow("Untrusted");
        await expect(invoke(IPC.cloudStoreGet, { account: "a", namespace: "sync", key: "k" }, foreign)).rejects.toThrow("Untrusted");
        for (const [channel, payload] of [[IPC.cloudCachePin, { ids: [] }], [IPC.cloudCacheUsage, {}], [IPC.cloudCacheSetLimit, { bytes: null }], [IPC.cloudCacheClear, {}]] as const) {
            await expect(invoke(channel, payload, foreign)).rejects.toThrow("Untrusted");
        }
        const bad: Array<[string, unknown]> = [
            [IPC.cloudRequest, { method: "PUT", path: "/v1/projects" }],
            [IPC.cloudRequest, { method: "GET", path: "/v1/account" }],
            [IPC.cloudRequest, { method: "GET", path: "/v1/uploads" }],
            [IPC.cloudRequest, { method: "GET", path: "/v1/projects", headers: { Authorization: "Bearer x" } }],
            [IPC.cloudRequest, { method: "GET", path: "/v1/projects", query: { cursor: { a: 1 } } }],
            [IPC.cloudRequest, { method: "POST", path: "/v1/projects", body: { name: "x".repeat(3 * 1024 * 1024) } }],
            [IPC.cloudRequest, { method: "GET", path: "/v1/projects", apiKey: "sk-x" }],
            [IPC.cloudDescribe, { mediaId: "../x" }],
            [IPC.cloudUpload, { mediaId: PROJECT, serverProjectId: "../x" }],
            [IPC.cloudUpload, { mediaId: PROJECT }],
            [IPC.cloudCache, { url: "x".repeat(5000), sizeBytes: null }],
            [IPC.cloudCache, { url: "https://cdn.opennan.com/a.mp4", sizeBytes: -1 }],
            [IPC.cloudCache, { url: "https://cdn.opennan.com/a.mp4", sizeBytes: 2 * 1024 ** 3 }],
            [IPC.cloudDuplicate, { mediaId: PROJECT, projectId: "cloud-abc" }],
            [IPC.cloudStoreGet, { account: "a", namespace: "settings", key: "k" }],
            [IPC.cloudStoreGet, { account: "a", namespace: "sync", key: "../k" }],
            [IPC.cloudStoreGet, { account: "", namespace: "sync", key: "k" }],
            [IPC.cloudStorePut, { account: "a", namespace: "sync", key: "a/b", value: 1 }],
            [IPC.cloudStorePut, { account: "a", namespace: "sync", key: "k" }],
            [IPC.cloudStoreKeys, { account: "a", namespace: "../mirror" }],
            [IPC.cloudCachePin, { ids: ["../x"] }],
            [IPC.cloudCachePin, { ids: Array.from({ length: 20_001 }, () => PROJECT) }],
            [IPC.cloudCacheSetLimit, { bytes: 1 }],
            [IPC.cloudCacheSetLimit, {}],
            [IPC.cloudCacheClear, { all: true }],
        ];
        for (const [channel, payload] of bad) await expect(invoke(channel, payload)).rejects.toThrow("Invalid");
        expect(fake.state().requests.slice(before)).toEqual([]);
        expect(fs.existsSync(path.join(dir, "cloud"))).toBe(false);
    });

    describe("director turn streams over IPC events (phase 9b)", () => {
        type Sent = { channel: string; payload: { streamId: string; bytes?: Uint8Array; error?: { code: string; status: number } } };
        function webContents(id = 1) {
            const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
            const target = {
                id,
                sent: [] as Sent[],
                destroyed: false,
                isDestroyed: () => target.destroyed,
                send: (channel: string, payload: Sent["payload"]) => {
                    if (target.destroyed) throw new Error("Object has been destroyed");
                    target.sent.push({ channel, payload });
                },
                on: (event: string, listener: (...args: unknown[]) => void) => {
                    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                    return target;
                },
                emit: (event: string, ...args: unknown[]) => {
                    for (const listener of listeners.get(event) ?? []) listener(...args);
                },
                listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
            };
            return target;
        }
        type Target = ReturnType<typeof webContents>;
        const start = (target: Target, payload: Record<string, unknown>) => invoke(IPC.cloudStreamStart, payload, top, target);
        const abort = (target: Target, streamId: string) => invoke(IPC.cloudStreamAbort, { streamId }, top, target);
        const textOf = (target: Target, streamId: string) => {
            const decoder = new TextDecoder();
            return target.sent.filter((e) => e.channel === EVENTS.cloudStreamChunk && e.payload.streamId === streamId).map((e) => decoder.decode(e.payload.bytes)).join("");
        };
        const ended = (target: Target, streamId: string) => target.sent.find((e) => e.channel === EVENTS.cloudStreamEnd && e.payload.streamId === streamId);
        const noKeyIn = (target: Target) => {
            for (const event of target.sent) {
                const text = JSON.stringify(event.payload) + (event.payload.bytes ? new TextDecoder().decode(event.payload.bytes) : "");
                expect(text).not.toContain(key);
                expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
            }
        };
        async function project(): Promise<string> {
            const created = await invoke(IPC.cloudRequest, { method: "POST", path: "/v1/projects", body: { name: "Trip" } }) as { value: { body: { id: string } } };
            return created.value.body.id;
        }

        beforeEach(() => {
            // invoke() with a sender: the stream channels need event.sender (the requesting webContents).
            invoke = async (channel, payload = {}, frame = top, sender?: unknown) => {
                const answer = await handlers.get(channel)!({ senderFrame: frame as never, sender }, payload);
                answers.push(answer);
                return answer;
            };
        });

        it("streams a turn's bytes to the requesting window only, then ends; no event carries the key", async () => {
            const id = await project();
            director().script([{ text: "Cutting the intro." }, { edit: { label: "Trim", changes: {} } }]);
            const target = webContents(1);
            const other = webContents(2);
            const started = await start(target, { streamId: "s-1", method: "POST", path: `/v1/projects/${id}/director/turns`, body: { message: "Trim it", stream: true }, headers: { "Idempotency-Key": "k-1" } });
            expect(started).toEqual({ ok: true, value: { status: 200 } });
            await vi.waitFor(() => expect(ended(target, "s-1")).toBeDefined(), { timeout: 5000 });
            expect(ended(target, "s-1")!.payload).toEqual({ streamId: "s-1" });
            const text = textOf(target, "s-1");
            expect(text).toContain("event: turn.started");
            expect(text).toContain("Cutting the intro.");
            expect(text).toContain("event: turn.finished");
            for (const event of target.sent.filter((e) => e.channel === EVENTS.cloudStreamChunk)) expect(event.payload.bytes).toBeInstanceOf(Uint8Array);
            expect(other.sent).toEqual([]);
            noKeyIn(target);
            expect(fake.state().requests.filter((r) => r.path.endsWith("/director/turns"))).toEqual([expect.objectContaining({ method: "POST", authorized: true })]);
        });

        it("answers a refusal like request(): CloudApiError JSON, no events", async () => {
            const target = webContents();
            const missing = await start(target, { streamId: "s-404", method: "POST", path: "/v1/projects/nope/director/turns", body: { message: "Hi" } }) as { ok: false; error: ReturnType<CloudApiError["toJSON"]> };
            expect(missing.ok).toBe(false);
            expect(CloudApiError.fromJSON(missing.error)).toMatchObject({ status: 404, fromServer: true });
            const id = await project();
            director().rateLimit(1);
            expect(await start(target, { streamId: "s-429", method: "POST", path: `/v1/projects/${id}/director/turns`, body: { message: "Hi" } })).toMatchObject({ ok: false, error: { status: 429, code: "rate_limit_exceeded" } });
            expect(target.sent).toEqual([]);
        });

        it("an abort drops the request (the server cancels the turn) and sends nothing more", async () => {
            const id = await project();
            director().script([{ text: "Working." }, { delay: 5000 }, { text: "Never." }]);
            const target = webContents();
            await start(target, { streamId: "s-abort", method: "POST", path: `/v1/projects/${id}/director/turns`, body: { message: "Hi" } });
            await vi.waitFor(() => expect(textOf(target, "s-abort")).toContain("Working."), { timeout: 3000 });
            expect(await abort(target, "s-abort")).toBeUndefined();
            await vi.waitFor(() => expect(director().state().turns[0]).toMatchObject({ status: "cancelled" }), { timeout: 3000 });
            const count = target.sent.length;
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(target.sent.length).toBe(count);
            expect(ended(target, "s-abort")).toBeUndefined();
            expect(textOf(target, "s-abort")).not.toContain("Never.");
            // Another window cannot abort it: aborts are per window.
            expect(await abort(webContents(9), "s-abort")).toBeUndefined();
        });

        it("a window that goes away (destroyed, crashed or reloaded) aborts its streams", async () => {
            const id = await project();
            for (const [i, event] of ["destroyed", "render-process-gone", "did-navigate"].entries()) {
                const pid = id;
                director().script([{ text: "Working." }, { delay: 5000 }]);
                const target = webContents();
                await start(target, { streamId: "s-gone", method: "POST", path: `/v1/projects/${pid}/director/turns`, body: { message: "Hi" } });
                await vi.waitFor(() => expect(textOf(target, "s-gone")).toContain("Working."), { timeout: 3000 });
                if (event === "destroyed") target.destroyed = true;
                target.emit(event);
                await vi.waitFor(() => expect(director().state().turns[i]).toMatchObject({ status: "cancelled" }), { timeout: 3000 });
                await vi.waitFor(() => expect(director().state().running).toEqual([]), { timeout: 3000 });
                expect(ended(target, "s-gone")).toBeUndefined();
            }
        });

        it("runs at most 4 streams per window and refuses a stream id already running", async () => {
            const stubHandlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
            const signals: AbortSignal[] = [];
            const endless = {
                stream: vi.fn(async (_method: string, _path: string, _request: unknown, signal: AbortSignal) => {
                    signals.push(signal);
                    return { status: 200, body: new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }) };
                }),
            };
            const stop = registerCloudIpc({ handle: (channel, listener) => void stubHandlers.set(channel, listener) }, { host: endless as never });
            const call = (channel: string, target: Target, payload: Record<string, unknown>) => stubHandlers.get(channel)!({ senderFrame: top as never, sender: target }, payload);
            const turn = (streamId: string) => ({ streamId, method: "POST", path: "/v1/projects/p1/director/turns", body: { message: "Hi" } });
            const target = webContents();
            for (let i = 0; i < 4; i += 1) expect(await call(IPC.cloudStreamStart, target, turn(`s-${i}`))).toMatchObject({ ok: true });
            expect(await call(IPC.cloudStreamStart, target, turn("s-0"))).toMatchObject({ ok: false, error: { code: "desktop_refused" } });
            expect(await call(IPC.cloudStreamStart, target, turn("s-4"))).toMatchObject({ ok: false, error: { status: 429, code: "desktop_busy" } });
            // Another window has its own streams.
            expect(await call(IPC.cloudStreamStart, webContents(2), turn("s-4"))).toMatchObject({ ok: true });
            await call(IPC.cloudStreamAbort, target, { streamId: "s-0" });
            expect(signals[0]!.aborted).toBe(true);
            expect(await call(IPC.cloudStreamStart, target, turn("s-5"))).toMatchObject({ ok: true });
            expect(target.listenerCount("destroyed")).toBe(1);
            // Shutdown aborts every stream of every window.
            stop();
            expect(signals.every((signal) => signal.aborted)).toBe(true);
            expect(target.sent).toEqual([]);
        });

        it("a mid-stream failure ends the stream with an error (redacted)", async () => {
            const stubHandlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
            const failing = {
                stream: vi.fn(async () => ({
                    status: 200,
                    body: new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("event: turn.thinking\ndata: {}\n\n"));
                            setTimeout(() => controller.error(new Error(`socket closed for ${key}`)), 20);
                        },
                    }),
                })),
            };
            const stop = registerCloudIpc({ handle: (channel, listener) => void stubHandlers.set(channel, listener) }, { host: failing as never });
            const target = webContents();
            const started = await stubHandlers.get(IPC.cloudStreamStart)!({ senderFrame: top as never, sender: target }, { streamId: "s-cut", method: "POST", path: "/v1/projects/p1/director/turns", body: { message: "Hi" } });
            expect(started).toEqual({ ok: true, value: { status: 200 } });
            await vi.waitFor(() => expect(ended(target, "s-cut")?.payload.error).toMatchObject({ status: 0, code: "network" }));
            expect(textOf(target, "s-cut")).toContain("turn.thinking");
            noKeyIn(target);
            stop();
        });

        it("refuses foreign senders and bad stream payloads before anything runs", async () => {
            const before = fake.state().requests.length;
            const target = webContents();
            await expect(invoke(IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/p1/director/turns" }, { url: "https://evil.example/" }, target)).rejects.toThrow("Untrusted");
            await expect(invoke(IPC.cloudStreamAbort, { streamId: "s" }, { url: "https://evil.example/" }, target)).rejects.toThrow("Untrusted");
            const bad: Array<[string, unknown]> = [
                [IPC.cloudStreamStart, { streamId: "s", method: "GET", path: "/v1/projects/p1/director/turns" }],
                [IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/p1/changes" }],
                [IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/quotes" }],
                [IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/../director/turns" }],
                [IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/p1/director/turns", headers: { Authorization: "Bearer x" } }],
                [IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/p1/director/turns", body: { message: "x".repeat(3 * 1024 * 1024) } }],
                [IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/p1/director/turns", query: { a: 1 } }],
                [IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/p1/director/turns", apiKey: "sk-x" }],
                [IPC.cloudStreamStart, { streamId: "a/b", method: "POST", path: "/v1/projects/p1/director/turns" }],
                [IPC.cloudStreamStart, { streamId: "x".repeat(65), method: "POST", path: "/v1/projects/p1/director/turns" }],
                [IPC.cloudStreamStart, { method: "POST", path: "/v1/projects/p1/director/turns" }],
                [IPC.cloudStreamAbort, { streamId: "" }],
                [IPC.cloudStreamAbort, { streamId: "s", extra: 1 }],
            ];
            for (const [channel, payload] of bad) await expect(invoke(channel, payload, top, target)).rejects.toThrow("Invalid");
            // A sender that is not a window (no send) is refused too.
            await expect(invoke(IPC.cloudStreamStart, { streamId: "s", method: "POST", path: "/v1/projects/p1/director/turns" }, top, {})).rejects.toThrow();
            expect(fake.state().requests.slice(before)).toEqual([]);
            expect(target.sent).toEqual([]);
        });
    });
});
