// Project pipeline tasks (story plan, storyboard, scene video, copy-video steps) over the cloud projects API client,
// the same way on web and desktop: one POST with a fresh Idempotency-Key (never retried: the server may already hold
// the task), then long polls of GET /v1/tasks/{id}?wait=50 at least a second apart until the task finishes, with
// backoff on network and server errors. Cancel follows phase 11.1's codes: 200 = cancelled (refunded);
// task_busy_retry is asked again after Retry-After (three times); task_not_cancellable keeps the task running ("it
// will finish and be charged"); task_already_finished reads the task and ends in its real state. A succeeded task
// reports the project revision its result landed in (`project_revision`), so the editor pulls until it has it.
import { isCloudApiError, type CloudApi } from "@opennan/cloud-backend";
import type { CheckedRequest } from "./director-pipelines";
import { isRecord } from "./director-types";

export type ProjectTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProjectTaskState {
    id: string;
    status: ProjectTaskStatus;
    /** 0..1 when the server reports progress. */
    progress?: number;
    stage?: string;
    /** What the run settled at (succeeded) or holds (running). */
    priceUsd?: number;
    projectRevision?: number;
    error?: { message: string; code?: string; refunded: boolean };
}

export type ProjectTaskOutcome = ProjectTaskState & { status: "succeeded" | "failed" | "cancelled" };

export type CancelAnswer = { accepted: true } | { accepted: false; message: string };

export interface ProjectTaskHandle {
    /** The task id once the server created it (rejects when the POST was refused). */
    readonly id: Promise<string>;
    /** The final state; rejects with the CloudApiError when the POST itself was refused (402, 409 busy, …). */
    readonly done: Promise<ProjectTaskOutcome>;
    cancel(): Promise<CancelAnswer>;
    /** Stops following the task (it keeps running on the server). */
    detach(): void;
}

export interface ProjectTasks {
    start(request: CheckedRequest, options?: { onUpdate?(state: ProjectTaskState): void; idempotencyKey?: string }): ProjectTaskHandle;
    /** Follows a task some other surface started (the director inside a budget). */
    follow(taskId: string, options?: { onUpdate?(state: ProjectTaskState): void }): ProjectTaskHandle;
}

export interface ProjectTasksOptions {
    sleep?(ms: number, signal: AbortSignal): Promise<void>;
    now?(): number;
    waitSeconds?: number;
}

export const TASK_WAIT_SECONDS = 50;
export const MIN_POLL_MS = 1_000;
export const MAX_POLL_BACKOFF_MS = 30_000;
export const TASK_DEADLINE_MS = 60 * 60_000;
export const CANCEL_RETRIES = 3;
export const CANCEL_TOO_LATE = "Already running: it will finish and be charged.";
export const CANCEL_UNKNOWN = "Couldn't reach OpenNan to stop it: it may still finish and be charged.";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(stopped());
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(stopped());
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function stopped(): Error {
    const error = new Error("Stopped following the task.");
    error.name = "AbortError";
    return error;
}

const STATUSES: readonly ProjectTaskStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];

export function parseTaskState(value: unknown): ProjectTaskState | null {
    if (!isRecord(value) || typeof value.id !== "string" || !TASK_ID.test(value.id)) return null;
    // The server shows "settling" as running.
    const status = STATUSES.includes(value.status as ProjectTaskStatus) ? (value.status as ProjectTaskStatus) : "running";
    const state: ProjectTaskState = { id: value.id, status };
    // The server reports 0–100.
    if (typeof value.progress === "number" && Number.isFinite(value.progress)) state.progress = Math.max(0, Math.min(1, value.progress / 100));
    if (typeof value.stage === "string" && value.stage) state.stage = value.stage;
    if (typeof value.price_usd === "number" && Number.isFinite(value.price_usd)) state.priceUsd = value.price_usd;
    if (typeof value.project_revision === "number" && Number.isInteger(value.project_revision)) state.projectRevision = value.project_revision;
    if (status === "failed" || status === "cancelled") {
        const error = isRecord(value.error) ? value.error : {};
        state.error = {
            message: typeof error.message === "string" ? error.message : "",
            ...(typeof error.code === "string" ? { code: error.code } : {}),
            refunded: error.refunded === true || status === "cancelled",
        };
    }
    return state;
}

const terminal = (status: ProjectTaskStatus) => status === "succeeded" || status === "failed" || status === "cancelled";

