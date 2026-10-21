// Built-in graphics clips (phase 10d) on native ffmpeg and ffmpeg.wasm: the compiled image-sequence overlay shows,
// at every output frame, exactly the pixels the shared Canvas 2D frame (raster/graphics-frame.ts) draws for that
// frame — nothing before the clip, nothing after it, the template frame and placement of that output frame.
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { encodePng } from "@opennan/timeline-core/looks/png";
import { describe, expect, it } from "vitest";
import { compileExport, exportFormat, exportLength } from "../src/compile";
import { clip as makeClip, input, scene } from "../src/compile/test-helpers";
import { createCanvasRasterizer, type RasterCanvas } from "../src/raster/canvas-rasterizer";
import { drawGraphicsEntry, type GraphicsCanvasPair } from "../src/raster/graphics-frame";
import { graphicsFrameEntry, planGraphicsJobs } from "../src/raster/jobs";
import type { RasterResult } from "../src/types";
import { ffmpegHosts } from "./ffmpeg";
import { splitFrames } from "./frames";
import { runPlanVideo } from "./plan-runner";

const hosts = await ffmpegHosts();
const black = encodePng({ width: 64, height: 36, channels: 3, data: new Uint8Array(64 * 36 * 3) });
const media = new Map([["/m/a.png", { durationSeconds: 0, hasVideo: true, hasAudio: false, width: 64, height: 36 }]]);
const rasterizer = createCanvasRasterizer({
    createCanvas: (w, h) => createCanvas(w, h) as unknown as RasterCanvas,
    encodePng: async (canvas) => new Uint8Array((canvas as unknown as Canvas).toBuffer("image/png")),
});

/** The expected frame k: the shared graphics frame (RGBA, unpremultiplied) on a canvas. */
function expectedFrame(graphic: ReturnType<typeof makeClip>, k: number, format: { fps: number; width: number; height: number }): Canvas {
    const layer = createCanvas(format.width, format.height);
    const out = createCanvas(format.width, format.height);
    const pair: GraphicsCanvasPair = { width: format.width, height: format.height, layer: layer as never, layerContext: layer.getContext("2d") as never, out: out.getContext("2d") as never };
    const visible = k >= Math.ceil(graphic.startTime * format.fps - 1e-6) && k < Math.ceil(graphic.endTime * format.fps - 1e-6);
    drawGraphicsEntry(pair, { templateId: graphic.remotionTemplateId!, propsJson: graphic.remotionPropsJson ?? null, startTime: graphic.startTime, endTime: graphic.endTime }, visible ? graphicsFrameEntry(graphic, k, format) : null, null);
    return out;
}

/** BT.601 luma of the frame pixel over black (the export's yuv420p keeps luma at full resolution). */
function luma(canvas: Canvas, x: number, y: number): number {
    const [r, g, b, a] = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
    return ((0.299 * r + 0.587 * g + 0.114 * b) * a) / 255;
}

/** A pixel deep inside the painted area of `canvas` (its 9 × 9 neighbourhood equally and clearly opaque). */
function interiorPixel(canvas: Canvas): [number, number] {
    const { width, height } = canvas;
    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    for (let y = 8; y < height - 8; y += 4) {
        for (let x = 8; x < width - 8; x += 4) {
            let solid = true;
            const alpha = data[(y * width + x) * 4 + 3];
            if (alpha < 100) continue;
            for (let dy = -4; dy <= 4 && solid; dy += 1) for (let dx = -4; dx <= 4 && solid; dx += 1) solid = data[((y + dy) * width + x + dx) * 4 + 3] === alpha;
            if (solid) return [x, y];
        }
    }
    throw new Error("nothing painted");
}

const CASES: Array<[string, Record<string, unknown>]> = [
    ["lower third entering and leaving", {}],
    ["moved, scaled, rotated, and faded", { positionX: 0.7, positionY: 0.4, scale: 0.8, rotationDegrees: 10, opacity: 0.6 }],
];

describe.each(hosts.map((h) => [h.name, h] as const))("graphics clips on %s", (_name, host) => {
    for (const [name, patch] of CASES) {
        it(`${name}: every output frame shows the shared Canvas 2D frame`, async () => {
            const graphic = makeClip("g", { trackType: "remotion", trackIndex: 1, startTime: 0.5, endTime: 1.5, remotionTemplateId: "lower-third", ...patch });
            const doc = input({ scenes: [scene("a", 0, 2, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png" })], clips: [graphic] });
            const format = exportFormat(doc, { resolution: "720p" });
            const { frameCount } = exportLength(doc, format);
            const rasters = new Map<string, RasterResult>();
            for (const job of planGraphicsJobs(doc.clips, format, frameCount)) rasters.set(job.id, await rasterizer.rasterize(job));
            const plan = compileExport(doc, { resolution: "720p" }, { media, rasters, gl: false });
            // Points inside the settled graphic (the entrance and exit slide through them).
            const settled = expectedFrame(graphic, 30, format);
            const [ix, iy] = interiorPixel(settled);
            const probes: Array<[number, number]> = [[ix, iy], [ix + 60, iy + 4]];
            const frames = new Map<string, Uint8Array[]>();
            for (const [px, py] of probes) {
                const raw = await runPlanVideo(host, plan, { "/m/a.png": black }, `format=gray,crop=1:1:${px}:${py}`);
                frames.set(`${px},${py}`, splitFrames(raw, 3));
            }
            let painted = 0;
            for (let k = 0; k < frameCount; k += 1) {
                const expected = expectedFrame(graphic, k, format);
                for (const [px, py] of probes) {
                    const got = frames.get(`${px},${py}`)!;
                    expect(got).toHaveLength(frameCount);
                    // gray = limited-range luma expanded back to full range by swscale: compare as full range.
                    const want = luma(expected, px, py);
                    if (want > 30) painted += 1;
                    expect(Math.abs(got[k][0] - want), `frame ${k} (${px},${py}): ${got[k][0]} vs ${want.toFixed(1)}`).toBeLessThanOrEqual(8);
                }
            }
            expect(painted).toBeGreaterThan(20);
        });
    }
});
