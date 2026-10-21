// Text, emoji, and sticker bitmaps drawn by the browser's own canvas (same fonts as the preview).
import type { TextFontFace } from "@opennan/timeline-core/text/fonts";
import { createCanvasRasterizer, type OverlayRasterizer, type RasterCanvas } from "../raster/canvas-rasterizer";
import { createFetchMediaReader, type FetchMediaEnvironment } from "./fetch-media-reader";

function createCanvas(width: number, height: number): RasterCanvas {
    // A document canvas sees fonts loaded with @font-face; fall back to OffscreenCanvas in workers.
    if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }
    return new OffscreenCanvas(width, height);
}

async function encodePng(canvas: RasterCanvas): Promise<Uint8Array> {
    const blob = canvas instanceof HTMLCanvasElement
        ? await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"))
        : await (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * `document.fonts.ready` only waits for faces already requested, so the faces a job draws with are loaded
 * explicitly (an unused bundled face would otherwise draw in a fallback font). Failures fall back silently.
 */
async function loadFonts(faces: TextFontFace[]): Promise<void> {
    if (typeof document === "undefined" || !document.fonts) return;
    await Promise.allSettled(faces.map((face) => document.fonts.load(`${face.style} ${face.weight} 32px "${face.family}"`)));
}

/** Decodes a sticker's `data:` SVG (or another image URL) into an image (Image in a document, ImageBitmap in workers). */
async function loadImage(url: string): Promise<unknown> {
    if (typeof Image !== "undefined") {
        const image = new Image();
        image.decoding = "async";
        // Cross-origin images must come with CORS, or they would taint the canvas (the PNG encode would throw).
        if (!url.startsWith("data:") && !url.startsWith("blob:")) image.crossOrigin = "anonymous";
        image.src = url;
        await image.decode();
        return image;
    }
    return createImageBitmap(await (await fetch(url)).blob());
}

export interface BrowserRasterizerOptions {
    /**
     * Where a graphic's image (a logo URL) is read from: the host's media environment, with its URL mapping and auth
     * rules (the GPU export reads it the same way). Without one, images load as cross-origin images.
     */
    media?: FetchMediaEnvironment;
}

export function createBrowserRasterizer(options: BrowserRasterizerOptions = {}): OverlayRasterizer {
    const readMedia = options.media ? createFetchMediaReader(options.media) : null;
    const load = async (url: string): Promise<unknown> => {
        if (url.startsWith("data:") || !readMedia) return loadImage(url);
        // Bytes through the media reader: never a tainted canvas, and the same URL rules as the media itself.
        return createImageBitmap(new Blob([new Uint8Array(await readMedia(url))]));
    };
    const rasterizer = createCanvasRasterizer({ createCanvas, encodePng, loadFonts, loadImage: load });
    return {
        async rasterize(job) {
            // Wait for @font-face fonts so the first bitmap does not use a fallback face.
            if (typeof document !== "undefined" && document.fonts) await document.fonts.ready;
            return rasterizer.rasterize(job);
        },
    };
}
