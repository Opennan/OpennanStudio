import { createOpenNanApi, isAllowedApiBase } from "./api";
import { InsufficientCreditsError, OpenNanApiError } from "./errors";

const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        return answer(url, init);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("createOpenNanApi", () => {
    it("sends the key as a bearer token to the API origin and parses JSON", async () => {
        const { fetch, calls } = fakeFetch(() => json(200, { object: "account", email: "ada@example.com" }));
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com/", fetch });
        expect(api.baseUrl).toBe("https://api.opennan.com");
        const account = await api.request<{ email: string }>("GET", "/v1/account", { apiKey: KEY });
        expect(account.email).toBe("ada@example.com");
        expect(calls[0]!.url).toBe("https://api.opennan.com/v1/account");
        expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    });

    it("posts JSON bodies and adds query parameters", async () => {
        const { fetch, calls } = fakeFetch(() => json(200, {}));
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
        await api.request("POST", "/v1/auth/device", { body: { device_name: "Mac" } });
        await api.request("GET", "/v1/tasks/t1", { query: { wait: 50, skip: undefined } });
        expect(calls[0]!.init.body).toBe('{"device_name":"Mac"}');
        expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
        expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
        expect(calls[1]!.url).toBe("https://api.opennan.com/v1/tasks/t1?wait=50");
    });

    it("maps the error envelope to OpenNanApiError with its code", async () => {
        const { fetch } = fakeFetch(() => json(400, { error: { type: "invalid_request_error", message: "Waiting", code: "authorization_pending" } }));
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
        const error = await api.request("POST", "/v1/auth/device/token").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanApiError);
        expect(error).toMatchObject({ status: 400, code: "authorization_pending", message: "Waiting" });
    });

    it("keeps the envelope's details (a refusal's {kind, ids} or {path}) on the error, with the message unchanged", async () => {
        const { fetch } = fakeFetch(() => json(404, { error: { type: "not_found", message: "Some clips are gone.", code: "entity_missing", details: { kind: "clip", ids: ["a", "b"] } } }));
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
        const error = await api.request("POST", "/v1/projects/p/changes").catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 404, code: "entity_missing", message: "Some clips are gone.", details: { kind: "clip", ids: ["a", "b"] } });
        const { fetch: plain } = fakeFetch(() => json(400, { error: { type: "invalid_request_error", message: "x", code: "invalid_request", details: ["not", "an", "object"] } }));
        const bare = await createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch: plain }).request("GET", "/v1/x").catch((e: unknown) => e);
        expect((bare as { details?: unknown }).details).toBeUndefined();
    });

    it("turns 402 insufficient_balance into InsufficientCreditsError", async () => {
        const { fetch } = fakeFetch(() => json(402, { error: { type: "billing_error", message: "Balance too low", code: "insufficient_balance" } }));
        const error = await createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }).request("POST", "/v1/images/generations", { apiKey: KEY }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(InsufficientCreditsError);
        expect(error).toBeInstanceOf(OpenNanApiError);
        expect(error).toMatchObject({ status: 402, code: "insufficient_balance", message: "Balance too low" });
    });

    it("reads Retry-After as seconds or an HTTP date", async () => {
        const now = Date.parse("2026-10-19T12:00:00Z");
        const answers = [
            json(429, { error: { type: "rate_limit_error", message: "Slow", code: "rate_limit_exceeded" } }, { "retry-after": "7" }),
            json(429, { error: { type: "rate_limit_error", message: "Slow", code: null } }, { "retry-after": "Mon, 19 Oct 2026 12:00:30 GMT" }),
        ];
        const { fetch } = fakeFetch(() => answers.shift()!);
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch, now: () => now });
        await expect(api.request("POST", "/v1/auth/device")).rejects.toMatchObject({ status: 429, code: "rate_limit_exceeded", retryAfterSeconds: 7 });
        await expect(api.request("POST", "/v1/auth/device")).rejects.toMatchObject({ status: 429, code: "rate_limited", retryAfterSeconds: 30 });
    });

    it("names non-JSON and network failures", async () => {
        const { fetch } = fakeFetch((url) => {
            if (url.endsWith("/down")) throw new TypeError("Failed to fetch");
            return new Response("<html>bad gateway</html>", { status: 502 });
        });
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
        await expect(api.request("GET", "/v1/x")).rejects.toMatchObject({ status: 502, code: "server_error" });
        await expect(api.request("GET", "/down")).rejects.toMatchObject({ status: 0, code: "network" });
    });

    it("lets an abort through as an AbortError", async () => {
        const { fetch } = fakeFetch((_url, init) => new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }));
        const abort = new AbortController();
        const pending = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }).request("GET", "/v1/x", { signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });

    it("returns bytes and their type for binary answers", async () => {
        const { fetch } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
        const answer = await createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }).requestBytes("POST", "/v1/audio/speech", { apiKey: KEY, body: { input: "hi" } });
        expect([...answer.bytes]).toEqual([1, 2, 3]);
        expect(answer.mimeType).toBe("audio/mpeg");
    });

    it("never repeats a key in an error message", async () => {
        const { fetch } = fakeFetch(() => json(401, { error: { type: "authentication_error", message: `Invalid key ${KEY}`, code: "invalid_api_key" } }));
        const error = (await createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }).request("GET", "/v1/account", { apiKey: KEY }).catch((e: Error) => e)) as Error;
        expect(String(error.message)).not.toContain(KEY);
        expect(error).toMatchObject({ status: 401, code: "invalid_api_key" });
    });

    it("accepts https bases and plain http only on loopback", () => {
        expect(isAllowedApiBase("https://api.opennan.com")).toBe(true);
        expect(isAllowedApiBase("http://127.0.0.1:4320")).toBe(true);
        expect(isAllowedApiBase("http://localhost:4320")).toBe(true);
        expect(isAllowedApiBase("http://api.opennan.com")).toBe(false);
        expect(isAllowedApiBase("https://user:pw@api.opennan.com")).toBe(false);
        expect(isAllowedApiBase("ftp://x")).toBe(false);
        expect(() => createOpenNanApi({ baseUrl: "http://evil.example" })).toThrow(/https/);
    });
});

