// Main → renderer calls for the MCP session: the open project's controller lives in the renderer (one
// controller, one undo history for the person and for agents). The renderer is a separate trust domain, so
// every answer is checked against the method's expected shape before it reaches the MCP server.
export const SESSION_METHODS = [
    "execute", "snapshot", "describeTimeline", "uiState", "historyDepth", "listEffects", "saveToLibrary", "cancelAiRun",
    "cloud.list", "cloud.save", "cloud.open", "cloud.status", "cloud.quote", "cloud.run", "cloud.edit", "cloud.script",
    "cloud.shareCreate", "cloud.shareList", "cloud.shareRevoke", "confirmShare", "cancelConfirmShare",
] as const;
export type SessionMethod = (typeof SESSION_METHODS)[number];

export interface SessionRequest {
    id: number;
    method: SessionMethod;
    args: unknown[];
}

export type SessionResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const CLOUD_ID = /^cloud-[A-Za-z0-9_-]{1,36}$/;
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const cloudProject = (value: unknown) => isObject(value) && typeof value.id === "string" && CLOUD_ID.test(value.id) && text(value.name, 500) && text(value.aspectRatio, 20)
    && finite(value.durationSeconds) && finite(value.mediaBytes) && finite(value.updatedAt) && (value.lastEditedDevice === null || text(value.lastEditedDevice, 200))
    && (value.origin === "studio" || value.origin === "web") && (value.deletedAt === null || finite(value.deletedAt));
const opened = (value: unknown) => isObject(value) && typeof value.projectId === "string" && CLOUD_ID.test(value.projectId) && text(value.name, 500);
const usd = (value: unknown) => finite(value) && (value as number) >= 0;
const quote = (value: unknown) => isObject(value) && (
    (value.kind === "quote" && usd(value.priceUsd) && usd(value.holdUsd))
    || (value.kind === "refused" && text(value.code, 100) && text(value.message, 2000))
    || value.kind === "unavailable");
const taskError = (value: unknown) => value === null || (isObject(value) && text(value.message, 2000) && (value.code === null || text(value.code, 100)) && typeof value.refunded === "boolean");
const pipelineRun = (value: unknown) => isObject(value) && typeof value.taskId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.taskId)
    && (value.status === "succeeded" || value.status === "failed" || value.status === "cancelled") && (value.chargedUsd === null || usd(value.chargedUsd))
    && (value.projectRevision === null || count(value.projectRevision)) && typeof value.synced === "boolean" && typeof value.undoable === "boolean" && taskError(value.error);

/**
 * A share page as the renderer's own check builds it (9c.1: on share_base_url): https on opennan.com or one of its
 * subdomains, then /s/<token>; this machine's loopback (the e2e fake) only when the API itself is loopback.
 */
