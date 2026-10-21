// Planning for motion tracking (phase 10d): which frames of which media a `tracking.run` analyses, and the keyframes
// `tracking.apply` writes so followers move with the tracked point. Pure; the controller persists the result as one
// undo entry, and the host (timeline-react) decodes the frames and runs the tracker.
//
// Spaces:
//   source  fractions of the tracked item's own picture (what the tracker sees: the decoded video frame). The item's
//           mask lives in the same space (looks/masks.ts: x, y are fractions of the item's pixel box).
//   frame   fractions of the output frame. A tracked point goes from source to frame through the tracked item's
//           placement at that moment: a V2+ clip as the preview and the export place every overlay (box at scale 1 =
//           source pixels over the 1920/1080 reference frame, posX over the free space, scale, scaleX, dx/dy,
//           rotation about the centre, flips), a main-track scene as looks/fit.ts sceneFitRect with its transform.
//
// Followers keep their offset: each one stays where it is at the moment the track first covers it, and from then on
// moves by the tracked point's frame displacement — converted into its own position units (clip posX over the free
// space, the box from `anchor`; graphics layers and scene offsets move linearly). Times go from the tracked item's
// local clock to timeline seconds to the follower's local clock, clamped to the follower. The dense per-frame
// positions are decimated (a keyframe is kept where linear interpolation between the kept ones would be off by more
// than a small tolerance), written as linear keyframes over the tracked span; the follower's other keyframes stay.
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { TimelineClipUpdate } from "../backend/types";
import { parseTimelineKeyframes, type TimelineKeyframePoint } from "../lib/timeline-editing-properties";
import { roundTimelineTime } from "../lib/timeline-editing-shared";
import { sceneFitRect } from "../looks/fit";
import { clampMaskKeyframeValues, parseMask } from "../looks/masks";
import { channelValueAt, removeKeyframe, serializeKeyframes, setKeyframe, type KeyframePoints } from "../motion/keyframes";
import { clipMediaStart, clipSpeedProfile, isIdentitySpeed, sceneSpeedProfile, sourceSpan, sourceTimeAt, type SpeedProfile } from "../motion/speed";
import { itemMotion, motionAt } from "../motion/transform";
import { stickerBox } from "../stickers/catalog";
import { getSceneDuration, getSceneStart, parseSceneCardConfig } from "../timeline/scene-timing";
import type { TrackRegion, TrackSample } from "./tracker";

export type Plan<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Plan<T> => ({ ok: true, value });
const fail = <T>(error: string): Plan<T> => ({ ok: false, error });

export interface TrackingState {
    clips: TimelineClip[];
    scenes: SceneData[];
    tracks: TimelineTrack[];
    /** The project's aspect ratio ("16:9"); default 16:9. */
    aspectRatio?: string | null;
}

/** The tracked item: a video clip or a main-track scene. */
export interface TrackingOwner {
    clipId?: string;
    sceneId?: string;
}

export interface TrackedItem {
    owner: { clipId: string } | { sceneId: string };
    clip?: TimelineClip;
    scene?: SceneData;
    /** Timeline seconds. */
    start: number;
    duration: number;
    mediaUrl: string;
}

/** Analysis rate: short spans at 30 fps, longer ones at 15 fps, never more than MAX_TRACKING_FRAMES frames. */
export const TRACKING_FPS = 15;
export const SHORT_TRACKING_FPS = 30;
export const SHORT_TRACKING_SPAN = 5;
export const MAX_TRACKING_FRAMES = 1800;
export const MAX_TRACKING_SAMPLES = 10_000;
/** Decimation tolerance in each channel's units (position fractions; scene offsets in percent use ×100). */
export const TRACKING_KEYFRAME_TOLERANCE = 0.0015;
/** Most keyframes one channel may hold (motion-commands MAX_KEYFRAMES_PER_CHANNEL). */
const MAX_KEYFRAMES = 200;
/** A follower whose box leaves less free space than this (frame fraction) cannot move along that axis. */
const MIN_ROOM = 0.02;

