// Drag payload for media bin tiles, in the format the timeline drop handler reads:
// application/json { url, name, mediaType, sourceType } plus an
// application/x-timeline-media-<kind>[;d=<seconds>] marker for the dragover ghost
// (source: SRC/components/editor/media/sources-panel.tsx:325-351; reader:
// packages/timeline-core/src/timeline/canvas/canvas-timeline-utils.ts:169-202).
import type { UploadedMedia } from "@opennan/timeline-core";
import { mediaKindOfItem } from "./media-kind";

export const MEDIA_DRAG_MARKER_PREFIX = "application/x-timeline-media-";

export interface MediaDragPayload {
    json: string;
    marker: string | null;
}

export function buildMediaDragPayload(media: UploadedMedia): MediaDragPayload {
    const kind = mediaKindOfItem(media);
    const duration = media.durationSeconds && media.durationSeconds > 0 ? media.durationSeconds : undefined;
    const json = JSON.stringify({
        url: media.url,
        name: media.name,
        mediaType: kind ?? "uploaded",
        sourceType: kind === "audio" ? "music" : undefined,
        // The drop handler takes a video/image duration from the payload and probes audio itself
        // (packages/timeline-react/src/timeline/nle-timeline.tsx:2547-2571).
        ...(kind !== "audio" && duration ? { duration } : {}),
    });
    const marker = kind ? `${MEDIA_DRAG_MARKER_PREFIX}${kind}${duration ? `;d=${duration.toFixed(1)}` : ""}` : null;
    return { json, marker };
}

export function writeMediaDrag(dataTransfer: DataTransfer, media: UploadedMedia): void {
    const payload = buildMediaDragPayload(media);
    dataTransfer.effectAllowed = "copy";
    dataTransfer.setData("application/json", payload.json);
    if (payload.marker) dataTransfer.setData(payload.marker, "1");
}

export function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
    return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}
