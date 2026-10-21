// Media file types the desktop app imports and stores. The extension of a stored file is always one of these;
// ffmpeg needs it (still images are read with image2's -loop, which extension-less files would not get).
export type MediaKindName = "video" | "audio" | "image";

export const MEDIA_EXTENSIONS: Record<string, { kind: MediaKindName; mimeType: string }> = {
    ".mp4": { kind: "video", mimeType: "video/mp4" },
    ".m4v": { kind: "video", mimeType: "video/mp4" },
    ".mov": { kind: "video", mimeType: "video/quicktime" },
    ".webm": { kind: "video", mimeType: "video/webm" },
    ".mkv": { kind: "video", mimeType: "video/x-matroska" },
    ".mp3": { kind: "audio", mimeType: "audio/mpeg" },
    ".m4a": { kind: "audio", mimeType: "audio/mp4" },
    ".aac": { kind: "audio", mimeType: "audio/aac" },
    ".wav": { kind: "audio", mimeType: "audio/wav" },
    ".ogg": { kind: "audio", mimeType: "audio/ogg" },
    ".opus": { kind: "audio", mimeType: "audio/opus" },
    ".flac": { kind: "audio", mimeType: "audio/flac" },
    ".png": { kind: "image", mimeType: "image/png" },
    ".jpg": { kind: "image", mimeType: "image/jpeg" },
    ".jpeg": { kind: "image", mimeType: "image/jpeg" },
    ".webp": { kind: "image", mimeType: "image/webp" },
    ".gif": { kind: "image", mimeType: "image/gif" },
};

/** The stored extension for a MIME type (first match), or null. */
export function extensionForMime(mimeType: string): string | null {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    return Object.entries(MEDIA_EXTENSIONS).find(([, info]) => info.mimeType === base)?.[0] ?? null;
}
