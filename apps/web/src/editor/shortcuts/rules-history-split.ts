// editor-layout.tsx:1743-1857: Escape, undo/redo, and the split shortcuts.
import { commits, editing } from "@opennan/timeline-core";
import { commitSplits, is, mod, selectCreated, splitRunner, type ShortcutRule } from "./keymap-context";

export const HISTORY_SPLIT_RULES: readonly ShortcutRule[] = [
    {
        id: "escape",
        source: "editor-layout.tsx:1743-1753",
        when: (e) => e.key === "Escape",
        run: ({ event, store, clipId }) => {
            const shouldExitTool = store.toolMode !== "select";
            const shouldClearSelection = store.selectedClipIds.size > 0 || Boolean(clipId)
                || store.selectedSceneId || store.selectedTransition || store.selectedAudioTarget;
            if (shouldExitTool || shouldClearSelection) {
                event.preventDefault();
                if (shouldExitTool) store.setToolMode("select");
                else store.clearSelection();
            }
            return true;
        },
    },
    {
        id: "undo-5",
        source: "editor-layout.tsx:1755-1760",
        when: (e) => is(e, "z", "Z") && mod(e) && e.altKey && !e.shiftKey,
        run: ({ event, ctx }) => {
            event.preventDefault();
            void ctx.ops.onUndo(5);
            return true;
        },
    },
    {
        id: "redo-5",
        source: "editor-layout.tsx:1762-1767",
        when: (e) => is(e, "z", "Z") && mod(e) && e.altKey && e.shiftKey,
        run: ({ event, ctx }) => {
            event.preventDefault();
            void ctx.ops.onRedo(5);
            return true;
        },
    },
    {
        id: "undo",
        source: "editor-layout.tsx:1769-1774",
        when: (e) => is(e, "z", "Z") && mod(e) && !e.altKey && !e.shiftKey,
        run: ({ event, ctx }) => {
            event.preventDefault();
            void ctx.ops.onUndo();
            return true;
        },
    },
    {
        id: "redo",
        source: "editor-layout.tsx:1776-1781",
        when: (e) => is(e, "z", "Z") && mod(e) && !e.altKey && e.shiftKey,
        run: ({ event, ctx }) => {
            event.preventDefault();
            void ctx.ops.onRedo();
            return true;
        },
    },
    {
        id: "redo-y",
        source: "editor-layout.tsx:1782-1786",
        when: (e) => is(e, "y", "Y") && mod(e) && !e.altKey && !e.shiftKey,
        run: ({ event, ctx }) => {
            event.preventDefault();
            void ctx.ops.onRedo();
            return true;
        },
    },
    {
        id: "split-selection-at-nearest-marker",
        source: "editor-layout.tsx:1788-1806",
        when: (e) => is(e, "b", "B") && mod(e) && e.shiftKey && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const split = editing.getTimelineSplitTargetAtNearestMarker(
                r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.timelineMarkers, r.store.currentTime,
            );
            if (split) commitSplits(r, split.clipIds, split.splitTime);
            return true;
        },
    },
    {
        id: "split-all-tracks-at-playhead",
        source: "editor-layout.tsx:1808-1823",
        when: (e) => is(e, "b", "B") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const ids = editing.getTimelineSplitAllTrackClipIdsAtPlayhead(r.clips, r.tracks, r.store.currentTime);
            if (ids.length > 0) commitSplits(r, ids, r.store.currentTime);
            return true;
        },
    },
    {
        id: "split-at-playhead",
        source: "editor-layout.tsx:1825-1832",
        when: (e) => is(e, "b", "B") && mod(e),
        run: ({ event, ctx }) => {
            event.preventDefault();
            ctx.splitAtPlayhead(event.altKey);
            return true;
        },
    },
    {
        id: "split-marker-range-boundaries",
        source: "editor-layout.tsx:1834-1857",
        when: (e) => is(e, "s", "S") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const targets = editing.getTimelineSplitMarkerRangeBoundaryTargets(r.clips, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (targets.length > 0) {
                void (async () => {
                    const created: Array<{ id?: string | null } | null> = [];
                    for (const target of targets) {
                        created.push(...await commits.commitTimelineClipSplits(target.clipIds, target.splitTime, splitRunner(r)));
                    }
                    selectCreated(r, created);
                })();
            }
            return true;
        },
    },
];
