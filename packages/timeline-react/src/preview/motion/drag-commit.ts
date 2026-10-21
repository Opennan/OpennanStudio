// Committing a preview transform gesture (phase 10b): a move, a corner scale (scale plus the position
// that keeps the opposite corner in place), a rotation, or a keyboard nudge, on a clip or a scene.
//
// A channel that has keyframes is written as a keyframe at the playhead (item-local time), so the item
// stays where it was dropped instead of snapping back to its curve; a static channel is written to the
// item's fields. Every gesture is ONE command, so it is one undo step:
//   - only keyed channels   → `keyframe.set` (clipId or sceneId, item units);
//   - only static channels  → `clip.update` / `scene.update` with the fields;
//   - both (a corner drag on an item with scale keyed and position static) → one update carrying the
//     static fields and the new `keyframesJson` (planKeyframes, exactly what `keyframe.set` writes).
// Position is one property (CapCut): when either axis is keyframed, a move keys both.
//
// Units: clips position_x/y 0..1 (fractions of the free space), scale, rotation_degrees; scenes
// position_x/y = transformOffsetX/Y in percent of the frame, scale = transformScale, rotation_degrees.
import { useCallback } from "react";
import type { EditorCommand, ExecuteOptions } from "@opennan/timeline-core/controller/commands";
import { planKeyframes } from "@opennan/timeline-core/controller/motion-commands";
import { channelValueAt, hasChannel } from "@opennan/timeline-core/motion/keyframes";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { selectLiveScenes } from "@opennan/timeline-core";
import { getSceneDuration, getSceneStart } from "@opennan/timeline-core/timeline/scene-timing";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { SceneData } from "@opennan/timeline-core/timeline/canvas/types";
import { useEditorStoreApi } from "../../hooks/use-editor-store";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { clipBaseAt, type DragOverride } from "./clip-motion";

/** Keyframes are set to 1 ms (the controller merges points within 1 ms). */
const roundMs = (seconds: number) => Math.round(seconds * 1000) / 1000;

export type TransformChannel = "position_x" | "position_y" | "scale" | "rotation_degrees";

const CLIP_FIELDS: Record<TransformChannel, keyof TimelineClip> = {
    position_x: "positionX", position_y: "positionY", scale: "scale", rotation_degrees: "rotationDegrees",
};
const SCENE_FIELDS: Record<TransformChannel, keyof SceneData> = {
    position_x: "transformOffsetX", position_y: "transformOffsetY", scale: "transformScale", rotation_degrees: "rotationDegrees",
};
const CHANNEL_ORDER: TransformChannel[] = ["position_x", "position_y", "scale", "rotation_degrees"];

export interface TransformTarget {
    kind: "clip" | "scene";
    id: string;
    keyframesJson: string | null | undefined;
    /** Item length in seconds (the keyframe time is clamped to it). */
    duration: number;
    /** Keyframed (or static) channel values at time t (fills the other position axis). */
    baseAt(t: number): Record<TransformChannel, number>;
}

/**
 * How `values` land on the target with the playhead at item-local `localTime`: keyed channels as keyframe values at
 * `time`, static channels as item fields (`patch`). Null when there is nothing to write.
 */
export function splitTransformValues(target: TransformTarget, values: Partial<Record<TransformChannel, number>>, localTime: number): { time: number; keyValues: Record<string, number>; patch: Record<string, number> } | null {
    const touched = CHANNEL_ORDER.filter((channel) => values[channel] !== undefined);
    if (touched.length === 0) return null;
    const points = parseTimelineKeyframes(target.keyframesJson);
    const duration = Math.max(0, target.duration);
    const time = roundMs(Math.min(duration, Math.max(0, Number.isFinite(localTime) ? localTime : 0)));
    const positionKeyed = hasChannel(points, "position_x") || hasChannel(points, "position_y");
    const keyed: Record<string, number> = {};
    const statics: Partial<Record<TransformChannel, number>> = {};
    let base: Record<TransformChannel, number> | null = null;
    for (const channel of touched) {
        const isPosition = channel === "position_x" || channel === "position_y";
        if (isPosition ? positionKeyed : hasChannel(points, channel)) keyed[channel] = values[channel]!;
        else statics[channel] = values[channel]!;
    }
    if (positionKeyed && (keyed.position_x !== undefined || keyed.position_y !== undefined)) {
        base ??= target.baseAt(time);
        keyed.position_x ??= base.position_x;
        keyed.position_y ??= base.position_y;
    }
    // Stable channel order in the values object.
    const keyValues: Record<string, number> = {};
    for (const channel of CHANNEL_ORDER) if (keyed[channel] !== undefined) keyValues[channel] = keyed[channel];
    const fields = target.kind === "clip" ? CLIP_FIELDS : SCENE_FIELDS;
    const patch: Record<string, number> = {};
    for (const channel of CHANNEL_ORDER) if (statics[channel] !== undefined) patch[fields[channel] as string] = statics[channel]!;
    return { time, keyValues, patch };
}

