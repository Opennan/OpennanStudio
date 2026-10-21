// editor-layout.tsx:2641-2905: Delete, invert/select-to-playhead/select-all, and gap insertion.
import { editing } from "@opennan/timeline-core";
import {
    commitBatch, commitUpdates, deleteKey, editableSelection, is, mod, plain, replaceSelection, type ShortcutRule,
} from "./keymap-context";

/** The source's toast icon for a fully locked selection (:2731). */
const LOCK_ICON = "\u{1F512}";

export const DELETE_SELECT_RULES: readonly ShortcutRule[] = [
    {
        id: "delete",
        source: "editor-layout.tsx:2641-2752",
        when: deleteKey,
        run: (r) => {
            const { event, store, clipId } = r;
            // Another handler (the canvas scene/marker handler) already consumed this key.
            if (event.defaultPrevented) return true;
            if (store.selectedMarkerId && plain(event)) {
                event.preventDefault();
                store.removeTimelineMarker(store.selectedMarkerId);
                return true;
            }
            const ids = store.selectedClipIds;
            const anySelected = ids.size > 0 || Boolean(clipId);
            if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && anySelected) {
                event.preventDefault();
                commitUpdates(r, editing.getTimelineDeleteNearestKeyframeTargetCommits(r.clips, r.tracks, ids, clipId, store.currentTime));
                return true;
            }
            if (event.shiftKey && event.altKey && anySelected) {
                const selected = editableSelection(r);
                const ripple = editing.rippleDeleteTimelineClipsGlobally(r.clipRows, r.tracks, selected);
                if (ripple) {
                    event.preventDefault();
                    store.setSelectedClipIds(editing.getTimelineSelectionAfterDelete(ids, selected, r.clips, r.tracks));
                    commitBatch(r, { creates: ripple.creates ?? [], updates: ripple.commits, deleteIds: ripple.deleteIds, description: "Global ripple delete timeline clips" }, false);
                    return true;
                }
            }
            if (event.shiftKey && anySelected) {
                const selected = editableSelection(r);
                const ripple = editing.rippleDeleteTimelineClips(r.clipRows, selected, r.tracks);
                if (ripple) {
                    event.preventDefault();
                    store.setSelectedClipIds(editing.getTimelineSelectionAfterDelete(ids, selected, r.clips, r.tracks));
                    commitBatch(r, { creates: ripple.creates ?? [], updates: ripple.commits, deleteIds: ripple.deleteIds, description: "Ripple delete timeline clips" }, false);
                    return true;
                }
            }
            if (ids.size > 0) {
                event.preventDefault();
                const editable = editableSelection(r);
                if (editable.size > 0) {
                    store.setSelectedClipIds(editing.getTimelineSelectionAfterDelete(ids, editable, r.clips, r.tracks));
                    void r.ctx.ops.onDeleteClips([...editable]);
                } else {
                    // Selection is entirely locked: same feedback as the toolbar (:2728-2731).
                    r.ctx.toast(r.ctx.messages.audioLockedDelete, { icon: LOCK_ICON });
                }
                return true;
            }
            if (clipId) {
                if (editableSelection(r).has(clipId)) {
                    event.preventDefault();
                    store.setSelectedClipIds(editing.getTimelineSelectionAfterDelete(new Set([clipId]), new Set([clipId]), r.clips, r.tracks));
                    void r.ctx.ops.onDeleteClip(clipId);
                }
                return true;
            }
            // A selected scene or transition deletes through the timeline's own handler (:2744-2751).
            if (store.selectedSceneId || store.selectedTransition) {
                event.preventDefault();
                store.setDeleteSelectionRequest(r.ctx.now());
                return true;
            }
            return false;
        },
    },
    {
        id: "invert-selection",
        source: "editor-layout.tsx:2754-2766",
        when: (e) => is(e, "a", "A") && mod(e) && e.shiftKey && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            replaceSelection(r, editing.getTimelineInvertSelectionClipIds(r.clips, r.tracks, r.store.selectedClipIds, r.clipId));
            return true;
        },
    },
    {
        id: "select-to-playhead",
        source: "editor-layout.tsx:2768-2781",
        when: (e) => is(e, "d", "D") && e.altKey && e.shiftKey && !mod(e),
        run: (r) => {
            r.event.preventDefault();
            replaceSelection(r, editing.getTimelineSelectionToPlayheadClipIds(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime));
            return true;
        },
    },
    {
        id: "select-all",
        source: "editor-layout.tsx:2783-2792",
        when: (e) => is(e, "a", "A") && mod(e) && !e.shiftKey && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const all = editing.getTimelineSelectAllClipIds(r.clips, r.tracks);
            if (all.size > 0) replaceSelection(r, all);
            return true;
        },
    },
    {
        id: "insert-marker-range-gap",
        source: "editor-layout.tsx:2794-2820",
        when: (e) => is(e, "i", "I") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineInsertMarkerRangeGapPlan(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (plan.commits.length > 0 || plan.creates.length > 0) {
                commitBatch(r, { creates: plan.creates, updates: plan.commits, deleteIds: [], description: "Insert marker range timeline gap" }, false);
            }
            return true;
        },
    },
    {
        id: "insert-marker-out-gap",
        source: "editor-layout.tsx:2822-2848",
        when: (e) => is(e, "h", "H") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineInsertMarkerOutGapPlan(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (plan.commits.length > 0 || plan.creates.length > 0) {
                commitBatch(r, { creates: plan.creates, updates: plan.commits, deleteIds: [], description: "Insert marker out timeline gap" }, false);
            }
            return true;
        },
    },
    {
        id: "insert-global-gap",
        source: "editor-layout.tsx:2850-2876",
        when: (e) => is(e, "g", "G") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineInsertGlobalGapPlan(r.clipRows, r.tracks, r.store.currentTime, 1);
            if (plan.commits.length > 0 || plan.creates.length > 0) {
                commitBatch(r, { creates: plan.creates, updates: plan.commits, deleteIds: [], description: "Insert global timeline gap" }, false);
            }
            return true;
        },
    },
    {
        id: "insert-active-track-gap",
        source: "editor-layout.tsx:2878-2905",
        when: (e) => is(e, "g", "G") && mod(e) && e.shiftKey && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineInsertGapPlan(r.clipRows, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime, 1);
            if (plan.commits.length > 0 || plan.creates.length > 0) {
                commitBatch(r, { creates: plan.creates, updates: plan.commits, deleteIds: [], description: "Insert active track timeline gap" }, false);
            }
            return true;
        },
    },
];
