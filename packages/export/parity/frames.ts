// Synthetic RGB test frames and frame comparison for parity tests.
import type { FfmpegHost } from "./ffmpeg";

export interface RgbFrame {
    width: number;
    height: number;
    /** RGB (3) or RGBA (4) bytes, rows top-first. */
    channels: 3 | 4;
    data: Uint8Array;
}

/** Deterministic xorshift32 in [0, 1). */
export function rng(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 4294967296;
    };
}

/**
 * Gradients, hard edges, saturated patches, skin-like tones, and noise: exercises curves, hue shifts,
 * spatial filters, and sampling boundaries.
 */
export function testFrame(width: number, height: number, seed = 1, channels: 3 | 4 = 3): RgbFrame {
    const rand = rng(seed);
    const data = new Uint8Array(width * height * channels);
    const patches = Array.from({ length: 6 }, () => [rand() * width, rand() * height, 4 + rand() * width * 0.2, rand() * 255, rand() * 255, rand() * 255]);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const o = (y * width + x) * channels;
            let r = (x / (width - 1)) * 255;
            let g = (y / (height - 1)) * 255;
            let b = ((x + y) % 32 < 16 ? 220 : 30) * (1 - x / width) + 128 * (x / width);
            for (const [px, py, radius, pr, pg, pb] of patches) {
                if (Math.hypot(x - px, y - py) < radius) {
                    r = pr;
                    g = pg;
                    b = pb;
                }
            }
            if (y > height * 0.8) {
                r = 224; g = 172; b = 140; // skin-like strip
            }
            const noise = (rand() - 0.5) * 24;
            data[o] = clampByte(r + noise);
            data[o + 1] = clampByte(g + noise);
            data[o + 2] = clampByte(b + noise);
            if (channels === 4) data[o + 3] = clampByte(255 - (x / width) * 120);
        }
    }
    return { width, height, channels, data };
}

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export interface FrameDiff {
    mean: number;
    p999: number;
    max: number;
    /** Share of samples that differ at all. */
    changed: number;
}

export function compareFrames(a: Uint8Array, b: Uint8Array): FrameDiff {
    if (a.length !== b.length) throw new Error(`frame sizes differ: ${a.length} vs ${b.length}`);
    const histogram = new Uint32Array(256);
    let sum = 0;
    let max = 0;
    let changed = 0;
    for (let i = 0; i < a.length; i += 1) {
        const d = Math.abs(a[i] - b[i]);
        histogram[d] += 1;
        sum += d;
        if (d > max) max = d;
        if (d) changed += 1;
    }
    let acc = 0;
    let p999 = 0;
    for (let d = 0; d < 256; d += 1) {
        acc += histogram[d];
        if (acc >= a.length * 0.999) {
            p999 = d;
            break;
        }
    }
    return { mean: sum / a.length, p999, max, changed: changed / a.length };
}

export interface FilterRun {
    /** Raw frames fed as inputs [0..n), each looped for `seconds` when given. */
    frames: RgbFrame[];
    /** Extra file inputs after the frames (PNG masks, CLUTs), by name, with their input options. */
    files?: Array<{ name: string; data: Uint8Array; options?: string[] }>;
    /** filter_complex graph; must end in the label [out]. */
    graph: string;
    /** Output pixel format: rgb24 or rgba. */
    outFormat?: "rgb24" | "rgba";
    /** Loop each frame for this many seconds at `fps` (transitions). Default: one frame. */
    seconds?: number;
    fps?: number;
}

export async function runFilter(host: FfmpegHost, run: FilterRun): Promise<Uint8Array> {
    const files: Record<string, Uint8Array> = {};
    const args: string[] = [];
    const fps = run.fps ?? 30;
    run.frames.forEach((frame, i) => {
        const name = `in${i}.raw`;
        files[name] = frame.data;
        if (run.seconds) args.push("-stream_loop", "-1", "-framerate", String(fps), "-t", String(run.seconds));
        else args.push("-framerate", String(fps));
        args.push("-f", "rawvideo", "-pix_fmt", frame.channels === 4 ? "rgba" : "rgb24", "-s", `${frame.width}x${frame.height}`, "-i", name);
    });
    for (const file of run.files ?? []) {
        files[file.name] = file.data;
        args.push(...(file.options ?? []), "-i", file.name);
    }
    // passthrough: never duplicate or drop frames to fit a constant rate (inputs may start at T > 0).
    args.push("-filter_complex", run.graph, "-map", "[out]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", run.outFormat ?? "rgb24", "out.raw");
    return host.run({ files, args, outputName: "out.raw" });
}

/** Splits concatenated raw frames. */
export function splitFrames(data: Uint8Array, frameBytes: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let o = 0; o + frameBytes <= data.length; o += frameBytes) out.push(data.subarray(o, o + frameBytes));
    return out;
}
