import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage, type Canvas } from "@napi-rs/canvas";
import { stickerDataUrl } from "@opennan/timeline-core/stickers/catalog";
import { textTemplateById } from "@opennan/timeline-core/text/templates";
import { textStatePlan } from "@opennan/timeline-core/text/text-states";
import type { RasterJob } from "../types";
import { MAX_ATLAS_SIDE } from "../motion/text-atlas";
import { createCanvasRasterizer, type CanvasRasterizerOptions, type RasterCanvas } from "./canvas-rasterizer";

const require = createRequire(import.meta.url);
const GOLDEN = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
GlobalFonts.registerFromPath(GOLDEN, "OpenNan Golden");

// The bundled Montserrat 900 the web app ships (apps/web @fontsource/montserrat), registered from its woff2;
// the golden DejaVu face stands in when the web app's dependencies are not installed.
const MONTSERRAT_WOFF2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/node_modules/@fontsource/montserrat/files/montserrat-latin-900-normal.woff2");
const BUNDLED_FONT = existsSync(MONTSERRAT_WOFF2) ? MONTSERRAT_WOFF2 : GOLDEN;
GlobalFonts.registerFromPath(BUNDLED_FONT, "Montserrat");

/** @napi-rs/canvas decodes SVG from bytes (not from a percent-encoded data: URL). */
const loadDataUrl = (url: string) => loadImage(Buffer.from(decodeURIComponent(url.slice(url.indexOf(",") + 1)), "utf8"));

let lastCanvas: Canvas | null = null;
const baseOptions: CanvasRasterizerOptions = {
    createCanvas: (w, h) => createCanvas(w, h) as unknown as RasterCanvas,
    encodePng: async (canvas) => {
        lastCanvas = canvas as unknown as Canvas;
        return new Uint8Array(lastCanvas.toBuffer("image/png"));
    },
    loadImage: loadDataUrl,
};
const rasterizer = createCanvasRasterizer(baseOptions);

function pngSize(png: Uint8Array): [number, number] {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    return [view.getUint32(16), view.getUint32(20)];
}

/** Summed alpha of a rectangle of the last encoded canvas. */
function ink(x: number, y: number, w: number, h: number): number {
    const data = lastCanvas!.getContext("2d").getImageData(x, y, w, h).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    return sum;
}

const textJob = (patch: Partial<Extract<RasterJob, { kind: "text" }>>): Extract<RasterJob, { kind: "text" }> => ({
    kind: "text", id: "text-c1", clipId: "c1", text: "Hello export", textStyle: null, scale: 1, frameScale: 1, frameWidth: 1920, ...patch,
});

