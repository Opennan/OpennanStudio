// Beats on the timeline (phase 11, Decision 5): an audio clip keeps its beats as `beatsJson`, source-media seconds, so
// trimming and moving the clip keep them aligned. This file maps them onto the timeline (dots, snapping) and plans
// `beats.set` and `beats.autoCut`. Pure.
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { SceneMove, TimelineClipUpdate } from "../backend/types";
import { clipSpeedProfile, sceneSpeedProfile } from "../motion/speed";
import { clipMediaStart } from "../ai/sources";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import { buildSceneTimelineTrimCardConfig, getSceneContentDuration, getSceneTimelineTrimStart, isContentBackedScene } from "../timeline/scene-helpers";
import { MAX_BEATS } from "./beats";
import type { Plan } from "./cuts";

/** Shortest item auto cut leaves, seconds. */
export const MIN_AUTO_CUT_SECONDS = 0.2;
const EPS = 1e-6;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Beat times stored on a clip (source seconds), sorted; [] when absent or malformed. */
export function parseBeatsJson(json: string | null | undefined): number[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
    } catch {
        return [];
    }
}

/** beats.set: the stored JSON (null clears) or why the beats are refused. Sorted, de-duplicated to the millisecond. */
export function planBeatsJson(beats: unknown): Plan<string | null> {
    if (beats === null) return { ok: true, value: null };
    if (!Array.isArray(beats)) return { ok: false, error: "beats must be a list of seconds, or null to clear them" };
    if (beats.length > MAX_BEATS) return { ok: false, error: `at most ${MAX_BEATS} beats` };
    if (beats.some((t) => typeof t !== "number" || !Number.isFinite(t) || t < 0)) return { ok: false, error: "every beat is a number of seconds ≥ 0" };
    const sorted = [...new Set((beats as number[]).map(round3))].sort((a, b) => a - b);
    return { ok: true, value: sorted.length > 0 ? JSON.stringify(sorted) : null };
}

/** A clip's beats as timeline seconds inside its window (constant speed; reversed or curved clips have none). */
export function clipBeatTimes(clip: Pick<TimelineClip, "beatsJson" | "startTime" | "endTime" | "trimStart" | "playbackSpeed" | "speedCurveJson" | "speedRamp" | "reversePlayback">): number[] {
    const beats = parseBeatsJson(clip.beatsJson);
    if (beats.length === 0 || clip.reversePlayback) return [];
    const profile = clipSpeedProfile(clip);
    if (profile.curve) return [];
    const base = clipMediaStart(clip);
    const out: number[] = [];
    for (const beat of beats) {
        const t = clip.startTime + (beat - base) / profile.speed;
        if (t >= clip.startTime - EPS && t <= clip.endTime + EPS) out.push(round6(t));
    }
    return out;
}

/** Every audio clip's beats on the timeline, sorted and de-duplicated. */
export function beatTimesOnTimeline(clips: readonly TimelineClip[]): number[] {
    const all = clips.filter((c) => c.trackType === "audio" && c.beatsJson).flatMap((c) => clipBeatTimes(c)).sort((a, b) => a - b);
    return all.filter((t, i) => i === 0 || t - all[i - 1] > 0.0005);
}

export interface AutoCutState {
    clips: TimelineClip[];
    scenes: SceneData[];
    tracks: TimelineTrack[];
}

export interface AutoCutRequest {
    clipIds?: readonly string[];
    sceneIds?: readonly string[];
    beatClipId?: string;
    every?: number;
}

export interface AutoCutPlan {
    clipUpdates: TimelineClipUpdate[];
    scenePatches: Array<{ sceneId: string; patch: Partial<SceneData> }>;
    sceneMoves: SceneMove[];
    /** Item ends that landed on a beat / kept their length (no beat in reach). */
    snapped: number;
    unchanged: number;
    beatClipId: string;
}

interface Item {
    clip?: TimelineClip;
    scene?: SceneData;
    start: number;
    end: number;
    trackType: string;
    trackIndex: number;
    /** Longest timeline length its media allows (Infinity: no limit known). */
    maxLength: number;
    speed: number;
}

