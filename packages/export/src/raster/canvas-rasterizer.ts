// Draws RasterJobs with any Canvas 2D implementation: the browser (createBrowserRasterizer in
// @opennan/export/web, the desktop renderer's bridge) or @napi-rs/canvas in Node tests. Text uses the
// preview's own layout and drawing code (timeline-core lib/preview-text-draw.ts); animated text draws
// every raster state into one atlas; bundled stickers draw their catalog SVG.
import {
    drawPreviewTextBlock, drawPreviewTextState, layoutPreviewTextBlock, previewTextBlockBleed, type PreviewTextBlockInput, type PreviewTextContext,
} from "@opennan/timeline-core/lib/preview-text-draw";
import { GRAPHICS_FONT_FACES } from "@opennan/timeline-core/graphics/draw/helpers";
import { graphicsAssetUrls } from "@opennan/timeline-core/graphics/render";
import type { GraphicsAssets, GraphicsContext } from "@opennan/timeline-core/graphics/types";
import { stickerDataUrl } from "@opennan/timeline-core/stickers/catalog";
import { fontFacesForStyle, type TextFontFace } from "@opennan/timeline-core/text/fonts";
import { atlasLayout, type TextState } from "@opennan/timeline-core/text/text-states";
import { MAX_ATLAS_SIDE } from "../motion/text-atlas";
import type { GraphicsRasterJob, RasterJob, RasterResult } from "../types";
import { drawGraphicsEntry, graphicsEntryKey, type GraphicsCanvasPair } from "./graphics-frame";

export interface RasterCanvas {
    width: number;
    height: number;
    getContext(contextId: "2d"): unknown;
}

export interface CanvasRasterizerOptions {
    createCanvas(width: number, height: number): RasterCanvas;
    encodePng(canvas: RasterCanvas): Promise<Uint8Array>;
    /**
     * Loads the bundled font faces a text job uses (browsers: `document.fonts.load`). Called before every text
     * job that names bundled faces; a rejection is ignored (the canvas draws with fallback fonts).
     */
    loadFonts?(faces: TextFontFace[]): Promise<void>;
    /** Decodes an image URL (a sticker's `data:` SVG) into something `drawImage` accepts. Required for sticker jobs. */
    loadImage?(url: string): Promise<unknown>;
}

export interface OverlayRasterizer {
    rasterize(job: RasterJob): Promise<RasterResult>;
}

type Context = PreviewTextContext & {
    save(): void;
    restore(): void;
    translate(x: number, y: number): void;
    scale(x: number, y: number): void;
    beginPath(): void;
    rect(x: number, y: number, w: number, h: number): void;
    clip(): void;
    drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
};

function context(canvas: RasterCanvas): Context {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    return ctx as Context;
}

type TextJob = Extract<RasterJob, { kind: "text" }>;

/**
 * The bitmap size of a single (non-atlas) raster: its padded box, shrunk uniformly to at most MAX_ATLAS_SIDE per
 * side (scale peaks or large style numbers can ask for more than a canvas or checkRasterResult takes). The result
 * still reports the unshrunk box and pad; compile (rasterGeometry) scales the smaller stream back up to the box,
 * as it does for shrunk atlas cells.
 */
function cappedSize(width: number, height: number): { width: number; height: number; sx: number; sy: number } {
    const shrink = Math.min(1, MAX_ATLAS_SIDE / width, MAX_ATLAS_SIDE / height);
    if (shrink >= 1) return { width, height, sx: 1, sy: 1 };
    const w = Math.max(1, Math.min(MAX_ATLAS_SIDE, Math.floor(width * shrink + 1e-9)));
    const h = Math.max(1, Math.min(MAX_ATLAS_SIDE, Math.floor(height * shrink + 1e-9)));
    return { width: w, height: h, sx: w / width, sy: h / height };
}

async function loadFaces(options: CanvasRasterizerOptions, textStyle: string | null): Promise<void> {
    const faces = fontFacesForStyle(textStyle);
    if (faces.length === 0 || !options.loadFonts) return;
    try {
        await options.loadFonts(faces);
    } catch {
        // Fallback fonts: the bitmap still draws, as the preview does before a face arrives.
    }
}

