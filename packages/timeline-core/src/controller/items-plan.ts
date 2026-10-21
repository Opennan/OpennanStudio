// Planning for the multi-item commands (phase 10c): items.delete, items.duplicate, items.transform, and the
// group-apply forms of look.set / animation.set / clip.effect.add (`targets`). Pure: the controller persists
// the plans (one undo entry per command).
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { TimelineClipUpdate, CreateClipInput } from "../backend/types";
import { ADJUSTMENT_KEYS, DEFAULT_ADJUSTMENTS, LEGACY_CLIP_ADJUSTMENTS, applyAdjustmentPatch, itemAdjustments, legacyClipFields, serializeAdjustments, type AdjustmentPatch } from "../looks/adjust";
import { normalizeFilterId } from "../looks/filters";
import { createClipInput, parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { channelValueAt, serializeKeyframes } from "../motion/keyframes";
import type { TimelineClipboard, TimelineDuplicateClip } from "../lib/timeline-editing-shared";
import { getSceneDuration, getSceneStart } from "../timeline/scene-timing";
import { planKeyframes, type Plan } from "./motion-commands";

/** A clip or a scene named by a group command. */
export interface ItemTarget {
    clipId?: string;
    sceneId?: string;
}

/** One item of `items.transform`: static fields and/or a keyframe written at item-local `time`. */
export interface ItemTransform<P> {
    id: string;
    patch?: P;
    keyframe?: { time: number; values: Record<string, number> };
    /**
     * The item's whole keyframes, replacing them (phase 10d: a group gesture on an item off the playhead moves every
     * keyframe, transformDeltaPatch). Not with `keyframe`. Absolute values keep a coalesced live gesture exact.
     */
    keyframesJson?: string | null;
}

/**
 * A group gesture applied to an item that is not visible at the playhead (phase 10d, transformDeltaPatch): the
 * similarity the visible items get, on the item's own base values AND on every keyframe of the channels it touches (the
 * item has no playhead time to key at, so its whole motion follows). Positions are frame fractions: clips and graphics use their position
 * (0..1; for clips the fraction of the free space, taken as a frame fraction since the box is unknown off screen),
 * scenes 0.5 + offset / 100. With p the item's position and c the group centre, on a frame of aspect W/H:
 *   p' = c + k · R(θ) · (p − c) + (dx, dy)        scale · k        rotation + θ
 * (R turns clockwise in pixels: the aspect keeps a turn round on wide frames).
 */
export interface TransformDelta {
    /** Translation in frame fractions. */
    dx?: number;
    dy?: number;
    /** Scale factor about `center` (> 0). */
    scale?: number;
    /** Degrees clockwise about `center`. */
    rotation?: number;
    /** Group centre in frame fractions (default the frame centre). */
    center?: { x: number; y: number };
    /** Frame width / height (default 16 / 9). */
    aspect?: number;
}

export type ClipTransformPatch = Partial<Pick<TimelineClip, "positionX" | "positionY" | "scale" | "rotationDegrees">>;
export type SceneTransformPatch = Partial<Pick<SceneData, "transformOffsetX" | "transformOffsetY" | "transformScale" | "rotationDegrees">>;

export interface ItemsState {
    clips: TimelineClip[];
    scenes: SceneData[];
    tracks: TimelineTrack[];
}

const ok = <T>(value: T): Plan<T> => ({ ok: true, value });
const fail = <T>(error: string): Plan<T> => ({ ok: false, error });
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The clip is locked, or sits on a locked or hidden track; a scene's video track is locked or hidden. */
export function itemLocked(tracks: TimelineTrack[], item: { clip?: TimelineClip; scene?: SceneData }): boolean {
    if (item.clip?.locked) return true;
    const type = item.scene ? "video" : item.clip?.trackType;
    const index = item.scene ? item.scene.trackIndex || 1 : item.clip?.trackIndex;
    return tracks.some((track) => track.type === type && track.index === index && (track.locked || track.visible === false));
}

/** The clips and scenes the ids name that exist and can be edited (unknown or locked ids are dropped). */
export function editableItems(state: ItemsState, clipIds: readonly string[] = [], sceneIds: readonly string[] = []): { clips: TimelineClip[]; scenes: SceneData[] } {
    const clipSet = new Set(clipIds);
    const sceneSet = new Set(sceneIds);
    return {
        clips: state.clips.filter((clip) => clipSet.has(clip.id) && !itemLocked(state.tracks, { clip })),
        scenes: state.scenes.filter((scene) => sceneSet.has(scene.id) && !itemLocked(state.tracks, { scene })),
    };
}

const sceneStartOf = (scene: SceneData, scenes: SceneData[]) => getSceneStart(scene, scenes, scenes.indexOf(scene));

export interface DuplicatePlan {
    clipInputs: CreateClipInput[];
    /** Where each scene copy goes (timeline start and video track). */
    sceneCopies: Array<{ sceneId: string; startTime: number; trackIndex: number }>;
    /** Seconds every copy sits after its original. */
    offset: number;
}

/**
 * Copies of the items with their relative timing kept: the group's start lands at `at` (default: the end of the
 * group, so the copies follow the selection). Scene copies never overlap another scene on their track: the whole
 * group moves later until none does (clip copies follow the same offset; clips may overlap as on paste).
 */
export function planItemsDuplicate(state: ItemsState, clipIds: readonly string[] = [], sceneIds: readonly string[] = [], at?: number): Plan<DuplicatePlan> {
    const { clips, scenes } = editableItems(state, clipIds, sceneIds);
    if (clips.length === 0 && scenes.length === 0) return fail("no editable items to duplicate");
    const spans = [
        ...clips.map((clip) => ({ start: clip.startTime, end: clip.endTime })),
        ...scenes.map((scene) => {
            const start = sceneStartOf(scene, state.scenes);
            return { start, end: start + getSceneDuration(scene) };
        }),
    ];
    const groupStart = Math.min(...spans.map((s) => s.start));
    const groupEnd = Math.max(...spans.map((s) => s.end));
    let offset = at !== undefined && Number.isFinite(at) ? Math.max(0, at) - groupStart : groupEnd - groupStart;
    const sources = scenes.map((scene) => {
        const start = sceneStartOf(scene, state.scenes);
        return { sceneId: scene.id, track: scene.trackIndex || 1, start, duration: getSceneDuration(scene) };
    });
    offset = pushPastScenes(state, sources, offset, at === undefined ? new Set(scenes.map((s) => s.id)) : new Set());
    const clipInputs = clips
        .slice()
        .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
        .map((clip) => {
            const input = createClipInput(clip as unknown as TimelineDuplicateClip);
            const startTime = round3(clip.startTime + offset);
            return { ...input, locked: false, startTime, endTime: round3(startTime + (clip.endTime - clip.startTime)) } as CreateClipInput;
        });
    const sceneCopies = sources.map((copy) => ({ sceneId: copy.sceneId, startTime: Math.max(0.001, round3(copy.start + offset)), trackIndex: copy.track }));
    return ok({ clipInputs, sceneCopies, offset });
}

/** The smallest offset ≥ `offset` at which no copy overlaps a scene on its track (`ignore`: scenes that do not count). */
function pushPastScenes(state: ItemsState, copies: Array<{ track: number; start: number; duration: number }>, offset: number, ignore: Set<string>): number {
    const others = state.scenes
        .filter((scene) => !ignore.has(scene.id))
        .map((scene) => {
            const start = sceneStartOf(scene, state.scenes);
            return { track: scene.trackIndex || 1, start, end: start + getSceneDuration(scene) };
        });
    // Offsets only grow, so this ends.
    for (let guard = 0; guard < others.length + 1; guard++) {
        let pushTo = offset;
        for (const copy of copies) {
            const s = copy.start + offset;
            const e = s + copy.duration;
            for (const other of others) {
                if (other.track === copy.track && s < other.end - 0.001 && e > other.start + 0.001) pushTo = Math.max(pushTo, other.end - copy.start);
            }
        }
        if (pushTo <= offset + 1e-9) break;
        offset = pushTo;
    }
    return offset;
}

/** The clipboard for a copy of clips and scenes together (offsets from the group's start). */
export function copyItemsToClipboard(state: ItemsState, clipIds: readonly string[] = [], sceneIds: readonly string[] = []): TimelineClipboard | null {
    const { clips, scenes } = editableItems(state, clipIds, sceneIds);
    if (clips.length === 0 && scenes.length === 0) return null;
    const sceneSpans = scenes.map((scene) => ({ scene, start: sceneStartOf(scene, state.scenes), duration: getSceneDuration(scene) }));
    const starts = [...clips.map((c) => c.startTime), ...sceneSpans.map((s) => s.start)];
    const ends = [...clips.map((c) => c.endTime), ...sceneSpans.map((s) => s.start + s.duration)];
    const groupStart = Math.min(...starts);
    const sorted = clips.slice().sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
    return {
        groupDuration: round3(Math.max(...ends) - groupStart),
        clips: sorted.map((clip) => ({
            offsetStart: round3(clip.startTime - groupStart),
            duration: round3(Math.max(0, clip.endTime - clip.startTime)),
            input: { ...createClipInput(clip as unknown as TimelineDuplicateClip), locked: false },
        })),
        scenes: sceneSpans.map((s) => ({ sceneId: s.scene.id, offsetStart: round3(s.start - groupStart), duration: round3(s.duration), trackIndex: s.scene.trackIndex || 1 })),
    };
}

/**
 * A paste of a clipboard (clips and scenes) with the group starting at `at`: clip copies from the stored inputs (on
 * editable tracks), scene copies of the scenes that still exist; the group moves later past overlapping scenes.
 */
export function planItemsPaste(state: ItemsState, clipboard: TimelineClipboard, at: number): Plan<DuplicatePlan> {
    if (!clipboard || !Array.isArray(clipboard.clips)) return fail("nothing to paste");
    const start = Number.isFinite(at) ? Math.max(0, at) : 0;
    const editableTrack = (type: unknown, index: unknown) => !state.tracks.some((t) => t.type === type && t.index === index && (t.locked || t.visible === false));
    // Scene copies land on their video track: none onto a locked (or hidden) one, as for the clips below.
    const sources = (clipboard.scenes ?? [])
        .filter((entry) => state.scenes.some((scene) => scene.id === entry.sceneId) && editableTrack("video", entry.trackIndex || 1))
        .map((entry) => ({ sceneId: entry.sceneId, track: entry.trackIndex || 1, start: start + entry.offsetStart, duration: entry.duration }));
    const offset = pushPastScenes(state, sources, 0, new Set());
    const clipInputs = clipboard.clips
        .filter((entry) => editableTrack(entry.input.trackType, entry.input.trackIndex))
        .map((entry) => {
            const startTime = round3(start + entry.offsetStart + offset);
            return { ...entry.input, startTime, endTime: round3(startTime + entry.duration) } as CreateClipInput;
        });
    const sceneCopies = sources.map((copy) => ({ sceneId: copy.sceneId, startTime: Math.max(0.001, round3(copy.start + offset)), trackIndex: copy.track }));
    if (clipInputs.length === 0 && sceneCopies.length === 0) return fail("nothing to paste");
    return ok({ clipInputs, sceneCopies, offset });
}

export interface ItemPatches {
    clipUpdates: TimelineClipUpdate[];
    scenePatches: Array<{ sceneId: string; patch: Partial<SceneData> }>;
}

const CLIP_TRANSFORM_KEYS = ["positionX", "positionY", "scale", "rotationDegrees"] as const;
const SCENE_TRANSFORM_KEYS = ["transformOffsetX", "transformOffsetY", "transformScale", "rotationDegrees"] as const;

function finitePatch<K extends string>(patch: Partial<Record<K, unknown>> | undefined, keys: readonly K[]): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const key of keys) {
        const value = patch?.[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        out[key] = value;
    }
    return out;
}

