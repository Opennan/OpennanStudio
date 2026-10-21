// editor-layout.tsx:2225-2509: the paste family.
import { editing, type TimelineClipCommand } from "@opennan/timeline-core";
import { commitBatch, commitCreates, editableSelection, is, mod, type ShortcutRule, type ShortcutRun } from "./keymap-context";

type PastePlan = { inputs: TimelineClipCommand["creates"]; commits: TimelineClipCommand["updates"]; deleteIds?: string[] };

/** The paste-plan branches: commit when the plan does anything, otherwise fall through. */
function commitPastePlan(r: ShortcutRun, plan: PastePlan, description: string, withDeletes: boolean): boolean {
    const deleteIds = withDeletes ? plan.deleteIds ?? [] : [];
    if (plan.inputs.length === 0 && deleteIds.length === 0 && plan.commits.length === 0) return false;
    r.event.preventDefault();
    commitBatch(r, { creates: plan.inputs, updates: plan.commits, deleteIds, description }, true);
    return true;
}

function markerPasteInput(r: ShortcutRun) {
    return { clipboard: r.store.timelineClipboard, clips: r.clipRows, tracks: r.tracks, markers: r.store.timelineMarkers, playheadTime: r.store.currentTime };
}

function pasteTime(r: ShortcutRun): number {
    return editing.getTimelinePasteTargetTime(r.clips, editableSelection(r), r.store.currentTime, r.tracks);
}

export const PASTE_RULES: readonly ShortcutRule[] = [
    {
        id: "replace-marker-range-paste",
        source: "editor-layout.tsx:2225-2256",
        when: (e) => is(e, "r", "R") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => commitPastePlan(r, editing.getTimelineReplaceMarkerRangePastePlan(markerPasteInput(r)), "Replace marker range with timeline clipboard", true),
    },
    {
        id: "insert-paste-at-marker-in",
        source: "editor-layout.tsx:2258-2289",
        when: (e) => is(e, "y", "Y") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => commitPastePlan(r, editing.getTimelineInsertMarkerRangePastePlan(markerPasteInput(r)), "Insert paste at marker in", false),
    },
    {
        id: "insert-paste-at-marker-out",
        source: "editor-layout.tsx:2291-2322",
        when: (e) => is(e, "n", "N") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => commitPastePlan(r, editing.getTimelineInsertMarkerOutPastePlan(markerPasteInput(r)), "Insert paste at marker out", false),
    },
    {
        id: "overwrite-paste-at-marker-in",
        source: "editor-layout.tsx:2324-2355",
        when: (e) => is(e, "u", "U") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => commitPastePlan(r, editing.getTimelineOverwriteMarkerRangePastePlan(markerPasteInput(r)), "Overwrite paste at marker in", true),
    },
    {
        id: "overwrite-paste-at-marker-out",
        source: "editor-layout.tsx:2357-2388",
        when: (e) => is(e, "j", "J") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => commitPastePlan(r, editing.getTimelineOverwriteMarkerOutPastePlan(markerPasteInput(r)), "Overwrite paste at marker out", true),
    },
    {
        id: "replace-selection-paste",
        source: "editor-layout.tsx:2390-2422",
        when: (e) => is(e, "v", "V") && mod(e) && e.shiftKey && e.altKey,
        run: (r) => commitPastePlan(r, editing.getTimelineReplaceSelectionPastePlan({
            clipboard: r.store.timelineClipboard, clips: r.clipRows, tracks: r.tracks,
            selectedClipIds: r.store.selectedClipIds, selectedClipId: r.clipId, playheadTime: r.store.currentTime,
        }), "Replace selected timeline clips", true),
    },
    {
        id: "insert-paste",
        source: "editor-layout.tsx:2424-2455",
        when: (e) => is(e, "v", "V") && mod(e) && e.shiftKey && !e.altKey,
        run: (r) => {
            const plan = editing.getTimelineInsertPastePlan({ clipboard: r.store.timelineClipboard, clips: r.clipRows, tracks: r.tracks, startTime: pasteTime(r) });
            if (plan.inputs.length === 0) return false;
            r.event.preventDefault();
            commitBatch(r, { creates: plan.inputs, updates: plan.commits, deleteIds: [], description: "Insert paste timeline clips" }, true);
            return true;
        },
    },
    {
        id: "overwrite-paste",
        source: "editor-layout.tsx:2457-2488",
        when: (e) => is(e, "v", "V") && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => commitPastePlan(r, editing.getTimelineOverwritePastePlan({
            clipboard: r.store.timelineClipboard, clips: r.clipRows, tracks: r.tracks, startTime: pasteTime(r),
        }), "Overwrite paste timeline clips", true),
    },
    {
        id: "paste",
        source: "editor-layout.tsx:2490-2509",
        when: (e) => is(e, "v", "V") && mod(e) && !e.shiftKey && !e.altKey,
        run: (r) => {
            const inputs = editing.getEditableTimelinePasteInputs(
                editing.pasteTimelineClips(r.store.timelineClipboard, pasteTime(r)), r.tracks, r.clipRows,
            );
            if (inputs.length === 0) return false;
            r.event.preventDefault();
            commitCreates(r, inputs);
            return true;
        },
    },
];
