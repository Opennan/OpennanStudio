// PreviewPanel's props (preview-panel.tsx:49-75) as the host wired them
// (editor-layout.tsx:3909-3925), now from the store and the controller.
import { useCallback, useMemo } from "react";
import { selectIsBackendSyncing, selectLiveScenes, selectTimelineClips, selectTimelineTracks, type TimelineClip } from "@opennan/timeline-core";
import { useEditorStore, useEditorStoreApi } from "../hooks/use-editor-store";
import { useTimelineController } from "../hooks/use-timeline-controller";

export function usePreviewDataProps() {
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    const scenes = useEditorStore(selectLiveScenes);
    const selectedSceneId = useEditorStore((s) => s.selectedSceneId);
    const selectedScene = useMemo(() => scenes.find((scene) => scene.id === selectedSceneId) ?? null, [scenes, selectedSceneId]);
    const musicUrl = useEditorStore((s) => s.projectMeta?.musicUrl ?? null);
    const aspectRatio = useEditorStore((s) => s.projectMeta?.aspectRatio);
    const timelineClips = useEditorStore(selectTimelineClips);
    const timelineTracks = useEditorStore(selectTimelineTracks);
    const isBackendSyncing = useEditorStore(selectIsBackendSyncing);

    // handlePlaybackSceneFollow, editor-layout.tsx:1388-1390.
    const onSceneChange = useCallback((id: string) => {
        storeApi.getState().syncActiveScene(id);
    }, [storeApi]);

    // handleUpdateProjectAspectRatio, editor-layout.tsx:1345-1383.
    const onAspectRatioChange = useCallback(async (ratio: string) => {
        await controller.execute({ type: "project.update", patch: { aspectRatio: ratio } });
    }, [controller]);

    // Preview drags commit with silentUndo + silentTimeline (editor-layout.tsx:3923). recordHistory:false
    // also keeps the write out of the backend's undo steps (Task 19 writeBackend -> withoutHistory()).
    const onUpdateClip = useCallback(async (clipId: string, updates: Record<string, unknown>) => {
        const result = await controller.execute({ type: "clip.update", clipIds: [clipId], patch: updates as Partial<TimelineClip> }, { recordHistory: false });
        return result.ok ? storeApi.getState().timelineData?.clips.find((clip) => clip.id === clipId) ?? null : null;
    }, [controller, storeApi]);

    // handleUpdateSceneTransform, editor-layout.tsx:1183-1256. Source-dimension backfill
    // (scene-preview.tsx:2582-2586) is a system write and stays out of undo history.
    const onUpdateSceneTransform = useCallback((sceneId: string, updates: {
        fitMode?: "contain" | "cover" | "fill";
        transformScale?: number;
        transformOffsetX?: number;
        transformOffsetY?: number;
        sourceWidth?: number;
        sourceHeight?: number;
    }) => {
        const systemOnly = Object.keys(updates).every((key) => key === "sourceWidth" || key === "sourceHeight");
        void controller.execute({ type: "scene.update", sceneId, patch: updates }, { recordHistory: !systemOnly });
    }, [controller]);

    return {
        scenes, selectedScene, musicUrl, aspectRatio, onSceneChange, timelineClips, timelineTracks,
        isBackendSyncing, onAspectRatioChange, onUpdateClip, onUpdateSceneTransform,
    };
}
