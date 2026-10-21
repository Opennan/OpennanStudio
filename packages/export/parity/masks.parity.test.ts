// Masks (phase 10c): the export's mask filters match the JS reference (timeline-core looks/masks.ts through
// renderLookReference) on native ffmpeg and ffmpeg.wasm. Static masks are generated images of the reference
// itself (bit-exact); animated masks run geq on the alpha plane with the keyframes as expressions of the
// frame-snapped keyframe clock (double precision like the reference; constants are written with 9 decimals).
// End to end, a masked main-track scene shows black outside its mask and a masked V2 clip shows the scene below.
import { describe, expect, it } from "vitest";
import { itemLook, maskLook, type LookSource } from "@opennan/timeline-core/looks/look-plan";
import { MASK_SHAPES, centredMaskBox, maskImage, maskLevelAt, parseMask, type MaskShape } from "@opennan/timeline-core/looks/masks";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { renderLookReference, type RawFrame } from "@opennan/timeline-core/looks/reference";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { compileExport } from "../src/compile";
import type { CompileContext } from "../src/compile/context";
import { clip, input, scene } from "../src/compile/test-helpers";
import { FilterGraph } from "../src/graph";
import { applyLook, type LookTarget } from "../src/looks/look-filters";
import { resolveOutputFormat } from "../src/presets";
import { ffmpegHosts, type FfmpegHost } from "./ffmpeg";
import { compareFrames, splitFrames, testFrame, type RgbFrame } from "./frames";
import { runPlanVideo } from "./plan-runner";

const hosts = await ffmpegHosts();
const FPS = 30;
const W = 96;
const H = 54;

const maskJson = (shape: MaskShape, over: Record<string, unknown> = {}) => JSON.stringify({
    shape, x: 0.46, y: 0.53, width: 0.7, height: 0.55, rotation: 17, feather: 0.12, roundness: 0.45, ...over,
});
/** Every mask channel keyed, on and between frames, with linear, ease, hold, and bezier segments. */
const KEYFRAMES = JSON.stringify({ keyframes: [
    { time: 0.1, mask_x: 0.3, mask_y: 0.4, mask_w: 0.5, mask_h: 0.4, mask_rotation: -10, mask_feather: 0 },
    { time: 0.5, mask_x: 0.6, mask_w: 0.8, mask_rotation: 40, mask_feather: 0.3, easing: 3 },
    { time: 0.737, mask_y: 0.6, mask_h: 0.7, easing: 4 },
    { time: 1.2, mask_x: 0.5, mask_rotation: 5, mask_feather: 0.1, easing: 5, bx1: 0.3, by1: -0.2, bx2: 0.6, by2: 1.3 },
] });

