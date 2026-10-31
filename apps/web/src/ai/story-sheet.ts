// Story film's copy step in the page: evenly spaced frames of a project video (or, once its shots are found, a few
// frames of each shot, labelled with the shot's number), decoded with mediabunny and tiled four across on one JPEG
// contact sheet, saved to the project's Media and handed to the story writer as a project image.
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

/** Frames to sample at chosen times (a copied video's shots: `shot` is the 0-based shot each frame shows, written on it). */
export type SheetFrames = ReadonlyArray<{ time: number; shot: number }>;

/** Makes the contact sheet of a project video (null when the browser cannot decode it); with `frames`, those frames, labelled by shot. */
export function createStorySheet(options: StorySheetOptions): (mediaUrl: string, signal?: AbortSignal, frames?: SheetFrames) => Promise<StorySheet | null> {
    const load = options.loadMediabunny ?? (() => import("mediabunny"));
    return async (mediaUrl, signal, frames) => {
        const mb = await load();
        const input = new mb.Input({ source: new mb.UrlSource(options.resolveMediaUrl(mediaUrl)), formats: mb.ALL_FORMATS });
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track || !(await track.canDecode())) return null;
            const duration = await input.computeDuration();
            if (!(duration > 0)) return null;
            const picked = frames && frames.length > 0 ? frames : null;
            const times = picked ? picked.map((f) => Math.min(duration - 0.001, Math.max(0, f.time))) : sheetTimes(duration);
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
                const shot = picked?.[i]?.shot;
                if (shot !== undefined) {
                    // "S3": the story writer lines its shots up with the real ones.
                    const label = `S${shot + 1}`;
                    const cx = (i % COLUMNS) * CELL.width + 8;
                    const cy = Math.floor(i / COLUMNS) * CELL.height + 8;
                    ctx.font = "bold 28px sans-serif";
                    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
                    ctx.fillRect(cx, cy, ctx.measureText(label).width + 16, 38);
                    ctx.fillStyle = "#fff";
                    ctx.textBaseline = "top";
                    ctx.fillText(label, cx + 8, cy + 5);
                }
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
