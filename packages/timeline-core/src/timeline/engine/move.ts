// INVARIANTS: see ../TIMELINE_RULES.md before changing these semantics.
// Free placement + push-right + crossing. One algorithm serves preview AND
// commit so what you see while dragging is byte-for-byte what gets saved.
//
// Crossing rule: dragging an item far enough that its proposed start passes a
// neighbor's start reorders them — the crossed neighbor hops to the other
// side, shifted by the moved item's duration (this is what makes swapping two
// scenes and inserting a scene between two others possible). Drags that do
// NOT pass a neighbor's start keep the old guarantees: leftward drags clamp
// at the previous item's end; rightward overlaps push later items right.

import type { EngineItem } from "./types";

const EPS = 0.001;

export function resolveMove(
    items: EngineItem[],
    movedIds: string[],
    deltaSeconds: number,
    targetTrackId?: string,
    primaryId?: string,
): Map<string, { start: number; trackId: string }> {
    const moved = new Set(movedIds);
    // targetTrackId only ever applies to the primary (anchor) item being
    // dragged. Default to the sole moved id for single-item drags so callers
    // that don't pass primaryId keep their previous behavior.
    const primary = primaryId ?? (movedIds.length === 1 ? movedIds[0] : undefined);
    const result = new Map<string, { start: number; trackId: string }>();

    // Clamp the group delta so no moved item goes below 0.
    let delta = deltaSeconds;
    for (const it of items) {
        if (moved.has(it.id)) delta = Math.max(delta, -it.start);
    }

    // Proposed placement for every item.
    const placed = items.map((it) => ({
        ...it,
        trackId: moved.has(it.id) && targetTrackId && it.id === primary ? targetTrackId : it.trackId,
        proposed: moved.has(it.id) ? it.start + delta : it.start,
        origStart: it.start,
        origTrackId: it.trackId,
        isMoved: moved.has(it.id),
    }));

    const tracks = new Set(placed.map((p) => p.trackId));
    for (const trackId of tracks) {
        const lane = placed.filter((p) => p.trackId === trackId);
        const movedLane = lane.filter((p) => p.isMoved && p.origTrackId === trackId);

        // Crossing — the intent separator between "slide" and "reorder": a
        // stationary neighbor flips to the other side ONLY when the moved
        // block's START passes that neighbor's MIDPOINT. Dropping on the far
        // half of a neighbor = slide (clamp/push as before); dropping past
        // its middle = reorder, shifted by the block's duration (leftward
        // crossings open an insert slot; rightward crossings close the gap
        // the block left behind). Cross-track arrivals reorder nothing.
        if (movedLane.length > 0) {
            const blockStart = Math.min(...movedLane.map((p) => p.proposed));
            const blockOrigStart = Math.min(...movedLane.map((p) => p.origStart));
            const blockDuration = movedLane.reduce((sum, p) => sum + p.duration, 0);
            for (const p of lane) {
                if (p.isMoved) continue;
                const originallyBefore = p.origStart < blockOrigStart;
                const midpoint = p.origStart + p.duration / 2;
                const nowBefore = midpoint < blockStart + EPS;
                if (originallyBefore && !nowBefore) {
                    p.proposed = p.origStart + blockDuration;
                } else if (!originallyBefore && nowBefore) {
                    p.proposed = Math.max(0, p.origStart - blockDuration);
                }
            }
        }

        // Sweep left→right in the (possibly reordered) sequence. Moved items
        // win their proposed spot when starts tie; anything overlapped gets
        // pushed right (never left).
        lane.sort((a, b) => (a.proposed - b.proposed) || (a.isMoved === b.isMoved ? (a.id < b.id ? -1 : 1) : a.isMoved ? -1 : 1));
        let cursor = 0;
        for (const p of lane) {
            const finalStart = Math.max(p.proposed, cursor);
            const original = items.find((i) => i.id === p.id)!;
            if (Math.abs(finalStart - original.start) > EPS || p.trackId !== original.trackId) {
                result.set(p.id, { start: round3(finalStart), trackId: p.trackId });
            }
            cursor = finalStart + p.duration;
        }
    }
    return result;
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}
