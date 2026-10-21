// Analysis frames for motion tracking (phase 10d): the tracked item's video decoded with mediabunny (WebCodecs, the
// same path as the timeline thumbnails) at the requested media times, downscaled to at most 640×360 and converted
// to luma. Decoding runs on the page (media URLs such as opennan-media:// and blob: resolve there); the tracker runs
// in a worker. close() disposes the input and its decoders.
import type { LumaFrame } from "@opennan/timeline-core/tracking/tracker";

export const ANALYSIS_MAX_HEIGHT = 360;
export const ANALYSIS_MAX_WIDTH = 640;

export interface DecodedVideo {
    /** The video's display size in pixels. */
    width: number;
    height: number;
    /** Luma frames at `times` (media seconds, ascending), in order; null where no frame exists. */
    frames(times: readonly number[], signal?: AbortSignal): AsyncIterable<LumaFrame | null>;
    close(): void;
}

export interface TrackingFrameDecoder {
    /** The video at `url` (already resolved), or null when this browser cannot decode it. `init`: request options (auth). */
    open(url: string, init?: RequestInit): Promise<DecodedVideo | null>;
}

/** The analysis size of a `width × height` video: at most 640×360, aspect kept, at least 1 px. */
export function analysisSize(width: number, height: number): { width: number; height: number } {
    const scale = Math.min(1, ANALYSIS_MAX_HEIGHT / Math.max(1, height), ANALYSIS_MAX_WIDTH / Math.max(1, width));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** BT.709 luma of RGBA pixels. */
export function rgbaToLuma(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < out.length; i += 1, j += 4) out[i] = (rgba[j] * 0.2126 + rgba[j + 1] * 0.7152 + rgba[j + 2] * 0.0722 + 0.5) | 0;
    return out;
}

export function isTrackingDecodeSupported(): boolean {
    return typeof VideoDecoder !== "undefined" && (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined")
        && (typeof window === "undefined" || window.isSecureContext !== false);
}

type Surface = { ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D };

function createSurface(width: number, height: number): Surface | null {
    if (typeof OffscreenCanvas !== "undefined") {
        const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
        if (ctx) return { ctx };
    }
    if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) return { ctx };
    }
    return null;
}

/** mediabunny: one Input per open(), VideoSampleSink over the primary video track. */
export const mediabunnyFrameDecoder: TrackingFrameDecoder = {
    async open(url, init) {
        if (!isTrackingDecodeSupported()) return null;
        const mb = await import("mediabunny");
        const input = new mb.Input({ source: new mb.UrlSource(url, init ? { requestInit: init } : undefined), formats: mb.ALL_FORMATS });
        try {
            const track = await input.getPrimaryVideoTrack();
            if (!track || !(await track.canDecode())) {
                input.dispose();
                return null;
            }
            const width = track.displayWidth;
            const height = track.displayHeight;
            const size = analysisSize(width, height);
            const surface = createSurface(size.width, size.height);
            if (!surface) {
                input.dispose();
                return null;
            }
            const sink = new mb.VideoSampleSink(track);
            let closed = false;
            return {
                width,
                height,
                async *frames(times, signal) {
                    for await (const sample of sink.samplesAtTimestamps([...times])) {
                        if (closed || signal?.aborted) {
                            sample?.close();
                            return;
                        }
                        if (!sample) {
                            yield null;
                            continue;
                        }
                        try {
                            surface.ctx.clearRect(0, 0, size.width, size.height);
                            sample.draw(surface.ctx, 0, 0, size.width, size.height);
                        } finally {
                            sample.close();
                        }
                        const pixels = surface.ctx.getImageData(0, 0, size.width, size.height).data;
                        yield { width: size.width, height: size.height, data: rgbaToLuma(pixels, size.width, size.height) };
                    }
                },
                close() {
                    if (closed) return;
                    closed = true;
                    input.dispose();
                },
            };
        } catch (error) {
            input.dispose();
            throw error;
        }
    },
};
