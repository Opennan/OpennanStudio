// Export and share's upload step on the web (phase 9c): the export's file — a Blob in memory, or the export streamed to
// the origin's private file system — hashed off the main thread and uploaded with the project's id through the cloud
// media upload (deduplicated, one PUT or parts, single-use links; the key goes only to the API). The disk file is let
// go once it is uploaded (or the upload failed). WebM exports (no H.264 encoder) are uploaded as WebM.
import { CloudApiError, cloudContentType, uploadBlob, type CloudApi } from "@opennan/cloud-backend";
import type { ExportResult } from "@opennan/export";
import { exportBlob } from "../export/web-export";

export interface ExportUploadOptions {
    /** The signed-in account's API client (null while signed out). */
    api(): CloudApi | null;
    fetch?: typeof globalThis.fetch;
    hash(blob: Blob, signal?: AbortSignal): Promise<string>;
    /** Removes an export written to the origin's private file system. */
    removeFile?(name: string): Promise<void>;
    /** The project's name, for the file name. */
    name?(): string;
    allowedHosts?: readonly string[];
}

const EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

function fileName(name: string, mimeType: string): string {
    const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 80) || "export";
    return `${clean}.${EXTENSIONS[mimeType] ?? "mp4"}`;
}

export function createExportUpload(options: ExportUploadOptions) {
    return async (result: ExportResult, serverId: string, run: { signal: AbortSignal; onProgress(ratio: number): void; name?: string }): Promise<{ mediaUrl: string }> => {
        const opfsName = result.output.kind === "blob" && "opfsName" in result.output ? (result.output as { opfsName?: string }).opfsName : undefined;
        try {
            const api = options.api();
            if (!api) throw new CloudApiError(401, "signed_out", "Sign in with OpenNan to share.");
            const blob = exportBlob(result);
            const type = cloudContentType(result.mimeType, blob.size);
            if ("refused" in type) throw new Error(`OpenNan can't hold this export (${result.mimeType}).`);
            const sha256 = await options.hash(blob, run.signal);
            run.onProgress(0);
            const uploaded = await uploadBlob(api, options.fetch ?? ((input, init) => globalThis.fetch(input, init)), blob, {
                filename: fileName(run.name ?? options.name?.() ?? "", type.contentType), contentType: type.contentType, sizeBytes: blob.size, sha256, projectId: serverId,
            }, { signal: run.signal, onProgress: (sent) => run.onProgress(blob.size > 0 ? sent / blob.size : 1), ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}) });
            run.onProgress(1);
            return { mediaUrl: uploaded.mediaUrl };
        } finally {
            if (opfsName) void options.removeFile?.(opfsName).catch(() => undefined);
        }
    };
}