const SHARE_URL = /^https:\/\/(([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+)?opennan\.com\/s\/[A-Za-z0-9_-]{20,64}$/;
const LOOPBACK_SHARE_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/s\/[A-Za-z0-9_-]{20,64}$/;
/** The person's answer to an agent's public link (9c.1). */
const SHARE_ANSWERS = new Set(["allow", "allow-session", "deny", "timeout"]);
const stamp = (value: unknown) => value === null || finite(value);
/** A share link (phase 9c): the link only on a share page path, only while active. */
const shareLink = (value: unknown, loopback: boolean) => isObject(value) && typeof value.id === "string" && /^shr_[0-9a-f]{24}$/.test(value.id)
    && (value.status === "active" || value.status === "expired" || value.status === "revoked")
    && (value.url === null || (typeof value.url === "string" && (SHARE_URL.test(value.url) || (loopback && LOOPBACK_SHARE_URL.test(value.url))) && value.status === "active"))
    && typeof value.allowDownload === "boolean" && stamp(value.expiresAt) && stamp(value.createdAt) && stamp(value.revokedAt) && count(value.views) && stamp(value.lastViewedAt);
const shareList = (value: unknown, loopback: boolean) => Array.isArray(value) && value.length <= 20 && value.every((link) => shareLink(link, loopback));

export interface CheckOptions {
    /** The API is this machine's loopback (the e2e fake): share links there are accepted. */
    loopbackShares?: boolean;
}

/** Throws when a renderer answer does not have the method's shape. */
export function checkResult(method: SessionMethod, value: unknown, options: CheckOptions = {}): unknown {
    const loopback = options.loopbackShares === true;
    const ok = (() => {
        switch (method) {
            case "execute":
                return isObject(value) && typeof value.ok === "boolean" && isObject(value.changed);
            case "snapshot":
                return isObject(value) && typeof value.projectId === "string" && Array.isArray(value.tracks) && Array.isArray(value.clips) && Array.isArray(value.scenes);
            case "describeTimeline":
                return typeof value === "string" && value.length <= 1024 * 1024;
            case "uiState":
                return isObject(value) && typeof value.currentTime === "number" && isObject(value.selection);
            case "historyDepth":
                return isObject(value) && count(value.undo) && count(value.redo) && count(value.recorded) && count(value.limit);
            case "listEffects":
                return Array.isArray(value);
            case "saveToLibrary":
            case "cancelAiRun":
                return value === undefined || value === null;
            case "cloud.list":
                return isObject(value) && Array.isArray(value.projects) && value.projects.length <= 200 && value.projects.every(cloudProject)
                    && (value.nextCursor === null || text(value.nextCursor, 500));
            case "cloud.save":
            case "cloud.open":
                return opened(value);
            case "cloud.status":
                return value === null || (isObject(value) && typeof value.projectId === "string" && CLOUD_ID.test(value.projectId) && text(value.state, 40) && text(value.label, 200)
                    && count(value.pending) && Array.isArray(value.conflicts) && value.conflicts.length <= 500 && value.conflicts.every((c) => text(c, 2000)));
            case "cloud.quote":
                return quote(value);
            case "cloud.run":
                return pipelineRun(value);
            case "cloud.edit":
                return isObject(value) && typeof value.synced === "boolean";
            case "cloud.script":
                return value === undefined || value === null;
            case "cloud.shareCreate":
                return shareLink(value, loopback);
            case "cloud.shareList":
            case "cloud.shareRevoke":
                return shareList(value, loopback);
            case "confirmShare":
                return typeof value === "string" && SHARE_ANSWERS.has(value);
            case "cancelConfirmShare":
                return value === undefined || value === null;
        }
    })();
    if (!ok) throw new Error(`The editor answered ${method} with an unexpected value`);
    return value;
}

/** The editor did not answer a call within its deadline. */
export class RendererTimeoutError extends Error {
    constructor(readonly method: SessionMethod, limitMs: number) {
        super(`The editor did not answer ${method} in ${Math.round(limitMs / 1000)} s`);
        this.name = "RendererTimeoutError";
    }
}

export interface RendererRpc {
    /** `timeoutMs` overrides the default for one call (ai.run waits on a provider job). */
    call(method: SessionMethod, args?: unknown[], options?: { timeoutMs?: number }): Promise<unknown>;
    receive(response: SessionResponse): void;
    close(reason: string): void;
}

/**
 * Request ids for the whole app run: a new session never reuses one, so an old editor's late answer (a share question
 * still open when the project changed) can never settle a new session's call.
 */
let nextRequestId = 1;

export function createRendererRpc({ send, timeoutMs = 30_000, loopbackShares = false }: { send(request: SessionRequest): void; timeoutMs?: number; loopbackShares?: boolean }): RendererRpc {
    let closed: string | null = null;
    const pending = new Map<number, { method: SessionMethod; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    return {
        call(method, args = [], options = {}) {
            if (closed) return Promise.reject(new Error(closed));
            const id = nextRequestId++;
            const limit = options.timeoutMs ?? timeoutMs;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new RendererTimeoutError(method, limit));
                }, limit);
                pending.set(id, { method, resolve, reject, timer });
                try {
                    send({ id, method, args });
                } catch (error) {
                    clearTimeout(timer);
                    pending.delete(id);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        },
        receive(response) {
            const waiter = pending.get(response.id);
            if (!waiter) return;
            pending.delete(response.id);
            clearTimeout(waiter.timer);
            if (!response.ok) {
                waiter.reject(new Error(response.error));
                return;
            }
            try {
                waiter.resolve(checkResult(waiter.method, response.value, { loopbackShares }));
            } catch (error) {
                waiter.reject(error as Error);
            }
        },
        close(reason) {
            closed = reason;
            for (const waiter of pending.values()) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error(reason));
            }
            pending.clear();
        },
    };
}
