// Ripple cuts (phase 11, Decision 6): removing timeline ranges from a clip or scene and its linked items, closing the
// gaps, and keeping everything after in sync. Pure: the controller writes the plan as one undo step.
//
//   removed R  the ranges, clamped to the target's window and merged
//   ripple(t)  t − (removed time before t): where an instant lands once R is gone
//
// - The target (a clip or a scene) keeps the parts outside R, laid end to end from its start: its first part is the
//   item itself (trims updated), each later part a copy (clips: a new clip; scenes: a duplicated scene).
// - Linked items are cut the same way: caption clips over the target's window (their text and word timings split by the
//   words that stay), audio clips that own a scene (sceneId) or play the target's media over its window.
// - Every other item on an unlocked track moves left by the removed time before it — except one that spans a removed
//   range (a music bed), which stays as it is. Items on locked tracks never change.
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { CreateClipInput, SceneMove, TimelineClipUpdate } from "../backend/types";
import type { AiTargetRef } from "../controller/ai-run";
import type { TimeRange } from "./host";
import { aiMediaSourceResult, clipMediaStart, sceneMediaUrl, type AiMediaSource } from "../ai/sources";
import { clipSpeedProfile } from "../motion/speed";
import { captionWords } from "../text/captions";
import { getTimelineTextClipKind } from "../lib/timeline-text-style";
import { mediaUrlsReferToSameAsset } from "../lib/preview-timeline-clips";
import { sanitizeTimelineClipCreateInput } from "../lib/timeline-optimistic";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import { buildSceneTimelineTrimCardConfig } from "../timeline/scene-helpers";

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string };

/** Ranges shorter than this are dropped; closer than this they merge. */
const EPS = 0.001;
export const MAX_CUT_RANGES = 5000;

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Sorted, merged ranges (touching or closer than `gap` merge), each longer than EPS. */
export function mergeTimeRanges(ranges: readonly TimeRange[], gap = EPS): TimeRange[] {
    const sorted = ranges
        .filter((r) => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
        .map((r) => ({ start: r.start, end: r.end }))
        .sort((a, b) => a.start - b.start);
    const out: TimeRange[] = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (last && range.start <= last.end + gap) last.end = Math.max(last.end, range.end);
        else out.push(range);
    }
    return out.filter((r) => r.end - r.start > EPS);
}

/** The ranges inside [start, end]. */
export function clampTimeRanges(ranges: readonly TimeRange[], start: number, end: number): TimeRange[] {
    return mergeTimeRanges(ranges.map((r) => ({ start: Math.max(start, r.start), end: Math.min(end, r.end) })));
}

/** [start, end] minus the (merged) removed ranges. */
export function keptRanges(start: number, end: number, removed: readonly TimeRange[]): TimeRange[] {
    const out: TimeRange[] = [];
    let cursor = start;
    for (const r of removed) {
        if (r.end <= cursor || r.start >= end) continue;
        if (r.start > cursor + EPS) out.push({ start: cursor, end: Math.min(r.start, end) });
        cursor = Math.max(cursor, r.end);
    }
    if (end - cursor > EPS) out.push({ start: cursor, end });
    return out;
}

/** Removed time before instant t. */
export function removedBefore(t: number, removed: readonly TimeRange[]): number {
    let total = 0;
    for (const r of removed) {
        if (r.start >= t) break;
        total += Math.min(t, r.end) - r.start;
    }
    return total;
}

/** Where instant t lands once the removed ranges are gone (an instant inside a range lands at its start). */
export function rippleTime(t: number, removed: readonly TimeRange[]): number {
    return t - removedBefore(t, removed);
}

type SourceMap = Pick<AiMediaSource, "startSeconds" | "endSeconds" | "timelineStart" | "timelineEnd" | "speed">;

/** Source-second ranges of an item as timeline ranges inside its window, merged. */
export function sourceRangesToTimeline(source: SourceMap, ranges: readonly TimeRange[]): TimeRange[] {
    const speed = source.speed > 0 ? source.speed : 1;
    return clampTimeRanges(ranges.map((r) => ({
        start: round6(source.timelineStart + (r.start - source.startSeconds) / speed),
        end: round6(source.timelineStart + (r.end - source.startSeconds) / speed),
    })), source.timelineStart, source.timelineEnd);
}

