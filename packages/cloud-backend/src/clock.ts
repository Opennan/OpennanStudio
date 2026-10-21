// Time for the sync engine, injectable so tests run timers by hand.

export interface Clock {
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    /** 0 ≤ x < 1, for retry jitter. */
    random(): number;
}

export const REAL_CLOCK: Clock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    random: () => Math.random(),
};

/** A clock tests advance by hand; timers run in due order, with pending promise jobs drained in between. */
export class FakeClock implements Clock {
    private time: number;
    private nextId = 1;
    private timers = new Map<number, { at: number; callback: () => void }>();

    constructor(start = 1_000_000) {
        this.time = start;
    }

    now(): number {
        return this.time;
    }

    random(): number {
        return 0.5;
    }

    setTimeout(callback: () => void, ms: number): unknown {
        const id = this.nextId++;
        this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
        return id;
    }

    clearTimeout(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    pending(): number {
        return this.timers.size;
    }

    /** Moves time forward by `ms`, running every timer that falls due (and the promise jobs they start). */
    async advance(ms: number): Promise<void> {
        const end = this.time + ms;
        for (;;) {
            await settle();
            const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due) break;
            this.timers.delete(due[0]);
            this.time = Math.max(this.time, due[1].at);
            due[1].callback();
        }
        this.time = end;
        await settle();
    }
}

/** Lets queued promise jobs (and their follow-ups) run. */
export async function settle(rounds = 25): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => setImmediateLike(resolve));
    for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function setImmediateLike(callback: () => void): void {
    const immediate = (globalThis as { setImmediate?: (cb: () => void) => void }).setImmediate;
    if (immediate) immediate(callback);
    else globalThis.setTimeout(callback, 0);
}
