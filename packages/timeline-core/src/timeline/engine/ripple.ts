// Ripple delete: closing the gap is an explicit action, never a side effect.

import type { EngineItem } from "./types";

export function resolveRippleDelete(
    items: EngineItem[],
    deletedId: string,
): Map<string, { start: number; trackId: string }> {
    const deleted = items.find((i) => i.id === deletedId);
    const result = new Map<string, { start: number; trackId: string }>();
    if (!deleted) return result;
    for (const it of items) {
        if (it.id === deletedId || it.trackId !== deleted.trackId) continue;
        if (it.start >= deleted.start + deleted.duration - 0.001) {
            result.set(it.id, { start: Math.max(0, Math.round((it.start - deleted.duration) * 1000) / 1000), trackId: it.trackId });
        }
    }
    return result;
}
