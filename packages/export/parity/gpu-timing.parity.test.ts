// GPU export timing parity (phase 10c): for every output frame, the source frame the GPU path's draw list asks
// for (gpu/plan.ts) is the source frame the ffmpeg export shows. Synthetic videos carry their frame number in
// binary stripes (left and right edge, 11 rows, frame n stores n + 1 so a black frame reads 0); the real export
// graph runs on native ffmpeg and each output frame's stripes are read back.
import type { SceneData } from "@opennan/timeline-core";
import { serializeSpeedCurve, speedCurvePreset } from "@opennan/timeline-core/motion/speed";
import { compileExport } from "../src/compile";
import { clip, input, scene } from "../src/compile/test-helpers";
import { gifPick, parseGif, type GifInfo } from "../src/gpu/gif";
import { planGpuExport, type DrawOp, type FrameSource, type VideoRead } from "../src/gpu/plan";
import type { ExportInput, MediaInfo } from "../src/types";
import { nativeFfmpeg } from "./ffmpeg";
import { runPlanVideo } from "./plan-runner";

// Each case renders through native ffmpeg (~45 s alone); a loaded machine needs far more headroom.
const PARITY_TIMEOUT_MS = 300_000;

const host = nativeFfmpeg();
const ROWS = 11;
const SOURCES = { a: { url: "/m/n30.mkv", fps: 30 }, b: { url: "/m/n25.mkv", fps: 25 } } as const;
const SECONDS = 14;

async function numberedVideo(fps: number): Promise<Uint8Array> {
    const rowH = 180 / ROWS;
    const bit = `mod(floor((N+1)/pow(2,floor(Y/${rowH.toFixed(6)}))),2)`;
    return host!.run({
        files: {},
        args: [
            "-f", "lavfi", "-i", `color=c=gray:s=320x180:r=${fps}:d=${SECONDS},format=gray`,
            "-vf", `geq=lum='if(lt(X,40)+gte(X,280),16+219*${bit},128)'`,
            "-c:v", "ffv1", "-pix_fmt", "gray", "out.mkv",
        ],
        outputName: "out.mkv",
    });
}

/**
 * A numbered GIF (frame n stores n + 1, as numberedVideo) with irregular delays — including 0 and 1 cs, which
 * ffmpeg plays as 10 cs — and the given NETSCAPE loop setting (ffmpeg's `-loop`: 0 forever, -1 none).
 */
async function numberedGif(frames: number, loop: number): Promise<Uint8Array> {
    const rowH = 180 / ROWS;
    const bit = `mod(floor((N+1)/pow(2,floor(Y/${rowH.toFixed(6)}))),2)`;
    const bytes = await host!.run({
        files: {},
        args: [
            "-f", "lavfi", "-i", `color=c=gray:s=320x180:r=10:d=${frames / 10},format=gray`,
            "-vf", `geq=lum='if(lt(X,40)+gte(X,280),16+219*${bit},128)'`, "-loop", String(loop), "out.gif",
        ],
        outputName: "out.gif",
    });
    // Rewrite each Graphic Control Extension's delay (the block walk of gpu/gif.ts parseGif).
    const delays = [3, 1, 7, 0, 12, 4, 25];
    let o = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
    let k = 0;
    const skip = () => {
        while (bytes[o] !== 0) o += bytes[o] + 1;
        o += 1;
    };
    while (o < bytes.length && bytes[o] !== 0x3b) {
        if (bytes[o] === 0x21) {
            if (bytes[o + 1] === 0xf9) {
                bytes[o + 4] = delays[k % delays.length];
                bytes[o + 5] = 0;
                k += 1;
            }
            o += 2;
            skip();
        } else {
            const packed = bytes[o + 9];
            o += 10 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0) + 1;
            skip();
        }
    }
    return bytes;
}

const info = (fps: number): MediaInfo => ({ durationSeconds: SECONDS, hasVideo: true, hasAudio: false, width: 320, height: 180 });
const MEDIA = new Map([[SOURCES.a.url, info(30)], [SOURCES.b.url, info(25)]]);

/** Numbered GIFs (phase 10d) by URL, parsed from the bytes the export reads. */
const GIFS = new Map<string, GifInfo>();

