// Copy and paste attributes (phase 10c, CapCut "Copy attributes / Paste attributes"). A snapshot holds the
// attribute values of one clip or scene as plain JSON (so the clipboard outlives its source); planAttributePaste
// turns a snapshot, the chosen kinds, and the targets into the writes of one `attributes.paste` command.
//
// Kinds are a registry (ATTRIBUTE_KIND_DEFS): which items take a kind, which keyframe channels it owns, how
// its values are read from an item and written to another. Field kinds (mask, filter) copy item fields by
// name; Adjust maps the clip's legacy brightness/contrast/saturation fields; effects and speed are planned
// with their own rules (fresh effect rows, speed.set lengths and ripple).
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { SceneMove, TimelineClipUpdate } from "../backend/types";
import { parseTimelineKeyframes, type TimelineKeyframePoint } from "../lib/timeline-editing-properties";
import { ADJUSTMENT_KEYS, LEGACY_CLIP_ADJUSTMENTS, isNeutral, itemAdjustments, legacyClipFields, serializeAdjustments, type Adjustments } from "../looks/adjust";
import { normalizeFilterId } from "../looks/filters";
import { clipTakesMask } from "../looks/masks";
import { parseAnimationSpec, serializeAnimationSpec } from "../motion/animation-spec";
import { KEYFRAME_META_KEYS, channelValueAt, pointEasing, serializeKeyframes, setKeyframe, type KeyframeEasingOptions } from "../motion/keyframes";
import { animationById, type AnimationTarget } from "../motion/registry";
import { clipSpeedProfile, isIdentitySpeed, sceneSpeedProfile } from "../motion/speed";
import { motionTarget } from "../motion/transform";
import type { AnimationSlot, AnimationSpec } from "../motion/types";
import { getSceneDuration } from "../timeline/scene-timing";
import { planClipSpeed, type SpeedRequest } from "../controller/speed-plan";
import { planSceneSpeed } from "../controller/motion-commands";

export const ATTRIBUTE_KINDS = ["filter", "adjust", "effects", "animation", "speed", "mask", "transform"] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];

export type AttributeItem = { kind: "clip"; clip: TimelineClip } | { kind: "scene"; scene: SceneData };

/** A paste target or a live source: a clip or a scene. */
export interface AttributeTarget {
    clipId?: string;
    sceneId?: string;
}

export interface AttributeEffectRow {
    effectId: string;
    paramsJson: string | null;
    enabled: boolean;
}

/** The copied attributes of one item, plain JSON. */
export interface AttributeSnapshot {
    version: 1;
    /** `label`: the clip's label or text, or the scene's caption, for the paste picker. */
    source: { itemType: "clip" | "scene"; id: string; trackType?: string; mediaType?: string; label?: string };
    /** The source's length in seconds when copied (keyframe times are item-local). */
    duration: number;
    /** The kinds the source has (configured values or keyframes), in ATTRIBUTE_KINDS order. */
    kinds: AttributeKind[];
    /**
     * Per kind: filter `{ visualFilter, filterIntensity }`, adjust `{ adjustments }` (the 13 controls),
     * effects `{ rows }`, animation `{ animationJson }`, speed `{ speed, curve, preservePitch }`, mask and
     * transform the source's own fields.
     */
    values: Partial<Record<AttributeKind, Record<string, unknown>>>;
    /** The source's keyframe points, restricted to the channels of `kinds`. */
    keyframes: TimelineKeyframePoint[];
}

export type AttributeSkipReason = "missing" | "locked" | "pending" | "source" | "not-supported" | "not-in-clipboard" | "invalid";

export interface AttributePasteReport {
    /** Targets that took at least one kind. */
    applied: Array<AttributeTarget & { kinds: AttributeKind[] }>;
    /** A whole target (no kind) or one kind of a target; kinds the clipboard lacks are listed once without a target. */
    skipped: Array<AttributeTarget & { kind?: AttributeKind; reason: AttributeSkipReason }>;
}

