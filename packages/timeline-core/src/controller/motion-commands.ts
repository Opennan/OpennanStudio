// Pure planning for the phase 10b motion commands (animation.set, keyframe.*, speed.set, text.*,
// caption.style.apply, effect.layer.add). The controller turns each plan into one persisted command
// (one undo entry, however many backend writes).
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { CreateClipInput, SceneMove, TimelineClipUpdate } from "../backend/types";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { roundTimelineTime } from "../lib/timeline-editing-shared";
import { nextTrackForType, resolveNonOverlappingTrackIndex } from "../lib/timeline-tracks";
import { getSceneTrackIndex } from "../timeline/canvas/scene-position";
import { getSceneDuration, getSceneSourceDuration, getSceneStart } from "../timeline/scene-timing";
import { parseAnimationSpec, serializeAnimationSpec } from "../motion/animation-spec";
import { EASING_IDS, type EasingId } from "../motion/easing";
import { MASK_KEYFRAME_CHANNELS, clampMaskKeyframeValues } from "../looks/masks";
import { KEYFRAME_CHANNELS, KEYFRAME_META_KEYS, pointAt, removeKeyframe, retimeKeyframe, serializeKeyframes, setKeyframe, setKeyframeEasing } from "../motion/keyframes";
import { animationById, type AnimationTarget } from "../motion/registry";
import type { AnimationSlot, AnimationSpec } from "../motion/types";
import { getTimelineTextClipKind } from "../lib/timeline-text-style";
import { textTemplateById, templateStyleJson } from "../text/templates";
import { captionStyleById, captionStyleJson } from "../text/captions";
import { sceneSpeedProfile } from "../motion/speed";
import { fail, nextProfile, ok, rescaleKeyframes, roundSpeedTime, samePlace, speedFields, storedProfile, type Plan, type SpeedRequest } from "./speed-plan";

export type { Plan, SpeedClip, SpeedRequest } from "./speed-plan";
export { MIN_SPEED_LENGTH, planClipSpeed } from "./speed-plan";

export interface SceneSpeedPlan {
    patch: Partial<SceneData>;
    moves: SceneMove[];
    clipUpdates: TimelineClipUpdate[];
}

const rawPosition = (scene: SceneData | undefined) => Number(scene?.timelinePositionSeconds) || 0;

/**
 * speed.set on a scene: the media span stays (source seconds), the timeline length follows the speed, and
 * everything that starts at or after the scene's old end — later scenes on its track and timeline clips — moves
 * by the length change (the scene edge-trim ripple, nle-timeline handleUpdateSceneDuration). The length change is
 * the real one: the scene's stored fields give its new length (sceneTimelineDuration), and a speed too fast
 * for MIN_SPEED_LENGTH is clamped. Like planClipSpeed, `scenes`/`clips` are the state before the edit (or the
 * gesture) and `current` the state shown now; every scene or clip whose place differs from either is written.
 */
