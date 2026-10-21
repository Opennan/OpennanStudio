// Reads the timeline the way the preview plays it: scene placement, lanes, transitions, and total
// duration. Each rule cites the preview code it mirrors (packages/timeline-react/src/preview/*).
import type { SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { getSceneTimelineStart, getSceneTrackIndex } from "@opennan/timeline-core/timeline/canvas/scene-position";
import { parseShotBreakdown, shotVisualDuration, totalShotDuration } from "@opennan/timeline-core/lib/shot-utils";
import { normalizeTimelineTransitionType } from "@opennan/timeline-core/lib/timeline-editing-navigation";
import { filterPreviewTimelineClips } from "@opennan/timeline-core/lib/preview-timeline-clips";
import { SCENE_CUT_TOLERANCE } from "@opennan/timeline-core/lib/scene-transitions";
import { sceneTimelineSeconds } from "@opennan/timeline-core/timeline/scene-duration";
import { outputTimeAt, sceneSpeedProfile, sourceTimeAt } from "@opennan/timeline-core/motion/speed";

export function parseCardConfig(scene: Pick<SceneData, "cardConfig">): Record<string, unknown> {
    if (!scene.cardConfig) return {};
    try {
        const parsed = JSON.parse(scene.cardConfig);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function timeToSeconds(value: string): number {
    const parts = value.replace(",", ".").split(":");
    if (parts.length !== 3) return 0;
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

/** Scene length on the timeline: the media span (sceneSourceDuration) over the scene speed. */
export function sceneDuration(scene: SceneData): number {
    return sceneTimelineSeconds(scene, sceneSourceDuration(scene));
}

/** Scene media span in source seconds: scene-preview.tsx:607-633. */
export function sceneSourceDuration(scene: SceneData): number {
    const config = parseCardConfig(scene);
    const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
    const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
    if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) return trimEnd - trimStart;
    let shotSum = 0;
    if (scene.shotBreakdown && scene.shotBreakdown !== "[]") {
        const shots = parseShotBreakdown(scene.shotBreakdown);
        if (shots.length > 0) shotSum = totalShotDuration(shots);
    }
    if (scene.cardType === "copy_video" && shotSum > 0) return shotSum;
    if (scene.videoUrl && scene.duration && scene.duration > 0) return shotSum > scene.duration ? shotSum : scene.duration;
    if (shotSum > 0) return shotSum;
    return scene.duration || (timeToSeconds(scene.endTime) - timeToSeconds(scene.startTime)) || 5;
}

/** Seconds into the scene media where the scene starts: scene-preview.tsx:137-141. */
export function sceneTrimStart(scene: SceneData): number {
    const config = parseCardConfig(scene);
    const value = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The scene's video: generated video, else a source clip's footage (what the backend's export validation accepts). */
export function sceneVideoUrl(scene: SceneData): string | null {
    return scene.videoUrl || (scene.cardType === "source_clip" ? scene.sourceVideoUrl ?? null : null);
}

/**
 * One shot of a shot-sequenced scene. Scene source second σ ∈ [sourceStart, sourceEnd) plays shot media second
 * rate·(σ − sourceStart); the scene's speed profile maps item time t to σ = S(t), so the shot covers item
 * timeline [start, end). `speed` is the average media seconds per timeline second (ShotSequencerV2's timeScale).
 */
export interface ScenePiece {
    url: string;
    start: number;
    end: number;
    speed: number;
    sourceStart: number;
    sourceEnd: number;
    rate: number;
}

/**
 * Scenes the preview plays shot by shot with ShotSequencerV2: no stitched video, not a source clip
 * with footage, and every shot has its own video_url (sceneNeedsShotSequencer, scene-preview.tsx:509-516).
 * Timing follows ShotSequencerV2 (scene-preview.tsx:3641-3681): shot i covers [acc_i, acc_i + d_i) / timeScale
 * of the scene and its video runs at timeScale = Σd / sceneDuration (which includes the scene speed). With a
 * speed curve the shot media follows the curve's time map: media = rate·S(t) − acc_i, rate = Σd / source span
 * (the preview's getSceneWarpedLocal). Null for every other scene.
 */
export function sceneShotSequence(scene: SceneData): ScenePiece[] | null {
    if (scene.videoUrl) return null;
    if (scene.cardType === "source_clip" && scene.sourceVideoUrl) return null;
    const shots = parseShotBreakdown<{ video_url?: string; duration?: string | number; duration_seconds?: string | number }>(scene.shotBreakdown);
    if (shots.length === 0 || !shots.every((shot) => Boolean(shot.video_url))) return null;
    const durations = shots.map((shot) => shotVisualDuration(shot));
    const total = durations.reduce((sum, d) => sum + d, 0);
    const length = sceneDuration(scene);
    const span = sceneSourceDuration(scene);
    const timeScale = total > 0 && length > 0 ? total / length : 1;
    const rate = total > 0 && span > 0 ? total / span : 1;
    const profile = sceneSpeedProfile(scene);
    let acc = 0;
    return shots.map((shot, i) => {
        const sourceStart = acc / rate;
        const sourceEnd = (acc + durations[i]) / rate;
        const start = i === 0 ? 0 : outputTimeAt(profile, sourceStart, length);
        const end = i === shots.length - 1 ? length : outputTimeAt(profile, sourceEnd, length);
        acc += durations[i];
        return { url: String(shot.video_url), start, end, speed: timeScale, sourceStart, sourceEnd, rate };
    });
}

/** Still shown for a scene without video (scene-preview.tsx getScenePosterUrl). */
export function sceneImageUrl(scene: SceneData): string | null {
    return scene.startImageUrl || scene.startImageThumbUrl || null;
}

export function isVideoTrackVisible(tracks: TimelineTrack[], index: number): boolean {
    return tracks.find((track) => track.type === "video" && track.index === index)?.visible !== false;
}

export interface PlacedScene {
    scene: SceneData;
    start: number;
    end: number;
    trackIndex: number;
    /** Canonical visual transition at this scene's end, and its authored duration. */
    transition: string;
    transitionDuration: number;
}

/**
 * Scene ranges on visible video tracks. Starts use the array order of all scenes
 * (scene-preview.tsx:919-929); hidden tracks drop out (scene-preview.tsx:956-968).
 */
export function placeScenes(scenes: SceneData[], tracks: TimelineTrack[]): PlacedScene[] {
    const placed: PlacedScene[] = [];
    scenes.forEach((scene, index) => {
        const trackIndex = getSceneTrackIndex(scene);
        if (!isVideoTrackVisible(tracks, trackIndex)) return;
        const start = getSceneTimelineStart(scene, scenes, index, sceneDuration);
        const duration = Number(scene.visualTransitionDuration ?? 0);
        placed.push({
            scene,
            start,
            end: start + sceneDuration(scene),
            trackIndex,
            transition: normalizeTimelineTransitionType(String(scene.visualTransition || "none")),
            transitionDuration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        });
    });
    return placed;
}

/** Clips the preview plays: filterPreviewTimelineClips (preview-panel.tsx:770-773). */
export function playableClips(clips: TimelineClip[], tracks: TimelineTrack[]): TimelineClip[] {
    return filterPreviewTimelineClips(clips, tracks);
}

/**
 * Edit length: the last visual end (all scenes, visual clips), else the last audio end
 * (scene-preview.tsx:934-954).
 */
export function timelineDuration(scenes: SceneData[], clips: TimelineClip[]): number {
    let visual = 0;
    scenes.forEach((scene, index) => {
        visual = Math.max(visual, getSceneTimelineStart(scene, scenes, index, sceneDuration) + sceneDuration(scene));
    });
    let audio = 0;
    for (const clip of clips) {
        const end = Number(clip.endTime) || 0;
        if (clip.trackType === "audio") audio = Math.max(audio, end);
        else visual = Math.max(visual, end);
    }
    return visual > 0 ? visual : audio;
}

// ── lanes ────────────────────────────────────────────────

/** ffmpeg xfade names for scene transitions (reference assembler table). */
export const SCENE_XFADE: Readonly<Record<string, string>> = {
    cross_dissolve: "fade",
    dip_black: "fadeblack",
    dip_white: "fadewhite",
    slide_left: "slideleft",
    slide_right: "slideright",
    slide_up: "slideup",
    slide_down: "slidedown",
    wipe_left: "wipeleft",
    zoom_in: "zoomin",
    blur_dissolve: "fadegrays",
};

export type LaneItem =
    /**
     * A scene: `offset` is the scene-local timeline second the item starts at (an overlapped scene keeps only its
     * tail), `trimStart` the media second it starts at (the scene trim plus S(offset) source seconds).
     */
    | { kind: "scene"; placed: PlacedScene; start: number; duration: number; offset: number; trimStart: number }
    | { kind: "gap"; start: number; duration: number };

export interface SceneLane {
    trackIndex: number;
    items: LaneItem[];
    /**
     * Transition between items[i] and items[i + 1], keyed by i. Only for two scenes that touch:
     * the preview requires the next scene within 0.06 s of the cut (scene-preview.tsx:415-425, 490-497).
     */
    joins: Map<number, { type: string; duration: number }>;
    end: number;
}

const GAP_EPSILON = 0.01;

/**
 * One gap-filled sequence per video track. Times are snapped to frames at `fps` so every
 * segment is a whole number of frames. A scene that overlaps the previous one keeps only
 * its uncovered tail (the earlier scene wins, as getActiveSceneFromRanges does in array order).
 */
export function buildSceneLanes(placed: PlacedScene[], fps: number): SceneLane[] {
    const frame = (seconds: number) => Math.round(seconds * fps) / fps;
    const byTrack = new Map<number, PlacedScene[]>();
    for (const entry of placed) {
        const list = byTrack.get(entry.trackIndex) ?? [];
        list.push(entry);
        byTrack.set(entry.trackIndex, list);
    }
    const lanes: SceneLane[] = [];
    for (const [trackIndex, entries] of [...byTrack.entries()].sort((a, b) => a[0] - b[0])) {
        const sorted = entries.map((entry, order) => ({ entry, order })).sort((a, b) => a.entry.start - b.entry.start || a.order - b.order);
        const items: LaneItem[] = [];
        const joins = new Map<number, { type: string; duration: number }>();
        let cursor = 0;
        let previous: { index: number; placed: PlacedScene } | null = null;
        for (const { entry } of sorted) {
            let start = frame(entry.start);
            const end = frame(entry.end);
            let offset = 0;
            if (start < cursor) {
                offset = cursor - start;
                start = cursor;
            }
            // The covered head is timeline time: the media skips the source seconds it would have played.
            const trimStart = sceneTrimStart(entry.scene) + (offset > 0 ? sourceTimeAt(sceneSpeedProfile(entry.scene), offset, sceneDuration(entry.scene)) : 0);
            if (end - start < 1 / fps / 2) continue;
            // The editor's cut rule (scene-transitions.ts): scenes this close are one cut, with no gap frame between.
            const touching = Math.abs(entry.start - (previous?.placed.end ?? Number.NaN)) <= SCENE_CUT_TOLERANCE;
            if (start > cursor + GAP_EPSILON && !(touching && previous?.index === items.length - 1)) {
                items.push({ kind: "gap", start: cursor, duration: start - cursor });
            } else {
                start = cursor;
            }
            if (previous && touching && previous.index === items.length - 1 && previous.placed.transition !== "none" && previous.placed.transitionDuration > 0) {
                joins.set(previous.index, { type: previous.placed.transition, duration: previous.placed.transitionDuration });
            }
            items.push({ kind: "scene", placed: entry, start, duration: end - start, offset, trimStart });
            previous = { index: items.length - 1, placed: entry };
            cursor = end;
        }
        if (items.length > 0) lanes.push({ trackIndex, items, joins, end: cursor });
    }
    return lanes;
}

// ── active scene windows (audio) ─────────────────────────

export interface ActiveSceneWindow {
    placed: PlacedScene;
    start: number;
    end: number;
}

/**
 * When each scene is the preview's active scene: the first V1 scene in array order covering the
 * time, else the covering scene on the highest track (getActiveSceneFromRanges, scene-preview.tsx:368-382).
 */
export function activeSceneWindows(placed: PlacedScene[]): ActiveSceneWindow[] {
    const points = [...new Set(placed.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
    const windows: ActiveSceneWindow[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const mid = (a + b) / 2;
        const covering = placed.filter((p) => mid >= p.start && mid < p.end);
        const active = covering.find((p) => p.trackIndex === 1)
            ?? covering.reduce<PlacedScene | null>((best, p) => (!best || p.trackIndex > best.trackIndex ? p : best), null);
        if (!active) continue;
        const last = windows[windows.length - 1];
        if (last && last.placed === active && Math.abs(last.end - a) < 1e-9) last.end = b;
        else windows.push({ placed: active, start: a, end: b });
    }
    return windows;
}
