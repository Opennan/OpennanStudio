// Optional IndexedDB (Dexie) adapters. Import from "@opennan/timeline-media/dexie";
// requires the optional peer dependency "dexie".
export { OpennanLocalDB, getLocalDB, isLocalDBAvailable, __resetLocalDBSingletonForTests } from "./dexie/local-db";
export type { LocalMediaBlobRow, LocalTimelineSnapshotRow, LocalSyncOp, LocalSyncQueueRow } from "./dexie/local-db";
export {
    DexieSnapshotStore,
    DexieSyncQueueStore,
    clearTimelineSnapshot,
    loadTimelineSnapshot,
    saveTimelineSnapshot,
    type SnapshotStore,
} from "./dexie/timeline-local-store";
