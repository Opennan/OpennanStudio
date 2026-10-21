// editor-layout.tsx:3242-3411: marker snapping, range and track selection, jumps, and Space.
import { editing } from "@opennan/timeline-core";
import {
    altShift, commitRule, editableSelection, is, mod, plain, replaceSelection, seek, type ShortcutRule,
} from "./keymap-context";

export const SELECT_JUMP_RULES: readonly ShortcutRule[] = [
    commitRule("trim-selection-to-nearest-marker", "editor-layout.tsx:3242-3260",
        (e) => is(e, "[", "]") && mod(e) && e.altKey && e.shiftKey,
        (r) => editing.getTimelineTrimSelectionToNearestMarkerTargetCommits(
            r.clips, r.tracks, r.store.timelineMarkers, r.store.selectedClipIds, r.clipId, r.event.key === "[" ? "start" : "end",
        )),
    commitRule("align-selection-to-nearest-marker", "editor-layout.tsx:3262-3280",
        (e) => is(e, "[", "]") && mod(e) && e.altKey && !e.shiftKey,
        (r) => editing.getTimelineAlignSelectionToNearestMarkerTargetCommits(
            r.clips, r.tracks, r.store.timelineMarkers, r.store.selectedClipIds, r.clipId, r.event.key === "[" ? "start" : "end",
        )),
    {
        id: "select-track-range",
        source: "editor-layout.tsx:3282-3298",
        when: (e) => is(e, "[", "]") && altShift(e),
        run: (r) => {
            r.event.preventDefault();
            if (editableSelection(r).size === 0) return true;
            replaceSelection(r, editing.getTimelineTrackRangeSelectionClipIds(
                r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime, r.event.key === "[" ? -1 : 1,
            ));
            return true;
        },
    },
    {
        id: "select-track",
        source: "editor-layout.tsx:3300-3314",
        when: (e) => editing.getTimelineTrackSelectionShortcut(e),
        run: (r) => {
            r.event.preventDefault();
            if (editableSelection(r).size === 0) return true;
            replaceSelection(r, editing.getTimelineTrackSelectionClipIds(r.clips, r.tracks, r.store.selectedClipIds, r.clipId));
            return true;
        },
    },
    {
        id: "select-linked",
        source: "editor-layout.tsx:3316-3329",
        when: (e) => is(e, "l", "L") && e.shiftKey && mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            if (editableSelection(r).size === 0) return true;
            r.store.setSelectedClipIds(editing.getTimelineLinkedSelectionClipIds(r.clips, r.tracks, r.store.selectedClipIds, r.clipId));
            return true;
        },
    },
    {
        id: "select-type",
        source: "editor-layout.tsx:3331-3344",
        when: (e) => is(e, "t", "T") && altShift(e),
        run: (r) => {
            r.event.preventDefault();
            if (editableSelection(r).size === 0) return true;
            r.store.setSelectedClipIds(editing.getTimelineTypeSelectionClipIds(r.clips, r.tracks, r.store.selectedClipIds, r.clipId));
            return true;
        },
    },
    {
        id: "select-range",
        source: "editor-layout.tsx:3346-3359",
        when: (e) => editing.getTimelineRangeSelectionShortcut(e) !== null,
        run: (r) => {
            r.event.preventDefault();
            const direction = editing.getTimelineRangeSelectionShortcut(r.event) as -1 | 1;
            replaceSelection(r, editing.getTimelineRangeSelectionClipIds(r.clips, r.tracks, r.store.currentTime, direction));
            return true;
        },
    },
    {
        id: "jump-marker",
        source: "editor-layout.tsx:3361-3374",
        when: (e) => is(e, "[", "]") && plain(e),
        run: (r) => {
            const target = editing.getAdjacentTimelineMarkerTime(r.store.timelineMarkers, r.store.currentTime, r.event.key === "[" ? -1 : 1);
            if (target === null) return false;
            r.event.preventDefault();
            seek(r, target);
            return true;
        },
    },
    {
        id: "jump-selection-boundary",
        source: "editor-layout.tsx:3376-3391",
        when: (e) => is(e, "Home", "End") && mod(e) && e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const target = editing.getTimelineSelectionBoundaryTime(
                r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.event.key === "Home" ? "start" : "end",
            );
            if (target !== null) seek(r, target);
            return true;
        },
    },
    {
        id: "jump-start-end",
        source: "editor-layout.tsx:3393-3403",
        when: (e) => is(e, "Home", "End") && !mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            seek(r, r.event.key === "Home" ? 0 : editing.getTimelineNavigationEndTime({ clips: r.clips, scenes: r.scenes }));
            return true;
        },
    },
    {
        id: "play-pause",
        source: "editor-layout.tsx:3405-3411",
        when: (e) => e.key === " ",
        run: (r) => {
            r.event.preventDefault();
            r.store.setPlayRequest(r.store.isPlaying ? "pause" : "play");
            r.store.setShuttleSpeed(0);
            return true;
        },
    },
];
