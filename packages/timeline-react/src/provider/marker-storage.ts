// Per-project marker persistence, as the host did around the app store
// (editor-layout.tsx:482-494 over SRC/stores/editor-store.ts:26-46).
import type { TimelineMarker } from "@opennan/timeline-core";

export interface TimelineMarkerStorage {
    load(projectId: string): TimelineMarker[];
    save(projectId: string, markers: TimelineMarker[]): void;
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createLocalStorageMarkerStorage(
    prefix = "opennan-studio:markers:",
    storage: KeyValueStorage | null = typeof localStorage !== "undefined" ? localStorage : null,
): TimelineMarkerStorage {
    return {
        load(projectId) {
            try {
                const raw = storage?.getItem(prefix + projectId);
                const parsed: unknown = raw ? JSON.parse(raw) : [];
                return Array.isArray(parsed)
                    ? parsed.filter((m): m is TimelineMarker => Boolean(m) && typeof m.id === "string" && Number.isFinite(m.time))
                    : [];
            } catch {
                return [];
            }
        },
        save(projectId, markers) {
            try {
                if (markers.length === 0) storage?.removeItem(prefix + projectId);
                else storage?.setItem(prefix + projectId, JSON.stringify(markers));
            } catch {
                // storage full or blocked: markers stay session-only (editor-store.ts:45)
            }
        },
    };
}
