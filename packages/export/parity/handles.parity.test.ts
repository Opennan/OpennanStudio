// Live transition handles and upper-track clip lanes (phase 10b): compiled export graphs run on native ffmpeg and
// ffmpeg.wasm, and every sampled window frame matches the JS reference built from the frames the window should
// show — real media past the cut where the media has it, the held last / first frame for the rest — within the
// YUV 4:2:0 round trip error (as compile.parity.test.ts). The media is a moving pattern (every frame differs a
// lot from its neighbours), so a window showing the frozen frame instead of the live one fails.
import { describe, expect, it } from "vitest";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { renderTransitionReference, type RawFrame } from "@opennan/timeline-core/looks/reference";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import { compileExport } from "../src/compile";
import { clip, input, scene } from "../src/compile/test-helpers";
import type { MediaInfo } from "../src/types";
import { ffmpegHosts, type FfmpegHost } from "./ffmpeg";
import { compareFrames, splitFrames } from "./frames";
import { runPlanVideo } from "./plan-runner";

const hosts = await ffmpegHosts();
const FPS = 30;
// 5:1 at 720p is 1280×256: the media fills the frame (scenes fit 1:1; clips at scale 1.5 × frameScale 2/3).
const W = 1280;
const H = 256;
const FRAMES = 40;
const URL = "/m/v.nut";
const MEDIA: MediaInfo = { durationSeconds: FRAMES / FPS, hasVideo: true, hasAudio: false, width: W, height: H };
const STILL: MediaInfo = { durationSeconds: 0, hasVideo: true, hasAudio: false, width: W, height: H };
const wipe = transitionById("wipe_left")!;

/** Media frame f: a pattern that moves 37 px (red) and 29 px (blue) per frame over a vertical green ramp. */
function mediaFrame(f: number, channels: 3 | 4 = 3): RawFrame {
    const data = new Uint8Array(W * H * channels);
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const o = (y * W + x) * channels;
            data[o] = Math.round(128 + 100 * Math.sin((x + 37 * f) / 23));
            data[o + 1] = Math.round(40 + 170 * (y / H));
            data[o + 2] = Math.round(128 + 90 * Math.cos((0.7 * x - 29 * f) / 31));
            if (channels === 4) data[o + 3] = 255;
        }
    }
    return { width: W, height: H, channels, data };
}

const frameCache = new Map<number, RawFrame>();
const frameAt = (f: number) => {
    let frame = frameCache.get(f);
    if (!frame) frameCache.set(f, (frame = mediaFrame(f)));
    return frame;
};

const encoded = new Map<FfmpegHost, Promise<Uint8Array>>();
/** The media as NUT/rawvideo yuv420p (every frame a keyframe), encoded by the host under test. */
function nutMedia(host: FfmpegHost): Promise<Uint8Array> {
    let media = encoded.get(host);
    if (!media) {
        const raw = new Uint8Array(W * H * 3 * FRAMES);
        for (let f = 0; f < FRAMES; f += 1) raw.set(frameAt(f).data, f * W * H * 3);
        media = host.run({
            files: { "in.rgb": raw },
            args: ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-framerate", String(FPS), "-i", "in.rgb", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "v.nut"],
            outputName: "v.nut",
        });
        encoded.set(host, media);
    }
    return media;
}

/** Window frames 9..20 (half = 0.2 s = 6 frames each side of the cut at frame 15): CapCut progress. */
const progress = (k: number) => (k - 9) / 12;
const trims = (start: number, end: number, content: number) => JSON.stringify({ timelineTrimStart: start, timelineTrimEnd: end, timelineSourceDuration: content });
const project = { aspectRatio: "5:1", musicUrl: null, musicVolume: 1 };
// Every frame: pieces, windows, and the frames around each cut.
const SAMPLES = Array.from({ length: 30 }, (_, k) => k);

/**
 * `meanLimit`: 2.5 levels as compile.parity.test.ts for scene lanes; clip layers also go through RGBA (as the
 * per-clip overlay path always has), which adds about half a level on ffmpeg.wasm.
 */