/** Timeline ranges inside an item's window as source-second ranges, merged. */
export function timelineRangesToSource(source: SourceMap, ranges: readonly TimeRange[]): TimeRange[] {
    const speed = source.speed > 0 ? source.speed : 1;
    return clampTimeRanges(ranges, source.timelineStart, source.timelineEnd).map((r) => ({
        start: round6(source.startSeconds + (r.start - source.timelineStart) * speed),
        end: round6(source.startSeconds + (r.end - source.timelineStart) * speed),
    }));
}

export interface CutsState {
    clips: TimelineClip[];
    scenes: SceneData[];
    tracks: TimelineTrack[];
}

export interface CutsPlan {
    /** The timeline ranges removed (clamped to the target, merged). */
    removed: TimeRange[];
    removedSeconds: number;
    clipUpdates: TimelineClipUpdate[];
    clipCreates: CreateClipInput[];
    clipDeletes: string[];
    /** Field patches on existing scenes (trims, transitions, keyframes). */
    scenePatches: Array<{ sceneId: string; patch: Partial<SceneData> }>;
    /** New positions of existing scenes. */
    sceneMoves: SceneMove[];
    /** Later parts of a cut scene: duplicate `sourceSceneId`, patch it, and move it. */
    sceneCopies: Array<{ sourceSceneId: string; patch: Partial<SceneData>; timelinePositionSeconds: number; trackIndex: number }>;
    /** Linked items cut with the target. */
    linked: { clipIds: string[] };
}

function trackLocked(tracks: TimelineTrack[], type: string, index: number): boolean {
    return tracks.some((t) => t.type === type && t.index === index && t.locked);
}

const spans = (start: number, end: number, removed: readonly TimeRange[]) => removed.some((r) => start < r.end - EPS && end > r.start + EPS);

/** Keyframes of the item-local window [from, to], re-based to its start; the last point before it carries over to 0. */
function keyframesInWindow(json: string | null | undefined, from: number, to: number): string | null {
    const points = parseTimelineKeyframes(json);
    if (points.length === 0) return json ?? null;
    const inside = points.filter((p) => p.time >= from - 1e-9 && p.time <= to + 1e-9).map((p) => ({ ...p, time: round3(p.time - from) }));
    const before = [...points].reverse().find((p) => p.time < from - 1e-9);
    if (before && (inside.length === 0 || inside[0].time > 0)) inside.unshift({ ...before, time: 0 });
    return inside.length > 0 ? JSON.stringify({ keyframes: inside }) : null;
}

/** A clip whose media can be cut by trims: constant speed, not reversed. */
function cuttable(clip: TimelineClip): boolean {
    return !clipSpeedProfile(clip).curve && !clip.reversePlayback;
}

function isCaption(clip: TimelineClip): boolean {
    return clip.trackType === "text" && (Boolean(clip.captionWordsJson) || getTimelineTextClipKind(clip.textStyle, clip.label) !== "text");
}

interface Writer {
    updates: Map<string, TimelineClipUpdate>;
    creates: CreateClipInput[];
    deletes: string[];
}

function update(writer: Writer, clipId: string, patch: Partial<TimelineClip>): void {
    writer.updates.set(clipId, { ...(writer.updates.get(clipId) ?? { clipId }), ...patch });
}

