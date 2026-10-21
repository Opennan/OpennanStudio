// The legacy clip filters (blur slider, chroma key, blend modes) on the GPU path vs the ffmpeg filters the
// compatible export compiles for them (filters/video.ts, applied by compile/overlays.ts). The GPU passes are the
// JS references of timeline-core looks/legacy.ts (the gl-parity e2e checks the shaders against them); here the
// references run on what a browser uploads and are compared with ffmpeg on the planes it really filters:
//   "rgb" input  (after a look, PNG/GIF/raster): RGBA → the ffmpeg filters → RGBA, vs the reference on the RGBA;
//   "yuv420" input (decoded video): the frame as yuv420p (the decoder's output) → the filters → RGBA, vs the
//                reference on the yuv420p frame converted to RGBA (what WebCodecs uploads).
// avgblur and the eq lookups are integer-exact in the references; the differences are the YUV ↔ RGB conversions
// (swscale's fixed point vs rounded floats) and 4:2:0 chroma siting (block means vs swscale's chroma filters).
import { describe, expect, it } from "vitest";
import { chromaKeyUv, eqPlanes, legacyPlaneModes, legacyReference, type LegacyOps } from "@opennan/timeline-core/looks/legacy";
import type { BlendMode, ChromaKey } from "../src/clip-params";
import { blendModeFilters, blurFilters, chromaKeyFilters } from "../src/filters/video";
import { pinEqFormats } from "../src/lgpl-filters";
import { ffmpegHosts, type FfmpegHost } from "./ffmpeg";
import { compareFrames, testFrame, type FrameDiff, type RgbFrame } from "./frames";

const hosts = await ffmpegHosts();
const W = 96;
const H = 54;

const BLEND_EQ: Record<Exclude<BlendMode, "normal">, { brightness: number; contrast: number; saturation: number }> = {
    multiply: { brightness: -0.08, contrast: 1.15, saturation: 1 },
    screen: { brightness: 0.08, contrast: 0.9, saturation: 1 },
    overlay: { brightness: 0, contrast: 1.25, saturation: 1.1 },
};

/** A test frame with a noisy green screen on its left third and a blue-ish one at the bottom right. */
function keyFrame(seed: number): RgbFrame {
    const frame = testFrame(W, H, seed, 4);
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const o = (y * W + x) * 4;
            const n = ((x * 7 + y * 13) % 17) - 8;
            if (x < W / 3) frame.data.set([10 + n, 230 + n, 20 + n, 255], o);
            else if (x > W * 0.7 && y > H * 0.6) frame.data.set([40 + n, 60 + n, 220 + n, 255], o);
            else frame.data[o + 3] = 255;
        }
    }
    return frame;
}

interface Case {
    name: string;
    blur?: number;
    key?: ChromaKey;
    blend?: Exclude<BlendMode, "normal">;
}

const CASES: Case[] = [
    { name: "blur 3", blur: 3 },
    { name: "blur 20 (radius limited by the frame)", blur: 20 },
    { name: "chroma key hard", key: { enabled: true, color: "0x00FF00", similarity: 0.12, blend: 0 } },
    { name: "chroma key soft", key: { enabled: true, color: "0x1EE614", similarity: 0.05, blend: 0.2 } },
    { name: "chroma key blue", key: { enabled: true, color: "0x3C3CDC", similarity: 0.1, blend: 0.1 } },
    { name: "multiply", blend: "multiply" },
    { name: "screen", blend: "screen" },
    { name: "overlay", blend: "overlay" },
    { name: "blur + key + overlay", blur: 2, key: { enabled: true, color: "0x00FF00", similarity: 0.1, blend: 0.15 }, blend: "overlay" },
];

function filters(c: Case): string[] {
    return pinEqFormats([
        ...(c.blur ? blurFilters(c.blur) : []),
        ...(c.key ? chromaKeyFilters(c.key) : []),
        ...(c.blend ? blendModeFilters(c.blend) : []),
    ]);
}

function ops(c: Case, input: "yuv420" | "rgb"): LegacyOps {
    const modes = legacyPlaneModes(input, { chromaKey: Boolean(c.key), eq: Boolean(c.blend), yuva444Fades: false });
    return {
        blur: c.blur ? { radius: Math.trunc(c.blur), mode: modes.blur } : null,
        chromaKey: c.key ? { key: { ...chromaKeyUv(c.key.color), similarity: c.key.similarity, blend: c.key.blend }, subsampled: modes.subsampled } : null,
        eq: c.blend ? eqPlanes(BLEND_EQ[c.blend]) : null,
    };
}

