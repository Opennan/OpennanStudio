// What Provider.run() resolves to (spec §5.4, phase 8): generated media (a URL to download or the bytes) plus an
// opaque result for opennan.* tools and the cost the provider charged. Hosts import the media into the project's
// library (createAiRunner's importMedia) and hand local URLs to the editor and agents.

export type GeneratedMediaKind = "video" | "image" | "audio";

export interface GeneratedMedia {
    kind: GeneratedMediaKind;
    /** Where to download it (https). Never fetched with provider credentials. */
    url?: string;
    /** The file itself, for providers that answer with bytes (speech). */
    bytes?: Uint8Array;
    mimeType?: string;
    name?: string;
    durationSeconds?: number;
    sizeBytes?: number;
    /** What the file is among several (a stem: "vocals", "instrumental", "drums", "bass", "other"). */
    role?: string;
    /** Pixel size of a video or image, when known. */
    width?: number;
    height?: number;
}

export interface CapabilityOutput {
    media: GeneratedMedia[];
    /** A tool's typed result (opennan.* tools): passed through as is. */
    result?: unknown;
    /** What the provider charged for the job, in US dollars. */
    costUsd?: number;
    /** Pixel size of the media Studio sent (phase 11): a resized result (an upscale) is stacked at the source's size. */
    sourceSize?: { width: number; height: number };
}

const KINDS = new Set<string>(["video", "image", "audio"]);

export function isCapabilityOutput(value: unknown): value is CapabilityOutput {
    if (typeof value !== "object" || value === null) return false;
    const media = (value as { media?: unknown }).media;
    return Array.isArray(media) && media.every((m) => typeof m === "object" && m !== null && KINDS.has((m as { kind?: string }).kind ?? ""));
}
