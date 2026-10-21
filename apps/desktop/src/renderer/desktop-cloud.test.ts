// The desktop renderer's cloud backend over the bridge: a proxy CloudApi (errors rebuilt as CloudApiError), the IPC
// store bound to the account, the working copies' persistence, and a media host whose work runs in main.
import { CloudApiError, OpenNanCloudBackend, STORE_NAMESPACES } from "@opennan/cloud-backend";
import { streamTurn } from "@opennan/director-client";
import type { CloudStreamEvent } from "../shared/bridge";
import { CLOUD_NAMESPACES } from "../shared/cloud-policy";
import { DesktopBackend } from "./desktop-backend";
import {
    DESKTOP_CLOUD_BASE, DESKTOP_DEVICE_NAME, createDesktopCloudBackend, createDesktopExportUpload, createDesktopMediaHost, createIpcCloudStore, createProxyCloudApi, desktopCloudUrlCheck,
    desktopMirrorPersistence,
} from "./desktop-cloud";
import { createTestBridge } from "./test-bridge";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const COPY = "4f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
const LOCAL = `opennan-local://media/${ID}`;
const CDN = "https://cdn.opennan.com/uploads/media/o/abc.webm";
const PROJECT = "11111111-2222-4333-8444-555555555555";
const err = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, error: { status, code, message: `m ${code}`, fromServer: true, ...extra } });

describe("proxy CloudApi", () => {
    it("forwards the call with exactly its fields and answers status, body and ETag", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.request).mockResolvedValue({ ok: true, value: { status: 200, body: { data: [] }, etag: "\"r3\"" } });
        const api = createProxyCloudApi(bridge);
        expect(api.baseUrl).toBe(DESKTOP_CLOUD_BASE);
        const answer = await api.request("GET", "/v1/projects", { query: { order: "updated", cursor: undefined, limit: 50, state: null }, headers: { "If-None-Match": "\"r2\"" }, signal: new AbortController().signal });
        expect(answer).toEqual({ status: 200, body: { data: [] }, etag: "\"r3\"" });
        expect(bridge.cloud.request).toHaveBeenCalledWith("GET", "/v1/projects", { query: { order: "updated", limit: 50 }, headers: { "If-None-Match": "\"r2\"" } });
        await api.request("POST", "/v1/projects/p/changes", { body: { label: "x" } });
        expect(bridge.cloud.request).toHaveBeenLastCalledWith("POST", "/v1/projects/p/changes", { body: { label: "x" } });
    });

    it("rebuilds main's errors as CloudApiError with status, code, details and Retry-After", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.request).mockResolvedValue(err(412, "timeline_changed", { details: { revision: 9 }, retryAfterSeconds: 3, type: "invalid_request_error" }));
        const error = await createProxyCloudApi(bridge).request("POST", "/v1/projects/p/changes", { body: {} }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CloudApiError);
        expect(error).toMatchObject({ status: 412, code: "timeline_changed", details: { revision: 9 }, retryAfterSeconds: 3, fromServer: true, message: "m timeline_changed" });
    });

    it("turns a payload main refused into a CloudApiError, and an aborted call into an AbortError without a call", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.request).mockRejectedValue(new Error("Error invoking remote method 'opennan:cloud:request': Error: Invalid opennan:cloud:request payload: path"));
        await expect(createProxyCloudApi(bridge).request("PUT", "/v1/account")).rejects.toMatchObject({ name: "CloudApiError", status: 400, code: "desktop_refused" });
        vi.mocked(bridge.cloud.request).mockClear();
        const controller = new AbortController();
        controller.abort();
        await expect(createProxyCloudApi(bridge).request("GET", "/v1/projects", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(bridge.cloud.request).not.toHaveBeenCalled();
    });
});

