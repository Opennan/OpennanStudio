// Built-in graphics clips in the ffmpeg export (phase 10d): each clip's image sequence (raster/jobs.ts
// planGraphicsJobs, drawn by the rasterizer with raster/graphics-frame.ts) is one image2 input whose frame i is
// output frame firstFrame + i, overlaid at 0:0 over exactly those frames. The GPU path draws the same frames
// (gpu/plan.ts), so both engines show the graphic on the same frames with the same pixels.
import type { TimelineClip } from "@opennan/timeline-core";
import { isBuiltinGraphics } from "@opennan/timeline-core/graphics/render";
import { fmt } from "../format";
import type { RasterResult } from "../types";
import type { CompileContext } from "./context";

/** The built-in graphics clips in layer order: lower tracks first, then by start. */
export function graphicsClips(clips: TimelineClip[]): TimelineClip[] {
    return clips
        .filter((clip) => isBuiltinGraphics(clip))
        .sort((a, b) => (a.trackIndex ?? 1) - (b.trackIndex ?? 1) || a.startTime - b.startTime);
}

/** Overlays `clip`'s sequence on `below`; without one (no rasterizer here), warns and returns `below`. */
export function compileGraphicsOverlay(ctx: CompileContext, below: string, clip: TimelineClip, raster: RasterResult | undefined): string {
    const sequence = raster?.sequence;
    const firstFrame = raster?.firstFrame;
    if (!raster || !sequence || sequence.length === 0 || firstFrame === undefined) {
        if (!raster) {
            ctx.warnings.push({ code: "remotion-unsupported", message: "Graphics need a canvas to draw, which this export host does not have; this clip is left out.", clipId: clip.id });
        }
        return below;
    }
    if (raster.missingAssets?.length) {
        ctx.warnings.push({ code: "graphics-asset-missing", message: "This graphic's image could not be loaded here; the graphic is exported without it.", clipId: clip.id });
    }
    const { graph, format, files } = ctx;
    const { fps } = format;
    // The compiler names job files; clip ids come from project data and never reach a path.
    const index = files.filter((file) => file.name.startsWith("gfx")).reduce((n, file) => Math.max(n, Number(/^gfx(\d+)-/.exec(file.name)?.[1] ?? -1) + 1), 0);
    const prefix = `gfx${index}-`;
    sequence.forEach((png, i) => files.push({ name: `${prefix}${String(i).padStart(5, "0")}.png`, data: png }));
    const input = graph.input("file", `${prefix}%05d.png`, ["-f", "image2", "-framerate", String(fps), "-start_number", "0"]);
    const start = firstFrame / fps;
    const layer = graph.chain([`${input}:v`], [`setpts=PTS-STARTPTS+${fmt(start)}/TB`], graph.label("gfx"));
    const enable = `enable='between(t,${fmt((firstFrame - 0.5) / fps)},${fmt((firstFrame + sequence.length - 0.5) / fps)})'`;
    return graph.chain([below, layer], [`overlay=0:0:eof_action=pass:format=auto:${enable}`], graph.label("ov"));
}
