// Where an ai.run result lands (phase 11, AiPlacement kinds): pure plans the controller writes as ONE persisted command
// (one undo step). A plan is a new track list (with any renumbering), field updates on existing clips and scenes, new
// clips, and clips to delete — written in that order, deletes last.
//
// - captions-track: a new captions track (lib/caption-placement.ts), cue times already in timeline seconds.
// - captions-track-translated: a new text track directly above the source track (upper text tracks renumbered when the
//   slot is taken), one clip per cue with the source clip's timing, style, and placement; untranslated cues keep the
//   source text and say so in their label; keepSource false deletes the source cues.
// - replace-audio: one new audio track per file; the clip covers the source item's window over `range` at the item's
//   speed, clamped to the file's length; the source is muted (a clip by volume 0, a scene by owning its sound: an audio
//   clip whose sceneId is the scene silences the scene's own audio in preview and export).
// - stack-video: the result on a new video track directly above the source's (upper video tracks renumbered when the
//   slot is taken), same window and speed, the source's transform, look, mask, and keyframes (scenes converted to clip
//   units), muted; the source hidden by opacity 0 unless hideSource is false; muteSource mutes the source's sound.
// - insert-media: each file on the first free track of its kind at `at` (or a new track).
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { CreateClipInput, TimelineClipUpdate } from "../backend/types";
import type { AiMediaRef, AiPlacement, AiSourceRange, AiTargetRef } from "../controller/ai-run";
import { aiMediaSourceResult, mediaFileName, type AiMediaSource } from "../ai/sources";
import { planCaptionPlacement } from "./caption-placement";
import { getTimelineSubtitleImportInputs } from "./subtitle-import";
import { captionStyleById, captionStyleJson } from "../text/captions";
import { parseTimelineKeyframes, type TimelineKeyframePoint } from "./timeline-editing-properties";
import { roundTimelineTime } from "./timeline-editing-shared";
import { sceneFitRect } from "../looks/fit";
import { frameAspect } from "../tracking/plan";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";

export interface AiPlacementState {
    clips: TimelineClip[];
    scenes: SceneData[];
    tracks: TimelineTrack[];
    /** The project's aspect ratio ("16:9"), to place a scene's look on a clip. */
    aspectRatio?: string | null;
}

export interface AiPlacementPlan {
    /** The whole new track list, or null when the tracks do not change. */
    tracks: TimelineTrack[] | null;
    /** Field updates on existing clips (renumbered tracks, muted or hidden sources). */
    clipUpdates: TimelineClipUpdate[];
    /** Field updates on existing scenes (renumbered tracks, hidden sources). */
    scenePatches: Array<{ sceneId: string; patch: Partial<SceneData> }>;
    creates: CreateClipInput[];
    /** Clips removed in the same step (translated captions with keepSource false). */
    deleteClipIds: string[];
}

type Result = { ok: true; value: AiPlacementPlan } | { ok: false; error: string };
const fail = (error: string): Result => ({ ok: false, error });

