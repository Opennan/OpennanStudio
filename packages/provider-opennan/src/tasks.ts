// OpenNan tasks: created with one POST (a fresh Idempotency-Key, never retried), then polled (GET /v1/tasks/{id}?wait=50)
// at least a second apart until they finish. The job's cancel is decided by the server from the moment the POST is
// sent: the POST is never aborted (the server may already hold the task), the cancel waits for its answer, and then
// asks POST /v1/tasks/{id}/cancel. Only a 200 (or a POST that failed: nothing was created) ends the job cancelled;
// a 409 or a cancel that gets no answer leaves it running (cancellable false: it may finish and be charged). The 409
// says which by its code (phase 11.1): task_busy_retry is asked again after Retry-After (up to three times),
// task_not_cancellable keeps the job running ("it will finish and be charged"), task_already_finished GETs the task
// and ends the job in its real final state. An older server without codes is told apart by its message.
// Local steps before the POST (preparing, uploading) register no handler, so a cancel there aborts at once.
import { JobCancelledError, JobFailedError, type CancelAnswer, type JobContext } from "@opennan/provider-sdk";
import type { OpenNanApi } from "./api";
import { OpenNanApiError, notChargedError, safeServerText } from "./errors";
import { randomIdempotencyKey } from "./inputs";

/** Seconds a task poll may wait on the server for the task to finish. */
export const TASK_WAIT_SECONDS = 50;
/** At least this long between task polls, even when the server answers at once (no tight loop). */
export const MIN_TASK_POLL_MS = 1_000;
/** A cancel the server answers "busy" is asked again this many times, this far apart, before it counts as refused. */
export const CANCEL_BUSY_RETRIES = 3;
export const CANCEL_BUSY_RETRY_MS = 1_000;
/** Retry-After of a busy cancel is honoured within these bounds (a broken header never stalls a cancel). */
export const MIN_CANCEL_RETRY_MS = 250;
export const MAX_CANCEL_RETRY_MS = 5_000;
/** What a job shows when the cancel came after the task had finished (its final state follows at once). */
export const CANCEL_TOO_LATE_MESSAGE = "It had already finished.";
/** A task still running after this long is given up (the job fails; the server may still finish it). */
export const TASK_DEADLINE_MS = 60 * 60_000;
/** The longest wait between polls after failed ones (unless Retry-After asks for more). */
export const MAX_POLL_BACKOFF_MS = 30_000;
const MAY_STILL_FINISH = "it may still finish and be charged.";

export interface TaskBody {
    id?: unknown;
    status?: unknown;
    progress?: unknown;
    stage?: unknown;
    outputs?: unknown;
    result?: unknown;
    price_usd?: unknown;
    error?: { message?: unknown; refunded?: unknown; code?: unknown } | null;
}

/** The words a job shows for each stage a tool reports (from each tool's fixed stage list). */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
    reading: "Reading", transcribing: "Transcribing", translating: "Translating", isolating: "Isolating", upscaling: "Upscaling",
    matting: "Removing background", syncing: "Syncing lips", separation: "Separating", generating: "Generating",
};

export function stageLabel(stage: string): string {
    const known = STAGE_LABELS[stage];
    if (known) return known;
    const words = stage.replace(/[_-]+/g, " ").trim();
    return words ? words[0]!.toUpperCase() + words.slice(1) : "Running";
}

function pause(ms: number, signal: AbortSignal, wake?: Wake): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new JobCancelledError());
            return;
        }
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            if (wake) wake.poke = () => undefined;
            resolve();
        };
        const timer = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timer);
            if (wake) wake.poke = () => undefined;
            reject(new JobCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (wake) {
            if (wake.body) {
                done();
                return;
            }
            wake.poke = done;
        }
    });
}

export interface PollOptions {
    pollIntervalMs?: number;
    /** What the job shows while the task runs without a stage. */
    runningLabel?: string;
    /** Milliseconds between cancels the server answered "busy" (tests); default CANCEL_BUSY_RETRY_MS. */
    cancelRetryMs?: number;
    /** How long a task may run before it is given up (tests); default TASK_DEADLINE_MS. */
    deadlineMs?: number;
    /** How long the task POST may take (tests); default TASK_SUBMIT_TIMEOUT_MS. */
    submitTimeoutMs?: number;
}

/** The task POST may take this long: a stems submit downloads and decodes the audio before it answers. */
export const TASK_SUBMIT_TIMEOUT_MS = 5 * 60_000;
export const SUBMIT_UNKNOWN_MESSAGE = "The connection to OpenNan was lost while the run was being submitted: it may have started and may still finish and be charged. Check your usage on opennan.com before running it again.";

