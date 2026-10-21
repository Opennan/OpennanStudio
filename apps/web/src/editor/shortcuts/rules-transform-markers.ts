// editor-layout.tsx:3159-3240: flip/rotate, transform reset, and marker placement.
import { editing } from "@opennan/timeline-core";
import { commitRule, is, mod, type ShortcutRule } from "./keymap-context";

export const TRANSFORM_MARKER_RULES: readonly ShortcutRule[] = [
    commitRule("flip-or-rotate", "editor-layout.tsx:3159-3184",
        (e) => is(e, "H", "V", "R") && e.altKey && e.shiftKey && !mod(e),
        (r) => {
            if (r.event.key === "H") return editing.getTimelineToggleHorizontalFlipTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId);
            if (r.event.key === "V") return editing.getTimelineToggleVerticalFlipTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId);
            return editing.getTimelineRotateVisualTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, 90);
        }),
    commitRule("reset-transform", "editor-layout.tsx:3186-3202",
        (e) => is(e, "r", "R") && mod(e) && e.altKey && !e.shiftKey,
        (r) => editing.getTimelineResetVisualTransformTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
    {
        id: "selected-range-markers",
        source: "editor-layout.tsx:3204-3216",
        when: (e) => is(e, "m", "M") && e.altKey && e.shiftKey && !mod(e),
        run: (r) => {
            r.event.preventDefault();
            const targets = editing.getTimelineSelectedRangeMarkerTargets(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.timelineMarkers);
            for (const marker of targets) r.store.addTimelineMarker(marker.time, marker.label);
            return true;
        },
    },
    {
        id: "selected-boundary-markers",
        source: "editor-layout.tsx:3218-3230",
        when: (e) => is(e, "m", "M") && e.altKey && !e.shiftKey && !mod(e),
        run: (r) => {
            r.event.preventDefault();
            const times = editing.getTimelineSelectedClipBoundaryMarkerTimes(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.timelineMarkers);
            for (const time of times) r.store.addTimelineMarker(time);
            return true;
        },
    },
    {
        id: "toggle-marker",
        source: "editor-layout.tsx:3232-3240",
        when: (e) => is(e, "m", "M") && !mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const near = r.store.timelineMarkers.some((marker) => Math.abs(marker.time - r.store.currentTime) <= 0.15);
            if (near) r.store.removeTimelineMarkerNear(r.store.currentTime);
            else r.store.addTimelineMarker(r.store.currentTime);
            return true;
        },
    },
];