export interface AttributePastePlan extends AttributePasteReport {
    /** Every clip written: targets (with their place) and clips a speed change pushes or ripples. */
    clipUpdates: TimelineClipUpdate[];
    scenePatches: Array<{ sceneId: string; patch: Partial<SceneData> }>;
    sceneMoves: SceneMove[];
    /** Effect stacks to replace (targets whose stack already equals the copy are left out). */
    effectStacks: Array<{ clipId?: string; sceneId?: string; rows: AttributeEffectRow[] }>;
}

export interface AttributePasteState {
    clips: TimelineClip[];
    /** Live scenes (with optimistic overrides). */
    scenes: SceneData[];
    tracks: TimelineTrack[];
}

// ── item helpers ─────────────────────────────────────────

type Fields = Record<string, unknown>;

const fieldsOf = (item: AttributeItem): Fields => (item.kind === "clip" ? item.clip : item.scene) as unknown as Fields;
const idOf = (item: AttributeItem) => (item.kind === "clip" ? item.clip.id : item.scene.id);
const refOf = (item: AttributeItem): AttributeTarget => (item.kind === "clip" ? { clipId: item.clip.id } : { sceneId: item.scene.id });
const lengthOf = (item: AttributeItem) => (item.kind === "clip" ? Math.max(0, item.clip.endTime - item.clip.startTime) : getSceneDuration(item.scene));
const isChannelKey = (key: string) => !KEYFRAME_META_KEYS.includes(key);

const isVideoClip = (item: AttributeItem) => item.kind === "clip" && item.clip.trackType === "video";
/** Scenes, video/image clips, and stickers take looks (inspector Adjust / Filter / Effects tabs). */
const takesLook = (item: AttributeItem) => item.kind === "scene" || isVideoClip(item) || (item.kind === "clip" && item.clip.trackType === "sticker");
// Graphics clips animate, rotate, and take keyframes like other visual clips (phase 10c).
const takesMotion = (item: AttributeItem) => takesLook(item) || (item.kind === "clip" && (item.clip.trackType === "text" || item.clip.trackType === "remotion"));
/** Speed: scenes, video clips (not stills), audio clips. */
const takesSpeed = (item: AttributeItem) => item.kind === "scene"
    || (isVideoClip(item) && (item as { clip: TimelineClip }).clip.mediaType !== "image")
    || (item.kind === "clip" && item.clip.trackType === "audio");
/** Masks: scenes and video, image, text, and sticker clips (looks/masks.ts clipTakesMask). */
const takesMask = (item: AttributeItem) => item.kind === "scene" || clipTakesMask(item.clip);

const empty = (value: unknown) => value === null || value === undefined || value === "";

// ── kind registry ────────────────────────────────────────

interface AttributeKindDef {
    kind: AttributeKind;
    accepts(item: AttributeItem): boolean;
    /** Keyframe channels the kind owns: pasting it replaces these channels on the target. */
    ownsChannel(channel: string): boolean;
    /** The kind's values on an item, or null when it has nothing to copy (keyframes aside). */
    read(item: AttributeItem): Fields | null;
    /** The target's field patch, or null when the values cannot map onto it. Effects and speed have their own plans. */
    write?(values: Fields, target: AttributeItem, source: AttributeSnapshot["source"]): Fields | null;
}

/**
 * A kind that copies item fields as they are. Clip and scene field lists pair up by position; with
 * `sameItemType` the kind only pastes between items of the same type (units differ).
 */
