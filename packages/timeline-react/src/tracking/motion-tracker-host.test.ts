import type { TrackingJob } from "@opennan/timeline-core";
import type { LumaFrame } from "@opennan/timeline-core/tracking/tracker";
import { analysisSize, rgbaToLuma, type DecodedVideo, type TrackingFrameDecoder } from "./frame-decoder";
import { BACKWARD_CHUNK, createMotionTrackerHost, mediaRequestInit } from "./motion-tracker-host";
import { createInlineTrackerChannel, trackerWorkerSource, type TrackerChannel } from "./tracker-worker";

const W = 160;
const H = 90;
const SIDE = 20;

/** The square's centre (px) at media second `t`: moves right and down. */
const centreAt = (t: number) => ({ x: 40 + 30 * t, y: 30 + 12 * t });

/** A textured square over a fixed noise background, 2×2 supersampled. */
function frameAt(t: number): LumaFrame {
    const { x: cx, y: cy } = centreAt(t);
    const data = new Uint8Array(W * H);
    let seed = 12345;
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const bg = 60 + (seed % 40);
            let sum = 0;
            for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
                const u = (x + ox - (cx - SIDE / 2)) / SIDE;
                const v = (y + oy - (cy - SIDE / 2)) / SIDE;
                sum += u >= 0 && u < 1 && v >= 0 && v < 1 ? 130 + 60 * Math.sin(6.3 * u + 1) * Math.cos(5.1 * v) + 40 * Math.sin(9 * u * v) : bg;
            }
            data[y * W + x] = sum / 4;
        }
    }
    return { width: W, height: H, data };
}

interface FakeVideo extends DecodedVideo {
    closed: boolean;
    requests: number[][];
}

function fakeDecoder(options: { failAt?: number; missing?: number[]; onFrame?(t: number): void } = {}): TrackingFrameDecoder & { videos: FakeVideo[]; urls: string[] } {
    const videos: FakeVideo[] = [];
    const urls: string[] = [];
    return {
        videos,
        urls,
        async open(url) {
            urls.push(url);
            const video: FakeVideo = {
                width: 1920, height: 1080, closed: false, requests: [],
                async *frames(times, signal) {
                    video.requests.push([...times]);
                    for (const t of times) {
                        await Promise.resolve();
                        if (signal?.aborted || video.closed) return;
                        if (options.failAt !== undefined && Math.abs(t - options.failAt) < 1e-6) throw new Error("decode failed");
                        options.onFrame?.(t);
                        yield options.missing?.some((m) => Math.abs(m - t) < 1e-6) ? null : frameAt(t);
                    }
                },
                close() {
                    video.closed = true;
                },
            };
            videos.push(video);
            return video;
        },
    };
}

function job(count: number, startIndex: number, fps = 15): TrackingJob {
    const frames = Array.from({ length: count }, (_, k) => ({ time: k / fps, media: k / fps }));
    const c = centreAt(frames[startIndex].media);
    return {
        owner: { clipId: "c" }, mediaUrl: "opennan-local://v.mp4", frames, startIndex, fps,
        region: { x: (c.x - SIDE / 2) / W, y: (c.y - SIDE / 2) / H, width: SIDE / W, height: SIDE / H },
    };
}

function trackedChannel(): { create: () => TrackerChannel; disposed: () => number } {
    let disposed = 0;
    return {
        create: () => {
            const inner = createInlineTrackerChannel();
            return { ...inner, dispose: () => { disposed += 1; inner.dispose(); } };
        },
        disposed: () => disposed,
    };
}

