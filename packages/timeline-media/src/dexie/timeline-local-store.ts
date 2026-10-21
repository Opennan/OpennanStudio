"use client";
// Dexie-backed adapters for the local-first timeline: an instant snapshot store
// (for fast hydrate on reload / offline) and the durable sync-queue storage that
// backs TimelineSyncQueue.

import { getLocalDB, isLocalDBAvailable } from "./local-db";
import type { QueuedCommand, SyncQueueStore } from "@opennan/timeline-core/lib/timeline-sync-queue";

// ── Snapshot store ──────────────────────────────────────────────────────────

// Persist the last-known timeline so the editor can paint instantly before the
// server responds. Best-effort: never throws into the caller.
export async function saveTimelineSnapshot(projectId: string, data: unknown): Promise<void> {
    if (!isLocalDBAvailable() || !projectId) return;
    try {
        // Deep copy to detach from React state. Prefer structuredClone (no large
        // intermediate JSON string) and fall back to JSON, which also sanitizes
        // any non-cloneable values (functions / class instances).
        let plain: unknown;
        if (typeof structuredClone === "function") {
            try {
                plain = structuredClone(data);
            } catch {
                plain = JSON.parse(JSON.stringify(data));
            }
        } else {
            plain = JSON.parse(JSON.stringify(data));
        }
        await getLocalDB().timelineSnapshots.put({ projectId, data: plain, savedAt: Date.now() });
    } catch {
        // ignore persistence failures
    }
}

export async function loadTimelineSnapshot<T = unknown>(projectId: string): Promise<T | null> {
    if (!isLocalDBAvailable() || !projectId) return null;
    try {
        const row = await getLocalDB().timelineSnapshots.get(projectId);
        return (row?.data as T) ?? null;
    } catch {
        return null;
    }
}

export async function clearTimelineSnapshot(projectId: string): Promise<void> {
    if (!isLocalDBAvailable() || !projectId) return;
    try {
        await getLocalDB().timelineSnapshots.delete(projectId);
    } catch {
        // ignore
    }
}

// ── Sync-queue storage ───────────────────────────────────────────────────────

export class DexieSyncQueueStore implements SyncQueueStore {
    async enqueue(cmd: Omit<QueuedCommand, "id">): Promise<number> {
        return (await getLocalDB().syncQueue.add(cmd as QueuedCommand)) as number;
    }

    async list(projectId: string): Promise<QueuedCommand[]> {
        return getLocalDB().syncQueue.where("projectId").equals(projectId).toArray();
    }

    async remove(id: number): Promise<void> {
        await getLocalDB().syncQueue.delete(id);
    }

    async update(id: number, patch: Partial<QueuedCommand>): Promise<void> {
        await getLocalDB().syncQueue.update(id, patch);
    }

    async supersede(projectId: string, coalesceKey: string, exceptId?: number): Promise<void> {
        const rows = await getLocalDB()
            .syncQueue.where("projectId")
            .equals(projectId)
            .filter((r) => r.coalesceKey === coalesceKey && r.id !== exceptId)
            .toArray();
        const ids = rows.map((r) => r.id).filter((id): id is number => id !== undefined);
        if (ids.length) await getLocalDB().syncQueue.bulkDelete(ids);
    }
}

// ── Snapshot store object (injectable) ──────────────────────────────────────

export interface SnapshotStore {
    save(key: string, data: unknown): Promise<void>;
    load<T = unknown>(key: string): Promise<T | null>;
    clear(key: string): Promise<void>;
}

export class DexieSnapshotStore implements SnapshotStore {
    save(key: string, data: unknown): Promise<void> {
        return saveTimelineSnapshot(key, data);
    }

    load<T = unknown>(key: string): Promise<T | null> {
        return loadTimelineSnapshot<T>(key);
    }

    clear(key: string): Promise<void> {
        return clearTimelineSnapshot(key);
    }
}
