// Stores generated media (createAiRunner's importMedia) in the project's media library: bytes are written as is,
// links are downloaded without credentials (never with a provider key), and media a host already imported (desktop
// main hands back opennan-local:// URLs) is only listed. The media bin refreshes through LIBRARY_CHANGED_EVENT.
import type { GeneratedMedia, ImportedMedia } from "@opennan/provider-sdk";
import { LOCAL_MEDIA_URL_PREFIX, type MediaLibraryBackend, type TimelineBackend, type UploadedMedia } from "@opennan/timeline-core";
import { extensionForMime } from "../media/media-kind";

export const LIBRARY_CHANGED_EVENT = "opennan:library-changed";
/** Largest generated file the page downloads. */
export const MAX_GENERATED_BYTES = 512 * 1024 * 1024;

const FALLBACK_MIME: Record<GeneratedMedia["kind"], string> = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" };

export interface MediaImporterOptions {
    fetch?: typeof globalThis.fetch;
    /** Pixel size of a stored video or image (phase 11: a stacked result keeps its on-screen size). Default: probed in the page. */
    probeSize?(file: Blob, kind: GeneratedMedia["kind"]): Promise<{ width: number; height: number } | null>;
    now?(): number;
    /** Plain http from 127.0.0.1/localhost: the e2e build's fake OpenNan server only. */
    allowLoopback?: boolean;
}

function nameFor(media: GeneratedMedia, mimeType: string, now: number): string {
    if (media.name && /^[\w .-]{1,120}$/.test(media.name)) return media.name;
    const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    return `${media.kind}-${stamp}.${extensionForMime(mimeType, "x.bin")}`;
}

/** Media types each kind may be stored as; anything else (text/html, …) is stored as the kind's default type. */
const ALLOWED_MIME: Record<GeneratedMedia["kind"], readonly string[]> = {
    image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    video: ["video/mp4", "video/webm", "video/quicktime"],
    audio: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/webm"],
};
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function safeMime(kind: GeneratedMedia["kind"], mime: string | undefined): string {
    const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
    return ALLOWED_MIME[kind].includes(base) ? base : FALLBACK_MIME[kind];
}

async function download(fetchFn: typeof globalThis.fetch, url: string, allowLoopback: boolean): Promise<{ bytes: Uint8Array; type: string }> {
    const parsed = new URL(url);
    const loopback = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    if (parsed.protocol !== "https:" && !(loopback && allowLoopback)) throw new Error("Generated media must come over https.");
    const response = await fetchFn(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`The download answered ${response.status}.`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_GENERATED_BYTES) throw new Error("The generated file is too large.");
    const type = response.headers.get("content-type") ?? "";
    if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_GENERATED_BYTES) throw new Error("The generated file is too large.");
        return { bytes, type };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_GENERATED_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error("The generated file is too large.");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes, type };
}

/** The page's probe: an image bitmap, or a video's metadata (8 s timeout); null when it cannot be read here. */
export async function probeMediaSize(file: Blob, kind: GeneratedMedia["kind"]): Promise<{ width: number; height: number } | null> {
    if (kind === "audio" || typeof URL.createObjectURL !== "function") return null;
    if (kind === "image") {
        if (typeof createImageBitmap !== "function") return null;
        const bitmap = await createImageBitmap(file).catch(() => null);
        if (!bitmap) return null;
        const size = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return size;
    }
    if (typeof document === "undefined") return null;
    const url = URL.createObjectURL(file);
    try {
        return await new Promise((resolve) => {
            const video = document.createElement("video");
            const done = (value: { width: number; height: number } | null) => {
                window.clearTimeout(timer);
                video.removeAttribute("src");
                resolve(value);
            };
            const timer = window.setTimeout(() => done(null), 8_000);
            video.preload = "metadata";
            video.muted = true;
            video.onloadedmetadata = () => done(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
            video.onerror = () => done(null);
            video.src = url;
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function createMediaImporter(backend: TimelineBackend & MediaLibraryBackend, options: MediaImporterOptions = {}) {
    const fetchFn = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const now = options.now ?? Date.now;
    return async (media: GeneratedMedia, { projectId }: { projectId: string | null }): Promise<ImportedMedia> => {
        if (!projectId) throw new Error("No project is open.");
        let uploaded: UploadedMedia;
        let size: { width: number; height: number } | null = media.width && media.height ? { width: media.width, height: media.height } : null;
        if (media.url?.startsWith(LOCAL_MEDIA_URL_PREFIX)) {
            const mimeType = safeMime(media.kind, media.mimeType);
            uploaded = { url: media.url, name: nameFor(media, mimeType, now()), size: media.sizeBytes ?? 0, mimeType, ...(media.durationSeconds ? { durationSeconds: media.durationSeconds } : {}) };
        } else {
            let bytes: Uint8Array;
            let type = media.mimeType;
            if (media.bytes) bytes = media.bytes;
            else if (media.url) {
                const downloaded = await download(fetchFn, media.url, options.allowLoopback === true);
                bytes = downloaded.bytes;
                type = downloaded.type || type;
            } else throw new Error("The provider returned media without a file.");
            const mimeType = safeMime(media.kind, type);
            const blob = new Blob([bytes as BlobPart], { type: mimeType });
            const file = new File([blob], nameFor(media, mimeType, now()), { type: mimeType });
            uploaded = await backend.uploadFile(projectId, file, media.kind);
            if (media.durationSeconds) uploaded = { ...uploaded, durationSeconds: media.durationSeconds };
            size = (await (options.probeSize ?? probeMediaSize)(file, media.kind).catch(() => null)) ?? size;
        }
        await backend.saveToLibrary(projectId, uploaded);
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: { projectId } }));
        return {
            url: uploaded.url, name: uploaded.name, mimeType: uploaded.mimeType, sizeBytes: uploaded.size,
            ...(uploaded.durationSeconds ? { durationSeconds: uploaded.durationSeconds } : {}), ...(size ? size : {}),
        };
    };
}
