// Public types of cloud projects: the sync state the top bar shows, conflict items, and storage use.

export type SyncState =
    | { kind: "saved"; at: number }
    | { kind: "syncing"; pending: number; uploading: number; uploaded: number; message?: string }
    | { kind: "offline"; pending: number; since: number }
    | { kind: "conflict"; items: ConflictItem[]; pending: number }
    | { kind: "signed-out"; pending: number }
    | { kind: "over-quota"; reason: "storage" | "project-data" | "pool-full"; pending: number };

export interface ConflictItem {
    entity: "clip" | "scene" | "track" | "project";
    id: string;
    label: string;
    reason: "deleted" | "locked" | "id-in-use" | "refused";
    message: string;
    at: number;
}

export interface StorageInfo {
    mediaBytes: number;
    mediaLimitBytes: number;
    projectDataBytes: number;
    projectDataLimitBytes: number;
    tempBytes: number;
    tempLimitBytes: number;
    uploadsToday: number;
    uploadsPerDay: number;
    uploadBytesToday: number;
    uploadBytesPerDay: number;
    state: "ok" | "over_quota" | "grace" | "pool_full";
}

export function storageFromJson(body: Record<string, unknown>): StorageInfo {
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const limits = (body.limits ?? {}) as Record<string, unknown>;
    const today = (body.today ?? {}) as Record<string, unknown>;
    const state = body.state === "over_quota" || body.state === "grace" || body.state === "pool_full" ? body.state : "ok";
    return {
        mediaBytes: num(body.media_bytes), mediaLimitBytes: num(limits.media_bytes), projectDataBytes: num(body.project_data_bytes),
        projectDataLimitBytes: num(limits.project_data_bytes), tempBytes: num(body.temp_bytes), tempLimitBytes: num(body.temp_limit_bytes),
        uploadsToday: num(today.uploads), uploadsPerDay: num(limits.uploads_per_day), uploadBytesToday: num(today.upload_bytes),
        uploadBytesPerDay: num(limits.upload_bytes_per_day), state,
    };
}

/** The download cache of cloud media on this device (phase 9a.1), as Settings shows it. */
export interface CacheUsage {
    /** Bytes of finished downloads. */
    usedBytes: number;
    entries: number;
    /** The limit in force (the person's choice, or the default). */
    limitBytes: number;
    defaultLimitBytes: number;
    /** The largest limit this device offers (web: 80 % of the browser's quota), or null for no bound. */
    maxLimitBytes: number | null;
    /** Bytes open projects use now (never evicted). */
    pinnedBytes: number;
    /** The person chose the limit (false: the default). */
    custom: boolean;
}

export interface MediaCacheControl {
    usage(): Promise<CacheUsage>;
    /** A new limit (null: the default); the cache is trimmed to it at once. */
    setLimit(bytes: number | null): Promise<CacheUsage>;
    /** Evicts every downloaded file open projects don't use. */
    clear(): Promise<{ freedBytes: number; keptBytes: number }>;
}

export const GB = 1024 ** 3;
/** Limits Settings offers (bytes). */
export const CACHE_LIMIT_CHOICES: readonly number[] = Object.freeze([1, 2, 5, 10, 20, 50, 100].map((n) => n * GB));
export const MIN_CACHE_LIMIT_BYTES = 256 * 1024 ** 2;
