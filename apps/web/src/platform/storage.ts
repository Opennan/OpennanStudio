// Browser storage for local projects. Without navigator.storage.persist(), browsers may
// evict IndexedDB under storage pressure, and Safari can delete script-written storage
// after a period without use: for an editor whose only copy of a project is in the
// browser, that is silent data loss. persist() is asked once, on the first project
// create or import; the project list shows the usage and warns while storage is not persistent.
import { formatBytes } from "../ui/format";

export interface StorageManagerLike {
    persisted?(): Promise<boolean>;
    persist?(): Promise<boolean>;
    estimate?(): Promise<{ usage?: number; quota?: number }>;
}

/** "best-effort": the browser may evict this origin's data under storage pressure. */
export type PersistState = "persistent" | "best-effort" | "unsupported";

export interface StorageUsage {
    usage: number;
    quota: number;
}

export interface StorageGuard {
    /** Asks for persistent storage once per tab and remembers the answer. */
    ensurePersisted(): Promise<PersistState>;
    /** The current state, without asking. */
    persisted(): Promise<PersistState>;
    estimate(): Promise<StorageUsage | null>;
}

export function createStorageGuard(storage: StorageManagerLike | null | undefined): StorageGuard {
    let asked: Promise<PersistState> | null = null;
    const persisted = async (): Promise<PersistState> => {
        if (!storage?.persisted) return "unsupported";
        return (await storage.persisted().catch(() => false)) ? "persistent" : "best-effort";
    };
    return {
        persisted,
        ensurePersisted() {
            asked ??= (async () => {
                const state = await persisted();
                if (state !== "best-effort" || !storage?.persist) return state;
                return (await storage.persist().catch(() => false)) ? "persistent" : "best-effort";
            })();
            return asked;
        },
        async estimate() {
            const result = await storage?.estimate?.().catch(() => null);
            return result && typeof result.usage === "number" && typeof result.quota === "number"
                ? { usage: result.usage, quota: result.quota }
                : null;
        },
    };
}

export function isQuotaExceeded(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "QuotaExceededError";
}

/** The reason a write failed for lack of space, with the usage when known; null for any other error. */
export function storageErrorMessage(error: unknown, usage: StorageUsage | null): string | null {
    if (!isQuotaExceeded(error)) return null;
    return usage
        ? `Not enough browser storage (${formatBytes(usage.usage)} of ${formatBytes(usage.quota)} used)`
        : "Not enough browser storage";
}
