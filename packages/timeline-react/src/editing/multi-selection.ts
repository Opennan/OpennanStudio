// Multi-item selection (phase 10c): clips and scenes picked together on the timeline or the preview. Pure helpers
// for keyboard maps and the timeline, plus the hook the inspector's group mode reads.
import { selectLiveScenes, type EditorState, type EditorStore, type SceneData, type TimelineClip, type TimelineController } from "@opennan/timeline-core";
import type { TimelineClipboard } from "@opennan/timeline-core/lib/timeline-editing";
import { copyItemsToClipboard, editableItems, type ItemTarget } from "@opennan/timeline-core/controller/items-plan";
import { getSceneDuration, getSceneStart } from "@opennan/timeline-core/timeline/scene-timing";
import { motionTarget } from "@opennan/timeline-core/motion/transform";
import type { AnimationTarget } from "@opennan/timeline-core/motion/registry";
import { useEditorStore } from "../hooks/use-editor-store";
import { useRef } from "react";

/** The selected clip ids and scene ids (the scene set; a scene only synced to the playhead does not count). */
export function selectionItemIds(state: Pick<EditorState, "selectedClipIds" | "selectedClipId" | "selectedSceneIds">): { clipIds: string[]; sceneIds: string[] } {
    const clipIds = state.selectedClipIds.size > 0 ? [...state.selectedClipIds] : state.selectedClipId ? [state.selectedClipId] : [];
    return { clipIds, sceneIds: [...state.selectedSceneIds] };
}

/** Two or more items with at least one scene: the selection the multi-item commands handle (clip-only selections keep the clip paths). */
export function isMixedSelection(state: Pick<EditorState, "selectedClipIds" | "selectedClipId" | "selectedSceneIds">): boolean {
    const { clipIds, sceneIds } = selectionItemIds(state);
    return sceneIds.length > 0 && clipIds.length + sceneIds.length >= 2;
}

function itemsState(state: EditorState) {
    return { clips: state.timelineData?.clips ?? [], scenes: selectLiveScenes(state), tracks: state.timelineData?.tracks ?? [] };
}

/** Where a paste of clips and scenes lands: right after the editable selection, else at the playhead. */
export function itemsPasteTime(state: EditorState): number {
    const items = itemsState(state);
    const { clipIds, sceneIds } = selectionItemIds(state);
    const { clips, scenes } = editableItems(items, clipIds, sceneIds);
    const ends = [
        ...clips.map((clip) => clip.endTime),
        ...scenes.map((scene) => getSceneStart(scene, items.scenes, items.scenes.indexOf(scene)) + getSceneDuration(scene)),
    ];
    if (ends.length > 0) return Math.round(Math.max(...ends) * 1000) / 1000;
    return Number.isFinite(state.currentTime) ? Math.max(0, state.currentTime) : 0;
}

/** The clipboard for the selected clips and scenes (null when nothing editable is selected). */
export function copySelectedItems(state: EditorState): TimelineClipboard | null {
    const { clipIds, sceneIds } = selectionItemIds(state);
    return copyItemsToClipboard(itemsState(state), clipIds, sceneIds);
}

/** True when the clipboard holds scenes (pasted with items.paste instead of the clip paste). */
export function clipboardHasScenes(clipboard: TimelineClipboard | null | undefined): boolean {
    return Boolean(clipboard?.scenes && clipboard.scenes.length > 0);
}

type Execute = Pick<TimelineController, "execute">;

/** Deletes every selected clip and scene in one undo step. */
export function deleteSelectedItems(controller: Execute, store: EditorStore) {
    const { clipIds, sceneIds } = selectionItemIds(store.getState());
    return controller.execute({ type: "items.delete", clipIds, sceneIds });
}

/** Duplicates every selected clip and scene after the selection, in one undo step (the copies become the selection). */
export function duplicateSelectedItems(controller: Execute, store: EditorStore) {
    const { clipIds, sceneIds } = selectionItemIds(store.getState());
    return controller.execute({ type: "items.duplicate", clipIds, sceneIds });
}

/** Pastes a clipboard with scenes after the selection (or at the playhead), in one undo step. */
export function pasteItems(controller: Execute, store: EditorStore, clipboard: TimelineClipboard) {
    return controller.execute({ type: "items.paste", clipboard, at: itemsPasteTime(store.getState()) });
}

/** Every editable clip and scene (Ctrl/Cmd+A). */
export function allEditableItems(state: EditorState): { clipIds: string[]; sceneIds: string[] } {
    const items = itemsState(state);
    const { clips, scenes } = editableItems(items, items.clips.map((c) => c.id), items.scenes.map((s) => s.id));
    return { clipIds: clips.map((c) => c.id), sceneIds: scenes.map((s) => s.id) };
}

/** A group selection (two or more items, clips and/or scenes) with the live items, for the inspector's group mode. */
export interface GroupSelection {
    clips: TimelineClip[];
    scenes: SceneData[];
    /** Group-apply targets, primary item first. */
    targets: ItemTarget[];
}

/** The group selection, or null for zero or one selected item. */
export function groupSelectionOf(state: EditorState): GroupSelection | null {
    const { clipIds, sceneIds } = selectionItemIds(state);
    if (clipIds.length + sceneIds.length < 2) return null;
    const allClips = state.timelineData?.clips ?? [];
    const allScenes = selectLiveScenes(state);
    const clips = clipIds.map((id) => allClips.find((c) => c.id === id)).filter((c): c is TimelineClip => Boolean(c));
    const scenes = sceneIds.map((id) => allScenes.find((s) => s.id === id)).filter((s): s is SceneData => Boolean(s));
    if (clips.length + scenes.length < 2) return null;
    return { clips, scenes, targets: [...clips.map((c) => ({ clipId: c.id })), ...scenes.map((s) => ({ sceneId: s.id }))] };
}

/** The live group selection (re-renders when its items change). */
export function useGroupSelection(): GroupSelection | null {
    const last = useRef<GroupSelection | null>(null);
    return useEditorStore((state) => {
        const next = groupSelectionOf(state);
        const prev = last.current;
        const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, i) => item === b[i]);
        if (prev === next || (prev && next && same(prev.clips, next.clips) && same(prev.scenes, next.scenes))) return prev;
        last.current = next;
        return next;
    });
}

/** Scenes and visual layer clips take looks (filter, adjust, effects), as single selections do (selection.ts lookTargetOf). */
export function takesLook(item: { clip?: TimelineClip; scene?: SceneData }): boolean {
    return Boolean(item.scene) || item.clip?.trackType === "video" || item.clip?.trackType === "sticker";
}

/** The animation family of an item (null: cannot be animated). */
export function animationFamilyOf(item: { clip?: TimelineClip; scene?: SceneData }): AnimationTarget | null {
    if (item.scene) return "clip";
    const clip = item.clip!;
    if (clip.trackType === "audio" || clip.trackType === "effect") return null;
    return motionTarget({ kind: "clip", clip });
}

/** The group's items, primary first. */
export function groupItems(group: GroupSelection): Array<{ clip?: TimelineClip; scene?: SceneData }> {
    return [...group.clips.map((clip) => ({ clip })), ...group.scenes.map((scene) => ({ scene }))];
}

/** The group's look targets (scenes and visual clips), or null when the group has none. */
export function groupLookTargets(group: GroupSelection | null): { targets: ItemTarget[] } | null {
    if (!group) return null;
    const targets = groupItems(group).filter(takesLook).map((item) => (item.scene ? { sceneId: item.scene.id } : { clipId: item.clip!.id }));
    return targets.length > 0 ? { targets } : null;
}
