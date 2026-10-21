// Adapters with the exact signatures of NleTimelineProps (nle-timeline-utils.ts:54-110),
// so seeded call sites stay unchanged while data comes from the store and writes go
// through TimelineController. Failure toasts: clip adapters pass toastOnError: false
// because the component already toasts on null/false results (e.g. nle-timeline.tsx:589).
import { useCallback, useMemo } from "react";
import {
    asCreateClipInput, getEditorSceneDuration, getEditorSceneStart, selectLiveScenes, selectTimelineClips, selectTimelineTracks,
    type EditorStore, type SceneData, type TimelineClip, type TimelineClipCommand, type TimelineClipCreateInput,
    type TimelineClipUpdateCommit, type TimelineController, type TimelineTrack,
} from "@opennan/timeline-core";
import { normalizeTimelineTransitionType } from "@opennan/timeline-core/lib/timeline-editing";
import { useEditorStore, useEditorStoreApi } from "../hooks/use-editor-store";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useTimelineCallbacks } from "../hooks/use-timeline-callbacks";

// use-timeline.ts:39-49: drag-like keys debounce 300 ms; property edits commit at once.
const CLIP_DRAG_DEBOUNCE_MS = 300;
const CLIP_DRAG_UPDATE_KEYS = new Set(["startTime", "endTime", "trimStart", "trimEnd", "positionX", "positionY", "keyframesJson"]);
const QUIET = { toastOnError: false } as const;

export function useTimelineDataProps() {
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const scenes = useEditorStore(selectLiveScenes);
    const timelineTracks = useEditorStore(selectTimelineTracks);
    const timelineClips = useEditorStore(selectTimelineClips);
    const musicUrl = useEditorStore((s) => s.projectMeta?.musicUrl ?? null);
    const selectedSceneId = useEditorStore((s) => s.selectedSceneId);

    // handleSceneChange, editor-layout.tsx:1392-1409.
    const onSelectScene = useCallback((id: string) => {
        storeApi.getState().selectScene(id);
        if (storeApi.getState().isPlaying) return;
        const live = selectLiveScenes(storeApi.getState());
        const index = live.findIndex((scene) => scene.id === id);
        if (index >= 0) storeApi.getState().setSeekRequest(getEditorSceneStart(live[index], live, index));
    }, [storeApi]);

    const onRefetch = useCallback(() => {
        void controller.refresh().catch(() => undefined);
    }, [controller]);

    return { scenes, timelineTracks, timelineClips, musicUrl, selectedSceneId, projectId: controller.projectId, onSelectScene, onRefetch };
}

export interface TimelineCommandAdapters {
    onCreateClip(input: Record<string, unknown>): Promise<TimelineClip | null>;
    onStartCreateClip(input: Record<string, unknown>): { tempId: string; settled: Promise<TimelineClip | null> };
    onCreateClips(inputs: TimelineClipCreateInput[]): Promise<(TimelineClip | null)[]>;
    onUpdateClip(clipId: string, updates: Record<string, unknown>): Promise<TimelineClip | null>;
    onUpdateClips(commits: TimelineClipUpdateCommit[]): Promise<void>;
    onDeleteClip(clipId: string): Promise<boolean>;
    onDeleteClips(clipIds: string[]): Promise<void>;
    onCommitClipCommand(command: TimelineClipCommand): Promise<(TimelineClip | null)[]>;
    onSplitClip(clipId: string, splitTime: number): Promise<TimelineClip | null>;
    onSplitClips(clipIds: string[], splitTime: number): Promise<(TimelineClip | null)[]>;
    onUpdateTracks(tracks: TimelineTrack[]): Promise<TimelineTrack[] | null>;
    onUndo(steps?: number): Promise<void>;
    onRedo(steps?: number): Promise<void>;
}