/** The source frame number (n + 1, 0 = none) the plan's source shows. */
function expectedNumber(source: FrameSource | undefined): number {
    if (!source || source.kind !== "video") return 0;
    const read: VideoRead = source.read;
    const gif = GIFS.get(read.url);
    if (gif) {
        const image = gifPick(gif, read.offsetAt(source.index), read.reverse);
        return image === null ? 0 : image + 1;
    }
    const fps = read.url === SOURCES.a.url ? SOURCES.a.fps : SOURCES.b.fps;
    // Matroska stores frame times in milliseconds: frame k sits at round(1000·k / fps) ms. The anchor is the first
    // frame at or after the seek ("first" reads) or the seek itself (absolute reads).
    const ts = (k: number) => Math.round((1000 * k) / fps) / 1000;
    let first = Math.max(0, Math.floor(read.seek * fps) - 1);
    while (ts(first) < read.seek - 1e-9) first += 1;
    const anchor = read.anchor === "first" ? ts(first) : read.seek;
    const t = anchor + read.offsetAt(source.index);
    if (t >= SECONDS) return 0;
    let k = Math.max(0, Math.floor(t * fps) - 1);
    while (ts(k + 1) <= t + 1e-12) k += 1;
    if (read.reverse) {
        // ffmpeg's `reverse` (phase 10d): the read's frames [anchor, anchor + span) play backwards on the same
        // timestamps, so the forward pick j shows frame n − 1 − j.
        let n = 0;
        while (ts(first + n) - anchor < read.reverse.span - 1e-9 && ts(first + n) < SECONDS) n += 1;
        return first + Math.max(0, n - 1 - Math.min(n - 1, k - first)) + 1;
    }
    return k + 1;
}

function laneSources(ops: DrawOp[]): { a?: FrameSource; b?: FrameSource; layer?: FrameSource } {
    const out: { a?: FrameSource; b?: FrameSource; layer?: FrameSource } = {};
    for (const op of ops) {
        if (op.kind === "lane" && op.opaque) {
            out.a = op.a?.source;
            out.b = op.b?.source ?? undefined;
        } else if (op.kind === "layer") out.layer = op.source;
    }
    return out;
}

/** Stripe numbers per output frame: [left, right] read from a 32×11 area downscale of the frame. */
function readNumbers(raw: Uint8Array, frames: number): Array<[number, number]> {
    const w = 32;
    const out: Array<[number, number]> = [];
    for (let f = 0; f < frames; f += 1) {
        const at = (x: number, y: number) => raw[(f * w * ROWS + y * w + x) * 3];
        const decode = (x: number) => {
            let n = 0;
            for (let row = 0; row < ROWS; row += 1) if (at(x, row) > 128) n |= 1 << row;
            return n;
        };
        out.push([decode(1), decode(30)]);
    }
    return out;
}

async function run(timeline: ExportInput, check: (k: number, ops: DrawOp[], left: number, right: number) => void) {
    const media = { [SOURCES.a.url]: await numberedVideo(30), [SOURCES.b.url]: await numberedVideo(25) };
    const plan = compileExport(timeline, { resolution: "720p" }, { media: MEDIA, rasters: new Map(), gl: false });
    // 1280×720 frame of a 320×180 source: the stripes are 160 px wide; rows are 720 / 11 px tall.
    const raw = await runPlanVideo(host!, plan, media, `scale=32:${ROWS}:flags=area`);
    const frames = Math.round(plan.durationSeconds * plan.format.fps);
    expect(raw.length).toBe(frames * 32 * ROWS * 3);
    const gpu = planGpuExport(timeline, plan.format, { media: MEDIA, rasters: new Map(), gl: false });
    expect(gpu.frameCount).toBe(frames);
    readNumbers(raw, frames).forEach(([left, right], k) => check(k, gpu.drawList(k), left, right));
}

const trim = (from: number, to: number) => JSON.stringify({ trimStart: from, trimEnd: to });

