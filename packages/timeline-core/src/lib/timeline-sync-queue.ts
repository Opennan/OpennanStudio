"use client";
// Durable, offline-safe outbox for timeline edits.
//
// Local edits are applied to React state and the local snapshot instantly; the
// network is no longer in the edit path. Each persistence command is enqueued
// here and flushed to the backend by a background drainer with exponential
// backoff. If the tab is offline (or the request fails), commands survive in
// IndexedDB and replay on reconnect, in order, per project.
//
// This module is pure orchestration: the actual storage and the actual GraphQL
// send are injected, so it is fully unit-testable without a browser.

import type { LocalSyncOp, LocalSyncQueueRow } from "./sync-queue-types";

export type QueuedCommand = LocalSyncQueueRow;

export interface SyncQueueStore {
    enqueue(cmd: Omit<QueuedCommand, "id">): Promise<number>;
    list(projectId: string): Promise<QueuedCommand[]>;
    remove(id: number): Promise<void>;
    update(id: number, patch: Partial<QueuedCommand>): Promise<void>;
    // Drop older un-sent commands sharing a coalesce key (latest write wins).
    supersede(projectId: string, coalesceKey: string, exceptId?: number): Promise<void>;
}

// Returns true when the command was accepted by the server; false/throw means
// a retryable failure (network/offline/5xx).
export type CommandSender = (cmd: QueuedCommand) => Promise<boolean>;

export interface SyncQueueOptions {
    now?: () => number;
    // Backoff schedule per attempt count (ms). Index clamps to last entry.
    backoffScheduleMs?: number[];
    isOnline?: () => boolean;
    maxAttempts?: number;
}

const DEFAULT_BACKOFF_MS = [0, 1000, 3000, 8000, 20000, 60000];

export function nextBackoffDelayMs(attempts: number, schedule = DEFAULT_BACKOFF_MS): number {
    if (attempts <= 0) return schedule[0] ?? 0;
    return schedule[Math.min(attempts, schedule.length - 1)] ?? schedule[schedule.length - 1];
}

// Commands eligible to send right now, oldest first.
export function selectDrainable(cmds: QueuedCommand[], now: number): QueuedCommand[] {
    return [...cmds]
        .filter((c) => c.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id ?? 0) - (b.id ?? 0));
}

export class TimelineSyncQueue {
    private now: () => number;
    private backoff: number[];
    private isOnline: () => boolean;
    private maxAttempts: number;
    private draining = false;
    private drainQueuedAgain = false;

    constructor(
        private store: SyncQueueStore,
        private sender: CommandSender,
        opts: SyncQueueOptions = {},
    ) {
        this.now = opts.now ?? (() => Date.now());
        this.backoff = opts.backoffScheduleMs ?? DEFAULT_BACKOFF_MS;
        this.isOnline = opts.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
        this.maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
    }

    async enqueue(
        projectId: string,
        op: LocalSyncOp,
        payload: unknown,
        coalesceKey?: string,
    ): Promise<number> {
        const id = await this.store.enqueue({
            projectId,
            op,
            payload,
            createdAt: this.now(),
            attempts: 0,
            nextAttemptAt: this.now(),
            coalesceKey,
        });
        if (coalesceKey) {
            await this.store.supersede(projectId, coalesceKey, id);
        }
        return id;
    }

    async pendingCount(projectId: string): Promise<number> {
        const cmds = await this.store.list(projectId);
        return cmds.length;
    }

    // Send all currently-drainable commands in order. Stops early on the first
    // retryable failure (subsequent commands likely depend on it / will also
    // fail), bumping that command's backoff so a later drain retries it.
    // Returns the number of commands successfully sent.
    async drain(projectId: string): Promise<number> {
        if (this.draining) {
            this.drainQueuedAgain = true;
            return 0;
        }
        this.draining = true;
        let sent = 0;
        try {
            do {
                this.drainQueuedAgain = false;
                if (!this.isOnline()) break;
                const all = await this.store.list(projectId);
                // Strict per-project ordering: process oldest first. A backed-off
                // head must block newer commands so dependent edits never reorder.
                const ordered = [...all].sort(
                    (a, b) => a.createdAt - b.createdAt || (a.id ?? 0) - (b.id ?? 0),
                );
                if (ordered.length === 0) break;
                let madeProgress = false;
                for (const cmd of ordered) {
                    if (!this.isOnline()) break;
                    if (cmd.nextAttemptAt > this.now()) break;
                    let ok = false;
                    try {
                        ok = await this.sender(cmd);
                    } catch {
                        ok = false;
                    }
                    if (ok) {
                        if (cmd.id !== undefined) await this.store.remove(cmd.id);
                        sent += 1;
                        madeProgress = true;
                    } else {
                        const attempts = cmd.attempts + 1;
                        if (cmd.id !== undefined) {
                            if (attempts >= this.maxAttempts) {
                                // Give up on this command so it can't wedge the queue.
                                await this.store.remove(cmd.id);
                            } else {
                                await this.store.update(cmd.id, {
                                    attempts,
                                    nextAttemptAt: this.now() + nextBackoffDelayMs(attempts, this.backoff),
                                });
                            }
                        }
                        // Stop this pass to preserve ordering; retry later.
                        break;
                    }
                }
                if (!madeProgress) break;
            } while (this.drainQueuedAgain);
        } finally {
            this.draining = false;
        }
        return sent;
    }
}