/** Cuts one clip by the removed ranges: its first kept part is the clip, later parts new clips, all rippled. */
function cutClip(writer: Writer, clip: TimelineClip, removed: readonly TimeRange[]): void {
    const kept = keptRanges(clip.startTime, clip.endTime, removed);
    if (kept.length === 0) {
        writer.deletes.push(clip.id);
        return;
    }
    const whole = kept.length === 1 && Math.abs(kept[0].start - clip.startTime) < EPS && Math.abs(kept[0].end - clip.endTime) < EPS;
    if (whole) {
        const shift = removedBefore(clip.startTime, removed);
        if (shift > 1e-9) update(writer, clip.id, { startTime: round3(clip.startTime - shift), endTime: round3(clip.endTime - shift) });
        return;
    }
    const media = (clip.trackType === "audio" || clip.trackType === "video") && Boolean(clip.mediaUrl) && clip.mediaType !== "image";
    const speed = clipSpeedProfile(clip).speed;
    const base = clipMediaStart(clip);
    const tokens = clip.trackType === "text" ? captionWords(clip) : [];
    const parts: Array<Partial<TimelineClip>> = [];
    kept.forEach((piece, i) => {
        const local = piece.start - clip.startTime;
        const length = piece.end - piece.start;
        const start = round3(rippleTime(piece.start, removed));
        const fields: Partial<TimelineClip> = { startTime: start, endTime: round3(start + length) };
        if (media) {
            fields.trimStart = round6(base + local * speed);
            fields.trimEnd = round6(base + (local + length) * speed);
        }
        if (clip.keyframesJson) fields.keyframesJson = keyframesInWindow(clip.keyframesJson, local, local + length);
        if (tokens.length > 0) {
            const words = tokens.filter((w) => {
                const mid = (w.start + w.end) / 2;
                return mid >= local - 1e-9 && mid <= local + length + 1e-9;
            });
            if (words.length === 0) return;
            fields.textContent = words.map((w) => w.text).join(" ");
            fields.captionWordsJson = JSON.stringify(words.map((w) => {
                const s = round3(Math.min(length, Math.max(0, w.start - local)));
                return { start: s, end: round3(Math.min(length, Math.max(s, w.end - local))), text: w.text };
            }));
        }
        if (i > 0) fields.fadeInDuration = 0;
        if (i < kept.length - 1) {
            fields.fadeOutDuration = 0;
            fields.transitionType = "none";
            fields.transitionDuration = 0;
        }
        parts.push(fields);
    });
    if (parts.length === 0) {
        writer.deletes.push(clip.id);
        return;
    }
    if (parts.length > 1) {
        // The last part keeps the clip's fade out and transition.
        const last = parts[parts.length - 1];
        delete last.fadeOutDuration;
        delete last.transitionType;
        delete last.transitionDuration;
    }
    update(writer, clip.id, parts[0]);
    const copy = sanitizeTimelineClipCreateInput(clip as unknown as Record<string, unknown>);
    for (const fields of parts.slice(1)) writer.creates.push({ ...copy, ...fields, startTime: fields.startTime!, endTime: fields.endTime! } as CreateClipInput);
}