/** The ONE command that writes `values` on the target with the playhead at item-local `localTime` (null: nothing to write). */
export function transformCommitCommand(target: TransformTarget, values: Partial<Record<TransformChannel, number>>, localTime: number): EditorCommand | null {
    const split = splitTransformValues(target, values, localTime);
    if (!split) return null;
    const { time, keyValues } = split;
    const patch: Record<string, unknown> = { ...split.patch };
    const duration = Math.max(0, target.duration);
    const hasKeys = Object.keys(keyValues).length > 0;
    const hasFields = Object.keys(patch).length > 0;
    const owner = target.kind === "clip" ? { clipId: target.id } : { sceneId: target.id };
    if (hasKeys && !hasFields) return { type: "keyframe.set", ...owner, time, values: keyValues };
    if (hasKeys) {
        const plan = planKeyframes(target.keyframesJson, duration, { type: "keyframe.set", time, values: keyValues });
        if (plan.ok) patch.keyframesJson = plan.value;
    }
    return target.kind === "clip"
        ? { type: "clip.update", clipIds: [target.id], patch: patch as Partial<TimelineClip> }
        : { type: "scene.update", sceneId: target.id, patch: patch as Partial<SceneData> };
}

/**
 * The ONE `items.transform` that writes a group gesture's values (phase 10c): per item, keyed channels become a keyframe
 * at the playhead and static ones fields, exactly as a single-item drag decides. Null when nothing changes.
 */
export function groupTransformCommand(entries: ReadonlyArray<{ target: TransformTarget; values: Partial<Record<TransformChannel, number>>; localTime: number }>): EditorCommand | null {
    const clips: Array<{ id: string; patch?: Record<string, number>; keyframe?: { time: number; values: Record<string, number> } }> = [];
    const scenes: typeof clips = [];
    for (const { target, values, localTime } of entries) {
        const split = splitTransformValues(target, values, localTime);
        if (!split) continue;
        const entry: (typeof clips)[number] = { id: target.id };
        if (Object.keys(split.patch).length > 0) entry.patch = split.patch;
        if (Object.keys(split.keyValues).length > 0) entry.keyframe = { time: split.time, values: split.keyValues };
        (target.kind === "clip" ? clips : scenes).push(entry);
    }
    if (clips.length === 0 && scenes.length === 0) return null;
    return { type: "items.transform", clips, scenes };
}

export function clipTransformTarget(clip: TimelineClip): TransformTarget {
    return clipTarget(clip);
}

/** A scene as a transform target (scene units: offsets in percent, transformScale, degrees). */
export function sceneTransformTarget(scene: SceneTransformSource, duration: number): TransformTarget {
    return {
        kind: "scene",
        id: scene.id,
        keyframesJson: scene.keyframesJson,
        duration,
        baseAt: (t) => {
            const base = sceneBaseAt(scene, t);
            return { position_x: base.offsetX, position_y: base.offsetY, scale: base.scale, rotation_degrees: base.rotation };
        },
    };
}

function clipTarget(clip: TimelineClip): TransformTarget {
    return {
        kind: "clip",
        id: clip.id,
        keyframesJson: clip.keyframesJson,
        duration: Math.max(0, clip.endTime - clip.startTime),
        baseAt: (t) => {
            const base = clipBaseAt(clip, t);
            return { position_x: base.posX, position_y: base.posY, scale: base.scale, rotation_degrees: base.rotation };
        },
    };
}

/** The commands that commit `override` on `clip` with the playhead at item-local `localTime` (zero or one). */
export function dragCommitCommands(clip: TimelineClip, override: DragOverride | null, localTime: number): EditorCommand[] {
    if (!override) return [];
    const command = transformCommitCommand(clipTarget(clip), {
        position_x: override.posX, position_y: override.posY, scale: override.scale, rotation_degrees: override.rotation,
    }, localTime);
    return command ? [command] : [];
}

