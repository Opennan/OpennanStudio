// Speed parity (phase 10b): a numbered synthetic video runs through the REAL compiled export graph (overlay
// clips and main-track scenes) on native ffmpeg and ffmpeg.wasm, and the source frame shown at every output
// frame must equal the JS reference exactly: the frame visible at the middle of the output frame,
// frame(n) = max { k : out(k/30) + bias < (n + ½)/30 } (speed-remap.ts pickSourceFrame). Audio: a sine through
// the compiled atempo / asetrate chains keeps the clip's exact length and keeps (or shifts) its pitch.
import { describe, expect, it } from "vitest";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { clipSpeedProfile, outputTimeAt, sceneSpeedProfile, sourceSpan, speedCurvePreset, type SpeedProfile } from "@opennan/timeline-core/motion/speed";
import { compileExport } from "../src/compile";
import { clip, input, scene } from "../src/compile/test-helpers";
import { speedRampTable } from "../src/filters/video";
import { fmt } from "../src/format";
import { pickSourceFrame } from "../src/speed-remap";
import { sceneDuration } from "../src/timeline-model";
import type { MediaInfo } from "../src/types";
import { ffmpegHosts, type FfmpegHost } from "./ffmpeg";
import { runPlanAudio, runPlanVideo } from "./plan-runner";

const hosts = await ffmpegHosts();
const FPS = 30;
// 80×16 matches the 5:1 export frame (1280×256 at 720p), so a scene fills the frame. Frame k shows its index
// in base 16 as three vertical bands of gray 16·digit + 8 (low digit left): limited-range YUV and the
// overlay's RGBA round trip move dark grays by up to ±4 levels, well inside a 16-level bin.
const SW = 80;
const SH = 16;
const FRAMES = 720;
const URL = "/m/count.nut";
const MEDIA: MediaInfo = { durationSeconds: FRAMES / FPS, hasVideo: true, hasAudio: false, width: SW, height: SH };

function numberedFrames(): Uint8Array {
    const raw = new Uint8Array(SW * SH * 3 * FRAMES);
    for (let k = 0; k < FRAMES; k += 1) {
        for (let y = 0; y < SH; y += 1) {
            for (let x = 0; x < SW; x += 1) {
                const o = ((k * SH + y) * SW + x) * 3;
                const digit = (k >> (4 * Math.floor((x * 3) / SW))) & 15;
                raw[o] = raw[o + 1] = raw[o + 2] = 16 * digit + 8;
            }
        }
    }
    return raw;
}