describe("proxy CloudApi streams (phase 9b)", () => {
    const TURNS = "/v1/projects/p1/director/turns";
    const bytes = (text: string) => new TextEncoder().encode(text);
    async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return text + decoder.decode();
            text += decoder.decode(value, { stream: true });
        }
    }
    /** A bridge whose stream() hands the test the listener and the stream id. */
    function streamingBridge(result: Awaited<ReturnType<ReturnType<typeof createTestBridge>["bridge"]["cloud"]["stream"]>> = { ok: true, value: { status: 200 } }) {
        const { bridge } = createTestBridge();
        const calls: Array<{ streamId: string; listener: (event: CloudStreamEvent) => void }> = [];
        let release: () => void = () => undefined;
        const gate = { held: false };
        vi.mocked(bridge.cloud.stream).mockImplementation(async (streamId, _method, _path, _request, listener) => {
            calls.push({ streamId, listener });
            if (gate.held) await new Promise<void>((resolve) => { release = resolve; });
            return result;
        });
        return { bridge, calls, gate, release: () => release() };
    }

    it("streams through the bridge with exactly its fields and answers status and the bytes in order", async () => {
        const { bridge, calls } = streamingBridge();
        const api = createProxyCloudApi(bridge);
        expect(api.stream).toBeTypeOf("function");
        const answer = await api.stream!("POST", TURNS, { body: { message: "Hi", stream: true }, headers: { "Idempotency-Key": "k" }, query: { x: 1 } });
        expect(answer.status).toBe(200);
        expect(bridge.cloud.stream).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), "POST", TURNS, { body: { message: "Hi", stream: true }, headers: { "Idempotency-Key": "k" } }, expect.any(Function));
        const { listener } = calls[0]!;
        listener({ type: "chunk", bytes: bytes("event: message\n") });
        listener({ type: "chunk", bytes: bytes("data: {}\n\n") });
        listener({ type: "end" });
        expect(await readAll(answer.body)).toBe("event: message\ndata: {}\n\n");
        expect(bridge.cloud.streamAbort).not.toHaveBeenCalled();
    });

    it("keeps bytes that arrive before main's answer, and uses a fresh id per stream", async () => {
        const { bridge, calls, gate, release } = streamingBridge();
        gate.held = true;
        const api = createProxyCloudApi(bridge);
        const pending = api.stream!("POST", TURNS, { body: { message: "Hi" } });
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0]!.listener({ type: "chunk", bytes: bytes("early") });
        calls[0]!.listener({ type: "end" });
        release();
        expect(await readAll((await pending).body)).toBe("early");
        gate.held = false;
        await api.stream!("POST", TURNS, {});
        expect(calls[1]!.streamId).not.toBe(calls[0]!.streamId);
    });

    it("rebuilds a refusal and a mid-stream error as CloudApiError, like request()", async () => {
        const refused = streamingBridge(err(409, "turn_in_progress", { details: { turn_id: "turn_x" } }));
        const error = await createProxyCloudApi(refused.bridge).stream!("POST", TURNS, {}).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CloudApiError);
        expect(error).toMatchObject({ status: 409, code: "turn_in_progress", details: { turn_id: "turn_x" }, fromServer: true });

        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.stream).mockRejectedValue(new Error("Invalid opennan:cloud:stream-start payload: path"));
        await expect(createProxyCloudApi(bridge).stream!("POST", "/v1/projects/p1/changes", {})).rejects.toMatchObject({ name: "CloudApiError", status: 400, code: "desktop_refused" });

        const broken = streamingBridge();
        const answer = await createProxyCloudApi(broken.bridge).stream!("POST", TURNS, {});
        broken.calls[0]!.listener({ type: "chunk", bytes: bytes("event: turn.thinking\n") });
        broken.calls[0]!.listener({ type: "error", error: { status: 0, code: "network", message: "Can't reach OpenNan.", fromServer: false } });
        const reader = answer.body.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: turn.thinking\n");
        await expect(reader.read()).rejects.toMatchObject({ name: "CloudApiError", status: 0, code: "network" });
    });

    it("an abort before the call sends nothing; an abort while waiting or reading stops main's stream", async () => {
        const { bridge, calls, gate, release } = streamingBridge();
        const api = createProxyCloudApi(bridge);
        const already = new AbortController();
        already.abort();
        await expect(api.stream!("POST", TURNS, { signal: already.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(bridge.cloud.stream).not.toHaveBeenCalled();

        gate.held = true;
        const waiting = new AbortController();
        const pending = api.stream!("POST", TURNS, { signal: waiting.signal });
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        waiting.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(bridge.cloud.streamAbort).toHaveBeenCalledWith(calls[0]!.streamId);
        release();

        gate.held = false;
        const reading = new AbortController();
        const answer = await api.stream!("POST", TURNS, { signal: reading.signal });
        const reader = answer.body.getReader();
        const read = reader.read();
        reading.abort();
        await expect(read).rejects.toMatchObject({ name: "AbortError" });
        expect(bridge.cloud.streamAbort).toHaveBeenLastCalledWith(calls[1]!.streamId);
        expect(bridge.cloud.streamAbort).toHaveBeenCalledTimes(2);
    });

    it("cancelling the body stops main's stream once; a finished stream is not aborted", async () => {
        const { bridge, calls } = streamingBridge();
        const api = createProxyCloudApi(bridge);
        const answer = await api.stream!("POST", TURNS, {});
        await answer.body.cancel();
        expect(bridge.cloud.streamAbort).toHaveBeenCalledWith(calls[0]!.streamId);
        calls[0]!.listener({ type: "chunk", bytes: bytes("late") });
        const done = await api.stream!("POST", TURNS, {});
        calls[1]!.listener({ type: "end" });
        const reader = done.body.getReader();
        expect((await reader.read()).done).toBe(true);
        await reader.cancel();
        expect(bridge.cloud.streamAbort).toHaveBeenCalledTimes(1);
    });

    it("carries a director turn for @opennan/director-client's streamTurn", async () => {
        const { bridge, calls } = streamingBridge();
        const events: string[] = [];
        const run = (async () => {
            for await (const event of streamTurn(createProxyCloudApi(bridge), "p1", { message: "Trim the intro" })) events.push(event.type === "message" ? `message:${event.text}` : event.type);
        })();
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const { listener } = calls[0]!;
        const turn = { object: "director_turn", id: `turn_${"a".repeat(24)}`, project_id: "p1", status: "completed", reply: "Trimmed.", charged_usd: 0.03 };
        const sse = `event: turn.started\ndata: {"turn_id":"${turn.id}","hold_usd":0.429,"limits":{},"revision_start":3}\n\n: ping\n\nevent: message\ndata: {"round":1,"text":"Trimmed."}\n\nevent: turn.finished\ndata: ${JSON.stringify(turn)}\n\n`;
        const encoded = bytes(sse);
        for (let i = 0; i < encoded.length; i += 7) listener({ type: "chunk", bytes: encoded.slice(i, i + 7) });
        listener({ type: "end" });
        await run;
        expect(events).toEqual(["turn.started", "message:Trimmed.", "turn.finished"]);
        expect(vi.mocked(bridge.cloud.stream).mock.calls[0]!.slice(1, 4)).toEqual(["POST", "/v1/projects/p1/director/turns", expect.objectContaining({ body: expect.objectContaining({ message: "Trim the intro", stream: true }) })]);
    });
});

describe("IPC cloud store and working copies", () => {
    it("binds the store to the account", async () => {
        const { bridge } = createTestBridge();
        const store = createIpcCloudStore(bridge, "ada@example.com");
        await store.put("sync", "cloud-p1", { revision: 1 });
        expect(bridge.cloud.storePut).toHaveBeenCalledWith("ada@example.com", "sync", "cloud-p1", { revision: 1 });
        expect(await store.get("sync", "cloud-p1")).toEqual({ revision: 1 });
        expect(await store.keys("sync")).toEqual(["cloud-p1"]);
        expect(await createIpcCloudStore(bridge, "bob@example.com").get("sync", "cloud-p1")).toBeNull();
        await store.delete("sync", "cloud-p1");
        expect(await store.get("sync", "cloud-p1")).toBeNull();
    });

    it("keeps working copies in the mirror namespace; media go through main and are never deleted by a working copy", async () => {
        const { bridge } = createTestBridge();
        const store = createIpcCloudStore(bridge, "ada@example.com");
        const mirror = new DesktopBackend({ persistence: desktopMirrorPersistence(store) }, bridge);
        await mirror.seedProject("cloud-p1", { meta: { name: "Trip" } });
        expect(await store.keys("mirror")).toEqual(["cloud-p1"]);
        expect(bridge.persistence.save).not.toHaveBeenCalled();
        const file = new File([new Uint8Array(3)], "a.mp4", { type: "video/mp4" });
        const media = await mirror.uploadFile("cloud-p1", file, "video");
        expect(bridge.media.import).toHaveBeenCalledWith("cloud-p1", file, "video");
        await mirror.saveToLibrary("cloud-p1", media);
        expect(await mirror.listProjects()).toEqual([expect.objectContaining({ id: "cloud-p1", name: "Trip" })]);
        const persistence = desktopMirrorPersistence(store);
        await expect(persistence.putBlob("x", new Blob())).rejects.toThrow();
        await expect(persistence.getBlob("x")).resolves.toBeNull();
        await mirror.detachProject("cloud-p1");
        await mirror.seedProject("cloud-p2", {});
        await mirror.deleteProject("cloud-p2");
        expect(await store.keys("mirror")).toEqual([]);
        expect(bridge.media.delete).not.toHaveBeenCalled();
        expect(bridge.media.releaseProject).not.toHaveBeenCalled();
    });
});

describe("desktop media host", () => {
    it("describes, uploads and caches through main by media-store id", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.describe).mockResolvedValue({ filename: "a.webm", contentType: "video/webm", sizeBytes: 10 });
        vi.mocked(bridge.cloud.upload).mockResolvedValue({ ok: true, value: { assetId: "as1", mediaUrl: CDN, contentType: "video/webm", sizeBytes: 10, sha256: "f".repeat(64), deduplicated: false } });
        vi.mocked(bridge.cloud.cache).mockResolvedValue({ ok: true, value: { url: `opennan-local://media/${COPY}` } });
        const host = createDesktopMediaHost(bridge, desktopCloudUrlCheck(false));
        expect(await host.describe(LOCAL)).toEqual({ filename: "a.webm", contentType: "video/webm", sizeBytes: 10 });
        expect(bridge.cloud.describe).toHaveBeenCalledWith(ID);
        expect(await host.describe("https://evil.example/a.mp4")).toBeNull();
        const progress = vi.fn();
        expect(await host.upload(LOCAL, "srv1", new AbortController().signal, progress)).toMatchObject({ assetId: "as1", mediaUrl: CDN });
        expect(bridge.cloud.upload).toHaveBeenCalledWith(ID, "srv1");
        expect(progress).toHaveBeenCalledWith(10);
        expect(await host.cache!(CDN, 10, new AbortController().signal)).toBe(`opennan-local://media/${COPY}`);
        expect(bridge.cloud.cache).toHaveBeenCalledWith(CDN, 10);
        await host.cache!(CDN, 1.5, new AbortController().signal);
        expect(bridge.cloud.cache).toHaveBeenLastCalledWith(CDN, null);
    });

    it("passes upload refusals on as CloudApiError (the media sync maps their codes)", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.upload).mockResolvedValue(err(403, "storage_quota_exceeded"));
        const host = createDesktopMediaHost(bridge, desktopCloudUrlCheck(false));
        await expect(host.upload(LOCAL, null, new AbortController().signal)).rejects.toMatchObject({ name: "CloudApiError", status: 403, code: "storage_quota_exceeded" });
        await expect(host.upload("https://cdn.opennan.com/x.mp4", null, new AbortController().signal)).rejects.toMatchObject({ code: "missing_file" });
        vi.mocked(bridge.cloud.cache).mockResolvedValue(err(400, "download_refused"));
        await expect(host.cache!("https://evil.example/a.mp4", null, new AbortController().signal)).rejects.toMatchObject({ code: "download_refused" });
    });

    it("copies to a local project by duplicating in main (cloud files are cached first)", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.cache).mockResolvedValue({ ok: true, value: { url: LOCAL } });
        vi.mocked(bridge.cloud.duplicate).mockResolvedValue({ ok: true, value: { url: `opennan-local://media/${COPY}`, name: "a.webm", size: 10, mimeType: "video/webm" } });
        const host = createDesktopMediaHost(bridge, desktopCloudUrlCheck(false));
        const target = { uploadFile: vi.fn() };
        expect(await host.copyToLocal!(LOCAL, target, PROJECT)).toBe(`opennan-local://media/${COPY}`);
        expect(bridge.cloud.duplicate).toHaveBeenLastCalledWith(ID, PROJECT);
        expect(bridge.cloud.cache).not.toHaveBeenCalled();
        expect(await host.copyToLocal!(CDN, target, PROJECT)).toBe(`opennan-local://media/${COPY}`);
        expect(bridge.cloud.cache).toHaveBeenCalledWith(CDN, null);
        expect(target.uploadFile).not.toHaveBeenCalled();
        await expect(host.copyToLocal!("https://evil.example/a.mp4", target, PROJECT)).rejects.toThrow();
    });

    it("pins the media-store ids of the local files open cloud projects use, best effort", async () => {
        const { bridge } = createTestBridge();
        const host = createDesktopMediaHost(bridge, desktopCloudUrlCheck(false));
        host.pin!([LOCAL, `opennan-media://blob/${COPY}`, CDN, "opennan-local://media/../x", LOCAL]);
        expect(bridge.cloud.cachePin).toHaveBeenLastCalledWith([ID, COPY]);
        host.pin!([]);
        expect(bridge.cloud.cachePin).toHaveBeenLastCalledWith([]);
        // Main refusing a pin (or being gone) never reaches the sync engine.
        vi.mocked(bridge.cloud.cachePin).mockRejectedValueOnce(new Error("Invalid payload"));
        expect(() => host.pin!([LOCAL])).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("treats OpenNan's CDN as cloud storage, and the loopback fake's files only in e2e builds", () => {
        expect(desktopCloudUrlCheck(false)(CDN)).toBe(true);
        expect(desktopCloudUrlCheck(false)("https://cdn.opennan.com/uploads/temp/o/a.wav")).toBe(false);
        expect(desktopCloudUrlCheck(false)("http://127.0.0.1:4318/files/uploads/media/o/a.webm")).toBe(false);
        expect(desktopCloudUrlCheck(true)("http://127.0.0.1:4318/files/uploads/media/o/a.webm")).toBe(true);
        expect(desktopCloudUrlCheck(true)("http://127.0.0.1:4318/files/uploads/temp/o/a.wav")).toBe(false);
    });
});

