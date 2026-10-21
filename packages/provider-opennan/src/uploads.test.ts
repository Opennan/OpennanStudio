import type { PreparedMedia } from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { OPENNAN_ERROR_COPY, OpenNanApiError } from "./errors";
import { startFakeOpenNan, type FakeOpenNan } from "./testing";
import { DEFAULT_UPLOAD_HOSTS, SINGLE_PUT_MAX_BYTES, UPLOAD_SCOPE_MESSAGE, isAllowedUploadUrl, uploadMedia, type UploadCache } from "./uploads";

const KEY = "sk-test_abcdefghijklmnopqrstuvwxyz0123";
const prepared = (bytes: number[], contentType = "audio/wav"): PreparedMedia => ({ data: new Uint8Array(bytes), contentType, filename: "clip.wav", sizeBytes: bytes.length, durationSeconds: 1 });

describe("isAllowedUploadUrl", () => {
    it("takes R2 presigned https and the API's own origin; plain http only on the loopback origin of a loopback API", () => {
        expect(isAllowedUploadUrl("https://bucket.r2.cloudflarestorage.com/x?sig=1", "https://api.opennan.com")).toBe(true);
        expect(isAllowedUploadUrl("https://acct.eu.r2.cloudflarestorage.com/x?sig=1", "https://api.opennan.com")).toBe(true);
        expect(isAllowedUploadUrl("https://api.opennan.com/v1/uploads/up_1/bytes", "https://api.opennan.com")).toBe(true);
        expect(isAllowedUploadUrl("https://u:p@bucket.r2.cloudflarestorage.com/x", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadUrl("http://bucket.example/x", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadUrl("http://127.0.0.1:4000/__uploads/1", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadUrl("http://127.0.0.1:4000/__uploads/1", "http://127.0.0.1:4000")).toBe(true);
        expect(isAllowedUploadUrl("http://127.0.0.1:4001/__uploads/1", "http://127.0.0.1:4000")).toBe(false);
        expect(isAllowedUploadUrl("http://localhost:4000/__uploads/1", "http://127.0.0.1:4000")).toBe(false);
        expect(isAllowedUploadUrl("not a url", "https://api.opennan.com")).toBe(false);
    });

    it("takes the upload gateway (https://upload.opennan.com/u/<token>) and keeps R2", () => {
        expect(DEFAULT_UPLOAD_HOSTS).toEqual(["*.r2.cloudflarestorage.com", "upload.opennan.com"]);
        expect(isAllowedUploadUrl("https://upload.opennan.com/u/abc.def", "https://api.opennan.com")).toBe(true);
        expect(isAllowedUploadUrl("http://upload.opennan.com/u/abc.def", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadUrl("https://evil.upload.opennan.com/u/abc.def", "https://api.opennan.com")).toBe(false);
        expect(isAllowedUploadUrl("https://upload.opennan.com.evil.example/u/abc.def", "https://api.opennan.com")).toBe(false);
    });

    it.each([
        "https://bucket.example/x",
        "https://r2.cloudflarestorage.com.evil.example/x",
        "https://evilr2.cloudflarestorage.com/x",
        "https://10.0.0.5/x",
        "https://169.254.169.254/latest/meta-data",
        "https://127.0.0.1/x",
        "https://[::1]/x",
        "https://localhost/x",
        "http://bucket.r2.cloudflarestorage.com/x",
    ])("refuses a hostile upload address %s", (url) => {
        expect(isAllowedUploadUrl(url, "https://api.opennan.com")).toBe(false);
    });

    it("takes other hosts only when they are allowed explicitly (a self-hosted server), never private literals", () => {
        const hosts = ["*.r2.cloudflarestorage.com", "storage.example.org", "*.blob.example.net"];
        expect(isAllowedUploadUrl("https://storage.example.org/x", "https://api.example.org", hosts)).toBe(true);
        expect(isAllowedUploadUrl("https://a.blob.example.net/x", "https://api.example.org", hosts)).toBe(true);
        expect(isAllowedUploadUrl("https://other.example.org/x", "https://api.example.org", hosts)).toBe(false);
        expect(isAllowedUploadUrl("https://10.0.0.5/x", "https://api.example.org", ["10.0.0.5"])).toBe(false);
    });
});

describe("uploadMedia against the fake server", () => {
    let fake: FakeOpenNan;
    beforeAll(async () => {
        fake = await startFakeOpenNan();
    });
    afterAll(() => fake.close());
    beforeEach(() => fake.reset());

    it("presigns, PUTs the exact bytes without the key, completes, and caches by content", async () => {
        const key = fake.mintKey();
        const api = createOpenNanApi({ baseUrl: fake.url });
        const cache: UploadCache = new Map();
        const signal = new AbortController().signal;
        const first = await uploadMedia(api, key, prepared([1, 2, 3]), { signal, cache });
        expect(first).toMatchObject({ mediaUrl: expect.stringMatching(new RegExp(`^${fake.url}/files/uploads/temp/`)), contentType: "audio/wav", sizeBytes: 3 });
        const bytes = new Uint8Array(await (await fetch(first.mediaUrl)).arrayBuffer());
        expect([...bytes]).toEqual([1, 2, 3]);
        const again = await uploadMedia(api, key, { ...prepared([1, 2, 3]), data: new Blob([new Uint8Array([1, 2, 3])]) }, { signal, cache });
        expect(again).toEqual(first);
        const other = await uploadMedia(api, key, prepared([1, 2, 3], "audio/mpeg"), { signal, cache });
        expect(other.mediaUrl).not.toBe(first.mediaUrl);
        const state = fake.state();
        expect(state.uploads).toHaveLength(2);
        expect(state.requests.filter((r) => r.method === "PUT").every((r) => !r.authorized)).toBe(true);
    });

    it("starts a new upload when the single-use gateway URL was already used (410), sending no project_id or scope", async () => {
        const key = fake.mintKey();
        const api = createOpenNanApi({ baseUrl: fake.url });
        let puts = 0;
        // The first gateway PUT is answered 410 (as if a retry had already used the URL); the restart lands.
        const racing: typeof globalThis.fetch = async (input, init) => {
            if (init?.method === "PUT" && (puts += 1) === 1) {
                await fetch(String(input), init);
                return fetch(String(input), init);
            }
            return fetch(input, init);
        };
        const uploaded = await uploadMedia({ ...api, fetch: racing }, key, prepared([4, 5, 6]), { signal: new AbortController().signal });
        expect(uploaded).toMatchObject({ contentType: "audio/wav", sizeBytes: 3, scope: "temp", expiresAt: expect.stringMatching(/Z$/) });
        const starts = fake.state().requests.filter((r) => r.method === "POST" && r.path === "/v1/uploads");
        expect(starts).toHaveLength(2);
        for (const start of starts) expect(start.body).toEqual({ filename: "clip.wav", content_type: "audio/wav", size_bytes: 3 });
        expect(fake.state().uploads.map((u) => u.completed)).toEqual([false, true]);
    });

    it("sends a tool input over the single-PUT limit in parts with their ETags (9a.1)", async () => {
        fake.cloud.setUploadLimits({ single_put_max_bytes: 8, part_size: 4 });
        const key = fake.mintKey();
        const bytes = Array.from({ length: 10 }, (_, i) => i + 1);
        const uploaded = await uploadMedia(createOpenNanApi({ baseUrl: fake.url }), key, prepared(bytes), { signal: new AbortController().signal, singlePutMaxBytes: 8 });
        expect(uploaded).toMatchObject({ sizeBytes: 10, scope: "temp" });
        expect([...new Uint8Array(await (await fetch(uploaded.mediaUrl)).arrayBuffer())]).toEqual(bytes);
        const starts = fake.state().requests.filter((r) => r.method === "POST" && r.path === "/v1/uploads");
        expect(starts.map((r) => r.body)).toEqual([{ filename: "clip.wav", content_type: "audio/wav", size_bytes: 10, multipart: true }]);
        const puts = fake.state().requests.filter((r) => r.method === "PUT");
        expect(puts).toHaveLength(3);
        expect(puts.every((r) => !r.authorized)).toBe(true);
        expect(fake.cloud.state().uploads.at(-1)).toMatchObject({ scope: "temp", transport: "multipart", completed: true });
        expect(SINGLE_PUT_MAX_BYTES).toBe(95 * 1024 * 1024);
    });

    it("asks again with parts when the server wants them (multipart_required) for a smaller file", async () => {
        fake.cloud.setUploadLimits({ single_put_max_bytes: 8, part_size: 4 });
        const key = fake.mintKey();
        const uploaded = await uploadMedia(createOpenNanApi({ baseUrl: fake.url }), key, prepared([1, 2, 3, 4, 5, 6, 7, 8, 9]), { signal: new AbortController().signal });
        expect(uploaded.sizeBytes).toBe(9);
        const starts = fake.state().requests.filter((r) => r.method === "POST" && r.path === "/v1/uploads").map((r) => r.body as Record<string, unknown>);
        expect(starts.map((b) => b.multipart ?? null)).toEqual([null, true]);
    });

    it("explains a server that takes no parts for tool inputs", async () => {
        fake.cloud.setUploadLimits({ single_put_max_bytes: 8, part_size: 4, temp_multipart: false });
        const key = fake.mintKey();
        const error = await uploadMedia(createOpenNanApi({ baseUrl: fake.url }), key, prepared([1, 2, 3, 4, 5, 6, 7, 8, 9]), { signal: new AbortController().signal }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanApiError);
        expect((error as OpenNanApiError).code).toBe("multipart_required");
        expect((error as Error).message).toBe(OPENNAN_ERROR_COPY.multipart_required);
    });

    it("explains a key without api:project", async () => {
        await fetch(`${fake.url}/__test/key-scopes?scopes=api:voice`);
        const key = fake.mintKey();
        const error = await uploadMedia(createOpenNanApi({ baseUrl: fake.url }), key, prepared([1]), { signal: new AbortController().signal }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanApiError);
        expect((error as OpenNanApiError).status).toBe(403);
        expect((error as Error).message).toBe(UPLOAD_SCOPE_MESSAGE);
        expect(UPLOAD_SCOPE_MESSAGE).toBe("Sign in again to allow uploads.");
        expect((error as OpenNanApiError).code).toBe("permission_denied");
    });
});

interface Call { method: string; url: string; init: RequestInit }

function storage(routes: (call: Call, n: number) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = { method: init.method ?? "GET", url: String(input), init };
        calls.push(call);
        return routes(call, calls.length);
    }) as typeof globalThis.fetch;
    return { api: createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }), calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PRESIGN = { upload_id: "up_1", upload_url: "https://bucket.r2.cloudflarestorage.com/k?sig=1", headers: { "Content-Type": "audio/wav", "Content-Length": "3" }, media_url: "https://media.opennan.com/k", expires_at: "2026-10-20T10:00:00Z" };
const COMPLETE = { asset_id: "a1", media_url: "https://media.opennan.com/k", content_type: "audio/wav", size_bytes: 3 };

describe("uploadMedia rules", () => {
    it("sends the PUT with only the given Content-Type, no credentials, no redirects, and no referrer", async () => {
        const { api, calls } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, PRESIGN);
            if (call.method === "PUT") return new Response(null, { status: 200 });
            return json(200, COMPLETE);
        });
        expect(await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal })).toEqual({ mediaUrl: COMPLETE.media_url, assetId: "a1", contentType: "audio/wav", sizeBytes: 3 });
        const presign = calls[0]!;
        expect(JSON.parse(String(presign.init.body))).toEqual({ filename: "clip.wav", content_type: "audio/wav", size_bytes: 3 });
        const put = calls[1]!;
        expect(put.url).toBe(PRESIGN.upload_url);
        const headers = new Headers(put.init.headers);
        expect([...headers.keys()]).toEqual(["content-type"]);
        expect(headers.get("content-type")).toBe("audio/wav");
        expect(put.init).toMatchObject({ method: "PUT", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
        expect(calls[2]!.url).toBe("https://api.opennan.com/v1/uploads/up_1/complete");
    });

    it("refuses a non-https upload URL without sending the bytes", async () => {
        const { api, calls } = storage(() => json(201, { ...PRESIGN, upload_url: "http://bucket.example/k" }));
        await expect(uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal })).rejects.toBeInstanceOf(OpenNanApiError);
        expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    });

    it("PUTs once more on a 409 from complete, then gives up with a typed error", async () => {
        let completes = 0;
        const { api, calls } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, PRESIGN);
            if (call.method === "PUT") return new Response(null, { status: 200 });
            completes += 1;
            return json(409, { error: { type: "conflict", message: "Nothing was uploaded to upload_url yet: PUT the file first.", code: null } });
        });
        const error = await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanApiError);
        expect(error).toMatchObject({ status: 409 });
        expect(completes).toBe(2);
        expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    });

    it("recovers when the second PUT lands", async () => {
        let completes = 0;
        const { api } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, PRESIGN);
            if (call.method === "PUT") return new Response(null, { status: 200 });
            completes += 1;
            return completes === 1 ? json(409, { error: { message: "PUT first" } }) : json(200, COMPLETE);
        });
        expect((await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal })).mediaUrl).toBe(COMPLETE.media_url);
    });

    it("upload_not_received: PUTs once more, then gives up with Studio's words (phase 11.1 codes)", async () => {
        let completes = 0;
        const { api, calls } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, PRESIGN);
            if (call.method === "PUT") return new Response(null, { status: 200 });
            completes += 1;
            return json(409, { error: { type: "conflict", message: "Nothing was uploaded to upload_url yet: PUT the file first.", code: "upload_not_received" } });
        });
        const error = await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal }).catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 409, code: "upload_not_received", message: "The file didn't reach OpenNan's storage. Run it again." });
        expect(completes).toBe(2);
        expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    });

    it.each([
        ["upload_size_mismatch", 400, "The upload didn't arrive intact. Run it again."],
        ["upload_type_mismatch", 400, "The upload didn't arrive intact. Run it again."],
        ["upload_not_found", 404, "The upload expired before it finished. Run it again."],
    ])("%s: a typed error without another PUT and without the server's text", async (code, status, message) => {
        const { api, calls } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, PRESIGN);
            if (call.method === "PUT") return new Response(null, { status: 200 });
            return json(status, { error: { type: "invalid_request_error", message: "The uploaded file is 2 bytes, not the 3 this upload was made for.", code } });
        });
        const error = await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanApiError);
        expect(error).toMatchObject({ status, code, message });
        expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    it("an expired gateway link (404 upload_not_found) starts one new upload too", async () => {
        const GATEWAY = { ...PRESIGN, upload_url: "https://upload.opennan.com/u/tok.sig", scope: "temp" };
        let starts = 0;
        const once = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, { ...GATEWAY, upload_id: `up_${(starts += 1)}` });
            if (call.method === "PUT") return starts === 1 ? json(404, { error: { type: "not_found", message: "expired", code: "upload_not_found" } }) : json(200, { etag: "e" });
            return json(200, { ...COMPLETE, scope: "temp", expires_at: "2026-10-21T10:00:00Z" });
        });
        expect((await uploadMedia(once.api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal })).assetId).toBe("a1");
        expect(once.calls.filter((c) => c.url.endsWith("/v1/uploads"))).toHaveLength(2);
    });

    it("a gateway 410 starts one new upload; a second 410 fails with Studio's words", async () => {
        const GATEWAY = { ...PRESIGN, upload_url: "https://upload.opennan.com/u/tok.sig", scope: "temp" };
        let starts = 0;
        const once = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, { ...GATEWAY, upload_id: `up_${(starts += 1)}` });
            if (call.method === "PUT") return starts === 1 ? json(410, { error: { type: "conflict", message: "This upload URL has already been used. Request a new one.", code: "upload_url_used" } }) : json(200, { etag: "e" });
            return json(200, { ...COMPLETE, scope: "temp", expires_at: "2026-10-21T10:00:00Z" });
        });
        expect(await uploadMedia(once.api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal })).toEqual({ mediaUrl: COMPLETE.media_url, assetId: "a1", contentType: "audio/wav", sizeBytes: 3, scope: "temp", expiresAt: "2026-10-21T10:00:00Z" });
        expect(once.calls.map((c) => `${c.method} ${c.url.replace("https://api.opennan.com", "")}`)).toEqual([
            "POST /v1/uploads", "PUT https://upload.opennan.com/u/tok.sig", "POST /v1/uploads", "PUT https://upload.opennan.com/u/tok.sig", "POST /v1/uploads/up_2/complete",
        ]);

        const twice = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, GATEWAY);
            if (call.method === "PUT") return json(410, { error: { type: "conflict", message: "used", code: "upload_url_used" } });
            return json(200, COMPLETE);
        });
        const error = await uploadMedia(twice.api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanApiError);
        expect(error).toMatchObject({ status: 410, code: "upload_url_used", message: OPENNAN_ERROR_COPY.upload_url_used });
        expect(twice.calls.filter((c) => c.url.endsWith("/v1/uploads"))).toHaveLength(2);
        expect(twice.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
    });

    it("a gateway URL is not PUT twice: complete's upload_not_received starts a new upload instead", async () => {
        const GATEWAY = { ...PRESIGN, upload_url: "https://upload.opennan.com/u/tok.sig" };
        let starts = 0;
        let completes = 0;
        const used = new Set<string>();
        const { api, calls } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, { ...GATEWAY, upload_id: `up_${(starts += 1)}`, upload_url: `https://upload.opennan.com/u/tok${starts}.sig` });
            if (call.method === "PUT") {
                if (used.has(call.url)) return json(410, { error: { type: "conflict", message: "used", code: "upload_url_used" } });
                used.add(call.url);
                return json(200, { etag: "e" });
            }
            completes += 1;
            return completes === 1 ? json(409, { error: { type: "conflict", message: "PUT first", code: "upload_not_received" } }) : json(200, COMPLETE);
        });
        expect((await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal })).mediaUrl).toBe(COMPLETE.media_url);
        expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.opennan.com", "")}`)).toEqual([
            "POST /v1/uploads", "PUT https://upload.opennan.com/u/tok1.sig", "POST /v1/uploads/up_1/complete", "PUT https://upload.opennan.com/u/tok1.sig",
            "POST /v1/uploads", "PUT https://upload.opennan.com/u/tok2.sig", "POST /v1/uploads/up_2/complete",
        ]);
    });

    it("reports a failed PUT and stops on abort mid-PUT", async () => {
        const failing = storage((call) => (call.method === "PUT" ? new Response("denied", { status: 403 }) : json(201, PRESIGN)));
        await expect(uploadMedia(failing.api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal })).rejects.toMatchObject({ code: "upload_failed" });

        const abort = new AbortController();
        const slow = storage((call) => {
            if (call.method !== "PUT") return json(201, PRESIGN);
            return new Promise<Response>((_resolve, reject) => {
                call.init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            });
        });
        const pending = uploadMedia(slow.api, KEY, prepared([1, 2, 3]), { signal: abort.signal });
        await vi.waitFor(() => expect(slow.calls.some((c) => c.method === "PUT")).toBe(true));
        abort.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(slow.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
    });

    it("refuses a content type the server cannot take without a request", async () => {
        const { api, calls } = storage(() => json(201, PRESIGN));
        await expect(uploadMedia(api, KEY, { ...prepared([1, 2, 3]), contentType: "application/zip" }, { signal: new AbortController().signal })).rejects.toThrow(/cannot take/);
        expect(calls).toEqual([]);
    });
});

