// Keyframed Adjust and filter intensity in the export (phase 10b): one Hald CLUT per look keyframe (at most
// LOOK_KEYFRAME_LIMIT), the item's pixels split to a haldclut per CLUT, and the results blended in sequence,
// acc_k = trunc(acc_k−1 + (LUT_k − acc_k−1)·q(s_k(T))), q = round to k / 1024 (timeline-core
// motion/look-keyframes.ts). blend's T is the frame time of its first input: item-local after the overlay's
// time filters (setpts=PTS-STARTPTS), and window-local in a scene piece, so a piece passes the scene-local
// second of its first frame as the offset. blend stores the double into the 8-bit plane by truncation (the
// preview's LookRenderer.lutMix rounds the same way), on planar RGB, where a store per plane is exact.
import type { SceneData, TimelineClip } from "@opennan/timeline-core";
import { emitFfmpeg } from "@opennan/timeline-core/looks/expr";
import { buildHaldClut, haldClutPng } from "@opennan/timeline-core/looks/lut";
import type { LookSource } from "@opennan/timeline-core/looks/look-plan";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import type { KeyframePoints } from "@opennan/timeline-core/motion/keyframes";
import { LOOK_KEYFRAME_LIMIT, LOOK_MIX_WEIGHT_STEPS, keyframedLook, lookSegmentWeight, type KeyframedLook } from "@opennan/timeline-core/motion/look-keyframes";
import { addFile, type CompileContext } from "../compile/context";
import { frameClock } from "../compile/placement";
import { sharedStill } from "../compile/shared-inputs";

export interface ExportKeyedLook extends KeyframedLook {
    points: KeyframePoints;
}

/** The item's keyframed look, or null without look keyframes; warns when keyframes beyond the limit are dropped. */
export function keyedLook(ctx: CompileContext, source: LookSource, keyframesJson: string | null | undefined, owner: { clipId?: string; sceneId?: string }): ExportKeyedLook | null {
    if (!keyframesJson) return null;
    const points = parseTimelineKeyframes(keyframesJson);
    const look = keyframedLook(source, points);
    if (!look) return null;
    if (look.dropped > 0) {
        ctx.warnings.push({
            code: "look-keyframes-limited",
            message: `Only the first ${LOOK_KEYFRAME_LIMIT} Adjust keyframes export; the look holds the last of them after it (${look.dropped} left out).`,
            ...owner,
        });
    }
    return { ...look, points };
}

export function clipKeyframedLook(ctx: CompileContext, clip: TimelineClip): ExportKeyedLook | null {
    return keyedLook(ctx, { kind: "clip", ...clip }, clip.keyframesJson, { clipId: clip.id });
}

export function sceneKeyframedLook(ctx: CompileContext, scene: SceneData): ExportKeyedLook | null {
    return keyedLook(ctx, { kind: "scene", ...scene }, scene.keyframesJson, { sceneId: scene.id });
}

/**
 * blend all_expr for keyframe k: A + (B − A)·q(clip(s_k, 0, 1)), q(w) = floor(w·1024 + 0.5) / 1024 (the JS
 * Math.round of lookMixWeight for w ≥ 0). `timeOffset` is the item-local second of the stream's first frame.
 */
export function lookBlendExpression(look: ExportKeyedLook, k: number, timeOffset = 0, fps = 30): string {
    // T snapped to the frame grid (compile/placement.ts frameClock): a hold easing switches exactly on its keyframe.
    const weight = emitFfmpeg(lookSegmentWeight(look.points, look.times, k), { target: "scalar", time: frameClock("T", fps) }, { timeOffset: timeOffset ? -timeOffset : 0 });
    return `A+(B-A)*(floor(clip(${weight},0,1)*${LOOK_MIX_WEIGHT_STEPS}+0.5)/${LOOK_MIX_WEIGHT_STEPS})`;
}

/** The keyframed CLUT cross-fade on `pad` (packed RGB in, planar gbrp out). */
export function applyKeyedLut(ctx: CompileContext, pad: string, look: ExportKeyedLook, timeOffset = 0): string {
    const { graph } = ctx;
    const clutPad = (k: number) => {
        const step = look.luts[k];
        const name = addFile(ctx, `lut|${step.key}`, "look", () => haldClutPng(buildHaldClut(step.fn)));
        return sharedStill(graph, name, ["format=rgb24"], "clut");
    };
    const count = look.luts.length;
    if (count === 1) {
        const main = graph.chain([pad], ["format=rgb24"], graph.label("lk"));
        return graph.chain([main, clutPad(0)], ["haldclut=interp=trilinear"], graph.label("lk"));
    }
    const branches = Array.from({ length: count }, () => graph.label("ks"));
    graph.chainOutputs([pad], ["format=rgb24", `split=${count}`], branches);
    const graded = branches.map((branch, k) => graph.chain([branch, clutPad(k)], ["haldclut=interp=trilinear", "format=gbrp"], graph.label("kh")));
    let acc = graded[0];
    for (let k = 1; k < count; k += 1) {
        acc = graph.chain([acc, graded[k]], [`blend=all_expr='${lookBlendExpression(look, k, timeOffset, ctx.format.fps)}'`], graph.label("kb"));
    }
    return acc;
}
