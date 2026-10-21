// editor-layout.tsx:2106-2223: copy, marker-range extract/lift, cut, and detach audio.
import { editing } from "@opennan/timeline-core";
import { commitBatch, editableSelection, hasTimelineSelection, is, mod, type ShortcutRule } from "./keymap-context";

export const CLIPBOARD_RULES: readonly ShortcutRule[] = [
    {
        id: "copy-selection",
        source: "editor-layout.tsx:2106-2114",
        when: (e) => is(e, "c", "C") && mod(e),
        run: (r) => {
            const ids = editing.getTimelineCopyTargetClipIds(r.store.selectedClipIds, r.clipId);
            if (ids.size === 0) {
                // One deliberate change to this branch: with a scene selected the key falls through to the
                // timeline's scene-strip copy (canvas-timeline.tsx:2842-2850). Clearing the clip clipboard
                // makes the next Ctrl/Cmd+V paste what was copied last (plan, "Keyboard shortcut parity").
                if (r.store.selectedSceneId && !r.event.altKey && !r.event.shiftKey) r.store.setTimelineClipboard(null);
                return false;
            }
            r.event.preventDefault();
            r.store.setTimelineClipboard(editing.copyTimelineClips(r.clipRows, ids, r.tracks));
            return true;
        },
    },
    {
        id: "extract-marker-range",
        source: "editor-layout.tsx:2116-2142",
        when: (e) => is(e, "x", "X") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineExtractMarkerRangePlan(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (plan) commitBatch(r, { creates: plan.creates ?? [], updates: plan.commits, deleteIds: plan.deleteIds, description: "Extract marker range" }, false);
            return true;
        },
    },
    {
        id: "lift-marker-range",
        source: "editor-layout.tsx:2144-2169",
        when: (e) => is(e, "x", "X") && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineLiftMarkerRangePlan(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (plan) commitBatch(r, { creates: plan.creates ?? [], updates: plan.commits, deleteIds: plan.deleteIds, description: "Lift marker range" }, false);
            return true;
        },
    },
    {
        id: "cut-selection",
        source: "editor-layout.tsx:2171-2189",
        when: (e) => is(e, "x", "X") && mod(e),
        run: (r) => {
            if (hasTimelineSelection(r)) r.event.preventDefault();
            const ids = editableSelection(r);
            if (ids.size === 0) return false;
            const cut = editing.cutTimelineClips(r.clipRows, ids, r.tracks);
            if (cut) {
                r.store.setTimelineClipboard(cut.clipboard);
                r.store.setSelectedClipIds(editing.getTimelineSelectionAfterDelete(r.store.selectedClipIds, new Set(cut.deleteIds), r.clips, r.tracks));
                void r.ctx.ops.onDeleteClips(cut.deleteIds);
            }
            return true;
        },
    },
    {
        id: "detach-audio",
        source: "editor-layout.tsx:2191-2223",
        when: (e) => is(e, "e", "E") && mod(e) && e.shiftKey && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            if (editableSelection(r).size === 0) return true;
            const plan = editing.getTimelineDetachAudioPlan(r.clipRows, r.tracks, r.store.selectedClipIds, r.clipId);
            if (plan.creates.length > 0 || plan.updates.length > 0) {
                commitBatch(r, { creates: plan.creates, updates: plan.updates, deleteIds: [], description: "Detach timeline audio" }, true);
            }
            return true;
        },
    },
];