function trackLocked(tracks: TimelineTrack[], type: string, index: number): boolean {
    return tracks.some((t) => t.type === type && t.index === index && t.locked);
}

/** beats.autoCut: items re-timed end to end so each cut lands on a beat, later items on their tracks rippled. */
export function planAutoCut(state: AutoCutState, request: AutoCutRequest): Plan<AutoCutPlan> {
    const every = request.every === undefined ? 1 : Math.trunc(request.every);
    if (!(every >= 1) || every > 64) return { ok: false, error: "every must be a whole number of beats from 1 to 64" };
    const items: Item[] = [];
    for (const id of request.clipIds ?? []) {
        const clip = state.clips.find((c) => c.id === id);
        if (!clip) return { ok: false, error: `No matching clip ${id}` };
        if (clip.id.startsWith("temp-")) return { ok: false, error: "clip is still being created" };
        if (clip.locked || trackLocked(state.tracks, clip.trackType, clip.trackIndex)) continue;
        const profile = clipSpeedProfile(clip);
        const media = (clip.trackType === "video" || clip.trackType === "audio") && clip.mediaType !== "image" && Boolean(clip.mediaUrl);
        if (media && (profile.curve || clip.reversePlayback)) return { ok: false, error: "Speed curves and reversed clips cannot be cut to the beat" };
        // Without a known media length a media clip can only get shorter.
        items.push({ clip, start: clip.startTime, end: clip.endTime, trackType: clip.trackType, trackIndex: clip.trackIndex, maxLength: media ? clip.endTime - clip.startTime : Number.POSITIVE_INFINITY, speed: profile.speed });
    }
    for (const id of request.sceneIds ?? []) {
        const index = state.scenes.findIndex((s) => s.id === id);
        if (index < 0) return { ok: false, error: `No matching scene ${id}` };
        const scene = state.scenes[index];
        const trackIndex = Math.max(1, Number(scene.trackIndex || 1));
        if (trackLocked(state.tracks, "video", trackIndex)) continue;
        const profile = sceneSpeedProfile(scene);
        if (profile.curve) return { ok: false, error: "Speed curves cannot be cut to the beat" };
        const start = getSceneStart(scene, state.scenes, index);
        const length = getSceneDuration(scene);
        const content = getSceneContentDuration(scene);
        const contentBacked = isContentBackedScene(scene);
        const maxLength = contentBacked
            ? Number.isFinite(content) ? Math.max(length, (content - getSceneTimelineTrimStart(scene)) / profile.speed) : length
            : scene.videoUrl ? length : Number.POSITIVE_INFINITY;
        items.push({ scene, start, end: start + length, trackType: "video", trackIndex, maxLength, speed: profile.speed });
    }
    if (items.length === 0) return { ok: false, error: "Select the clips or scenes to cut to the beat" };
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    const groupStart = items[0].start;
    const groupEnd = Math.max(...items.map((i) => i.end));
    const beatClip = request.beatClipId
        ? state.clips.find((c) => c.id === request.beatClipId)
        : state.clips.filter((c) => c.trackType === "audio" && c.beatsJson && clipBeatTimesInRange(c, groupStart, groupEnd)).sort((a, b) => a.startTime - b.startTime)[0];
    if (!beatClip) return { ok: false, error: request.beatClipId ? "No matching beat clip" : "No audio clip with beats under these items: detect beats first" };
    const all = clipBeatTimes(beatClip);
    if (all.length === 0) return { ok: false, error: "The audio clip has no beats: detect beats first" };
    const first = all.findIndex((t) => t >= groupStart - EPS);
    const beats = first < 0 ? [] : all.slice(first).filter((_, i) => i % every === 0);

    const clipUpdates: TimelineClipUpdate[] = [];
    const scenePatches: AutoCutPlan["scenePatches"] = [];
    const sceneMoves: SceneMove[] = [];
    let snapped = 0;
    let unchanged = 0;
    let cursor = groupStart;
    for (const item of items) {
        const length = item.end - item.start;
        const natural = cursor + length;
        const lo = cursor + MIN_AUTO_CUT_SECONDS;
        const hi = cursor + item.maxLength;
        let end = natural;
        let best = Number.POSITIVE_INFINITY;
        for (const beat of beats) {
            if (beat < lo - EPS || beat > hi + EPS) continue;
            const distance = Math.abs(beat - natural);
            if (distance < best) {
                best = distance;
                end = beat;
            }
        }
        if (Number.isFinite(best)) snapped += 1;
        else unchanged += 1;
        const start = round3(cursor);
        end = round3(end);
        const newLength = end - start;
        if (item.clip) {
            const clip = item.clip;
            const update: TimelineClipUpdate = { clipId: clip.id, startTime: start, endTime: end };
            const media = (clip.trackType === "video" || clip.trackType === "audio") && clip.mediaType !== "image" && Boolean(clip.mediaUrl);
            if (media && Math.abs(newLength - length) > EPS) {
                const trimStart = clipMediaStart(clip);
                update.trimStart = trimStart;
                update.trimEnd = round6(trimStart + newLength * item.speed);
            }
            if (Math.abs(start - clip.startTime) > EPS || Math.abs(end - clip.endTime) > EPS) clipUpdates.push(update);
        } else {
            const scene = item.scene!;
            if (Math.abs(newLength - length) > EPS) {
                if (scene.videoUrl || isContentBackedScene(scene)) {
                    const trimStart = getSceneTimelineTrimStart(scene);
                    const span = round6(newLength * item.speed);
                    scenePatches.push({ sceneId: scene.id, patch: { cardConfig: buildSceneTimelineTrimCardConfig(scene, trimStart, trimStart + span), duration: span } });
                } else {
                    scenePatches.push({ sceneId: scene.id, patch: { duration: round6(newLength * item.speed) } });
                }
            }
            if (Math.abs(start - item.start) > EPS || Number(scene.timelinePositionSeconds ?? 0) <= 0) sceneMoves.push({ sceneId: scene.id, timelinePositionSeconds: Math.max(0.001, start) });
        }
        cursor = end;
    }
    // Ripple: later items on the tracks of the cut items move by the change of the group's end.
    const delta = cursor - groupEnd;
    if (Math.abs(delta) > EPS) {
        const tracks = new Set(items.map((i) => `${i.trackType}:${i.trackIndex}`));
        const chosen = new Set(items.map((i) => i.clip?.id ?? i.scene!.id));
        for (const clip of state.clips) {
            if (chosen.has(clip.id) || !tracks.has(`${clip.trackType}:${clip.trackIndex}`) || clip.startTime < groupEnd - EPS) continue;
            if (clip.locked || trackLocked(state.tracks, clip.trackType, clip.trackIndex)) continue;
            clipUpdates.push({ clipId: clip.id, startTime: round3(Math.max(0, clip.startTime + delta)), endTime: round3(Math.max(0, clip.endTime + delta)) });
        }
        state.scenes.forEach((scene, index) => {
            const trackIndex = Math.max(1, Number(scene.trackIndex || 1));
            if (chosen.has(scene.id) || !tracks.has(`video:${trackIndex}`)) return;
            const start = getSceneStart(scene, state.scenes, index);
            if (start < groupEnd - EPS) return;
            sceneMoves.push({ sceneId: scene.id, timelinePositionSeconds: Math.max(0.001, round3(start + delta)) });
        });
    }
    if (clipUpdates.some((u) => u.clipId.startsWith("temp-"))) return { ok: false, error: "clip is still being created" };
    return { ok: true, value: { clipUpdates, scenePatches, sceneMoves, snapped, unchanged, beatClipId: beatClip.id } };
}

function clipBeatTimesInRange(clip: TimelineClip, start: number, end: number): boolean {
    return clip.startTime < end && clip.endTime > start && clipBeatTimes(clip).length > 0;
}
