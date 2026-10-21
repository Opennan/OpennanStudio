// A clip's or scene's look (looks/look-plan.ts in timeline-core) as ffmpeg filters on its own pixels:
// Hald CLUTs on packed RGB (FFmpeg rotates channels when the CLUT stream is planar), sharpen on a
// replicated border, vignette and grain as blends against generated images, effect passes as geq. Each
// generated image is one ffmpeg input however many items use it (compile/shared-inputs.ts). The mask (phase
// 10c, last step) cuts the alpha: a static mask is a generated gray image (timeline-core maskImage, the
// reference itself) merged as the alpha of an opaque item or multiplied into an item's own alpha (blend
// multiply); an animated mask is geq on the alpha plane with its keyframes as expressions of the keyframe clock.
// Every step is parity-tested against the JS references on FFmpeg 5.1 (wasm) and 7.1 (desktop).
import { emitFfmpeg, geqOptions } from "@opennan/timeline-core/looks/expr";
import { maskBoxKey, maskExpr, maskImage, type MaskBox } from "@opennan/timeline-core/looks/masks";
import { buildHaldClut, haldClutPng } from "@opennan/timeline-core/looks/lut";
import type { LookPlan, LookStep } from "@opennan/timeline-core/looks/look-plan";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { grainCropOptions, grainImage, sharpenFilters, vignetteMask } from "@opennan/timeline-core/looks/spatial";
import { addFile, type CompileContext } from "../compile/context";
import { frameClock } from "../compile/placement";
import { loopedStill, sharedStill } from "../compile/shared-inputs";
import { applyKeyedLut, type ExportKeyedLook } from "../motion/lut-keyframes";

export interface LookTarget {
    width: number;
    height: number;
    /** Keep an alpha plane (stickers, PNG overlays, transparent lanes). */
    alpha: boolean;
    /** Seconds the stream lasts (grain image length). */
    duration: number;
    /** Item-local seconds at the stream's first frame (geq T is shifted by it). */
    timeOffset?: number;
    /** Keyframe time (item-local; scene-local for scene pieces) at the stream's first frame, for keyframed looks. Default timeOffset. */
    keyframeOffset?: number;
    /** The item's box inside the stream for the mask (phase 10d: padded text and sticker bitmaps); default the whole stream. */
    maskBox?: MaskBox | null;
}

/**
 * Applies the plan to `pad` and returns the new pad (RGB, with the source's alpha merged back for alpha targets).
 * Null plan: the pad itself. `keyed` (Adjust keyframes, motion/lut-keyframes.ts) runs first, in place of the
 * plan's adjust CLUT; `plan` is then the steps after it.
 */
type MaskStep = Extract<LookStep, { kind: "mask" }>;

/** The mask level of every pixel as a gray stream: `alpha` (an item's own alpha plane) times the level, or the level alone. */
function maskAlpha(ctx: CompileContext, mask: MaskStep, target: LookTarget, alpha: string | null, clock: string | null): string {
    const { graph } = ctx;
    const w = Math.max(1, Math.round(target.width));
    const h = Math.max(1, Math.round(target.height));
    if (!mask.animated) {
        const box = target.maskBox ?? null;
        const name = addFile(ctx, `mask|${w}x${h}${maskBoxKey(box)}|${mask.key}`, "mask", () => encodePng({ width: w, height: h, channels: 1, data: maskImage(mask.mask, w, h, [], 0, box) }));
        const still = sharedStill(graph, name, ["format=gray"], "mask");
        if (!alpha) return still;
        return graph.chain([alpha, still], ["blend=all_mode=multiply"], graph.label("ma"));
    }
    // geq stores by truncation: floor(a·L/255) is exact in double (a·L is an integer), the blend multiply rule.
    const offset = target.keyframeOffset ?? target.timeOffset ?? 0;
    const level = emitFfmpeg(maskExpr(mask.mask, mask.points, undefined, target.maskBox), { target: "geq" }, { reuseSlots: true, timeVar: frameClock("T", ctx.format.fps), timeOffset: offset ? -offset : 0 });
    if (alpha) return graph.chain([alpha], [`geq=i=n:lum='floor(lum(X,Y)*${level}/255)'`], graph.label("ma"));
    return graph.chain([clock!], ["format=gray", `geq=i=n:lum='${level}'`], graph.label("ma"));
}

