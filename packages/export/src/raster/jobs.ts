// Bitmaps the export needs from a canvas: text clips, emoji stickers (preview-panel.tsx:1234-1374), and
// bundled catalog stickers (timeline-core stickers/catalog.ts).
import type { TimelineClip } from "@opennan/timeline-core";
import { graphicsLayerAt, graphicsLayerHidden, graphicsLayerMatrix, graphicsOutputFrames } from "@opennan/timeline-core/graphics/layer";
import { graphicsFrameAt, isBuiltinGraphics } from "@opennan/timeline-core/graphics/render";
import { stickerBox, stickerById } from "@opennan/timeline-core/stickers/catalog";
import { overlayScale } from "../compile/overlay-scale";
import { textAtlasPlan } from "../motion/text-atlas";
import type { GraphicsRasterFrame, GraphicsRasterJob, OutputFormat, RasterJob } from "../types";

/** Longest side of a bundled sticker bitmap in px; larger clips scale the bitmap up. */
export const MAX_STICKER_SIDE = 2048;

/** A sticker clip whose `stickerId` is in this build's catalog (drawn from the bundled SVG). */
export function isBundledSticker(clip: TimelineClip): boolean {
    return clip.trackType === "sticker" && Boolean(clip.stickerId && stickerById(clip.stickerId));
}

export function isEmojiSticker(clip: TimelineClip): boolean {
    return clip.trackType === "sticker" && !clip.mediaUrl && Boolean(clip.textContent) && !isBundledSticker(clip);
}

export function isExportedText(clip: TimelineClip): boolean {
    return clip.trackType === "text" && Boolean(clip.textContent?.trim());
}

export const textJobId = (clipId: string) => `text-${clipId}`;
export const emojiJobId = (clipId: string) => `emoji-${clipId}`;
export const stickerJobId = (clipId: string) => `sticker-${clipId}`;
export const graphicsJobId = (clipId: string) => `graphics-${clipId}`;

/** A bundled sticker's box in output px at clip scale `scale` (stickerBox on the output frame height). */
export function bundledStickerBox(stickerId: string, scale: number, format: OutputFormat): { width: number; height: number } | null {
    const box = stickerBox(stickerId, format.height);
    return box && { width: box.width * scale, height: box.height * scale };
}

/** Raster jobs for the playable clips, in clip order. */
export function planRasterJobs(clips: TimelineClip[], format: OutputFormat): RasterJob[] {
    const jobs: RasterJob[] = [];
    for (const clip of clips) {
        const { reference: scale, layout } = overlayScale(clip, format.fps);
        if (isExportedText(clip)) {
            const plan = textAtlasPlan(clip);
            // Text wraps at its layout scale (the preview's textLayoutScale); an animation peak above it draws the
            // same layout larger: font and wrap width both grow by scale / layout.
            jobs.push({
                kind: "text", id: textJobId(clip.id), clipId: clip.id, text: clip.textContent ?? "", textStyle: clip.textStyle,
                scale, frameScale: format.frameScale, frameWidth: scale === layout ? format.width : (format.width * scale) / layout,
                ...(plan ? { states: plan.states } : {}),
            });
        } else if (isBundledSticker(clip)) {
            const box = bundledStickerBox(clip.stickerId!, scale, format)!;
            const fit = Math.min(1, MAX_STICKER_SIDE / Math.max(box.width, box.height));
            jobs.push({
                kind: "sticker", id: stickerJobId(clip.id), clipId: clip.id, stickerId: clip.stickerId!, scale,
                width: Math.max(1, Math.round(box.width * fit)), height: Math.max(1, Math.round(box.height * fit)),
            });
        } else if (isEmojiSticker(clip)) {
            jobs.push({ kind: "emoji", id: emojiJobId(clip.id), clipId: clip.id, text: clip.textContent ?? "", scale, frameScale: format.frameScale });
        }
    }
    return jobs;
}

/** The entry of a graphics clip at output frame `k` (null: nothing drawn), shared by both export engines' timing. */
export function graphicsFrameEntry(clip: TimelineClip, k: number, format: Pick<OutputFormat, "fps" | "width" | "height">): GraphicsRasterFrame | null {
    const local = k / format.fps - clip.startTime;
    const placement = graphicsLayerAt(clip, local);
    if (graphicsLayerHidden(placement)) return null;
    return { frame: graphicsFrameAt(clip, local), matrix: graphicsLayerMatrix(placement, format.width, format.height), opacity: Math.min(1, Math.max(0, placement.opacity)) };
}

/**
 * Image-sequence jobs for the built-in graphics clips (the ffmpeg path; the GPU path draws them per frame): one
 * entry per output frame each clip shows on (graphicsOutputFrames), limited to `window` (inclusive output frames)
 * when given, e.g. a single preview frame.
 */
export function planGraphicsJobs(clips: TimelineClip[], format: OutputFormat, frameCount: number, window?: { first: number; last: number }): GraphicsRasterJob[] {
    const jobs: GraphicsRasterJob[] = [];
    for (const clip of clips) {
        if (!isBuiltinGraphics(clip)) continue;
        const span = graphicsOutputFrames(clip, format.fps, frameCount);
        let first = span.first;
        let end = span.first + span.count;
        if (window) {
            first = Math.max(first, window.first);
            end = Math.min(end, window.last + 1);
        }
        if (end <= first) continue;
        const frames: Array<GraphicsRasterFrame | null> = [];
        for (let k = first; k < end; k += 1) frames.push(graphicsFrameEntry(clip, k, format));
        if (frames.every((entry) => entry === null)) continue;
        jobs.push({
            kind: "graphics", id: graphicsJobId(clip.id), clipId: clip.id, templateId: clip.remotionTemplateId!, propsJson: clip.remotionPropsJson ?? null,
            startTime: clip.startTime, endTime: clip.endTime, width: format.width, height: format.height, firstFrame: first, frames, scale: 1,
        });
    }
    return jobs;
}
