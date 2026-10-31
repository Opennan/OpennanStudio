// Story film's "Remake from your video" in the page: the copied video's shots are found here (frames decoded small with
// mediabunny, each compared with the one before; @opennan/story-film turns the differences into cuts and shots of
// 2-15 s), and each shot is cut out as its own project video, the clip a remake sends as its reference.
import { findCuts, splitShots, type ShotRange } from "@opennan/story-film";
import type { MediaLibraryBackend, TimelineBackend } from "@opennan/timeline-core";
import { LIBRARY_CHANGED_EVENT } from "./import-generated";

type Mediabunny = typeof import("mediabunny");

export interface StoryShotsOptions {
    backend: TimelineBackend & MediaLibraryBackend;
    projectId: string;
    resolveMediaUrl(url: string): string;
    loadMediabunny?(): Promise<Mediabunny>;
}

export interface FoundShots {
    durationSeconds: number;
    shots: ShotRange[];
    /** The video had more shots than a story holds: the rest was left out. */
    truncated: boolean;
}

/** Frames compared per second (fewer on a long video: at most MAX_SAMPLES in all). */
const SAMPLE_FPS = 6;
const MAX_SAMPLES = 1500;
const THUMB = { width: 48, height: 27 };

/** How much two small RGBA frames differ: the mean change of each colour, 0..1. */
export function frameDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
    let sum = 0;
    let count = 0;
    for (let i = 0; i + 3 < a.length && i + 3 < b.length; i += 4) {
        sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
        count += 3;
    }
    return count > 0 ? sum / count / 255 : 0;
}

/** The sample times of a video of this length. */
export function sampleTimes(durationSeconds: number): number[] {
    const fps = Math.min(SAMPLE_FPS, MAX_SAMPLES / Math.max(durationSeconds, 1e-3));
    const count = Math.max(2, Math.floor(durationSeconds * fps));
    return Array.from({ length: count }, (_, i) => Math.min(durationSeconds - 0.001, i / fps));
}

export function createStoryShots(options: StoryShotsOptions) {
    const load = options.loadMediabunny ?? (() => import("mediabunny"));

    /** The video's shots (null when the browser cannot decode it). */
    async function find(mediaUrl: string, signal?: AbortSignal): Promise<FoundShots | null> {
        const mb = await load();
        const input = new mb.Input({ source: new mb.UrlSource(options.resolveMediaUrl(mediaUrl)), formats: mb.ALL_FORMATS });
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track || !(await track.canDecode())) return null;
            const duration = await input.computeDuration();
            if (!(duration > 0)) return null;
            const times = sampleTimes(duration);
            const canvas = new OffscreenCanvas(THUMB.width, THUMB.height);
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return null;
            const sink = new mb.CanvasSink(track, { width: THUMB.width, height: THUMB.height, fit: "fill", poolSize: 1 });
            const diffs: number[] = [];
            let previous: Uint8ClampedArray | null = null;
            for await (const wrapped of sink.canvasesAtTimestamps(times)) {
                if (signal?.aborted) return null;
                if (!wrapped) {
                    diffs.push(0);
                    continue;
                }
                ctx.drawImage(wrapped.canvas as OffscreenCanvas, 0, 0, THUMB.width, THUMB.height);
                const pixels = ctx.getImageData(0, 0, THUMB.width, THUMB.height).data;
                diffs.push(previous ? frameDifference(previous, pixels) : 0);
                previous = new Uint8ClampedArray(pixels);
            }
            const split = splitShots(findCuts(times, diffs), duration);
            return { durationSeconds: duration, ...split };
        } finally {
            input.dispose?.();
        }
    }

    /**
     * Each shot cut out of the video as its own project video ("story-shot-01.mp4"), in order: H.264 MP4 where the
     * browser encodes it (else VP9 WebM; the remake prepares an MP4 again when it sends one), no sound.
     */
    async function cut(mediaUrl: string, shots: readonly ShotRange[], signal?: AbortSignal, onShot?: (index: number) => void): Promise<string[]> {
        const mb = await load();
        const urls: string[] = [];
        for (const [index, shot] of shots.entries()) {
            if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
            onShot?.(index);
            const input = new mb.Input({ source: new mb.UrlSource(options.resolveMediaUrl(mediaUrl)), formats: mb.ALL_FORMATS });
            try {
                const mp4 = await mb.canEncodeVideo("avc");
                const target = new mb.BufferTarget();
                const output = new mb.Output({ format: mp4 ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(), target });
                const conversion = await mb.Conversion.init({
                    input, output, trim: { start: shot.start, end: shot.end }, showWarnings: false,
                    video: { codec: mp4 ? "avc" : "vp9", bitrate: mb.QUALITY_HIGH, forceTranscode: true }, audio: { discard: true },
                } as Parameters<Mediabunny["Conversion"]["init"]>[0]);
                if (!conversion.isValid) throw new Error("This browser cannot cut this video into shots.");
                const stop = () => void conversion.cancel();
                signal?.addEventListener("abort", stop, { once: true });
                try {
                    await conversion.execute();
                } finally {
                    signal?.removeEventListener("abort", stop);
                }
                if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
                if (!target.buffer) throw new Error("A shot came out empty.");
                const type = mp4 ? "video/mp4" : "video/webm";
                const file = new File([target.buffer], `story-shot-${String(index + 1).padStart(2, "0")}.${mp4 ? "mp4" : "webm"}`, { type });
                const uploaded = await options.backend.uploadFile(options.projectId, file, "video");
                await options.backend.saveToLibrary(options.projectId, uploaded);
                urls.push(uploaded.url);
            } finally {
                input.dispose?.();
            }
        }
        window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED_EVENT, { detail: { projectId: options.projectId } }));
        return urls;
    }

    return { find, cut };
}

export type StoryShots = ReturnType<typeof createStoryShots>;