/** Runs `source`'s look through applyLook on one looped raw frame; returns RGBA frames. */
async function runLook(host: FfmpegHost, frame: RgbFrame, source: LookSource, target: Partial<LookTarget> = {}, seconds = 1 / FPS): Promise<Uint8Array[]> {
    const graph = new FilterGraph();
    const ctx: CompileContext = { graph, format: resolveOutputFormat("16:9", "720p"), duration: seconds, media: new Map(), rasters: new Map(), warnings: [], files: [], fileKeys: new Map() };
    graph.input("media", "frame.raw", []);
    const pad = applyLook(ctx, "0:v", itemLook(source), { width: W, height: H, alpha: frame.channels === 4, duration: seconds, ...target });
    graph.chain([pad], ["format=rgba"], "out");
    const files: Record<string, Uint8Array> = { "frame.raw": frame.data };
    const args = ["-stream_loop", "-1", "-framerate", String(FPS), "-t", String(seconds), "-f", "rawvideo", "-pix_fmt", frame.channels === 4 ? "rgba" : "rgb24", "-s", `${W}x${H}`, "-i", "frame.raw"];
    for (const entry of graph.inputs.slice(1)) {
        const file = ctx.files.find((f) => f.name === entry.source)!;
        files[file.name] = file.data;
        args.push(...entry.options, "-i", file.name);
    }
    args.push("-filter_complex", graph.toString(), "-map", "[out]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "out.raw");
    return splitFrames(await host.run({ files, args, outputName: "out.raw" }), W * H * 4);
}

const alphaOf = (rgba: Uint8Array) => rgba.filter((_, i) => i % 4 === 3);
const colorOf = (rgba: Uint8Array) => rgba.filter((_, i) => i % 4 !== 3);

describe("the reference (no ffmpeg)", () => {
    it("renderLookReference's alpha is the mask image, and keyframes move it", () => {
        const frame = testFrame(W, H, 3) as RawFrame;
        const source: LookSource = { kind: "scene", maskJson: maskJson("heart"), keyframesJson: KEYFRAMES };
        const plan = itemLook(source)!;
        for (const t of [0, 0.5, 0.9]) {
            const out = renderLookReference(frame, plan, t);
            const spec = parseMask(source.maskJson)!;
            const points = parseTimelineKeyframes(KEYFRAMES);
            expect([...alphaOf(out.data)]).toEqual([...maskImage(spec, W, H, points, t)]);
            expect(alphaOf(out.data)[Math.round(H / 2) * W + 2]).toBe(maskLevelAt(spec, 2, Math.round(H / 2), W, H, points, t));
        }
    });
});

describe.each(hosts.map((h) => [h.name, h] as const))("masks on %s", (_name, host) => {
    const rgb = testFrame(W, H, 21);
    const rgba = testFrame(W, H, 22, 4);

    it("every shape, static: the generated image is exact on an opaque item, and multiplies an item's alpha exactly", async () => {
        for (const shape of MASK_SHAPES) {
            for (const invert of [false, true]) {
                const source: LookSource = { kind: "scene", maskJson: maskJson(shape, { invert }) };
                const [opaque] = await runLook(host, rgb, source);
                expect(compareFrames(opaque, renderLookReference(rgb as RawFrame, itemLook(source)).data).max, `${shape} invert=${invert}`).toBe(0);
            }
            const source: LookSource = { kind: "clip", trackType: "video", maskJson: maskJson(shape) };
            const [alpha] = await runLook(host, rgba, source);
            expect(compareFrames(alpha, renderLookReference(rgba as RawFrame, itemLook(source)).data).max, `${shape} on alpha`).toBe(0);
        }
    }, 300_000);

    it("a look and a mask together: the colour is the look's, the alpha the mask's", async () => {
        const source: LookSource = {
            kind: "scene", visualFilter: "teal_orange", filterIntensity: 0.7, adjustmentsJson: '{"vignette":0.4,"exposure":0.2}', maskJson: maskJson("rectangle"),
            effects: [{ id: "e", effectId: "fx_rgb_split", order: 0, paramsJson: null, enabled: true }],
        };
        const [out] = await runLook(host, rgb, source);
        const expected = renderLookReference(rgb as RawFrame, itemLook(source)).data;
        expect(compareFrames(alphaOf(out), alphaOf(expected)).max).toBe(0);
        // haldclut's trilinear lerp may move one level on arm64 (looks.parity).
        expect(compareFrames(colorOf(out), colorOf(expected)).max).toBeLessThanOrEqual(1);
    }, 300_000);

    for (const offset of [0, 0.5]) {
        it(`every shape, keyframed: geq on alpha follows the keyframe clock frame by frame (stream starts at keyframe second ${offset})`, async () => {
            const seconds = 1.5 - offset;
            for (const shape of MASK_SHAPES) {
                const source: LookSource = { kind: "scene", maskJson: maskJson(shape, { invert: shape === "star" }), keyframesJson: KEYFRAMES };
                const plan = itemLook(source)!;
                for (const frame of [rgb, rgba]) {
                    const frames = await runLook(host, frame, source, { keyframeOffset: offset, timeOffset: 7 }, seconds);
                    expect(frames.length, shape).toBe(Math.round(seconds * FPS));
                    let worst = { mean: 0, p999: 0 };
                    frames.forEach((out, n) => {
                        const expected = renderLookReference(frame as RawFrame, plan, n / FPS + offset).data;
                        const diff = compareFrames(alphaOf(out), alphaOf(expected));
                        worst = { mean: Math.max(worst.mean, diff.mean), p999: Math.max(worst.p999, diff.p999) };
                        expect(compareFrames(colorOf(out), colorOf(expected)).max, `${shape} colour @${n}`).toBe(0);
                    });
                    expect(worst.mean, `${shape} (${frame.channels} channels)`).toBeLessThanOrEqual(0.05);
                    expect(worst.p999, `${shape} (${frame.channels} channels)`).toBeLessThanOrEqual(1);
                }
            }
        }, 600_000);
    }
});

// ── end to end ─────────────────────────────────────────────

function smooth(seed: number, width: number, height: number): RawFrame {
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const o = (y * width + x) * 3;
            data[o] = Math.round(60 + 150 * (x / width) + seed * 10);
            data[o + 1] = Math.round(50 + 160 * (y / height));
            data[o + 2] = Math.round(120 + 90 * Math.sin((x / width + y / height + seed) * 4));
        }
    }
    return { width, height, channels: 3, data };
}

