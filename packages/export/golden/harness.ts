// Golden-test plumbing: local ffmpeg paths, fixture export, frame extraction, SSIM, probing.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, type Canvas } from "@napi-rs/canvas";
import { exportTimeline, type ExportResult } from "../src/export-timeline";
import { createCanvasRasterizer, type RasterCanvas } from "../src/raster/canvas-rasterizer";
import { createNodeRunner } from "../src/node/runner";
import type { ExportResolution } from "../src/types";
import { GOLDEN_FONT_FAMILY, GOLDEN_MEDIA_URL, type GoldenFixture } from "./fixtures";

export const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = path.join(GOLDEN_DIR, "media");
export const SNAPSHOT_DIR = path.join(GOLDEN_DIR, "snapshots");
export const OUT_DIR = path.join(GOLDEN_DIR, "out");
// GPL Homebrew build: fine for tests, never shipped (spec §3).
export const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
export const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
export const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE);
/** ffmpeg release the committed snapshots and thresholds were measured with. */
export const SNAPSHOT_FFMPEG = "7.1";

export function ffmpegVersion(): string {
    return execFileSync(FFMPEG, ["-hide_banner", "-version"], { encoding: "utf8" }).match(/ffmpeg version n?(\S+)/)?.[1] ?? "unknown";
}

let fontRegistered = false;
function registerFont(): void {
    if (fontRegistered) return;
    GlobalFonts.registerFromPath(path.join(MEDIA_DIR, "golden-font.ttf"), GOLDEN_FONT_FAMILY);
    fontRegistered = true;
}

export function snapshotPath(fixture: string, time: number): string {
    return path.join(SNAPSHOT_DIR, `${fixture}@${time}.png`);
}

const renders = new Map<string, Promise<{ result: ExportResult; file: string }>>();

/** Renders a fixture once per resolution (the export-only checks reuse the stream test's render). */
export function exportFixture(fixture: GoldenFixture, resolution: ExportResolution = fixture.resolution): Promise<{ result: ExportResult; file: string }> {
    const key = `${fixture.name}@${resolution}`;
    let render = renders.get(key);
    if (!render) {
        render = renderFixture(fixture, resolution);
        renders.set(key, render);
    }
    return render;
}

async function renderFixture(fixture: GoldenFixture, resolution: ExportResolution): Promise<{ result: ExportResult; file: string }> {
    if (!existsSync(path.join(MEDIA_DIR, "golden-font.ttf"))) throw new Error("golden media missing: run node golden/make-media.mjs");
    registerFont();
    mkdirSync(OUT_DIR, { recursive: true });
    const runner = createNodeRunner({
        ffmpegPath: FFMPEG,
        ffprobePath: FFPROBE,
        outputPath: (container) => path.join(OUT_DIR, `${fixture.name}-${resolution}.${container}`),
        // Fail closed like a real host: only golden media under golden/media is readable.
        mediaRoots: [MEDIA_DIR],
        resolveSource: (url) => (url.startsWith(`${GOLDEN_MEDIA_URL}/`) ? path.join(MEDIA_DIR, url.slice(GOLDEN_MEDIA_URL.length + 1)) : null),
    });
    const rasterizer = createCanvasRasterizer({
        createCanvas: (w, h) => createCanvas(w, h) as unknown as RasterCanvas,
        encodePng: async (canvas) => new Uint8Array((canvas as unknown as Canvas).toBuffer("image/png")),
    });
    const result = await exportTimeline({
        project: { aspectRatio: fixture.aspectRatio, musicUrl: fixture.musicUrl, musicVolume: fixture.musicVolume },
        tracks: fixture.tracks,
        clips: fixture.clips,
        scenes: fixture.scenes,
    }, { resolution }, { runner, rasterizer });
    if (result.output.kind !== "file") throw new Error("node runner returns files");
    return { result, file: result.output.path };
}

export interface ProbedStreams {
    duration: number;
    video: { codec: string; width: number; height: number; fps: string } | null;
    audio: { codec: string; sampleRate: number; channels: number } | null;
}

export function probeOutput(file: string): ProbedStreams {
    const data = JSON.parse(execFileSync(FFPROBE, [
        "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration", "-of", "json", file,
    ], { encoding: "utf8" }));
    const video = data.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const audio = data.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    return {
        duration: Number(data.format.duration),
        video: video ? { codec: video.codec_name, width: video.width, height: video.height, fps: video.r_frame_rate } : null,
        audio: audio ? { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels } : null,
    };
}

