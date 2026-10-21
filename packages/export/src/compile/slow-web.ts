// How much of the export runs per-pixel `geq` expressions (phase 10b slow-export warning). On ffmpeg.wasm a
// geq pass over a full frame costs far more than everything else in the graph, so a long stretch of them
// makes a browser export take many minutes; the desktop app runs the same graph natively.
//
// Counted, as timeline seconds per item (an item with several passes counts once):
// - scenes whose look has an effect pass (every built-in pass is animated or spatial: geq, look-plan.ts);
// - scenes with an animated opacity channel (lanes.ts placeSceneMotion: geq on the alpha plane);
// - V2+ video clips with an effect pass or a keyframed/animated opacity (overlays.ts: geq alpha; legacy
//   alpha fades use the fade filter and do not count) whose peak scale makes them a full-size layer;
// - effect-track spans with an effect pass (effect-spans.ts: geq on the whole composite);
// - scenes and full-size V2+ clips with a keyframed mask (look-filters.ts: geq on the alpha plane).
// Not counted: CLUT-only looks, text and stickers (small bitmaps), and small overlay clips.
import type { TimelineClip } from "@opennan/timeline-core";
import { itemLook, type LookSource } from "@opennan/timeline-core/looks/look-plan";
import { isConstantChannel, itemMotion } from "@opennan/timeline-core/motion/transform";
import { DEFAULT_FPS } from "../presets";
import { placeScenes, playableClips, sceneDuration } from "../timeline-model";
import type { ExportInput } from "../types";
import { effectSpans } from "./effect-spans";
import { channelPeak } from "./overlay-scale";

/** Above this many seconds of geq work, web exports warn (`slow-web-effect`). */
export const SLOW_WEB_EFFECT_SECONDS = 20;
/** An overlay clip counts as a full-size layer from this peak scale (a quarter of the frame and up). */
const FULL_SIZE_SCALE = 0.5;

/** An effect pass, or a keyframed mask (looks/look-filters.ts: geq on the alpha plane; a static mask is a generated image). */
function hasPass(source: LookSource): boolean {
    return itemLook(source)?.steps.some((step) => step.kind === "pass" || (step.kind === "mask" && step.animated)) ?? false;
}

/** overlays.ts: opacity other than base × legacy fades runs a per-frame geq alpha. */
function clipGeqOpacity(clip: TimelineClip): boolean {
    return !isConstantChannel(itemMotion({ kind: "clip", clip: { ...clip, fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none" } }), "opacity");
}

/** Timeline seconds of per-pixel geq work in the export (see the header for what counts). */
export function slowWebEffectSeconds(input: ExportInput): number {
    let total = 0;
    for (const placed of placeScenes(input.scenes, input.tracks)) {
        const scene = placed.scene;
        const opacity = itemMotion({ kind: "scene", scene, duration: sceneDuration(scene) }).channels.opacity;
        if (opacity.k !== "num" || hasPass({ kind: "scene", ...scene })) total += Math.max(0, placed.end - placed.start);
    }
    const clips = playableClips(input.clips, input.tracks);
    for (const clip of clips) {
        if (clip.trackType !== "video" || (clip.trackIndex ?? 2) < 2 || !clip.mediaUrl) continue;
        if (!clipGeqOpacity(clip) && !hasPass({ kind: "clip", ...clip })) continue;
        if (channelPeak(itemMotion({ kind: "clip", clip }), "scale", DEFAULT_FPS) < FULL_SIZE_SCALE) continue;
        total += Math.max(0, clip.endTime - clip.startTime);
    }
    for (const span of effectSpans(clips)) {
        if (hasPass({ kind: "scene", effects: span.effects })) total += Math.max(0, span.endTime - span.startTime);
    }
    return total;
}
