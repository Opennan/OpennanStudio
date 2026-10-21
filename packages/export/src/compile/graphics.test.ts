import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { drawGraphicsFrame } from "@opennan/timeline-core/graphics/render";
import { describe, expect, it } from "vitest";
import { createCanvasRasterizer, type RasterCanvas } from "../raster/canvas-rasterizer";
import { graphicsJobId, planGraphicsJobs } from "../raster/jobs";
import { exportFormat, compileExport, staticExportWarnings, exportLength } from "./index";
import { clip, COMPILE_OPTIONS, input, scene } from "./test-helpers";
import type { GraphicsRasterJob, RasterResult } from "../types";

const graphic = (patch: Record<string, unknown> = {}) =>
    clip("g", { trackType: "remotion", trackIndex: 1, startTime: 1, endTime: 2, remotionTemplateId: "lower-third", ...patch });
const doc = (clips = [graphic()]) => input({ scenes: [scene("a", 0, 3)], clips });

const canvases: Canvas[] = [];
const rasterizer = createCanvasRasterizer({
    createCanvas: (w, h) => {
        const canvas = createCanvas(w, h);
        canvases.push(canvas);
        return canvas as unknown as RasterCanvas;
    },
    encodePng: async (canvas) => new Uint8Array((canvas as unknown as Canvas).toBuffer("image/png")),
});

describe("graphics raster jobs", () => {
    const format = exportFormat(doc(), { resolution: "720p" });
    const { frameCount } = exportLength(doc(), format);

    it("one entry per output frame with start ≤ k/fps < end, from the clip's first frame", () => {
        const [job] = planGraphicsJobs(doc().clips, format, frameCount);
        expect(job).toMatchObject({ kind: "graphics", id: graphicsJobId("g"), templateId: "lower-third", firstFrame: 30, width: 1280, height: 720 });
        expect(job.frames).toHaveLength(30);
        expect(job.frames[0]).toMatchObject({ frame: 0, opacity: 1, matrix: [1, 0, -0, 1, 0, 0] });
        expect(job.frames[29]!.frame).toBe(29);
    });

    it("limits the entries to a window and leaves out custom-code and unknown graphics", () => {
        const [job] = planGraphicsJobs(doc().clips, format, frameCount, { first: 40, last: 41 });
        expect(job.firstFrame).toBe(40);
        expect(job.frames.map((entry) => entry!.frame)).toEqual([10, 11]);
        expect(planGraphicsJobs(doc().clips, format, frameCount, { first: 70, last: 80 })).toEqual([]);
        expect(planGraphicsJobs([graphic({ remotionCode: "export default 1" }), graphic({ remotionTemplateId: "nope" })], format, frameCount)).toEqual([]);
    });

    it("bakes placement and opacity: a hidden layer is null, a moved one has its matrix", () => {
        const faded = planGraphicsJobs([graphic({ opacity: 0 })], format, frameCount);
        expect(faded).toEqual([]);
        const [moved] = planGraphicsJobs([graphic({ positionX: 1, scale: 0.5 })], format, frameCount);
        // Centre moves right by half the frame; half size.
        expect(moved.frames[0]!.matrix.map((v) => Math.round(v * 1000) / 1000)).toEqual([0.5, 0, -0, 0.5, 960, 180]);
    });
});

describe("graphics raster sequences", () => {
    it("draws each entry as a full-frame PNG, sharing equal entries", async () => {
        const format = exportFormat(doc(), { resolution: "720p" });
        const job: GraphicsRasterJob = {
            ...planGraphicsJobs(doc().clips, format, exportLength(doc(), format).frameCount)[0],
        };
        job.frames = [job.frames[0], job.frames[25], job.frames[25], null];
        const result = await rasterizer.rasterize(job);
        expect(result.sequence).toHaveLength(4);
        expect(result.sequence![1]).toBe(result.sequence![2]);
        expect(result.sequence![0]).not.toBe(result.sequence![1]);
        expect(result.firstFrame).toBe(30);
        expect(result).toMatchObject({ width: 1280, height: 720, scale: 1 });
    });

    it("the PNG holds the template frame at the placement the preview uses", async () => {
        const format = exportFormat(doc(), { resolution: "720p" });
        const job = planGraphicsJobs(doc().clips, format, exportLength(doc(), format).frameCount)[0];
        job.frames = [job.frames[25]];
        canvases.length = 0;
        await rasterizer.rasterize(job);
        const out = canvases[1];
        const reference = createCanvas(1280, 720);
        const bounds = drawGraphicsFrame(reference.getContext("2d") as never, { trackType: "remotion", startTime: 1, endTime: 2, remotionTemplateId: "lower-third", remotionPropsJson: null, remotionCode: null }, { width: 1280, height: 720, frame: 25 })!;
        const x = Math.round(bounds.x + bounds.width - 12);
        const y = Math.round(bounds.y + 10);
        expect([...out.getContext("2d").getImageData(x, y, 1, 1).data]).toEqual([...reference.getContext("2d").getImageData(x, y, 1, 1).data]);
        expect(out.getContext("2d").getImageData(x, y, 1, 1).data[3]).toBe(255);
    });
});