function pngSize(file: string): [number, number] {
    const data = readFileSync(file);
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

/** SSIM "All" between the export frame at `time` and a preview snapshot (export frame scaled to the snapshot). */
export function ssimAt(file: string, time: number, snapshot: string): number {
    const [width, height] = pngSize(snapshot);
    return parseSsim(stderrOf([
        "-hide_banner", "-ss", String(time), "-i", file, "-i", snapshot,
        "-filter_complex", `[0:v]trim=end_frame=1,scale=${width}:${height}:flags=bicubic,format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim`,
        "-f", "null", "-",
    ]));
}

/** ffmpeg writes filter reports (ssim, volumedetect) to stderr. */
function stderrOf(args: string[]): string {
    const result = spawnSync(FFMPEG, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ffmpeg failed:\n${result.stderr.slice(-500)}`);
    return result.stderr;
}

export function parseSsim(log: string): number {
    const match = log.match(/All:([0-9.]+)/);
    if (!match) throw new Error(`no SSIM in ffmpeg output:\n${log.slice(-500)}`);
    return Number(match[1]);
}

/** Mean volume (dB) of one channel (0 = left, 1 = right). */
export function channelMeanVolume(file: string, channel: 0 | 1, start = 0, duration?: number): number {
    const log = stderrOf([
        "-hide_banner", "-ss", String(start), ...(duration ? ["-t", String(duration)] : []), "-i", file,
        "-af", `pan=mono|c0=c${channel},volumedetect`, "-f", "null", "-",
    ]);
    const match = log.match(/mean_volume: (-?[0-9.]+) dB/);
    if (!match) throw new Error("no volumedetect output");
    return Number(match[1]);
}

/** Average RGB of the export frame at `time` (the whole frame scaled to one pixel). */
export function meanColor(file: string, time: number): [number, number, number] {
    const out = execFileSync(FFMPEG, [
        "-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=1:1:flags=area,format=rgb24", "-f", "rawvideo", "-",
    ]);
    return [out[0], out[1], out[2]];
}

/** RGB of one pixel of the export frame at `time` (ffmpeg seeks to the first frame at or after it). */
export function pixelAt(file: string, time: number, x: number, y: number): [number, number, number] {
    const out = execFileSync(FFMPEG, ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"]);
    return [out[0], out[1], out[2]];
}

/** RGB pixels of row `y` of the export frame at `time`. */
export function rowPixels(file: string, time: number, y: number): Array<[number, number, number]> {
    const out = execFileSync(FFMPEG, ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", `crop=iw:1:0:${y},format=rgb24`, "-f", "rawvideo", "-"]);
    const pixels: Array<[number, number, number]> = [];
    for (let i = 0; i + 2 < out.length; i += 3) pixels.push([out[i], out[i + 1], out[i + 2]]);
    return pixels;
}

/**
 * Source frame number of every export frame in [start, start + duration) for full-frame counter.mkv
 * overlays: each of the 7 bars is one bit (white = set), read by averaging each bar to one pixel.
 */
export function counterIndices(file: string, start: number, duration: number): number[] {
    const out = execFileSync(FFMPEG, ["-v", "error", "-ss", String(start), "-t", String(duration), "-i", file, "-vf", "scale=7:1:flags=area,format=gray", "-f", "rawvideo", "-"]);
    const indices: number[] = [];
    for (let i = 0; i + 7 <= out.length; i += 7) indices.push([...out.subarray(i, i + 7)].reduce((n, value, bit) => n + (value > 128 ? 1 << bit : 0), 0));
    return indices;
}

/** Frequency (Hz) of a pure tone on one channel, from astats' zero-crossing rate (two crossings per cycle). */
export function channelFrequency(file: string, channel: 0 | 1, start = 0, duration?: number): number {
    const log = stderrOf([
        "-hide_banner", "-ss", String(start), ...(duration ? ["-t", String(duration)] : []), "-i", file,
        "-af", `pan=mono|c0=c${channel},aresample=48000,astats`, "-f", "null", "-",
    ]);
    const rates = [...log.matchAll(/Zero crossings rate: ([0-9.]+)/g)];
    if (rates.length === 0) throw new Error("no astats output");
    return (Number(rates[rates.length - 1][1]) * 48000) / 2;
}

/**
 * SSIM between the export frame at `time` and the average of its frames at `from` and `to`: a
 * cross-dissolve midpoint must equal that blend.
 */
export function ssimToBlend(file: string, from: number, to: number, time: number): number {
    return parseSsim(stderrOf([
        "-hide_banner", "-ss", String(from), "-i", file, "-ss", String(to), "-i", file, "-ss", String(time), "-i", file,
        "-filter_complex", "[0:v]trim=end_frame=1[a];[1:v]trim=end_frame=1[b];[2:v]trim=end_frame=1[c];[a][b]blend=all_mode=average[r];[r][c]ssim",
        "-f", "null", "-",
    ]));
}
