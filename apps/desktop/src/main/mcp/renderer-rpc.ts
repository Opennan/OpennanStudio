// Main → renderer calls for the MCP session: the open project's controller lives in the renderer (one
// controller, one undo history for the person and for agents). The renderer is a separate trust domain, so
// every answer is checked against the method's expected shape before it reaches the MCP server.
export const SESSION_METHODS = [
    "execute", "snapshot", "describeTimeline", "uiState", "historyDepth", "listEffects", "saveToLibrary", "cancelAiRun",
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

/** Throws when a renderer answer does not have the method's shape. */
export function checkResult(method: SessionMethod, value: unknown): unknown {
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
 * Request ids for the whole app run: a new session never reuses one, so an old editor's late answer can never settle
 * a new session's call.
 */
let nextRequestId = 1;

export function createRendererRpc({ send, timeoutMs = 30_000 }: { send(request: SessionRequest): void; timeoutMs?: number }): RendererRpc {
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
                waiter.resolve(checkResult(waiter.method, response.value));
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