/** Codes an older server (before phase 11.1) or a generic refusal carries: the message has to tell the case. */
const GENERIC_CODES = new Set(["conflict", "busy", ""]);

type CancelRefusal = "busy" | "not-cancellable" | "finished" | "unknown";

/** Which refusal a failed cancel POST is: by its code, by its message only for an older server. */
function refusalOf(error: unknown): CancelRefusal {
    if (!(error instanceof OpenNanApiError) || error.status !== 409) return "unknown";
    if (error.code === "task_busy_retry") return "busy";
    if (error.code === "task_not_cancellable") return "not-cancellable";
    if (error.code === "task_already_finished") return "finished";
    if (GENERIC_CODES.has(error.code) && /\bbusy\b/i.test(error.message)) return "busy";
    return "not-cancellable";
}

/** How long to wait before asking a busy cancel again: Retry-After, within MIN/MAX_CANCEL_RETRY_MS (1 s without it). */
export function cancelRetryDelayMs(error: unknown): number {
    const seconds = error instanceof OpenNanApiError ? error.retryAfterSeconds : undefined;
    if (seconds === undefined) return CANCEL_BUSY_RETRY_MS;
    return Math.min(MAX_CANCEL_RETRY_MS, Math.max(MIN_CANCEL_RETRY_MS, seconds * 1000));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Asks the server to cancel a created task: accepted only when it confirmed (200). Busy is asked again after
 * Retry-After a few times; a task that already finished is fetched (`onFinished` gets its body) and the cancel is
 * refused with CANCEL_TOO_LATE_MESSAGE; anything else is refused (it may still finish and be charged).
 */
async function cancelTask(api: OpenNanApi, key: string, id: string, retryMs: number | undefined, onFinished: (task: TaskBody) => void): Promise<CancelAnswer> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await api.request("POST", `/v1/tasks/${encodeURIComponent(id)}/cancel`, { apiKey: key });
            return true;
        } catch (error) {
            const refusal = refusalOf(error);
            if (refusal === "busy" && attempt < CANCEL_BUSY_RETRIES) {
                await sleep(retryMs ?? cancelRetryDelayMs(error));
                continue;
            }
            if (refusal === "finished") {
                try {
                    onFinished(await api.request<TaskBody>("GET", `/v1/tasks/${encodeURIComponent(id)}`, { apiKey: key }));
                } catch {
                    // The next poll reads it.
                }
                return { accepted: false, message: CANCEL_TOO_LATE_MESSAGE };
            }
            // Not cancellable (its paid step started), or no answer / 5xx / 404: it may still finish and be charged.
            return false;
        }
    }
}

/** A poll loop's mailbox: the cancel hands it a fetched final body and wakes its wait. */
interface Wake {
    body: TaskBody | null;
    poke(): void;
}

/**
 * Creates a task (POST `path`) and polls it until it succeeds (resolves its final body), fails (JobFailedError), or
 * is cancelled. The cancel handler is in place before the POST is sent.
 */
/** The task POST's answer was lost (no HTTP answer): whether a task exists is unknown. */
const LOST = "\u0000lost";

export async function runTask(api: OpenNanApi, key: string, context: JobContext, path: string, body: Record<string, unknown>, options: PollOptions = {}): Promise<TaskBody> {
    let settleId!: (id: string | null) => void;
    const created = new Promise<string | null>((resolve) => {
        settleId = resolve;
    });
    const wake: Wake = { body: null, poke: () => undefined };
    context.onCancel(async () => {
        const id = await created;
        // The server refused the POST (an HTTP answer) or named no task: nothing was created.
        if (id === null) return true;
        // The POST's answer was lost: a task may exist that nothing here can name, so the cancel cannot be confirmed.
        if (id === LOST) return false;
        return cancelTask(api, key, id, options.cancelRetryMs, (body) => {
            wake.body = body;
            wake.poke();
        });
    });
    try {
        let first: TaskBody;
        try {
            // Not aborted by a cancel: once sent, the POST completes so the task it created is known (and can be
            // cancelled). Bounded by a generous timeout so a stalled connection cannot hold the job forever.
            first = await api.request<TaskBody>("POST", path, {
                apiKey: key, body, headers: { "Idempotency-Key": randomIdempotencyKey() },
                signal: AbortSignal.timeout(options.submitTimeoutMs ?? TASK_SUBMIT_TIMEOUT_MS),
            });
        } catch (error) {
            // OpenNan's own HTTP answer (4xx, 5xx in its error envelope, 402) is the server refusing: nothing was
            // created. No answer (network, timeout) or a 5xx without the envelope (a proxy in front of it) leaves it
            // unknown: the request may have reached the server.
            // A 2xx whose body could not be read is not a refusal either: the task may well exist.
            const answered = error instanceof OpenNanApiError && error.status >= 400 && !(error.status >= 500 && !error.fromServer);
            if (answered) {
                settleId(null);
                throw notChargedError(error);
            }
            settleId(LOST);
            throw new JobFailedError(SUBMIT_UNKNOWN_MESSAGE, { cause: error, code: "submit_unknown", refunded: false });
        }
        const id = typeof first.id === "string" ? first.id : null;
        if (!id) {
            // Accepted (2xx) without naming its task: one may exist that nothing here can name or cancel.
            settleId(LOST);
            throw new JobFailedError(SUBMIT_UNKNOWN_MESSAGE, { code: "submit_unknown", refunded: false });
        }
        settleId(id);
        return await pollTask(api, first, id, key, context, options, wake);
    } finally {
        context.onCancel(null);
    }
}