describe.each(hosts.map((h) => [h.name, h] as const))("masked items in a compiled export on %s", (_name, host) => {
    it("a V1 scene shows black outside its mask; a V2 clip with a keyframed mask shows the scene below outside it", async () => {
        // A fills the 720p frame as the scene; B (1080p) fills it as a V2 clip at scale 1.
        const A = smooth(0, 1280, 720);
        const B = smooth(4, 1920, 1080);
        const info = (img: RawFrame) => ({ durationSeconds: 0, hasVideo: true, hasAudio: false, width: img.width, height: img.height });
        const media = {
            "/m/a.png": encodePng({ width: A.width, height: A.height, channels: 3, data: A.data }),
            "/m/b.png": encodePng({ width: B.width, height: B.height, channels: 3, data: B.data }),
        };
        const base = scene("a", 0, 1, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png", maskJson: maskJson("circle", { x: 0.5, y: 0.5, rotation: 0, feather: 0 }) });
        const keyframes = JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.25 }, { time: 1, mask_x: 0.75 }] });
        const overlay = clip("o", {
            trackType: "video", trackIndex: 2, startTime: 0, endTime: 1, mediaUrl: "/m/b.png", mediaType: "image", scale: 1,
            maskJson: maskJson("rectangle", { width: 0.4, height: 0.4, rotation: 0, feather: 0, roundness: 0 }), keyframesJson: keyframes,
        });
        const plan = compileExport(input({ scenes: [base], clips: [overlay] }), { resolution: "720p" }, {
            media: new Map([["/m/a.png", info(A)], ["/m/b.png", info(B)]]), rasters: new Map(), gl: false,
        });
        const outW = plan.format.width;
        const outH = plan.format.height;
        const frames = splitFrames(await runPlanVideo(host, plan, media), outW * outH * 3);
        expect(frames.length).toBe(30);
        const px = (frame: Uint8Array, x: number, y: number) => {
            const o = (Math.round(y * outH) * outW + Math.round(x * outW)) * 3;
            return [frame[o], frame[o + 1], frame[o + 2]];
        };
        const near = (got: number[], want: number[], tolerance = 6) => got.every((v, i) => Math.abs(v - want[i]) <= tolerance);
        const sample = (img: RawFrame, x: number, y: number) => {
            const o = (Math.round(y * img.height) * img.width + Math.round(x * img.width)) * 3;
            return [img.data[o], img.data[o + 1], img.data[o + 2]];
        };
        for (const n of [0, 15, 29]) {
            const frame = frames[n];
            const cx = 0.25 + 0.5 * (n / FPS);
            // Corner: outside the V1 circle and outside the clip's square → black.
            expect(near(px(frame, 0.03, 0.05), [0, 0, 0]), `corner @${n}`).toBe(true);
            // Inside the clip's moving square → B.
            expect(near(px(frame, cx, 0.5), sample(B, cx, 0.5)), `square @${n}`).toBe(true);
            // Inside the V1 circle, away from the square → A.
            const away = cx < 0.5 ? 0.66 : 0.34;
            expect(near(px(frame, away, 0.4), sample(A, away, 0.4)), `circle @${n}`).toBe(true);
        }
    }, 300_000);

    it("a moving masked scene (keyframed scale, placed per frame) keeps its mask", async () => {
        const A = smooth(1, 1280, 720);
        const media = { "/m/a.png": encodePng({ width: A.width, height: A.height, channels: 3, data: A.data }) };
        const moving = scene("a", 0, 1, {
            cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png", maskJson: maskJson("circle", { x: 0.5, y: 0.5, width: 0.8, height: 0.8, rotation: 0, feather: 0 }),
            keyframesJson: JSON.stringify({ keyframes: [{ time: 0, scale: 1 }, { time: 1, scale: 0.8 }] }),
        });
        const plan = compileExport(input({ scenes: [moving] }), { resolution: "720p" }, {
            media: new Map([["/m/a.png", { durationSeconds: 0, hasVideo: true, hasAudio: false, width: A.width, height: A.height }]]), rasters: new Map(), gl: false,
        });
        const outW = plan.format.width;
        const outH = plan.format.height;
        const frames = splitFrames(await runPlanVideo(host, plan, media), outW * outH * 3);
        const px = (frame: Uint8Array, x: number, y: number) => {
            const o = (Math.round(y * outH) * outW + Math.round(x * outW)) * 3;
            return [frame[o], frame[o + 1], frame[o + 2]];
        };
        const near = (got: number[], want: number[], tolerance = 8) => got.every((v, i) => Math.abs(v - want[i]) <= tolerance);
        for (const n of [0, 29]) {
            const frame = frames[n];
            // The centre shows A; a point of the media rect left of the circle (radius 0.4·720 px) is black at both scales.
            const o = (360 * 1280 + 640) * 3;
            expect(near(px(frame, 0.5, 0.5), [A.data[o], A.data[o + 1], A.data[o + 2]]), `centre @${n}`).toBe(true);
            expect(near(px(frame, 0.15, 0.5), [0, 0, 0]), `outside the circle @${n}`).toBe(true);
            expect(near(px(frame, 0.03, 0.04), [0, 0, 0]), `corner @${n}`).toBe(true);
        }
    }, 300_000);
});

