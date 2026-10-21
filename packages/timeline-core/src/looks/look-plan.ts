// What the preview and the export apply to one clip or scene, in order: one Hald CLUT (filter at its
// intensity, then the pointwise adjustments), sharpen, vignette, grain, then the enabled built-in
// effects of its stack (static color effects as their own CLUT, others as IR passes), and last the mask
// (phase 10c, looks/masks.ts), which cuts the item's alpha before it is placed.
import type { ClipEffect } from "../model/timeline";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import type { KeyframePoints } from "../motion/keyframes";
import { clipTakesMask, isMaskAnimated, maskKeyframeKey, parseMask, serializeMask, type MaskSpec } from "./masks";
import { adjustPixel, isPointwiseNeutral, itemAdjustments, serializeAdjustments, POINTWISE_ADJUSTMENTS } from "./adjust";
import type { Rgb } from "./color";
import { effectById, effectParams, type EffectPass } from "./effects";
import { filterPixel, normalizeFilterId } from "./filters";
import { sharpenKernel, type Kernel3 } from "./spatial";

export interface LookSource {
    kind: "clip" | "scene";
    visualFilter?: string | null;
    filterIntensity?: number | null;
    adjustmentsJson?: string | null;
    brightness?: number | null;
    contrast?: number | null;
    saturation?: number | null;
    effects?: Array<Pick<ClipEffect, "id" | "effectId" | "order" | "paramsJson" | "enabled">> | null;
    /** Mask (phase 10c, looks/masks.ts): scenes and video, image, text (phase 10d), and sticker clips. */
    maskJson?: string | null;
    /** The item's keyframes: mask_* channels animate the mask (keyframe time = item-local; scene-local for scenes). */
    keyframesJson?: string | null;
    /** Clips: audio, effect, and graphics clips take no mask (looks/masks.ts clipTakesMask). */
    trackType?: string | null;
}

export type LookStep =
    | { kind: "lut"; key: string; fn(c: Rgb): Rgb }
    | { kind: "sharpen"; kernel: Kernel3 }
    | { kind: "vignette"; amount: number }
    | { kind: "grain"; amount: number }
    | { kind: "pass"; key: string; effectId: string; pass: EffectPass; params: Record<string, number> }
    /**
     * The mask: alpha × level / 255 (looks/masks.ts). `points` are the item's keyframes (the mask_* channels
     * animate it, evaluated at the keyframe time every backend receives); `key` names the mask and its keyframes.
     */
    | { kind: "mask"; key: string; mask: MaskSpec; points: KeyframePoints; animated: boolean };

export interface LookPlan {
    steps: LookStep[];
    /** Enabled stack rows whose effect is not built in (legacy catalog effects). */
    unknownEffects: string[];
    /** True when a step reads time (the preview must redraw every frame). */
    animated: boolean;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Intensity 0..1; a filter without one (pre-10a projects) is full strength. */
export function itemFilterIntensity(item: Pick<LookSource, "filterIntensity">): number {
    const value = item.filterIntensity;
    return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

export function itemLook(item: LookSource): LookPlan | null {
    const steps: LookStep[] = [];
    const unknownEffects: string[] = [];
    const adjust = itemAdjustments(item, item.kind);
    const filter = normalizeFilterId(item.visualFilter);
    const intensity = itemFilterIntensity(item);
    const hasFilter = filter !== "none" && intensity > 0;
    if (hasFilter || !isPointwiseNeutral(adjust)) {
        const key = `flt:${filter}@${r4(hasFilter ? intensity : 0)}|adj:${serializeAdjustments(adjust, POINTWISE_ADJUSTMENTS) ?? ""}`;
        steps.push({
            kind: "lut",
            key,
            fn: (c) => adjustPixel(hasFilter ? filterPixel(filter, c, intensity) : c, adjust),
        });
    }
    const kernel = sharpenKernel(adjust.sharpen);
    if (kernel) steps.push({ kind: "sharpen", kernel });
    if (adjust.vignette > 0) steps.push({ kind: "vignette", amount: r4(adjust.vignette) });
    if (adjust.grain > 0) steps.push({ kind: "grain", amount: r4(adjust.grain) });
    let animated = adjust.grain > 0;
    const rows = [...(item.effects ?? [])].filter((row) => row.enabled).sort((a, b) => a.order - b.order);
    for (const row of rows) {
        const effect = effectById(row.effectId);
        if (!effect) {
            unknownEffects.push(row.effectId);
            continue;
        }
        const params = effectParams(effect, row.paramsJson);
        const paramKey = JSON.stringify(params);
        if (effect.lut) {
            const fn = effect.lut(params);
            steps.push({ kind: "lut", key: `fx:${effect.id}:${paramKey}`, fn });
        } else {
            (effect.passes ?? []).forEach((pass, index) => {
                steps.push({ kind: "pass", key: `fx:${effect.id}:${index}:${paramKey}`, effectId: effect.id, pass, params });
            });
            animated = true;
        }
    }
    const mask = itemMask(item);
    if (mask) {
        steps.push(mask);
        animated = animated || mask.animated;
    }
    if (steps.length === 0 && unknownEffects.length === 0) return null;
    return { steps, unknownEffects, animated };
}

/** The item's mask step, or null (no mask, unreadable, or an item kind that takes none). */
export function itemMask(item: LookSource): Extract<LookStep, { kind: "mask" }> | null {
    if (item.kind === "clip" && item.trackType && !clipTakesMask(item)) return null;
    const mask = parseMask(item.maskJson);
    if (!mask) return null;
    const points = item.keyframesJson ? parseTimelineKeyframes(item.keyframesJson) : [];
    const animated = isMaskAnimated(mask, points);
    const key = `mask:${serializeMask(mask)}${animated ? `|kf:${maskKeyframeKey(points)}` : ""}`;
    return { kind: "mask", key, mask, points: animated ? points : [], animated };
}

/** The item's mask as a plan of its own (text draws no look, only its mask), or null without a mask. */
export function maskLook(item: LookSource): LookPlan | null {
    const mask = itemMask(item);
    return mask ? { steps: [mask], unknownEffects: [], animated: mask.animated } : null;
}

export function lookFunctionPixel(step: Extract<LookStep, { kind: "lut" }>, c: Rgb): Rgb {
    return step.fn(c);
}
