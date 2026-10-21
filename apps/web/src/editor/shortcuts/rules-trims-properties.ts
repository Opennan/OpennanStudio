// editor-layout.tsx:3011-3157: Q/W trims, marker removal and range selection, and clip property toggles.
import { commits, editing } from "@opennan/timeline-core";
import { commitRule, is, mod, replaceSelection, updateRunner, type ShortcutRule } from "./keymap-context";

export const TRIM_PROPERTY_RULES: readonly ShortcutRule[] = [
    {
        id: "trim-to-playhead",
        source: "editor-layout.tsx:3011-3039",
        when: (e) => is(e, "q", "Q", "w", "W") && !mod(e) && !e.altKey,
        run: (r) => {
            const edge = r.event.key.toLowerCase() === "q" ? "start" : "end";
            const trim = r.event.shiftKey ? editing.getTimelineRippleTrimTargetCommitsToPlayhead : editing.getTimelineTrimTargetCommitsToPlayhead;
            const list = trim(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime, edge);
            if (list.length === 0) return false;
            r.event.preventDefault();
            void commits.commitTimelineClipUpdates(list, updateRunner(r));
            return true;
        },
    },
    {
        id: "remove-marker-near-playhead",
        source: "editor-layout.tsx:3041-3046",
        when: (e) => is(e, "m", "M") && e.shiftKey && !mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            r.store.removeTimelineMarkerNear(r.store.currentTime);
            return true;
        },
    },
    {
        id: "clear-markers",
        source: "editor-layout.tsx:3048-3053",
        when: (e) => is(e, "m", "M") && e.shiftKey && mod(e) && e.altKey,
        run: (r) => {
            r.event.preventDefault();
            r.store.clearTimelineMarkers();
            return true;
        },
    },
    {
        id: "select-marker-range",
        source: "editor-layout.tsx:3055-3067",
        when: (e) => is(e, "m", "M") && e.shiftKey && mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            replaceSelection(r, editing.getTimelineMarkerRangeSelectionClipIds(r.clips, r.tracks, r.store.timelineMarkers, r.store.currentTime));
            return true;
        },
    },
    commitRule("toggle-mute", "editor-layout.tsx:3069-3085",
        (e) => is(e, "m", "M") && mod(e) && !e.shiftKey && !e.altKey,
        (r) => editing.getTimelineToggleClipMuteTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
    commitRule("reset-volume", "editor-layout.tsx:3087-3103",
        (e) => is(e, "m", "M") && mod(e) && e.altKey && !e.shiftKey,
        (r) => editing.getTimelineResetClipVolumeTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
    commitRule("toggle-lock", "editor-layout.tsx:3105-3121",
        (e) => is(e, "l", "L") && mod(e) && !e.shiftKey && !e.altKey,
        (r) => editing.getTimelineToggleClipLockTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
    commitRule("reset-trim", "editor-layout.tsx:3123-3139",
        (e) => is(e, "t", "T") && mod(e) && e.altKey && !e.shiftKey,
        (r) => editing.getTimelineResetClipTrimTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
    commitRule("toggle-visibility", "editor-layout.tsx:3141-3157",
        (e) => is(e, "h", "H") && mod(e) && e.shiftKey && !e.altKey,
        (r) => editing.getTimelineToggleClipVisibilityTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
];
