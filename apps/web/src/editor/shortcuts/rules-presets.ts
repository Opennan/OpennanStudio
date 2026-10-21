// editor-layout.tsx:3413-3545: volume, speed ramp, and speed presets, freeze/reverse, edit-point trim, keyframe jumps.
import { editing } from "@opennan/timeline-core";
import { altOnly, altShift, commitRule, is, mod, seek, type ShortcutRule } from "./keymap-context";

const VOLUME_BY_KEY: Record<string, number> = { "5": 0.25, "6": 0.5, "7": 1, "8": 1.5 };
const SPEED_RAMP_BY_KEY: Record<string, string> = { "1": "none", "2": "montage", "3": "hero", "4": "bullet" };
const SPEED_BY_KEY: Record<string, number> = { "1": 0.5, "2": 1, "3": 2 };

export const PRESET_RULES: readonly ShortcutRule[] = [
    commitRule("clip-volume-preset", "editor-layout.tsx:3413-3431",
        (e) => is(e, "5", "6", "7", "8") && altShift(e),
        (r) => editing.getTimelineSetClipVolumeTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, VOLUME_BY_KEY[r.event.key])),
    commitRule("speed-ramp-preset", "editor-layout.tsx:3433-3451",
        (e) => is(e, "1", "2", "3", "4") && altShift(e),
        (r) => editing.getTimelineSetSpeedRampTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, SPEED_RAMP_BY_KEY[r.event.key])),
    commitRule("playback-speed-preset", "editor-layout.tsx:3453-3471",
        (e) => is(e, "1", "2", "3") && altOnly(e),
        (r) => editing.getTimelineSetPlaybackSpeedTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, SPEED_BY_KEY[r.event.key])),
    commitRule("toggle-freeze-frame", "editor-layout.tsx:3473-3489",
        (e) => is(e, "f", "F") && altOnly(e),
        (r) => editing.getTimelineToggleFreezeFrameTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
    commitRule("toggle-reverse", "editor-layout.tsx:3491-3507",
        (e) => is(e, "r", "R") && altOnly(e),
        (r) => editing.getTimelineToggleReversePlaybackTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId)),
    commitRule("trim-to-nearest-edit-point", "editor-layout.tsx:3509-3527",
        (e) => is(e, ",", ".") && mod(e) && e.altKey && e.shiftKey,
        (r) => editing.getTimelineTrimSelectionToNearestEditPointTargetCommits(
            r.clips, r.tracks, r.scenes, r.store.selectedClipIds, r.clipId, r.event.key === "," ? "start" : "end",
        )),
    {
        id: "jump-keyframe",
        source: "editor-layout.tsx:3529-3545",
        when: (e) => is(e, ",", ".") && altOnly(e),
        run: (r) => {
            r.event.preventDefault();
            const target = editing.getAdjacentTimelineClipKeyframeTime(
                r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.store.currentTime, r.event.key === "," ? -1 : 1,
            );
            if (target !== null) seek(r, target);
            return true;
        },
    },
];
