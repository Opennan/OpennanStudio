// Transitions, filters, adjustments, effect stacks, masks, and paste attributes for agents: the same
// controller commands the editor's libraries and inspector run (transition.set/applyAll, look.set,
// clip.effect.*, mask.set, attributes.paste), so every call is undoable with undo_last_edit and shows in
// the open editor at once.
import type { ControllerSnapshot } from "@opennan/timeline-core";
import { ATTRIBUTE_KINDS, type AttributeKind, type AttributePasteReport, type AttributeTarget } from "@opennan/timeline-core/attributes/attributes";
import { ADJUSTMENT_KEYS, adjustmentRange, type AdjustmentPatch } from "@opennan/timeline-core/looks/adjust";
import { looksCatalog } from "@opennan/timeline-core/looks/catalog";
import { DEFAULT_FILTER_INTENSITY } from "@opennan/timeline-core/looks/filters";
import {
    MASK_KEYFRAME_CHANNELS, MASK_CHANNEL_FIELDS, MASK_POSITION_RANGE, MASK_ROTATION_LIMIT, MASK_SIZE_RANGE, isMaskShape, parseMask, type MaskPatch,
} from "@opennan/timeline-core/looks/masks";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { clipById, sceneByOrder, scenesInOrder, type Args } from "../args";
import { commandFailure, failure, success } from "../outcome";
import { lockReason, sceneLockReason } from "./placement";
import type { ToolHandler } from "./types";

export type Target = { sceneId: string; label: string } | { clipId: string; label: string };

export interface TargetKinds {
    /** Track types whose clips the tool edits. */
    trackTypes: readonly string[];
    /** "looks apply to video and sticker clips": the refusal for other clips (main-track clips are added to it). */
    applies: string;
}

const LOOK_KINDS: TargetKinds = { trackTypes: ["video", "sticker"], applies: "looks apply to video and sticker clips" };
const MASK_KINDS: TargetKinds = { trackTypes: ["video", "text", "sticker"], applies: "masks apply to video, image, text, and sticker clips" };

/**
 * clip_id (a clip of one of `kinds.trackTypes`; video and sticker layer clips for looks) or scene_order (a main-track
 * clip); exactly one. Locked or hidden tracks and locked clips are refused, as in the editor.
 */
export function lookTarget(snap: ControllerSnapshot, args: Args, tool: string, kinds: TargetKinds = LOOK_KINDS): Target | string {
    const hasClip = args.clip_id !== undefined;
    const hasScene = args.scene_order !== undefined;
    if (hasClip === hasScene) return `${tool} needs clip_id or scene_order (one of them).`;
    if (hasScene) {
        const scene = sceneByOrder(snap, args.scene_order);
        const label = `scene ${String(args.scene_order)}`;
        const locked = sceneLockReason(snap, scene, label);
        if (locked) return locked;
        return { sceneId: scene.id, label };
    }
    const clip = clipById(snap, args.clip_id);
    if (!kinds.trackTypes.includes(clip.trackType)) return `Clip ${clip.id} is a ${clip.trackType} clip; ${kinds.applies} and to main-track clips (scene_order).`;
    const locked = lockReason(snap, clip);
    if (locked) return locked;
    return { clipId: clip.id, label: `clip ${clip.id}` };
}

export const commandTarget = (target: Target) => ("sceneId" in target ? { sceneId: target.sceneId } : { clipId: target.clipId });

const listTransitions: ToolHandler = async () => {
    const { transitions } = looksCatalog();
    return success(`${transitions.length} transitions: ${transitions.map((t) => t.id).join(", ")}.`, {
        transitions: transitions.map((t) => ({ id: t.id, name: t.name, category: t.category, default_duration: t.defaultDuration })),
    });
};