/** Scene transform values a gesture writes (offsets in percent of the frame, transformScale, degrees). */
export interface SceneOverride {
    offsetX?: number;
    offsetY?: number;
    scale?: number;
    rotation?: number;
}

type SceneTransformSource = Pick<SceneData, "id"> & Partial<Pick<SceneData, "transformScale" | "transformOffsetX" | "transformOffsetY" | "rotationDegrees" | "keyframesJson">>;

function num(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === "") return fallback;
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}

/** Keyframed (or static) scene transform at scene-local `t` (transform.ts baseFields for scenes). */
export function sceneBaseAt(scene: SceneTransformSource, t: number): { offsetX: number; offsetY: number; scale: number; rotation: number } {
    const scale = num(scene.transformScale, 1);
    const fields = { offsetX: num(scene.transformOffsetX, 0), offsetY: num(scene.transformOffsetY, 0), scale: scale > 0 ? scale : 1, rotation: num(scene.rotationDegrees, 0) };
    const points = parseTimelineKeyframes(scene.keyframesJson);
    if (points.length === 0) return fields;
    return {
        offsetX: channelValueAt(points, "position_x", t, fields.offsetX),
        offsetY: channelValueAt(points, "position_y", t, fields.offsetY),
        scale: channelValueAt(points, "scale", t, fields.scale),
        rotation: channelValueAt(points, "rotation_degrees", t, fields.rotation),
    };
}

/** The commands that commit a scene gesture (zero or one): `scene.update`, or `keyframe.set` with sceneId when keyed. */
export function sceneDragCommands(scene: SceneTransformSource, duration: number, override: SceneOverride | null, localTime: number): EditorCommand[] {
    if (!override) return [];
    const target: TransformTarget = {
        kind: "scene",
        id: scene.id,
        keyframesJson: scene.keyframesJson,
        duration,
        baseAt: (t) => {
            const base = sceneBaseAt(scene, t);
            return { position_x: base.offsetX, position_y: base.offsetY, scale: base.scale, rotation_degrees: base.rotation };
        },
    };
    const command = transformCommitCommand(target, {
        position_x: override.offsetX, position_y: override.offsetY, scale: override.scale, rotation_degrees: override.rotation,
    }, localTime);
    return command ? [command] : [];
}

type CommitOptions = Pick<ExecuteOptions, "coalesceKey" | "debounceMs">;

/** Commits a finished preview drag through the controller (with history: undoable). */
export function useDragCommit(): (clipId: string, override: DragOverride | null, options?: CommitOptions) => Promise<boolean> {
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    return useCallback(async (clipId: string, override: DragOverride | null, options?: CommitOptions) => {
        const state = storeApi.getState();
        const clip = state.timelineData?.clips.find((c) => c.id === clipId);
        if (!clip) return false;
        let ok = true;
        for (const command of dragCommitCommands(clip, override, state.currentTime - clip.startTime)) {
            const result = await controller.execute(command, options);
            ok = ok && (result.ok || Boolean(result.superseded));
        }
        return ok;
    }, [controller, storeApi]);
}

/**
 * Commits a scene gesture at the playhead. Scene media is drawn by ScenePreview from the store, so a
 * live drag writes through here on every move with one `coalesceKey` (optimistic store update, one backend
 * write and one undo entry when the gesture ends with a short `debounceMs`).
 */
export function useSceneTransformCommit(): (sceneId: string, override: SceneOverride | null, options?: CommitOptions) => Promise<boolean> {
    const controller = useTimelineController();
    const storeApi = useEditorStoreApi();
    return useCallback(async (sceneId: string, override: SceneOverride | null, options?: CommitOptions) => {
        const state = storeApi.getState();
        const scenes = selectLiveScenes(state);
        const index = scenes.findIndex((s) => s.id === sceneId);
        if (index < 0) return false;
        const scene = scenes[index];
        const start = getSceneStart(scene, scenes, index);
        let ok = true;
        for (const command of sceneDragCommands(scene, getSceneDuration(scene), override, state.currentTime - start)) {
            const result = await controller.execute(command, options);
            ok = ok && (result.ok || Boolean(result.superseded));
        }
        return ok;
    }, [controller, storeApi]);
}