describe("createDesktopCloudBackend", () => {
    it("builds an OpenNanCloudBackend whose catalog goes through main", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.request).mockResolvedValue({ ok: true, value: { status: 200, body: { data: [{ id: "srv1", name: "Trip", updated_at: "2026-10-20T10:00:00Z", origin: "studio" }], next_cursor: null }, etag: null } });
        const backend = createDesktopCloudBackend(bridge, "ada@example.com");
        expect(backend).toBeInstanceOf(OpenNanCloudBackend);
        const listed = await backend.listCloudProjects();
        expect(listed.projects).toEqual([expect.objectContaining({ id: "cloud-srv1", name: "Trip", kind: "cloud" })]);
        expect(bridge.cloud.request).toHaveBeenCalledWith("GET", "/v1/projects", { query: { order: "updated", state: "active", limit: 50 } });
        expect(bridge.cloud.storePut).toHaveBeenCalledWith("ada@example.com", "lists", "active", expect.any(Array));
        expect(DESKTOP_DEVICE_NAME).toBe("OpenNan Studio desktop");
        await backend.dispose();
    });

    it("with a migration, moves the email store's records to the account id's store before its first store call", async () => {
        const { bridge, cloudFiles } = createTestBridge();
        await bridge.cloud.storePut("ada@example.com", "sync", "cloud-old", { revision: 3 });
        await bridge.cloud.storePut("ada@example.com", "urls", "u1", { local: LOCAL, remote: CDN });
        let release!: () => void;
        const waitFor = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(bridge.cloud.request).mockResolvedValue({ ok: true, value: { status: 200, body: { data: [], next_cursor: null }, etag: null } });
        const backend = createDesktopCloudBackend(bridge, "id:usr_1", { migration: { from: "ada@example.com", waitFor } });
        const listed = backend.listCloudProjects();
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Nothing reaches the id store until the old backend let go of the email store.
        expect(vi.mocked(bridge.cloud.storePut).mock.calls.filter(([account]) => account === "id:usr_1")).toEqual([]);
        release();
        await listed;
        expect(cloudFiles.get("id:usr_1|sync")?.get("cloud-old")).toBe(JSON.stringify({ revision: 3 }));
        expect(cloudFiles.get("id:usr_1|urls")?.has("u1")).toBe(true);
        expect([...(cloudFiles.get("ada@example.com|sync")?.keys() ?? [])]).toEqual([]);
        await backend.dispose();
    });

    it("migrates every namespace main keeps", () => {
        expect([...STORE_NAMESPACES].sort()).toEqual([...CLOUD_NAMESPACES].sort());
    });
});