export function createProjectTasks(api: CloudApi, options: ProjectTasksOptions = {}): ProjectTasks {
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const wait = options.waitSeconds ?? TASK_WAIT_SECONDS;

    function track(begin: (signal: AbortSignal) => Promise<ProjectTaskState>, onUpdate?: (state: ProjectTaskState) => void): ProjectTaskHandle {
        const controller = new AbortController();
        let resolveId!: (id: string) => void;
        let rejectId!: (error: unknown) => void;
        const id = new Promise<string>((resolve, reject) => {
            resolveId = resolve;
            rejectId = reject;
        });
        id.catch(() => undefined);
        /** A body a cancel or a finished read handed over: the poll loop ends with it. */
        let pushed: ProjectTaskState | null = null;
        let wake: (() => void) | null = null;
        const push = (state: ProjectTaskState) => {
            pushed = state;
            wake?.();
        };
        let last: ProjectTaskState | null = null;
        const publish = (state: ProjectTaskState) => {
            last = state;
            onUpdate?.(state);
        };

        const done = (async (): Promise<ProjectTaskOutcome> => {
            let state: ProjectTaskState;
            try {
                state = await begin(controller.signal);
            } catch (error) {
                rejectId(error);
                throw error;
            }
            resolveId(state.id);
            publish(state);
            const started = now();
            let failures = 0;
            let lastPoll = now();
            while (!terminal(state.status)) {
                if (pushed) {
                    state = pushed;
                    pushed = null;
                    publish(state);
                    continue;
                }
                if (now() - started > TASK_DEADLINE_MS) {
                    const out: ProjectTaskOutcome = { ...state, status: "failed", error: { message: "It is taking too long: it may still finish and be charged.", refunded: false } };
                    publish(out);
                    return out;
                }
                const gap = Math.max(0, lastPoll + MIN_POLL_MS - now());
                if (gap > 0 || failures > 0) {
                    const delay = failures > 0 ? Math.min(MAX_POLL_BACKOFF_MS, MIN_POLL_MS * 2 ** (failures - 1)) : gap;
                    await new Promise<void>((resolve, reject) => {
                        wake = resolve;
                        sleep(delay, controller.signal).then(resolve, reject);
                    }).finally(() => {
                        wake = null;
                    });
                    if (pushed) continue;
                }
                lastPoll = now();
                try {
                    const answer = await api.request<unknown>("GET", `/v1/tasks/${encodeURIComponent(state.id)}`, { query: { wait }, signal: controller.signal });
                    const next = parseTaskState(answer.body);
                    failures = 0;
                    if (next) {
                        state = next;
                        publish(state);
                    }
                } catch (error) {
                    if (controller.signal.aborted) throw stopped();
                    if (isCloudApiError(error) && error.status === 404) {
                        const out: ProjectTaskOutcome = { ...state, status: "failed", error: { message: "OpenNan no longer knows this task.", code: "not_found", refunded: false } };
                        publish(out);
                        return out;
                    }
                    failures += 1;
                    if (isCloudApiError(error) && error.retryAfterSeconds) await sleep(Math.min(MAX_POLL_BACKOFF_MS, error.retryAfterSeconds * 1000), controller.signal);
                }
            }
            return state as ProjectTaskOutcome;
        })();
        done.catch(() => undefined);

        async function cancel(): Promise<CancelAnswer> {
            let taskId: string;
            try {
                taskId = await id;
            } catch {
                return { accepted: true };
            }
            if (last && terminal(last.status)) return { accepted: false, message: "It had already finished." };
            for (let attempt = 0; ; attempt++) {
                try {
                    const answer = await api.request<unknown>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`);
                    const state = parseTaskState(answer.body);
                    push(state && terminal(state.status) ? state : { ...(last ?? { id: taskId }), id: taskId, status: "cancelled", error: { message: "", refunded: true } });
                    return { accepted: true };
                } catch (error) {
                    if (!isCloudApiError(error)) return { accepted: false, message: CANCEL_UNKNOWN };
                    if (error.code === "task_busy_retry" && attempt < CANCEL_RETRIES) {
                        const ms = Math.max(250, Math.min(5_000, (error.retryAfterSeconds ?? 1) * 1000));
                        await sleep(ms, new AbortController().signal);
                        continue;
                    }
                    if (error.code === "task_already_finished") {
                        try {
                            const answer = await api.request<unknown>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
                            const state = parseTaskState(answer.body);
                            if (state) push(state);
                        } catch {
                            // the poll loop will read it
                        }
                        return { accepted: false, message: "It had already finished." };
                    }
                    if (error.code === "task_not_cancellable" || error.status === 409) return { accepted: false, message: CANCEL_TOO_LATE };
                    return { accepted: false, message: CANCEL_UNKNOWN };
                }
            }
        }

        return { id, done, cancel, detach: () => controller.abort() };
    }

    return {
        start(request, startOptions = {}) {
            return track(async () => {
                // The POST is never aborted (no signal): the server may already hold the task.
                const answer = await api.request<unknown>("POST", request.path, {
                    body: request.body, headers: { "Idempotency-Key": startOptions.idempotencyKey ?? globalThis.crypto.randomUUID() },
                });
                const state = parseTaskState(answer.body);
                if (!state) throw new Error("OpenNan started the step but sent no task to follow: check your usage on opennan.com before running it again.");
                return state;
            }, startOptions.onUpdate);
        },
        follow(taskId, followOptions = {}) {
            if (!TASK_ID.test(taskId)) throw new Error("Not a task id.");
            return track(async () => ({ id: taskId, status: "queued" }), followOptions.onUpdate);
        },
    };
}
