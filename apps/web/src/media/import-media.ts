// Local media import: store the blob through MediaLibraryBackend.uploadFile (opennan-local://
// URL, spec §6; the Blob itself goes to IndexedDB, never a copy of its bytes), probe its
// duration, and add it to the project's media bin.
import type { MediaKind, MediaLibraryBackend, UploadedMedia } from "@opennan/timeline-core";
import { storageErrorMessage, isQuotaExceeded, type StorageUsage } from "../platform/storage";
import { errorMessage, formatBytes } from "../ui/format";
import { MAX_MEDIA_BYTES, mediaKindOf, mediaKindOfItem } from "./media-kind";

export interface MediaProbe {
    durationSeconds?: number;
}

export type ProbeMedia = (media: Blob, kind: MediaKind) => Promise<MediaProbe>;

export interface ImportResult {
    imported: UploadedMedia[];
    rejected: Array<{ name: string; reason: string }>;
}

export type LibraryBackend = Pick<MediaLibraryBackend, "uploadFile" | "saveToLibrary">;

export interface ImportOptions {
    signal?: AbortSignal;
    /** MAX_MEDIA_BYTES by default. */
    maxBytes?: number;
    /** StorageGuard.estimate, read only to explain a QuotaExceededError. */
    estimate?(): Promise<StorageUsage | null>;
}

export async function importMediaFiles(
    backend: LibraryBackend,
    projectId: string,
    files: Iterable<File>,
    probe: ProbeMedia,
    options: ImportOptions = {},
): Promise<ImportResult> {
    const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
    const result: ImportResult = { imported: [], rejected: [] };
    for (const file of files) {
        const kind = mediaKindOf(file);
        if (!kind) {
            result.rejected.push({ name: file.name, reason: "Unsupported file type" });
            continue;
        }
        if (file.size > maxBytes) {
            result.rejected.push({ name: file.name, reason: `Larger than ${formatBytes(maxBytes)}, the editor's limit per file` });
            continue;
        }
        try {
            const uploaded = await backend.uploadFile(projectId, file, kind, { signal: options.signal });
            const probed = await probe(file, kind).catch((): MediaProbe => ({}));
            const media: UploadedMedia = {
                ...uploaded,
                name: file.name,
                ...(probed.durationSeconds && probed.durationSeconds > 0 ? { durationSeconds: probed.durationSeconds } : {}),
            };
            await backend.saveToLibrary(projectId, media);
            result.imported.push(media);
        } catch (error) {
            if (options.signal?.aborted) throw error;
            const usage = isQuotaExceeded(error) ? await options.estimate?.().catch(() => null) ?? null : null;
            result.rejected.push({ name: file.name, reason: storageErrorMessage(error, usage) ?? errorMessage(error) });
        }
    }
    return result;
}

/**
 * Media the timeline uploaded by itself (its scene and audio pickers) arrives without a
 * duration (packages/timeline-react/src/timeline/adapters.ts:198-201). Probe the stored
 * blob so the bin shows the length and "Add to timeline" places the real duration.
 */
export async function completeMediaDuration(
    backend: Pick<MediaLibraryBackend, "readMedia">,
    media: UploadedMedia,
    probe: ProbeMedia,
): Promise<UploadedMedia> {
    const kind = mediaKindOfItem(media);
    if (media.durationSeconds || (kind !== "video" && kind !== "audio")) return media;
    const blob = await backend.readMedia(media.url).catch(() => null);
    if (!blob) return media;
    const probed = await probe(blob, kind).catch((): MediaProbe => ({}));
    return probed.durationSeconds && probed.durationSeconds > 0 ? { ...media, durationSeconds: probed.durationSeconds } : media;
}
