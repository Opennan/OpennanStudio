// Layout reads stored starts only. No derivation, no modes.

import type { EngineItem } from "./types";

export function itemsOnTrack(items: EngineItem[], trackId: string): EngineItem[] {
    return items
        .filter((i) => i.trackId === trackId)
        .sort((a, b) => (a.start - b.start) || (a.id < b.id ? -1 : 1));
}

export function trackEnd(items: EngineItem[], trackId: string): number {
    return items.reduce((end, i) => (i.trackId === trackId ? Math.max(end, i.start + i.duration) : end), 0);
}

export function contentEnd(items: EngineItem[]): number {
    return items.reduce((end, i) => Math.max(end, i.start + i.duration), 0);
}

export function overlaps(a: EngineItem, b: EngineItem): boolean {
    if (a.trackId !== b.trackId) return false;
    return a.start < b.start + b.duration && b.start < a.start + a.duration;
}
