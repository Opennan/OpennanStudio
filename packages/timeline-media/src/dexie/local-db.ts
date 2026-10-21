"use client";
// Client-side IndexedDB database (Dexie) backing the local-first editor.
//
// Holds three kinds of durable, browser-local state so the editor can edit and
// preview instantly without waiting on the network:
//   - mediaBlobs:        imported files staged locally before/while uploading to R2
//   - timelineSnapshots: last-known timeline state per project for instant hydrate
//   - syncQueue:         durable, retryable edit commands flushed to the backend
//
// The server remains the canonical source of truth; this store is an instant
// local mirror plus an offline-safe outbox.

import Dexie, { type Table } from "dexie";
import type { LocalSyncQueueRow } from "@opennan/timeline-core/lib/sync-queue-types";
export type { LocalSyncOp, LocalSyncQueueRow } from "@opennan/timeline-core/lib/sync-queue-types";

export interface LocalMediaBlobRow {
    localId: string;
    blob: Blob;
    name: string;
    type: string;
    size: number;
    createdAt: number;
}

export interface LocalTimelineSnapshotRow {
    projectId: string;
    // JSON-serializable TimelineData ({ tracks, clips, canUndo, canRedo }).
    data: unknown;
    savedAt: number;
}

export class OpennanLocalDB extends Dexie {
    mediaBlobs!: Table<LocalMediaBlobRow, string>;
    timelineSnapshots!: Table<LocalTimelineSnapshotRow, string>;
    syncQueue!: Table<LocalSyncQueueRow, number>;

    constructor() {
        super("opennan-local");
        this.version(1).stores({
            mediaBlobs: "localId, createdAt",
            timelineSnapshots: "projectId, savedAt",
            syncQueue: "++id, projectId, coalesceKey, nextAttemptAt",
        });
    }
}

let dbInstance: OpennanLocalDB | null = null;

// Lazily construct the DB so it is only touched in the browser (never SSR).
export function getLocalDB(): OpennanLocalDB {
    if (typeof window === "undefined") {
        throw new Error("getLocalDB must only be called in the browser"); // i18n-ignore — internal log
    }
    if (!dbInstance) {
        dbInstance = new OpennanLocalDB();
    }
    return dbInstance;
}

// True when IndexedDB is usable in this environment (degrade gracefully if not).
export function isLocalDBAvailable(): boolean {
    return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

// Test/teardown helper: drops the in-memory singleton (does not delete data).
export function __resetLocalDBSingletonForTests(): void {
    dbInstance = null;
}