describe("graphics images (logo-sting)", () => {
    const logo = (patch: Record<string, unknown> = {}) => clip("l", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 1, remotionTemplateId: "logo-sting", remotionPropsJson: JSON.stringify({ logoUrl: "https://cdn.test/logo.png", text: "Brand" }), ...patch });
    const jobFor = () => {
        const doc = input({ scenes: [scene("a", 0, 1)], clips: [logo()] });
        const format = exportFormat(doc, { resolution: "720p" });
        const job = planGraphicsJobs(doc.clips, format, exportLength(doc, format).frameCount)[0];
        return { ...job, frames: job.frames.slice(0, 2) };
    };
    const rasterizerWith = (loadImage: (url: string) => Promise<unknown>) => createCanvasRasterizer({
        createCanvas: (w, h) => createCanvas(w, h) as unknown as RasterCanvas,
        encodePng: async (canvas) => new Uint8Array((canvas as unknown as Canvas).toBuffer("image/png")),
        loadImage,
    });

    it("draws without an image that fails to load or cannot be drawn (it would taint the canvas), and reports it", async () => {
        const failed = await rasterizerWith(async () => { throw new Error("blocked"); }).rasterize(jobFor());
        expect(failed.missingAssets).toEqual(["https://cdn.test/logo.png"]);
        expect(failed.sequence).toHaveLength(2);
        const unusable = await rasterizerWith(async () => ({ not: "an image" })).rasterize(jobFor());
        expect(unusable.missingAssets).toEqual(["https://cdn.test/logo.png"]);
        const image = createCanvas(4, 4);
        const fine = await rasterizerWith(async () => image).rasterize(jobFor());
        expect(fine.missingAssets).toBeUndefined();
    });

    it("the export warns when a graphic is drawn without its image", () => {
        const doc = input({ scenes: [scene("a", 0, 1)], clips: [logo()] });
        const raster: RasterResult = {
            id: "graphics-l", png: new Uint8Array([0]), width: 1280, height: 720, boxWidth: 1280, boxHeight: 720, pad: 0, scale: 1,
            sequence: [new Uint8Array([0])], firstFrame: 0, missingAssets: ["https://cdn.test/logo.png"],
        };
        const plan = compileExport(doc, { resolution: "720p" }, { ...COMPILE_OPTIONS, media: new Map([["/m/a.webm", { durationSeconds: 1, hasVideo: true, hasAudio: false, width: 640, height: 360 }]]), rasters: new Map([["graphics-l", raster]]) });
        expect(plan.warnings).toContainEqual(expect.objectContaining({ code: "graphics-asset-missing", clipId: "l" }));
    });
});

describe("graphics in the ffmpeg graph", () => {
    const sequence = (n: number) => Array.from({ length: n }, (_, i) => new Uint8Array([i]));
    const rasters = (extra: Record<string, RasterResult>) => new Map([...COMPILE_OPTIONS.rasters, ...Object.entries(extra)]);
    const gfx = (firstFrame: number, n: number): RasterResult => ({
        id: "graphics-g", png: new Uint8Array([0]), width: 1280, height: 720, boxWidth: 1280, boxHeight: 720, pad: 0, scale: 1, sequence: sequence(n), firstFrame,
    });

    it("adds an image-sequence input overlaid over exactly its frames, below text", () => {
        const text = clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hi" });
        const plan = compileExport(doc([graphic(), text]), { resolution: "720p" }, { ...COMPILE_OPTIONS, media: new Map([["/m/a.webm", { durationSeconds: 3, hasVideo: true, hasAudio: false, width: 640, height: 360 }]]), rasters: rasters({ "graphics-g": gfx(30, 30) }) });
        const input = plan.inputs.find((entry) => entry.source === "gfx0-%05d.png");
        expect(input).toEqual({ kind: "file", source: "gfx0-%05d.png", options: ["-f", "image2", "-framerate", "30", "-start_number", "0"] });
        expect(plan.files.filter((file) => file.name.startsWith("gfx0-")).map((file) => file.name).slice(0, 2)).toEqual(["gfx0-00000.png", "gfx0-00001.png"]);
        expect(plan.files.filter((file) => file.name.startsWith("gfx0-"))).toHaveLength(30);
        expect(plan.filterGraph).toContain("setpts=PTS-STARTPTS+1/TB");
        expect(plan.filterGraph).toMatch(/overlay=0:0:eof_action=pass:format=auto:enable='between\(t,0\.98333\d*,1\.98333\d*\)'/);
        // Text overlays come after the graphic.
        const at = (source: string) => plan.inputs.findIndex((entry) => entry.source.startsWith(source));
        expect(at("raster-")).toBeGreaterThan(at("gfx0-"));
        expect(plan.warnings.filter((w) => w.code === "remotion-unsupported")).toEqual([]);
    });

    it("warns when no rasterizer drew the graphic, and for custom code or unknown templates", () => {
        const plan = compileExport(doc(), { resolution: "720p" }, { ...COMPILE_OPTIONS, media: new Map([["/m/a.webm", { durationSeconds: 3, hasVideo: true, hasAudio: false, width: 640, height: 360 }]]) });
        expect(plan.warnings.map((w) => w.code)).toContain("remotion-unsupported");
        expect(plan.inputs.some((entry) => entry.source.startsWith("gfx"))).toBe(false);
        expect(staticExportWarnings(doc(), { gl: true })).toEqual([]);
        expect(staticExportWarnings(doc([graphic({ remotionCode: "x" })]), { gl: true })[0]).toMatchObject({ code: "remotion-unsupported", clipId: "g" });
        expect(staticExportWarnings(doc([graphic({ remotionTemplateId: "zzz" })]), { gl: true })[0].message).toMatch(/template/);
    });
});
