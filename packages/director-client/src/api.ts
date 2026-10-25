// The opennan.com public API client for the project pipeline routes (moved here from the removed cloud-backend
// package): JSON in and out, the ETag of every answer, 304 passed through, and the error envelope
// {"error": {type, message, code, details}} as ProjectApiError. The key is read from the host on every call and goes
// only to the API's own origin as a bearer; nothing here stores or logs it.
export type ProjectApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ProjectApiRequest {
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined | null>;
    /** Idempotency-Key, If-Match, If-None-Match. Never replaces the key or the JSON content type. */
    headers?: Record<string, string>;
    signal?: AbortSignal;
}

export interface ProjectApiResponse<T> {
    status: number;
    body: T;
    etag: string | null;
}

export interface ProjectApi {
    readonly baseUrl: string;
    request<T = unknown>(method: ProjectApiMethod, path: string, request?: ProjectApiRequest): Promise<ProjectApiResponse<T>>;
}

export interface ProjectApiErrorInit {
    type?: string;
    details?: Record<string, unknown>;
    retryAfterSeconds?: number;
    fromServer?: boolean;
    cause?: unknown;
}

/** A refused or failed call. status 0 = the network; code is the server's (never null) or one Studio made up. */
export class ProjectApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly type?: string;
    readonly details?: Record<string, unknown>;
    readonly retryAfterSeconds?: number;
    readonly fromServer: boolean;

    constructor(status: number, code: string, message: string, init: ProjectApiErrorInit = {}) {
        super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
        this.name = "ProjectApiError";
        this.status = status;
        this.code = code;
        if (init.type !== undefined) this.type = init.type;
        if (init.details !== undefined) this.details = init.details;
        if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
        this.fromServer = init.fromServer ?? false;
    }

    /** A plain object for IPC (desktop main → renderer). */
    toJSON(): { status: number; code: string; message: string; type?: string; details?: Record<string, unknown>; retryAfterSeconds?: number; fromServer: boolean } {
        return {
            status: this.status, code: this.code, message: this.message, fromServer: this.fromServer,
            ...(this.type !== undefined ? { type: this.type } : {}), ...(this.details !== undefined ? { details: this.details } : {}),
            ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
        };
    }

    static fromJSON(value: { status: number; code: string; message: string; type?: string; details?: Record<string, unknown>; retryAfterSeconds?: number; fromServer?: boolean }): ProjectApiError {
        return new ProjectApiError(value.status, value.code, value.message, {
            ...(value.type !== undefined ? { type: value.type } : {}), ...(value.details !== undefined ? { details: value.details } : {}),
            ...(value.retryAfterSeconds !== undefined ? { retryAfterSeconds: value.retryAfterSeconds } : {}), fromServer: value.fromServer ?? false,
        });
    }
}

export function isProjectApiError(error: unknown): error is ProjectApiError {
    return error instanceof ProjectApiError || (typeof error === "object" && error !== null && (error as { name?: string }).name === "ProjectApiError");
}

export function isAbortError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https, or plain http to this machine's loopback (tests, the fake server); never credentials in the URL. */
export function isAllowedProjectApiBase(value: string): boolean {
    try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        if (url.protocol === "https:") return true;
        return url.protocol === "http:" && LOOPBACK.has(url.hostname);
    } catch {
        return false;
    }
}

export function retryAfterSeconds(header: string | null, now: number): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined;
}

const DEFAULT_CODES: Array<[(status: number) => boolean, string]> = [
    [(s) => s === 401, "unauthorized"], [(s) => s === 402, "insufficient_balance"], [(s) => s === 403, "forbidden"],
    [(s) => s === 404, "not_found"], [(s) => s === 409, "conflict"], [(s) => s === 410, "gone"], [(s) => s === 412, "timeline_changed"],
    [(s) => s === 413, "request_too_large"], [(s) => s === 429, "rate_limited"], [(s) => s >= 500, "server_error"],
];

export interface ProjectApiOptions {
    baseUrl: string;
    /** The signed-in key, read on every call; null = signed out (the call fails with 401 signed_out, nothing is sent). */
    apiKey(): string | null;
    fetch?: typeof globalThis.fetch;
    now?(): number;
}

export function createProjectApi(options: ProjectApiOptions): ProjectApi {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!isAllowedProjectApiBase(baseUrl)) throw new Error(`The OpenNan API address must use https (or http on this machine's loopback): ${baseUrl}`);
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const now = options.now ?? Date.now;
    /** Sends one call; a refusal or a network failure throws ProjectApiError, an abort stays an abort. */
    async function send(method: ProjectApiMethod, path: string, request: ProjectApiRequest, accept: string): Promise<Response> {
        if (!path.startsWith("/")) throw new Error("An API path starts with /");
        const key = options.apiKey();
        if (!key) throw new ProjectApiError(401, "signed_out", "Sign in with OpenNan first.");
        const url = new URL(baseUrl + path);
        for (const [name, value] of Object.entries(request.query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers ?? {})) {
            const lower = name.toLowerCase();
            if (lower === "authorization" || lower === "content-type" || lower === "cookie") continue;
            headers.set(name, value);
        }
        headers.set("accept", accept);
        headers.set("authorization", `Bearer ${key}`);
        let body: string | undefined;
        if (request.body !== undefined) {
            headers.set("content-type", "application/json");
            body = JSON.stringify(request.body);
        }
        let response: Response;
        try {
            response = await doFetch(url.href, { method, headers, body, signal: request.signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
        } catch (error) {
            if (isAbortError(error) || request.signal?.aborted) throw error;
            throw new ProjectApiError(0, "network", "Can't reach OpenNan.", { cause: error });
        }
        if (response.ok || response.status === 304) return response;
        const text = await response.text().catch(() => "");
        let envelope: { error?: { message?: unknown; code?: unknown; type?: unknown; details?: unknown } } | null = null;
        try {
            envelope = JSON.parse(text);
        } catch {
            envelope = null;
        }
        const serverMessage = typeof envelope?.error?.message === "string" ? envelope.error.message : null;
        let code = typeof envelope?.error?.code === "string" ? envelope.error.code : null;
        code ??= DEFAULT_CODES.find(([match]) => match(response.status))?.[1] ?? "http_error";
        const details = envelope?.error?.details;
        const type = typeof envelope?.error?.type === "string" ? envelope.error.type : undefined;
        const retry = retryAfterSeconds(response.headers.get("retry-after"), now());
        throw new ProjectApiError(response.status, code, serverMessage ?? `OpenNan answered ${response.status}.`, {
            fromServer: serverMessage !== null,
            ...(type ? { type } : {}),
            ...(details && typeof details === "object" && !Array.isArray(details) ? { details: details as Record<string, unknown> } : {}),
            ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
        });
    }

    return {
        baseUrl,
        async request<T>(method: ProjectApiMethod, path: string, request: ProjectApiRequest = {}): Promise<ProjectApiResponse<T>> {
            const response = await send(method, path, request, "application/json");
            const etag = response.headers.get("etag");
            if (response.status === 304) return { status: 304, body: null as T, etag };
            const text = await response.text().catch(() => "");
            if (!text) return { status: response.status, body: {} as T, etag };
            try {
                return { status: response.status, body: JSON.parse(text) as T, etag };
            } catch (error) {
                throw new ProjectApiError(response.status, "invalid_response", "OpenNan sent an answer Studio cannot read.", { cause: error });
            }
        },
    };
}