const raw = (host: FfmpegHost, args: string[], files: Record<string, Uint8Array>) => host.run({ files, args: [...args, "-f", "rawvideo", "out.raw"], outputName: "out.raw" });
const input = (fmt: string, name: string) => ["-f", "rawvideo", "-pix_fmt", fmt, "-s", `${W}x${H}`, "-i", name];

/**
 * RGBA diff split into colour and alpha; alpha without the 1-pixel border, where ffmpeg's chromakey reads stale
 * neighbours (its 3×3 window keeps the previous pixel's values outside the frame, which depends on slice threading).
 */
function diff(a: Uint8Array, b: Uint8Array): { color: FrameDiff; alpha: FrameDiff } {
    const n = a.length / 4;
    const ca = new Uint8Array(n * 3);
    const cb = new Uint8Array(n * 3);
    const aa: number[] = [];
    const ab: number[] = [];
    for (let i = 0; i < n; i += 1) {
        // Colour where both are visible (ffmpeg keeps colour under alpha 0 too, but nothing shows it).
        const seen = a[i * 4 + 3] > 0 || b[i * 4 + 3] > 0;
        for (let c = 0; c < 3; c += 1) {
            ca[i * 3 + c] = seen ? a[i * 4 + c] : 0;
            cb[i * 3 + c] = seen ? b[i * 4 + c] : 0;
        }
        const x = i % W;
        const y = Math.floor(i / W);
        if (x > 0 && y > 0 && x < W - 1 && y < H - 1) {
            aa.push(a[i * 4 + 3]);
            ab.push(b[i * 4 + 3]);
        }
    }
    return { color: compareFrames(ca, cb), alpha: compareFrames(new Uint8Array(aa), new Uint8Array(ab)) };
}

const report = (host: string, name: string, d: { color: FrameDiff; alpha: FrameDiff }) =>
    process.stderr.write(`[legacy-parity] ${host} ${name}: colour mean ${d.color.mean.toFixed(3)} p99.9 ${d.color.p999} max ${d.color.max}; alpha mean ${d.alpha.mean.toFixed(3)} p99.9 ${d.alpha.p999} max ${d.alpha.max}\n`);

describe.each(hosts.map((h) => [h.name, h] as const))("legacy clip filters: GPU references vs ffmpeg on %s", (hostName, host) => {
    for (const c of CASES) {
        it(`${c.name} on RGB input`, async () => {
            const frame = keyFrame(21);
            const out = await raw(host, [...input("rgba", "in.raw"), "-vf", [...filters(c), "format=rgba"].join(","), "-pix_fmt", "rgba"], { "in.raw": frame.data });
            const ref = legacyReference(frame.data, W, H, ops(c, "rgb"));
            const d = diff(out, ref);
            report(hostName, `${c.name} rgb`, d);
            expect(d.color.mean).toBeLessThan(0.6);
            expect(d.color.p999).toBeLessThanOrEqual(3);
            expect(d.alpha.mean).toBeLessThan(0.6);
            expect(d.alpha.p999).toBeLessThanOrEqual(c.key ? 3 : 0);
        });

        it(`${c.name} on decoded 4:2:0 video`, async () => {
            const frame = keyFrame(22);
            const yuv = await raw(host, [...input("rgba", "in.raw"), "-pix_fmt", "yuv420p"], { "in.raw": frame.data });
            const uploaded = await raw(host, [...input("yuv420p", "in.yuv"), "-pix_fmt", "rgba"], { "in.yuv": yuv });
            const out = await raw(host, [...input("yuv420p", "in.yuv"), "-vf", [...filters(c), "format=rgba"].join(","), "-pix_fmt", "rgba"], { "in.yuv": yuv });
            const ref = legacyReference(uploaded, W, H, ops(c, "yuv420"));
            const d = diff(out, ref);
            report(hostName, `${c.name} yuv420`, d);
            expect(d.color.mean).toBeLessThan(1.5);
            expect(d.color.p999).toBeLessThanOrEqual(c.blur || c.key ? 24 : 4);
            expect(d.alpha.mean).toBeLessThan(c.key ? 1.5 : 0.001);
        });
    }
});
