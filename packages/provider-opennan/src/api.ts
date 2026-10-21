// The opennan.com public API client: one fetch wrapper. JSON bodies in and out; the error envelope
// {"error":{"type","message","code","details"?}} becomes OpenNanApiError with the server's code, type and details (402
// insufficient_balance: InsufficientCreditsError); its message is shown only through errors.ts's copy table.
// The key goes only to the API's own origin, as a bearer token; nothing here logs.
import { InsufficientCreditsError, OpenNanApiError } from "./errors";

export const DEFAULT_API_BASE = "https://api.opennan.com";
export const DEFAULT_CONSOLE_BASE = "https://opennan.com";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
    apiKey?: string | null;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    signal?: AbortSignal;
    /** Extra headers (Idempotency-Key). They never replace the key, accept, or the JSON content type. */
    headers?: Record<string, string>;
}

export interface OpenNanApi {
    readonly baseUrl: string;
    /** The fetch the client uses, for requests that must never carry the key (the PUT of an upload to storage). */
    readonly fetch: typeof globalThis.fetch;
    request<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
    requestBytes(method: HttpMethod, path: string, options?: RequestOptions): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface OpenNanApiOptions {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    now?(): number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https, or plain http to this machine's loopback (tests, the fake server); never credentials in the URL. */
export function isAllowedApiBase(value: string): boolean {
    try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        if (url.protocol === "https:") return true;
        return url.protocol === "http:" && LOOPBACK.has(url.hostname);
    } catch {
        return false;
    }
}

function retryAfter(header: string | null, now: number): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined;
}

function isAbort(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

export function createOpenNanApi(options: OpenNanApiOptions = {}): OpenNanApi {
    const baseUrl = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    if (!isAllowedApiBase(baseUrl)) throw new Error(`The OpenNan API address must use https (or http on this machine's loopback): ${baseUrl}`);
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const now = options.now ?? Date.now;

    async function send(method: HttpMethod, path: string, request: RequestOptions): Promise<Response> {
        const url = new URL(baseUrl + path);
        for (const [name, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
        const headers = new Headers(request.headers ?? {});
        headers.set("accept", "application/json");
        headers.delete("authorization");
        headers.delete("content-type");
        if (request.apiKey) headers.set("authorization", `Bearer ${request.apiKey}`);
        let body: string | undefined;
        if (request.body !== undefined) {
            headers.set("content-type", "application/json");
            body = JSON.stringify(request.body);
        }
        let response: Response;
        try {
            response = await doFetch(url.href, { method, headers, body, signal: request.signal, credentials: "omit", redirect: "error" });
        } catch (error) {
            if (isAbort(error) || request.signal?.aborted) throw error;
            throw new OpenNanApiError(0, "network", "Can't reach OpenNan.", { cause: error });
        }
        if (response.ok) return response;
        const text = await response.text().catch(() => "");
        let envelope: { error?: { message?: unknown; code?: unknown; type?: unknown; details?: unknown } } | null = null;
        try {
            envelope = JSON.parse(text);
        } catch {
            envelope = null;
        }
        const serverMessage = typeof envelope?.error?.message === "string" ? envelope.error.message : null;
        const message = serverMessage ?? `OpenNan answered ${response.status}.`;
        const type = typeof envelope?.error?.type === "string" ? envelope.error.type : undefined;
        const rawDetails = envelope?.error?.details;
        const details = typeof rawDetails === "object" && rawDetails !== null && !Array.isArray(rawDetails) ? (rawDetails as Record<string, unknown>) : undefined;
        let code = typeof envelope?.error?.code === "string" ? envelope.error.code : null;
        if (!code) {
            if (response.status === 401) code = "unauthorized";
            else if (response.status === 402) code = "insufficient_balance";
            else if (response.status === 403) code = "forbidden";
            else if (response.status === 404) code = "not_found";
            else if (response.status === 409) code = "conflict";
            else if (response.status === 429) code = "rate_limited";
            else if (response.status >= 500) code = "server_error";
            else code = "http_error";
        }
        if (response.status === 402 && code === "insufficient_balance") throw new InsufficientCreditsError(message);
        // The server's code (never null since its phase 11.1 contract); synthesized above only for an older server.
        throw new OpenNanApiError(response.status, code, message, {
            retryAfterSeconds: retryAfter(response.headers.get("retry-after"), now()), fromServer: serverMessage !== null, ...(type ? { type } : {}), ...(details ? { details } : {}),
        });
    }

    return {
        baseUrl,
        fetch: doFetch as typeof globalThis.fetch,
        async request<T>(method: HttpMethod, path: string, request: RequestOptions = {}): Promise<T> {
            const response = await send(method, path, request);
            const text = await response.text();
            if (!text) return {} as T;
            try {
                return JSON.parse(text) as T;
            } catch (error) {
                throw new OpenNanApiError(response.status, "invalid_response", "OpenNan sent an answer Studio cannot read.", { cause: error });
            }
        },
        async requestBytes(method, path, request = {}) {
            const response = await send(method, path, request);
            return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream" };
        },
    };
}
