// What desktop main does for OpenNan cloud projects on the renderer's behalf (phase 9a), as plain rules with no
// dependencies (main, the IPC schemas, and the renderer share them). The renderer never holds the key: it asks main
// to call the API, and main sends only these requests (the sync engine's, the catalog's and, phase 9b, the AI
// director's: turns, quotes, project pipelines, tasks and the script, and agents' copy-video source and shot words; phase
// 9c: share links and proposal runs; nothing else), streams only a director turn, downloads
// only OpenNan's storage, and keeps cloud state under the app data folder in these namespaces and keys.

export const CLOUD_NAMESPACES = ["sync", "mirror", "uploads", "urls", "lists", "snapshots"] as const;
export type CloudNamespace = (typeof CLOUD_NAMESPACES)[number];
const STORE_KEY = /^[A-Za-z0-9:_-]{1,120}$/;
/** opennan.com project ids (also file-name safe). */
export const SERVER_PROJECT_ID = /^[A-Za-z0-9_-]{1,36}$/;
export const CLOUD_REQUEST_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type CloudRequestMethod = (typeof CLOUD_REQUEST_METHODS)[number];
export const CLOUD_REQUEST_HEADERS = ["Idempotency-Key", "If-Match", "If-None-Match"] as const;
export const MAX_CLOUD_HEADER_CHARS = 200;
export const MAX_CLOUD_BODY_BYTES = 2.5 * 1024 * 1024;
export const MAX_CLOUD_VALUE_BYTES = 64 * 1024 * 1024;
export const MAX_CLOUD_QUERY_KEYS = 16;
export const MAX_CLOUD_QUERY_CHARS = 512;
/** A streamed answer's id, chosen by the renderer (unique per window while it runs). */
export const CLOUD_STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Streams one window may run at once. */
export const MAX_CLOUD_STREAMS_PER_WINDOW = 4;
/** The largest file OpenNan stores (a 1 GiB video); a download may be the listed size + 1 MiB. */
export const MAX_CLOUD_MEDIA_BYTES = 1024 ** 3;
export const CLOUD_CDN_ORIGIN = "https://cdn.opennan.com";

const ID = "[A-Za-z0-9_-]{1,36}";
const SCENE = "[A-Za-z0-9_-]{1,64}";
const TURN = "turn_[0-9a-f]{24}";
const PROPOSAL = "prop_[0-9a-f]{24}";
const SHARE = "shr_[0-9a-f]{24}";
const TASK = "[A-Za-z0-9_-]{1,64}";
const SHOT = "\\d{1,3}";
/** The 9a sync and catalog routes' methods (PUT is only ever the copy-video source). */
const ANY_METHOD: readonly CloudRequestMethod[] = ["GET", "POST", "PATCH", "DELETE"];
const route = (pattern: string, methods: readonly CloudRequestMethod[]) => ({ pattern: new RegExp(`^${pattern}$`), methods });
/**
 * Every route main sends, with its methods. The 9a sync and catalog routes keep every method they always had; the
 * phase 9b AI director routes (turns, quotes, project pipelines, tasks, the script) take only the methods they use.
 */
const ROUTES = [
    route("/v1/projects", ANY_METHOD),
    route("/v1/projects/import", ANY_METHOD),
    route(`/v1/projects/${ID}`, ANY_METHOD),
    route(`/v1/projects/${ID}/(document|changes|restore)`, ANY_METHOD),
    route("/v1/storage", ANY_METHOD),
    route(`/v1/projects/${ID}/director/turns`, ["GET", "POST"]),
    route(`/v1/projects/${ID}/director/turns/${TURN}`, ["GET"]),
    route(`/v1/projects/${ID}/director/turns/${TURN}/cancel`, ["POST"]),
    // Phase 9c: a director proposal run by its id (the server runs the stored step at most at its quote).
    route(`/v1/projects/${ID}/director/turns/${TURN}/proposals/${PROPOSAL}/run`, ["POST"]),
    // Phase 9c: the project's view-only share links (create or rotate, list, stop sharing, turn one off).
    route(`/v1/projects/${ID}/shares`, ["GET", "POST", "DELETE"]),
    route(`/v1/projects/${ID}/shares/${SHARE}`, ["DELETE"]),
    route("/v1/quotes", ["POST"]),
    route(`/v1/projects/${ID}/story/plan`, ["POST"]),
    route(`/v1/projects/${ID}/scenes/${SCENE}/(storyboard|videos|copy-video/detections|copy-video/recreate)`, ["POST"]),
    route(`/v1/projects/${ID}/scenes/${SCENE}/shots/${SHOT}/image-edits`, ["POST"]),
    // Agents' no-charge copy-video edits (MCP project pipeline tools).
    route(`/v1/projects/${ID}/scenes/${SCENE}/copy-video/source`, ["PUT"]),
    route(`/v1/projects/${ID}/scenes/${SCENE}/shots/${SHOT}`, ["PATCH"]),
    route(`/v1/tasks/${TASK}`, ["GET"]),
    route(`/v1/tasks/${TASK}/cancel`, ["POST"]),
    route(`/v1/projects/${ID}/script`, ["GET"]),
];
/** The one route whose answer main streams to the renderer (the director's turn events, POST only). */
const STREAMABLE = new RegExp(`^/v1/projects/${ID}/director/turns$`);
const QUERY_KEY = /^[a-z_]{1,32}$/;
/** Query keys whose values are bounded integers (the turn list's page size, a task's long poll in seconds). */
const BOUNDED_QUERY: Record<string, [number, number]> = { limit: [1, 200], wait: [0, 50] };
const HEADER_VALUE = /^[\x20-\x7e]*$/;

