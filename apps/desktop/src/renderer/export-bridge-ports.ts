// Serves text/sticker bitmaps and GL effect frames to main's export runner over the two MessagePorts the preload
// forwards (main: createRemoteRasterizer / createRemoteGlFrameProcessor). The rasterizer is the preview's
// own canvas drawing (createCanvasRasterizer from @opennan/export's main entry; @opennan/export/web would
// pull in the ffmpeg.wasm runner).
import { previewMediaUrl } from "../shared/media-policy";
import { createCanvasRasterizer, serveGlFrameProcessor, serveOverlayRasterizer, type BridgePort, type OverlayRasterizer, type RasterCanvas } from "@opennan/export";
import { createWebGlFrameProcessor } from "@opennan/export/web-gl";
import { EXPORT_PORTS_MESSAGE } from "../shared/bridge";

function createCanvas(width: number, height: number): RasterCanvas {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

async function encodePng(canvas: RasterCanvas): Promise<Uint8Array> {
    const blob = await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
}

type RasterizerOptions = Parameters<typeof createCanvasRasterizer>[0];

/** Loads the bundled faces a text job uses (`document.fonts.ready` does not load unused faces); failures fall back. */
const loadFonts: NonNullable<RasterizerOptions["loadFonts"]> = async (faces) => {
    if (!document.fonts) return;
    await Promise.allSettled(faces.map((face) => document.fonts.load(`${face.style} ${face.weight} 32px "${face.family}"`)));
};

/**
 * Decodes a bundled sticker's `data:` SVG for drawImage; a graphic's image (a logo) is read as bytes from the media
 * library (the preview's own mapping; anything else is refused, as for every desktop media URL).
 */
const loadImage: NonNullable<RasterizerOptions["loadImage"]> = async (url) => {
    if (!url.startsWith("data:")) {
        const media = previewMediaUrl(url, location.origin);
        if (!media.allowed) throw new Error("only imported media can be drawn"); // i18n-ignore
        const response = await fetch(media.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`); // i18n-ignore
        return createImageBitmap(await response.blob());
    }
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return image;
};

export function createDesktopRasterizer(): OverlayRasterizer {
    const rasterizer = createCanvasRasterizer({ createCanvas, encodePng, loadFonts, loadImage });
    return {
        async rasterize(job) {
            if (document.fonts) await document.fonts.ready;
            return rasterizer.rasterize(job);
        },
    };
}

/**
 * A DOM MessagePort as a BridgePort that never transfers: Electron's MessagePortMain cannot receive transferred
 * ArrayBuffers (main's listener gets `data: null` and throws in the bridge, an uncaught exception in main), so
 * pixels are copied by the structured clone instead (main's side copies too: adaptPort).
 */
export function copyingPort(port: MessagePort): BridgePort {
    return {
        postMessage: (message) => port.postMessage(message),
        addEventListener: (type, listener) => port.addEventListener(type, listener),
        removeEventListener: (type, listener) => port.removeEventListener(type, listener),
        start: () => port.start(),
    };
}

export interface ExportPortServers {
    rasterizer(): OverlayRasterizer;
    glProcessor(): ReturnType<typeof createWebGlFrameProcessor>;
}

/** Listens for the ports main posts after each page load; returns a function that stops listening. */
export function serveExportBridgePorts(servers: ExportPortServers = { rasterizer: createDesktopRasterizer, glProcessor: createWebGlFrameProcessor }): () => void {
    let stopServing: Array<() => void> = [];
    const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.origin !== window.location.origin || event.data !== EXPORT_PORTS_MESSAGE) return;
        const [rasterPort, glPort] = event.ports;
        if (!rasterPort || !glPort) return;
        stopServing.forEach((stop) => stop());
        stopServing = [serveOverlayRasterizer(copyingPort(rasterPort), servers.rasterizer()), serveGlFrameProcessor(copyingPort(glPort), servers.glProcessor())];
    };
    window.addEventListener("message", onMessage);
    return () => {
        window.removeEventListener("message", onMessage);
        stopServing.forEach((stop) => stop());
    };
}