/** The adapters without React, for hosts that drive the controller directly (keyboard maps, agents). */
export function createTimelineCommandAdapters(controller: TimelineController, storeApi: EditorStore): TimelineCommandAdapters {
    const clipById = (id?: string): TimelineClip | null => (
        id ? storeApi.getState().timelineData?.clips.find((clip) => clip.id === id) ?? null : null
    );
    const createMany = async (inputs: Array<Record<string, unknown>>) => {
        const result = await controller.execute({ type: "clip.create", input: inputs.map((input) => asCreateClipInput(input)) }, QUIET);
        if (!result.ok) return inputs.map(() => null);
        return (result.createdClipIds ?? []).map((id) => clipById(id));
    };
    return {
        onCreateClip: async (input) => (await createMany([input]))[0] ?? null,
        onStartCreateClip: (input) => {
            const started = controller.start({ type: "clip.create", input: asCreateClipInput(input) }, QUIET);
            return {
                tempId: started.optimistic.clipIds[0],
                settled: started.settled.then((result) => (result.ok ? clipById(result.createdClipIds?.[0]) : null)),
            };
        },
        onCreateClips: (inputs) => createMany(inputs),
        onUpdateClip: async (clipId, updates) => {
            const dragLike = Object.keys(updates).some((key) => CLIP_DRAG_UPDATE_KEYS.has(key));
            const result = await controller.execute(
                { type: "clip.update", clipIds: [clipId], patch: updates as Partial<TimelineClip> },
                { ...QUIET, coalesceKey: `clip-update:${clipId}`, debounceMs: dragLike ? CLIP_DRAG_DEBOUNCE_MS : 0 },
            );
            // null when superseded or failed, as the source hook resolved (use-timeline.ts:1341).
            return result.ok ? clipById(clipId) : null;
        },
        onUpdateClips: async (commits) => {
            if (commits.length === 0) return;
            await controller.execute({ type: "clip.updateMany", updates: commits }, QUIET);
        },
        onDeleteClip: async (clipId) => (await controller.execute({ type: "clip.delete", clipIds: [clipId] }, QUIET)).ok,
        onDeleteClips: async (clipIds) => {
            if (clipIds.length === 0) return;
            await controller.execute({ type: "clip.delete", clipIds }, QUIET);
        },
        onCommitClipCommand: async (command) => {
            const result = await controller.execute({ type: "clip.batch", command }, QUIET);
            if (!result.ok) return [];
            return [...(result.createdClipIds ?? []), ...command.updates.map((u) => u.clipId)].map((id) => clipById(id));
        },
        onSplitClip: async (clipId, splitTime) => {
            const result = await controller.execute({ type: "clip.split", clipIds: [clipId], atSeconds: splitTime }, QUIET);
            return result.ok ? clipById(result.createdClipIds?.[0]) : null;
        },
        onSplitClips: async (clipIds, splitTime) => {
            const result = await controller.execute({ type: "clip.split", clipIds, atSeconds: splitTime }, QUIET);
            return result.ok ? (result.createdClipIds ?? []).map((id) => clipById(id)) : [];
        },
        onUpdateTracks: async (tracks) => {
            // The server deletes only explicitly named tracks (use-timeline.ts:778-780, 1909-1912).
            const current = storeApi.getState().timelineData?.tracks ?? [];
            const removed = current
                .filter((track) => !tracks.some((next) => next.type === track.type && next.index === track.index))
                .map((track) => ({ type: track.type, index: track.index }));
            const result = await controller.execute({ type: "track.update", tracks, removed }, QUIET);
            return result.ok ? storeApi.getState().timelineData?.tracks ?? tracks : null;
        },
        onUndo: async (steps) => {
            await controller.execute({ type: "history.undo", steps });
        },
        onRedo: async (steps) => {
            await controller.execute({ type: "history.redo", steps });
        },
    };
}

export function useTimelineCommandAdapters(): TimelineCommandAdapters {
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    return useMemo(() => createTimelineCommandAdapters(controller, storeApi), [controller, storeApi]);
}

export function useSceneOverrideAdapters() {
    const storeApi = useEditorStoreApi();
    return useMemo(() => ({
        onSceneOverridesUpdate: (updates: Map<string, number>, trackChangeSceneId?: string, trackChangeIndex?: number) => {
            storeApi.getState().applySceneOverrides(updates, trackChangeSceneId, trackChangeIndex);
        },
        onOptimisticSceneDelete: (sceneId: string, restore?: boolean) => {
            storeApi.getState().applyOptimisticSceneDelete(sceneId, restore);
        },
        onOptimisticSceneSplit: (split: { sourceSceneId: string; tempSceneId: string; firstScene: Partial<SceneData>; secondScene: SceneData; splitTime: number }) => {
            storeApi.getState().applyOptimisticSceneSplit(split);
        },
        onOptimisticSceneSplitCommit: (tempSceneId: string, createdSceneId: string) => {
            storeApi.getState().commitOptimisticSceneSplit(tempSceneId, createdSceneId);
        },
        onOptimisticSceneSplitRollback: (sourceSceneId: string, sceneId: string) => {
            storeApi.getState().rollbackOptimisticSceneSplit(sourceSceneId, sceneId);
        },
        onOptimisticSceneAdd: (tempScene: Record<string, unknown> & { id: string }) => {
            storeApi.getState().applyOptimisticSceneAdd(tempScene as unknown as SceneData);
        },
        onLocalScenePatch: (sceneId: string, patch: Record<string, unknown>) => {
            storeApi.getState().applyLocalScenePatch(sceneId, patch as Partial<SceneData>);
        },
    }), [storeApi]);
}

export function useSceneFeatureAdapters() {
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const callbacks = useTimelineCallbacks();
    return useMemo(() => ({
        // transition.set: validates the cut and clamps the duration to it (lib/scene-transitions.ts);
        // a non-finite duration takes the transition's default.
        onSetSceneTransition: async (sceneId: string, transitionType: string, durationSeconds: number) => {
            await controller.execute({
                type: "transition.set",
                sceneId,
                transition: transitionType || "none",
                ...(Number.isFinite(durationSeconds) ? { duration: durationSeconds } : {}),
            }, { toastOnError: false });
        },
        // handleUpdateSceneTransform, editor-layout.tsx:1183-1256.
        onUpdateSceneTransform: async (sceneId: string, updates: Partial<Pick<SceneData, "fitMode" | "transformScale" | "transformOffsetX" | "transformOffsetY" | "sourceWidth" | "sourceHeight">>) => {
            await controller.execute({ type: "scene.update", sceneId, patch: updates });
        },
        // onSaveToSources, editor-layout.tsx:496-501 -> host callback.
        onSaveToSources: async (url: string, name: string, size: number, mimeType: string) => {
            callbacks.onSaveToSources?.({ url, name, size, mimeType });
        },
    }), [callbacks, controller, storeApi]);
}