export function isCloudStoreKey(key: unknown): key is string {
    return typeof key === "string" && STORE_KEY.test(key);
}

/**
 * A store key or cloud project id spelled for a file name, reversibly and case-safely: an upper-case letter becomes
 * "^" + the letter and ":" becomes "~", so names that differ only in case stay apart on macOS and Windows disks.
 */
export function caseSafeName(key: string): string {
    return key.replace(/[A-Z:]/g, (c) => (c === ":" ? "~" : `^${c.toLowerCase()}`));
}

export function isAllowedCloudPath(path: unknown): path is string {
    return typeof path === "string" && ROUTES.some((r) => r.pattern.test(path));
}

/** Whether main sends this method to this path. */
export function isAllowedCloudRoute(method: unknown, path: unknown): boolean {
    return typeof path === "string" && ROUTES.some((r) => r.pattern.test(path) && (r.methods as readonly unknown[]).includes(method));
}

/** Whether main may stream this path's answer to the renderer (with POST: a director turn). */
export function isStreamablePath(path: unknown): path is string {
    return typeof path === "string" && STREAMABLE.test(path);
}

/** The canonical name of an allowed request header (any case), or null. */
export function canonicalCloudHeader(name: string): (typeof CLOUD_REQUEST_HEADERS)[number] | null {
    return CLOUD_REQUEST_HEADERS.find((allowed) => allowed.toLowerCase() === name.toLowerCase()) ?? null;
}

/** JSON size in UTF-16 code units (cheap, works in every process). */
export function jsonLength(value: unknown): number {
    try {
        return (JSON.stringify(value) ?? "").length;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

export interface CloudRequestInput {
    body?: unknown;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
}

/** Why main will not send this request, or null when it may. */
export function checkCloudRequest(method: unknown, path: unknown, request: CloudRequestInput = {}): string | null {
    if (!(CLOUD_REQUEST_METHODS as readonly unknown[]).includes(method)) return "method";
    if (!isAllowedCloudPath(path)) return "path";
    if (!isAllowedCloudRoute(method, path)) return "method";
    const query = request.query ?? {};
    if (typeof query !== "object" || query === null || Array.isArray(query)) return "query";
    const entries = Object.entries(query);
    if (entries.length > MAX_CLOUD_QUERY_KEYS) return "query";
    for (const [key, value] of entries) {
        if (!QUERY_KEY.test(key)) return "query";
        const bounds = BOUNDED_QUERY[key];
        if (bounds && !(typeof value === "number" && Number.isInteger(value) && value >= bounds[0] && value <= bounds[1])) return "query";
        const ok = (typeof value === "string" && value.length <= MAX_CLOUD_QUERY_CHARS) || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
        if (!ok) return "query";
    }
    const headers = request.headers ?? {};
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return "headers";
    for (const [name, value] of Object.entries(headers)) {
        if (!canonicalCloudHeader(name)) return "headers";
        if (typeof value !== "string" || value.length > MAX_CLOUD_HEADER_CHARS || !HEADER_VALUE.test(value)) return "headers";
    }
    if (request.body !== undefined && jsonLength(request.body) > MAX_CLOUD_BODY_BYTES) return "body";
    return null;
}

export type CloudStreamInput = Omit<CloudRequestInput, "query">;

/** Why main will not stream this request, or null when it may: a director turn POST (body and headers, no query). */
export function checkCloudStream(method: unknown, path: unknown, request: CloudStreamInput = {}): string | null {
    if (method !== "POST") return "method";
    if (!isStreamablePath(path)) return "path";
    if ((request as CloudRequestInput).query !== undefined) return "query";
    return checkCloudRequest(method, path, request);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isTempUpload(url: URL): boolean {
    let decoded = url.pathname;
    try {
        decoded = decodeURIComponent(url.pathname);
    } catch {
        return true;
    }
    return url.pathname.includes("/uploads/temp/") || decoded.includes("/uploads/temp/");
}

/**
 * Whether a URL is a file on OpenNan's storage that cloud projects may use (never a temporary upload): the CDN, plus
 * the fake server's /files/ when the API base is loopback (tests and e2e). `fake` is that API base, or "loopback"
 * for any loopback origin (the e2e renderer, which does not know the fake's port; main checks the exact one).
 */
export function cloudStorageUrlRule(fake: string | "loopback" | null): (url: string) => boolean {
    let fakeOrigin: string | null = null;
    if (fake && fake !== "loopback") {
        try {
            const base = new URL(fake);
            if (base.protocol === "http:" && LOOPBACK.has(base.hostname)) fakeOrigin = base.origin;
        } catch {
            fakeOrigin = null;
        }
    }
    return (value) => {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            return false;
        }
        if (url.username || url.password || isTempUpload(url)) return false;
        if (url.origin === CLOUD_CDN_ORIGIN) return true;
        if (!url.pathname.startsWith("/files/")) return false;
        if (fakeOrigin) return url.origin === fakeOrigin;
        return fake === "loopback" && url.protocol === "http:" && LOOPBACK.has(url.hostname);
    };
}