export function planSceneSpeed(
    scenes: SceneData[], clips: TimelineClip[], scene: SceneData, request: SpeedRequest,
    current: { scenes: SceneData[]; clips: TimelineClip[] } = { scenes, clips },
): Plan<SceneSpeedPlan> {
    const p0 = sceneSpeedProfile(scene);
    const next = nextProfile(p0, request);
    if (!next.ok) return next;
    const span = getSceneSourceDuration(scene);
    const p1 = storedProfile(next.value, span);
    const fields = speedFields(p1);
    const index = scenes.indexOf(scene);
    const start = getSceneStart(scene, scenes, index);
    const d0 = getSceneDuration(scene);
    const d1 = getSceneDuration({ ...scene, ...fields });
    const keyframesJson = rescaleKeyframes(scene.keyframesJson, p0, d0, p1, d1);
    const patch: Partial<SceneData> = { ...fields, ...(keyframesJson !== undefined ? { keyframesJson } : {}) };
    const oldEnd = start + d0;
    const delta = d1 - d0;
    const finalPositions = new Map<string, number>();
    const finalClips = new Map<string, { startTime: number; endTime: number }>();
    if (Math.abs(delta) > 0.0005) {
        const track = getSceneTrackIndex(scene);
        let rippled = false;
        scenes.forEach((other, i) => {
            if (other.id === scene.id || getSceneTrackIndex(other) !== track) return;
            const otherStart = getSceneStart(other, scenes, i);
            if (otherStart >= oldEnd - 0.01) {
                finalPositions.set(other.id, roundSpeedTime(Math.max(0.001, otherStart + delta)));
                rippled = true;
            }
        });
        for (const c of clips) {
            if (c.startTime >= oldEnd - 0.01) finalClips.set(c.id, { startTime: roundSpeedTime(Math.max(0, c.startTime + delta)), endTime: roundSpeedTime(Math.max(0, c.endTime + delta)) });
        }
        // Scenes without an absolute position are laid out end to end; pin this one so the ripple is well defined.
        if (!(Number(scene.timelinePositionSeconds) > 0) && rippled) finalPositions.set(scene.id, roundSpeedTime(Math.max(0.001, start)));
    }
    const shownScenes = new Map(current.scenes.map((s) => [s.id, s]));
    const moves: SceneMove[] = [];
    for (const other of scenes) {
        const target = finalPositions.get(other.id) ?? rawPosition(other);
        const shown = shownScenes.get(other.id);
        if (target !== rawPosition(other) || (shown && target !== rawPosition(shown))) moves.push({ sceneId: other.id, timelinePositionSeconds: target });
    }
    const shownClips = new Map(current.clips.map((c) => [c.id, c]));
    const clipUpdates: TimelineClipUpdate[] = [];
    for (const c of clips) {
        const target = finalClips.get(c.id) ?? { startTime: c.startTime, endTime: c.endTime };
        const shown = shownClips.get(c.id);
        if (!samePlace(c, target) || (shown && !samePlace(shown, target))) clipUpdates.push({ clipId: c.id, ...target });
    }
    return ok({ patch, moves, clipUpdates });
}

export interface EffectLayerPlan {
    /** The full track list when a new effect track is needed. */
    tracks: TimelineTrack[] | null;
    input: CreateClipInput;
}

/** effect.layer.add: the first unlocked effect track free over the span, else a new effect track. */
export function planEffectLayer(
    tracks: TimelineTrack[], clips: TimelineClip[],
    request: { effectId: string; startTime: number; endTime: number; trackIndex?: number; label?: string; tracks?: TimelineTrack[] },
): Plan<EffectLayerPlan> {
    const start = Math.max(0, request.startTime);
    const end = request.endTime;
    if (!(end - start >= 0.05)) return fail("the effect layer needs a positive length");
    const label = request.label || request.effectId;
    if (request.tracks) {
        // The caller resolved the row (a drop onto a new effect row): write its track list, place on that row.
        const row = request.tracks.find((t) => t.type === "effect" && t.index === request.trackIndex);
        if (!row) return fail("the effect track does not exist");
        if (row.locked) return fail("the track is locked");
        const changed = JSON.stringify(request.tracks) !== JSON.stringify(tracks);
        return ok({
            tracks: changed ? request.tracks : null,
            input: { trackType: "effect", trackIndex: row.index, startTime: roundTimelineTime(start), endTime: roundTimelineTime(end), mediaType: "effect", label },
        });
    }
    let index: number | null = null;
    let nextTracks: TimelineTrack[] | null = null;
    if (request.trackIndex !== undefined) {
        const track = tracks.find((t) => t.type === "effect" && t.index === request.trackIndex);
        if (track?.locked) return fail("the track is locked");
        if (track && resolveNonOverlappingTrackIndex(clips, "effect", [track.index], start, end) !== null) index = track.index;
    }
    if (index === null) {
        const lanes = tracks.filter((t) => t.type === "effect" && !t.locked && t.visible !== false).map((t) => t.index).sort((a, b) => a - b);
        index = lanes.length ? resolveNonOverlappingTrackIndex(clips, "effect", lanes, start, end) : null;
    }
    if (index === null) {
        const added = nextTrackForType(tracks, "effect") as TimelineTrack;
        nextTracks = [...tracks, added];
        index = added.index;
    }
    return ok({
        tracks: nextTracks,
        input: { trackType: "effect", trackIndex: index, startTime: roundTimelineTime(start), endTime: roundTimelineTime(end), mediaType: "effect", label },
    });
}

// ── animation.set ───────────────────────────────────────

export interface AnimationRequest {
    slot: AnimationSlot;
    animationId: string | null;
    duration?: number;
}

