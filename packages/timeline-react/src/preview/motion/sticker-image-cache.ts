// Bundled stickers in the preview (phase 10b): the catalog SVG (stickers/catalog.ts) decoded through an
// `Image` at a size bucket at least as large as the drawn size, so the vector stays sharp without
// re-decoding on every scale change. While a larger bucket decodes, the largest loaded one is drawn.
import { stickerBox, stickerDataUrl } from "@opennan/timeline-core/stickers/catalog";
import { LruCache } from "./lru-cache";

export interface ImageLike {
    src: string;
    complete: boolean;
    naturalWidth: number;
    naturalHeight: number;
    onload: ((this: never, ev: never) => unknown) | null;
    onerror: unknown;
}

export const STICKER_SIZE_BUCKETS: readonly number[] = [64, 128, 256, 512, 1024, 2048];
export const STICKER_IMAGE_CACHE_SIZE = 48;

/** The smallest bucket holding `px` device pixels (the largest bucket above it). */
export function stickerSizeBucket(px: number): number {
    for (const bucket of STICKER_SIZE_BUCKETS) if (px <= bucket) return bucket;
    return STICKER_SIZE_BUCKETS[STICKER_SIZE_BUCKETS.length - 1];
}

export function stickerImageKey(stickerId: string, bucket: number): string {
    return `${stickerId}@${bucket}`;
}

export interface StickerImageCacheOptions {
    createImage: () => ImageLike;
    /** An image finished decoding (or failed): the compositor redraws. */
    onLoad: () => void;
    dataUrl?: (id: string, size: { width: number; height: number }) => string | null;
    max?: number;
}

const loaded = (image: ImageLike) => image.complete && image.naturalWidth > 0;

export class StickerImageCache {
    private readonly cache: LruCache<ImageLike>;
    private readonly dataUrl: (id: string, size: { width: number; height: number }) => string | null;

    constructor(private readonly options: StickerImageCacheOptions) {
        this.dataUrl = options.dataUrl ?? stickerDataUrl;
        this.cache = new LruCache<ImageLike>(options.max ?? STICKER_IMAGE_CACHE_SIZE, (image) => {
            image.onload = null;
            image.onerror = null;
            image.src = "";
        });
    }

    get size(): number {
        return this.cache.size;
    }

    keys(): string[] {
        return this.cache.keys();
    }

    clear(): void {
        this.cache.clear();
    }

    /**
     * A decoded image of the sticker for `px` device pixels on its longer side: the bucket's image when
     * loaded, else (starting its decode) the largest loaded bucket of the same sticker, else null.
     */
    get(stickerId: string, px: number): ImageLike | null {
        const bucket = stickerSizeBucket(px);
        const key = stickerImageKey(stickerId, bucket);
        let image = this.cache.get(key);
        if (!image) {
            const box = stickerBox(stickerId);
            if (!box) return null;
            const longer = Math.max(box.width, box.height, 1);
            const url = this.dataUrl(stickerId, { width: (bucket * box.width) / longer, height: (bucket * box.height) / longer });
            if (!url) return null;
            image = this.options.createImage();
            const created = image;
            const done = () => {
                if (this.cache.peek(key) === created) this.options.onLoad();
            };
            image.onload = done;
            image.onerror = done;
            this.cache.set(key, image);
            image.src = url;
        }
        if (loaded(image)) return image;
        let fallback: ImageLike | null = null;
        let fallbackBucket = 0;
        for (const other of STICKER_SIZE_BUCKETS) {
            const candidate = this.cache.peek(stickerImageKey(stickerId, other));
            if (candidate && loaded(candidate) && other > fallbackBucket) {
                fallback = candidate;
                fallbackBucket = other;
            }
        }
        return fallback;
    }
}
