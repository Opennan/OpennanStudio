// Storage row shapes for the timeline sync queue (storage implementation is injected).

export type LocalSyncOp =
    | "createClip"
    | "createClips"
    | "updateClip"
    | "updateClips"
    | "deleteClip"
    | "deleteClips"
    | "splitClip"
    | "splitClips"
    | "updateTracks"
    | "command";

export interface LocalSyncQueueRow {
    // Auto-incremented primary key.
    id?: number;
    projectId: string;
    op: LocalSyncOp;
    // The mutation variables payload (already sanitized).
    payload: unknown;
    createdAt: number;
    attempts: number;
    // Epoch ms before which we should not retry (exponential backoff).
    nextAttemptAt: number;
    // Optional coalescing key: newer rows with the same key supersede older unsent rows.
    coalesceKey?: string;
}