const encoded = new Map<FfmpegHost, Promise<Uint8Array>>();
/** The numbered clip as NUT/rawvideo yuv420p, encoded by the host under test (every frame a keyframe). */
function numberedMedia(host: FfmpegHost): Promise<Uint8Array> {
    let media = encoded.get(host);
    if (!media) {
        media = host.run({
            files: { "in.rgb": numberedFrames() },
            args: ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${SW}x${SH}`, "-framerate", String(FPS), "-i", "in.rgb", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "count.nut"],
            outputName: "count.nut",
        });
        encoded.set(host, media);
    }
    return media;
}

/** Source frame index per 3×1 probe frame (one pixel per band, low digit first). */
function decode(bytes: Uint8Array): number[] {
    const out: number[] = [];
    const digit = (value: number) => Math.min(15, Math.max(0, Math.floor(value / 16)));
    for (let o = 0; o + 9 <= bytes.length; o += 9) out.push(digit(bytes[o]) + 16 * digit(bytes[o + 3]) + 256 * digit(bytes[o + 6]));
    return out;
}

const SCENE_PROBE = "scale=3:1:flags=neighbor";
// A scale-3 overlay of the 80×16 clip at 720p is 160×32, centered in the 1280×256 frame.
const OVERLAY_PROBE = "crop=160:32:560:112,scale=3:1:flags=neighbor";

async function render(host: FfmpegHost, doc: Parameters<typeof compileExport>[0], probe: string): Promise<number[]> {
    const plan = compileExport(doc, { resolution: "720p" }, { media: new Map([[URL, MEDIA]]), rasters: new Map(), gl: false });
    return decode(await runPlanVideo(host, plan, { [URL]: await numberedMedia(host) }, probe));
}

const reference = (profile: SpeedProfile, D: number) => Array.from({ length: Math.round(D * FPS) }, (_, n) => pickSourceFrame(profile, D, n, FPS, FPS));
const doc = (clips: ReturnType<typeof clip>[] = [], scenes: ReturnType<typeof scene>[] = []) =>
    input({ project: { aspectRatio: "5:1", musicUrl: null, musicVolume: 1 }, clips, scenes });
const overlay = (D: number, patch: Record<string, unknown>) =>
    clip("o", { trackType: "video", trackIndex: 2, startTime: 0, endTime: D, mediaUrl: URL, mediaType: "video", scale: 3, ...patch });
const curveJson = (id: string) => JSON.stringify(speedCurvePreset(id));

/** The 10a export's ramp remap (filters/video.ts speedRampFilters before phase 10b), for the legacy comparison. */
function legacyRampFilter(ramp: "montage" | "hero" | "bullet", duration: number, speed: number): string {
    const table = speedRampTable(ramp, duration, speed)!;
    const line = (s: (typeof table.segments)[number]) =>
        `${s.outputStart > 0 ? `${fmt(s.outputStart)}+` : ""}(T${s.sourceStart > 0 ? `-${fmt(s.sourceStart)}` : ""})/${fmt(s.speed)}`;
    let expression = line(table.segments[table.segments.length - 1]);
    for (let i = table.segments.length - 2; i >= 0; i -= 1) {
        expression = `if(lt(T,${fmt(table.segments[i + 1].sourceStart)}),${line(table.segments[i])},${expression})`;
    }
    return `setpts='(${expression})/TB'`;
}

describe.each(hosts.map((h) => [h.name, h] as const))("speed on %s", (_name, host) => {
    const D = 2;
    const cases: Array<[string, Record<string, unknown>]> = [
        ["constant 0.5x", { playbackSpeed: 0.5 }],
        ["constant 2x", { playbackSpeed: 2 }],
        ["constant 10x", { playbackSpeed: 10 }],
        ["constant 1.5x", { playbackSpeed: 1.5 }],
        ["hero curve", { speedCurveJson: curveJson("hero") }],
        ["flash_in curve", { speedCurveJson: curveJson("flash_in") }],
        ["bullet curve at 2x", { speedCurveJson: curveJson("bullet"), playbackSpeed: 2 }],
    ];

    it.each(cases)("overlay clip, %s: every output frame shows the reference source frame", async (_label, patch) => {
        const c = overlay(D, patch);
        const frames = await render(host, doc([c]), OVERLAY_PROBE);
        expect(frames).toEqual(reference(clipSpeedProfile(c), D));
    }, 600_000);

    it("a legacy ramp (montage at 1x) shows the same frames as the 10a export and the reference", async () => {
        const c = overlay(D, { speedRamp: "montage" });
        const frames = await render(host, doc([c]), OVERLAY_PROBE);
        expect(frames).toEqual(reference(clipSpeedProfile(c), D));
        const span = speedRampTable("montage", D, 1)!.sourceSpan;
        const legacy = decode(await host.run({
            files: { "count.nut": await numberedMedia(host) },
            args: ["-t", span.toFixed(3), "-i", "count.nut", "-vf", `setpts=PTS-STARTPTS,${legacyRampFilter("montage", D, 1)},fps=${FPS},trim=duration=${D},scale=3:1:flags=neighbor`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "out.raw"],
            outputName: "out.raw",
        }));
        expect(frames).toEqual(legacy);
    }, 600_000);

    it.each([
        ["reverse at 2x", { playbackSpeed: 2, reversePlayback: true }],
        ["reverse with the hero curve", { speedCurveJson: curveJson("hero"), reversePlayback: true }],
    ] as Array<[string, Record<string, unknown>]>)("overlay clip, %s: the source is reversed first, then remapped", async (_label, patch) => {
        const c = overlay(D, patch);
        const profile = clipSpeedProfile(c);
        const frames = await render(host, doc([c]), OVERLAY_PROBE);
        // The reversed source is the K frames before the span, last first.
        const K = Math.ceil(sourceSpan(profile, D) * FPS - 1e-9);
        expect(frames).toEqual(reference(profile, D).map((j) => K - 1 - j));
    }, 600_000);

    it.each([
        ["constant 2x from a trim", { playbackSpeed: 2, cardConfig: JSON.stringify({ trimStart: 0.5 }) }, 3],
        ["constant 0.5x", { playbackSpeed: 0.5 }, 1],
        ["hero curve from a trim", { speedCurveJson: curveJson("hero"), cardConfig: JSON.stringify({ trimStart: 0.3 }) }, 2.325],
    ] as Array<[string, Record<string, unknown>, number]>)("main-track scene, %s", async (_label, patch, source) => {
        const s = scene("a", 0, source, { sourceVideoUrl: URL, ...patch });
        const D = sceneDuration(s);
        const trimFrames = Math.round(Number(JSON.parse(String(patch.cardConfig ?? "{}")).trimStart ?? 0) * FPS);
        const frames = await render(host, doc([], [s]), SCENE_PROBE);
        expect(frames).toEqual(reference(sceneSpeedProfile(s), D).map((k) => k + trimFrames));
    }, 600_000);

    it("a shot-sequenced scene follows the curve across its shots", async () => {
        // Two shots of the numbered clip (1 s + 1.325 s of source) under the hero curve: shot 2 restarts its media at 0.
        const shots = JSON.stringify([{ duration: 1, video_url: URL }, { duration: 1.325, video_url: URL }]);
        const s = scene("g", 0, 2.325, { cardType: "ai_video", sourceVideoUrl: null, shotBreakdown: shots, speedCurveJson: curveJson("hero") });
        const D = sceneDuration(s);
        const profile = sceneSpeedProfile(s);
        const cut = Math.round(outputTimeAt(profile, 1, D) * FPS);
        const frames = await render(host, doc([], [s]), SCENE_PROBE);
        expect(frames).toEqual(reference(profile, D).map((k, n) => (n < cut ? k : Math.max(0, k - FPS))));
    }, 600_000);

    it("a sped-up scene after a transition: its head and body pieces read from S(piece start) and stay frame exact", async () => {
        const a = scene("a", 0, 1, { sourceVideoUrl: URL, visualTransition: "dip_black", visualTransitionDuration: 0.4 });
        const b = scene("b", 1, 2.325, { sourceVideoUrl: URL, speedCurveJson: curveJson("hero"), cardConfig: JSON.stringify({ trimStart: 0.5 }) });
        const D = sceneDuration(b);
        expect(D).toBeCloseTo(3, 9);
        const frames = await render(host, doc([], [a, b]), SCENE_PROBE);
        expect(frames).toHaveLength(120);
        // A plays 1:1 until the window (frames 24..35 mix through black); B's body follows its curve from frame 36.
        expect(frames.slice(0, 24)).toEqual(Array.from({ length: 24 }, (_, n) => n));
        const expectedB = reference(sceneSpeedProfile(b), D).map((k) => k + 15);
        expect(frames.slice(36)).toEqual(expectedB.slice(6));
    }, 600_000);
});

// ── audio ────────────────────────────────────────────────

const RATE = 48000;
const TONE = 440;

/** A mono 16-bit WAV: a 440 Hz sine for `seconds`. */
function sineWav(seconds: number): Uint8Array {
    const samples = Math.round(seconds * RATE);
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i += 1) view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * TONE * i) / RATE) * 16000), true);
    return bytes;
}

const WAV = "/m/tone.wav";
const WAV_INFO: MediaInfo = { durationSeconds: 30, hasVideo: false, hasAudio: true, width: 0, height: 0 };
const AUDIO_FRAME = 1024;

/** First and last sample above the threshold, and the tone frequency measured by zero crossings in [a, b) seconds. */
function measure(samples: Float32Array, a: number, b: number) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < samples.length; i += 1) {
        if (Math.abs(samples[i]) > 0.05) {
            if (first < 0) first = i;
            last = i;
        }
    }
    let crossings = 0;
    for (let i = Math.round(a * RATE) + 1; i < Math.round(b * RATE); i += 1) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings += 1;
    return { first, last, frequency: crossings / (2 * (b - a)) };
}

describe.each(hosts.map((h) => [h.name, h] as const))("speed audio on %s", (_name, host) => {
    // The clip sits at [0.5, 1.5) of a 2 s timeline (an image clip sets the length).
    const timeline = (patch: Record<string, unknown>) => input({
        clips: [
            clip("img", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/i.png", mediaType: "image" }),
            clip("au", { trackType: "audio", trackIndex: 2, startTime: 0.5, endTime: 1.5, mediaUrl: WAV, mediaType: "audio", ...patch }),
        ],
    });
    const run = async (patch: Record<string, unknown>) => {
        const media = new Map([[WAV, WAV_INFO], ["/m/i.png", { durationSeconds: 0, hasVideo: true, hasAudio: false, width: 2, height: 2 }]]);
        const plan = compileExport(timeline(patch), { resolution: "720p" }, { media, rasters: new Map(), gl: false });
        const png = encodePng({ width: 2, height: 2, channels: 3, data: new Uint8Array(12) });
        return { plan, samples: await runPlanAudio(host, plan, { [WAV]: sineWav(30), "/m/i.png": png }) };
    };

    it.each([
        ["2x keeping pitch (atempo)", { playbackSpeed: 2 }, TONE],
        ["2x with pitch following (asetrate)", { playbackSpeed: 2, preservePitch: false }, 2 * TONE],
        ["0.5x keeping pitch", { playbackSpeed: 0.5 }, TONE],
        ["0.5x with pitch following", { playbackSpeed: 0.5, preservePitch: false }, TONE / 2],
        ["10x keeping pitch", { playbackSpeed: 10 }, TONE],
        ["a legacy ramp keeping pitch", { speedRamp: "montage" }, TONE],
        ["the flash_in curve keeping pitch", { speedCurveJson: curveJson("flash_in") }, TONE],
    ] as Array<[string, Record<string, unknown>, number]>)("%s: exact length, expected pitch", async (_label, patch, frequency) => {
        const { plan, samples } = await run(patch);
        expect(plan.warnings).toEqual([]);
        expect(samples.length).toBe(2 * RATE);
        const { first, last, frequency: measured } = measure(samples, 0.7, 1.3);
        expect(Math.abs(first - 0.5 * RATE), "onset").toBeLessThanOrEqual(AUDIO_FRAME);
        expect(Math.abs(last + 1 - 1.5 * RATE), "end").toBeLessThanOrEqual(AUDIO_FRAME);
        expect(Math.abs(measured - frequency) / frequency, `${measured} Hz`).toBeLessThan(0.02);
    }, 600_000);
});