const applyTransition: ToolHandler = async (args, { session }) => {
    const transition = String(args.transition_id);
    const duration = typeof args.duration === "number" ? args.duration : undefined;
    if (args.apply_to_all === true) {
        const result = await session.execute({ type: "transition.applyAll", transition, ...(duration !== undefined ? { duration } : {}) });
        return commandFailure("transition.applyAll", result) ?? success(`Set ${transition} on every cut between main-track clips.`, { scenes: result.changed.scenes ?? [] });
    }
    if (args.scene_order === undefined) return failure("apply_transition needs scene_order (the main-track clip before the cut) or apply_to_all: true.");
    const snap = await session.snapshot();
    const scene = sceneByOrder(snap, args.scene_order);
    const result = await session.execute({ type: "transition.set", sceneId: scene.id, transition, ...(duration !== undefined ? { duration } : {}) });
    const failed = commandFailure("transition.set", result);
    if (failed) return failed;
    const after = (await session.snapshot()).scenes.find((s) => s.id === scene.id);
    return success(transition === "none"
        ? `Removed the transition after scene ${String(args.scene_order)}.`
        : `Set ${transition} (${after?.visualTransitionDuration ?? duration ?? 0} s) on the cut after scene ${String(args.scene_order)}.`, {
        sceneId: scene.id, transition: after?.visualTransition ?? transition, duration: after?.visualTransitionDuration ?? null,
    });
};

const listFilters: ToolHandler = async () => {
    const { filters } = looksCatalog();
    return success(`${filters.length} filters: ${filters.map((f) => f.id).join(", ")}.`, {
        filters: filters.map((f) => ({ id: f.id, name: f.name, category: f.category })),
    });
};

const applyFilter: ToolHandler = async (args, { session, tool }) => {
    const target = lookTarget(await session.snapshot(), args, tool.name);
    if (typeof target === "string") return failure(target);
    const intensity = typeof args.intensity === "number" ? Math.min(100, Math.max(0, args.intensity)) / 100 : DEFAULT_FILTER_INTENSITY;
    const filter = String(args.filter_id);
    const result = await session.execute({ type: "look.set", ...commandTarget(target), filter, intensity });
    return commandFailure("look.set", result)
        ?? success(filter === "none" ? `Removed the filter from ${target.label}.` : `Applied ${filter} at ${Math.round(intensity * 100)}% to ${target.label}.`, { ...commandTarget(target), filter, intensity: Math.round(intensity * 100) });
};

const setAdjustments: ToolHandler = async (args, { session, tool }) => {
    const target = lookTarget(await session.snapshot(), args, tool.name);
    if (typeof target === "string") return failure(target);
    const patch: AdjustmentPatch = {};
    for (const key of ADJUSTMENT_KEYS) {
        const value = args[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) return failure(`${key} must be a number.`);
        const [min, max] = adjustmentRange(key);
        patch[key] = Math.min(max * 100, Math.max(min * 100, value)) / 100;
    }
    if (args.reset === true) {
        const reset = await session.execute({ type: "look.set", ...commandTarget(target), adjustments: null });
        const resetFailed = commandFailure("look.set", reset);
        if (resetFailed) return resetFailed;
        if (Object.keys(patch).length === 0) return success(`Reset every adjustment on ${target.label}.`, commandTarget(target));
    }
    if (Object.keys(patch).length === 0) return failure("set_adjustments needs at least one control (brightness, contrast, …) or reset: true.");
    const result = await session.execute({ type: "look.set", ...commandTarget(target), adjustments: patch });
    const values = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, Math.round((value ?? 0) * 100)]));
    return commandFailure("look.set", result) ?? success(`Set ${Object.keys(values).join(", ")} on ${target.label}.`, { ...commandTarget(target), values });
};

const reorderVisualEffects: ToolHandler = async (args, { session, tool }) => {
    const target = lookTarget(await session.snapshot(), args, tool.name);
    if (typeof target === "string") return failure(target);
    const ids = Array.isArray(args.effect_row_ids) ? args.effect_row_ids.map(String) : [];
    const result = await session.execute({ type: "clip.effect.reorder", ...commandTarget(target), effectRowIds: ids });
    return commandFailure("clip.effect.reorder", result) ?? success(`Reordered the effects on ${target.label}.`, { ...commandTarget(target), effectRowIds: ids });
};

