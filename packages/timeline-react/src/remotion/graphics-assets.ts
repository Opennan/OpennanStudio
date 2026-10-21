// Fonts and images the built-in graphics templates draw with (phase 10d), shared by the DOM graphics layer
// (graphics-overlay.tsx) and the compositor canvas (preview/motion/graphics-layer.ts, phase 11).
import { GRAPHICS_FONT_FACES } from "@opennan/timeline-core/graphics/draw/helpers";

let fontsRequested: Promise<unknown> | null = null;

/** Loads the graphics faces once per page (the canvas draws fallback fonts until they arrive). */
export function loadGraphicsFonts(): Promise<unknown> {
    if (fontsRequested) return fontsRequested;
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fontsRequested = fonts ? Promise.allSettled(GRAPHICS_FONT_FACES.map((face) => fonts.load(`${face.style} ${face.weight} 32px "${face.family}"`))) : Promise.resolve();
    return fontsRequested;
}

interface AssetEntry {
    image: HTMLImageElement;
    state: "loading" | "loaded" | "failed";
    /** Redraws waiting for this image (one per owner, replaced on every draw). */
    waiting: Map<string, () => void>;
}

/** Template images by resolved URL (a few logos at most; the oldest goes past MAX_ASSET_IMAGES). */
const images = new Map<string, AssetEntry>();
const MAX_ASSET_IMAGES = 24;

/**
 * A decoded image for a template asset (logo), or null until it loads (or when it failed). `owner`'s redraw runs
 * once it loads; one listener per owner, however often it draws meanwhile.
 */
export function graphicsAssetImage(url: string, owner: string, onLoad: () => void): HTMLImageElement | null {
    let entry = images.get(url);
    if (!entry) {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.decoding = "async";
        const created: AssetEntry = { image, state: "loading", waiting: new Map() };
        image.addEventListener("load", () => {
            created.state = "loaded";
            const waiting = [...created.waiting.values()];
            created.waiting.clear();
            for (const redraw of waiting) redraw();
        }, { once: true });
        image.addEventListener("error", () => {
            created.state = "failed";
            created.waiting.clear();
        }, { once: true });
        image.src = url;
        images.set(url, created);
        if (images.size > MAX_ASSET_IMAGES) images.delete(images.keys().next().value!);
        entry = created;
    }
    if (entry.state === "loaded") return entry.image;
    if (entry.state === "loading") entry.waiting.set(owner, onLoad);
    return null;
}

/** True once the asset at `url` finished (loaded or failed): a draw without it is final. */
export function graphicsAssetSettled(url: string): boolean {
    const state = images.get(url)?.state;
    return state === "loaded" || state === "failed";
}
