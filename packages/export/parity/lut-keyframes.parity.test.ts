// Adjust keyframes (phase 10b): the export's CLUT cross-fade (one haldclut per keyframe, blended in sequence
// with the eased weight of blend's T) matches the JS reference at every frame on native ffmpeg and
// ffmpeg.wasm: each keyframe's CLUT as renderLookReference applies it, then acc_k = trunc(acc_k−1 +
// (LUT_k − acc_k−1)·q(s_k(T))). The sequence equals the preview's two-CLUT mix (lookKeyframeMix), and the
// weight rule equals timeline-media's lutMixWeight / lutMixLevel. End to end, an overlay clip starting at
// 0.5 s is graded at its own item-local time (blend's T after the overlay's setpts=PTS-STARTPTS).
import { describe, expect, it } from "vitest";
import type { LookSource } from "@opennan/timeline-core/looks/look-plan";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { evaluateScalar } from "@opennan/timeline-core/looks/expr";
import { renderLookReference, type RawFrame } from "@opennan/timeline-core/looks/reference";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { keyframedLook, keyframeLut, lookKeyframeMix, lookMixLevel, lookMixWeight, lookSegmentWeight } from "@opennan/timeline-core/motion/look-keyframes";
import { lutMixLevel, lutMixWeight } from "@opennan/timeline-media/looks/gl-programs";
import { compileExport } from "../src/compile";
import type { CompileContext } from "../src/compile/context";
import { clip as makeClip, input } from "../src/compile/test-helpers";
import { FilterGraph } from "../src/graph";
import { applyLook } from "../src/looks/look-filters";
import type { ExportKeyedLook } from "../src/motion/lut-keyframes";
import { resolveOutputFormat } from "../src/presets";
import { ffmpegHosts, type FfmpegHost } from "./ffmpeg";
import { compareFrames, splitFrames, testFrame, type RgbFrame } from "./frames";
import { runPlanVideo } from "./plan-runner";

const hosts = await ffmpegHosts();
const FPS = 30;
const W = 96;
const H = 54;
const SECONDS = 2;

/** Keyframes on frame boundaries and between them, every easing kind, a neutral keyframe, filter intensity. */
const KEYFRAMES: Array<Record<string, number>> = [
    { time: 0.2, adj_exposure: -0.4, adj_saturation: 0.3, filter_intensity: 0.2 },
    { time: 0.7, adj_exposure: 0.5, adj_contrast: 0.4, easing: 1 },
    { time: 1, adj_exposure: 0, adj_saturation: 0, adj_contrast: 0, filter_intensity: 0, easing: 5, bx1: 0.2, by1: -0.4, bx2: 0.7, by2: 1.5 },
    { time: 1.37, adj_temperature: 0.6, adj_exposure: 0.2, easing: 4 },
    { time: 1.6, adj_temperature: -0.5, filter_intensity: 1, easing: 3 },
    { time: 1.9, adj_exposure: -0.2 },
];
const ITEM: LookSource = { kind: "scene", visualFilter: "teal_orange", filterIntensity: 0.6, adjustmentsJson: '{"highlights":-0.3}' };

function keyed(item: LookSource, points: Array<Record<string, number>>): ExportKeyedLook {
    const parsed = parseTimelineKeyframes(JSON.stringify(points));
    return { ...keyframedLook(item, parsed)!, points: parsed };
}

/** The JS reference: every keyframe's CLUT (renderLookReference), mixed in sequence at item-local `t`. */
function sequentialReference(frame: RgbFrame, look: ExportKeyedLook, luts: Uint8Array[], t: number): Uint8Array {
    const out = new Uint8Array(luts[0]);
    for (let k = 1; k < luts.length; k += 1) {
        const w = evaluateScalar(lookSegmentWeight(look.points, look.times, k), t);
        for (let i = 0; i < out.length; i += 1) out[i] = lookMixLevel(out[i], luts[k][i], w);
    }
    return out;
}