/** The new `animationJson` of an item: a combo replaces in and out (and the other way round); null removes a slot. */
export function planAnimation(target: AnimationTarget | null, currentJson: string | null | undefined, request: AnimationRequest): Plan<string | null> {
    if (!target) return fail("this item cannot be animated");
    if (request.slot === "loop" && target === "clip") return fail("video and image clips use combo animations, not loops");
    if (request.slot === "combo" && target === "text") return fail("text uses loop animations, not combos");
    const spec: AnimationSpec = { ...parseAnimationSpec(currentJson) };
    if (request.animationId === null) {
        delete spec[request.slot];
        return ok(serializeAnimationSpec(spec));
    }
    const def = animationById(target, request.slot, request.animationId);
    if (!def) return fail(`unknown ${request.slot} animation "${request.animationId}"`);
    const seconds = request.duration !== undefined && Number.isFinite(request.duration) && request.duration > 0 ? request.duration : def.defaultDuration;
    if (request.slot === "combo") {
        delete spec.in;
        delete spec.out;
        spec.combo = request.duration !== undefined && seconds > 0 ? { id: def.id, duration: Math.round(seconds * 1000) / 1000 } : { id: def.id };
    } else if (request.slot === "loop") {
        spec.loop = { id: def.id, period: Math.round(seconds * 1000) / 1000 };
    } else {
        delete spec.combo;
        spec[request.slot] = { id: def.id, duration: Math.round(Math.max(0.1, seconds) * 1000) / 1000 };
    }
    return ok(serializeAnimationSpec(spec));
}

// ── keyframes ───────────────────────────────────────────

export type KeyframeRequest =
    | { type: "keyframe.set"; time: number; values: Record<string, number>; easing?: EasingId; bezier?: [number, number, number, number] }
    | { type: "keyframe.remove"; time: number; channels?: string[] }
    | { type: "keyframe.easing"; time: number; easing: EasingId; bezier?: [number, number, number, number] }
    | { type: "keyframe.retime"; from: number; to: number; channels?: string[]; values?: Record<string, number> };

// Mask channels (phase 10c, looks/masks.ts) ride in the same keyframes.
const CHANNEL_SET = new Set<string>([...KEYFRAME_CHANNELS, ...MASK_KEYFRAME_CHANNELS]);
/** Most keyframes one channel may hold (the export writes each channel as one ffmpeg expression). */
export const MAX_KEYFRAMES_PER_CHANNEL = 200;

/** The new `keyframesJson` of an item of `duration` seconds (times are item-local). */
export function planKeyframes(currentJson: string | null | undefined, duration: number, request: KeyframeRequest): Plan<string | null> {
    if (request.type === "keyframe.retime") return planRetime(currentJson, duration, request);
    if (!Number.isFinite(request.time) || request.time < -0.001 || request.time > duration + 0.001) return fail("the keyframe time is outside the item");
    const time = Math.min(duration, Math.max(0, request.time));
    const points = parseTimelineKeyframes(currentJson);
    if (request.type === "keyframe.set") {
        const entries = Object.entries(request.values ?? {});
        if (entries.length === 0) return fail("keyframe.set needs channel values");
        const unknown = entries.find(([key, value]) => !CHANNEL_SET.has(key) || typeof value !== "number" || !Number.isFinite(value));
        if (unknown) return fail(`unknown keyframe channel or value "${unknown[0]}"`);
        if (request.easing && !EASING_IDS.includes(request.easing)) return fail("unknown easing");
        // Mask channels hold values in the mask's ranges (parseMask's rules), as mask.set writes them.
        const next = setKeyframe(points, time, clampMaskKeyframeValues(request.values), { easing: request.easing, bezier: request.bezier });
        const count = (list: typeof points, key: string) => list.filter((point) => typeof point[key] === "number").length;
        // Only a new point is refused, so an older project past the cap can still edit its points.
        const crowded = entries.find(([key]) => count(next, key) > MAX_KEYFRAMES_PER_CHANNEL && count(next, key) > count(points, key));
        if (crowded) return fail(`a channel can hold at most ${MAX_KEYFRAMES_PER_CHANNEL} keyframes ("${crowded[0]}" is full)`);
        return ok(serializeKeyframes(next));
    }
    if (!pointAt(points, time)) return fail("there is no keyframe at that time");
    if (request.type === "keyframe.remove") return ok(serializeKeyframes(removeKeyframe(points, time, request.channels)));
    if (!EASING_IDS.includes(request.easing)) return fail("unknown easing");
    return ok(serializeKeyframes(setKeyframeEasing(points, time, request.easing, request.bezier)));
}