async function rasterizeText(options: CanvasRasterizerOptions, job: TextJob): Promise<RasterResult> {
    await loadFaces(options, job.textStyle);
    const blockInput: PreviewTextBlockInput = { text: job.text, textStyle: job.textStyle, scale: job.scale, frameScale: job.frameScale, frameWidth: job.frameWidth };
    const measured = layoutPreviewTextBlock(context(options.createCanvas(1, 1)), blockInput);
    const states = job.states && job.states.length > 0 ? job.states : null;
    const pad = previewTextBlockBleed(measured, states ?? undefined);
    const width = Math.max(1, Math.ceil(measured.width + pad * 2));
    const height = Math.max(1, Math.ceil(measured.height + pad * 2));
    if (!states) {
        const size = cappedSize(width, height);
        const canvas = options.createCanvas(size.width, size.height);
        const ctx = context(canvas);
        const block = layoutPreviewTextBlock(ctx, blockInput);
        if (size.sx !== 1 || size.sy !== 1) ctx.scale(size.sx, size.sy);
        drawPreviewTextBlock(ctx, block, pad, pad);
        return {
            id: job.id, png: await options.encodePng(canvas), width: size.width, height: size.height,
            boxWidth: block.width, boxHeight: block.height, pad, scale: job.scale,
        };
    }
    return drawAtlas(options, job, blockInput, states, pad, width, height);
}

/** Every state in one grid, cell i = states[i]; cells shrink uniformly when the grid exceeds MAX_ATLAS_SIDE. */
async function drawAtlas(
    options: CanvasRasterizerOptions, job: TextJob, blockInput: PreviewTextBlockInput, states: TextState[], pad: number, width: number, height: number,
): Promise<RasterResult> {
    const layout = atlasLayout(states.length, width, height, MAX_ATLAS_SIDE);
    const canvas = options.createCanvas(layout.width, layout.height);
    const ctx = context(canvas);
    const block = layoutPreviewTextBlock(ctx, blockInput);
    const helpers = { createCanvas: options.createCanvas };
    const sx = layout.cellWidth / width;
    const sy = layout.cellHeight / height;
    states.forEach((state, i) => {
        const x = (i % layout.cols) * layout.cellWidth;
        const y = Math.floor(i / layout.cols) * layout.cellHeight;
        ctx.save();
        // Nothing a state paints (glow, shadow, letter travel) may reach a neighbouring cell.
        ctx.beginPath();
        ctx.rect(x, y, layout.cellWidth, layout.cellHeight);
        ctx.clip();
        ctx.translate(x, y);
        if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
        drawPreviewTextState(ctx, block, pad, pad, state, helpers);
        ctx.restore();
    });
    return {
        id: job.id, png: await options.encodePng(canvas), width: layout.width, height: layout.height,
        boxWidth: block.width, boxHeight: block.height, pad, scale: job.scale,
        atlas: { cols: layout.cols, rows: layout.rows, cellWidth: layout.cellWidth, cellHeight: layout.cellHeight, count: states.length },
    };
}

async function rasterizeSticker(options: CanvasRasterizerOptions, job: Extract<RasterJob, { kind: "sticker" }>): Promise<RasterResult> {
    const width = Math.max(1, Math.round(job.width));
    const height = Math.max(1, Math.round(job.height));
    const url = stickerDataUrl(job.stickerId, { width, height });
    if (!url) throw new Error(`unknown sticker ${job.stickerId}`);
    if (!options.loadImage) throw new Error("sticker jobs need a loadImage option on this rasterizer");
    const image = await options.loadImage(url);
    const canvas = options.createCanvas(width, height);
    context(canvas).drawImage(image, 0, 0, width, height);
    return { id: job.id, png: await options.encodePng(canvas), width, height, boxWidth: width, boxHeight: height, pad: 0, scale: job.scale };
}