const roundTo = (value: number, digits: number) => {
    const f = 10 ** digits;
    return Math.round(value * f) / f || 0;
};

/** The delta's numbers, or null when one is not finite (or the scale is not positive). */
function checkedDelta(delta: TransformDelta): Required<Omit<TransformDelta, "center">> & { center: { x: number; y: number } } | null {
    const out = {
        dx: delta.dx ?? 0, dy: delta.dy ?? 0, scale: delta.scale ?? 1, rotation: delta.rotation ?? 0,
        center: { x: delta.center?.x ?? 0.5, y: delta.center?.y ?? 0.5 }, aspect: delta.aspect ?? 16 / 9,
    };
    const numbers = [out.dx, out.dy, out.scale, out.rotation, out.center.x, out.center.y, out.aspect];
    if (!numbers.every((x) => typeof x === "number" && Number.isFinite(x)) || !(out.scale > 0) || !(out.aspect > 0)) return null;
    return out;
}

/** The fields and keyframes a delta writes on one item (TransformDelta). `fields` maps the channels to the item's fields. */
function deltaPatch(
    item: { keyframesJson?: string | null } & Record<string, unknown>, delta: NonNullable<ReturnType<typeof checkedDelta>>,
    fields: { x: string; y: string; scale: string; rotation: string }, base: { x: number; y: number; scale: number; rotation: number },
    position: { toFrame(v: number): number; fromFrame(v: number): number; digits: number },
): Record<string, unknown> {
    const { dx, dy, scale: k, rotation: theta, center, aspect } = delta;
    const r = (theta * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const moves = dx !== 0 || dy !== 0 || k !== 1 || theta !== 0;
    /** A position (item units) through the similarity. */
    const mapPoint = (x: number, y: number): [number, number] => {
        const u = (position.toFrame(x) - center.x) * aspect;
        const v = position.toFrame(y) - center.y;
        const fx = center.x + (k * (u * cos - v * sin)) / aspect + dx;
        const fy = center.y + k * (u * sin + v * cos) + dy;
        return [roundTo(position.fromFrame(fx), position.digits), roundTo(position.fromFrame(fy), position.digits)];
    };
    const patch: Record<string, unknown> = {};
    if (moves) [patch[fields.x], patch[fields.y]] = mapPoint(base.x, base.y);
    if (k !== 1) patch[fields.scale] = roundTo(base.scale * k, 4);
    if (theta !== 0) patch[fields.rotation] = roundTo(base.rotation + theta, 2);
    const points = parseTimelineKeyframes(item.keyframesJson);
    let keyed = false;
    const next = points.map((point) => {
        const out: Record<string, number> = { ...point };
        const hasX = typeof point.position_x === "number";
        const hasY = typeof point.position_y === "number";
        if (moves && (hasX || hasY)) {
            const [x, y] = mapPoint(hasX ? point.position_x : channelValueAt(points, "position_x", point.time, base.x), hasY ? point.position_y : channelValueAt(points, "position_y", point.time, base.y));
            if (hasX) out.position_x = x;
            if (hasY) out.position_y = y;
            keyed = true;
        }
        if (k !== 1 && typeof point.scale === "number") {
            out.scale = roundTo(point.scale * k, 4);
            keyed = true;
        }
        if (theta !== 0 && typeof point.rotation_degrees === "number") {
            out.rotation_degrees = roundTo(point.rotation_degrees + theta, 2);
            keyed = true;
        }
        return out as typeof point;
    });
    if (keyed) patch.keyframesJson = serializeKeyframes(next);
    return patch;
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const CLIP_POSITION = { toFrame: (v: number) => v, fromFrame: (v: number) => v, digits: 6 };
const SCENE_POSITION = { toFrame: (v: number) => 0.5 + v / 100, fromFrame: (v: number) => Math.min(200, Math.max(-200, (v - 0.5) * 100)), digits: 4 };

/**
 * The items.transform entry of a group gesture on an item off the playhead (TransformDelta): absolute static fields
 * and, when a touched channel is keyed, the whole keyframes with every key moved. Null when the delta changes nothing.
 */
export function transformDeltaPatch(
    item: TimelineClip | SceneData, kind: "clip" | "scene", delta: TransformDelta,
): Plan<{ patch: ClipTransformPatch | SceneTransformPatch; keyframesJson?: string | null } | null> {
    const checked = checkedDelta(delta);
    if (!checked) return fail("transform deltas must be finite numbers (scale above 0)");
    let written: Record<string, unknown>;
    if (kind === "clip") {
        const clip = item as TimelineClip;
        written = deltaPatch(clip as never, checked, { x: "positionX", y: "positionY", scale: "scale", rotation: "rotationDegrees" }, {
            x: num(clip.positionX, 0.5), y: num(clip.positionY, 0.5), scale: num(clip.scale, 1), rotation: num(clip.rotationDegrees, 0),
        }, CLIP_POSITION);
    } else {
        const scene = item as SceneData;
        const scale = num(scene.transformScale, 1);
        written = deltaPatch(scene as never, checked, { x: "transformOffsetX", y: "transformOffsetY", scale: "transformScale", rotation: "rotationDegrees" }, {
            x: num(scene.transformOffsetX, 0), y: num(scene.transformOffsetY, 0), scale: scale > 0 ? scale : 1, rotation: num(scene.rotationDegrees, 0),
        }, SCENE_POSITION);
    }
    const { keyframesJson, ...patch } = written;
    if (Object.keys(patch).length === 0 && keyframesJson === undefined) return ok(null);
    return ok(keyframesJson === undefined ? { patch } : { patch, keyframesJson: keyframesJson as string | null });
}

/** An entry's whole keyframes, normalized (keyframesJson replaces the item's; not with `keyframe`). */
function wholeKeyframes(item: ItemTransform<unknown>): Plan<string | null> {
    if (item.keyframe) return fail("items.transform takes keyframesJson or a keyframe, not both");
    if (item.keyframesJson === null || item.keyframesJson === "") return ok(null);
    if (typeof item.keyframesJson !== "string") return fail("keyframesJson must be a string or null");
    try {
        JSON.parse(item.keyframesJson);
    } catch {
        return fail("keyframesJson is not valid JSON");
    }
    return ok(serializeKeyframes(parseTimelineKeyframes(item.keyframesJson)));
}

/** items.transform as field patches: static fields, and keyframe writes merged into `keyframesJson` (keyframe.set rules). */
export function planItemsTransform(
    state: ItemsState,
    clipItems: ReadonlyArray<ItemTransform<ClipTransformPatch>> = [],
    sceneItems: ReadonlyArray<ItemTransform<SceneTransformPatch>> = [],
): Plan<ItemPatches> {
    if (clipItems.length === 0 && sceneItems.length === 0) return fail("items.transform needs at least one item");
    const clipUpdates: TimelineClipUpdate[] = [];
    const scenePatches: ItemPatches["scenePatches"] = [];
    for (const item of clipItems) {
        const clip = state.clips.find((c) => c.id === item.id);
        if (!clip) return fail("no matching clips");
        if (itemLocked(state.tracks, { clip })) continue;
        const patch = finitePatch(item.patch, CLIP_TRANSFORM_KEYS);
        if (!patch) return fail("transform values must be finite numbers");
        const update: TimelineClipUpdate = { clipId: clip.id, ...patch };
        if (item.keyframesJson !== undefined) {
            const whole = wholeKeyframes(item);
            if (!whole.ok) return fail(whole.error);
            update.keyframesJson = whole.value;
        }
        if (item.keyframe) {
            const plan = planKeyframes(clip.keyframesJson, Math.max(0, clip.endTime - clip.startTime), { type: "keyframe.set", time: item.keyframe.time, values: item.keyframe.values });
            if (!plan.ok) return fail(plan.error);
            update.keyframesJson = plan.value;
        }
        if (Object.keys(update).length > 1) clipUpdates.push(update);
    }
    for (const item of sceneItems) {
        const scene = state.scenes.find((s) => s.id === item.id);
        if (!scene) return fail("no matching scene");
        if (itemLocked(state.tracks, { scene })) continue;
        const patch = finitePatch(item.patch, SCENE_TRANSFORM_KEYS) as Partial<SceneData> | null;
        if (!patch) return fail("transform values must be finite numbers");
        if (item.keyframesJson !== undefined) {
            const whole = wholeKeyframes(item);
            if (!whole.ok) return fail(whole.error);
            patch.keyframesJson = whole.value;
        }
        if (item.keyframe) {
            const plan = planKeyframes(scene.keyframesJson, getSceneDuration(scene), { type: "keyframe.set", time: item.keyframe.time, values: item.keyframe.values });
            if (!plan.ok) return fail(plan.error);
            patch.keyframesJson = plan.value;
        }
        if (Object.keys(patch).length > 0) scenePatches.push({ sceneId: scene.id, patch });
    }
    if (clipUpdates.length === 0 && scenePatches.length === 0) return fail("the items are locked");
    return ok({ clipUpdates, scenePatches });
}

export interface LookRequest {
    filter?: string;
    intensity?: number;
    adjustments?: AdjustmentPatch | null;
}

/** The fields look.set writes on one clip or scene (adjustments from the item's own values). */
export function planLookPatch(item: TimelineClip | SceneData, kind: "clip" | "scene", request: LookRequest): Plan<Record<string, unknown>> {
    const patch: Record<string, unknown> = {};
    if (request.filter !== undefined) patch.visualFilter = normalizeFilterId(request.filter);
    if (request.intensity !== undefined) patch.filterIntensity = Math.round(Math.min(1, Math.max(0, request.intensity)) * 1000) / 1000;
    if (request.adjustments !== undefined) {
        const current = itemAdjustments(item, kind);
        const next = request.adjustments === null ? { ...DEFAULT_ADJUSTMENTS } : applyAdjustmentPatch(current, request.adjustments);
        if (kind === "clip") {
            Object.assign(patch, legacyClipFields(next));
            patch.adjustmentsJson = serializeAdjustments(next, ADJUSTMENT_KEYS.filter((key) => !(LEGACY_CLIP_ADJUSTMENTS as readonly string[]).includes(key)));
        } else {
            patch.adjustmentsJson = serializeAdjustments(next);
        }
    }
    if (Object.keys(patch).length === 0) return fail("look.set needs a filter, an intensity, or adjustments");
    return ok(patch);
}

/**
 * Resolves group targets to items (each once, in order); fails on an unknown or empty target. Locked items (the clip,
 * or the clip's or scene's track; see itemLocked) are skipped, as items.transform does; fails when none is left.
 */
export function resolveTargets(state: ItemsState, targets: readonly ItemTarget[]): Plan<Array<{ clip?: TimelineClip; scene?: SceneData }>> {
    if (!Array.isArray(targets) || targets.length === 0) return fail("needs at least one target");
    const seen = new Set<string>();
    const out: Array<{ clip?: TimelineClip; scene?: SceneData }> = [];
    for (const target of targets) {
        if (target.sceneId) {
            const scene = state.scenes.find((s) => s.id === target.sceneId);
            if (!scene) return fail("no matching scene");
            if (seen.has(`s:${scene.id}`)) continue;
            seen.add(`s:${scene.id}`);
            if (!itemLocked(state.tracks, { scene })) out.push({ scene });
        } else if (target.clipId) {
            const clip = state.clips.find((c) => c.id === target.clipId);
            if (!clip) return fail("no matching clips");
            if (seen.has(`c:${clip.id}`)) continue;
            seen.add(`c:${clip.id}`);
            if (!itemLocked(state.tracks, { clip })) out.push({ clip });
        } else {
            return fail("a target needs a clipId or a sceneId");
        }
    }
    if (out.length === 0) return fail("targets are locked");
    return ok(out);
}