const lutImages = (frame: RgbFrame | RawFrame, look: ExportKeyedLook) =>
    look.luts.map((step) => renderLookReference(frame as RawFrame, { steps: [step], unknownEffects: [], animated: false }).data);

async function runKeyed(host: FfmpegHost, frame: RgbFrame, look: ExportKeyedLook, offset: number): Promise<Uint8Array[]> {
    const graph = new FilterGraph();
    const ctx: CompileContext = { graph, format: resolveOutputFormat("16:9", "720p"), duration: SECONDS, media: new Map(), rasters: new Map(), warnings: [], files: [], fileKeys: new Map() };
    graph.input("media", "frame.raw", []);
    const pad = applyLook(ctx, "0:v", look.rest, { width: W, height: H, alpha: false, duration: SECONDS, timeOffset: offset }, look);
    graph.chain([pad], ["format=rgb24"], "out");
    const files: Record<string, Uint8Array> = { "frame.raw": frame.data };
    const args = ["-stream_loop", "-1", "-framerate", String(FPS), "-t", String(SECONDS), "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", "frame.raw"];
    for (const entry of graph.inputs.slice(1)) {
        const file = ctx.files.find((f) => f.name === entry.source)!;
        files[file.name] = file.data;
        args.push(...entry.options, "-i", file.name);
    }
    args.push("-filter_complex", graph.toString(), "-map", "[out]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "out.raw");
    return splitFrames(await host.run({ files, args, outputName: "out.raw" }), W * H * 3);
}

describe("the mix rule (no ffmpeg)", () => {
    it("core's lookMixWeight / lookMixLevel are timeline-media's lutMixWeight / lutMixLevel", () => {
        for (let i = -20; i <= 1044; i += 1) {
            const w = i / 1024 + (i % 7) * 1e-4;
            expect(lookMixWeight(w)).toBe(lutMixWeight(w));
            expect(lookMixLevel(i & 255, (i * 37) & 255, w)).toBe(lutMixLevel(i & 255, (i * 37) & 255, w));
        }
    });

    it("the sequential blend equals the preview's two-CLUT mix (lookKeyframeMix + keyframeLut) at every frame", () => {
        const frame = testFrame(W, H, 7);
        const look = keyed(ITEM, KEYFRAMES);
        const luts = lutImages(frame, look);
        for (let n = 0; n < SECONDS * FPS; n += 1) {
            const t = n / FPS;
            const at = lookKeyframeMix(look.points, t)!;
            const a = renderLookReference(frame as RawFrame, { steps: [keyframeLut(ITEM, look.points, at.from)], unknownEffects: [], animated: false }).data;
            const b = renderLookReference(frame as RawFrame, { steps: [keyframeLut(ITEM, look.points, at.to)], unknownEffects: [], animated: false }).data;
            const preview = a.map((value, i) => lutMixLevel(value, b[i], at.w));
            expect(compareFrames(sequentialReference(frame, look, luts, t), preview).max, `frame ${n}`).toBe(0);
        }
    });
});

describe.each(hosts.map((h) => [h.name, h] as const))("Adjust keyframes on %s", (_name, host) => {
    const frame = testFrame(W, H, 11);

    for (const offset of [0, 0.5]) {
        it(`the compiled cross-fade matches the reference at every frame, keyframes included (stream starts at item second ${offset})`, async () => {
            const look = keyed(ITEM, KEYFRAMES);
            expect(look.luts).toHaveLength(6);
            const luts = lutImages(frame, look);
            const frames = await runKeyed(host, frame, look, offset);
            expect(frames).toHaveLength(SECONDS * FPS);
            let exact = 0;
            frames.forEach((out, n) => {
                const diff = compareFrames(out, sequentialReference(frame, look, luts, n / FPS + offset));
                // haldclut's trilinear lerp may move one level on arm64 (looks.parity); the mix keeps it at one.
                expect(diff.max, `frame ${n}`).toBeLessThanOrEqual(1);
                if (diff.max === 0) exact += 1;
            });
            // The keyframe frames themselves (exactly one CLUT) and most others are bit-exact.
            expect(exact).toBeGreaterThan(frames.length / 2);
        }, 300_000);
    }

    it("a single look keyframe is one CLUT, and spatial steps run after the cross-fade", async () => {
        const look = keyed({ kind: "scene", adjustmentsJson: '{"vignette":0.5}' }, [{ time: 0.3, adj_exposure: 0.4 }]);
        expect(look.luts).toHaveLength(1);
        expect(look.rest?.steps.map((s) => s.kind)).toEqual(["vignette"]);
        const frames = await runKeyed(host, frame, look, 0);
        const expected = renderLookReference(frame as RawFrame, { steps: [look.luts[0], ...look.rest!.steps], unknownEffects: [], animated: false }).data;
        expect(compareFrames(frames[10], expected).max).toBeLessThanOrEqual(1);
    }, 300_000);
});

// ── end to end: an overlay clip with Adjust keyframes ─────

const FW = 1280;
const FH = 720;
function smooth(): RgbFrame {
    const data = new Uint8Array(FW * FH * 3);
    for (let y = 0; y < FH; y += 1) {
        for (let x = 0; x < FW; x += 1) {
            const o = (y * FW + x) * 3;
            data[o] = Math.round(40 + 170 * (x / FW));
            data[o + 1] = Math.round(30 + 190 * (y / FH));
            data[o + 2] = Math.round(120 + 100 * Math.sin((x + y) / 160));
        }
    }
    return { width: FW, height: FH, channels: 3, data };
}

describe.each(hosts.map((h) => [h.name, h] as const))("Adjust keyframes through the compiled overlay on %s", (_name, host) => {
    it("grades the clip at its item-local time (blend's T after the overlay's time filters)", async () => {
        const source = smooth();
        const START = 0.5;
        // A fast look change (±0.6 exposure per 0.5 s): one frame of time error moves the mean by several levels.
        const points: Array<Record<string, number>> = [{ time: 0, adj_exposure: -0.6 }, { time: 0.5, adj_exposure: 0.6 }, { time: 1, adj_exposure: -0.6, easing: 3 }];
        const clip = makeClip("g", {
            trackType: "video", trackIndex: 2, startTime: START, endTime: 1.6, mediaUrl: "/m/g.png", mediaType: "image", scale: 1.5, keyframesJson: JSON.stringify(points),
        });
        const plan = compileExport(input({ clips: [clip] }), { resolution: "720p" }, {
            media: new Map([["/m/g.png", { durationSeconds: 0, hasVideo: true, hasAudio: false, width: FW, height: FH }]]), rasters: new Map(), gl: false,
        });
        expect(plan.filterGraph).toContain("blend=all_expr=");
        const frames = splitFrames(await runPlanVideo(host, plan, { "/m/g.png": encodePng({ width: FW, height: FH, channels: 3, data: source.data }) }), FW * FH * 3);
        const look = keyed({ kind: "clip", ...clip }, points);
        const luts = lutImages(source, look);
        for (const n of [16, 20, 27, 30, 33, 38, 44]) {
            const local = n / FPS - START;
            const right = compareFrames(frames[n], sequentialReference(source, look, luts, local)).mean;
            const early = compareFrames(frames[n], sequentialReference(source, look, luts, local - 1 / FPS)).mean;
            const late = compareFrames(frames[n], sequentialReference(source, look, luts, local + 1 / FPS)).mean;
            // YUV 4:2:0 round trip of the composite (compile.parity's bound), and closer than one frame off either way.
            expect(right, `frame ${n}`).toBeLessThan(2.5);
            expect(right, `frame ${n} vs a frame early`).toBeLessThan(early);
            expect(right, `frame ${n} vs a frame late`).toBeLessThan(late);
        }
    }, 600_000);
});
