// Display formatting shared by the project list, media bin, and export dialog.
export function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatEdited(timestamp: number, now: number = Date.now()): string {
    const diff = Math.max(0, now - timestamp);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return "Edited just now";
    if (diff < hour) return `Edited ${Math.floor(diff / minute)} min ago`;
    if (diff < day) return `Edited ${Math.floor(diff / hour)} h ago`;
    if (diff < 7 * day) {
        const days = Math.floor(diff / day);
        return `Edited ${days} ${days === 1 ? "day" : "days"} ago`;
    }
    return `Edited ${new Date(timestamp).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}`;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** "Beach Trip!" -> "beach-trip.mp4". */
export function exportFileName(projectName: string): string {
    const slug = projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${slug || "opennan-studio"}.mp4`;
}