describe("Export and share on desktop (phase 9c)", () => {
    const result = (output: Record<string, unknown>) => ({ output, mimeType: "video/mp4" }) as never;

    it("has main upload the file it exported, with the project's id", async () => {
        const { bridge } = createTestBridge();
        vi.mocked(bridge.cloud.uploadExport).mockResolvedValue({ ok: true, value: { assetId: "a1", mediaUrl: CDN, contentType: "video/mp4", sizeBytes: 9, sha256: "x", deduplicated: false } });
        const upload = createDesktopExportUpload(bridge);
        const ratios: number[] = [];
        expect(await upload(result({ kind: "file", path: "/Users/me/Movies/OpenNan Studio/Trip.mp4" }), "p1", { signal: new AbortController().signal, onProgress: (r) => ratios.push(r) })).toEqual({ mediaUrl: CDN });
        expect(bridge.cloud.uploadExport).toHaveBeenCalledWith("/Users/me/Movies/OpenNan Studio/Trip.mp4", "p1");
        expect(ratios).toEqual([0, 1]);
    });

    it("refuses an export that is not a file main wrote, a refusal comes back as CloudApiError, and a cancel is an AbortError", async () => {
        const { bridge } = createTestBridge();
        const upload = createDesktopExportUpload(bridge);
        await expect(upload(result({ kind: "bytes", data: new Uint8Array(1) }), "p1", { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toThrow(/export/);
        await expect(upload(result({ kind: "file", path: "main" }), "p1", { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toThrow(/export/);
        vi.mocked(bridge.cloud.uploadExport).mockResolvedValue(err(400, "not_an_export"));
        await expect(upload(result({ kind: "file", path: "/x/Trip.mp4" }), "p1", { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toMatchObject({ name: "CloudApiError", code: "not_an_export" });
        const abort = new AbortController();
        abort.abort();
        await expect(upload(result({ kind: "file", path: "/x/Trip.mp4" }), "p1", { signal: abort.signal, onProgress: () => undefined })).rejects.toMatchObject({ name: "AbortError" });
    });
});