/** A result shorter than this does not land. */
const MIN_RESULT_SECONDS = 0.05;
const DEFAULT_STILL_SECONDS = 5;
const IMAGE_URL = /\.(png|jpe?g|webp|gif|svg|avif|bmp)(\?|#|$)/i;
const AUDIO_URL = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|weba)(\?|#|$)/i;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Mutable working copy of what a placement changes. */
class Draft {
    tracks: TimelineTrack[];
    private tracksChanged = false;
    private readonly clipUpdates = new Map<string, TimelineClipUpdate>();
    private readonly scenePatches = new Map<string, Partial<SceneData>>();
    readonly creates: CreateClipInput[] = [];
    readonly deleteClipIds: string[] = [];

    constructor(readonly state: AiPlacementState) {
        this.tracks = state.tracks.map((t) => ({ ...t }));
    }

    trackIndexOf(clip: TimelineClip): number {
        return this.clipUpdates.get(clip.id)?.trackIndex ?? clip.trackIndex;
    }

    updateClip(clipId: string, patch: Partial<TimelineClip>): void {
        this.clipUpdates.set(clipId, { ...(this.clipUpdates.get(clipId) ?? { clipId }), ...patch });
    }

    patchScene(sceneId: string, patch: Partial<SceneData>): void {
        this.scenePatches.set(sceneId, { ...(this.scenePatches.get(sceneId) ?? {}), ...patch });
    }

    addTrack(track: TimelineTrack, afterIndexOfType?: number): void {
        this.tracksChanged = true;
        const at = afterIndexOfType === undefined ? -1 : this.tracks.findIndex((t) => t.type === track.type && t.index === afterIndexOfType);
        if (at >= 0) this.tracks.splice(at + 1, 0, track);
        else this.tracks.push(track);
    }

    markTracksChanged(): void {
        this.tracksChanged = true;
    }

    uniqueLabel(type: TimelineTrack["type"], base: string): string {
        const taken = new Set(this.tracks.filter((t) => t.type === type).map((t) => t.label));
        if (!taken.has(base)) return base;
        for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
    }

    finish(): Result {
        const updates = [...this.clipUpdates.values()];
        if (updates.some((u) => u.clipId.startsWith("temp-")) || this.deleteClipIds.some((id) => id.startsWith("temp-"))) return fail("clip is still being created");
        return {
            ok: true,
            value: {
                tracks: this.tracksChanged ? this.tracks : null,
                clipUpdates: updates,
                scenePatches: [...this.scenePatches].map(([sceneId, patch]) => ({ sceneId, patch })),
                creates: this.creates,
                deleteClipIds: this.deleteClipIds,
            },
        };
    }
}

const DEFAULT_LABEL = { video: "V", text: "T" } as const;

/**
 * A new track of `type` directly above track `below`: index below + 1, every upper track of the type (and its clips,
 * and scenes on upper video tracks) moved up one when that slot is taken. Tracks still named by their index ("V3")
 * follow their new index.
 */
function insertTrackAbove(draft: Draft, type: "video" | "text", below: number, label: string): number {
    const index = below + 1;
    const { clips, scenes } = draft.state;
    const taken = draft.tracks.some((t) => t.type === type && t.index === index)
        || clips.some((c) => c.trackType === type && c.trackIndex === index)
        || (type === "video" && scenes.some((s) => Math.max(1, Number(s.trackIndex || 1)) === index));
    if (taken) {
        draft.tracks = draft.tracks.map((t) => {
            if (t.type !== type || t.index <= below) return t;
            const next = t.index + 1;
            return { ...t, index: next, label: t.label === `${DEFAULT_LABEL[type]}${t.index}` ? `${DEFAULT_LABEL[type]}${next}` : t.label };
        });
        draft.markTracksChanged();
        for (const clip of clips) if (clip.trackType === type && clip.trackIndex > below) draft.updateClip(clip.id, { trackIndex: clip.trackIndex + 1 });
        if (type === "video") {
            for (const scene of scenes) {
                const track = Math.max(1, Number(scene.trackIndex || 1));
                if (track > below) draft.patchScene(scene.id, { trackIndex: track + 1 });
            }
        }
    }
    draft.addTrack({ type, index, label, muted: false, locked: false, visible: true, volume: 1 }, below);
    return index;
}

function newTrackAtEnd(draft: Draft, type: "audio" | "video", label: string, minIndex = 1): number {
    const index = Math.max(minIndex - 1, ...draft.tracks.filter((t) => t.type === type).map((t) => t.index),
        ...draft.state.clips.filter((c) => c.trackType === type).map((c) => c.trackIndex),
        ...draft.creates.filter((c) => c.trackType === type).map((c) => Number(c.trackIndex) || 0)) + 1;
    draft.addTrack({ type, index, label: draft.uniqueLabel(type, label), muted: false, locked: false, visible: true, volume: 1 });
    return index;
}

/** The timeline window a result over `range` covers, clamped to the item and to the file's length. */
function resultWindow(source: AiMediaSource, range: AiSourceRange | undefined, mediaSeconds: number | undefined): { start: number; end: number } {
    const speed = source.speed > 0 ? source.speed : 1;
    const r0 = Math.min(source.endSeconds, Math.max(source.startSeconds, Number(range?.startSeconds ?? source.startSeconds)));
    const r1 = Math.min(source.endSeconds, Math.max(r0, Number(range?.endSeconds ?? source.endSeconds)));
    const start = roundTimelineTime(source.timelineStart + (r0 - source.startSeconds) / speed);
    let end = roundTimelineTime(source.timelineStart + (r1 - source.startSeconds) / speed);
    if (mediaSeconds !== undefined && Number.isFinite(mediaSeconds) && mediaSeconds > 0) end = Math.min(end, roundTimelineTime(start + mediaSeconds / speed));
    return { start, end: Math.min(end, roundTimelineTime(source.timelineEnd)) };
}

function resolveSource(state: AiPlacementState, target: AiTargetRef | undefined): { ok: true; source: AiMediaSource; clip?: TimelineClip; scene?: SceneData } | { ok: false; error: string } {
    if (!target || (!target.clipId && !target.sceneId)) return { ok: false, error: "the placement needs the clip or scene the tool ran on" };
    const resolved = aiMediaSourceResult(state, target);
    if (!resolved.ok) return resolved;
    return {
        ok: true,
        source: resolved.source,
        clip: target.sceneId ? undefined : state.clips.find((c) => c.id === target.clipId),
        scene: target.sceneId ? state.scenes.find((s) => s.id === target.sceneId) : undefined,
    };
}

// ── captions ──────────────────────────────────────────────

function placeCaptions(state: AiPlacementState, placement: Extract<AiPlacement, { kind: "captions-track" }>): Result {
    const plan = planCaptionPlacement(placement.cues, state.tracks, { style: placement.style, ...(placement.label ? { label: placement.label } : {}) });
    return { ok: true, value: { tracks: plan.tracks, clipUpdates: [], scenePatches: [], creates: plan.inputs, deleteClipIds: [] } };
}

function placeTranslated(state: AiPlacementState, placement: Extract<AiPlacement, { kind: "captions-track-translated" }>): Result {
    const sourceIndex = placement.sourceTrackIndex;
    const sources = state.clips
        .filter((c) => c.trackType === "text" && c.trackIndex === sourceIndex && (c.textContent ?? "").trim().length > 0)
        .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    if (!placement.keepSource && state.tracks.some((t) => t.type === "text" && t.index === sourceIndex && t.locked)) return fail("the captions track is locked");
    const draft = new Draft(state);
    const index = insertTrackAbove(draft, "text", sourceIndex, draft.uniqueLabel("text", `Captions (${placement.language})`));
    const untranslated = new Set(placement.untranslated ?? []);
    const fallbackStyle = (() => {
        const base = JSON.parse(JSON.stringify(getTimelineSubtitleImportInputs([{ startTime: 0, endTime: 1, text: "x" }], [{ type: "text", index }], placement.style === "subtitle" ? "subtitle" : "caption")[0] ?? {}));
        const preset = (base.textStyle as string | undefined) ?? null;
        return placement.style && captionStyleById(placement.style) ? captionStyleJson(placement.style, preset) ?? preset : preset;
    })();
    const cues = [...placement.cues].map((cue, i) => ({ cue, i })).sort((a, b) => a.cue.startTime - b.cue.startTime);
    cues.forEach(({ cue, i }, order) => {
        const source = sources[i];
        const keepText = untranslated.has(i) && source?.textContent;
        const text = keepText ? source!.textContent! : cue.text;
        const nextStart = order + 1 < cues.length ? cues[order + 1].cue.startTime : Number.POSITIVE_INFINITY;
        const startTime = roundTimelineTime(Math.max(0, cue.startTime));
        const endTime = roundTimelineTime(Math.min(cue.endTime, nextStart));
        if (!(endTime - startTime >= MIN_RESULT_SECONDS) || !text.trim()) return;
        draft.creates.push({
            trackType: "text", trackIndex: index, startTime, endTime, textContent: text,
            textStyle: source?.textStyle ?? sources[0]?.textStyle ?? fallbackStyle,
            positionX: source?.positionX ?? 0.5, positionY: source?.positionY ?? 0.82, scale: source?.scale ?? 1, opacity: source?.opacity ?? 1,
            ...(keepText ? { label: `Untranslated (${placement.language})` } : {}),
        });
    });
    if (draft.creates.length === 0) return fail("the translation has no captions to place");
    if (!placement.keepSource) draft.deleteClipIds.push(...sources.map((c) => c.id));
    return draft.finish();
}

// ── replace-audio ─────────────────────────────────────────

function placeReplaceAudio(state: AiPlacementState, placement: Extract<AiPlacement, { kind: "replace-audio" }>): Result {
    if (placement.media.length === 0) return fail("the tool returned no audio");
    const resolved = resolveSource(state, placement.source);
    if (!resolved.ok) return fail(resolved.error);
    const { source, clip, scene } = resolved;
    const draft = new Draft(state);
    const preservePitch = (clip ?? scene)?.preservePitch;
    for (const media of placement.media) {
        const { start, end } = resultWindow(source, placement.range, media.durationSeconds);
        if (end - start < MIN_RESULT_SECONDS) return fail("the result is too short to place");
        const trackIndex = newTrackAtEnd(draft, "audio", media.role ? titleCase(media.role) : "Voice");
        draft.creates.push({
            trackType: "audio", trackIndex, startTime: start, endTime: end, mediaUrl: media.url, mediaType: "audio",
            label: media.name || (media.role ? `${titleCase(media.role)} · ${source.label}` : `Voice · ${source.label}`),
            playbackSpeed: source.speed, trimStart: 0, trimEnd: roundTimelineTime((end - start) * source.speed), volume: 1,
            ...(preservePitch === false ? { preservePitch: false } : {}),
            ...(scene ? { sceneId: scene.id } : {}),
        });
    }
    if (clip && clip.volume !== 0) draft.updateClip(clip.id, { volume: 0 });
    return draft.finish();
}

// ── stack-video ───────────────────────────────────────────

interface ClipLook {
    positionX: number;
    positionY: number;
    scale: number;
    rotationDegrees: number;
    opacity: number;
    keyframesJson: string | null;
    extra: Partial<TimelineClip>;
}

const finite = (value: unknown, fallback: number) => {
    const n = Number(value);
    return value === null || value === undefined || !Number.isFinite(n) ? fallback : n;
};

/** Keyframes re-based to a window starting `offset` seconds into the item and `duration` long; volume never copied (the result is muted). */
function rebaseKeyframes(points: TimelineKeyframePoint[], offset: number, duration: number, map?: (point: TimelineKeyframePoint) => TimelineKeyframePoint): string | null {
    const out: TimelineKeyframePoint[] = [];
    for (const point of points) {
        const time = roundTimelineTime(point.time - offset);
        if (time < -0.0005 || time > duration + 0.0005) continue;
        const mapped: TimelineKeyframePoint = { ...(map ? map(point) : point), time: Math.max(0, time) };
        delete mapped.volume;
        if (Object.keys(mapped).length > 1) out.push(mapped);
    }
    return out.length > 0 ? JSON.stringify({ keyframes: out }) : null;
}

/** A video clip's look and placement, copied for the stacked result (its keyframes re-based to the result's window). */
function clipLookOf(clip: TimelineClip, offset: number, duration: number, mediaScale: number): ClipLook {
    const scaleOf = (s: number) => round6(s * mediaScale);
    const keyframesJson = rebaseKeyframes(parseTimelineKeyframes(clip.keyframesJson), offset, duration, (p) => (p.scale === undefined ? p : { ...p, scale: scaleOf(p.scale) }));
    return {
        positionX: finite(clip.positionX, 0.5), positionY: finite(clip.positionY, 0.5), scale: scaleOf(finite(clip.scale, 1)),
        rotationDegrees: finite(clip.rotationDegrees, 0), opacity: finite(clip.opacity, 1), keyframesJson,
        extra: {
            horizontalFlip: clip.horizontalFlip, verticalFlip: clip.verticalFlip,
            cropLeft: clip.cropLeft, cropRight: clip.cropRight, cropTop: clip.cropTop, cropBottom: clip.cropBottom,
            brightness: clip.brightness, contrast: clip.contrast, saturation: clip.saturation,
            visualFilter: clip.visualFilter, filterIntensity: clip.filterIntensity ?? null, adjustmentsJson: clip.adjustmentsJson ?? null,
            blurStrength: clip.blurStrength, blendMode: clip.blendMode, maskJson: clip.maskJson ?? null,
        },
    };
}

/**
 * A scene's fit and transform as overlay clip fields (the overlay box at scale 1 is the media's pixels over the
 * 1080p reference frame, its centre posX of the free space; tracking/plan.ts sourceToFrame): the clip scale makes the
 * box as tall as the scene's fit rect, the position puts its centre where the scene's is. A "fill" scene keeps its
 * height (a clip cannot stretch one axis). Unknown media sizes count as the frame's shape.
 */
function sceneLookOf(scene: SceneData, aspect: number, result: { width?: number; height?: number }, offset: number, duration: number): ClipLook {
    const refW = aspect > 1 ? 1920 : 1080;
    const refH = refW / aspect;
    const sceneSrc = finite(scene.sourceWidth, 0) > 0 && finite(scene.sourceHeight, 0) > 0
        ? { width: Number(scene.sourceWidth), height: Number(scene.sourceHeight) }
        : result.width && result.height ? { width: result.width, height: result.height } : { width: refW, height: refH };
    // The result keeps the source's shape; its pixel height decides the box at scale 1.
    const resultH = result.height && result.height > 0 ? result.height : sceneSrc.height;
    const resultW = result.width && result.width > 0 ? result.width : (sceneSrc.width / sceneSrc.height) * resultH;
    const place = (s: number, offX: number, offY: number) => {
        const rect = sceneFitRect(scene.fitMode, sceneSrc, { width: aspect, height: 1 }, s, offX, offY);
        const scale = rect.height * refH / resultH;
        const anchorW = (resultW / refW) * scale;
        const anchorH = (resultH / refH) * scale;
        const cx = (rect.x + rect.width / 2) / aspect;
        const cy = rect.y + rect.height / 2;
        const pos = (centre: number, anchor: number) => (anchor < 1 - 1e-9 ? Math.min(1, Math.max(0, (centre - anchor / 2) / (1 - anchor))) : 0.5);
        return { scale: round6(scale), positionX: round6(pos(cx, anchorW)), positionY: round6(pos(cy, anchorH)) };
    };
    const s0 = finite(scene.transformScale, 1) > 0 ? finite(scene.transformScale, 1) : 1;
    const x0 = finite(scene.transformOffsetX, 0);
    const y0 = finite(scene.transformOffsetY, 0);
    const base = place(s0, x0, y0);
    const keyframesJson = rebaseKeyframes(parseTimelineKeyframes(scene.keyframesJson), offset, duration, (p) => {
        if (p.scale === undefined && p.position_x === undefined && p.position_y === undefined) return p;
        const placed = place(p.scale ?? s0, p.position_x ?? x0, p.position_y ?? y0);
        const next: TimelineKeyframePoint = { ...p };
        if (p.scale !== undefined) next.scale = placed.scale;
        if (p.position_x !== undefined) next.position_x = placed.positionX;
        if (p.position_y !== undefined) next.position_y = placed.positionY;
        return next;
    });
    return {
        ...base, rotationDegrees: finite(scene.rotationDegrees, 0), opacity: finite(scene.opacity, 1), keyframesJson,
        extra: { visualFilter: scene.visualFilter ?? "none", filterIntensity: scene.filterIntensity ?? null, adjustmentsJson: scene.adjustmentsJson ?? null, maskJson: scene.maskJson ?? null },
    };
}

function placeStackVideo(state: AiPlacementState, placement: Extract<AiPlacement, { kind: "stack-video" }>): Result {
    const media = placement.media;
    if (!media?.url) return fail("the tool returned no video");
    const resolved = resolveSource(state, placement.source);
    if (!resolved.ok) return fail(resolved.error);
    const { source, clip, scene } = resolved;
    if (source.kind === "audio") return fail("a video result needs a video clip or scene");
    const { start, end } = resultWindow(source, placement.range, media.durationSeconds);
    if (end - start < MIN_RESULT_SECONDS) return fail("the result is too short to place");
    const draft = new Draft(state);
    const index = insertTrackAbove(draft, "video", source.trackIndex, "");
    const created = draft.tracks.find((t) => t.type === "video" && t.index === index)!;
    created.label = draft.uniqueLabel("video", `V${index}`);
    const offset = start - source.timelineStart;
    const duration = end - start;
    const resultSize = { width: media.width, height: media.height };
    const look = scene
        ? sceneLookOf(scene, frameAspect(state.aspectRatio), resultSize, offset, duration)
        : clipLookOf(clip!, offset, duration, placement.sourceSize && media.width && placement.sourceSize.width > 0 ? placement.sourceSize.width / media.width : 1);
    const image = (media.mimeType ?? "").startsWith("image/") || IMAGE_URL.test(media.url);
    draft.creates.push({
        trackType: "video", trackIndex: index, startTime: start, endTime: end, mediaUrl: media.url, mediaType: image ? "image" : "video",
        label: media.name || mediaFileName(media.url) || source.label,
        playbackSpeed: image ? 1 : source.speed, trimStart: 0, ...(image ? {} : { trimEnd: roundTimelineTime(duration * source.speed) }), volume: 0,
        ...((clip ?? scene)?.preservePitch === false ? { preservePitch: false } : {}),
        positionX: look.positionX, positionY: look.positionY, scale: look.scale, rotationDegrees: look.rotationDegrees, opacity: look.opacity,
        ...(look.keyframesJson ? { keyframesJson: look.keyframesJson } : {}),
        ...look.extra,
    });
    if (placement.hideSource !== false) {
        if (clip) draft.updateClip(clip.id, { opacity: 0 });
        else draft.patchScene(scene!.id, { opacity: 0 });
    }
    if (placement.muteSource) {
        if (clip) {
            if (clip.volume !== 0) draft.updateClip(clip.id, { volume: 0 });
        } else if (scene && source.hasAudio) {
            muteScene(draft, scene, placement.audioClipId, { start, end }, media);
        }
    }
    return draft.finish();
}

/**
 * Silences a scene's own sound over a window by ownership (an audible audio clip whose sceneId is the scene): the clip
 * that drives the result (lip sync's audio) takes the scene when it is free, else a new audio clip plays the result's
 * own soundtrack over the window.
 */
function muteScene(draft: Draft, scene: SceneData, audioClipId: string | undefined, window: { start: number; end: number }, media: AiMediaRef): void {
    const driving = audioClipId ? draft.state.clips.find((c) => c.id === audioClipId && c.trackType === "audio") : undefined;
    if (driving && !driving.sceneId && !driving.id.startsWith("temp-")) {
        draft.updateClip(driving.id, { sceneId: scene.id });
        return;
    }
    const trackIndex = newTrackAtEnd(draft, "audio", "Lip sync");
    draft.creates.push({
        trackType: "audio", trackIndex, startTime: window.start, endTime: window.end, mediaUrl: media.url, mediaType: "audio",
        label: `Lip sync · ${media.name || mediaFileName(media.url)}`, trimStart: 0, trimEnd: window.end - window.start, volume: 1, sceneId: scene.id,
    });
}

// ── insert-media ──────────────────────────────────────────

function mediaKind(media: AiMediaRef): "video" | "image" | "audio" {
    const mime = (media.mimeType ?? "").toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (IMAGE_URL.test(media.url)) return "image";
    if (AUDIO_URL.test(media.url)) return "audio";
    return "video";
}

function placeInsertMedia(state: AiPlacementState, placement: Extract<AiPlacement, { kind: "insert-media" }>): Result {
    if (placement.media.length === 0) return fail("the tool returned no media");
    const at = roundTimelineTime(Math.max(0, Number.isFinite(placement.at) ? placement.at : 0));
    const draft = new Draft(state);
    const busy = (type: "video" | "audio", index: number, start: number, end: number) => {
        const overlaps = (s: number, e: number) => s < end - 0.001 && e > start + 0.001;
        if (state.clips.some((c) => c.trackType === type && c.trackIndex === index && overlaps(c.startTime, c.endTime))) return true;
        if (draft.creates.some((c) => c.trackType === type && c.trackIndex === index && overlaps(Number(c.startTime), Number(c.endTime)))) return true;
        if (type === "video") {
            return state.scenes.some((s, i) => Math.max(1, Number(s.trackIndex || 1)) === index && overlaps(getSceneStart(s, state.scenes, i), getSceneStart(s, state.scenes, i) + getSceneDuration(s)));
        }
        return false;
    };
    for (const media of placement.media) {
        const kind = mediaKind(media);
        const duration = roundTimelineTime(media.durationSeconds && media.durationSeconds > 0 ? media.durationSeconds : DEFAULT_STILL_SECONDS);
        const end = roundTimelineTime(at + duration);
        const type = kind === "audio" ? "audio" : "video";
        const minIndex = type === "video" ? 2 : 1;
        const free = draft.tracks
            .filter((t) => t.type === type && t.index >= minIndex && !t.locked && t.visible !== false)
            .sort((a, b) => a.index - b.index)
            .find((t) => !busy(type, t.index, at, end));
        const trackIndex = free?.index ?? newTrackAtEnd(draft, type, type === "video" ? "V" : "A", minIndex);
        if (!free) {
            const added = draft.tracks.find((t) => t.type === type && t.index === trackIndex)!;
            added.label = draft.uniqueLabel(type, `${type === "video" ? "V" : "A"}${trackIndex}`);
        }
        draft.creates.push({
            trackType: type, trackIndex, startTime: at, endTime: end, mediaUrl: media.url, mediaType: kind,
            label: media.name || mediaFileName(media.url) || titleCase(kind),
            ...(kind === "image" ? {} : { trimStart: 0, trimEnd: duration }),
        });
    }
    return draft.finish();
}

/** The writes that place an ai.run result (one undo step), or why it cannot land. */
export function planAiPlacement(state: AiPlacementState, placement: AiPlacement): Result {
    switch (placement.kind) {
        case "captions-track":
            return placeCaptions(state, placement);
        case "captions-track-translated":
            return placeTranslated(state, placement);
        case "replace-audio":
            return placeReplaceAudio(state, placement);
        case "stack-video":
            return placeStackVideo(state, placement);
        case "insert-media":
            return placeInsertMedia(state, placement);
        default:
            return fail(`unknown placement ${(placement as { kind?: string }).kind}`);
    }
}
