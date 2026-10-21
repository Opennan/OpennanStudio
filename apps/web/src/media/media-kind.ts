// File type detection for imports and the ffmpeg input names of the interim export.
import type { MediaKind, UploadedMedia } from "@opennan/timeline-core";

const EXTENSION_KIND: Record<string, MediaKind> = {
    mp4: "video", m4v: "video", mov: "video", webm: "video", mkv: "video", ogv: "video",
    mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", oga: "audio", opus: "audio", flac: "audio",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image",
};

const MIME_EXTENSION: Record<string, string> = {
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "video/ogg": "ogv",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mp4": "m4a",
    "audio/aac": "aac", "audio/ogg": "ogg", "audio/flac": "flac", "audio/webm": "webm",
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
};

/**
 * What the file picker accepts (MediaBin). Some of these may not decode in every browser
 * or in ffmpeg.wasm (AVIF, .mkv, HEVC or ProRes .mov): they still import, the bin marks
 * video and audio the browser could not read (no duration) as "May not play in this
 * browser", and an export that fails on one names the file (Task 28b).
 */
export const MEDIA_ACCEPT = "video/*,audio/*,image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,.mkv,.mov";

/**
 * The largest media file the browser editor imports or exports (README "Limits").
 * IndexedDB keeps blobs on disk, but browser decoders and the ffmpeg.wasm export are
 * not reliable above this.
 */
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;

export function extensionOf(name: string): string {
    const match = /\.([a-z0-9]+)$/i.exec(name);
    return match ? match[1].toLowerCase() : "";
}

/** By MIME type first, then by extension (drag-and-drop often reports an empty type). SVG is not supported. */
export function mediaKindOf(file: { name: string; type: string }): MediaKind | null {
    const type = file.type.toLowerCase();
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (type.startsWith("image/")) return type === "image/svg+xml" ? null : "image";
    return EXTENSION_KIND[extensionOf(file.name)] ?? null;
}

export function mediaKindOfItem(media: Pick<UploadedMedia, "name" | "mimeType">): MediaKind | null {
    return mediaKindOf({ name: media.name, type: media.mimeType });
}

/** Virtual file extension for ffmpeg, which picks demuxers by name for still images. */
export function extensionForMime(mime: string, fallbackName = ""): string {
    const base = mime.split(";")[0].trim().toLowerCase();
    return MIME_EXTENSION[base] ?? (extensionOf(fallbackName) || "bin");
}
