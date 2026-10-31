// Story film's copy step in the page: evenly spaced frames of a project video, decoded with mediabunny and tiled four
// across on one JPEG contact sheet, saved to the project's Media and handed to the story writer as a project image.
// One image instead of sixteen: one upload, and the story writer reads the whole video at once.
import type { MediaLibraryBackend, TimelineBackend } from "@opennan/timeline-core";
import { LIBRARY_CHANGED_EVENT } from "./import-generated";

type Mediabunny = typeof import("mediabunny");

export interface StorySheet {
    /** The sheet in the project's Media. */
    url: string;
    frames: number;
    everySeconds: number;
    durationSeconds: number;
}

export interface StorySheetOptions {
    backend: TimelineBackend & MediaLibraryBackend;
    projectId: string;
    resolveMediaUrl(url: string): string;
    loadMediabunny?(): Promise<Mediabunny>;
}

export const SHEET_FRAMES = 16;
const COLUMNS = 4;
const CELL = { width: 480, height: 270 };

/** The source times of `frames` evenly spaced frames: the middle of each equal part of the video. */
export function sheetTimes(durationSeconds: number, frames = SHEET_FRAMES): number[] {
    const step = durationSeconds / frames;
    return Array.from({ length: frames }, (_, i) => Math.min(durationSeconds - 0.001, (i + 0.5) * step));
}

/** Makes the contact sheet of a project video (null when the browser cannot decode it). */
export function createStorySheet(options: StorySheetOptions): (mediaUrl: string, signal?: AbortSignal) => Promise<StorySheet | null> {
    const load = options.loadMediabunny ?? (() => import("mediabunny"));
    return async (mediaUrl, signal) => {
        const mb = await load();
        const input = new mb.Input({ source: new mb.UrlSource(options.resolveMediaUrl(mediaUrl)), formats: mb.ALL_FORMATS });
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track || !(await track.canDecode())) return null;
            const duration = await input.computeDuration();
            if (!(duration > 0)) return null;
            const times = sheetTimes(duration);
            const rows = Math.ceil(times.length / COLUMNS);
            const sheet = new OffscreenCanvas(CELL.width * COLUMNS, CELL.height * rows);
            const ctx = sheet.getContext("2d");
            if (!ctx) return null;
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, sheet.width, sheet.height);
            const sink = new mb.CanvasSink(track, { poolSize: 1 });
            for (const [i, time] of times.entries()) {
                if (signal?.aborted) return null;
                const wrapped = await sink.getCanvas(time);
                if (!wrapped) continue;
                const frame = wrapped.canvas as HTMLCanvasElement | OffscreenCanvas;
                // Letterboxed into its cell, whatever the video's shape.
                const scale = Math.min(CELL.width / frame.width, CELL.height / frame.height);
                const w = frame.width * scale;
                const h = frame.height * scale;
                const x = (i % COLUMNS) * CELL.width + (CELL.width - w) / 2;
                const y = Math.floor(i / COLUMNS) * CELL.height + (CELL.height - h) / 2;
                ctx.drawImage(frame, x, y, w, h);
            }
            const blob = await sheet.convertToBlob({ type: "image/jpeg", quality: 0.85 });
            const file = new File([blob], "story-frames.jpg", { type: "image/jpeg" });
            const uploaded = await options.backend.uploadFile(options.projectId, file, "image");
            await options.backend.saveToLibrary(options.projectId, uploaded);
            window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: { projectId: options.projectId } }));
            return { url: uploaded.url, frames: times.length, everySeconds: duration / times.length, durationSeconds: duration };
        } finally {
            input.dispose?.();
        }
    };
}
