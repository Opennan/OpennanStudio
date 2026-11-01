// Text, emoji and stickers for `mcp serve --ffmpeg` exports: @napi-rs/canvas (an optional dependency) draws them
// with the editor's canvas code, and the bundled fonts come from their @fontsource packages. Without the canvas the
// exporter leaves those clips out with a text-unsupported warning, as before.
import { createRequire } from "node:module";
import path from "node:path";
import { createCanvasRasterizer, type OverlayRasterizer, type RasterCanvas } from "@opennan/export";
import { fontByFamily, type TextFontFace } from "@opennan/timeline-core/text/fonts";

interface NapiCanvas {
    createCanvas(width: number, height: number): RasterCanvas & { toBuffer(mime: "image/png"): Uint8Array };
    loadImage(source: string): Promise<unknown>;
    GlobalFonts: { registerFromPath(file: string, family: string): unknown };
}

const require = createRequire(import.meta.url);
// A variable specifier: bundlers that inline @opennan/mcp (the desktop main process) leave the native module alone.
const CANVAS_MODULE = "@napi-rs/canvas";

/** The face's latin woff2 in its @fontsource package, or null when the family is not bundled or not installed. */
export function fontsourceFile(face: TextFontFace, resolve: (id: string) => string = require.resolve): string | null {
    const font = fontByFamily(face.family);
    if (!font) return null;
    const slug = font.packageName.slice(font.packageName.indexOf("/") + 1);
    try {
        const dir = path.dirname(resolve(`${font.packageName}/package.json`));
        return path.join(dir, "files", `${slug}-latin-${face.weight}-${face.style}.woff2`);
    } catch {
        return null;
    }
}

/** A canvas rasterizer over @napi-rs/canvas, or undefined when it is not installed. */
export async function createNodeRasterizer(load: () => Promise<unknown> = () => import(CANVAS_MODULE)): Promise<OverlayRasterizer | undefined> {
    let canvas: NapiCanvas;
    try {
        const loaded = (await load()) as NapiCanvas & { default?: NapiCanvas };
        canvas = typeof loaded.createCanvas === "function" ? loaded : loaded.default!;
        if (typeof canvas?.createCanvas !== "function") return undefined;
    } catch {
        return undefined;
    }
    const registered = new Set<string>();
    return createCanvasRasterizer({
        createCanvas: (width, height) => canvas.createCanvas(width, height),
        encodePng: async (target) => new Uint8Array((target as ReturnType<NapiCanvas["createCanvas"]>).toBuffer("image/png")),
        loadFonts: async (faces) => {
            for (const face of faces) {
                const file = fontsourceFile(face);
                if (!file || registered.has(file)) continue;
                registered.add(file);
                // A missing file is ignored: the canvas draws with the style's fallback fonts.
                try {
                    canvas.GlobalFonts.registerFromPath(file, face.family);
                } catch {
                    // fallback fonts
                }
            }
        },
        loadImage: (url) => canvas.loadImage(url),
    });
}
