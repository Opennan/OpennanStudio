// One output frame of a built-in graphics clip on Canvas 2D (phase 10d), shared by both export engines: the
// ffmpeg path encodes it as a PNG of the image sequence (canvas-rasterizer.ts), the GPU path uploads it as a
// full-frame layer (gpu/gpu-export.ts). The template frame is drawn on a clear layer canvas filling the frame,
// then placed as one layer (matrix, group opacity) on a clear output canvas — the preview's CSS transform and
// opacity on its full-frame layer.
import { drawGraphicsFrame } from "@opennan/timeline-core/graphics/render";
import type { GraphicsAssets, GraphicsContext } from "@opennan/timeline-core/graphics/types";
import type { GraphicsRasterFrame, GraphicsRasterJob } from "../types";

export interface GraphicsCanvasPair {
    width: number;
    height: number;
    /** Scratch canvas the template frame is drawn on, and its context. */
    layer: CanvasImageSource;
    layerContext: GraphicsContext;
    /** The output frame's context. */
    out: GraphicsContext;
}

export type GraphicsClipData = Pick<GraphicsRasterJob, "templateId" | "propsJson" | "startTime" | "endTime">;

/** Clears the output and draws `entry` (null: leaves it clear). */
export function drawGraphicsEntry(pair: GraphicsCanvasPair, clip: GraphicsClipData, entry: GraphicsRasterFrame | null, assets: GraphicsAssets | null): void {
    const { width, height, out, layerContext } = pair;
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = 1;
    out.clearRect(0, 0, width, height);
    if (!entry) return;
    layerContext.setTransform(1, 0, 0, 1, 0, 0);
    layerContext.globalAlpha = 1;
    layerContext.clearRect(0, 0, width, height);
    drawGraphicsFrame(layerContext, {
        trackType: "remotion", startTime: clip.startTime, endTime: clip.endTime, remotionTemplateId: clip.templateId, remotionPropsJson: clip.propsJson, remotionCode: null,
    }, { width, height, frame: entry.frame, assets });
    out.setTransform(...entry.matrix);
    out.globalAlpha = entry.opacity;
    out.drawImage(pair.layer, 0, 0, width, height);
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = 1;
}

/** A stable key of an entry: equal keys draw equal pixels. */
export function graphicsEntryKey(entry: GraphicsRasterFrame | null): string {
    return entry ? `${entry.frame}|${entry.matrix.join(",")}|${entry.opacity}` : "none";
}