function fieldKind(
    kind: AttributeKind,
    fields: { clip: readonly string[]; scene: readonly string[] },
    ownsChannel: (channel: string) => boolean,
    accepts: (item: AttributeItem) => boolean,
    options: { sameItemType?: boolean; isDefault?(values: Fields, item: AttributeItem): boolean } = {},
): AttributeKindDef {
    return {
        kind, accepts, ownsChannel,
        read: (item) => {
            const source = fieldsOf(item);
            const values: Fields = {};
            for (const field of fields[item.kind]) if (field in source && source[field] !== undefined) values[field] = source[field];
            if (Object.values(values).every(empty)) return null;
            return options.isDefault?.(values, item) ? null : values;
        },
        write: (values, target, source) => {
            if (options.sameItemType && source.itemType !== target.kind) return null;
            const from = fields[source.itemType];
            const patch: Fields = {};
            fields[target.kind].forEach((field, i) => {
                patch[field] = values[from[i]] ?? null;
            });
            return patch;
        },
    };
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const TRANSFORM_CHANNELS = new Set(["position_x", "position_y", "scale", "rotation_degrees", "opacity"]);

/** Which animation family an item uses, and whether a slot is allowed there (planAnimation's rules). */
function animationFamily(item: AttributeItem): AnimationTarget {
    return item.kind === "scene" ? "clip" : motionTarget({ kind: "clip", clip: item.clip });
}

function slotAllowed(family: AnimationTarget, slot: AnimationSlot, id: string): boolean {
    if (slot === "loop" && family === "clip") return false;
    if (slot === "combo" && family === "text") return false;
    return Boolean(animationById(family, slot, id));
}

export const ATTRIBUTE_KIND_DEFS: readonly AttributeKindDef[] = [
    {
        kind: "filter",
        accepts: takesLook,
        ownsChannel: (channel) => channel === "filter_intensity",
        read: (item) => {
            const fields = fieldsOf(item);
            const visualFilter = normalizeFilterId(fields.visualFilter as string | null | undefined);
            if (visualFilter === "none") return null;
            const intensity = fields.filterIntensity;
            return { visualFilter, filterIntensity: typeof intensity === "number" && Number.isFinite(intensity) ? intensity : null };
        },
        write: (values) => ({ visualFilter: values.visualFilter ?? "none", filterIntensity: values.filterIntensity ?? null }),
    },
    {
        kind: "adjust",
        accepts: takesLook,
        ownsChannel: (channel) => channel.startsWith("adj_"),
        read: (item) => {
            const adjustments = itemAdjustments(fieldsOf(item), item.kind);
            if (isNeutral(adjustments)) return null;
            // Stored precision (serializeAdjustments): 0.30000000000000004 → 0.3.
            for (const key of ADJUSTMENT_KEYS) adjustments[key] = Math.round(adjustments[key] * 10000) / 10000;
            return { adjustments };
        },
        // Same mapping as look.set: clips keep brightness/contrast/saturation in their legacy fields.
        write: (values, target) => {
            const next = { ...itemAdjustments({}, "scene"), ...(values.adjustments as Partial<Adjustments> | undefined) } as Adjustments;
            if (target.kind === "scene") return { adjustmentsJson: serializeAdjustments(next) };
            return {
                ...legacyClipFields(next),
                adjustmentsJson: serializeAdjustments(next, ADJUSTMENT_KEYS.filter((key) => !(LEGACY_CLIP_ADJUSTMENTS as readonly string[]).includes(key))),
            };
        },
    },
    {
        kind: "effects",
        accepts: takesLook,
        ownsChannel: () => false,
        read: (item) => {
            const rows = effectRowsOf(item);
            return rows.length > 0 ? { rows } : null;
        },
    },
    {
        kind: "animation",
        accepts: takesMotion,
        ownsChannel: () => false,
        read: (item) => {
            const json = serializeAnimationSpec(parseAnimationSpec(fieldsOf(item).animationJson as string | null | undefined));
            return json ? { animationJson: json } : null;
        },
        // Only the slots the target's family has (clip / sticker / text animations); durations keep the parse rules.
        write: (values, target) => {
            const spec = parseAnimationSpec(values.animationJson as string | null | undefined);
            const family = animationFamily(target);
            const kept: AnimationSpec = {};
            for (const slot of ["in", "out", "combo", "loop"] as const) {
                const entry = spec[slot];
                if (entry && slotAllowed(family, slot, entry.id)) (kept as Record<string, unknown>)[slot] = entry;
            }
            const json = serializeAnimationSpec(kept);
            return json ? { animationJson: json } : null;
        },
    },
    {
        kind: "speed",
        accepts: takesSpeed,
        ownsChannel: () => false,
        read: (item) => {
            const profile = item.kind === "clip" ? clipSpeedProfile(item.clip) : sceneSpeedProfile(item.scene);
            if (isIdentitySpeed(profile)) return null;
            const curve = profile.curve ? { id: profile.curve.id, points: profile.curve.points.map(([x, y]) => [x, y] as [number, number]) } : null;
            return { speed: profile.speed, curve, preservePitch: profile.preservePitch };
        },
    },
    // Masks (10c-3, text and stickers 10d): `maskJson` on scenes and visual clips, keyframed through `mask_*` channels. Items
    // without the field have nothing to copy, so this kind is inert until masks exist.
    fieldKind("mask", { clip: ["maskJson"], scene: ["maskJson"] }, (channel) => channel.startsWith("mask_"), takesMask),
    // Static placement; positions use different units on clips and scenes, so only same-type pastes.
    fieldKind(
        "transform",
        { clip: ["positionX", "positionY", "scale", "rotationDegrees", "opacity"], scene: ["transformOffsetX", "transformOffsetY", "transformScale", "rotationDegrees", "opacity"] },
        (channel) => TRANSFORM_CHANNELS.has(channel),
        takesMotion,
        {
            sameItemType: true,
            isDefault: (values, item) => item.kind === "clip"
                ? num(values.positionX, 0.5) === 0.5 && num(values.positionY, 0.5) === 0.5 && num(values.scale, 1) === 1 && num(values.rotationDegrees, 0) === 0 && num(values.opacity, 1) === 1
                : num(values.transformOffsetX, 0) === 0 && num(values.transformOffsetY, 0) === 0 && num(values.transformScale, 1) === 1 && num(values.rotationDegrees, 0) === 0 && num(values.opacity, 1) === 1,
        },
    ),
];

const DEFS = new Map(ATTRIBUTE_KIND_DEFS.map((def) => [def.kind, def]));

function effectRowsOf(item: AttributeItem): AttributeEffectRow[] {
    const rows = item.kind === "clip" ? item.clip.effects : item.scene.effects;
    return [...(rows ?? [])].sort((a, b) => a.order - b.order).map((row) => ({ effectId: row.effectId, paramsJson: row.paramsJson ?? null, enabled: row.enabled !== false }));
}

/** The kinds an item can take, in ATTRIBUTE_KINDS order. */
export function acceptedAttributeKinds(item: AttributeItem): AttributeKind[] {
    return ATTRIBUTE_KIND_DEFS.filter((def) => def.accepts(item)).map((def) => def.kind);
}

/** Copies an item's attributes: every kind it takes that has values or keyframes. */
export function snapshotAttributes(item: AttributeItem): AttributeSnapshot {
    const points = parseTimelineKeyframes(fieldsOf(item).keyframesJson);
    const hasChannels = (def: AttributeKindDef) => points.some((point) => Object.keys(point).some((key) => isChannelKey(key) && def.ownsChannel(key)));
    const kinds: AttributeKind[] = [];
    const values: AttributeSnapshot["values"] = {};
    for (const def of ATTRIBUTE_KIND_DEFS) {
        if (!def.accepts(item)) continue;
        const read = def.read(item);
        if (!read && !hasChannels(def)) continue;
        kinds.push(def.kind);
        values[def.kind] = read ?? {};
    }
    const owns = (key: string) => kinds.some((kind) => DEFS.get(kind)!.ownsChannel(key));
    const keyframes = points.flatMap((point) => {
        const kept = pickChannels(point, owns);
        return kept ? [kept] : [];
    });
    const source: AttributeSnapshot["source"] = item.kind === "clip"
        ? { itemType: "clip", id: item.clip.id, trackType: item.clip.trackType, mediaType: item.clip.mediaType }
        : { itemType: "scene", id: item.scene.id };
    const label = (item.kind === "clip" ? item.clip.label || item.clip.textContent : item.scene.caption)?.trim();
    if (label) source.label = label.slice(0, 80);
    return { version: 1, source, duration: Math.round(lengthOf(item) * 1e6) / 1e6, kinds, values, keyframes };
}

/** A point with only the owned channels (and its easing), or null when none is left. */
function pickChannels(point: TimelineKeyframePoint, owns: (channel: string) => boolean): TimelineKeyframePoint | null {
    const out: Record<string, number> = { time: point.time };
    let any = false;
    for (const [key, value] of Object.entries(point)) {
        if (key === "time") continue;
        if (isChannelKey(key)) {
            if (!owns(key)) continue;
            any = true;
        }
        out[key] = value;
    }
    return any ? (out as TimelineKeyframePoint) : null;
}

export function isAttributeSnapshot(value: unknown): value is AttributeSnapshot {
    const v = value as Partial<AttributeSnapshot> | null;
    return Boolean(v && typeof v === "object" && v.version === 1 && v.source && Array.isArray(v.kinds) && v.values && typeof v.values === "object");
}

// ── keyframe channels ────────────────────────────────────

/**
 * The target's keyframes with the owned channels replaced by the source's (item-local times). Points past the
 * target's end are dropped and the channel gets a point at the end with the value its curve has there.
 * undefined when nothing changes.
 */
export function replaceKeyframeChannels(
    targetJson: string | null | undefined, sourcePoints: readonly TimelineKeyframePoint[], owns: (channel: string) => boolean, duration: number,
): string | null | undefined {
    const target = parseTimelineKeyframes(targetJson);
    const ownedKeys = (point: TimelineKeyframePoint) => Object.keys(point).filter((key) => isChannelKey(key) && owns(key));
    const source = sourcePoints.filter((point) => ownedKeys(point).length > 0);
    if (source.length === 0 && !target.some((point) => ownedKeys(point).length > 0)) return undefined;
    let points: TimelineKeyframePoint[] = target.flatMap((point) => {
        const owned = ownedKeys(point);
        if (owned.length === 0) return [point];
        const rest = { ...point };
        for (const key of owned) delete rest[key];
        return Object.keys(rest).some(isChannelKey) ? [rest] : [];
    });
    const end = Math.max(0, duration);
    const cut = new Set<string>();
    for (const point of source) {
        const values: Record<string, number> = {};
        for (const key of ownedKeys(point)) {
            if (point.time > end + 0.001) cut.add(key);
            else values[key] = point[key];
        }
        if (Object.keys(values).length === 0) continue;
        const options: KeyframeEasingOptions = {};
        if (typeof point.easing === "number") {
            const easing = pointEasing(point);
            options.easing = easing.id;
            if (easing.bezier) options.bezier = easing.bezier;
        }
        points = setKeyframe(points, Math.min(end, point.time), values, options);
    }
    for (const channel of cut) {
        const hasEnd = source.some((point) => typeof point[channel] === "number" && Math.abs(Math.min(end, point.time) - end) <= 0.001 && point.time <= end + 0.001);
        if (!hasEnd) points = setKeyframe(points, end, { [channel]: Math.round(channelValueAt(source, channel, end, 0) * 1000) / 1000 });
    }
    return serializeKeyframes(points);
}

// ── planning ─────────────────────────────────────────────

const targetKey = (target: AttributeTarget) => (target.sceneId ? `s:${target.sceneId}` : `c:${target.clipId ?? ""}`);

function isLocked(item: AttributeItem, tracks: TimelineTrack[]): boolean {
    if (item.kind === "scene") {
        const index = Number(item.scene.trackIndex ?? 1);
        const track = tracks.find((t) => t.type === "video" && t.index === index);
        return Boolean(track?.locked);
    }
    if (item.clip.locked) return true;
    return Boolean(tracks.find((t) => t.type === item.clip.trackType && t.index === item.clip.trackIndex)?.locked);
}

const sameRows = (a: AttributeEffectRow[], b: AttributeEffectRow[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The writes that paste `kinds` of `snapshot` onto `targets` (one `attributes.paste`). Speed runs first, with
 * speed.set's rules (the item keeps its source span, so its length follows; its keyframes rescale; later scenes
 * ripple; overlapped clips are pushed), then the other kinds against the new length.
 */
export function planAttributePaste(state: AttributePasteState, snapshot: AttributeSnapshot, targets: readonly AttributeTarget[], kinds: readonly AttributeKind[]): AttributePastePlan {
    const wanted = ATTRIBUTE_KINDS.filter((kind) => kinds.includes(kind));
    // Kinds keep the order asked for in the report.
    const ordered = [...new Set(kinds)].filter((kind): kind is AttributeKind => wanted.includes(kind));
    const skipped: AttributePastePlan["skipped"] = [];
    for (const kind of ordered) if (!snapshot.kinds.includes(kind)) skipped.push({ kind, reason: "not-in-clipboard" });
    const available = ordered.filter((kind) => snapshot.kinds.includes(kind));

    let clips = state.clips.slice();
    let scenes = state.scenes.slice();
    const clipTouched = new Map<string, Set<string>>();
    const sceneTouched = new Map<string, Set<string>>();
    const touch = (map: Map<string, Set<string>>, id: string, keys: Iterable<string>) => {
        const set = map.get(id) ?? new Set<string>();
        for (const key of keys) set.add(key);
        map.set(id, set);
    };
    const patchClip = (id: string, patch: Fields) => {
        clips = clips.map((c) => (c.id === id ? { ...c, ...patch } as TimelineClip : c));
        touch(clipTouched, id, Object.keys(patch));
    };
    const patchScene = (id: string, patch: Fields) => {
        scenes = scenes.map((s) => (s.id === id ? { ...s, ...patch } as SceneData : s));
        touch(sceneTouched, id, Object.keys(patch));
    };
    const itemFor = (target: AttributeTarget): AttributeItem | null => {
        if (target.sceneId) {
            const scene = scenes.find((s) => s.id === target.sceneId);
            return scene ? { kind: "scene", scene } : null;
        }
        const clip = target.clipId ? clips.find((c) => c.id === target.clipId) : undefined;
        return clip ? { kind: "clip", clip } : null;
    };

    // Resolve targets and which kinds each takes.
    const plans: Array<{ ref: AttributeTarget; kinds: AttributeKind[] }> = [];
    const seen = new Set<string>();
    for (const raw of targets) {
        const ref: AttributeTarget = raw.sceneId ? { sceneId: raw.sceneId } : { clipId: raw.clipId };
        const key = targetKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        const item = itemFor(ref);
        if (!item) {
            skipped.push({ ...ref, reason: "missing" });
            continue;
        }
        if (item.kind === "clip" && item.clip.id.startsWith("temp-")) {
            skipped.push({ ...ref, reason: "pending" });
            continue;
        }
        if (snapshot.source.itemType === item.kind && snapshot.source.id === idOf(item)) {
            skipped.push({ ...ref, reason: "source" });
            continue;
        }
        if (isLocked(item, state.tracks)) {
            skipped.push({ ...ref, reason: "locked" });
            continue;
        }
        const taken: AttributeKind[] = [];
        for (const kind of available) {
            const def = DEFS.get(kind)!;
            const values = snapshot.values[kind] ?? {};
            const fits = def.accepts(item) && (!def.write || Object.keys(values).length === 0 || def.write(values, item, snapshot.source) !== null);
            if (fits) taken.push(kind);
            else skipped.push({ ...ref, kind, reason: "not-supported" });
        }
        if (taken.length > 0) plans.push({ ref, kinds: taken });
    }

    // Speed first: lengths, rescaled keyframes, ripple, and pushes.
    const speedValues = snapshot.values.speed;
    if (speedValues) {
        const request: SpeedRequest = {
            speed: speedValues.speed as number,
            curve: (speedValues.curve as SpeedRequest["curve"]) ?? null,
            preservePitch: speedValues.preservePitch as boolean,
        };
        for (const plan of plans) {
            if (!plan.ref.sceneId || !plan.kinds.includes("speed")) continue;
            const scene = scenes.find((s) => s.id === plan.ref.sceneId)!;
            const step = planSceneSpeed(scenes, clips, scene, request);
            if (!step.ok) {
                plan.kinds = plan.kinds.filter((kind) => kind !== "speed");
                skipped.push({ ...plan.ref, kind: "speed", reason: "invalid" });
                continue;
            }
            patchScene(scene.id, step.value.patch as Fields);
            const moves = new Map(step.value.moves.map((move) => [move.sceneId, move.timelinePositionSeconds]));
            scenes = scenes.map((s) => (moves.has(s.id) ? { ...s, timelinePositionSeconds: moves.get(s.id) } : s));
            const places = new Map(step.value.clipUpdates.map((update) => [update.clipId, update]));
            clips = clips.map((c) => (places.has(c.id) ? { ...c, startTime: places.get(c.id)!.startTime!, endTime: places.get(c.id)!.endTime! } : c));
        }
        const clipIds = plans.filter((plan) => plan.ref.clipId && plan.kinds.includes("speed")).map((plan) => plan.ref.clipId!);
        if (clipIds.length > 0) {
            const step = planClipSpeed(clips, clipIds, request);
            if (step.ok) {
                for (const update of step.value) {
                    const { clipId, startTime, endTime, ...fields } = update;
                    clips = clips.map((c) => (c.id === clipId ? { ...c, startTime: startTime!, endTime: endTime! } : c));
                    if (clipIds.includes(clipId)) patchClip(clipId, fields);
                }
            } else {
                for (const plan of plans) {
                    if (!plan.ref.clipId || !clipIds.includes(plan.ref.clipId)) continue;
                    plan.kinds = plan.kinds.filter((kind) => kind !== "speed");
                    skipped.push({ ...plan.ref, kind: "speed", reason: "invalid" });
                }
            }
        }
    }

    // Field kinds and keyframe channels, against each target's length after speed.
    const effectStacks: AttributePastePlan["effectStacks"] = [];
    for (const plan of plans) {
        const item = itemFor(plan.ref)!;
        const patch: Fields = {};
        for (const kind of plan.kinds) {
            const def = DEFS.get(kind)!;
            const values = snapshot.values[kind] ?? {};
            if (def.write && Object.keys(values).length > 0) Object.assign(patch, def.write(values, item, snapshot.source));
        }
        const owned = plan.kinds.map((kind) => DEFS.get(kind)!).filter((def) => def.kind !== "transform" || snapshot.source.itemType === item.kind);
        const keyframesJson = replaceKeyframeChannels(fieldsOf(item).keyframesJson as string | null | undefined, snapshot.keyframes, (channel) => owned.some((def) => def.ownsChannel(channel)), lengthOf(item));
        if (keyframesJson !== undefined) patch.keyframesJson = keyframesJson;
        if (Object.keys(patch).length > 0) (item.kind === "clip" ? patchClip : patchScene)(idOf(item), patch);
        if (plan.kinds.includes("effects")) {
            const rows = (snapshot.values.effects?.rows as AttributeEffectRow[] | undefined) ?? [];
            if (!sameRows(effectRowsOf(item), rows)) effectStacks.push({ ...refOf(item), rows: rows.map((row) => ({ ...row })) });
        }
    }

    // Writes: every touched field of a target, every place that moved.
    const clipUpdates: TimelineClipUpdate[] = [];
    const originalClips = new Map(state.clips.map((c) => [c.id, c]));
    for (const clip of clips) {
        const was = originalClips.get(clip.id)!;
        const keys = clipTouched.get(clip.id);
        const moved = Math.abs(was.startTime - clip.startTime) > 1e-9 || Math.abs(was.endTime - clip.endTime) > 1e-9;
        if (!keys && !moved) continue;
        const update: TimelineClipUpdate = { clipId: clip.id, startTime: clip.startTime, endTime: clip.endTime };
        for (const key of keys ?? []) (update as Fields)[key] = (clip as unknown as Fields)[key] ?? null;
        clipUpdates.push(update);
    }
    const scenePatches: AttributePastePlan["scenePatches"] = [];
    for (const [sceneId, keys] of sceneTouched) {
        const scene = scenes.find((s) => s.id === sceneId)!;
        const patch: Fields = {};
        for (const key of keys) patch[key] = (scene as unknown as Fields)[key] ?? null;
        scenePatches.push({ sceneId, patch: patch as Partial<SceneData> });
    }
    const originalScenes = new Map(state.scenes.map((s) => [s.id, s]));
    const sceneMoves: SceneMove[] = scenes
        .filter((s) => (Number(s.timelinePositionSeconds) || 0) !== (Number(originalScenes.get(s.id)?.timelinePositionSeconds) || 0))
        .map((s) => ({ sceneId: s.id, timelinePositionSeconds: Number(s.timelinePositionSeconds) || 0 }));

    return {
        applied: plans.filter((plan) => plan.kinds.length > 0).map((plan) => ({ ...plan.ref, kinds: plan.kinds })),
        skipped, clipUpdates, scenePatches, sceneMoves, effectStacks,
    };
}
