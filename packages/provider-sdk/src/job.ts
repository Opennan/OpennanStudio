// Job<T> (spec §5.4): every generation call returns one, so the UI shows progress the same way for every
// provider. createJob turns an async function into a Job with status, progress updates, and cancel.
import { CapabilityUnavailableError, JobCancelledError, JobFailedError } from "./errors";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobUpdate {
    status: JobStatus;
    /** 0..1 */
    progress?: number;
    message?: string;
    error?: string;
    /** false once cancel can no longer stop the job (a paid step started): it will finish and be charged. */
    cancellable?: boolean;
}

export interface Job<T> {
    id: string;
    status(): Promise<JobStatus>;
    /** Resolves the value; rejects with JobFailedError (provider message) or JobCancelledError. */
    result(): Promise<T>;
    cancel(): Promise<void>;
    /** The listener gets the current update at once and every later one. */
    subscribe?(listener: (update: JobUpdate) => void): () => void;
    /**
     * Resolves when the provider's work has really stopped: after cancel() the job is "cancelled" at once, but
     * processes and downloads may need a moment to wind down. Hosts that run one job at a time wait for this.
     */
    finished?(): Promise<void>;
}

export interface JobContext {
    signal: AbortSignal;
    /** Progress 0..1 (null keeps the last value) and an optional phase message. */
    report(progress: number | null, message?: string): void;
    /**
     * Who decides a cancel (phase 11): cancel() awaits the handler. true (or a throw): the job is cancelled and the
     * signal aborts. false: the provider refused (its paid step started), the job keeps running and reports
     * cancellable: false. null clears it (cancel aborts at once, as without a handler).
     */
    onCancel(handler: (() => Promise<CancelAnswer>) | null): void;
}

/** A cancel handler's answer: true accepted, false refused, or refused with the message the job shows instead. */
export type CancelAnswer = boolean | { accepted: false; message: string };

export const CANCEL_REFUSED_MESSAGE = "Already running: it will finish and be charged.";

export interface CreateJobOptions {
    id?: string;
}

export type LocalJob<T> = Job<T> & { subscribe(listener: (update: JobUpdate) => void): () => void; finished(): Promise<void>; update(): JobUpdate };

function randomId(): string {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    let out = "";
    for (const byte of bytes) out += byte.toString(36).padStart(2, "0");
    return `job-${out}`;
}

const isTerminal = (status: JobStatus) => status === "succeeded" || status === "failed" || status === "cancelled";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createJob<T>(run: (context: JobContext) => Promise<T>, options: CreateJobOptions = {}): LocalJob<T> {
    const controller = new AbortController();
    const listeners = new Set<(update: JobUpdate) => void>();
    let current: JobUpdate = { status: "queued" };
    let settle!: { resolve(value: T): void; reject(error: unknown): void };
    const outcome = new Promise<T>((resolve, reject) => {
        settle = { resolve, reject };
    });
    // A failed job nobody awaits must not surface as an unhandled rejection.
    outcome.catch(() => undefined);

    let cancelHandler: (() => Promise<CancelAnswer>) | null = null;
    let refused = false;
    const publish = (next: JobUpdate) => {
        if (refused && !isTerminal(next.status)) next = { ...next, cancellable: false };
        current = next;
        for (const listener of [...listeners]) listener({ ...next });
    };
    const finish = (status: JobStatus, error?: unknown) => {
        if (isTerminal(current.status)) return;
        const base: JobUpdate = { status };
        if (current.message !== undefined) base.message = current.message;
        if (status === "succeeded") base.progress = 1;
        else if (current.progress !== undefined) base.progress = current.progress;
        if (status === "failed") base.error = errorText(error);
        publish(base);
    };

    const start = async () => {
        await Promise.resolve();
        if (controller.signal.aborted) return;
        publish({ status: "running" });
        const report = (progress: number | null, message?: string) => {
            if (current.status !== "running") return;
            const next: JobUpdate = { status: "running" };
            const value = progress === null ? current.progress : Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
            if (value !== undefined) next.progress = value;
            const text = message ?? current.message;
            if (text !== undefined) next.message = text;
            publish(next);
        };
        const onCancel = (handler: (() => Promise<CancelAnswer>) | null) => {
            cancelHandler = handler;
        };
        try {
            const value = await run({ signal: controller.signal, report, onCancel });
            if (controller.signal.aborted) return;
            finish("succeeded");
            settle.resolve(value);
        } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof JobCancelledError) {
                finish("cancelled");
                settle.reject(error);
                return;
            }
            finish("failed", error);
            // Typed SDK errors pass through (a CapabilityUnavailableError is guidance, e.g. "sign in"); others become JobFailedError.
            const typed = error instanceof JobFailedError || error instanceof CapabilityUnavailableError;
            settle.reject(typed ? error : new JobFailedError(errorText(error), { cause: error }));
        }
    };
    const done = start().catch(() => undefined);

    return {
        id: options.id ?? randomId(),
        status: async () => current.status,
        result: () => outcome,
        async cancel() {
            if (isTerminal(current.status) || refused) return;
            const handler = cancelHandler;
            if (handler) {
                let answer: CancelAnswer = true;
                try {
                    answer = await handler();
                } catch {
                    answer = true;
                }
                if (isTerminal(current.status)) return;
                if (answer !== true) {
                    refused = true;
                    publish({ ...current, message: typeof answer === "object" ? answer.message : CANCEL_REFUSED_MESSAGE });
                    return;
                }
            }
            controller.abort();
            finish("cancelled");
            settle.reject(new JobCancelledError());
        },
        subscribe(listener) {
            listeners.add(listener);
            listener({ ...current });
            return () => {
                listeners.delete(listener);
            };
        },
        finished: () => done,
        update: () => ({ ...current }),
    };
}
