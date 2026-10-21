// AiJobBook (phase 11): what the editor's AI jobs did, for the job tray and MCP's check_generation_status.
// createAiRunner(registry, { jobs }) records every job it starts and every update it sees: status, progress,
// stage message, whether cancel can still stop it, the cost on success, and the error plus refund on failure.
import type { JobStatus } from "./job";

export interface AiJobRecord {
    jobId: string;
    capability: string;
    status: JobStatus;
    /** 0..1 */
    progress?: number;
    message?: string;
    /** What the provider charged (on success). */
    costUsd?: number;
    error?: string;
    /** The provider says nothing was charged for the failed run. */
    refunded?: boolean;
    /** false once cancel can no longer stop the job (its paid step started). */
    cancellable: boolean;
    /** Milliseconds since the epoch. */
    startedAt: number;
    finishedAt?: number;
}

export type AiJobPatch = Partial<Omit<AiJobRecord, "jobId" | "capability" | "startedAt" | "finishedAt">>;

/** The book forgets the oldest finished records past this many. */
export const MAX_AI_JOB_RECORDS = 200;

const isTerminal = (status: JobStatus) => status === "succeeded" || status === "failed" || status === "cancelled";

export class AiJobBook {
    private readonly records = new Map<string, AiJobRecord>();
    private readonly listeners = new Set<(record: AiJobRecord) => void>();
    private readonly now: () => number;
    private changes = 0;

    constructor(options: { now?(): number } = {}) {
        this.now = options.now ?? Date.now;
    }

    /** Starts a record (status queued, cancellable). Recording an id again starts it afresh. */
    record(entry: { jobId: string; capability: string }): AiJobRecord {
        this.records.delete(entry.jobId);
        const record: AiJobRecord = { jobId: entry.jobId, capability: entry.capability, status: "queued", cancellable: true, startedAt: this.now() };
        this.records.set(entry.jobId, record);
        this.trim();
        this.changed(record);
        return { ...record };
    }

    /** Merges an update into a record (unknown ids are ignored); a terminal status stamps finishedAt. */
    update(jobId: string, patch: AiJobPatch): void {
        const record = this.records.get(jobId);
        if (!record) return;
        for (const [key, value] of Object.entries(patch) as Array<[keyof AiJobPatch, unknown]>) {
            if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
        }
        if (isTerminal(record.status) && record.finishedAt === undefined) record.finishedAt = this.now();
        this.changed(record);
    }

    get(jobId: string): AiJobRecord | undefined {
        const record = this.records.get(jobId);
        return record ? { ...record } : undefined;
    }

    /** Newest first. */
    list(): AiJobRecord[] {
        return [...this.records.values()].reverse().map((record) => ({ ...record }));
    }

    subscribe(listener: (record: AiJobRecord) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Increases on every change (a snapshot key for UI stores). */
    version(): number {
        return this.changes;
    }

    private trim(): void {
        while (this.records.size > MAX_AI_JOB_RECORDS) {
            let victim: string | undefined;
            for (const record of this.records.values()) {
                if (isTerminal(record.status)) {
                    victim = record.jobId;
                    break;
                }
            }
            this.records.delete(victim ?? this.records.keys().next().value!);
        }
    }

    private changed(record: AiJobRecord): void {
        this.changes += 1;
        for (const listener of [...this.listeners]) listener({ ...record });
    }
}
