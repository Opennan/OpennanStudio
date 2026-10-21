// Cuts between touching scenes on the same video track: where a scene transition can live. The
// transition is stored on the outgoing scene (visualTransition / visualTransitionDuration) and is
// centered on the cut (phase 10a): it may last at most as long as the shorter neighbour (and 2 s).
import type { TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import { MAX_TRANSITION_SECONDS, MIN_TRANSITION_SECONDS } from "../looks/transitions";

/** Touching tolerance in seconds (the preview and the export both use it). */
export const SCENE_CUT_TOLERANCE = 0.06;

export interface SceneJunction {
    /** Outgoing scene: it owns the transition. */
    sceneId: string;
    nextSceneId: string;
    trackIndex: number;
    /** Timeline seconds of the cut. */
    cut: number;
    /** Longest transition this cut can hold. */
    maxDuration: number;
    /** False on locked or hidden tracks. */
    editable: boolean;
}

export function sceneJunctions(scenes: SceneData[], tracks: TimelineTrack[] = []): SceneJunction[] {
    const placed = scenes.map((scene, index) => {
        const start = getSceneStart(scene, scenes, index);
        return { scene, start, end: start + getSceneDuration(scene), trackIndex: Number(scene.trackIndex || 1) };
    });
    const out: SceneJunction[] = [];
    for (const a of placed) {
        const next = placed
            .filter((b) => b.scene.id !== a.scene.id && b.trackIndex === a.trackIndex && Math.abs(b.start - a.end) <= SCENE_CUT_TOLERANCE)
            .sort((x, y) => Math.abs(x.start - a.end) - Math.abs(y.start - a.end))[0];
        if (!next) continue;
        const track = tracks.find((t) => t.type === "video" && t.index === a.trackIndex);
        out.push({
            sceneId: a.scene.id,
            nextSceneId: next.scene.id,
            trackIndex: a.trackIndex,
            cut: a.end,
            maxDuration: Math.max(0, Math.min(MAX_TRANSITION_SECONDS, a.end - a.start, next.end - next.start)),
            editable: !track || (!track.locked && track.visible !== false),
        });
    }
    return out.sort((x, y) => x.trackIndex - y.trackIndex || x.cut - y.cut);
}

/** The duration a transition at this cut will get: clamped to [0.1, maxDuration], rounded to ms. */
export function clampJunctionDuration(junction: Pick<SceneJunction, "maxDuration">, seconds: number): number {
    const value = Number.isFinite(seconds) ? seconds : 0.5;
    return Math.round(Math.max(Math.min(MIN_TRANSITION_SECONDS, junction.maxDuration), Math.min(junction.maxDuration, value)) * 1000) / 1000;
}