describe("createOpenNanApi phase 11", () => {
    it("sends extra headers (Idempotency-Key) but never lets them replace the key or the content type", async () => {
        const { fetch, calls } = fakeFetch(() => json(202, {}));
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
        await api.request("POST", "/v1/audio/isolations", { apiKey: KEY, body: {}, headers: { "Idempotency-Key": "run-1", authorization: "Bearer other", "content-type": "text/plain" } });
        const headers = new Headers(calls[0]!.init.headers);
        expect(headers.get("idempotency-key")).toBe("run-1");
        expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
        expect(headers.get("content-type")).toBe("application/json");
    });

    it("names a 409 without a code conflict and exposes its fetch for storage uploads", async () => {
        const { fetch } = fakeFetch(() => json(409, { error: { type: "conflict", message: "busy", code: null } }));
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
        await expect(api.request("POST", "/v1/tasks/t/cancel")).rejects.toMatchObject({ status: 409, code: "conflict", message: "busy" });
        expect(typeof api.fetch).toBe("function");
    });
});

describe("createOpenNanApi phase 11.1 codes", () => {
    it("keeps the server's code and type, marks its text as the server's, and reads Retry-After on a busy 409", async () => {
        const { fetch } = fakeFetch(() => json(409, { error: { type: "conflict", message: "This task is busy and could not be cancelled right now. Try again.", code: "task_busy_retry" } }, { "retry-after": "1" }));
        const error = await createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }).request("POST", "/v1/tasks/t/cancel", { apiKey: KEY }).catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 409, code: "task_busy_retry", type: "conflict", fromServer: true, retryAfterSeconds: 1 });
    });

    it("an answer without an envelope is Studio's own words", async () => {
        const { fetch } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
        const error = await createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }).request("GET", "/v1/tools").catch((e: unknown) => e);
        expect(error).toMatchObject({ status: 502, code: "server_error", fromServer: false, message: "OpenNan answered 502." });
    });
});
