// The main-process cloud host against the fake OpenNan server: allowlisted API calls with the key added here, uploads
// of media-store files (hashed in main, deduplicated), guarded streaming downloads into the media store, copies.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudApiError } from "@opennan/cloud-backend";
import { OpenNanSession, createOpenNanApi, memoryCredentialStore } from "@opennan/provider-opennan";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { openDatabase, type DesktopDatabase } from "../store/database";
import { createMediaStore, type MediaStore } from "../store/media-store";
import { createMediaProtocolHandler } from "../protocol/media-protocol";
import { createCloudHost, type CloudHost, type CloudHostOptions } from "./cloud-host";

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
const OTHER = "22222222-2222-4333-8444-555555555555";
const idOf = (url: string) => url.slice("opennan-local://media/".length);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("cloud host", () => {
    let dir: string;
    let db: DesktopDatabase;
    let media: MediaStore;
    const answers: unknown[] = [];

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-cloud-host-")));
        db = openDatabase(":memory:");
        media = createMediaStore({ db, root: path.join(dir, "media") });
        answers.length = 0;
    });
    afterEach(() => {
        for (const answer of answers) expect(JSON.stringify(answer ?? null)).not.toMatch(/sk-/);
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function signedInSession(signedIn = true) {
        const session = new OpenNanSession({
            api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(signedIn ? { apiKey: fake.mintKey(), keyId: "key_1" } : null), deviceName: "Mac", client: "desktop",
        });
        await session.restore();
        return session;
    }

    async function setup(options: Partial<CloudHostOptions> & { signedIn?: boolean } = {}): Promise<CloudHost> {
        const session = options.session ?? (await signedInSession(options.signedIn ?? true));
        return createCloudHost({ apiBase: fake.url, session, mediaStore: media, root: path.join(dir, "cloud"), ...options });
    }

    /** Runs a call and records its answer or its error's JSON for the key scan. */
    async function record<T>(run: Promise<T>): Promise<T> {
        try {
            const value = await run;
            answers.push(value);
            return value;
        } catch (error) {
            answers.push(error instanceof CloudApiError ? error.toJSON() : String(error));
            throw error;
        }
    }

    /** cache(), then the file adopted into the media store (cache answers once the download's headers arrived). */
    async function cached(host: CloudHost, url: string, sizeBytes: number | null): Promise<string> {
        const local = await record(host.cache(url, sizeBytes));
        await vi.waitFor(() => expect(media.pathOf(idOf(local))).not.toBeNull());
        await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(dir, "cloud", "media-cache.json"), "utf8")).entries).toContainEqual(expect.objectContaining({ id: idOf(local), state: "ready" })));
        return local;
    }

    async function importClip(bytes = new Uint8Array(randomBytes(3000)), name = "clip.webm", mimeType = "video/webm") {
        const stored = await media.importBytes({ projectId: PROJECT, name, mimeType, kind: "video", bytes });
        return { id: stored.id, bytes };
    }

    it("sends the catalog and sync calls with the key added in main and answers status, body and ETag", async () => {
        const host = await setup();
        const created = await record(host.request("POST", "/v1/projects", { body: { name: "Trip" } }));
        expect(created.status).toBe(201);
        const id = (created.body as { id: string }).id;
        const doc = await record(host.request("GET", `/v1/projects/${id}/document`, {}));
        expect(doc).toMatchObject({ status: 200, etag: expect.stringMatching(/^"r\d+"$/) });
        const again = await record(host.request("GET", `/v1/projects/${id}/document`, { headers: { "If-None-Match": doc.etag! } }));
        expect(again).toEqual({ status: 304, body: null, etag: doc.etag });
        await record(host.request("PATCH", `/v1/projects/${id}`, { body: { name: "Trip 2" } }));
        const list = await record(host.request("GET", "/v1/projects", { query: { order: "updated", state: "active", limit: 10 } }));
        expect((list.body as { data: Array<{ name: string }> }).data.map((p) => p.name)).toEqual(["Trip 2"]);
        await record(host.request("DELETE", `/v1/projects/${id}`, {}));
        await record(host.request("POST", `/v1/projects/${id}/restore`, {}));
        expect((await record(host.request("GET", "/v1/storage", {}))).status).toBe(200);
        const sent = fake.state().requests.filter((r) => r.path.startsWith("/v1/projects") || r.path === "/v1/storage");
        expect(sent.length).toBeGreaterThanOrEqual(8);
        expect(sent.every((r) => r.authorized)).toBe(true);
    });

    it("passes the server's refusals as CloudApiError with code and details", async () => {
        const host = await setup();
        const error = await record(host.request("GET", "/v1/projects/nope", {})).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CloudApiError);
        expect(error).toMatchObject({ status: 404 });
    });

    it("refuses every request outside the allowlist before any network call", async () => {
        const fetch = vi.fn(globalThis.fetch);
        const host = await setup({ fetch });
        const before = fake.state().requests.length;
        const refused: Array<[string, string, Record<string, unknown>]> = [
            ["PUT", "/v1/projects", {}], ["GET", "/v1/account", {}], ["POST", "/v1/uploads", { body: {} }], ["DELETE", "/v1/auth/key", {}],
            ["GET", "/v1/projects/../account", {}], ["GET", "/v1/projects/a/b", {}], ["GET", `/v1/projects/${"a".repeat(37)}`, {}], ["POST", "/v1/projects/p/timeline/undo", {}],
            ["GET", "/v1/projects?x=1", {}], ["GET", "https://evil.example/v1/projects", {}],
            ["GET", "/v1/projects", { headers: { Authorization: "Bearer sk-stolen" } }], ["GET", "/v1/projects", { headers: { "X-Other": "1" } }],
            ["GET", "/v1/projects", { headers: { "If-Match": "x".repeat(201) } }], ["GET", "/v1/projects", { query: { cursor: { a: 1 } } }],
            ["POST", "/v1/projects", { body: { name: "x".repeat(3 * 1024 * 1024) } }],
        ];
        for (const [method, apiPath, request] of refused) {
            await expect(record(host.request(method as never, apiPath, request as never))).rejects.toMatchObject({ name: "CloudApiError", status: 400, code: "desktop_refused" });
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(fake.state().requests.slice(before)).toEqual([]);
    });

    it("signed out: the API's own 401 signed_out, nothing sent", async () => {
        const host = await setup({ signedIn: false });
        await expect(record(host.request("GET", "/v1/projects", {}))).rejects.toMatchObject({ status: 401, code: "signed_out" });
        expect(fake.state().requests).toEqual([]);
    });

    describe("director turn streams (phase 9b)", () => {
        async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
            const decoder = new TextDecoder();
            let text = "";
            for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
            return text + decoder.decode();
        }

        it("streams a turn's events with the key added in main", async () => {
            const host = await setup();
            const id = ((await record(host.request("POST", "/v1/projects", { body: { name: "Trip" } }))).body as { id: string }).id;
            director().script([{ text: "Hello there." }]);
            const answer = await host.stream("POST", `/v1/projects/${id}/director/turns`, { body: { message: "Hi", stream: true }, headers: { "idempotency-key": "k-1" } }, new AbortController().signal);
            expect(answer.status).toBe(200);
            const text = await readAll(answer.body);
            expect(text).toContain("event: turn.started");
            expect(text).toContain("Hello there.");
            expect(text).toContain("event: turn.finished");
            expect(text).not.toMatch(/sk-/);
            const sent = fake.state().requests.filter((r) => r.path === `/v1/projects/${id}/director/turns`);
            expect(sent).toEqual([expect.objectContaining({ method: "POST", authorized: true })]);
        });

        it("refuses anything but a director turn POST before any network call", async () => {
            const fetch = vi.fn(globalThis.fetch);
            const host = await setup({ fetch });
            const signal = new AbortController().signal;
            for (const [method, apiPath, request] of [
                ["GET", "/v1/projects/p1/director/turns", {}], ["POST", "/v1/projects/p1/changes", {}], ["POST", "/v1/quotes", {}],
                ["POST", "/v1/projects/p1/director/turns", { headers: { Authorization: "Bearer sk-x" } }],
                ["POST", "/v1/projects/../director/turns", {}], ["POST", "/v1/projects/p1/director/turns", { query: { a: 1 } }],
            ] as const) {
                await expect(record(host.stream(method as never, apiPath, request as never, signal))).rejects.toMatchObject({ status: 400, code: "desktop_refused" });
            }
            expect(fetch).not.toHaveBeenCalled();
        });

        it("passes a refusal as CloudApiError with the server's code", async () => {
            const host = await setup();
            await expect(record(host.stream("POST", "/v1/projects/nope/director/turns", { body: { message: "Hi" } }, new AbortController().signal))).rejects.toMatchObject({ name: "CloudApiError", status: 404 });
            const signedOut = await setup({ signedIn: false });
            await expect(record(signedOut.stream("POST", "/v1/projects/p1/director/turns", { body: { message: "Hi" } }, new AbortController().signal))).rejects.toMatchObject({ status: 401, code: "signed_out" });
        });

        it("gives the headers a deadline and the body an idle limit, never a total one", async () => {
            const never = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
            }));
            const opts = { apiBase: "https://api.opennan.com", session: { apiKey: () => "sk-test_abcdefghijklmnopqrstuvwxyz" }, mediaStore: media, root: path.join(dir, "cloud"), apiTimeoutMs: 80 };
            const slow = createCloudHost({ ...opts, fetch: never });
            await expect(record(slow.stream("POST", "/v1/projects/p1/director/turns", {}, new AbortController().signal))).rejects.toMatchObject({ status: 0, code: "network" });
            // A body that sends a byte every 40 ms for 200 ms (longer than the 80 ms deadline) and then stalls.
            const trickle = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
                let sent = 0;
                const body = new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        if (sent >= 5) return new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
                        await new Promise((resolve) => setTimeout(resolve, 40));
                        sent += 1;
                        controller.enqueue(new TextEncoder().encode(": ping\n\n"));
                    },
                });
                return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
            });
            const host = createCloudHost({ ...opts, fetch: trickle });
            const answer = await host.stream("POST", "/v1/projects/p1/director/turns", {}, new AbortController().signal);
            const reader = answer.body.getReader();
            for (let i = 0; i < 5; i += 1) expect((await reader.read()).done).toBe(false);
            await expect(reader.read()).rejects.toMatchObject({ name: "CloudApiError", status: 0, code: "network" });
            expect(trickle.mock.calls[0]![1]).toMatchObject({ redirect: "error", credentials: "omit" });
        });

        it("an abort ends the request: the server cancels the dropped turn", async () => {
            const host = await setup();
            const id = ((await record(host.request("POST", "/v1/projects", { body: { name: "Trip" } }))).body as { id: string }).id;
            director().script([{ text: "Working." }, { delay: 5000 }, { text: "Never." }]);
            const abort = new AbortController();
            const answer = await host.stream("POST", `/v1/projects/${id}/director/turns`, { body: { message: "Hi" } }, abort.signal);
            const reader = answer.body.getReader();
            await reader.read();
            abort.abort();
            await expect(reader.read()).rejects.toThrow();
            await vi.waitFor(() => expect(director().state().turns[0]).toMatchObject({ status: "cancelled" }), { timeout: 3000 });
        });
    });

    it("describes media-store files", async () => {
        const host = await setup();
        const { id, bytes } = await importClip();
        expect(host.describe(id)).toEqual({ filename: "clip.webm", contentType: "video/webm", sizeBytes: bytes.byteLength });
        expect(host.describe(OTHER)).toBeNull();
        expect(host.describe("../x")).toBeNull();
    });

    it("uploads a media-store file hashed in main, deduplicated the second time, one upload per file at a time", async () => {
        const host = await setup();
        const created = await host.request("POST", "/v1/projects", { body: { name: "Trip" } });
        const serverId = (created.body as { id: string }).id;
        const { id, bytes } = await importClip();
        const [first, concurrent] = await Promise.all([record(host.upload(id, serverId)), record(host.upload(id, serverId))]);
        expect(concurrent).toEqual(first);
        expect(first).toMatchObject({ deduplicated: false, sha256: sha256(bytes), sizeBytes: bytes.byteLength, contentType: "video/webm", mediaUrl: expect.stringContaining(`${fake.url}/files/`) });
        const second = await record(host.upload(id, null));
        expect(second).toMatchObject({ deduplicated: true, assetId: first.assetId, mediaUrl: first.mediaUrl });
        const requests = fake.state().requests;
        expect(requests.filter((r) => r.method === "POST" && r.path === "/v1/uploads")).toHaveLength(2);
        const puts = requests.filter((r) => r.method === "PUT");
        expect(puts).toEqual([expect.objectContaining({ path: expect.stringMatching(/^\/u\//), authorized: false })]);
        const asset = fake.cloud.state().assets.find((a) => a.id === first.assetId)!;
        expect(asset).toMatchObject({ sha256: sha256(bytes), scope: "account", project_ids: [serverId] });
    });

    it("gives API calls a deadline: a server that never answers is a network failure", async () => {
        const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }));
        const host = createCloudHost({ apiBase: "https://api.opennan.com", session: { apiKey: () => "sk-test_abcdefghijklmnopqrstuvwxyz" }, mediaStore: media, root: path.join(dir, "cloud"), fetch, apiTimeoutMs: 50 });
        await expect(record(host.request("GET", "/v1/projects", {}))).rejects.toMatchObject({ name: "CloudApiError", status: 0, code: "network" });
    });

    it("gives an upload a deadline, and runs one upload per file and project at a time", async () => {
        const { id } = await importClip();
        const slow = await setup({ uploadTimeoutMs: 100 });
        fake.cloud.setLatency(1000, "/u/");
        await expect(record(slow.upload(id, null))).rejects.toMatchObject({ status: 0, code: "network" });
        fake.cloud.setLatency(0);
        const host = await setup();
        const created = await host.request("POST", "/v1/projects", { body: { name: "Trip" } });
        const serverId = (created.body as { id: string }).id;
        const before = fake.state().requests.length;
        const [withProject, without] = await Promise.all([record(host.upload(id, serverId)), record(host.upload(id, null))]);
        expect(withProject.assetId).toBe(without.assetId);
        expect(fake.state().requests.slice(before).filter((r) => r.method === "POST" && r.path === "/v1/uploads")).toHaveLength(2);
        expect(fake.cloud.state().assets.find((a) => a.id === withProject.assetId)!.project_ids).toEqual([serverId]);
    });

    it("refuses files OpenNan cannot hold and ids that are not in the media store, before any request", async () => {
        const host = await setup();
        const before = fake.state().requests.length;
        const mkv = await media.importBytes({ projectId: PROJECT, name: "a.mkv", mimeType: "video/x-matroska", kind: "video", bytes: new Uint8Array(10) });
        await expect(record(host.upload(mkv.id, null))).rejects.toMatchObject({ code: "unsupported_type" });
        await expect(record(host.upload(OTHER, null))).rejects.toMatchObject({ code: "missing_file" });
        await expect(record(host.upload(mkv.id, "../x"))).rejects.toMatchObject({ code: "desktop_refused" });
        expect(fake.state().requests.slice(before)).toEqual([]);
    });

    it("caches an OpenNan storage file once: streamed into the media store, shared by concurrent calls, remembered across restarts", async () => {
        const host = await setup();
        const { id, bytes } = await importClip();
        const uploaded = await host.upload(id, null);
        const before = fake.state().requests.length;
        const [local, same] = await Promise.all([record(host.cache(uploaded.mediaUrl, bytes.byteLength)), record(host.cache(uploaded.mediaUrl, bytes.byteLength))]);
        expect(same).toBe(local);
        expect(local).toMatch(/^opennan-local:\/\/media\/[0-9a-f-]{36}$/);
        await cached(host, uploaded.mediaUrl, bytes.byteLength);
        expect(idOf(local)).not.toBe(id);
        expect(fs.readFileSync(media.pathOf(idOf(local))!)).toEqual(Buffer.from(bytes));
        expect(media.info(idOf(local))).toMatchObject({ projectId: null, mimeType: "video/webm" });
        const gets = () => fake.state().requests.slice(before).filter((r) => r.method === "GET" && r.path.startsWith("/files/"));
        expect(gets()).toHaveLength(1);
        expect(await record(host.cache(uploaded.mediaUrl, null))).toBe(local);
        const restarted = await setup();
        expect(await record(restarted.cache(uploaded.mediaUrl, null))).toBe(local);
        expect(gets()).toHaveLength(1);
        // A cached file deleted from the media store is downloaded again.
        await media.delete(idOf(local));
        const fresh = await cached(restarted, uploaded.mediaUrl, null);
        expect(fresh).not.toBe(local);
        expect(gets()).toHaveLength(2);
        expect(fs.readdirSync(path.join(dir, "cloud", "downloads"))).toEqual([]);
    });

    it("sweeps download temp files a crash left behind when it starts", async () => {
        const downloads = path.join(dir, "cloud", "downloads");
        fs.mkdirSync(downloads, { recursive: true });
        fs.writeFileSync(path.join(downloads, "x.part"), "half");
        fs.writeFileSync(path.join(dir, "cloud", "media-cache.json.1.tmp"), "half");
        const host = await setup();
        const { id } = await importClip();
        const uploaded = await host.upload(id, null);
        await host.cache(uploaded.mediaUrl, null);
        expect(fs.readdirSync(downloads)).toEqual([]);
        expect(fs.readdirSync(path.join(dir, "cloud")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("downloads only OpenNan storage: no other host, no temporary uploads, no API paths", async () => {
        const fetch = vi.fn(globalThis.fetch);
        const host = await setup({ fetch });
        for (const url of [
            "https://evil.example/a.mp4", "http://cdn.opennan.com/a.mp4", `${fake.url}/files/uploads/temp/o/t.wav`, `${fake.url}/v1/account`, "file:///etc/passwd",
            `${fake.url.replace("127.0.0.1", "localhost")}/files/a.mp4`,
        ]) await expect(record(host.cache(url, null))).rejects.toMatchObject({ code: "download_refused" });
        expect(fetch).not.toHaveBeenCalled();
        // With a production API base the fake's files are not OpenNan storage either.
        const production = await setup({ apiBase: "https://api.opennan.com", fetch });
        await expect(record(production.cache(`${fake.url}/files/uploads/media/o/a.webm`, null))).rejects.toMatchObject({ code: "download_refused" });
        expect(fetch).not.toHaveBeenCalled();
    });

    describe("guarded download (stub fetch on the CDN)", () => {
        const CDN = "https://cdn.opennan.com/uploads/media/o/a.webm";
        const stub = (answer: (url: string, init?: RequestInit) => Response) => vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => answer(String(input), init));

        it("asks without credentials, follows no redirect by itself, and re-checks every hop", async () => {
            const seen: Array<{ url: string; init?: RequestInit }> = [];
            const fetch = stub((url, init) => {
                seen.push({ url, init });
                if (url === CDN) return new Response(null, { status: 302, headers: { location: "/uploads/media/o/b.webm" } });
                return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/webm" } });
            });
            const host = await setup({ apiBase: "https://api.opennan.com", fetch });
            const local = await cached(host, CDN, 3);
            expect(fs.readFileSync(media.pathOf(idOf(local))!)).toEqual(Buffer.from([1, 2, 3]));
            expect(seen.map((s) => s.url)).toEqual([CDN, "https://cdn.opennan.com/uploads/media/o/b.webm"]);
            for (const { init } of seen) expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
            for (const { init } of seen) expect(new Headers(init?.headers).get("authorization")).toBeNull();
        });

        it.each([
            "https://media.opennan-storage.example/a.webm", "https://cdn.opennan.com/uploads/temp/o/t.wav", "http://media.opennan-storage.example/a.webm", "https://127.0.0.1/a.webm", "https://10.0.0.8/a.webm", "https://[::1]/a.webm", "https://localhost/a.webm",
            "https://169.254.169.254/latest/meta-data",
        ])("refuses a redirect to %s", async (location) => {
            const fetch = stub((url) => (url === CDN ? new Response(null, { status: 302, headers: { location } }) : new Response("secret")));
            const host = await setup({ apiBase: "https://api.opennan.com", fetch });
            await expect(record(host.cache(CDN, null))).rejects.toMatchObject({ code: "download_failed" });
            expect(fetch).toHaveBeenCalledTimes(1);
        });

        it("caps the bytes at the listed size + 1 MiB while streaming, and by Content-Length up front", async () => {
            const cap = 10 + 1024 ** 2;
            let pulled = 0;
            const big = () => new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulled += 64 * 1024;
                    if (pulled > cap + 256 * 1024) controller.close();
                    else controller.enqueue(new Uint8Array(64 * 1024));
                },
            });
            const warn = vi.fn();
            const host = await setup({ apiBase: "https://api.opennan.com", warn, fetch: stub(() => new Response(big(), { status: 200, headers: { "content-type": "video/webm" } })) });
            // The listed size is known at the headers, so cache() answers; the body over the cap ends the download.
            const local = await record(host.cache(CDN, 10));
            await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[cloud] download failed", expect.stringMatching(/larger/)));
            expect(media.pathOf(idOf(local))).toBeNull();
            const declared = await setup({ apiBase: "https://api.opennan.com", fetch: stub(() => new Response("x", { status: 200, headers: { "content-type": "video/webm", "content-length": String(cap + 1) } })) });
            // (Other URLs: the first one's entry stays "partial", so asking for it again answers at once and retries.)
            await expect(record(declared.cache("https://cdn.opennan.com/uploads/media/o/declared.webm", 10))).rejects.toMatchObject({ code: "download_failed", message: expect.stringMatching(/larger/) });
            const missing = await setup({ apiBase: "https://api.opennan.com", fetch: stub(() => new Response("gone", { status: 404 })) });
            await expect(record(missing.cache("https://cdn.opennan.com/uploads/media/o/missing.webm", 10))).rejects.toMatchObject({ code: "download_failed" });
            const notMedia = await setup({ apiBase: "https://api.opennan.com", fetch: stub(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })) });
            await expect(record(notMedia.cache("https://cdn.opennan.com/page", null))).rejects.toMatchObject({ code: "download_failed" });
            expect(fs.readdirSync(path.join(dir, "cloud", "downloads"))).toEqual([]);
            expect(db.prepare("select count(*) as n from media").get()).toEqual({ n: 0 });
        });

        it("downloads at most 3 files at once", async () => {
            let running = 0;
            let most = 0;
            const releases: Array<() => void> = [];
            const fetch = vi.fn(async () => {
                running += 1;
                most = Math.max(most, running);
                await new Promise<void>((resolve) => releases.push(resolve));
                running -= 1;
                return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "video/webm" } });
            });
            const host = await setup({ apiBase: "https://api.opennan.com", fetch });
            const all = Promise.all([1, 2, 3, 4, 5].map((n) => record(host.cache(`https://cdn.opennan.com/uploads/media/o/${n}.webm`, 1))));
            await vi.waitFor(() => expect(releases).toHaveLength(3));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(fetch).toHaveBeenCalledTimes(3);
            for (let i = 0; i < 5; i++) {
                await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
                releases.shift()!();
            }
            expect(new Set(await all).size).toBe(5);
            expect(most).toBe(3);
        });

        it("times out a download that never ends", async () => {
            const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    init?.signal?.addEventListener("abort", () => controller.error(new DOMException("timed out", "TimeoutError")));
                },
            }), { status: 200, headers: { "content-type": "video/webm" } }));
            const host = await setup({ apiBase: "https://api.opennan.com", fetch, downloadTimeoutMs: 50 });
            await expect(record(host.cache(CDN, null))).rejects.toMatchObject({ code: "download_failed" });
            expect(fs.readdirSync(path.join(dir, "cloud", "downloads"))).toEqual([]);
        });
    });

    describe("streaming while downloading (stub CDN)", () => {
        const CDN = "https://cdn.opennan.com/uploads/media/o/";
        const BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);
        let open: () => void;
        let gate: Promise<void>;
        let seen: Array<{ url: string; range: string | null; init?: RequestInit }>;
        let rangeAnswer: (url: string, start: number, end: number) => Response;
        let failFirst: boolean;
        let warn: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;

        beforeEach(() => {
            gate = new Promise<void>((resolve) => {
                open = resolve;
            });
            seen = [];
            failFirst = false;
            warn = vi.fn();
            rangeAnswer = (_url, start, end) => new Response(BYTES.slice(start, end + 1), { status: 206, headers: { "content-type": "video/webm", "content-range": `bytes ${start}-${end}/100` } });
        });

        /** The whole file: 40 bytes at once, the rest when the gate opens; a Range request: rangeAnswer. */
        const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const range = new Headers(init?.headers).get("range");
            seen.push({ url, range, init });
            if (range) {
                const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
                return rangeAnswer(url, Number(start), Number(end));
            }
            const fail = failFirst;
            failFirst = false;
            return new Response(new ReadableStream<Uint8Array>({
                async start(controller) {
                    controller.enqueue(BYTES.slice(0, 40));
                    if (fail) {
                        controller.error(new Error("connection reset"));
                        return;
                    }
                    await gate;
                    controller.enqueue(BYTES.slice(40));
                    controller.close();
                },
            }), { status: 200, headers: { "content-type": "video/webm", "content-length": "100" } });
        });

        const streamingHost = () => setup({ apiBase: "https://api.opennan.com", fetch: fetch as never, warn });
        const protocolFor = (host: CloudHost) => createMediaProtocolHandler(media, { streaming: (id) => host.streamSource(id) });
        const get = (local: string, range?: string) => new Request(`opennan-media://blob/${idOf(local)}`, range ? { headers: { Range: range } } : undefined);
        const partFile = (local: string) => path.join(dir, "cloud", "downloads", `${idOf(local)}.part`);
        const bytesOf = async (response: Response) => [...new Uint8Array(await response.arrayBuffer())];

        it("answers at the headers while the body still flows, then adopts the file under that same id", async () => {
            const host = await streamingHost();
            const local = await record(host.cache(`${CDN}a.webm`, 100));
            expect(media.pathOf(idOf(local))).toBeNull();
            const entries = () => JSON.parse(fs.readFileSync(path.join(dir, "cloud", "media-cache.json"), "utf8")).entries as unknown[];
            expect(entries()).toEqual([expect.objectContaining({ id: idOf(local), url: `${CDN}a.webm`, sizeBytes: 100, state: "partial", mimeType: "video/webm" })]);
            // Asked again meanwhile: the same id, no second download.
            expect(await record(host.cache(`${CDN}a.webm`, 100))).toBe(local);
            open();
            await vi.waitFor(() => expect(media.pathOf(idOf(local))).not.toBeNull());
            expect(new Uint8Array(fs.readFileSync(media.pathOf(idOf(local))!))).toEqual(BYTES);
            await vi.waitFor(() => expect(entries()).toEqual([expect.objectContaining({ id: idOf(local), sizeBytes: 100, state: "ready" })]));
            expect(seen).toHaveLength(1);
            expect(await host.streamSource(idOf(local))).toBeNull();
        });

        it("the protocol serves a range already on disk from the part file and a range beyond it with a ranged request to OpenNan's storage", async () => {
            const host = await streamingHost();
            const local = await record(host.cache(`${CDN}a.webm`, 100));
            await vi.waitFor(() => expect(fs.statSync(partFile(local)).size).toBe(40));
            const serve = protocolFor(host);
            const head = await serve(get(local, "bytes=0-9"));
            expect(head.status).toBe(206);
            expect(head.headers.get("content-range")).toBe("bytes 0-9/100");
            expect(head.headers.get("content-type")).toBe("video/webm");
            expect(await bytesOf(head)).toEqual([...BYTES.slice(0, 10)]);
            expect(seen.filter((s) => s.range)).toEqual([]);
            const tail = await serve(get(local, "bytes=90-99"));
            expect(tail.status).toBe(206);
            expect(await bytesOf(tail)).toEqual([...BYTES.slice(90)]);
            const ranged = seen.filter((s) => s.range);
            expect(ranged).toEqual([expect.objectContaining({ url: `${CDN}a.webm`, range: "bytes=90-99" })]);
            expect(ranged[0]!.init).toMatchObject({ credentials: "omit", redirect: "manual" });
            expect(new Headers(ranged[0]!.init?.headers).get("authorization")).toBeNull();
            // A storage that ignores the range (200) is read from the start of the range, never past its end.
            rangeAnswer = () => new Response(BYTES.slice(), { status: 200, headers: { "content-type": "video/webm", "content-length": "100" } });
            expect(await bytesOf(await serve(get(local, "bytes=50-54")))).toEqual([50, 51, 52, 53, 54]);
            // The whole file (no Range) while downloading.
            const whole = await serve(get(local));
            expect(whole.status).toBe(200);
            expect(whole.headers.get("content-length")).toBe("100");
            expect(new Uint8Array(await whole.arrayBuffer())).toEqual(BYTES);
            open();
            await vi.waitFor(() => expect(media.pathOf(idOf(local))).not.toBeNull());
            const before = seen.length;
            expect(await bytesOf(await serve(get(local, "bytes=95-99")))).toEqual([95, 96, 97, 98, 99]);
            expect(seen).toHaveLength(before);
        });

        it.each([
            ["a redirect off OpenNan's storage", () => new Response(null, { status: 302, headers: { location: "https://evil.example/a.webm" } })],
            ["a redirect to a temporary upload", () => new Response(null, { status: 302, headers: { location: "https://cdn.opennan.com/uploads/temp/o/a.webm" } })],
            ["a Content-Range that does not match", () => new Response(BYTES.slice(0, 10), { status: 206, headers: { "content-range": "bytes 0-9/100" } })],
            ["a Content-Range of another size", () => new Response(BYTES.slice(90), { status: 206, headers: { "content-range": "bytes 90-99/200" } })],
            ["a 200 of another size", () => new Response(BYTES.slice(0, 50), { status: 200, headers: { "content-length": "50" } })],
            ["an error status", () => new Response("no", { status: 403 })],
        ])("refuses %s (502)", async (_name, answer) => {
            const host = await streamingHost();
            const local = await record(host.cache(`${CDN}a.webm`, 100));
            rangeAnswer = answer;
            const res = await protocolFor(host)(get(local, "bytes=90-99"));
            expect(res.status).toBe(502);
            expect(seen.filter((s) => s.range).map((s) => s.url)).toEqual([`${CDN}a.webm`]);
            open();
        });

        it("a failed download stays partial, still streamed, and the next cache() downloads it again under the same id", async () => {
            failFirst = true;
            const host = await streamingHost();
            const local = await record(host.cache(`${CDN}a.webm`, 100));
            await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[cloud] download failed", expect.stringMatching(/reset/)));
            expect(fs.existsSync(partFile(local))).toBe(false);
            expect(media.pathOf(idOf(local))).toBeNull();
            const source = await host.streamSource(idOf(local));
            expect(source).toMatchObject({ size: 100, mimeType: "video/webm" });
            expect(await bytesOf(await protocolFor(host)(get(local, "bytes=0-3")))).toEqual([0, 1, 2, 3]);
            // After a restart too (the download is not running there).
            const restarted = await streamingHost();
            expect(await restarted.streamSource(idOf(local))).toMatchObject({ size: 100 });
            expect(await record(restarted.cache(`${CDN}a.webm`, 100))).toBe(local);
            open();
            await vi.waitFor(() => expect(media.pathOf(idOf(local))).not.toBeNull());
            expect(new Uint8Array(fs.readFileSync(media.pathOf(idOf(local))!))).toEqual(BYTES);
            expect(seen.filter((s) => !s.range)).toHaveLength(2);
        });

        it("a copy for a local project waits for the download", async () => {
            const host = await streamingHost();
            const local = await record(host.cache(`${CDN}a.webm`, 100));
            let copied = false;
            const copy = record(host.duplicate(idOf(local), OTHER)).then((value) => {
                copied = true;
                return value;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(copied).toBe(false);
            open();
            const made = await copy;
            expect(made).toMatchObject({ size: 100, mimeType: "video/webm" });
            expect(media.info(idOf(made.url))).toMatchObject({ projectId: OTHER });
            expect(new Uint8Array(fs.readFileSync(media.pathOf(idOf(made.url))!))).toEqual(BYTES);
        });

        it("streams nothing for ids that are not downloads in progress", async () => {
            const host = await streamingHost();
            const { id } = await importClip();
            expect(await host.streamSource(id)).toBeNull();
            expect(await host.streamSource(OTHER)).toBeNull();
            expect(await host.streamSource("../x")).toBeNull();
        });
    });

    it("duplicates a media-store file under a new id for a local project", async () => {
        const host = await setup();
        const { id, bytes } = await importClip();
        const copy = await record(host.duplicate(id, OTHER));
        expect(copy).toMatchObject({ url: expect.stringMatching(/^opennan-local:\/\/media\//), name: "clip.webm", size: bytes.byteLength, mimeType: "video/webm" });
        expect(idOf(copy.url)).not.toBe(id);
        expect(media.info(idOf(copy.url))).toMatchObject({ projectId: OTHER });
        await media.deleteProject(OTHER);
        expect(media.pathOf(id)).not.toBeNull();
        await expect(record(host.duplicate(OTHER, OTHER))).rejects.toMatchObject({ code: "missing_file" });
    });

    describe("media cache: LRU under a limit (stub CDN)", () => {
        const CDN = "https://cdn.opennan.com/uploads/media/o/";
        const DAY = 24 * 3600_000;
        const at = (name: string) => `${CDN}${name}`;
        let clock: number;
        let files: Record<string, Uint8Array>;
        let limit: { value: number | null; get(): number | null; set(bytes: number | null): void };
        let fetch: ReturnType<typeof vi.fn>;
        const cloudRoot = () => path.join(dir, "cloud");
        const indexFile = () => path.join(cloudRoot(), "media-cache.json");
        const readIndex = () => JSON.parse(fs.readFileSync(indexFile(), "utf8")) as { version: number; entries: Array<{ id: string; url: string; sizeBytes: number; lastUsed: number; state: string }> };
        const writeIndex = (value: unknown) => {
            fs.mkdirSync(cloudRoot(), { recursive: true });
            fs.writeFileSync(indexFile(), JSON.stringify(value));
        };
        const bytesOf = (n: number, fill: number) => new Uint8Array(n).fill(fill);

        beforeEach(() => {
            clock = 1_000 * DAY;
            files = { "a.webm": bytesOf(10, 1), "b.webm": bytesOf(10, 2), "c.webm": bytesOf(10, 3), "d.webm": bytesOf(10, 4), "e.webm": bytesOf(10, 5) };
            limit = { value: null, get() { return this.value; }, set(bytes) { this.value = bytes; } };
            fetch = vi.fn(serve);
        });

        /** The stub CDN: each file whole, with its type and length. */
        async function serve(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
            const bytes = files[String(input).slice(CDN.length)];
            if (!bytes) return new Response("gone", { status: 404 });
            return new Response(bytes.slice(), { status: 200, headers: { "content-type": "video/webm", "content-length": String(bytes.byteLength) } });
        }

        const cacheHost = (options: Partial<CloudHostOptions> = {}) => setup({ apiBase: "https://api.opennan.com", fetch: fetch as never, now: () => clock, limit, ...options });
        /** A file in the media store with no project, as a cached download (or a released local file) has. */
        const unowned = async (fill: number, id?: string) => media.putBlob(new Blob([bytesOf(10, fill)]), { projectId: null, name: "x.webm", mimeType: "video/webm", ...(id ? { id } : {}) });

        it("evicts the least recently used downloads first: room is made before a download and the limit kept after one", async () => {
            limit.value = 25;
            const host = await cacheHost();
            const a = await cached(host, at("a.webm"), 10);
            clock += 120_000;
            const b = await cached(host, at("b.webm"), 10);
            clock += 120_000;
            expect(await record(host.cache(at("a.webm"), 10))).toBe(a);
            clock += 120_000;
            const c = await cached(host, at("c.webm"), 10);
            expect(media.pathOf(idOf(b))).toBeNull();
            expect(media.info(idOf(b))).toBeNull();
            expect(fs.readFileSync(media.pathOf(idOf(a))!)).toEqual(Buffer.from(files["a.webm"]!));
            expect(media.pathOf(idOf(c))).not.toBeNull();
            expect(readIndex()).toMatchObject({ version: 2 });
            expect(readIndex().entries.map((e) => e.url).sort()).toEqual([at("a.webm"), at("c.webm")]);
            expect(await host.usage()).toMatchObject({ usedBytes: 20, entries: 2, limitBytes: 25, custom: true });
            // No listed size: nothing to make room for up front, so the limit is kept once the file is in.
            clock += 120_000;
            const d = await cached(host, at("d.webm"), null);
            await vi.waitFor(() => expect(media.pathOf(idOf(a))).toBeNull());
            expect(media.pathOf(idOf(c))).not.toBeNull();
            expect(media.pathOf(idOf(d))).not.toBeNull();
            expect(fetch).toHaveBeenCalledTimes(4);
        });

        it("never evicts a pinned file, a download still running, a released Save-to-OpenNan file, a file a local project names, or one a project owns now", async () => {
            const released = await importClip();
            media.releaseProject(PROJECT);
            const referenced = new Set<string>();
            const warn = vi.fn();
            let open!: () => void;
            const gate = new Promise<void>((resolve) => {
                open = resolve;
            });
            files["slow.webm"] = bytesOf(10, 9);
            fetch.mockImplementation(async (input: RequestInfo | URL) => {
                if (!String(input).endsWith("slow.webm")) return serve(input);
                return new Response(new ReadableStream<Uint8Array>({
                    async start(controller) {
                        controller.enqueue(bytesOf(4, 9));
                        await gate;
                        controller.enqueue(bytesOf(6, 9));
                        controller.close();
                    },
                }), { status: 200, headers: { "content-type": "video/webm", "content-length": "10" } });
            });
            const host = await cacheHost({ localReferences: (ids) => new Set(ids.filter((id) => referenced.has(`opennan-local://media/${id}`))), warn });
            const pinned = await cached(host, at("a.webm"), 10);
            const named = await cached(host, at("b.webm"), 10);
            const owned = await cached(host, at("c.webm"), 10);
            const free = await cached(host, at("d.webm"), 10);
            const slow = host.cache(at("slow.webm"), 10);
            await vi.waitFor(() => expect(readIndex().entries.find((e) => e.url === at("slow.webm"))).toMatchObject({ state: "partial", sizeBytes: 10 }));
            host.pin([idOf(pinned), "not-a-uuid"]);
            referenced.add(named);
            db.prepare("update media set project_id = ? where id = ?").run(OTHER, idOf(owned));
            clock += 120_000;
            expect(await record(host.clear())).toEqual({ freedBytes: 10, keptBytes: 10 });
            expect(media.pathOf(idOf(free))).toBeNull();
            for (const kept of [pinned, named, owned]) expect(media.pathOf(idOf(kept))).not.toBeNull();
            expect(media.pathOf(released.id)).not.toBeNull();
            expect(warn).toHaveBeenCalledTimes(2);
            // The ones a project uses are forgotten by the cache (never candidates again); their files stay.
            expect(readIndex().entries.map((e) => [e.url, e.state]).sort()).toEqual([[at("a.webm"), "ready"], [at("slow.webm"), "partial"]]);
            // Over the limit, the pinned file and the running download still stay.
            limit.value = 1;
            clock += 120_000;
            await cached(host, at("e.webm"), 10);
            expect(media.pathOf(idOf(pinned))).not.toBeNull();
            open();
            const done = await slow;
            await vi.waitFor(() => expect(media.pathOf(idOf(done))).not.toBeNull());
            expect(media.pathOf(released.id)).not.toBeNull();
        });

        it("keeps the old index when writing the new one fails, and finds it after a restart", async () => {
            if (process.platform === "win32") return;
            const host = await cacheHost();
            const a = await cached(host, at("a.webm"), 10);
            const before = fs.readFileSync(indexFile(), "utf8");
            fs.chmodSync(cloudRoot(), 0o500);
            try {
                await expect(record(host.cache(at("b.webm"), 10))).rejects.toMatchObject({ code: "download_failed" });
            } finally {
                fs.chmodSync(cloudRoot(), 0o700);
            }
            expect(fs.readFileSync(indexFile(), "utf8")).toBe(before);
            expect(fs.readdirSync(cloudRoot()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
            const calls = fetch.mock.calls.length;
            const restarted = await cacheHost();
            expect(await record(restarted.cache(at("a.webm"), 10))).toBe(a);
            expect(fetch.mock.calls.length).toBe(calls);
        });

        it("migrates the 9a index with sizes from the media table and drops entries whose file is gone", async () => {
            const kept = await unowned(1);
            writeIndex({ version: 1, entries: { [at("a.webm")]: kept.id, [at("b.webm")]: OTHER, [at("c.webm")]: "../x" } });
            const host = await cacheHost();
            expect(await host.usage()).toMatchObject({ usedBytes: 10, entries: 1 });
            expect(readIndex()).toEqual({ version: 2, entries: [{ id: kept.id, url: at("a.webm"), sizeBytes: 10, lastUsed: 0, state: "ready" }] });
            expect(await record(host.cache(at("a.webm"), 10))).toBe(`opennan-local://media/${kept.id}`);
            expect(fetch).not.toHaveBeenCalled();
        });

        it("at start: an adopt a crash interrupted becomes ready, stale partial downloads and vanished or project-owned files are forgotten", async () => {
            const adopted = await unowned(1);
            const ownedNow = await unowned(2);
            db.prepare("update media set project_id = ? where id = ?").run(OTHER, ownedNow.id);
            const fresh = "33333333-2222-4333-8444-555555555555";
            const stale = "44444444-2222-4333-8444-555555555555";
            const vanished = "55555555-2222-4333-8444-555555555555";
            const entry = (id: string, url: string, state: string, lastUsed: number) => ({ id, url, sizeBytes: 10, lastUsed, state, mimeType: "video/webm" });
            writeIndex({
                version: 2, entries: [
                    entry(adopted.id, at("a.webm"), "partial", clock - DAY), entry(ownedNow.id, at("b.webm"), "ready", clock - DAY),
                    entry(fresh, at("c.webm"), "partial", clock - DAY), entry(stale, at("d.webm"), "partial", clock - 31 * DAY), entry(vanished, at("e.webm"), "ready", clock - DAY),
                ],
            });
            const host = await cacheHost();
            expect(await host.usage()).toMatchObject({ usedBytes: 10, entries: 1 });
            expect(readIndex().entries.map((e) => [e.id, e.state]).sort()).toEqual([[adopted.id, "ready"], [fresh, "partial"]].sort());
            expect(media.pathOf(ownedNow.id)).not.toBeNull();
        });

        it("reports usage, takes a limit from 256 MiB to 1024 GB (or the default) and trims the cache to it at once", async () => {
            const GB = 1024 ** 3;
            const host = await cacheHost();
            expect(await record(host.usage())).toEqual({ usedBytes: 0, entries: 0, limitBytes: 10 * GB, defaultLimitBytes: 10 * GB, maxLimitBytes: 1024 * GB, pinnedBytes: 0, custom: false });
            const a = await cached(host, at("a.webm"), 10);
            await cached(host, at("b.webm"), 10);
            host.pin([idOf(a)]);
            expect(await host.usage()).toMatchObject({ usedBytes: 20, entries: 2, pinnedBytes: 10 });
            for (const bad of [1024, 1.5 * GB + 0.5, 1025 * GB, -1]) await expect(record(host.setLimit(bad))).rejects.toMatchObject({ code: "desktop_refused" });
            expect(await record(host.setLimit(256 * 1024 ** 2))).toMatchObject({ limitBytes: 256 * 1024 ** 2, custom: true });
            expect(limit.value).toBe(256 * 1024 ** 2);
            expect(await record(host.setLimit(null))).toMatchObject({ limitBytes: 10 * GB, custom: false });
            // A limit store that reads every choice back as 15 bytes: the new limit trims the cache before answering.
            let stored: number | null = null;
            const tiny = await cacheHost({ limit: { get: () => (stored === null ? null : 15), set: (bytes) => void (stored = bytes) } });
            clock += 120_000;
            expect(await record(tiny.setLimit(GB))).toMatchObject({ usedBytes: 10, entries: 1, limitBytes: 15, custom: true });
        });
    });
});
