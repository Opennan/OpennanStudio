// editor-layout.tsx:1859-2104: marker-range fit/trim, duplicate, and copy/lift/extract to the clipboard.
import { editing } from "@opennan/timeline-core";
import {
    commitBatch, commitCreates, commitUpdates, editableSelection, hasTimelineSelection, is, mod, type ShortcutRule,
} from "./keymap-context";

export const MARKER_RANGE_RULES: readonly ShortcutRule[] = [
    {
        id: "fit-selection-to-marker-range",
        source: "editor-layout.tsx:1859-1877",
        when: (e) => is(e, "f", "F") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineFitSelectionToMarkerRangeTargetCommits(
                r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.timelineMarkers, r.store.currentTime,
            ));
            return true;
        },
    },
    {
        id: "trim-selection-to-marker-range",
        source: "editor-layout.tsx:1879-1897",
        when: (e) => is(e, "t", "T") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineTrimSelectionToMarkerRangeTargetCommits(
                r.clips, r.tracks, r.store.timelineMarkers, r.store.selectedClipIds, r.clipId, r.store.currentTime,
            ));
            return true;
        },
    },
    {
        id: "overwrite-duplicate-marker-range",
        source: "editor-layout.tsx:1899-1929",
        when: (e) => is(e, "o", "O") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineOverwriteDuplicateMarkerRangePlan({
                clips: r.clipRows, tracks: r.tracks, markers: r.store.timelineMarkers, playheadTime: r.store.currentTime,
            });
            if (plan.inputs.length === 0 && plan.deleteIds.length === 0 && plan.commits.length === 0) return false;
            commitBatch(r, { creates: plan.inputs, updates: plan.commits, deleteIds: plan.deleteIds, description: "Overwrite duplicate marker range" }, true);
            return true;
        },
    },
    {
        id: "insert-duplicate-marker-range",
        source: "editor-layout.tsx:1931-1961",
        when: (e) => is(e, "d", "D") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineInsertDuplicateMarkerRangePlan({
                clips: r.clipRows, tracks: r.tracks, markers: r.store.timelineMarkers, playheadTime: r.store.currentTime,
            });
            if (plan.inputs.length === 0 && plan.commits.length === 0) return false;
            commitBatch(r, { creates: plan.inputs, updates: plan.commits, deleteIds: [], description: "Insert duplicate marker range" }, true);
            return true;
        },
    },
    {
        id: "insert-duplicate-selection",
        source: "editor-layout.tsx:1963-1995",
        when: (e) => is(e, "d", "D") && mod(e) && e.shiftKey && !e.altKey,
        run: (r) => {
            if (hasTimelineSelection(r)) r.event.preventDefault();
            if (editableSelection(r).size === 0) return true;
            const plan = editing.getTimelineInsertDuplicatePlan({
                clips: r.clipRows, tracks: r.tracks, selectedClipIds: r.store.selectedClipIds, selectedClipId: r.clipId,
            });
            if (plan.inputs.length === 0 && plan.commits.length === 0) return false;
            commitBatch(r, { creates: plan.inputs, updates: plan.commits, deleteIds: [], description: "Insert duplicate timeline clips" }, true);
            return true;
        },
    },
    {
        id: "duplicate-marker-range",
        source: "editor-layout.tsx:1997-2016",
        when: (e) => is(e, "d", "D") && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const inputs = editing.duplicateTimelineMarkerRange(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (inputs.length > 0) commitCreates(r, inputs);
            return true;
        },
    },
    {
        id: "duplicate-selection",
        source: "editor-layout.tsx:2018-2033",
        when: (e) => is(e, "d", "D") && mod(e) && !e.shiftKey,
        run: (r) => {
            if (hasTimelineSelection(r)) r.event.preventDefault();
            const ids = editableSelection(r);
            if (ids.size === 0) return false;
            commitCreates(r, editing.duplicateTimelineClips(r.clipRows, ids, r.tracks));
            return true;
        },
    },
    {
        id: "copy-marker-range",
        source: "editor-layout.tsx:2035-2046",
        when: (e) => is(e, "c", "C") && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const clipboard = editing.copyTimelineMarkerRange(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (clipboard) r.store.setTimelineClipboard(clipboard);
            return true;
        },
    },
    {
        id: "lift-marker-range-to-clipboard",
        source: "editor-layout.tsx:2048-2075",
        when: (e) => is(e, "l", "L") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineLiftMarkerRangeToClipboardPlan(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (plan) {
                r.store.setTimelineClipboard(plan.clipboard);
                commitBatch(r, { creates: plan.creates ?? [], updates: plan.commits, deleteIds: plan.deleteIds, description: "Lift marker range to clipboard" }, false);
            }
            return true;
        },
    },
    {
        id: "extract-marker-range-to-clipboard",
        source: "editor-layout.tsx:2077-2104",
        when: (e) => is(e, "c", "C") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const plan = editing.getTimelineExtractMarkerRangeToClipboardPlan(r.clipRows, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (plan) {
                r.store.setTimelineClipboard(plan.clipboard);
                commitBatch(r, { creates: plan.creates ?? [], updates: plan.commits, deleteIds: plan.deleteIds, description: "Extract marker range to clipboard" }, false);
            }
            return true;
        },
    },
];
