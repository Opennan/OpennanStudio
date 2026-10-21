// editor-layout.tsx:3649-3834: slide, roll, slip, nudge, track moves, edit-point jumps, and Left/Right steps.
import { editing, getEditorSceneStart, type TimelineClipUpdateCommit } from "@opennan/timeline-core";
import {
    altOnly, altShift, commitRule, commitUpdates, hasTimelineSelection, is, mod, seek, type ShortcutRule, type ShortcutRun,
} from "./keymap-context";

const leftRight = (e: KeyboardEvent) => is(e, "ArrowLeft", "ArrowRight");
const upDown = (e: KeyboardEvent) => is(e, "ArrowUp", "ArrowDown");

/** Slide, slip, and nudge act only with a selection and otherwise fall through (:3650-3730). */
function selectionMoveRule(id: string, source: string, when: (e: KeyboardEvent) => boolean, plan: (r: ShortcutRun, direction: -1 | 1) => TimelineClipUpdateCommit[]): ShortcutRule {
    return {
        id,
        source,
        when,
        run: (r) => {
            if (!hasTimelineSelection(r)) return false;
            r.event.preventDefault();
            commitUpdates(r, plan(r, r.event.key === "ArrowLeft" ? -1 : 1));
            return true;
        },
    };
}

export const ARROW_RULES: readonly ShortcutRule[] = [
    selectionMoveRule("slide", "editor-layout.tsx:3649-3667",
        (e) => leftRight(e) && e.altKey && e.shiftKey && mod(e),
        (r, direction) => editing.getTimelineSlideTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, direction * 1)),
    {
        id: "roll",
        source: "editor-layout.tsx:3669-3688",
        when: (e) => editing.getTimelineRollShortcut(e) !== null,
        run: (r) => {
            const roll = editing.getTimelineRollShortcut(r.event);
            if (!roll || !hasTimelineSelection(r)) return false;
            r.event.preventDefault();
            commitUpdates(r, editing.getTimelineRollTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, roll.edge, roll.deltaSeconds));
            return true;
        },
    },
    selectionMoveRule("slip", "editor-layout.tsx:3690-3709",
        (e) => leftRight(e) && e.altKey && mod(e),
        (r, direction) => editing.getTimelineSlipTargetCommits(
            r.clips, r.tracks, r.store.selectedClipIds, r.clipId, direction * (r.event.shiftKey ? 1 : 1 / 30),
        )),
    selectionMoveRule("nudge", "editor-layout.tsx:3711-3730",
        (e) => leftRight(e) && e.altKey,
        (r, direction) => editing.getTimelineNudgeTargetCommits(
            r.clips, r.tracks, r.store.selectedClipIds, r.clipId, direction * editing.getTimelineNudgeStepSeconds(r.event.shiftKey),
        )),
    commitRule("move-to-outer-track", "editor-layout.tsx:3732-3749",
        (e) => upDown(e) && altShift(e),
        (r) => editing.getTimelineTrackMoveExtremeTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.event.key === "ArrowUp" ? 1 : -1)),
    commitRule("move-track", "editor-layout.tsx:3751-3768",
        (e) => upDown(e) && altOnly(e),
        (r) => editing.getTimelineTrackMoveTargetCommits(r.clips, r.tracks, r.store.selectedClipIds, r.clipId, r.event.key === "ArrowUp" ? 1 : -1)),
    {
        id: "jump-edit-point",
        source: "editor-layout.tsx:3770-3784",
        when: (e) => upDown(e) && !mod(e) && !e.altKey,
        run: (r) => {
            const target = editing.getAdjacentTimelineEditPoint({
                clips: r.clips, scenes: r.scenes, currentTime: r.store.currentTime, direction: r.event.key === "ArrowUp" ? -1 : 1,
            });
            if (target === null) return false;
            r.event.preventDefault();
            seek(r, target);
            return true;
        },
    },
    {
        id: "scene-or-second-step",
        source: "editor-layout.tsx:3786-3834",
        when: (e) => leftRight(e) && !mod(e) && !e.altKey,
        run: (r) => {
            r.event.preventDefault();
            const back = r.event.key === "ArrowLeft";
            if (r.event.shiftKey) {
                const end = editing.getTimelineNavigationEndTime({ clips: r.clips, scenes: r.scenes });
                seek(r, back ? Math.max(0, r.store.currentTime - 1) : Math.min(end, r.store.currentTime + 1));
                return true;
            }
            const current = r.scenes.findIndex((scene) => scene.id === r.store.selectedSceneId);
            if (current < 0) return true;
            const next = current + (back ? -1 : 1);
            if (next < 0 || next >= r.scenes.length) return true;
            r.store.selectScene(r.scenes[next].id);
            r.store.setSeekRequest(getEditorSceneStart(r.scenes[next], r.scenes, next));
            return true;
        },
    },
];