describe("createMotionTrackerHost", () => {
    it("decodes the planned frames, tracks forward and backward in chunks, and reports progress", async () => {
        const decoder = fakeDecoder();
        const channel = trackedChannel();
        const host = createMotionTrackerHost({ media: { resolveMediaUrl: (u) => u.replace("opennan-local://", "blob:") }, decoder, createChannel: channel.create });
        const plan = job(BACKWARD_CHUNK + 20, BACKWARD_CHUNK + 5);
        const progress: number[] = [];
        const outcome = await host.track(plan, { onProgress: (p) => progress.push(p) });
        expect(outcome.error).toBeUndefined();
        expect(decoder.urls).toEqual(["blob:v.mp4"]);
        expect(outcome.source).toEqual({ width: 1920, height: 1080 });
        expect(outcome.samples).toHaveLength(plan.frames.length);
        outcome.samples!.forEach((sample, k) => {
            expect(sample.time).toBe(plan.frames[k].time);
            const c = centreAt(plan.frames[k].media);
            expect(Math.hypot(sample.x * W - c.x, sample.y * H - c.y)).toBeLessThan(0.5);
            expect(sample.lost).toBe(false);
        });
        // Forward from the drawn frame, then two backward chunks, each decoded in ascending order.
        const requests = decoder.videos[0].requests;
        expect(requests[0][0]).toBe(plan.frames[plan.startIndex].media);
        expect(requests.slice(1).map((r) => r.length)).toEqual([BACKWARD_CHUNK, 5]);
        expect(requests[1][0]).toBeLessThan(requests[1][requests[1].length - 1]);
        expect(progress[progress.length - 1]).toBe(1);
        expect(progress.length).toBe(plan.frames.length);
        expect(decoder.videos[0].closed).toBe(true);
        expect(channel.disposed()).toBe(1);
    });

    it("holds the position where a frame cannot be decoded", async () => {
        const plan = job(10, 0);
        const decoder = fakeDecoder({ missing: [plan.frames[4].media] });
        const host = createMotionTrackerHost({ media: { resolveMediaUrl: (u) => u }, decoder, createChannel: createInlineTrackerChannel });
        const outcome = await host.track(plan, {});
        expect(outcome.samples![4]).toMatchObject({ lost: true, confidence: 0, x: outcome.samples![3].x, y: outcome.samples![3].y });
        expect(outcome.samples![6].lost).toBe(false);
    });

    it("cancels: the worker is stopped and the decoder closed", async () => {
        const abort = new AbortController();
        const plan = job(40, 0);
        const decoder = fakeDecoder({ onFrame: (t) => (t > 0.5 ? abort.abort() : undefined) });
        const channel = trackedChannel();
        const host = createMotionTrackerHost({ media: { resolveMediaUrl: (u) => u }, decoder, createChannel: channel.create });
        const outcome = await host.track(plan, { signal: abort.signal });
        expect(outcome).toEqual({ cancelled: true });
        expect(decoder.videos[0].closed).toBe(true);
        expect(channel.disposed()).toBeGreaterThanOrEqual(1);
    });

    it("reports decode errors and unsupported videos, always cleaning up", async () => {
        const plan = job(12, 0);
        const failing = fakeDecoder({ failAt: plan.frames[6].media });
        const channel = trackedChannel();
        const outcome = await createMotionTrackerHost({ media: { resolveMediaUrl: (u) => u }, decoder: failing, createChannel: channel.create }).track(plan, {});
        expect(outcome).toEqual({ error: "decode failed" });
        expect(failing.videos[0].closed).toBe(true);
        expect(channel.disposed()).toBe(1);
        const none = await createMotionTrackerHost({ media: { resolveMediaUrl: (u) => u }, decoder: { open: async () => null } }).track(plan, {});
        expect(none).toMatchObject({ unavailable: true });
        const preAborted = new AbortController();
        preAborted.abort();
        expect(await createMotionTrackerHost({ media: { resolveMediaUrl: (u) => u }, decoder: fakeDecoder() }).track(plan, { signal: preAborted.signal })).toEqual({ cancelled: true });
    });

    it("passes the host's anchors through", () => {
        const host = createMotionTrackerHost({ media: { resolveMediaUrl: (u) => u }, anchors: (ids) => Object.fromEntries(ids.map((id) => [id, { width: 0.1, height: 0.1 }])) });
        expect(host.anchors?.(["a"])).toEqual({ a: { width: 0.1, height: 0.1 } });
    });
});

describe("tracker worker", () => {
    it("runs from its own source text and answers in order", async () => {
        const replies: unknown[] = [];
        const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: unknown): void } = { onmessage: null, postMessage: (m) => replies.push(m) };
        new Function("self", trackerWorkerSource())(scope);
        const c0 = centreAt(0);
        scope.onmessage!({ data: { id: 1, type: "start", pass: "p", frame: frameAt(0), region: { x: (c0.x - 10) / W, y: (c0.y - 10) / H, width: 20 / W, height: 20 / H } } });
        scope.onmessage!({ data: { id: 2, type: "step", pass: "p", frame: frameAt(1 / 15) } });
        scope.onmessage!({ data: { id: 3, type: "step", pass: "missing", frame: frameAt(2 / 15) } });
        expect(replies[0]).toMatchObject({ id: 1, point: { confidence: 1, lost: false } });
        const point = (replies[1] as { point: { x: number; y: number } }).point;
        const c1 = centreAt(1 / 15);
        expect(Math.hypot(point.x * W - c1.x, point.y * H - c1.y)).toBeLessThan(0.5);
        expect(replies[2]).toMatchObject({ id: 3, error: expect.stringMatching(/no tracker/) });
    });

    it("rejects calls after dispose", async () => {
        const channel = createInlineTrackerChannel();
        channel.dispose();
        await expect(channel.step("p", frameAt(0))).rejects.toThrow(/stopped/);
    });
});

describe("analysis frames", () => {
    it("downscales to at most 640×360 and converts RGBA to luma", () => {
        expect(analysisSize(1920, 1080)).toEqual({ width: 640, height: 360 });
        expect(analysisSize(1080, 1920)).toEqual({ width: 203, height: 360 });
        expect(analysisSize(320, 240)).toEqual({ width: 320, height: 240 });
        expect([...rgbaToLuma([255, 255, 255, 255, 255, 0, 0, 255], 2, 1)]).toEqual([255, 54]);
    });
});

describe("mediaRequestInit", () => {
    it("sends auth headers only to the media environment's own origin", async () => {
        const media = { resolveMediaUrl: (u: string) => u, origin: "https://app.test", getAuthHeaders: async () => ({ Authorization: "Bearer x" }) };
        await expect(mediaRequestInit(media, "https://app.test/media/a.mp4")).resolves.toEqual({ credentials: "same-origin", headers: { Authorization: "Bearer x" } });
        await expect(mediaRequestInit(media, "https://cdn.other/a.mp4")).resolves.toEqual({ credentials: "omit" });
        await expect(mediaRequestInit(media, "blob:https://app.test/123")).resolves.toBeUndefined();
    });
});