/** Why polls kept failing, in a few fixed words (never a "try again": the task may still run and be charged). */
function pollFailure(error: unknown): string {
    if (!(error instanceof OpenNanApiError) || error.status === 0) return "no answer from OpenNan";
    if (error.status === 429) return "OpenNan was busy";
    if (error.code === "invalid_response") return "an answer Studio could not read";
    return "OpenNan had an error";
}

/** A poll that failed but may work later: no answer, 429, 5xx, or an answer that could not be read. */
function isTransient(error: unknown): boolean {
    if (!(error instanceof OpenNanApiError)) return false;
    return error.status === 0 || error.status === 429 || error.status >= 500 || error.code === "invalid_response";
}

/** The wait before the next poll after `failures` failed ones in a row: doubling from the interval, at least Retry-After. */
function backoffMs(failures: number, interval: number, error: unknown): number {
    const doubled = Math.min(MAX_POLL_BACKOFF_MS, interval * 2 ** (failures - 1));
    const retryAfter = error instanceof OpenNanApiError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : 0;
    return Math.max(doubled, retryAfter);
}

/**
 * Polls until the task reaches a terminal status. A poll that gets no answer, 429, or 5xx is tried again with
 * backoff until the deadline (the task runs on on the server); any other 4xx fails the job.
 */
async function pollTask(api: OpenNanApi, created: TaskBody, id: string, key: string, context: JobContext, options: PollOptions, wake: Wake): Promise<TaskBody> {
    const interval = options.pollIntervalMs ?? MIN_TASK_POLL_MS;
    const deadline = Date.now() + (options.deadlineMs ?? TASK_DEADLINE_MS);
    let task = created;
    let lastPoll = 0;
    let failures = 0;
    let lastError: unknown = null;
    let backoff = 0;
    for (;;) {
        if (wake.body) {
            task = wake.body;
            wake.body = null;
        }
        const status = task.status;
        if (status === "succeeded") return task;
        if (status === "failed") {
            const error = task.error ?? {};
            // The server's public failure text (its refund wording), only when it is safe to show.
            const message = (typeof error.message === "string" ? safeServerText(error.message) : null) ?? (error.refunded === true ? "The OpenNan task failed. You were not charged." : "The OpenNan task failed.");
            throw new JobFailedError(message, { refunded: error.refunded === true, ...(typeof error.code === "string" ? { code: error.code } : {}) });
        }
        if (status === "cancelled") throw new JobCancelledError();
        const progress = Number(task.progress);
        const label = typeof task.stage === "string" ? stageLabel(task.stage) : status === "queued" ? "Queued" : (options.runningLabel ?? "Generating");
        context.report(Number.isFinite(progress) ? progress / 100 : null, label);
        const left = deadline - Date.now();
        if (left <= 0) {
            const why = lastError !== null ? `Studio could not check the OpenNan task (${pollFailure(lastError)})` : "The OpenNan task did not finish within the time Studio waits";
            throw new JobFailedError(`${why}: ${MAY_STILL_FINISH}`, { refunded: false, ...(lastError ? { cause: lastError } : {}) });
        }
        const wait = Math.min(left, Math.max(lastPoll + interval - Date.now(), backoff));
        if (wait > 0) await pause(wait, context.signal, wake);
        if (wake.body) continue;
        lastPoll = Date.now();
        try {
            task = await api.request<TaskBody>("GET", `/v1/tasks/${encodeURIComponent(id)}`, { apiKey: key, query: { wait: TASK_WAIT_SECONDS }, signal: context.signal });
            failures = 0;
            lastError = null;
            backoff = 0;
        } catch (error) {
            if (context.signal.aborted || !isTransient(error)) throw error;
            failures += 1;
            lastError = error;
            backoff = backoffMs(failures, interval, error);
        }
    }
}

export function costOf(task: TaskBody): number | undefined {
    const price = Number(task.price_usd);
    return Number.isFinite(price) && price > 0 ? price : undefined;
}