describe("createCanvasRasterizer", () => {
    it("draws text into a padded PNG whose box is the preview layout box", async () => {
        const result = await rasterizer.rasterize(textJob({ textStyle: JSON.stringify({ fontSize: 48, fontFamily: "OpenNan Golden", bgColor: "rgba(0,0,0,0.5)" }) }));
        expect(result.id).toBe("text-c1");
        expect(result).not.toHaveProperty("fileName");
        expect(result).not.toHaveProperty("atlas");
        expect(Array.from(result.png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
        expect(pngSize(result.png)).toEqual([result.width, result.height]);
        expect(result.boxHeight).toBeCloseTo(48 * 1.3);
        expect(result.width).toBe(Math.ceil(result.boxWidth + result.pad * 2));
    });

    it("caps a huge single text bitmap at the atlas side, drawn scaled down, and reports the unshrunk box", async () => {
        // A scale peak of 40 on 400 px text: the padded box is far beyond what a canvas (and checkRasterResult) takes.
        const job = textJob({ text: "Huge", textStyle: JSON.stringify({ fontSize: 400, fontFamily: "OpenNan Golden" }), scale: 40, frameWidth: 1920 });
        const result = await rasterizer.rasterize(job);
        expect(Math.max(result.width, result.height)).toBe(MAX_ATLAS_SIDE);
        expect(pngSize(result.png)).toEqual([result.width, result.height]);
        expect(result).not.toHaveProperty("atlas");
        const fullW = Math.ceil(result.boxWidth + result.pad * 2);
        const fullH = Math.ceil(result.boxHeight + result.pad * 2);
        expect(Math.max(fullW, fullH)).toBeGreaterThan(MAX_ATLAS_SIDE);
        // Uniform shrink (aspect kept to the pixel) and the glyphs still land inside.
        expect(result.width / fullW).toBeCloseTo(result.height / fullH, 2);
        expect(ink(0, 0, result.width, result.height)).toBeGreaterThan(0);
    });

    it("caps a huge emoji bitmap the same way", async () => {
        const result = await rasterizer.rasterize({ kind: "emoji", id: "emoji-s1", clipId: "s1", text: "★", scale: 200, frameScale: 1 });
        expect(result.width).toBe(MAX_ATLAS_SIDE);
        expect(result.height).toBe(MAX_ATLAS_SIDE);
        expect(Math.ceil(result.boxWidth + result.pad * 2)).toBeGreaterThan(MAX_ATLAS_SIDE);
    });

    it("draws emoji stickers in a square around the 1.2× box", async () => {
        const result = await rasterizer.rasterize({ kind: "emoji", id: "emoji-s1", clipId: "s1", text: "★", scale: 1, frameScale: 0.5 });
        expect(result.boxWidth).toBeCloseTo(38.4);
        expect(result.width).toBe(result.height);
    });
});

describe("createCanvasRasterizer: text state atlases", () => {
    const template = textTemplateById("title_bold")!;
    const style = JSON.stringify(template.style);
    const states = textStatePlan({ textContent: "Hi!", textStyle: style, animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }), startTime: 0, endTime: 2 }).states;

    it("draws a template with the bundled font, one cell per state, in an atlas grid", async () => {
        expect(states.map((s) => s.kind)).toEqual(["full", "typewriter", "typewriter", "typewriter"]);
        const result = await rasterizer.rasterize(textJob({ text: "Hi!", textStyle: style, states, frameScale: 0.5, frameWidth: 960 }));
        const atlas = result.atlas!;
        expect(atlas.count).toBe(4);
        expect(atlas.cols * atlas.rows).toBeGreaterThanOrEqual(4);
        expect(pngSize(result.png)).toEqual([result.width, result.height]);
        expect([result.width, result.height]).toEqual([atlas.cols * atlas.cellWidth, atlas.rows * atlas.cellHeight]);
        // No shrinking needed: a cell is the padded box of the single-bitmap path.
        expect(atlas.cellWidth).toBe(Math.ceil(result.boxWidth + result.pad * 2));
        expect(atlas.cellHeight).toBe(Math.ceil(result.boxHeight + result.pad * 2));
        expect(result.boxHeight).toBeCloseTo(96 * 0.5 * 1.3);
        const cell = (i: number) => ink((i % atlas.cols) * atlas.cellWidth, Math.floor(i / atlas.cols) * atlas.cellHeight, atlas.cellWidth, atlas.cellHeight);
        const inks = [0, 1, 2, 3].map(cell);
        // full > two glyphs > one glyph > none (the template has no background box).
        expect(inks[1]).toBe(0);
        expect(inks[2]).toBeGreaterThan(0);
        expect(inks[3]).toBeGreaterThan(inks[2]);
        expect(inks[0]).toBeGreaterThan(inks[3]);
    });

    it("uses the bundled face (its metrics differ from the fallback face)", async () => {
        const bundled = await rasterizer.rasterize(textJob({ text: "Hi!", textStyle: style, states }));
        const fallback = await rasterizer.rasterize(textJob({ text: "Hi!", textStyle: JSON.stringify({ ...template.style, fontFamily: "No Such Family, sans-serif" }), states }));
        if (BUNDLED_FONT === MONTSERRAT_WOFF2) expect(bundled.boxWidth).not.toBeCloseTo(fallback.boxWidth, 0);
    });

    it("blurs blur states through the createCanvas helper and keeps every cell non-empty", async () => {
        const blur = textStatePlan({ textContent: "Blur", textStyle: style, animationJson: JSON.stringify({ in: { id: "blur_in", duration: 0.5 } }), startTime: 0, endTime: 2 }).states;
        expect(blur.length).toBeGreaterThan(2);
        const result = await rasterizer.rasterize(textJob({ text: "Blur", textStyle: style, states: blur, frameScale: 0.5, frameWidth: 960 }));
        const atlas = result.atlas!;
        for (let i = 0; i < atlas.count; i += 1) {
            expect(ink((i % atlas.cols) * atlas.cellWidth, Math.floor(i / atlas.cols) * atlas.cellHeight, atlas.cellWidth, atlas.cellHeight), `cell ${i}`).toBeGreaterThan(0);
        }
    });

    it("shrinks the grid to the atlas side limit and reports the unshrunk box", async () => {
        const text = "A long typewriter line";
        const big = JSON.stringify({ ...template.style, fontSize: 300 });
        const many = textStatePlan({ textContent: text, textStyle: big, animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }), startTime: 0, endTime: 2 }).states;
        const result = await rasterizer.rasterize(textJob({ text, textStyle: big, states: many }));
        const atlas = result.atlas!;
        expect(atlas.count).toBe(many.length);
        expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_ATLAS_SIDE);
        expect(atlas.cellWidth).toBeLessThan(Math.ceil(result.boxWidth + result.pad * 2));
        expect(atlas.cellWidth / Math.ceil(result.boxWidth + result.pad * 2)).toBeCloseTo(atlas.cellHeight / Math.ceil(result.boxHeight + result.pad * 2), 1);
        expect(result.scale).toBe(1);
    });
});

