// LRU of pre-rendered clip bodies (filmstrip/waveform/label) so drag frames
// blit one bitmap per clip instead of re-rasterizing filmstrip slices and
// waveform peaks on every dirty frame. Keys carry a contentKey + mediaVersion
// so thumbnail/waveform arrivals and clip edits naturally invalidate.

export const CLIP_RENDER_CACHE_MAX_ENTRIES = 200;

// Width buckets: sub-pixel scroll/zoom jitter must not thrash the cache, but
// real size changes must miss. 1px buckets keep strips visually exact.
const WIDTH_BUCKET_PX = 1;

export interface ClipCacheKeyParts {
    clipId: string;
    widthPx: number;
    heightPx: number;
    dpr: number;
    /** Hash of everything drawn in the body (label, volume, trim, urls…). */
    contentKey: string;
    /** Bumps when async media (thumbnails/waveform peaks) arrive. */
    mediaVersion: number;
}

export function clipCacheKey(p: ClipCacheKeyParts): string {
    const w = Math.round(p.widthPx / WIDTH_BUCKET_PX) * WIDTH_BUCKET_PX;
    const h = Math.round(p.heightPx);
    return `${p.clipId}|${w}|${h}|${p.dpr}|${p.mediaVersion}|${p.contentKey}`;
}

const cache = new Map<string, OffscreenCanvas>();

function touch(key: string, bitmap: OffscreenCanvas) {
    cache.delete(key);
    cache.set(key, bitmap);
}

export function getCachedClipBitmap(key: string): OffscreenCanvas | null {
    const hit = cache.get(key);
    if (!hit) return null;
    touch(key, hit);
    return hit;
}

export function renderClipToCache(
    key: string,
    widthPx: number,
    heightPx: number,
    dpr: number,
    draw: (ctx: OffscreenCanvasRenderingContext2D) => void,
): OffscreenCanvas | null {
    if (typeof OffscreenCanvas === "undefined" || !OffscreenCanvas) return null;
    const w = Math.max(1, Math.ceil(widthPx * dpr));
    const h = Math.max(1, Math.ceil(heightPx * dpr));
    let canvas: OffscreenCanvas;
    try {
        canvas = new OffscreenCanvas(w, h);
    } catch {
        return null;
    }
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.scale(dpr, dpr);
    draw(ctx);
    cache.set(key, canvas);
    while (cache.size > CLIP_RENDER_CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return canvas;
}

export function invalidateClip(clipId: string): void {
    const prefix = `${clipId}|`;
    for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
}

export function clearClipRenderCache(): void {
    cache.clear();
}
