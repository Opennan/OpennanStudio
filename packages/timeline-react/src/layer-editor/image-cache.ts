// packages/timeline-react/src/layer-editor/image-cache.ts
// Layer images for the editor canvas, plus alpha lookups so a click picks the visible pixel, not the box.
export interface ImageSource {
    get(src: string): CanvasImageSource | undefined;
}

export class LayerImageCache implements ImageSource {
    private readonly images = new Map<string, HTMLImageElement>();
    private readonly alpha = new Map<string, { w: number; h: number; data: Uint8ClampedArray } | null>();

    constructor(private readonly resolve: (src: string) => string, private readonly onLoad: () => void) {}

    get(src: string): HTMLImageElement | undefined {
        let img = this.images.get(src);
        if (!img) {
            img = new Image();
            img.decoding = "async";
            img.onload = () => this.onLoad();
            img.src = this.resolve(src);
            this.images.set(src, img);
        }
        return img.complete && img.naturalWidth > 0 ? img : undefined;
    }

    /** Alpha (0–255) at a point given as fractions of the image (0..1); null when unknown (treat as opaque). */
    alphaAt(src: string, fx: number, fy: number): number | null {
        const img = this.get(src);
        if (!img) return null;
        let a = this.alpha.get(src);
        if (a === undefined) {
            try {
                const c = document.createElement("canvas");
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                const ctx = c.getContext("2d", { willReadFrequently: true });
                if (!ctx) throw new Error("no 2d");
                ctx.drawImage(img, 0, 0);
                a = { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
            } catch {
                a = null; // tainted or unsupported: fall back to box hits
            }
            this.alpha.set(src, a);
        }
        if (!a) return null;
        const x = Math.min(a.w - 1, Math.max(0, Math.floor(fx * a.w)));
        const y = Math.min(a.h - 1, Math.max(0, Math.floor(fy * a.h)));
        return a.data[(y * a.w + x) * 4 + 3];
    }
}