/** Plans `cuts.apply`: the target's ranges removed with its linked items, the rest rippled. */
export function planCuts(state: CutsState, target: AiTargetRef, ranges: ReadonlyArray<{ start: number; end: number }>): Plan<CutsPlan> {
    if (!Array.isArray(ranges) || ranges.length === 0) return { ok: false, error: "cuts.apply needs at least one range" };
    if (ranges.length > MAX_CUT_RANGES) return { ok: false, error: `cuts.apply takes at most ${MAX_CUT_RANGES} ranges` };
    if (ranges.some((r) => !r || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end < r.start)) return { ok: false, error: "each range needs a start and an end (end ≥ start), in seconds" };
    const resolved = aiMediaSourceResult(state, target);
    if (!resolved.ok) return resolved;
    const source = resolved.source;
    const removed = clampTimeRanges(ranges, source.timelineStart, source.timelineEnd).map((r) => ({ start: round6(r.start), end: round6(r.end) }));
    if (removed.length === 0) return { ok: false, error: "the ranges do not cover any part of the item" };
    const removedSeconds = round6(removed.reduce((sum, r) => sum + r.end - r.start, 0));
    if (removedSeconds >= source.timelineEnd - source.timelineStart - EPS) return { ok: false, error: "the ranges cover the whole item: delete it instead" };

    const writer: Writer = { updates: new Map(), creates: [], deletes: [] };
    const scenePatches = new Map<string, Partial<SceneData>>();
    const sceneMoves: SceneMove[] = [];
    const sceneCopies: CutsPlan["sceneCopies"] = [];
    const window = { start: source.timelineStart, end: source.timelineEnd };
    const targetScene = target.sceneId ? state.scenes.find((s) => s.id === target.sceneId)! : undefined;
    const targetClip = targetScene ? undefined : state.clips.find((c) => c.id === target.clipId)!;
    const targetMedia = targetScene ? sceneMediaUrl(targetScene) : targetClip!.mediaUrl;

    // Linked clips: captions over the window, audio that owns the scene or plays the same media over the window.
    const overlapsWindow = (c: TimelineClip) => c.startTime < window.end - EPS && c.endTime > window.start + EPS;
    const linked = state.clips.filter((c) => {
        if (c.id === targetClip?.id || c.locked || trackLocked(state.tracks, c.trackType, c.trackIndex) || c.id.startsWith("temp-")) return false;
        if (!overlapsWindow(c)) return false;
        if (isCaption(c)) return true;
        if (c.trackType !== "audio" || !cuttable(c)) return false;
        if (targetScene && c.sceneId === targetScene.id) return true;
        return Boolean(targetMedia && mediaUrlsReferToSameAsset(c.mediaUrl, targetMedia));
    });
    const linkedIds = new Set(linked.map((c) => c.id));

    if (targetClip) {
        cutClip(writer, targetClip, removed);
    } else {
        const scene = targetScene!;
        const kept = keptRanges(window.start, window.end, removed);
        const trackIndex = source.trackIndex;
        kept.forEach((piece, i) => {
            const local = piece.start - window.start;
            const length = piece.end - piece.start;
            const sourceStart = round6(source.startSeconds + local * source.speed);
            const sourceEnd = round6(source.startSeconds + (local + length) * source.speed);
            const start = round3(rippleTime(piece.start, removed));
            const patch: Partial<SceneData> = {};
            if (source.kind === "video") {
                patch.cardConfig = buildSceneTimelineTrimCardConfig(scene, sourceStart, sourceEnd);
                patch.duration = round6(sourceEnd - sourceStart);
            } else {
                patch.duration = round6(length);
            }
            if (scene.keyframesJson) patch.keyframesJson = keyframesInWindow(scene.keyframesJson, local, local + length);
            if (i < kept.length - 1) {
                patch.visualTransition = "none";
                patch.visualTransitionDuration = 0;
            } else if (i > 0) {
                // The last part is a copy of the (already patched) scene: it takes the scene's transition back.
                patch.visualTransition = scene.visualTransition ?? null;
                patch.visualTransitionDuration = scene.visualTransitionDuration ?? null;
            }
            if (i === 0) {
                scenePatches.set(scene.id, patch);
                if (Math.abs(start - window.start) > 1e-9) sceneMoves.push({ sceneId: scene.id, timelinePositionSeconds: start });
            } else {
                sceneCopies.push({ sourceSceneId: scene.id, patch, timelinePositionSeconds: Math.max(0.001, start), trackIndex });
            }
        });
    }
    for (const clip of linked) cutClip(writer, clip, removed);

    // Everything else on unlocked tracks: ripple, unless it spans a removed range.
    for (const clip of state.clips) {
        if (clip.id === targetClip?.id || linkedIds.has(clip.id) || clip.locked || trackLocked(state.tracks, clip.trackType, clip.trackIndex)) continue;
        if (spans(clip.startTime, clip.endTime, removed)) continue;
        const shift = removedBefore(clip.startTime, removed);
        if (shift > 1e-9) update(writer, clip.id, { startTime: round3(clip.startTime - shift), endTime: round3(clip.endTime - shift) });
    }
    state.scenes.forEach((scene, index) => {
        if (scene.id === targetScene?.id) return;
        const trackIndex = Math.max(1, Number(scene.trackIndex || 1));
        if (trackLocked(state.tracks, "video", trackIndex)) return;
        const start = getSceneStart(scene, state.scenes, index);
        const end = start + getSceneDuration(scene);
        if (spans(start, end, removed)) return;
        const shift = removedBefore(start, removed);
        if (shift > 1e-9) sceneMoves.push({ sceneId: scene.id, timelinePositionSeconds: Math.max(0.001, round3(start - shift)) });
    });

    const updates = [...writer.updates.values()];
    if (updates.some((u) => u.clipId.startsWith("temp-"))) return { ok: false, error: "clip is still being created" };
    return {
        ok: true,
        value: {
            removed, removedSeconds,
            clipUpdates: updates.filter((u) => !writer.deletes.includes(u.clipId)),
            clipCreates: writer.creates,
            clipDeletes: writer.deletes,
            scenePatches: [...scenePatches].map(([sceneId, patch]) => ({ sceneId, patch })),
            sceneMoves,
            sceneCopies,
            linked: { clipIds: linked.map((c) => c.id) },
        },
    };
}
