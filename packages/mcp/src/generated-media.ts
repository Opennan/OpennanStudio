// Headless `mcp serve`: generated media (createAiRunner's importMedia) goes into the project's media folder through
// LocalBackend, like an import, and into its library. Links go through provider-sdk's downloadMedia (https only,
// redirects re-checked, no private addresses, no credentials, 512 MB, timeout; loopback only for the tests' fake).
import { downloadMedia, type GeneratedMedia, type ImportedMedia } from "@opennan/provider-sdk";
import type { LocalBackend } from "@opennan/timeline-core";

export const MAX_GENERATED_BYTES = 512 * 1024 * 1024;
const FALLBACK_MIME: Record<GeneratedMedia["kind"], string> = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" };
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg" };

export function createHeadlessMediaImporter(backend: Pick<LocalBackend, "uploadFile" | "saveToLibrary">, options: { fetch?: typeof globalThis.fetch; allowLoopback?: boolean; now?(): number } = {}) {
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const now = options.now ?? Date.now;
    return async (media: GeneratedMedia, { projectId }: { projectId: string | null }): Promise<ImportedMedia> => {
        if (!projectId) throw new Error("No project is open.");
        let bytes: Uint8Array;
        let mimeType = media.mimeType ?? "";
        if (media.bytes) bytes = media.bytes;
        else if (media.url) {
            const downloaded = await downloadMedia(media.url, { fetch: doFetch, allowLoopback: options.allowLoopback, maxBytes: MAX_GENERATED_BYTES });
            bytes = downloaded.bytes;
            mimeType = downloaded.mimeType || mimeType;
        } else throw new Error("The provider returned media without a file.");
        if (!EXT[mimeType]) mimeType = FALLBACK_MIME[media.kind];
        const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
        const file = new File([bytes as BlobPart], `${media.kind}-${stamp}.${EXT[mimeType]}`, { type: mimeType });
        const uploaded = await backend.uploadFile(projectId, file, media.kind);
        await backend.saveToLibrary(projectId, uploaded);
        return { url: uploaded.url, name: uploaded.name, mimeType: uploaded.mimeType, sizeBytes: uploaded.size };
    };
}
