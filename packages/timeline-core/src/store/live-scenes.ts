// Derived selectors. computeLiveScenes is copied from the liveScenes merge in
// opennan frontend editor-layout.tsx:603-663 with that file's scene timing
// (editor-layout.tsx:198-230, which clamps trims to >= 0.2 s). The clamp differs
// from core scene-timing.ts:26-41 on purpose: it keeps today's ordering.
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { getSceneTimelineStart } from "../timeline/canvas/scene-position";
import { parseShotBreakdown, totalShotDuration } from "../lib/shot-utils";
import type { EditorState } from "./editor-store";

function timeToSeconds(t: string): number {
    const clean = t.replace(",", ".");
    const parts = clean.split(":");
    if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    return 0;
}

/** Scene duration as the source editor computed it (editor-layout.tsx:206-226). */
export function getEditorSceneDuration(s: SceneData): number {
    const rawCardConfig = s.cardConfig ?? (s as unknown as { card_config?: string | null }).card_config;
    if (rawCardConfig) {
        try {
            const config = JSON.parse(rawCardConfig);
            const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
            const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
            if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
                return Math.max(0.2, trimEnd - trimStart);
            }
        } catch {
            // fall through to shot/duration timing
        }
    }
    if (s.shotBreakdown && s.shotBreakdown !== "[]") {
        const shots = parseShotBreakdown(s.shotBreakdown);
        if (shots.length > 0) {
            const total = totalShotDuration(shots);
            if (total > 0) return total;
        }
    }
    return s.duration || (timeToSeconds(s.endTime) - timeToSeconds(s.startTime)) || 5;
}

export function getEditorSceneStart(scene: SceneData, scenes: SceneData[], index: number): number {
    return getSceneTimelineStart(scene, scenes, index, getEditorSceneDuration);
}

type LiveSceneInputs = Pick<EditorState,
    "serverScenes" | "scenePositionOverrides" | "sceneTrackOverrides" | "optimisticScenes" | "sceneFieldOverrides" | "deletedSceneIds">;

export function computeLiveScenes(input: LiveSceneInputs): SceneData[] {
    const { serverScenes, scenePositionOverrides, sceneTrackOverrides, optimisticScenes, sceneFieldOverrides, deletedSceneIds } = input;
    if (
        scenePositionOverrides.size === 0 && sceneTrackOverrides.size === 0 && optimisticScenes.size === 0
        && sceneFieldOverrides.size === 0 && deletedSceneIds.size === 0
    ) {
        return serverScenes;
    }
    const visible = deletedSceneIds.size === 0 ? serverScenes : serverScenes.filter((s) => !deletedSceneIds.has(s.id));
    const merged: SceneData[] = visible.map((s) => {
        const next: SceneData = { ...s, ...(sceneFieldOverrides.get(s.id) || {}) };
        const position = scenePositionOverrides.get(s.id);
        const track = sceneTrackOverrides.get(s.id);
        if (position !== undefined) next.timelinePositionSeconds = position;
        if (track !== undefined) next.trackIndex = track;
        return next;
    });
    for (const [id, scene] of optimisticScenes) {
        if (merged.some((s) => s.id === id)) continue;
        const wantStart = Number(scene.timelinePositionSeconds ?? Number.POSITIVE_INFINITY);
        const wantTrack = Number(scene.trackIndex || 1);
        if (!Number.isFinite(wantStart)) {
            merged.push(scene);
            continue;
        }
        const insertAt = merged.findIndex((s) => {
            if (Number(s.trackIndex || 1) !== wantTrack) return false;
            return getEditorSceneStart(s, merged, merged.indexOf(s)) > wantStart;
        });
        if (insertAt < 0) merged.push(scene);
        else merged.splice(insertAt, 0, scene);
    }
    const sorted = [...merged].sort((a, b) => {
        const ta = Number(a.trackIndex || 1);
        const tb = Number(b.trackIndex || 1);
        if (ta !== tb) return ta - tb;
        const ea = getEditorSceneStart(a, merged, merged.indexOf(a));
        const eb = getEditorSceneStart(b, merged, merged.indexOf(b));
        if (ea !== eb) return ea - eb;
        return (a.order ?? 0) - (b.order ?? 0);
    });
    const orderById = new Map<string, number>();
    sorted.forEach((s, i) => orderById.set(s.id, i));
    return sorted.map((s) => ({ ...s, order: orderById.get(s.id) ?? s.order }));
}

// Memoized per input identity so subscribers do not re-render on every tick
// (the source recomputed liveScenes every render, editor-layout.tsx:603).
const liveMemo = new WeakMap<SceneData[], { inputs: unknown[]; value: SceneData[] }>();

export function selectLiveScenes(state: LiveSceneInputs): SceneData[] {
    const inputs = [
        state.scenePositionOverrides, state.sceneTrackOverrides, state.optimisticScenes,
        state.sceneFieldOverrides, state.deletedSceneIds,
    ];
    const cached = liveMemo.get(state.serverScenes);
    if (cached && cached.inputs.every((value, index) => value === inputs[index])) return cached.value;
    const value = computeLiveScenes(state);
    liveMemo.set(state.serverScenes, { inputs, value });
    return value;
}

const EMPTY_CLIPS: TimelineClip[] = [];
const EMPTY_TRACKS: TimelineTrack[] = [];

export function selectTimelineClips(state: Pick<EditorState, "timelineData">): TimelineClip[] {
    return state.timelineData?.clips ?? EMPTY_CLIPS;
}

export function selectTimelineTracks(state: Pick<EditorState, "timelineData">): TimelineTrack[] {
    return state.timelineData?.tracks ?? EMPTY_TRACKS;
}

export function selectIsBackendSyncing(state: Pick<EditorState, "activeTimelineSaves" | "optimisticScenes" | "sceneFieldOverrides">): boolean {
    // editor-layout.tsx:3922
    return state.activeTimelineSaves > 0 || state.optimisticScenes.size > 0 || state.sceneFieldOverrides.size > 0;
}
