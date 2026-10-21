// editor-layout.tsx:2511-2639: in/out markers and gap closing.
import { editing } from "@opennan/timeline-core";
import { commitUpdates, deleteKey, is, mod, plain, type ShortcutRule } from "./keymap-context";

export const MARKER_GAP_RULES: readonly ShortcutRule[] = [
    {
        id: "in-out-marker",
        source: "editor-layout.tsx:2511-2516",
        when: (e) => is(e, "i", "I", "o", "O") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.addTimelineMarker(r.store.currentTime, r.event.key.toLowerCase() === "i" ? "In" : "Out");
            return true;
        },
    },
    {
        id: "close-marker-range-gap",
        source: "editor-layout.tsx:2518-2534",
        when: (e) => is(e, "i", "I") && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineDeleteMarkerRangeGapTargetCommits(r.clips, r.tracks, r.store.timelineMarkers, r.store.currentTime));
            return true;
        },
    },
    {
        id: "close-marker-out-gap",
        source: "editor-layout.tsx:2536-2552",
        when: (e) => is(e, "h", "H") && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineDeleteMarkerOutGapTargetCommits(r.clips, r.tracks, r.store.timelineMarkers, r.store.currentTime));
            return true;
        },
    },
    {
        id: "close-every-track-gap-at-playhead",
        source: "editor-layout.tsx:2554-2569",
        when: (e) => deleteKey(e) && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineDeleteAllTrackGapsAtPlayheadTargetCommits(r.clips, r.tracks, r.store.currentTime));
            return true;
        },
    },
    {
        id: "close-shared-gap-at-playhead",
        source: "editor-layout.tsx:2571-2586",
        when: (e) => deleteKey(e) && mod(e) && e.shiftKey && e.altKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineDeleteGlobalGapTargetCommits(r.clips, r.tracks, r.store.currentTime));
            return true;
        },
    },
    {
        id: "close-active-track-gap-at-playhead",
        source: "editor-layout.tsx:2588-2605",
        when: (e) => deleteKey(e) && mod(e) && e.shiftKey && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineDeleteGapTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime));
            return true;
        },
    },
    {
        id: "close-every-gap",
        source: "editor-layout.tsx:2607-2621",
        when: (e) => is(e, "p", "P") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineCloseAllTrackGapsTargetCommits(r.clips, r.tracks));
            return true;
        },
    },
    {
        id: "close-active-track-gaps",
        source: "editor-layout.tsx:2623-2639",
        when: (e) => is(e, "p", "P") && mod(e) && e.altKey && !e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineCloseActiveTrackGapsTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId));
            return true;
        },
    },
];
