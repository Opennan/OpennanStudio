// Studio's words for cloud projects: the sync chip, its popover, the storage meter, and upload refusals.
import { isCloudProjectId, serverIdOf, type StorageInfo, type SyncState } from "@opennan/cloud-backend";
import { formatBytes } from "../ui/format";

export const SAVED = "Saved";
export const STORAGE_SOON = "More storage is coming soon.";

export function syncLabel(state: SyncState | null): string {
    if (!state) return "Opening…";
    switch (state.kind) {
        case "saved": return SAVED;
        case "syncing": return state.uploading > 0 ? `Uploading ${state.uploaded + 1} of ${state.uploaded + state.uploading}` : "Syncing…";
        case "offline": return state.pending > 0 ? `Offline (${state.pending} pending)` : "Offline";
        case "conflict": return "Conflict";
        case "signed-out": return "Sign in to sync";
        case "over-quota": return "Storage full";
    }
}

function clock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function syncDetail(state: SyncState | null): string {
    if (!state) return "Opening the project from OpenNan.";
    switch (state.kind) {
        case "saved": return `Saved to OpenNan · ${clock(state.at)}`;
        case "syncing": return state.message ?? (state.pending > 0 ? `${state.pending} ${state.pending === 1 ? "change" : "changes"} on the way to OpenNan.` : "Sending your changes to OpenNan.");
        case "offline": return "Edits are saved on this device and will sync when you're back online. Cloud AI tools are paused.";
        case "conflict": return state.items.length === 1 ? "1 edit was not applied." : `${state.items.length} edits were not applied.`;
        case "signed-out": return "Your edits are kept on this device. Sign in with OpenNan to sync them.";
        case "over-quota": return state.reason === "project-data"
            ? `This project's data is over your cloud storage. Edits are kept on this device. ${STORAGE_SOON}`
            : state.reason === "pool-full"
                ? "OpenNan cloud storage is busy right now. Edits still sync; new media will upload later."
                : `Your cloud storage is full. Edits still sync; new media can't upload. ${STORAGE_SOON}`;
    }
}

export function storageLine(storage: StorageInfo): string {
    return `${formatBytes(storage.mediaBytes)} of ${formatBytes(storage.mediaLimitBytes)}`;
}

export function storageFull(storage: StorageInfo): boolean {
    return storage.state === "over_quota" || (storage.mediaLimitBytes > 0 && storage.mediaBytes >= storage.mediaLimitBytes);
}

export function storageFullMessage(storage: StorageInfo): string {
    return `Cloud storage is full (${storageLine(storage)}). Edits still sync; new media can't upload. ${STORAGE_SOON}`;
}

/** Percent 0..100 for a meter. */
export function share(used: number, limit: number): number {
    if (!(limit > 0)) return 0;
    return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

export function deletedIn(deletedAt: number | null | undefined, now = Date.now()): string {
    if (!deletedAt) return "In the trash";
    const days = Math.max(0, Math.ceil((deletedAt + 7 * 86_400_000 - now) / 86_400_000));
    return days === 0 ? "Deleted today" : days === 1 ? "Deleted in 1 day" : `Deleted in ${days} days`;
}

const ERROR_COPY: Record<string, string> = {
    storage_quota_exceeded: `Your OpenNan cloud storage is full. ${STORAGE_SOON}`,
    free_storage_pool_full: "OpenNan cloud storage is busy right now. Try again later.",
    upload_daily_limit: "You reached today's upload limit. Try again tomorrow.",
    project_data_quota_exceeded: `This project is larger than your cloud storage allows. ${STORAGE_SOON}`,
    project_too_large: "This project is too large for a cloud project (5,000 clips or 1,000 scenes at most).",
    upload_gateway_unavailable: "Uploads to OpenNan are not available right now. Try again in a minute.",
    signed_out: "Sign in with OpenNan to use cloud projects.",
    invalid_api_key: "Sign in with OpenNan again to use cloud projects.",
    network: "Can't reach OpenNan. Check your connection and try again.",
    rate_limited: "Too many requests to OpenNan. Try again in a minute.",
    rate_limit_exceeded: "Too many requests to OpenNan. Try again in a minute.",
    forbidden: "This OpenNan key can't use cloud projects. Sign in with OpenNan again.",
    not_found: "This cloud project is no longer on OpenNan.",
};

/** Studio's words for a cloud failure (never raw server text). */
export function cloudErrorMessage(error: unknown): string {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && ERROR_COPY[code]) return ERROR_COPY[code]!;
    if (error instanceof Error && (error.name === "CloudStorageFullError" || error.name === "AbortError")) return error.name === "AbortError" ? "Cancelled." : error.message;
    if (typeof code === "string" && (code === "unsupported_type" || code === "missing_file") && error instanceof Error) return error.message;
    return "Something went wrong with OpenNan. Try again.";
}

/** Where a cloud project's shots made on opennan.com are edited: its page on opennan.com (phase 9a.1). */
export function shotsEditUrl(consoleOrigin: string, projectId: string): string | null {
    if (!isCloudProjectId(projectId)) return null;
    return `${consoleOrigin.replace(/\/+$/, "")}/video/${encodeURIComponent(serverIdOf(projectId))}`;
}