describe("uploadMedia refuses a hostile upload address", () => {
    it.each(["https://10.0.0.5/k", "http://bucket.r2.cloudflarestorage.com/k", "https://bucket.example/k"])("%s: nothing is PUT", async (upload_url) => {
        const { api, calls } = storage((call) => (call.url.endsWith("/v1/uploads") ? json(201, { ...PRESIGN, upload_url }) : new Response(null, { status: 200 })));
        const error = await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal }).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "invalid_upload_url" });
        expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    });

    it("PUTs to a host the caller allowed explicitly", async () => {
        const { api, calls } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, { ...PRESIGN, upload_url: "https://storage.example.org/k?sig=1" });
            if (call.method === "PUT") return new Response(null, { status: 200 });
            return json(200, COMPLETE);
        });
        await uploadMedia(api, KEY, prepared([1, 2, 3]), { signal: new AbortController().signal, allowedHosts: ["storage.example.org"] });
        expect(calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual(["https://storage.example.org/k?sig=1"]);
    });
});

describe("uploadMedia in parts (9a.1)", () => {
    const MULTI = {
        upload_id: "up_m", upload_url: null, headers: { "Content-Type": "audio/wav" }, media_url: "https://media.opennan.com/m",
        multipart: { part_size: 2, parts: [{ number: 1, size: 2, url: "https://upload.opennan.com/u/p1.x" }, { number: 2, size: 1, url: "https://upload.opennan.com/u/p2.x" }] },
    };
    const big = { signal: new AbortController().signal, singlePutMaxBytes: 2 };

    it("takes a part's ETag from the header or the JSON body and completes with the parts in order", async () => {
        const { api, calls } = storage((call) => {
            if (call.url.endsWith("/v1/uploads")) return json(201, MULTI);
            if (call.url.endsWith("p1.x")) return new Response(JSON.stringify({ part_number: 1, etag: "e1" }), { status: 200, headers: { etag: '"e1"' } });
            if (call.url.endsWith("p2.x")) return json(200, { part_number: 2, etag: "e2" });
            return json(200, COMPLETE);
        });
        await uploadMedia(api, KEY, prepared([7, 8, 9]), big);
        const puts = calls.filter((c) => c.method === "PUT");
        expect(puts.map((c) => [...(c.init.body as Uint8Array)])).toEqual([[7, 8], [9]]);
        expect(puts.every((c) => c.init.credentials === "omit" && c.init.redirect === "error" && !new Headers(c.init.headers).has("authorization"))).toBe(true);
        const complete = calls.find((c) => c.url.endsWith("/complete"))!;
        expect(JSON.parse(String(complete.init.body))).toEqual({ parts: [{ number: 1, etag: "e1" }, { number: 2, etag: "e2" }] });
    });

    it("starts the whole upload once more when a part's link was used (410) or the parts were refused", async () => {
        for (const failure of ["part", "complete"] as const) {
            let starts = 0;
            let failed = false;
            const { api } = storage((call) => {
                if (call.url.endsWith("/v1/uploads")) {
                    starts += 1;
                    return json(201, MULTI);
                }
                if (call.method === "PUT") {
                    if (failure === "part" && !failed && call.url.endsWith("p2.x")) {
                        failed = true;
                        return json(410, { error: { code: "upload_url_used" } });
                    }
                    return json(200, { etag: "e" });
                }
                if (failure === "complete" && !failed) {
                    failed = true;
                    return json(400, { error: { type: "invalid_request_error", code: "upload_parts_invalid", message: "x" } });
                }
                return json(200, COMPLETE);
            });
            await expect(uploadMedia(api, KEY, prepared([7, 8, 9]), big)).resolves.toMatchObject({ mediaUrl: COMPLETE.media_url });
            expect(starts).toBe(2);
        }
    });

    it("refuses a part address off OpenNan's storage before sending anything", async () => {
        const { api, calls } = storage((call) => (call.url.endsWith("/v1/uploads")
            ? json(201, { ...MULTI, multipart: { part_size: 2, parts: [{ number: 1, size: 3, url: "https://evil.example/u/p1" }] } })
            : json(200, COMPLETE)));
        await expect(uploadMedia(api, KEY, prepared([7, 8, 9]), big)).rejects.toMatchObject({ code: "invalid_upload_url" });
        expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    });

    it("slices parts by their numbers whatever order the server lists them in; numbers must be 1..n (review)", async () => {
        const reversed = { ...MULTI, multipart: { part_size: 2, parts: [...MULTI.multipart.parts].reverse() } };
        const { api, calls } = storage((call) => (call.url.endsWith("/v1/uploads") ? json(201, reversed) : call.method === "PUT" ? json(200, { etag: call.url.slice(-4) }) : json(200, COMPLETE)));
        await uploadMedia(api, KEY, prepared([7, 8, 9]), big);
        const puts = calls.filter((c) => c.method === "PUT");
        expect(Object.fromEntries(puts.map((c) => [c.url.slice(-4), [...(c.init.body as Uint8Array)]]))).toEqual({ "p1.x": [7, 8], "p2.x": [9] });
        for (const parts of [[MULTI.multipart.parts[0]!, { ...MULTI.multipart.parts[1]!, number: 1 }], MULTI.multipart.parts.map((p) => ({ ...p, number: p.number + 1 }))]) {
            const bad = storage((call) => (call.url.endsWith("/v1/uploads") ? json(201, { ...MULTI, multipart: { part_size: 2, parts } }) : json(200, COMPLETE)));
            await expect(uploadMedia(bad.api, KEY, prepared([7, 8, 9]), big)).rejects.toMatchObject({ code: "invalid_response" });
            expect(bad.calls.filter((c) => c.method === "PUT")).toEqual([]);
        }
    });

    it("refuses parts that don't add up to the file", async () => {
        const { api, calls } = storage((call) => (call.url.endsWith("/v1/uploads")
            ? json(201, { ...MULTI, multipart: { part_size: 2, parts: [{ number: 1, size: 2, url: "https://upload.opennan.com/u/p1.x" }] } })
            : json(200, COMPLETE)));
        await expect(uploadMedia(api, KEY, prepared([7, 8, 9]), big)).rejects.toMatchObject({ code: "invalid_response" });
        expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    });
});