export function applyLook(ctx: CompileContext, pad: string, plan: LookPlan | null, target: LookTarget, keyed: ExportKeyedLook | null = null): string {
    if (!keyed && (!plan || plan.steps.length === 0)) return pad;
    const { graph } = ctx;
    const mask = plan?.steps.find((step): step is MaskStep => step.kind === "mask") ?? null;
    const colorPlan = mask && plan ? { ...plan, steps: plan.steps.filter((step) => step.kind !== "mask") } : plan;
    if (target.alpha) {
        // swscale's rgba → gbrap conversion can move alpha by one level: the color runs without alpha and
        // the untouched alpha plane is merged back (alphaextract/alphamerge copy it exactly).
        const color = graph.label("lc");
        const alphaSource = graph.label("la");
        graph.chain([pad], ["format=rgba", "split=2"], `${color}][${alphaSource}`);
        const extracted = graph.chain([alphaSource], ["alphaextract"], graph.label("la"));
        const alpha = mask ? maskAlpha(ctx, mask, target, extracted, null) : extracted;
        const processed = applyLook(ctx, color, colorPlan, { ...target, alpha: false }, keyed);
        return graph.chain([processed, alpha], ["alphamerge"], graph.label("lk"));
    }
    if (mask) {
        // An opaque item: the color, then the mask level as its alpha (the frames of an animated mask follow the item's own clock).
        const processed = applyLook(ctx, pad, colorPlan, target, keyed);
        let color = processed;
        let clock: string | null = null;
        if (mask.animated) {
            color = graph.label("mc");
            clock = graph.label("mk");
            // split shares one format between its outputs: pin it to planar RGB, or negotiation may pick gray for both.
            graph.chainOutputs([processed], ["format=gbrp", "split=2"], [color, clock]);
        }
        return graph.chain([color, maskAlpha(ctx, mask, target, null, clock)], ["alphamerge"], graph.label("lk"));
    }
    const planar = "gbrp";
    const packed = "rgb24";
    const w = Math.max(1, Math.round(target.width));
    const h = Math.max(1, Math.round(target.height));
    let current = keyed ? applyKeyedLut(ctx, pad, keyed, target.keyframeOffset ?? target.timeOffset ?? 0) : pad;
    for (const step of plan?.steps ?? []) {
        switch (step.kind) {
            case "lut": {
                const name = addFile(ctx, `lut|${step.key}`, "look", () => haldClutPng(buildHaldClut(step.fn)));
                const clut = sharedStill(graph, name, ["format=rgb24"], "clut");
                const main = graph.chain([current], [`format=${packed}`], graph.label("lk"));
                current = graph.chain([main, clut], ["haldclut=interp=trilinear"], graph.label("lk"));
                break;
            }
            case "sharpen":
                current = graph.chain([current], [`format=${planar}`, ...sharpenFilters(step.kernel)], graph.label("lk"));
                break;
            case "vignette": {
                const name = addFile(ctx, `vignette|${w}x${h}|${step.amount}`, "mask", () => encodePng({ width: w, height: h, channels: 1, data: vignetteMask(w, h, step.amount) }));
                const mask = sharedStill(graph, name, [`format=${planar}`], "mask");
                const main = graph.chain([current], [`format=${planar}`], graph.label("lk"));
                current = graph.chain([main, mask], ["blend=all_mode=multiply"], graph.label("lk"));
                break;
            }
            case "grain": {
                const image = () => {
                    const g = grainImage(w, h, step.amount);
                    return encodePng({ width: g.width, height: g.height, channels: 1, data: g.data });
                };
                const name = addFile(ctx, `grain|${w}x${h}|${step.amount}`, "grain", image);
                // The frames `-loop 1 -framerate fps -t duration` gave, from one shared decode (shared-inputs.ts).
                const frames = loopedStill(graph, name, ctx.format.fps, Math.max(1 / ctx.format.fps, target.duration), "gl");
                const offset = target.timeOffset ?? 0;
                const grain = graph.chain([frames], [`crop=${grainCropOptions(w, h, offset)}`, `format=${planar}`], graph.label("grain"));
                const main = graph.chain([current], [`format=${planar}`], graph.label("lk"));
                current = graph.chain([main, grain], ["blend=all_mode=grainmerge"], graph.label("lk"));
                break;
            }
            case "pass": {
                const options = geqOptions((ch) => step.pass.channel(ch), { params: step.params, timeOffset: target.timeOffset ? -target.timeOffset : 0 });
                current = graph.chain([current], [`format=${planar}`, `geq=${options}`], graph.label("lk"));
                break;
            }
            case "mask":
                break; // handled above (alpha)
        }
    }
    return current;
}
