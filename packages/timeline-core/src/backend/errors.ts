// Error types and the timeout helper used by TimelineController (spec §10).
// Semantics from opennan frontend nle-timeline-utils.ts:120-152, scheduler injected.

export class TimelineTimeoutError extends Error {
    constructor(label = "timeline request") {
        super(`${label} timed out`);
        this.name = "TimelineTimeoutError";
    }
}

export class CommandUnavailableError extends Error {
    constructor(readonly command: string, reason: string) {
        super(reason);
        this.name = "CommandUnavailableError";
    }
}

export interface Scheduler {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

// Reads globalThis at call time so tests can install fake timers after construction.
export const GLOBAL_SCHEDULER: Scheduler = {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function withTimeout<T>(
    task: Promise<T>,
    timeoutMs: number,
    scheduler: Scheduler = GLOBAL_SCHEDULER,
    label?: string,
): Promise<T> {
    let handle: unknown = null;
    try {
        return await Promise.race([
            task,
            new Promise<never>((_resolve, reject) => {
                handle = scheduler.setTimeout(() => reject(new TimelineTimeoutError(label)), timeoutMs);
            }),
        ]);
    } finally {
        if (handle !== null) scheduler.clearTimeout(handle);
    }
}
