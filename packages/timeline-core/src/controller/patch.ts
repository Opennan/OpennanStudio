// Optimistic patch applied to the store before the backend call; rolled back on failure.
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { ProjectMeta, SceneMove } from "../backend/types";

export interface OptimisticPatch {
    clipsUpsert: TimelineClip[];
    clipsRemove: string[];
    tracks?: TimelineTrack[];
    sceneFieldPatches: Array<{ sceneId: string; patch: Partial<SceneData> }>;
    scenePositions: SceneMove[];
    scenesAdd: SceneData[];
    scenesRemove: string[];
    project?: Partial<Omit<ProjectMeta, "id">>;
}

export function emptyPatch(): OptimisticPatch {
    return { clipsUpsert: [], clipsRemove: [], sceneFieldPatches: [], scenePositions: [], scenesAdd: [], scenesRemove: [] };
}

export function patchClipIds(patch: OptimisticPatch): Set<string> {
    return new Set([...patch.clipsUpsert.map((clip) => clip.id), ...patch.clipsRemove]);
}

export function patchSceneIds(patch: OptimisticPatch): Set<string> {
    return new Set([
        ...patch.sceneFieldPatches.map((entry) => entry.sceneId),
        ...patch.scenePositions.map((move) => move.sceneId),
        ...patch.scenesAdd.map((scene) => scene.id),
        ...patch.scenesRemove,
    ]);
}
