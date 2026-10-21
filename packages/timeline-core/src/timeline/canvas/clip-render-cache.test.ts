// Unit tests for the per-clip offscreen bitmap render cache.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    clipCacheKey,
    getCachedClipBitmap,
    renderClipToCache,
    invalidateClip,
    clearClipRenderCache,
    CLIP_RENDER_CACHE_MAX_ENTRIES,
} from "./clip-render-cache";

class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }
    getContext() {
        return { scale: vi.fn(), fillRect: vi.fn() };
    }
}

beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    clearClipRenderCache();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("clipCacheKey", () => {
    it("is stable for equivalent inputs and rounds sub-pixel width jitter", () => {
        const base = { clipId: "c1", widthPx: 100.2, heightPx: 40, dpr: 2, contentKey: "a|b", mediaVersion: 3 };
        expect(clipCacheKey(base)).toBe(clipCacheKey({ ...base, widthPx: 100.4 }));
        expect(clipCacheKey(base)).not.toBe(clipCacheKey({ ...base, widthPx: 103 }));
        expect(clipCacheKey(base)).not.toBe(clipCacheKey({ ...base, mediaVersion: 4 }));
        expect(clipCacheKey(base)).not.toBe(clipCacheKey({ ...base, contentKey: "a|c" }));
    });
});

describe("render cache", () => {
    const key = (id: string, extra = 0) =>
        clipCacheKey({ clipId: id, widthPx: 80, heightPx: 40, dpr: 1, contentKey: "x", mediaVersion: extra });

    it("misses before render, hits after", () => {
        expect(getCachedClipBitmap(key("c1"))).toBeNull();
        const draw = vi.fn();
        const bitmap = renderClipToCache(key("c1"), 80, 40, 1, draw);
        expect(bitmap).not.toBeNull();
        expect(draw).toHaveBeenCalledTimes(1);
        expect(getCachedClipBitmap(key("c1"))).toBe(bitmap);
    });

    it("invalidateClip drops every cached size/version of that clip", () => {
        renderClipToCache(key("c1", 0), 80, 40, 1, vi.fn());
        renderClipToCache(key("c1", 1), 80, 40, 1, vi.fn());
        renderClipToCache(key("c2", 0), 80, 40, 1, vi.fn());
        invalidateClip("c1");
        expect(getCachedClipBitmap(key("c1", 0))).toBeNull();
        expect(getCachedClipBitmap(key("c1", 1))).toBeNull();
        expect(getCachedClipBitmap(key("c2", 0))).not.toBeNull();
    });

    it("evicts the least recently used entry past the cap", () => {
        for (let i = 0; i < CLIP_RENDER_CACHE_MAX_ENTRIES + 1; i++) {
            renderClipToCache(key(`clip-${i}`), 80, 40, 1, vi.fn());
        }
        expect(getCachedClipBitmap(key("clip-0"))).toBeNull();
        expect(getCachedClipBitmap(key(`clip-${CLIP_RENDER_CACHE_MAX_ENTRIES}`))).not.toBeNull();
    });

    it("returns null gracefully when OffscreenCanvas is unavailable", () => {
        vi.unstubAllGlobals();
        vi.stubGlobal("OffscreenCanvas", undefined);
        expect(renderClipToCache(key("c9"), 80, 40, 1, vi.fn())).toBeNull();
    });
});