/** keyframe.retime: the point at `from` (within 1 ms) to `to`, clamped into [0, duration]. */
function planRetime(currentJson: string | null | undefined, duration: number, request: Extract<KeyframeRequest, { type: "keyframe.retime" }>): Plan<string | null> {
    if (!Number.isFinite(request.from) || !Number.isFinite(request.to)) return fail("keyframe.retime needs numeric from and to times");
    const points = parseTimelineKeyframes(currentJson);
    const source = pointAt(points, request.from);
    if (!source) return fail("there is no keyframe at that time");
    const channels = request.channels;
    if (channels !== undefined) {
        // Any channel name is accepted (new channel families keep working); meta keys are not channels.
        if (!Array.isArray(channels) || channels.length === 0 || channels.some((key) => typeof key !== "string" || KEYFRAME_META_KEYS.includes(key))) {
            return fail("keyframe.retime channels must be a non-empty list of channel names");
        }
        if (!channels.some((key) => typeof source[key] === "number")) return fail("the keyframe at that time has none of those channels");
    }
    const values = request.values;
    if (values !== undefined) {
        const bad = Object.entries(values ?? {}).find(([key, value]) => !CHANNEL_SET.has(key) || typeof value !== "number" || !Number.isFinite(value));
        if (bad || values === null || typeof values !== "object") return fail(`unknown keyframe channel or value "${bad?.[0] ?? ""}"`);
    }
    const to = Math.min(Math.max(0, duration), Math.max(0, request.to));
    const moved = retimeKeyframe(points, request.from, to, channels);
    return ok(serializeKeyframes(values && Object.keys(values).length > 0 ? setKeyframe(moved, to, clampMaskKeyframeValues(values)) : moved));
}

// ── text and captions ───────────────────────────────────

const isTextClip = (clip: TimelineClip) => clip.trackType === "text";

function styleObject(json: string | null | undefined): Record<string, unknown> {
    if (!json) return {};
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** text.style.set: merge a patch into each text clip's style (a null value removes the key). */
export function planTextStyle(clips: TimelineClip[], clipIds: string[], patch: Record<string, unknown>): Plan<TimelineClipUpdate[]> {
    const targets = clips.filter((c) => clipIds.includes(c.id) && isTextClip(c));
    if (targets.length === 0) return fail("no matching text clips");
    if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) return fail("text.style.set needs a style patch");
    return ok(targets.map((clip) => {
        const style = styleObject(clip.textStyle);
        for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete style[key];
            else style[key] = value;
        }
        return { clipId: clip.id, startTime: clip.startTime, endTime: clip.endTime, textStyle: JSON.stringify(style) };
    }));
}

/** text.template.apply: the template's style (caption keys of the old style kept) and, when it has one, its animation. */
export function planTextTemplate(clips: TimelineClip[], clipIds: string[], templateId: string): Plan<TimelineClipUpdate[]> {
    const template = textTemplateById(templateId);
    if (!template) return fail(`unknown text template "${templateId}"`);
    const targets = clips.filter((c) => clipIds.includes(c.id) && isTextClip(c));
    if (targets.length === 0) return fail("no matching text clips");
    return ok(targets.map((clip) => ({
        clipId: clip.id, startTime: clip.startTime, endTime: clip.endTime,
        textStyle: templateStyleJson(templateId, clip.textStyle),
        ...(template.animation ? { animationJson: serializeAnimationSpec(template.animation) } : {}),
    })));
}

/** caption.style.apply: the given caption clips, else every caption clip on `trackIndex`, else every caption clip. */
export function planCaptionStyle(clips: TimelineClip[], request: { clipIds?: string[]; trackIndex?: number; styleId: string }): Plan<TimelineClipUpdate[]> {
    if (!captionStyleById(request.styleId)) return fail(`unknown caption style "${request.styleId}"`);
    const isCaption = (clip: TimelineClip) => isTextClip(clip) && getTimelineTextClipKind(clip.textStyle, clip.label) !== "text";
    const targets = clips.filter((clip) => {
        if (request.clipIds?.length) return request.clipIds.includes(clip.id) && isTextClip(clip);
        if (request.trackIndex !== undefined) return isCaption(clip) && clip.trackIndex === request.trackIndex;
        return isCaption(clip);
    });
    if (targets.length === 0) return fail("there are no caption clips");
    return ok(targets.map((clip) => ({
        clipId: clip.id, startTime: clip.startTime, endTime: clip.endTime, textStyle: captionStyleJson(request.styleId, clip.textStyle),
    })));
}
