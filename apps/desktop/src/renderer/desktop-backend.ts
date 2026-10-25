// LocalBackend for the desktop renderer: the same in-memory model, undo history, and catalog as the web app
// (spec §6), with two media differences. uploadFile gives main the file (its path when it has one; bytes
// otherwise) and main copies it into the media library, probing its duration; readMedia answers null
// because media files are read by main (export, probes), never streamed back into the renderer.
import { LocalBackend, type LocalBackendOptions, type MediaKind, type UploadOptions, type UploadedMedia } from "@opennan/timeline-core";
import type { DesktopBridge } from "../shared/bridge";

export class DesktopBackend extends LocalBackend {
    constructor(options: LocalBackendOptions, private readonly bridge: Pick<DesktopBridge, "media">) {
        super(options);
    }

    override async uploadFile(projectId: string, file: Blob, kind: MediaKind, options: UploadOptions = {}): Promise<UploadedMedia> {
        if (options.signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
        await this.loadProject(projectId);
        const media = await this.bridge.media.import(projectId, file as File, kind);
        options.onProgress?.(100);
        return media;
    }

    override async readMedia(_url: string): Promise<Blob | null> {
        return null;
    }
}
