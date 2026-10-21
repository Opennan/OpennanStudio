// INVARIANTS: see ../TIMELINE_RULES.md before changing these semantics.
// Builds the exact updateSceneTimelinePositions payload from an engine change
// map. One write path: what resolveMove returned is what gets saved.

export function buildScenePositionWrites(
    changes: Map<string, { start: number; trackId: string }>,
    sceneIds: Set<string>,
): { sceneId: string; timelinePositionSeconds: number; trackIndex: number }[] {
    const writes: { sceneId: string; timelinePositionSeconds: number; trackIndex: number }[] = [];
    for (const [id, change] of changes) {
        if (!sceneIds.has(id)) continue;
        const trackIndex = Number(change.trackId.replace(/^v/, "")) || 1;
        // Never write EXACTLY 0: the layout treats 0 as "no explicit position"
        // (legacy-row compatibility) and falls back to array-order placement,
        // which is stale for a beat after a swap — the timeline visibly
        // collapses until the server reorder lands. 1ms is visually zero.
        writes.push({ sceneId: id, timelinePositionSeconds: Math.max(0.001, change.start), trackIndex });
    }
    return writes.sort((a, b) => (a.sceneId < b.sceneId ? -1 : 1));
}
