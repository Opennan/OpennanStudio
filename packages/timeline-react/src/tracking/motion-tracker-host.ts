// The browser's MotionTrackerHost (phase 10d): decodes the frames a `tracking.run` planned (frame-decoder.ts) and
// tracks them in a worker (tracker-worker.ts) — forward from the drawn frame to the end, then backward to the first
// frame in chunks (decoders read forward, so each chunk is decoded in order and fed in reverse). At most a few
// frames are in flight at once. Cancel (the signal) or any error terminates the worker and closes the decoder.
import type { MotionTrackerHost, SourceSize, TrackingJob, TrackingJobContext, TrackingJobOutcome, TrackSample } from "@opennan/timeline-core";
import type { LumaFrame, TrackPoint } from "@opennan/timeline-core/tracking/tracker";
import type { MediaEnvironment } from "@opennan/timeline-media";
import { mediabunnyFrameDecoder, type TrackingFrameDecoder } from "./frame-decoder";
import { createDefaultTrackerChannel, type TrackerChannel } from "./tracker-worker";

export interface MotionTrackerHostOptions {
    media: Pick<MediaEnvironment, "resolveMediaUrl"> & Partial<Pick<MediaEnvironment, "getAuthHeaders" | "origin">>;
    decoder?: TrackingFrameDecoder;
    createChannel?: () => TrackerChannel;
    /** Clip boxes the host laid out (the preview's overlay geometry), for tracking.apply. */
    anchors?(clipIds: string[]): Record<string, SourceSize | undefined>;
}

/** Frames decoded per backward chunk (memory: one chunk of analysis-size luma frames). */
export const BACKWARD_CHUNK = 30;
/** Frames sent to the worker before waiting for its answers. */
const IN_FLIGHT = 4;

class Cancelled extends Error {}

/** Request options for the clip's media: auth headers only for the media environment's own origin (as the export). */
export async function mediaRequestInit(media: MotionTrackerHostOptions["media"], url: string): Promise<RequestInit | undefined> {
    const home = media.origin ?? (typeof location !== "undefined" ? location.origin : undefined);
    let target: URL;
    try {
        target = new URL(url, home);
    } catch {
        return undefined;
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") return undefined;
    const own = Boolean(home) && target.origin === home;
    const headers = own && media.getAuthHeaders ? await media.getAuthHeaders() : undefined;
    return { credentials: own ? "same-origin" : "omit", ...(headers ? { headers } : {}) };
}

const copyFrame = (frame: LumaFrame): LumaFrame => ({ width: frame.width, height: frame.height, data: Uint8Array.from(frame.data) });

export function createMotionTrackerHost(options: MotionTrackerHostOptions): MotionTrackerHost {
    const decoder = options.decoder ?? mediabunnyFrameDecoder;
    const createChannel = options.createChannel ?? createDefaultTrackerChannel;
    return {
        anchors: options.anchors,
        async track(job: TrackingJob, context: TrackingJobContext): Promise<TrackingJobOutcome> {
            const { signal } = context;
            if (signal?.aborted) return { cancelled: true };
            let video;
            try {
                const url = options.media.resolveMediaUrl(job.mediaUrl);
                video = await decoder.open(url, await mediaRequestInit(options.media, url));
            } catch (error) {
                return { error: `could not open the video: ${error instanceof Error ? error.message : String(error)}` };
            }
            if (!video) return { unavailable: true, error: "this browser cannot decode the clip's video for tracking" };
            const channel = createChannel();
            const stop = () => {
                channel.dispose();
                video.close();
            };
            if (signal?.aborted) {
                stop();
                return { cancelled: true };
            }
            signal?.addEventListener("abort", stop, { once: true });
            const total = job.frames.length;
            const samples: TrackSample[] = new Array(total);
            let done = 0;
            const report = () => context.onProgress?.(total > 0 ? done / total : 1);
            const record = (index: number, point: TrackPoint) => {
                samples[index] = { time: job.frames[index].time, ...point };
                done += 1;
                report();
            };
            /** A frame the decoder could not produce holds the previous position (lost). */
            const hold = (index: number, from: number) => record(index, { ...(samples[from] ?? { x: 0, y: 0 }), confidence: 0, lost: true });
            const check = () => {
                if (signal?.aborted) throw new Cancelled();
            };
            try {
                const start = job.startIndex;
                // Forward: the drawn frame starts both passes.
                let startFrame: LumaFrame | null = null;
                const forward = job.frames.slice(start).map((f) => f.media);
                let index = start;
                const inFlight: Array<Promise<void>> = [];
                for await (const frame of video.frames(forward, signal)) {
                    check();
                    const i = index++;
                    if (i === start) {
                        if (!frame) throw new Error("the drawn frame could not be decoded");
                        startFrame = copyFrame(frame);
                        record(i, await channel.start("forward", frame, job.region, job.options));
                        continue;
                    }
                    if (!frame) {
                        await Promise.all(inFlight.splice(0));
                        hold(i, i - 1);
                        continue;
                    }
                    const stepped = channel.step("forward", frame).then((point) => record(i, point));
                    // Awaited below; the guard only keeps a rejection after a stop from being reported as unhandled.
                    stepped.catch(() => undefined);
                    inFlight.push(stepped);
                    if (inFlight.length >= IN_FLIGHT) await inFlight.shift();
                }
                await Promise.all(inFlight.splice(0));
                check();
                if (!startFrame) throw new Error("the drawn frame could not be decoded");
                for (let i = start + 1; i < total; i += 1) if (!samples[i]) hold(i, i - 1);
                // Backward, chunk by chunk from the drawn frame towards the first one.
                if (start > 0) {
                    await channel.start("backward", startFrame, job.region, job.options);
                    for (let end = start; end > 0; end -= BACKWARD_CHUNK) {
                        const from = Math.max(0, end - BACKWARD_CHUNK);
                        const chunk: Array<LumaFrame | null> = [];
                        for await (const frame of video.frames(job.frames.slice(from, end).map((f) => f.media), signal)) {
                            check();
                            chunk.push(frame);
                        }
                        check();
                        for (let i = end - 1; i >= from; i -= 1) {
                            const frame = chunk[i - from];
                            if (frame) record(i, await channel.step("backward", frame));
                            else hold(i, i + 1);
                            check();
                        }
                    }
                }
                return { samples, source: { width: video.width, height: video.height } };
            } catch (error) {
                if (error instanceof Cancelled || signal?.aborted) return { cancelled: true };
                return { error: error instanceof Error ? error.message : String(error) };
            } finally {
                signal?.removeEventListener("abort", stop);
                stop();
            }
        },
    };
}