describe.skipIf(!host)("GPU plan timing matches the ffmpeg export (native ffmpeg)", () => {
    it("plain scenes with odd trims, a 25 fps source, 2× speed, and a speed curve", async () => {
        const scenes: SceneData[] = [
            scene("odd", 0, SECONDS, { sourceVideoUrl: SOURCES.a.url, cardConfig: trim(1.31, 2.81) }),
            scene("pal", 1.5, SECONDS, { sourceVideoUrl: SOURCES.b.url, cardConfig: trim(0.47, 1.97) }),
            scene("fast", 3, SECONDS, { sourceVideoUrl: SOURCES.a.url, cardConfig: trim(2, 5), playbackSpeed: 2 }),
            scene("curve", 4.5, SECONDS, { sourceVideoUrl: SOURCES.b.url, cardConfig: trim(3.1, 6.1), speedCurveJson: serializeSpeedCurve(speedCurvePreset("montage")) }),
        ];
        let mismatches = 0;
        await run(input({ scenes }), (k, ops, left, right) => {
            const expected = expectedNumber(laneSources(ops).a);
            if (left !== expected || right !== expected) mismatches += 1;
            expect.soft([k, left, right]).toEqual([k, expected, expected]);
        });
        expect(mismatches).toBe(0);
    }, PARITY_TIMEOUT_MS);

    it("transition windows with live and frozen handles", async () => {
        const scenes: SceneData[] = [
            // Live handles both ways (the media continues past each trim).
            scene("a", 0, SECONDS, { sourceVideoUrl: SOURCES.a.url, cardConfig: trim(2, 4), visualTransition: "wipe_left", visualTransitionDuration: 0.8 }),
            scene("b", 2, SECONDS, { sourceVideoUrl: SOURCES.b.url, cardConfig: trim(3.2, 5.2), visualTransition: "wipe_right", visualTransitionDuration: 0.6 }),
            // No media before its start: its head is frozen.
            scene("c", 4, SECONDS, { sourceVideoUrl: SOURCES.a.url, cardConfig: trim(0, 2) }),
        ];
        await run(input({ scenes }), (k, ops, left, right) => {
            const { a, b } = laneSources(ops);
            const options = new Set([expectedNumber(a), ...(b ? [expectedNumber(b)] : [])]);
            expect.soft({ k, left: options.has(left) }).toEqual({ k, left: true });
            expect.soft({ k, right: options.has(right) }).toEqual({ k, right: true });
        });
    }, PARITY_TIMEOUT_MS);

    it("a full-frame upper-track clip at 1.5× and a frozen clip over a gap", async () => {
        const full = { trackType: "video", trackIndex: 2, mediaType: "video", scale: 6, positionX: 0.5, positionY: 0.5 };
        // Overlays draw at native pixels × frameScale (720/1080) × scale: 320 × 2/3 × 6 = 1280, the full frame.
        const timeline = input({
            scenes: [scene("base", 0, SECONDS, { sourceVideoUrl: null, cardType: "image", startImageUrl: null })],
            clips: [
                clip("fast", { ...full, startTime: 0.5, endTime: 2.5, mediaUrl: SOURCES.b.url, playbackSpeed: 1.5 }),
                clip("still", { ...full, startTime: 2.5, endTime: 3.5, mediaUrl: SOURCES.a.url, freezeFrame: true }),
                clip("late", { ...full, startTime: 3.51, endTime: 4.5, mediaUrl: SOURCES.a.url }),
            ],
        });
        await run(timeline, (k, ops, left, right) => {
            const expected = expectedNumber(laneSources(ops).layer);
            expect.soft([k, left, right]).toEqual([k, expected, expected]);
        });
    }, PARITY_TIMEOUT_MS);

    it("reversed upper-track clips: plain, at 1.5×, on a speed curve, and frozen (phase 10d)", async () => {
        const full = { trackType: "video", trackIndex: 2, mediaType: "video", scale: 6, positionX: 0.5, positionY: 0.5, reversePlayback: true };
        const timeline = input({
            scenes: [scene("base", 0, SECONDS, { sourceVideoUrl: null, cardType: "image", startImageUrl: null })],
            clips: [
                clip("plain", { ...full, startTime: 0.2, endTime: 1.73, mediaUrl: SOURCES.a.url }),
                clip("fast", { ...full, startTime: 1.8, endTime: 3.1, mediaUrl: SOURCES.b.url, playbackSpeed: 1.5 }),
                clip("curve", { ...full, startTime: 3.2, endTime: 5, mediaUrl: SOURCES.a.url, speedCurveJson: serializeSpeedCurve(speedCurvePreset("montage")) }),
                clip("still", { ...full, startTime: 5.1, endTime: 5.9, mediaUrl: SOURCES.b.url, freezeFrame: true }),
            ],
        });
        let reversed = 0;
        await run(timeline, (k, ops, left, right) => {
            const layer = laneSources(ops).layer;
            if (layer?.kind === "video" && layer.read.reverse) reversed += 1;
            const expected = expectedNumber(layer);
            expect.soft([k, left, right]).toEqual([k, expected, expected]);
        });
        expect(reversed).toBeGreaterThan(100);
    }, PARITY_TIMEOUT_MS);

    it("trimmed upper-track clips start at their trimStart: plain, 1.5×, reversed, and frozen", async () => {
        const full = { trackType: "video", trackIndex: 2, mediaType: "video", scale: 6, positionX: 0.5, positionY: 0.5 };
        const timeline = input({
            scenes: [scene("base", 0, SECONDS, { sourceVideoUrl: null, cardType: "image", startImageUrl: null })],
            clips: [
                clip("plain", { ...full, startTime: 0.5, endTime: 1.5, mediaUrl: SOURCES.a.url, trimStart: 2, trimEnd: 3 }),
                clip("odd", { ...full, startTime: 1.5, endTime: 2.5, mediaUrl: SOURCES.b.url, trimStart: 1.31, trimEnd: 2.31 }),
                clip("fast", { ...full, startTime: 2.5, endTime: 3.5, mediaUrl: SOURCES.a.url, trimStart: 4, playbackSpeed: 1.5 }),
                clip("back", { ...full, startTime: 3.5, endTime: 4.5, mediaUrl: SOURCES.a.url, trimStart: 6, trimEnd: 7, reversePlayback: true }),
                clip("still", { ...full, startTime: 4.5, endTime: 5.5, mediaUrl: SOURCES.b.url, trimStart: 3, freezeFrame: true }),
            ],
        });
        // Each clip's first output frame shows its trimStart's source frame (n + 1; the 25 fps source rounds up to its next frame).
        const first = new Map([[15, 61], [45, 34], [75, 121], [105, 210], [135, 76], [160, 76]]);
        await run(timeline, (k, ops, left, right) => {
            const expected = expectedNumber(laneSources(ops).layer);
            expect.soft([k, left, right]).toEqual([k, expected, expected]);
            const at = first.get(k);
            if (at !== undefined) expect.soft([k, left]).toEqual([k, at]);
        });
    }, PARITY_TIMEOUT_MS);

    it("a split clip joined by a transition: both halves continue the media through the window (live handles)", async () => {
        const full = { trackType: "video", trackIndex: 2, mediaType: "video", scale: 6, positionX: 0.5, positionY: 0.5, mediaUrl: SOURCES.a.url };
        const timeline = input({
            scenes: [scene("base", 0, SECONDS, { sourceVideoUrl: null, cardType: "image", startImageUrl: null })],
            clips: [
                clip("left", { ...full, startTime: 0.5, endTime: 2, trimStart: 1, trimEnd: 2.5, transitionType: "wipe_left", transitionDuration: 0.8 }),
                clip("right", { ...full, startTime: 2, endTime: 3.5, trimStart: 2.5, trimEnd: 4 }),
            ],
        });
        let windows = 0;
        await run(timeline, (k, ops, left, right) => {
            const lane = ops.find((op): op is Extract<DrawOp, { kind: "lane" }> => op.kind === "lane" && !op.opaque);
            if (!lane) return;
            const options = new Set([expectedNumber(lane.a?.source), ...(lane.b ? [expectedNumber(lane.b.source)] : [])]);
            if (lane.b) windows += 1;
            expect.soft({ k, left: options.has(left), right: options.has(right) }).toEqual({ k, left: true, right: true });
            // One continuous take: frame k shows source frame (k − 15) + 30 (n + 1 numbering), in and out of the window.
            expect.soft([k, left, right]).toEqual([k, k - 15 + 31, k - 15 + 31]);
        });
        expect(windows).toBe(24);
    }, PARITY_TIMEOUT_MS);

    it("animated GIFs: looping, reversed, sped up, and one that plays once (phase 10d)", async () => {
        const loops = await numberedGif(20, 0);
        const once = await numberedGif(9, -1);
        GIFS.set("/m/loop.gif", parseGif(loops));
        GIFS.set("/m/once.gif", parseGif(once));
        const gifInfo: MediaInfo = { durationSeconds: 1, hasVideo: true, hasAudio: false, width: 320, height: 180 };
        const media = new Map([...MEDIA, ["/m/loop.gif", gifInfo], ["/m/once.gif", gifInfo]]);
        const full = { trackType: "video", trackIndex: 2, mediaType: "video", scale: 6, positionX: 0.5, positionY: 0.5 };
        const timeline = input({
            scenes: [scene("base", 0, SECONDS, { sourceVideoUrl: null, cardType: "image", startImageUrl: null })],
            clips: [
                clip("loop", { ...full, startTime: 0.1, endTime: 3.4, mediaUrl: "/m/loop.gif" }),
                clip("back", { ...full, startTime: 3.5, endTime: 5.2, mediaUrl: "/m/loop.gif", reversePlayback: true }),
                clip("fast", { ...full, startTime: 5.3, endTime: 6.6, mediaUrl: "/m/loop.gif", playbackSpeed: 1.5 }),
                clip("once", { ...full, startTime: 6.7, endTime: 8.4, mediaUrl: "/m/once.gif" }),
            ],
        });
        const plan = compileExport(timeline, { resolution: "720p" }, { media, rasters: new Map(), gl: false });
        const raw = await runPlanVideo(host!, plan, { "/m/loop.gif": loops, "/m/once.gif": once }, `scale=32:${ROWS}:flags=area`);
        const frames = Math.round(plan.durationSeconds * plan.format.fps);
        const gpu = planGpuExport(timeline, plan.format, { media, rasters: new Map(), gl: false });
        let shown = 0;
        readNumbers(raw, frames).forEach(([left, right], k) => {
            const expected = expectedNumber(laneSources(gpu.drawList(k)).layer);
            if (expected > 0) shown += 1;
            expect.soft([k, left, right]).toEqual([k, expected, expected]);
        });
        expect(shown).toBeGreaterThan(200);
    }, PARITY_TIMEOUT_MS);
});
