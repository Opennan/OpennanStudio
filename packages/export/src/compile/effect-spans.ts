// Effect-track spans with built-in effects: the composite below runs through the effect passes during
// the span (time starts at 0 at the span's start). The composite is cut into before / span / after with trim
// and joined again with concat, so frames outside the span never leave YUV and nothing is buffered: the 10b
// graph laid the span back with overlay, which made ffmpeg queue every composite frame before the span (a span
// at 40 s of a 1080p project held 1200 frames, about 4 GB, before the first frame reached the encoder).
import type { TimelineClip } from "@opennan/timeline-core";
import { isBuiltinEffect } from "@opennan/timeline-core/looks/effects";
import { itemLook } from "@opennan/timeline-core/looks/look-plan";
import { applyLook } from "../looks/look-filters";
import type { CompileContext } from "./context";

export function effectSpans(clips: TimelineClip[]): TimelineClip[] {
    return clips
        .filter((clip) => clip.trackType === "effect" && clip.effects?.some((row) => row.enabled && isBuiltinEffect(row.effectId)))
        .sort((a, b) => a.trackIndex - b.trackIndex || a.startTime - b.startTime);
}

export function compileEffectSpan(ctx: CompileContext, below: string, clip: TimelineClip): string {
    const { graph } = ctx;
    const { fps, width, height } = ctx.format;
    const startFrame = Math.round(Math.max(0, clip.startTime) * fps);
    const endFrame = Math.round(Math.min(ctx.duration, clip.endTime) * fps);
    if (endFrame - startFrame < 1) return below;
    const plan = itemLook({ kind: "scene", effects: (clip.effects ?? []).filter((row) => isBuiltinEffect(row.effectId)) });
    if (!plan) return below;
    const start = startFrame / fps;
    const end = endFrame / fps;
    const total = Math.round(ctx.duration * fps);
    const parts = [startFrame > 0, true, endFrame < total];
    const pads = parts.filter(Boolean).map(() => graph.label("es"));
    graph.chainOutputs([below], [`split=${pads.length}`], pads);
    const segments: string[] = [];
    let next = 0;
    if (parts[0]) segments.push(graph.chain([pads[next++]], [`trim=end_frame=${startFrame}`, "setpts=PTS-STARTPTS", "format=yuv420p"], graph.label("es")));
    const span = graph.chain([pads[next++]], [`trim=start_frame=${startFrame}:end_frame=${endFrame}`, "setpts=PTS-STARTPTS", `fps=${fps}`], graph.label("es"));
    const processed = applyLook(ctx, span, plan, { width, height, alpha: false, duration: end - start });
    segments.push(graph.chain([processed], ["format=yuv420p"], graph.label("es")));
    if (parts[2]) segments.push(graph.chain([pads[next++]], [`trim=start_frame=${endFrame}`, "setpts=PTS-STARTPTS", "format=yuv420p"], graph.label("es")));
    if (segments.length === 1) return graph.chain([segments[0]], [`settb=1/${fps}`], graph.label("es"));
    return graph.chain(segments, [`concat=n=${segments.length}:v=1:a=0`, `settb=1/${fps}`], graph.label("es"));
}