/**
 * The images a graphics job's template draws (logo-sting's logo), decoded once. An image that fails to load, or that
 * would taint the canvas (a cross-origin image without CORS, which makes the PNG encode throw), is left out: the
 * graphic draws without it and the URL is reported in `missing`.
 */
async function graphicsAssets(options: CanvasRasterizerOptions, job: GraphicsRasterJob): Promise<{ assets: GraphicsAssets; missing: string[] }> {
    const images = new Map<string, CanvasImageSource>();
    const missing: string[] = [];
    for (const url of graphicsAssetUrls({ remotionTemplateId: job.templateId, remotionPropsJson: job.propsJson })) {
        try {
            if (!options.loadImage) throw new Error("no image loader"); // i18n-ignore
            const image = (await options.loadImage(url)) as CanvasImageSource;
            // Reading a pixel back throws for a tainting image: better now than when the PNG is encoded.
            const probe = context(options.createCanvas(1, 1)) as unknown as GraphicsContext & { getImageData(x: number, y: number, w: number, h: number): unknown };
            probe.drawImage(image, 0, 0, 1, 1);
            probe.getImageData(0, 0, 1, 1);
            images.set(url, image);
        } catch {
            missing.push(url);
        }
    }
    return { assets: { image: (url) => images.get(url) ?? null }, missing };
}

/** A graphics clip's image sequence (graphics-frame.ts per entry); equal entries share one PNG. */
async function rasterizeGraphics(options: CanvasRasterizerOptions, job: GraphicsRasterJob): Promise<RasterResult> {
    if (options.loadFonts) {
        try {
            await options.loadFonts([...GRAPHICS_FONT_FACES]);
        } catch {
            // Fallback fonts, as for text.
        }
    }
    const { assets, missing } = await graphicsAssets(options, job);
    const width = Math.max(1, Math.round(job.width));
    const height = Math.max(1, Math.round(job.height));
    const layerCanvas = options.createCanvas(width, height);
    const outCanvas = options.createCanvas(width, height);
    const pair: GraphicsCanvasPair = {
        width, height, layer: layerCanvas as unknown as CanvasImageSource,
        layerContext: context(layerCanvas) as unknown as GraphicsContext, out: context(outCanvas) as unknown as GraphicsContext,
    };
    const byKey = new Map<string, Uint8Array>();
    const sequence: Uint8Array[] = [];
    for (const entry of job.frames) {
        const key = graphicsEntryKey(entry);
        let png = byKey.get(key);
        if (!png) {
            drawGraphicsEntry(pair, job, entry, assets);
            png = await options.encodePng(outCanvas);
            byKey.set(key, png);
        }
        sequence.push(png);
    }
    return { id: job.id, png: sequence[0] ?? new Uint8Array(), width, height, boxWidth: width, boxHeight: height, pad: 0, scale: 1, sequence, firstFrame: job.firstFrame,
        ...(missing.length > 0 ? { missingAssets: missing } : {}),
    };
}

export function createCanvasRasterizer(options: CanvasRasterizerOptions): OverlayRasterizer {
    return {
        async rasterize(job: RasterJob): Promise<RasterResult> {
            if (job.kind === "graphics") return rasterizeGraphics(options, job);
            if (job.kind === "text") return rasterizeText(options, job);
            if (job.kind === "sticker") return rasterizeSticker(options, job);
            // Emoji sticker: 64 px × scale glyph centered in a 1.2× box (preview-panel.tsx:1359-1374).
            const size = 64 * job.scale * job.frameScale;
            const box = size * 1.2;
            const pad = Math.ceil(box * 0.25);
            const side = Math.max(1, Math.ceil(box + pad * 2));
            const capped = cappedSize(side, side);
            const canvas = options.createCanvas(capped.width, capped.height);
            const ctx = context(canvas);
            if (capped.sx !== 1 || capped.sy !== 1) ctx.scale(capped.sx, capped.sy);
            ctx.font = `${size}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(job.text, side / 2, side / 2);
            return {
                id: job.id, png: await options.encodePng(canvas), width: capped.width, height: capped.height,
                boxWidth: box, boxHeight: box, pad, scale: job.scale,
            };
        },
    };
}