function expectFrames(frames: Uint8Array[], expected: (k: number) => RawFrame, frozen: (k: number) => RawFrame | null, meanLimit = 2.5): void {
    expect(frames).toHaveLength(30);
    for (const k of SAMPLES) {
        const diff = compareFrames(frames[k], expected(k).data);
        expect(diff.mean, `frame ${k}`).toBeLessThan(meanLimit);
        expect(diff.p999, `frame ${k}`).toBeLessThan(24);
        // Not vacuous: the 10a frozen frame would be far off wherever a live frame differs from it.
        const old = frozen(k);
        if (old) expect(compareFrames(frames[k], old.data).mean, `frame ${k} (frozen)`).toBeGreaterThan(8);
    }
}

const referenceCache = new Map<string, RawFrame>();
function transitionFrame(key: string, a: RawFrame, b: RawFrame, p: number): RawFrame {
    let frame = referenceCache.get(key);
    if (!frame) referenceCache.set(key, (frame = renderTransitionReference(wipe, a, b, p)));
    return frame;
}

describe.each(hosts.map((h) => [h.name, h] as const))("live transition handles on %s", (_name, host) => {
    it("a scene window shows real media past the cut on both sides, then the held frames", async () => {
        // a: media 0.2..0.7 of a 0.8 s file (0.1 s = 3 frames after its end); b: media 0.1..0.6 (3 frames before).
        const a = scene("a", 0, 0.5, { sourceVideoUrl: URL, cardConfig: trims(0.2, 0.7, 0.8), visualTransition: "wipe_left", visualTransitionDuration: 0.4 });
        const b = scene("b", 0.5, 0.5, { sourceVideoUrl: URL, cardConfig: trims(0.1, 0.6, FRAMES / FPS) });
        const plan = compileExport(input({ project, scenes: [a, b] }), { resolution: "720p" }, { media: new Map([[URL, MEDIA]]), rasters: new Map(), gl: false });
        const frames = splitFrames(await runPlanVideo(host, plan, { [URL]: await nutMedia(host) }), W * H * 3);
        const aFrame = (k: number) => Math.min(6 + k, 23);
        const bFrame = (k: number) => Math.max(0, 3 + (k - 15));
        const expected = (k: number) => (k < 9 ? frameAt(6 + k) : k >= 21 ? frameAt(3 + k - 15)
            : transitionFrame(`s${k}`, frameAt(aFrame(k)), frameAt(bFrame(k)), progress(k)));
        // 10a: a holds media frame 20 after the cut, b holds media frame 3 before it.
        // (Checked where the live side covers a third of the frame or more.)
        const frozen = (k: number) => (k === 13 || k === 16
            ? renderTransitionReference(wipe, frameAt(k < 15 ? 6 + k : 20), frameAt(k < 15 ? 3 : 3 + k - 15), progress(k)) : null);
        expectFrames(frames, expected, frozen);
    }, 600_000);

    it("a window whose half is not a whole number of milliseconds starts on its first frame (frozen sides)", async () => {
        // 0.5 s → half 7/30 s: the tail piece starts at 23/30 s, which must not round up to 0.767 and skip frame 23.
        const a = scene("a", 0, 1, { sourceVideoUrl: URL, visualTransition: "wipe_left", visualTransitionDuration: 0.5 });
        const b = scene("b", 1, 1, { sourceVideoUrl: URL });
        const plan = compileExport(input({ project, scenes: [a, b] }), { resolution: "720p" }, { media: new Map([[URL, MEDIA]]), rasters: new Map(), gl: false });
        expect(plan.inputs.map((i) => i.options.join(" "))).toContain("-ss 0.766 -t 0.233");
        const frames = splitFrames(await runPlanVideo(host, plan, { [URL]: await nutMedia(host) }), W * H * 3);
        expect(frames).toHaveLength(60);
        const p = (k: number) => (k - 23) / 14;
        const expected = (k: number) => transitionFrame(`h${k}`, frameAt(Math.min(k, 29)), frameAt(Math.max(0, k - 30)), p(k));
        for (const k of [23, 26, 33, 36]) {
            const diff = compareFrames(frames[k], expected(k).data);
            expect(diff.mean, `frame ${k}`).toBeLessThan(2.5);
            expect(diff.p999, `frame ${k}`).toBeLessThan(24);
        }
    }, 600_000);

    it("a V2 clip lane blends two video clips with a wipe; the outgoing clip plays on past the cut", async () => {
        const v = (id: string, start: number, end: number, patch: Record<string, unknown> = {}) =>
            clip(id, { trackType: "video", trackIndex: 2, startTime: start, endTime: end, mediaUrl: URL, mediaType: "video", scale: 1.5, ...patch });
        const plan = compileExport(input({ project, clips: [v("a", 0, 0.5, { transitionType: "wipe_left", transitionDuration: 0.4 }), v("b", 0.5, 1)] }), { resolution: "720p" }, {
            media: new Map([[URL, MEDIA]]), rasters: new Map(), gl: false,
        });
        expect(plan.filterGraph).toContain("format=gbrap");
        const frames = splitFrames(await runPlanVideo(host, plan, { [URL]: await nutMedia(host) }), W * H * 3);
        // Clips play from media 0: a shows frame k (live after the cut, the file is long enough); b holds frame 0 before it.
        const expected = (k: number) => (k < 9 ? frameAt(k) : k >= 21 ? frameAt(k - 15)
            : transitionFrame(`c${k}`, frameAt(k), frameAt(Math.max(0, k - 15)), progress(k)));
        const frozen = (k: number) => (k === 16 ? renderTransitionReference(wipe, frameAt(14), frameAt(k - 15), progress(k)) : null);
        expectFrames(frames, expected, frozen, 3.5);
        // Outside the window the lane draws exactly what the per-clip path draws (same clips, no transition).
        const legacy = compileExport(input({ project, clips: [v("a", 0, 0.5), v("b", 0.5, 1)] }), { resolution: "720p" }, { media: new Map([[URL, MEDIA]]), rasters: new Map(), gl: false });
        expect(legacy.filterGraph).not.toContain("format=gbrap");
        const before = splitFrames(await runPlanVideo(host, legacy, { [URL]: await nutMedia(host) }), W * H * 3);
        for (const k of [3, 25]) expect(compareFrames(frames[k], before[k]).mean, `frame ${k} vs the per-clip path`).toBeLessThan(1);
    }, 600_000);

    it("a V2 clip lane with transparency: a half-transparent image wipes to an opaque one over the main track", async () => {
        const bg = mediaFrame(30);
        const aRgba = mediaFrame(5, 4);
        for (let i = 0; i < W * H; i += 1) if ((i % W) >= W / 2) aRgba.data[i * 4 + 3] = 0;
        const bRgba = mediaFrame(12, 4);
        // On the lane each clip sits on a clear frame: fully transparent pixels carry no color.
        const aLane: RawFrame = { ...aRgba, data: aRgba.data.map((value, i) => (aRgba.data[i - (i % 4) + 3] === 0 ? 0 : value)) };
        const files = {
            "/m/bg.png": encodePng({ width: W, height: H, channels: 3, data: bg.data }),
            "/m/a.png": encodePng({ width: W, height: H, channels: 4, data: aRgba.data }),
            "/m/b.png": encodePng({ width: W, height: H, channels: 3, data: mediaFrame(12).data }),
        };
        const image = (id: string, start: number, end: number, patch: Record<string, unknown> = {}) =>
            clip(id, { trackType: "video", trackIndex: 2, startTime: start, endTime: end, mediaUrl: `/m/${id}.png`, mediaType: "image", scale: 1.5, ...patch });
        const plan = compileExport(input({
            project,
            scenes: [scene("bg", 0, 1, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/bg.png" })],
            clips: [image("a", 0, 0.5, { transitionType: "wipe_left", transitionDuration: 0.4 }), image("b", 0.5, 1)],
        }), { resolution: "720p" }, { media: new Map(Object.keys(files).map((url) => [url, STILL])), rasters: new Map(), gl: false });
        const frames = splitFrames(await runPlanVideo(host, plan, files), W * H * 3);
        const over = (lane: RawFrame): RawFrame => {
            const out = new Uint8Array(W * H * 3);
            for (let i = 0; i < W * H; i += 1) {
                const alpha = lane.data[i * 4 + 3] / 255;
                for (let c = 0; c < 3; c += 1) out[i * 3 + c] = Math.round(lane.data[i * 4 + c] * alpha + bg.data[i * 3 + c] * (1 - alpha));
            }
            return { width: W, height: H, channels: 3, data: out };
        };
        const expected = (k: number) => over(k < 9 ? aLane : k >= 21 ? bRgba : transitionFrame(`t${k}`, aLane, bRgba, progress(k)));
        expectFrames(frames, expected, () => null, 3.5);
    }, 600_000);
});
