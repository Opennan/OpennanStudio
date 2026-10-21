// The 40-item bench project (test-only, phase 10b): 40 main-track scenes over two stills and a video, each
// with a filter and some Adjust (a few with sharpen, vignette, or grain), a transition on every cut, and a
// few overlay clips with looks of their own. Synthetic media, made on a parity host.
import type { SceneData } from "@opennan/timeline-core";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { TRANSITIONS } from "@opennan/timeline-core/looks/transitions";
import { clip, input, scene } from "../src/compile/test-helpers";
import type { ExportInput, MediaInfo } from "../src/types";
import type { FfmpegHost } from "./ffmpeg";

const FILTERS = ["fresh", "warm", "cinematic", "teal_orange", "cool"];
const ADJUST = [
    { exposure: 0.15, contrast: 0.2 },
    { saturation: 0.3, vignette: 0.4 },
    { highlights: -0.3, grain: 0.25 },
    { temperature: 0.2, sharpen: 0.35 },
];
const VIDEO = { width: 320, height: 180, seconds: 3, fps: 30 };

export const BENCH_URLS = { a: "/m/bench-a.png", b: "/m/bench-b.png", v: "/m/bench-v.mp4" };

export const BENCH_MEDIA_INFO: ReadonlyMap<string, MediaInfo> = new Map([
    [BENCH_URLS.a, { durationSeconds: 0, hasVideo: true, hasAudio: false, width: 640, height: 360 }],
    [BENCH_URLS.b, { durationSeconds: 0, hasVideo: true, hasAudio: false, width: 360, height: 360 }],
    [BENCH_URLS.v, { durationSeconds: VIDEO.seconds, hasVideo: true, hasAudio: false, width: VIDEO.width, height: VIDEO.height }],
]);

export interface BenchOptions {
    scenes?: number;
    /** Seconds per scene (cycled). */
    durations?: number[];
    overlays?: boolean;
    /** A transition on every cut (default true). */
    transitions?: boolean;
}

/** The bench timeline: `scenes` scenes (default 40) cycling still A, still B, video, then the overlays. */
export function benchProject({ scenes: count = 40, durations = [1, 1.2, 0.8], overlays = true, transitions = true }: BenchOptions = {}): ExportInput {
    const scenes: SceneData[] = [];
    let at = 0;
    for (let i = 0; i < count; i += 1) {
        const duration = durations[i % durations.length];
        const kind = i % 3;
        const media: Partial<SceneData> = kind === 0
            ? { cardType: "image", sourceVideoUrl: null, startImageUrl: BENCH_URLS.a }
            : kind === 1
                ? { cardType: "image", sourceVideoUrl: null, startImageUrl: BENCH_URLS.b }
                : { cardType: "source_clip", sourceVideoUrl: BENCH_URLS.v };
        scenes.push(scene(`s${i}`, at, duration, {
            ...media,
            order: i,
            visualFilter: FILTERS[i % FILTERS.length],
            filterIntensity: 0.8,
            adjustmentsJson: JSON.stringify(ADJUST[i % ADJUST.length]),
            // Every cut; the last scene's transition has no incoming scene and is ignored.
            ...(transitions ? { visualTransition: TRANSITIONS[(i * 7) % TRANSITIONS.length].id, visualTransitionDuration: 0.4 } : {}),
        }));
        at += duration;
    }
    const clips = overlays
        ? [
            clip("ov1", { trackType: "video", trackIndex: 2, startTime: 2, endTime: 5, mediaUrl: BENCH_URLS.v, mediaType: "video", scale: 0.4, visualFilter: "warm" }),
            clip("ov2", { trackType: "video", trackIndex: 2, startTime: Math.max(0, at - 6), endTime: Math.max(1, at - 3.5), mediaUrl: BENCH_URLS.v, mediaType: "video", scale: 0.35, visualFilter: "cinematic", adjustmentsJson: '{"vignette":0.3}' }),
            clip("st1", { trackType: "sticker", trackIndex: 1, startTime: 1, endTime: Math.min(at, 12), mediaUrl: BENCH_URLS.b, mediaType: "image", scale: 0.25, visualFilter: "fresh", adjustmentsJson: '{"grain":0.2}' }),
        ]
        : [];
    return input({ scenes, clips });
}

function gradient(width: number, height: number, seed: number): Uint8Array {
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const o = (y * width + x) * 3;
            data[o] = Math.round(30 + 190 * (x / width) + seed * 7) & 255;
            data[o + 1] = Math.round(40 + 170 * (y / height));
            data[o + 2] = Math.round(128 + 100 * Math.sin((x + y + seed * 40) / 37));
        }
    }
    return data;
}

/** Bench media bytes by URL; the video (MPEG-4 Part 2, decodable on every host) is encoded on `host`. */
export async function benchMedia(host: FfmpegHost): Promise<Record<string, Uint8Array>> {
    const { width, height, seconds, fps } = VIDEO;
    const frames = seconds * fps;
    const raw = new Uint8Array(width * height * 3 * frames);
    for (let n = 0; n < frames; n += 1) raw.set(gradient(width, height, n), n * width * height * 3);
    const video = await host.run({
        files: { "v.raw": raw },
        args: ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "v.raw", "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", "v.mp4"],
        outputName: "v.mp4",
    });
    return {
        [BENCH_URLS.a]: encodePng({ width: 640, height: 360, channels: 3, data: gradient(640, 360, 3) }),
        [BENCH_URLS.b]: encodePng({ width: 360, height: 360, channels: 3, data: gradient(360, 360, 9) }),
        [BENCH_URLS.v]: video,
    };
}
