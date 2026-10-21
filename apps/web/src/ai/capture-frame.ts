// "From this frame" (phase 11): the still under the playhead, decoded from the video item there, saved to the project's
// Media as a PNG and handed to image-to-video as a project image (a MediaSourceRef the provider prepares and uploads).
import type { MediaSourceRef } from "@opennan/provider-sdk";
import { aiMediaSource, timelineToSource, type AiTargetRef, type ControllerSnapshot, type MediaLibraryBackend, type TimelineBackend } from "@opennan/timeline-core";

type Mediabunny = typeof import("mediabunny");

/** The video item whose frame is under the playhead: the selection when it is a video, else the topmost video there. */
export function frameTarget(snapshot: ControllerSnapshot): { target: AiTargetRef; sourceSeconds: number; mediaUrl: string } | null {
    const at = snapshot.currentTime;
    const candidates: AiTargetRef[] = [];
    for (const id of snapshot.selection.clipIds) candidates.push({ clipId: id });
    if (snapshot.selection.sceneId) candidates.push({ sceneId: snapshot.selection.sceneId });
    const clips = snapshot.clips
        .filter((c) => c.trackType === "video" && c.startTime <= at && at < c.endTime)
        .sort((a, b) => b.trackIndex - a.trackIndex);
    for (const clip of clips) candidates.push({ clipId: clip.id });
    for (const scene of [...snapshot.scenes].sort((a, b) => (b.trackIndex ?? 1) - (a.trackIndex ?? 1))) candidates.push({ sceneId: scene.id });
    for (const target of candidates) {
        const source = aiMediaSource(snapshot, target);
        if (!source || source.kind !== "video") continue;
        if (at < source.timelineStart || at >= source.timelineEnd) continue;
        const sourceSeconds = Math.min(source.endSeconds, Math.max(source.startSeconds, timelineToSource(source, at)));
        return { target, sourceSeconds, mediaUrl: source.mediaUrl };
    }
    return null;
}

export interface FrameCaptureOptions {
    snapshot(): ControllerSnapshot;
    backend: TimelineBackend & MediaLibraryBackend;
    projectId: string;
    resolveMediaUrl(url: string): string;
    loadMediabunny?(): Promise<Mediabunny>;
}

/** Decodes the frame, stores it in Media, and returns it as a project image (null when no video is under the playhead). */
export function createFrameCapture(options: FrameCaptureOptions): () => Promise<MediaSourceRef | null> {
    const load = options.loadMediabunny ?? (() => import("mediabunny"));
    return async () => {
        const found = frameTarget(options.snapshot());
        if (!found) return null;
        const mb = await load();
        const input = new mb.Input({ source: new mb.UrlSource(options.resolveMediaUrl(found.mediaUrl)), formats: mb.ALL_FORMATS });
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track || !(await track.canDecode())) return null;
            const sink = new mb.CanvasSink(track, { poolSize: 1 });
            const wrapped = await sink.getCanvas(found.sourceSeconds);
            if (!wrapped) return null;
            const canvas = wrapped.canvas as HTMLCanvasElement | OffscreenCanvas;
            const blob = "convertToBlob" in canvas
                ? await canvas.convertToBlob({ type: "image/png" })
                : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("The frame could not be encoded."))), "image/png"));
            const file = new File([blob], `frame-${found.sourceSeconds.toFixed(2).replace(".", "_")}s.png`, { type: "image/png" });
            const uploaded = await options.backend.uploadFile(options.projectId, file, "image");
            await options.backend.saveToLibrary(options.projectId, uploaded);
            return { mediaUrl: uploaded.url };
        } finally {
            input.dispose?.();
        }
    };
}