// ── text and stickers (phase 10d) ───────────────────────────
// A text or emoji raster is its layout box plus padding: the mask is sized and placed by the box (centred in the
// bitmap), and the padding takes the mask's continuation. Static masks are the boxed reference image (exact); keyframed
// masks are geq with the box shift (double precision like the reference).

describe.each(hosts.map((h) => [h.name, h] as const))("text and sticker masks on %s", (_name, host) => {
    const rgba = testFrame(W, H, 23, 4);
    const box = centredMaskBox({ width: W, height: H }, { width: W - 21, height: H - 13 });

    it("every shape in the item box, static (exact) and keyframed (geq with the box shift)", async () => {
        for (const shape of MASK_SHAPES) {
            const source: LookSource = { kind: "clip", trackType: "text", maskJson: maskJson(shape, { invert: shape === "heart" }) };
            const [still] = await runLook(host, rgba, source, { maskBox: box });
            expect(compareFrames(still, renderLookReference(rgba as RawFrame, maskLook(source), 0, box).data).max, `${shape} static`).toBe(0);
            const keyed: LookSource = { ...source, trackType: "sticker", keyframesJson: KEYFRAMES };
            const seconds = 0.8;
            const frames = await runLook(host, rgba, keyed, { maskBox: box }, seconds);
            expect(frames.length).toBe(Math.round(seconds * FPS));
            let worst = { mean: 0, p999: 0 };
            frames.forEach((out, n) => {
                const expected = renderLookReference(rgba as RawFrame, maskLook(keyed), n / FPS, box).data;
                const diff = compareFrames(alphaOf(out), alphaOf(expected));
                worst = { mean: Math.max(worst.mean, diff.mean), p999: Math.max(worst.p999, diff.p999) };
                expect(compareFrames(colorOf(out), colorOf(expected)).max, `${shape} colour @${n}`).toBe(0);
            });
            expect(worst.mean, `${shape} keyframed`).toBeLessThanOrEqual(0.05);
            expect(worst.p999, `${shape} keyframed`).toBeLessThanOrEqual(1);
        }
    }, 600_000);

    it("a masked text clip in a compiled export: inside the circle the text, outside it (box and padding) the scene", async () => {
        const A = smooth(2, 1280, 720);
        // The raster: a 400×200 white box with a 20 px red half-transparent outline around it (the padding).
        const rw = 440;
        const rh = 240;
        const png = new Uint8Array(rw * rh * 4);
        for (let y = 0; y < rh; y += 1) {
            for (let x = 0; x < rw; x += 1) {
                const o = (y * rw + x) * 4;
                const inBox = x >= 20 && x < 420 && y >= 20 && y < 220;
                png.set(inBox ? [255, 255, 255, 255] : [255, 0, 0, 128], o);
            }
        }
        const text = clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, textContent: "Hi", positionX: 0.5, positionY: 0.5, maskJson: maskJson("circle", { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, feather: 0 }) });
        const wide = clip("w", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, textContent: "Hi", positionX: 0.5, positionY: 0.1, maskJson: maskJson("rectangle", { x: 0.5, y: 0.5, width: 5, height: 5, rotation: 0, feather: 0, roundness: 0 }) });
        const raster = { png: encodePng({ width: rw, height: rh, channels: 4, data: png }), width: rw, height: rh, boxWidth: 400, boxHeight: 200, pad: 20, scale: 1 };
        const plan = compileExport(input({ scenes: [scene("a", 0, 1, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png" })], clips: [text, wide] }), { resolution: "720p" }, {
            media: new Map([["/m/a.png", { durationSeconds: 0, hasVideo: true, hasAudio: false, width: A.width, height: A.height }]]),
            rasters: new Map([["text-t", { ...raster, id: "text-t" }], ["text-w", { ...raster, id: "text-w" }]]), gl: false,
        });
        const outW = plan.format.width;
        const frames = splitFrames(await runPlanVideo(host, plan, { "/m/a.png": encodePng({ width: A.width, height: A.height, channels: 3, data: A.data }) }), outW * plan.format.height * 3);
        const px = (frame: Uint8Array, x: number, y: number) => {
            const o = (y * outW + x) * 3;
            return [frame[o], frame[o + 1], frame[o + 2]];
        };
        const scenePx = (x: number, y: number) => [A.data[(y * 1280 + x) * 3], A.data[(y * 1280 + x) * 3 + 1], A.data[(y * 1280 + x) * 3 + 2]];
        const near = (got: number[], want: number[], tolerance = 6) => got.every((v, i) => Math.abs(v - want[i]) <= tolerance);
        for (const n of [0, 29]) {
            const frame = frames[n];
            // Box centre (640, 360), mask radius 0.25 × 200 = 50 px: the white text inside, the scene outside.
            expect(near(px(frame, 640, 360), [255, 255, 255]), `centre @${n}`).toBe(true);
            expect(near(px(frame, 640 + 120, 360), scenePx(760, 360)), `box outside the circle @${n}`).toBe(true);
            expect(near(px(frame, 640, 360 + 75), scenePx(640, 435)), `box below the circle @${n}`).toBe(true);
            // The outline (padding) is cut by the small circle...
            expect(near(px(frame, 640, 360 + 110), scenePx(640, 470)), `outline cut @${n}`).toBe(true);
            // ...and kept by a mask larger than the box: half-transparent red over the scene.
            const top = Math.round(0.1 * (720 - 200)) + 100; // the wide clip's box centre row
            const s = scenePx(640, top - 110);
            const red = [Math.round((255 * 128 + s[0] * 127) / 255), Math.round((s[1] * 127) / 255), Math.round((s[2] * 127) / 255)];
            expect(near(px(frame, 640, top - 110), red, 10), `outline kept @${n}`).toBe(true);
        }
    }, 300_000);
});

