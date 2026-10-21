// Scene duration and start-time helpers. Copied from opennan frontend
// components/editor/timeline/nle-timeline-utils.ts (pure subset).
import type { SceneData } from "./canvas/types";
import { getSceneTimelineStart } from "./canvas/scene-position";
import { parseShotBreakdown, totalShotDuration } from "../lib/shot-utils";
import { sceneTimelineSeconds } from "./scene-duration";

function timeToSeconds(t: string): number {
    const clean = t.replace(",", ".");
    const parts = clean.split(":");
    if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return 0;
}

export function parseSceneCardConfig(scene: Pick<SceneData, "cardConfig">): Record<string, unknown> {
    if (!scene.cardConfig) return {};
    try {
        const parsed = JSON.parse(scene.cardConfig);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** Timeline length: the media span (source seconds) divided by the scene speed (scene-duration.ts). */
export function getSceneDuration(s: SceneData): number {
    return sceneTimelineSeconds(s, getSceneSourceDuration(s));
}

/** The scene's media span in source seconds (trims, shots, duration). */
export function getSceneSourceDuration(s: SceneData): number {
    const config = parseSceneCardConfig(s);
    const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
    const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
    if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
        return trimEnd - trimStart;
    }

    let shotSum = 0;
    if (s.shotBreakdown && s.shotBreakdown !== "[]") {
        const shots = parseShotBreakdown(s.shotBreakdown);
        if (shots.length > 0) shotSum = totalShotDuration(shots);
    }
    if (s.cardType === "copy_video" && shotSum > 0) return shotSum;
    if (shotSum > 0) return shotSum;
    return s.duration || (timeToSeconds(s.endTime) - timeToSeconds(s.startTime)) || 5;
}

export function getSceneStart(scene: SceneData, scenes: SceneData[], index: number): number {
    return getSceneTimelineStart(scene, scenes, index, getSceneDuration);
}
