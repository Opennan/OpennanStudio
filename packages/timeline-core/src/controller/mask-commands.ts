// Pure planning for `mask.set` (phase 10c). The controller turns the plan into one clip.update / scene.update
// (one undo entry). A patch merges into the item's mask (looks/masks.ts applyMaskPatch); a numeric field whose
// keyframe channel (mask_x …) is keyed is written as a keyframe at the given item-local time instead of the
// static value, so the mask stays where it was dropped (the transform handles' rule, drag-commit.ts). null
// removes the mask and every mask_* keyframe channel.
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import { removeKeyframe, serializeKeyframes, setKeyframe, hasChannel } from "../motion/keyframes";
import {
    MASK_CHANNEL_FIELDS, MASK_KEYFRAME_CHANNELS, applyMaskPatch, isMaskShape, parseMask, serializeMask, type MaskKeyframeChannel, type MaskPatch,
} from "../looks/masks";
import { fail, ok, type Plan } from "./speed-plan";

export interface MaskRequest {
    mask: MaskPatch | null;
    /** Item-local seconds for keyframe writes. */
    time: number;
    /** Start from the shape's defaults instead of the current mask, and drop the mask keyframes (Reset). */
    replace?: boolean;
}

export interface MaskPlan {
    maskJson: string | null;
    /** Present when the keyframes change. */
    keyframesJson?: string | null;
}

const PATCH_KEYS = new Set(["shape", "x", "y", "width", "height", "rotation", "feather", "roundness", "invert"]);

/** The fields of `item` that `mask.set` writes, for an item of `duration` seconds. */
/** The keyframes without the mask channels, or undefined when none are keyed. */
function withoutMaskKeyframes(points: ReturnType<typeof parseTimelineKeyframes>): string | null | undefined {
    if (!MASK_KEYFRAME_CHANNELS.some((channel) => hasChannel(points, channel))) return undefined;
    let next = points.slice();
    for (const time of [...new Set(points.map((point) => point.time))]) next = removeKeyframe(next, time, MASK_KEYFRAME_CHANNELS);
    return serializeKeyframes(next);
}

export function planMask(item: { maskJson?: string | null; keyframesJson?: string | null }, duration: number, request: MaskRequest): Plan<MaskPlan> {
    const points = parseTimelineKeyframes(item.keyframesJson);
    if (request.mask === null) {
        const keyframesJson = withoutMaskKeyframes(points);
        return ok(keyframesJson === undefined ? { maskJson: null } : { maskJson: null, keyframesJson });
    }
    const patch = request.mask;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return fail("mask.set needs a mask patch or null");
    const keys = Object.keys(patch).filter((key) => PATCH_KEYS.has(key));
    if (keys.length === 0) return fail("mask.set needs a mask patch or null");
    if (patch.shape !== undefined && !isMaskShape(patch.shape)) return fail(`unknown mask shape "${String(patch.shape)}"`);
    for (const key of keys) {
        if (key === "shape" || key === "invert") continue;
        const value = (patch as Record<string, unknown>)[key];
        if (typeof value !== "number" || !Number.isFinite(value)) return fail(`mask ${key} must be a number`);
    }
    if (patch.invert !== undefined && typeof patch.invert !== "boolean") return fail("mask invert must be true or false");

    if (request.replace) {
        const maskJson = serializeMask(applyMaskPatch(null, patch));
        const keyframesJson = withoutMaskKeyframes(points);
        return ok(keyframesJson === undefined ? { maskJson } : { maskJson, keyframesJson });
    }
    const current = parseMask(item.maskJson);
    const keyedWrites: Partial<Record<MaskKeyframeChannel, number>> = {};
    const staticPatch: Record<string, unknown> = {};
    for (const key of keys) {
        const channel = MASK_KEYFRAME_CHANNELS.find((c) => MASK_CHANNEL_FIELDS[c] === key);
        if (channel && hasChannel(points, channel)) keyedWrites[channel] = (patch as Record<string, number>)[key];
        else staticPatch[key] = (patch as Record<string, unknown>)[key];
    }
    // The static mask also takes keyed values, so the inspector's fields and a later "remove keyframes" agree.
    const merged = applyMaskPatch(current, { ...staticPatch, ...Object.fromEntries(Object.entries(keyedWrites).map(([c, v]) => [MASK_CHANNEL_FIELDS[c as MaskKeyframeChannel], v])) } as MaskPatch);
    const maskJson = serializeMask(merged);
    if (Object.keys(keyedWrites).length === 0) return ok({ maskJson });
    if (!Number.isFinite(request.time) || request.time < -0.001 || request.time > duration + 0.001) return fail("the keyframe time is outside the item");
    const time = Math.min(duration, Math.max(0, request.time));
    // The keyframe holds the clamped value (applyMaskPatch's rules), as the static mask would.
    const values: Record<string, number> = {};
    for (const channel of Object.keys(keyedWrites) as MaskKeyframeChannel[]) values[channel] = merged![MASK_CHANNEL_FIELDS[channel]];
    return ok({ maskJson, keyframesJson: serializeKeyframes(setKeyframe(points, Math.round(time * 1000) / 1000, values)) });
}