const isImageUrl = (url: string | null | undefined) => /\.(png|jpe?g|webp|gif|svg|avif)(\?|#|$)/i.test(url ?? "");

function itemLocked(tracks: TimelineTrack[], item: { clip?: TimelineClip; scene?: SceneData }): boolean {
    if (item.clip?.locked) return true;
    const type = item.scene ? "video" : item.clip?.trackType;
    const index = item.scene ? item.scene.trackIndex || 1 : item.clip?.trackIndex;
    return tracks.some((track) => track.type === type && track.index === index && (track.locked || track.visible === false));
}

/** The scene's own video: a generated video or a source clip's footage (shot-sequenced scenes have none). */
function sceneVideo(scene: SceneData): string | null {
    return scene.videoUrl || (scene.cardType === "source_clip" ? scene.sourceVideoUrl ?? null : null);
}

/** The project aspect ratio as width / height (16:9 when missing or malformed). */
export function frameAspect(aspectRatio: string | null | undefined): number {
    const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(aspectRatio ?? "");
    const value = match ? Number(match[1]) / Number(match[2]) : 16 / 9;
    return Number.isFinite(value) && value > 0 ? value : 16 / 9;
}

export function resolveTrackedItem(state: TrackingState, owner: TrackingOwner): Plan<TrackedItem> {
    if (owner.sceneId) {
        const index = state.scenes.findIndex((s) => s.id === owner.sceneId);
        if (index < 0) return fail("no matching scene");
        const scene = state.scenes[index];
        const mediaUrl = sceneVideo(scene);
        if (!mediaUrl || isImageUrl(mediaUrl)) return fail("the scene has no single video to track");
        return ok({ owner: { sceneId: scene.id }, scene, start: getSceneStart(scene, state.scenes, index), duration: getSceneDuration(scene), mediaUrl });
    }
    if (!owner.clipId) return fail("tracking needs a clipId or a sceneId");
    const clip = state.clips.find((c) => c.id === owner.clipId);
    if (!clip) return fail("no matching clips");
    if (clip.id.startsWith("temp-")) return fail("clip is still being created");
    if (clip.trackType !== "video" || clip.mediaType === "image" || !clip.mediaUrl || isImageUrl(clip.mediaUrl)) return fail("only video clips and main-track scenes can be tracked");
    if (clip.freezeFrame) return fail("a frozen clip does not move");
    return ok({ owner: { clipId: clip.id }, clip, start: clip.startTime, duration: Math.max(0, clip.endTime - clip.startTime), mediaUrl: clip.mediaUrl });
}

function sceneTrimStart(scene: SceneData): number {
    const config = parseSceneCardConfig(scene);
    const value = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** S(t) as the preview plays it (speed-sync.ts mediaTimeAt without the trim). */
function consumed(profile: SpeedProfile, local: number, duration: number): number {
    const t = Math.max(0, local);
    if (isIdentitySpeed(profile)) return t;
    if (!profile.curve || !(duration > 0)) return profile.speed * t;
    return sourceTimeAt(profile, t, duration);
}

/**
 * Media seconds shown at item-local `local`: scenes start at their trim, clips at their trimStart (motion/speed.ts
 * clipMediaStart, as the preview and both exports play them); speed curves through the exact time map; reverse
 * plays the consumed span backwards from its end.
 */
export function trackedMediaTime(item: TrackedItem, local: number): number {
    if (item.scene) return sceneTrimStart(item.scene) + consumed(sceneSpeedProfile(item.scene), local, item.duration);
    const clip = item.clip!;
    const profile = clipSpeedProfile(clip);
    const base = clipMediaStart(clip);
    const s = consumed(profile, local, item.duration);
    if (!clip.reversePlayback) return base + s;
    const span = isIdentitySpeed(profile) ? item.duration : sourceSpan(profile, item.duration);
    return base + Math.max(0, span - s);
}

export interface TrackingFrame {
    /** Item-local seconds. */
    time: number;
    /** Media seconds to decode. */
    media: number;
}

export interface TrackingRunRequest {
    region: TrackRegion;
    /** Item-local seconds of the frame the region was drawn on. */
    time: number;
    /** Item-local span to track (default: the whole item). */
    range?: { start: number; end: number };
    fps?: number;
}

export interface TrackingJobPlan {
    frames: TrackingFrame[];
    /** Index of the frame the region was drawn on (tracking runs forward and backward from it). */
    startIndex: number;
    fps: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function validRegion(region: TrackRegion | undefined): boolean {
    if (!region || typeof region !== "object") return false;
    const { x, y, width, height } = region;
    return [x, y, width, height].every((v) => typeof v === "number" && Number.isFinite(v))
        && width > 0 && height > 0 && x >= 0 && y >= 0 && x + width <= 1 + 1e-6 && y + height <= 1 + 1e-6;
}

/** The analysis frames of a `tracking.run`: every 1/fps seconds outwards from the drawn frame, inside the span. */
export function planTrackingFrames(item: TrackedItem, request: TrackingRunRequest): Plan<TrackingJobPlan> {
    if (!validRegion(request.region)) return fail("the region must be x, y, width, height fractions inside the frame");
    const D = item.duration;
    if (!(D > 0)) return fail("the item has no length");
    const start = Math.min(D, Math.max(0, request.range?.start ?? 0));
    const end = Math.min(D, Math.max(start, request.range?.end ?? D));
    if (request.range && !(end - start > 0)) return fail("the tracking range must have a positive length inside the item");
    if (!Number.isFinite(request.time) || request.time < start - 0.001 || request.time > end + 0.001) return fail("the region's time must be inside the tracked range");
    const time = Math.min(end, Math.max(start, request.time));
    let fps = request.fps !== undefined && Number.isFinite(request.fps) && request.fps > 0 ? Math.min(60, request.fps) : end - start <= SHORT_TRACKING_SPAN ? SHORT_TRACKING_FPS : TRACKING_FPS;
    if ((end - start) * fps + 1 > MAX_TRACKING_FRAMES) fps = (MAX_TRACKING_FRAMES - 1) / (end - start);
    const step = 1 / fps;
    // The last decodable frame sits just before the item's end.
    const last = Math.min(end, Math.max(start, D - 0.001));
    const before: number[] = [];
    for (let k = 1; time - k * step >= start - 1e-9; k += 1) before.push(time - k * step);
    const after: number[] = [];
    for (let k = 1; time + k * step <= last + 1e-9; k += 1) after.push(time + k * step);
    // The span's first and last instants too, so the track covers the whole range.
    if ((before.length > 0 ? before[before.length - 1] : time) - start > 0.001) before.push(start);
    if (last - (after.length > 0 ? after[after.length - 1] : time) > 0.001) after.push(last);
    const times = [...before.reverse(), Math.min(time, last), ...after].map(round3);
    const frames = times.filter((t, i) => i === 0 || t > times[i - 1]).map((t) => ({ time: t, media: Math.round(trackedMediaTime(item, t) * 1e6) / 1e6 }));
    const startIndex = frames.findIndex((f) => f.time === round3(Math.min(time, last)));
    return ok({ frames, startIndex: Math.max(0, startIndex), fps });
}

// ── source → frame ──────────────────────────────────────

export interface SourceSize {
    width: number;
    height: number;
}

const num = (value: unknown, fallback: number) => {
    const x = Number(value);
    return value === null || value === undefined || value === "" || !Number.isFinite(x) ? fallback : x;
};

/** The tracked point (source fractions) in frame fractions at item-local `local`. */
export function sourceToFrame(item: TrackedItem, local: number, point: { x: number; y: number }, source: SourceSize | null | undefined, aspect: number): { x: number; y: number } {
    // Work in frame-height units: the frame is aspect × 1.
    if (item.clip) {
        const clip = item.clip;
        const refW = aspect > 1 ? 1920 : 1080;
        const refH = refW / aspect;
        const src = source && source.width > 0 && source.height > 0 ? source : { width: refW, height: refH };
        const m = motionAt(itemMotion({ kind: "clip", clip }), local);
        const anchorW = (src.width / refW) * m.scale;
        const anchorH = (src.height / refH) * m.scale;
        const cx = (m.posX * Math.max(0, 1 - anchorW) + anchorW / 2 + m.dx) * aspect;
        const cy = m.posY * Math.max(0, 1 - anchorH) + anchorH / 2 + m.dy;
        const w = anchorW * Math.abs(m.scaleX) * aspect;
        const h = anchorH;
        const sx = clip.horizontalFlip ? 1 - point.x : point.x;
        const sy = clip.verticalFlip ? 1 - point.y : point.y;
        return rotateInto(cx, cy, (sx - 0.5) * w, (sy - 0.5) * h, m.rotation, aspect);
    }
    const scene = item.scene!;
    const m = motionAt(itemMotion({ kind: "scene", scene, duration: item.duration }), local);
    const src = source && source.width > 0 && source.height > 0 ? source : { width: aspect, height: 1 };
    const rect = sceneFitRect(scene.fitMode, src, { width: aspect, height: 1 }, m.scale, m.posX, m.posY);
    const cx = rect.x + rect.width / 2 + m.dx * aspect;
    const cy = rect.y + rect.height / 2 + m.dy;
    return rotateInto(cx, cy, (point.x - 0.5) * rect.width * Math.abs(m.scaleX), (point.y - 0.5) * rect.height, m.rotation, aspect);
}

function rotateInto(cx: number, cy: number, ux: number, uy: number, degrees: number, aspect: number): { x: number; y: number } {
    const r = (degrees * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return { x: (cx + ux * cos - uy * sin) / aspect, y: cy + ux * sin + uy * cos };
}

// ── tracking.apply ──────────────────────────────────────

/** A follower: a clip (text, sticker, graphics, upper-track video), a main-track scene, or the tracked item's mask. */
export interface TrackingFollower {
    clipId?: string;
    sceneId?: string;
    /** The tracked item's own mask (mask_x / mask_y keyframes). */
    mask?: boolean;
    /** A clip's box at scale 1 in frame fractions (the host's layout); improves the position mapping. */
    anchor?: SourceSize;
}

export interface TrackingApplyRequest {
    /** Item-local times of the tracked item; x/y in source fractions (tracker output). */
    samples: readonly TrackSample[];
    /** The tracked video's pixel size (the tracker's report); places the tracked item on the frame. */
    source?: SourceSize | null;
    followers: readonly TrackingFollower[];
}

export type TrackingSkipReason =
    | "not-found" | "pending" | "locked" | "tracked-item" | "no-position" | "not-visual" | "no-overlap" | "no-room" | "no-mask" | "duplicate";

export interface TrackingApplied {
    clipId?: string;
    sceneId?: string;
    mask?: true;
    /** Keyframes written per channel. */
    keyframes: number;
    /** Positions mapped without a known box size (text the host did not lay out): small boxes are exact, large ones move a little less than the point. */
    approximate?: true;
}

export interface TrackingSkipped {
    clipId?: string;
    sceneId?: string;
    mask?: true;
    reason: TrackingSkipReason;
}

export interface TrackingReport {
    applied: TrackingApplied[];
    skipped: TrackingSkipped[];
}

export interface TrackingApplyPlan {
    clipUpdates: TimelineClipUpdate[];
    scenePatches: Array<{ sceneId: string; patch: Partial<SceneData> }>;
    report: TrackingReport;
}

interface Dense {
    /** Follower-local seconds. */
    t: number;
    a: number;
    b: number;
}

/** Ramer-Douglas-Peucker on a two-channel time series: indices kept so linear interpolation stays within `tolerance`. */
export function decimateTrack(points: readonly Dense[], tolerance: number): Dense[] {
    if (points.length <= 2) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [i0, i1] = stack.pop()!;
        const p0 = points[i0];
        const p1 = points[i1];
        let worst = -1;
        let at = -1;
        for (let i = i0 + 1; i < i1; i += 1) {
            const u = (points[i].t - p0.t) / (p1.t - p0.t || 1);
            const error = Math.max(Math.abs(points[i].a - (p0.a + (p1.a - p0.a) * u)), Math.abs(points[i].b - (p0.b + (p1.b - p0.b) * u)));
            if (error > worst) {
                worst = error;
                at = i;
            }
        }
        if (at >= 0 && worst > tolerance) {
            keep[at] = 1;
            stack.push([i0, at], [at, i1]);
        }
    }
    return points.filter((_, i) => keep[i] === 1);
}

/** Linear interpolation of a sorted series at `t` (held outside). */
function interpolate<T extends { t: number }>(series: readonly T[], t: number, value: (p: T) => number): number {
    if (t <= series[0].t) return value(series[0]);
    const last = series[series.length - 1];
    if (t >= last.t) return value(last);
    let lo = 0;
    let hi = series.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (series[mid].t <= t) lo = mid;
        else hi = mid;
    }
    const a = series[lo];
    const b = series[hi];
    const u = (t - a.t) / (b.t - a.t || 1);
    return value(a) + (value(b) - value(a)) * u;
}

/** The tracked path sampled at follower timeline span [from, to]: every sample inside plus both ends. */
function spanTimes(timeline: readonly number[], from: number, to: number): number[] {
    const inside = timeline.filter((t) => t > from + 1e-6 && t < to - 1e-6);
    return [from, ...inside, ...(to > from + 1e-6 ? [to] : [])];
}

/**
 * Writes `dense` (follower-local times) into `points` as linear keyframes of channels [ca, cb] (null: not written):
 * those channels are cleared inside the span first; the tolerance grows until every channel fits the keyframe cap.
 */
function writeChannels(points: KeyframePoints, dense: readonly Dense[], ca: string | null, cb: string | null, tolerance: number, clamp?: (values: Record<string, number>) => Record<string, number>): { points: TimelineKeyframePoint[]; count: number } {
    const channels = [ca, cb].filter((c): c is string => c !== null);
    const from = dense[0].t - 0.0005;
    const to = dense[dense.length - 1].t + 0.0005;
    let cleared = points.slice() as TimelineKeyframePoint[];
    for (const time of [...new Set(points.filter((p) => p.time >= from && p.time <= to).map((p) => p.time))]) cleared = removeKeyframe(cleared, time, channels);
    const outside = Math.max(0, ...channels.map((c) => cleared.filter((p) => typeof p[c] === "number").length));
    let tol = tolerance;
    let kept = decimateTrack(dense, tol);
    while (kept.length + outside > MAX_KEYFRAMES && kept.length > 2) {
        tol *= 1.5;
        kept = decimateTrack(dense, tol);
    }
    let next = cleared;
    for (const point of kept) {
        const values: Record<string, number> = {};
        // Stored values keep three decimals (parseTimelineKeyframes rounds them on read).
        if (ca) values[ca] = round3(point.a);
        if (cb) values[cb] = round3(point.b);
        next = setKeyframe(next, roundTimelineTime(point.t), clamp ? clamp(values) : values);
    }
    return { points: next, count: kept.length };
}

function followerKey(f: TrackingFollower): string {
    return f.mask ? "mask" : f.sceneId ? `s:${f.sceneId}` : `c:${f.clipId ?? ""}`;
}

/** A bundled sticker's box at scale 1 in frame fractions (catalog sizes), else null (unknown to the core). */
function knownAnchor(clip: TimelineClip, aspect: number): SourceSize | null {
    if (clip.trackType === "sticker" && clip.stickerId) {
        const box = stickerBox(clip.stickerId, 1);
        if (box) return { width: box.width / aspect, height: box.height };
    }
    return null;
}

/**
 * The keyframes `tracking.apply` writes. `anchors` supplies clip boxes the host laid out (frame fractions at
 * scale 1) for followers without one in the request.
 */
export function planTrackingApply(
    state: TrackingState, owner: TrackingOwner, request: TrackingApplyRequest, anchors?: (clipIds: string[]) => Record<string, SourceSize | undefined>,
): Plan<TrackingApplyPlan> {
    const resolved = resolveTrackedItem({ ...state }, owner);
    if (!resolved.ok) return resolved;
    const item = resolved.value;
    if (!Array.isArray(request.samples) || request.samples.length === 0) return fail("tracking.apply needs tracked samples");
    if (request.samples.length > MAX_TRACKING_SAMPLES) return fail(`at most ${MAX_TRACKING_SAMPLES} samples`);
    if (request.samples.some((s) => !s || ![s.time, s.x, s.y].every((v) => typeof v === "number" && Number.isFinite(v)))) return fail("every sample needs numeric time, x, and y");
    if (!Array.isArray(request.followers) || request.followers.length === 0) return fail("tracking.apply needs at least one follower");
    const aspect = frameAspect(state.aspectRatio);
    const sorted = [...request.samples]
        .filter((s) => s.time >= -0.001 && s.time <= item.duration + 0.001)
        .sort((a, b) => a.time - b.time)
        .filter((s, i, list) => i === 0 || s.time - list[i - 1].time > 1e-6);
    if (sorted.length === 0) return fail("no sample lies inside the tracked item");
    // The path in timeline seconds, in source and frame fractions.
    const path = sorted.map((s) => {
        const local = Math.min(item.duration, Math.max(0, s.time));
        const frame = sourceToFrame(item, local, s, request.source, aspect);
        return { t: item.start + local, local, sx: s.x, sy: s.y, fx: frame.x, fy: frame.y };
    });
    const timeline = path.map((p) => p.t);
    const first = path[0].t;
    const last = path[path.length - 1].t;
    const fxAt = (t: number) => interpolate(path, t, (p) => p.fx);
    const fyAt = (t: number) => interpolate(path, t, (p) => p.fy);

    const report: TrackingReport = { applied: [], skipped: [] };
    const clipUpdates: TimelineClipUpdate[] = [];
    const scenePatches: Array<{ sceneId: string; patch: Partial<SceneData> }> = [];
    const seen = new Set<string>();
    const wantAnchors = request.followers.filter((f) => f.clipId && !f.anchor).map((f) => f.clipId!);
    const hostAnchors = anchors && wantAnchors.length > 0 ? anchors(wantAnchors) : {};
    const ownerId = "clipId" in item.owner ? item.owner.clipId : item.owner.sceneId;

    for (const follower of request.followers) {
        const key = followerKey(follower);
        const label: Pick<TrackingSkipped, "clipId" | "sceneId" | "mask"> = follower.mask ? { mask: true } : follower.sceneId ? { sceneId: follower.sceneId } : { clipId: follower.clipId };
        const skip = (reason: TrackingSkipReason) => report.skipped.push({ ...label, reason });
        if (seen.has(key)) {
            skip("duplicate");
            continue;
        }
        seen.add(key);

        if (follower.mask) {
            const target = item.clip ?? item.scene!;
            const mask = parseMask(target.maskJson);
            if (!mask) {
                skip("no-mask");
                continue;
            }
            if (itemLocked(state.tracks, { clip: item.clip, scene: item.scene })) {
                skip("locked");
                continue;
            }
            const points = parseTimelineKeyframes(target.keyframesJson);
            const ref = path[0];
            const x0 = channelValueAt(points, "mask_x", ref.local, mask.x);
            const y0 = channelValueAt(points, "mask_y", ref.local, mask.y);
            const dense = path.map((p) => ({ t: p.local, a: x0 + (p.sx - ref.sx), b: y0 + (p.sy - ref.sy) }));
            const written = writeChannels(points, dense, "mask_x", "mask_y", TRACKING_KEYFRAME_TOLERANCE, clampMaskKeyframeValues);
            const keyframesJson = serializeKeyframes(written.points);
            if (item.clip) clipUpdates.push({ clipId: item.clip.id, keyframesJson });
            else scenePatches.push({ sceneId: item.scene!.id, patch: { keyframesJson } });
            report.applied.push({ mask: true, keyframes: written.count });
            continue;
        }

        if (follower.sceneId) {
            const index = state.scenes.findIndex((s) => s.id === follower.sceneId);
            const scene = index >= 0 ? state.scenes[index] : undefined;
            if (!scene) {
                skip("not-found");
                continue;
            }
            if (scene.id === ownerId) {
                skip("tracked-item");
                continue;
            }
            if (itemLocked(state.tracks, { scene })) {
                skip("locked");
                continue;
            }
            const start = getSceneStart(scene, state.scenes, index);
            const end = start + getSceneDuration(scene);
            const from = Math.max(first, start);
            const to = Math.min(last, end);
            if (!(to >= from)) {
                skip("no-overlap");
                continue;
            }
            const points = parseTimelineKeyframes(scene.keyframesJson);
            const x0 = channelValueAt(points, "position_x", from - start, num(scene.transformOffsetX, 0));
            const y0 = channelValueAt(points, "position_y", from - start, num(scene.transformOffsetY, 0));
            const fx0 = fxAt(from);
            const fy0 = fyAt(from);
            const dense = spanTimes(timeline, from, to).map((t) => ({ t: t - start, a: x0 + (fxAt(t) - fx0) * 100, b: y0 + (fyAt(t) - fy0) * 100 }));
            const written = writeChannels(points, dense, "position_x", "position_y", TRACKING_KEYFRAME_TOLERANCE * 100);
            scenePatches.push({ sceneId: scene.id, patch: { keyframesJson: serializeKeyframes(written.points) } });
            report.applied.push({ sceneId: scene.id, keyframes: written.count });
            continue;
        }

        const clip = state.clips.find((c) => c.id === follower.clipId);
        if (!clip) {
            skip("not-found");
            continue;
        }
        if (clip.id.startsWith("temp-")) {
            skip("pending");
            continue;
        }
        if (clip.id === ownerId) {
            skip("tracked-item");
            continue;
        }
        if (clip.trackType === "audio") {
            skip("not-visual");
            continue;
        }
        // No built-in effect has a position or centre parameter: effect layers cannot follow (a recorded gap).
        if (clip.trackType === "effect") {
            skip("no-position");
            continue;
        }
        if (itemLocked(state.tracks, { clip })) {
            skip("locked");
            continue;
        }
        const from = Math.max(first, clip.startTime);
        const to = Math.min(last, clip.endTime);
        if (!(to >= from)) {
            skip("no-overlap");
            continue;
        }
        const points = parseTimelineKeyframes(clip.keyframesJson);
        const localOf = (t: number) => Math.min(clip.endTime - clip.startTime, Math.max(0, t - clip.startTime));
        const ref = localOf(from);
        const x0 = channelValueAt(points, "position_x", ref, num(clip.positionX, 0.5));
        const y0 = channelValueAt(points, "position_y", ref, num(clip.positionY, 0.5));
        const fx0 = fxAt(from);
        const fy0 = fyAt(from);
        const times = spanTimes(timeline, from, to);
        let dense: Dense[];
        let ca: string | null = "position_x";
        let cb: string | null = "position_y";
        let approximate = false;
        if (clip.trackType === "remotion") {
            // Graphics layers translate by posX − 0.5 frame fractions (graphics/layer.ts): linear in the displacement.
            dense = times.map((t) => ({ t: localOf(t), a: x0 + (fxAt(t) - fx0), b: y0 + (fyAt(t) - fy0) }));
        } else {
            const anchor = follower.anchor ?? hostAnchors[clip.id] ?? knownAnchor(clip, aspect);
            approximate = !anchor;
            const box = anchor && anchor.width >= 0 && anchor.height >= 0 ? anchor : { width: 0, height: 0 };
            const baseScale = num(clip.scale, 1) > 0 ? num(clip.scale, 1) : 1;
            const scaleAt = (u: number) => Math.max(0, channelValueAt(points, "scale", u, baseScale));
            const roomX = (u: number) => 1 - box.width * scaleAt(u);
            const roomY = (u: number) => 1 - box.height * scaleAt(u);
            const movableX = times.every((t) => roomX(localOf(t)) >= MIN_ROOM);
            const movableY = times.every((t) => roomY(localOf(t)) >= MIN_ROOM);
            if (!movableX && !movableY) {
                skip("no-room");
                continue;
            }
            if (!movableX) ca = null;
            if (!movableY) cb = null;
            // Centre = pos · room + box/2 (clip-motion placedBox): keep the reference centre plus the displacement.
            const centreX0 = x0 * roomX(ref) + (box.width * scaleAt(ref)) / 2;
            const centreY0 = y0 * roomY(ref) + (box.height * scaleAt(ref)) / 2;
            dense = times.map((t) => {
                const u = localOf(t);
                return {
                    t: u,
                    a: movableX ? (centreX0 + (fxAt(t) - fx0) - (box.width * scaleAt(u)) / 2) / roomX(u) : x0,
                    b: movableY ? (centreY0 + (fyAt(t) - fy0) - (box.height * scaleAt(u)) / 2) / roomY(u) : y0,
                };
            });
        }
        const written = writeChannels(points, dense, ca, cb, TRACKING_KEYFRAME_TOLERANCE);
        clipUpdates.push({ clipId: clip.id, keyframesJson: serializeKeyframes(written.points) });
        report.applied.push({ clipId: clip.id, keyframes: written.count, ...(approximate ? { approximate: true as const } : {}) });
    }
    if (report.applied.length === 0) {
        const reasons = report.skipped.map((s) => `${s.mask ? "mask" : s.clipId ?? s.sceneId}: ${s.reason}`).join(", ");
        return fail(`no follower can follow the track (${reasons})`);
    }
    return ok({ clipUpdates, scenePatches, report });
}