// ── masks ──────────────────────────────────────────────

/** set_mask number fields → [min, max] (timeline-core looks/masks.ts ranges). */
const MASK_NUMBER_RANGES: Record<string, readonly [number, number]> = {
    x: MASK_POSITION_RANGE, y: MASK_POSITION_RANGE, width: MASK_SIZE_RANGE, height: MASK_SIZE_RANGE,
    rotation: [-MASK_ROTATION_LIMIT, MASK_ROTATION_LIMIT], feather: [0, 1], roundness: [0, 1],
};

/** The set_mask fields as a mask patch (shape excluded), or why they are invalid. */
function maskFields(args: Args): MaskPatch | string {
    const patch: Record<string, unknown> = {};
    for (const [key, [min, max]] of Object.entries(MASK_NUMBER_RANGES)) {
        const value = args[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return `${key} must be a number from ${min} to ${max}.`;
        patch[key] = value;
    }
    if (args.invert !== undefined) {
        if (typeof args.invert !== "boolean") return "invert must be true or false.";
        patch.invert = args.invert;
    }
    return patch as MaskPatch;
}

/** The item a target names, from a snapshot. */
const targetItem = (snap: ControllerSnapshot, target: Target) => ("sceneId" in target
    ? snap.scenes.find((s) => s.id === target.sceneId)
    : snap.clips.find((c) => c.id === target.clipId));

const setMask: ToolHandler = async (args, { session, tool }) => {
    const snap = await session.snapshot();
    const target = lookTarget(snap, args, tool.name, MASK_KINDS);
    if (typeof target === "string") return failure(target);
    const shapeArg = args.shape;
    if (shapeArg !== undefined && shapeArg !== "none" && !isMaskShape(shapeArg)) return failure(`shape must be one of none, linear, mirror, circle, rectangle, heart, star.`);
    const fields = maskFields(args);
    if (typeof fields === "string") return failure(fields);
    if (args.time !== undefined && (typeof args.time !== "number" || !Number.isFinite(args.time))) return failure("time must be a number of item-local seconds.");
    const remove = args.remove === true || shapeArg === "none";
    const reset = args.reset === true;
    const hasFields = Object.keys(fields).length > 0;
    if (remove && (hasFields || reset || (shapeArg !== undefined && shapeArg !== "none"))) {
        return failure("remove (or shape none) deletes the mask; leave out the other shape, reset, and the mask fields (call set_mask again to add a new one).");
    }
    const current = parseMask(targetItem(snap, target)?.maskJson);
    let mask: MaskPatch | null;
    if (remove) {
        mask = null;
    } else {
        if (shapeArg === undefined && !hasFields && !reset) return failure("set_mask needs shape, a mask field, reset, or remove (mask fields: x, y, width, height, rotation, feather, roundness, invert).");
        const shape = isMaskShape(shapeArg) ? shapeArg : current?.shape;
        if (!shape) return failure(`${target.label} has no mask yet; give shape (linear, mirror, circle, rectangle, heart, or star) to add one.`);
        mask = { ...fields, shape };
    }
    const time = typeof args.time === "number" ? args.time : undefined;
    // Fields whose mask channel is keyed are written as keyframes (mask.set's rule), reported back to the agent.
    const points = parseTimelineKeyframes(targetItem(snap, target)?.keyframesJson);
    const keyframed = mask && !reset
        ? MASK_KEYFRAME_CHANNELS.filter((channel) => (mask as Record<string, unknown>)[MASK_CHANNEL_FIELDS[channel]] !== undefined && points.some((p) => typeof p[channel] === "number"))
        : [];
    const result = await session.execute({ type: "mask.set", ...commandTarget(target), mask, ...(time !== undefined ? { time } : {}), ...(reset ? { replace: true } : {}) });
    const failed = commandFailure("mask.set", result);
    if (failed) return failed;
    const after = parseMask(targetItem(await session.snapshot(), target)?.maskJson);
    const text = !after
        ? `Removed the mask from ${target.label}.`
        : `${reset ? "Reset" : current ? "Updated" : "Added"} the ${after.shape} mask on ${target.label}${keyframed.length ? ` (keyframed ${keyframed.join(", ")})` : ""}.`;
    return success(text, { ...commandTarget(target), mask: after, keyframed });
};

// ── paste attributes ───────────────────────────────────

const pasteRef = (snap: ControllerSnapshot, ref: AttributeTarget): Record<string, unknown> => {
    if (ref.clipId) return { clip_id: ref.clipId };
    if (ref.sceneId) {
        const order = scenesInOrder(snap.scenes).findIndex((s) => s.id === ref.sceneId);
        return order >= 0 ? { scene_order: order + 1 } : { scene_id: ref.sceneId };
    }
    return {};
};

const refLabel = (ref: Record<string, unknown>) => (ref.clip_id !== undefined ? `clip ${String(ref.clip_id)}` : ref.scene_order !== undefined ? `scene ${String(ref.scene_order)}` : "");

const pasteAttributes: ToolHandler = async (args, { session }) => {
    const snap = await session.snapshot();
    const hasClip = args.source_clip_id !== undefined;
    const hasScene = args.source_scene_order !== undefined;
    if (hasClip === hasScene) return failure("paste_attributes needs source_clip_id or source_scene_order (one of them).");
    const source: AttributeTarget = hasClip ? { clipId: clipById(snap, args.source_clip_id).id } : { sceneId: sceneByOrder(snap, args.source_scene_order).id };
    const clipIds = Array.isArray(args.clip_ids) ? args.clip_ids : [];
    const sceneOrders = Array.isArray(args.scene_orders) ? args.scene_orders : [];
    if (clipIds.length + sceneOrders.length === 0) return failure("paste_attributes needs clip_ids or scene_orders to paste onto.");
    const targets: AttributeTarget[] = [
        ...sceneOrders.map((order) => ({ sceneId: sceneByOrder(snap, order).id })),
        ...clipIds.map((id) => ({ clipId: clipById(snap, id).id })),
    ];
    let attributes: AttributeKind[] | undefined;
    if (args.attributes !== undefined) {
        const list = Array.isArray(args.attributes) ? args.attributes : [];
        const bad = list.find((kind) => !(ATTRIBUTE_KINDS as readonly unknown[]).includes(kind));
        if (list.length === 0 || bad !== undefined) return failure(`attributes must list kinds from ${ATTRIBUTE_KINDS.join(", ")}.`);
        attributes = [...new Set(list as AttributeKind[])];
    }
    const result = await session.execute({ type: "attributes.paste", source, targets, ...(attributes ? { attributes } : {}) });
    const report = (result.output ?? { applied: [], skipped: [] }) as AttributePasteReport;
    const applied = report.applied.map(({ kinds, ...ref }) => ({ ...pasteRef(snap, ref), kinds }));
    const skipped = report.skipped.map(({ kind, reason, ...ref }) => ({ ...pasteRef(snap, ref), ...(kind ? { kind } : {}), reason }));
    const skippedText = skipped.map((entry) => `${[refLabel(entry), entry.kind].filter(Boolean).join(": ")} (${entry.reason})`).join(", ");
    const failed = commandFailure("attributes.paste", result);
    if (failed) return failure(`${failed.text}${skipped.length ? `. Skipped ${skippedText}.` : ""}`, { applied, skipped });
    const appliedText = applied.map((entry) => `${refLabel(entry)} (${entry.kinds.join(", ")})`).join(", ");
    return success(`Pasted onto ${applied.length ? appliedText : "nothing new (the targets already match)"}${skipped.length ? `; skipped ${skippedText}` : ""}.`, { applied, skipped });
};

export const LOOK_HANDLERS: Record<string, ToolHandler> = {
    list_transitions: listTransitions,
    apply_transition: applyTransition,
    list_filters: listFilters,
    apply_filter: applyFilter,
    set_adjustments: setAdjustments,
    reorder_visual_effects: reorderVisualEffects,
    set_mask: setMask,
    paste_attributes: pasteAttributes,
};