describe("createCanvasRasterizer: fonts", () => {
    it("loads the bundled faces of a text job before drawing and survives a failing loader", async () => {
        const calls: unknown[] = [];
        const loading = createCanvasRasterizer({ ...baseOptions, loadFonts: async (faces) => { calls.push(faces); } });
        await loading.rasterize(textJob({ textStyle: JSON.stringify(textTemplateById("title_bold")!.style) }));
        expect(calls).toEqual([[{ family: "Montserrat", weight: 900, style: "normal" }]]);
        await loading.rasterize(textJob({ textStyle: JSON.stringify({ fontFamily: "OpenNan Golden" }) }));
        expect(calls).toHaveLength(1);

        const failing = createCanvasRasterizer({ ...baseOptions, loadFonts: async () => { throw new Error("offline"); } });
        await expect(failing.rasterize(textJob({ textStyle: JSON.stringify(textTemplateById("title_bold")!.style) }))).resolves.toMatchObject({ id: "text-c1" });
    });
});

describe("createCanvasRasterizer: bundled stickers", () => {
    it("draws the sticker SVG at the job size through the injected image loader", async () => {
        const urls: string[] = [];
        const stickers = createCanvasRasterizer({ ...baseOptions, loadImage: (url) => { urls.push(url); return loadDataUrl(url); } });
        const result = await stickers.rasterize({ kind: "sticker", id: "sticker-s", clipId: "s", stickerId: "twemoji:1f525", scale: 1.5, width: 120, height: 120 });
        expect(urls).toEqual([stickerDataUrl("twemoji:1f525", { width: 120, height: 120 })]);
        expect(result).toMatchObject({ id: "sticker-s", width: 120, height: 120, boxWidth: 120, boxHeight: 120, pad: 0, scale: 1.5 });
        expect(pngSize(result.png)).toEqual([120, 120]);
        expect(ink(0, 0, 120, 120)).toBeGreaterThan(120 * 120 * 255 * 0.2);
        expect(ink(0, 0, 4, 4)).toBe(0);
    });

    it("refuses unknown stickers and hosts without an image loader", async () => {
        const job = { kind: "sticker", id: "sticker-s", clipId: "s", stickerId: "opennan:nope", scale: 1, width: 10, height: 10 } as const;
        await expect(rasterizer.rasterize(job)).rejects.toThrow("unknown sticker");
        const noLoader = createCanvasRasterizer({ createCanvas: baseOptions.createCanvas, encodePng: baseOptions.encodePng });
        await expect(noLoader.rasterize({ ...job, stickerId: "twemoji:1f525" })).rejects.toThrow("loadImage");
    });
});
