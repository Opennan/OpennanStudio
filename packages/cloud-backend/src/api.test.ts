import { CloudApiError, createCloudApi, isAllowedCloudBase } from "./api";

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

describe("createCloudApi", () => {
    it("accepts https and loopback http bases only", () => {
        expect(isAllowedCloudBase("https://api.opennan.com")).toBe(true);
        expect(isAllowedCloudBase("http://127.0.0.1:4320")).toBe(true);
        expect(isAllowedCloudBase("http://api.opennan.com")).toBe(false);
        expect(isAllowedCloudBase("https://user:pw@api.opennan.com")).toBe(false);
        expect(() => createCloudApi({ baseUrl: "http://evil.test", apiKey: () => "sk-x" })).toThrow();
    });

    it("sends the key as a bearer to its own origin only, JSON in and out, no redirects or cookies", async () => {
        const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { etag: '"r3"', "content-type": "application/json" } }));
        const api = createCloudApi({ baseUrl: "https://api.opennan.com/", apiKey: () => "sk-test", fetch });
        const answer = await api.request("POST", "/v1/projects/p1/changes", { body: { a: 1 }, headers: { "Idempotency-Key": "k1", "If-Match": '"r2"', authorization: "Bearer other" }, query: { x: 1, y: undefined } });
        expect(answer).toEqual({ status: 200, body: { ok: 1 }, etag: '"r3"' });
        const { url, init } = calls[0]!;
        expect(url).toBe("https://api.opennan.com/v1/projects/p1/changes?x=1");
        const headers = new Headers(init.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-test");
        expect(headers.get("idempotency-key")).toBe("k1");
        expect(headers.get("if-match")).toBe('"r2"');
        expect(headers.get("content-type")).toBe("application/json");
        expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", body: JSON.stringify({ a: 1 }) });
    });

    it("passes a 304 through with its ETag and no body", async () => {
        const { fetch } = fakeFetch(() => new Response(null, { status: 304, headers: { etag: '"r9"' } }));
        const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
        expect(await api.request("GET", "/v1/projects/p1/document", { headers: { "If-None-Match": '"r9"' } })).toEqual({ status: 304, body: null, etag: '"r9"' });
    });

    it("turns the error envelope into CloudApiError with code, details, and Retry-After", async () => {
        const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: { type: "conflict", message: "locked", code: "clip_locked", details: { kind: "clip", ids: ["c1"] } } }), { status: 409, headers: { "retry-after": "7" } }));
        const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
        const error = await api.request("POST", "/v1/x").catch((e) => e);
        expect(error).toBeInstanceOf(CloudApiError);
        expect(error).toMatchObject({ status: 409, code: "clip_locked", type: "conflict", details: { kind: "clip", ids: ["c1"] }, retryAfterSeconds: 7, fromServer: true });
    });

    it("reports a network failure as status 0, and signed out without calling", async () => {
        const { fetch, calls } = fakeFetch(() => {
            throw new TypeError("Failed to fetch");
        });
        const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
        await expect(api.request("GET", "/v1/storage")).rejects.toMatchObject({ status: 0, code: "network" });
        const signedOut = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => null, fetch });
        await expect(signedOut.request("GET", "/v1/storage")).rejects.toMatchObject({ status: 401, code: "signed_out" });
        expect(calls).toHaveLength(1);
    });

    it("keeps an abort an abort", async () => {
        const controller = new AbortController();
        const { fetch } = fakeFetch(() => {
            controller.abort();
            throw new DOMException("aborted", "AbortError");
        });
        const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
        await expect(api.request("GET", "/v1/storage", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    });

    it("synthesizes a code when an older server sends none", async () => {
        const { fetch } = fakeFetch(() => new Response("oops", { status: 503 }));
        const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
        await expect(api.request("GET", "/v1/storage")).rejects.toMatchObject({ status: 503, code: "server_error", fromServer: false });
    });

    describe("stream", () => {
        it("answers the body stream of a 2xx with the same headers and guards as request", async () => {
            const { fetch, calls } = fakeFetch(() => new Response("event: a\ndata: 1\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
            const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
            const answer = await api.stream!("POST", "/v1/projects/p1/director/turns", { body: { message: "hi" }, headers: { "Idempotency-Key": "k1" } });
            expect(answer.status).toBe(200);
            expect(await new Response(answer.body).text()).toBe("event: a\ndata: 1\n\n");
            const headers = new Headers(calls[0]!.init.headers);
            expect(headers.get("accept")).toBe("text/event-stream");
            expect(headers.get("authorization")).toBe("Bearer sk-test");
            expect(headers.get("idempotency-key")).toBe("k1");
            expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", body: JSON.stringify({ message: "hi" }) });
        });

        it("throws the error envelope of a refusal as CloudApiError", async () => {
            const { fetch } = fakeFetch(() => new Response(JSON.stringify({ error: { type: "conflict", message: "busy", code: "turn_in_progress", details: { turn_id: "turn_1" } } }), { status: 409 }));
            const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
            await expect(api.stream!("POST", "/v1/projects/p1/director/turns", { body: {} })).rejects.toMatchObject({ status: 409, code: "turn_in_progress", details: { turn_id: "turn_1" } });
        });

        it("reports a network failure as status 0 and signed out without calling", async () => {
            const { fetch, calls } = fakeFetch(() => {
                throw new TypeError("Failed to fetch");
            });
            const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
            await expect(api.stream!("POST", "/v1/x", { body: {} })).rejects.toMatchObject({ status: 0, code: "network" });
            const signedOut = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => null, fetch });
            await expect(signedOut.stream!("POST", "/v1/x", { body: {} })).rejects.toMatchObject({ status: 401, code: "signed_out" });
            expect(calls).toHaveLength(1);
        });

        it("refuses a 2xx without a body", async () => {
            const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
            const api = createCloudApi({ baseUrl: "https://api.opennan.com", apiKey: () => "sk-test", fetch });
            await expect(api.stream!("POST", "/v1/x", { body: {} })).rejects.toMatchObject({ code: "invalid_response" });
        });
    });
});
