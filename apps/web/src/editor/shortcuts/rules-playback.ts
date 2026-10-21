// editor-layout.tsx:3547-3647: frame step, J/K/L shuttle, split at nearest marker, and keyframes.
import { editing } from "@opennan/timeline-core";
import { commitRule, commitSplits, is, mod, plain, type ShortcutRule } from "./keymap-context";

export const PLAYBACK_RULES: readonly ShortcutRule[] = [
    {
        id: "frame-back",
        source: "editor-layout.tsx:3547-3555",
        when: (e) => e.key === "," && plain(e),
        run: (r) => {
            r.event.preventDefault();
            const target = Math.max(0, r.store.currentTime - 1 / 30);
            r.store.setShuttleSpeed(0);
            r.store.setCurrentTime(target);
            r.store.setFrameStepRequest(-1, target);
            return true;
        },
    },
    {
        id: "frame-forward",
        source: "editor-layout.tsx:3557-3565",
        when: (e) => e.key === "." && plain(e),
        run: (r) => {
            r.event.preventDefault();
            const target = r.store.currentTime + 1 / 30;
            r.store.setShuttleSpeed(0);
            r.store.setCurrentTime(target);
            r.store.setFrameStepRequest(1, target);
            return true;
        },
    },
    {
        id: "shuttle-reverse",
        source: "editor-layout.tsx:3567-3580",
        when: (e) => is(e, "j", "J") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            const speed = r.store.shuttleSpeed;
            r.store.setShuttleSpeed(speed >= 0 ? -1 : speed <= -4 ? -4 : speed * 2);
            return true;
        },
    },
    {
        id: "split-all-at-nearest-marker",
        source: "editor-layout.tsx:3582-3598",
        when: (e) => is(e, "k", "K") && mod(e) && e.altKey && e.shiftKey,
        run: (r) => {
            r.event.preventDefault();
            const target = editing.getTimelineSplitAllTrackTargetAtNearestMarker(r.clips, r.tracks, r.store.timelineMarkers, r.store.currentTime);
            if (target) commitSplits(r, target.clipIds, target.splitTime);
            return true;
        },
    },
    commitRule("keyframe", "editor-layout.tsx:3600-3624",
        (e) => is(e, "k", "K") && e.altKey && !mod(e),
        (r) => (r.event.shiftKey
            ? editing.getTimelineClearKeyframesTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)
            : editing.getTimelineAddKeyframeTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime))),
    {
        id: "shuttle-stop",
        source: "editor-layout.tsx:3626-3632",
        when: (e) => is(e, "k", "K") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            r.store.setShuttleSpeed(0);
            r.store.setPlayRequest("pause");
            return true;
        },
    },
    {
        id: "shuttle-forward",
        source: "editor-layout.tsx:3634-3647",
        when: (e) => is(e, "l", "L") && plain(e),
        run: (r) => {
            r.event.preventDefault();
            const speed = r.store.shuttleSpeed;
            r.store.setShuttleSpeed(speed <= 0 ? 1 : speed >= 4 ? 4 : speed * 2);
            return true;
        },
    },
];
