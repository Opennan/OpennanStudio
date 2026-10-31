// Media references for capability inputs (phase 11). ai.run inputs stay small JSON (MAX_RUN_INPUT_BYTES): a media tool
// names the project's media and the source range it needs, and the provider asks its host's MediaPreparer for the
// file (web: mediabunny in the page; desktop: main trims with the bundled ffmpeg), then uploads it where its key lives.

/** A range of one of the project's media files. Seconds are source-media seconds; absent means the whole file. */
export interface MediaSourceRef {
    /** The project's media URL (opennan-local://, opennan-media://, blob:, or https:). */
    mediaUrl: string;
    startSeconds?: number;
    endSeconds?: number;
}

/** What to prepare: a media range, or the mixed audio of a timeline snapshot (cloud captions of the whole timeline). */
export type MediaPrepareInput = { kind: "media"; source: MediaSourceRef } | { kind: "timeline"; snapshot: unknown };

export interface MediaPreparePurpose {
    /** audio: an audio-only file; video: the video stream (audio dropped unless keepAudio); image: a still as is. */
    output: "audio" | "video" | "image";
    keepAudio?: boolean;
    /** Audio sample rate (16000 for speech, 44100 for voice and music). */
    sampleRate?: number;
    /** The destination's size cap. */
    maxBytes: number;
    /** The destination's length cap (the preparer never produces more). */
    maxSeconds?: number;
    /** Content types the destination accepts, preferred first. */
    contentTypes: readonly string[];
    /**
     * Video: the smallest picture the destination takes, in pixels per frame. A smaller source is scaled up (its shape
     * kept, sides even) until it has at least this many; a source that has them is never resized.
     */
    minPixels?: number;
    /** Video: the frame rates the destination takes; a source outside them is re-timed to the nearest one (when the preparer can). */
    frameRate?: { min: number; max: number };
}

export interface PreparedMedia {
    data: Blob | Uint8Array;
    contentType: string;
    filename: string;
    sizeBytes: number;
    /** The prepared file's own length: providers re-check their estimate against it before anything is sent. */
    durationSeconds?: number;
    width?: number;
    height?: number;
    /** Video: frames per second of the prepared file, when the preparer knows it. */
    frameRate?: number;
}

export type MediaPreparer = (input: MediaPrepareInput, purpose: MediaPreparePurpose, signal: AbortSignal) => Promise<PreparedMedia>;

const MEDIA_URL = /^(opennan-local:\/\/|opennan-media:\/\/|blob:|https:\/\/)/;

/** A MediaSourceRef from untrusted input (ai.run, MCP), or a reason it is not one. */
export function parseMediaSourceRef(value: unknown): MediaSourceRef | string {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "a media source must be { mediaUrl, startSeconds?, endSeconds? }";
    const raw = value as Record<string, unknown>;
    for (const key of Object.keys(raw)) if (!["mediaUrl", "startSeconds", "endSeconds"].includes(key)) return `unknown media source field ${key}`;
    if (typeof raw.mediaUrl !== "string" || raw.mediaUrl.length === 0 || raw.mediaUrl.length > 4096 || !MEDIA_URL.test(raw.mediaUrl)) return "mediaUrl must be a project media URL";
    const ref: MediaSourceRef = { mediaUrl: raw.mediaUrl };
    for (const key of ["startSeconds", "endSeconds"] as const) {
        const seconds = raw[key];
        if (seconds === undefined) continue;
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) return `${key} must be seconds from 0 to 86400`;
        ref[key] = seconds;
    }
    if (ref.startSeconds !== undefined && ref.endSeconds !== undefined && ref.endSeconds <= ref.startSeconds) return "endSeconds must come after startSeconds";
    return ref;
}

/**
 * The picture size a preparer encodes for `purpose.minPixels`: the source's, or (when it has fewer pixels) scaled up
 * with its shape kept, each side even, until it has at least that many.
 */
export function minPixelsSize(width: number, height: number, minPixels: number | undefined): { width: number; height: number } {
    if (!minPixels || !(width > 0) || !(height > 0) || width * height >= minPixels) return { width, height };
    const scale = Math.sqrt(minPixels / (width * height));
    let w = Math.ceil((width * scale) / 2) * 2;
    let h = Math.ceil((height * scale) / 2) * 2;
    while (w * h < minPixels) {
        w += 2;
        h = Math.ceil((w * height) / width / 2) * 2;
    }
    return { width: w, height: h };
}
