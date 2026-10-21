import { describe, expect, it, vi } from "vitest";
import { STICKERS } from "@opennan/timeline-core/stickers/catalog";
import { textStateAt, textStatePlan, type TextState } from "@opennan/timeline-core/text/text-states";
import { FontLoader, fontFaceQuery } from "./font-loader";
import { LruCache } from "./lru-cache";
import { StickerImageCache, stickerImageKey, stickerSizeBucket, type ImageLike } from "./sticker-image-cache";
import { TEXT_BITMAP_CACHE_BYTES, TextStateBitmapCache, textBitmapKey, type TextBitmapRequest } from "./text-state-cache";
import { recordingCanvasFactory } from "./test-fixtures";

describe("LruCache", () => {
    it("evicts the least recently used entry and releases it", () => {
        const evicted: string[] = [];
        const cache = new LruCache<number>(2, (_value, key) => evicted.push(key));
        cache.set("a", 1);
        cache.set("b", 2);
        cache.get("a");
        cache.set("c", 3);
        expect(cache.keys()).toEqual(["a", "c"]);
        expect(evicted).toEqual(["b"]);
        cache.clear();
        expect(evicted).toEqual(["b", "a", "c"]);
        expect(cache.size).toBe(0);
    });

    it("keeps its entries within a byte budget (evicting oldest first, never the newest entry)", () => {
        const evicted: string[] = [];
        const cache = new LruCache<number>(10, (_value, key) => evicted.push(key), { maxBytes: 100, sizeOf: (v) => v });
        cache.set("a", 40);
        cache.set("b", 40);
        expect(cache.bytes).toBe(80);
        cache.set("c", 30);
        expect(cache.keys()).toEqual(["b", "c"]);
        expect(evicted).toEqual(["a"]);
        expect(cache.bytes).toBe(70);
        // An entry larger than the budget stays alone (it is in use this frame).
        cache.set("huge", 500);
        expect(cache.keys()).toEqual(["huge"]);
        expect(cache.bytes).toBe(500);
        cache.set("huge", 20);
        expect(cache.bytes).toBe(20);
        cache.clear();
        expect(cache.bytes).toBe(0);
    });
});

const request = (overrides: Partial<TextBitmapRequest> = {}): TextBitmapRequest => ({
    clipId: "t1", text: "Hello world", textStyle: JSON.stringify({ fontSize: 40 }), state: { kind: "full" },
    layoutScale: 1, frameScale: 0.5, frameWidth: 640, density: 2, ...overrides,
});

describe("text state bitmaps", () => {
    it("keys on clip, style, text, state, layout scale, resolution, and wrap width", () => {
        const base = textBitmapKey(request());
        expect(textBitmapKey(request())).toBe(base);
        for (const change of [
            { clipId: "t2" }, { text: "Hello" }, { textStyle: "{}" }, { state: { kind: "typewriter", visible: 3 } as TextState },
            { layoutScale: 1.5 }, { density: 1 }, { frameScale: 0.6 }, { frameWidth: 700 },
        ]) {
            expect(textBitmapKey(request(change))).not.toBe(base);
        }
    });

    it("draws once per key and evicts beyond its size, freeing evicted canvases", () => {
        const { createCanvas, contexts } = recordingCanvasFactory();
        const cache = new TextStateBitmapCache(createCanvas, 2);
        const first = cache.get(request())!;
        expect(first.canvas.width).toBeGreaterThan(0);
        expect(cache.get(request())).toBe(first);
        const drawn = contexts.length;
        cache.get(request({ state: { kind: "typewriter", visible: 2 } }));
        cache.get(request({ state: { kind: "typewriter", visible: 4 } }));
        expect(contexts.length).toBeGreaterThan(drawn);
        expect(cache.size).toBe(2);
        expect(first.canvas.width).toBe(0);
    });

    it("frees bitmaps beyond its byte budget (w·h·4), not only beyond its entry count", () => {
        const { createCanvas } = recordingCanvasFactory();
        const one = new TextStateBitmapCache(createCanvas).get(request())!;
        const bytes = one.canvas.width * one.canvas.height * 4;
        const cache = new TextStateBitmapCache(createCanvas, 64, bytes * 2.5);
        const first = cache.get(request())!;
        cache.get(request({ state: { kind: "typewriter", visible: 2 } }));
        cache.get(request({ state: { kind: "typewriter", visible: 4 } }));
        expect(cache.size).toBe(2);
        expect(first.canvas.width).toBe(0);
        expect(first.canvas.height).toBe(0);
        expect(cache.bytes).toBeLessThanOrEqual(bytes * 2.5);
        expect(TEXT_BITMAP_CACHE_BYTES).toBe(128 * 1024 * 1024);
    });

    it("reuses the last bitmap of a resize drag (scaled) instead of drawing one per pointer move", () => {
        const { createCanvas, contexts } = recordingCanvasFactory();
        const cache = new TextStateBitmapCache(createCanvas);
        const settled = cache.get(request({ layoutScale: 1 }))!;
        expect(settled.layoutScale).toBe(1);
        const drawn = contexts.length;
        for (const scale of [1.05, 1.2, 1.4, 1.7, 0.6]) {
            expect(cache.get(request({ layoutScale: scale }), { reuseScaled: true })).toBe(settled);
        }
        expect(contexts.length).toBe(drawn);
        // Too far from the reused bitmap's scale: a fresh bitmap (the next moves reuse that one).
        const bigger = cache.get(request({ layoutScale: 2.5 }), { reuseScaled: true })!;
        expect(bigger).not.toBe(settled);
        expect(bigger.layoutScale).toBe(2.5);
        expect(cache.get(request({ layoutScale: 2.6 }), { reuseScaled: true })).toBe(bigger);
        // Another state or text never reuses.
        expect(cache.get(request({ layoutScale: 2.6, text: "Other" }), { reuseScaled: true })).not.toBe(bigger);
        // Release: the exact scale is drawn.
        const exact = cache.get(request({ layoutScale: 1.7 }))!;
        expect(exact).not.toBe(settled);
        expect(exact.layoutScale).toBe(1.7);
    });

    it("lays out in reference px: the CSS box follows the frame scale, not the display density", () => {
        const { createCanvas, contexts } = recordingCanvasFactory();
        const cache = new TextStateBitmapCache(createCanvas);
        const one = cache.get(request({ density: 1 }))!;
        const two = cache.get(request({ density: 2 }))!;
        expect(two.boxW).toBeCloseTo(one.boxW, 9);
        expect(two.boxH).toBeCloseTo(one.boxH, 9);
        expect(two.canvas.width).toBeGreaterThan(one.canvas.width * 1.9);
        expect(two.canvas.width * two.pxSize).toBeCloseTo(one.canvas.width * one.pxSize, 0);
        const big = cache.get(request({ frameScale: 1, frameWidth: 1280, density: 1 }))!;
        expect(big.boxW).toBeCloseTo(one.boxW * 2, 9);
        // The bitmap context draws in reference px through a resolution transform.
        expect(contexts[contexts.length - 1].named("setTransform")[0].args).toEqual([1, 0, 0, 1, 0, 0]);
    });

    it("draws the typewriter state's visible glyphs only (shared drawing code)", () => {
        const { createCanvas, contexts } = recordingCanvasFactory();
        const cache = new TextStateBitmapCache(createCanvas);
        const clip = {
            textContent: "Hello world", textStyle: JSON.stringify({ fontSize: 40 }), startTime: 0, endTime: 4,
            animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }),
        };
        const plan = textStatePlan(clip);
        expect(plan.animated).toBe(true);
        const state = textStateAt(plan, 0.5);
        expect(state).toMatchObject({ kind: "typewriter" });
        const visible = (state as { visible: number }).visible;
        expect(visible).toBeGreaterThan(0);
        expect(visible).toBeLessThan(10);
        cache.get(request({ text: clip.textContent, state }));
        const drawn = contexts[contexts.length - 1].named("fillText").map((call) => String(call.args[0])).join("");
        expect(drawn.replace(/\s/g, "").length).toBe(visible);
    });
});

class FakeImage implements ImageLike {
    src = "";
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    onload: ((this: never, ev: never) => unknown) | null = null;
    onerror: unknown = null;
    finish() {
        this.complete = true;
        this.naturalWidth = 10;
        this.naturalHeight = 10;
        (this.onload as unknown as () => void)?.();
    }
}

describe("sticker images", () => {
    const id = STICKERS[0].id;

    it("buckets drawn sizes", () => {
        expect(stickerSizeBucket(10)).toBe(64);
        expect(stickerSizeBucket(64)).toBe(64);
        expect(stickerSizeBucket(65)).toBe(128);
        expect(stickerSizeBucket(9999)).toBe(2048);
    });

    it("decodes one image per sticker and bucket, redraws on load, and falls back to a loaded bucket", () => {
        const images: FakeImage[] = [];
        const onLoad = vi.fn();
        const cache = new StickerImageCache({ createImage: () => { const image = new FakeImage(); images.push(image); return image; }, onLoad });
        expect(cache.get(id, 100)).toBeNull();
        expect(images).toHaveLength(1);
        expect(images[0].src.startsWith("data:image/svg+xml")).toBe(true);
        expect(decodeURIComponent(images[0].src)).toMatch(/width="128"|height="128"/);
        expect(cache.get(id, 120)).toBeNull();
        expect(images).toHaveLength(1);
        images[0].finish();
        expect(onLoad).toHaveBeenCalledTimes(1);
        expect(cache.get(id, 100)).toBe(images[0]);
        // A larger size starts the next bucket and draws the loaded one meanwhile.
        expect(cache.get(id, 400)).toBe(images[0]);
        expect(images).toHaveLength(2);
        expect(cache.keys()).toEqual([stickerImageKey(id, 128), stickerImageKey(id, 512)]);
    });

    it("returns null for unknown stickers and evicts beyond its size", () => {
        const images: FakeImage[] = [];
        const cache = new StickerImageCache({ createImage: () => { const image = new FakeImage(); images.push(image); return image; }, onLoad: () => {}, max: 2 });
        expect(cache.get("no-such-sticker", 50)).toBeNull();
        cache.get(STICKERS[0].id, 50);
        cache.get(STICKERS[1].id, 50);
        cache.get(STICKERS[2].id, 50);
        expect(cache.size).toBe(2);
        expect(images[0].src).toBe("");
        expect(images[0].onload).toBeNull();
    });
});

describe("FontLoader", () => {
    const face = { family: "Bebas Neue", weight: 400, style: "normal" as const };

    it("loads each missing face once and reports when it arrives", async () => {
        let loaded = false;
        let finish: () => void = () => {};
        const fonts = {
            check: vi.fn(() => loaded),
            load: vi.fn(() => new Promise<unknown>((resolve) => { finish = () => { loaded = true; resolve([]); }; })),
        };
        const onLoaded = vi.fn();
        const loader = new FontLoader(fonts, onLoaded);
        expect(loader.ensure([face])).toBe(false);
        expect(loader.ensure([face])).toBe(false);
        expect(fonts.load).toHaveBeenCalledTimes(1);
        expect(fonts.load).toHaveBeenCalledWith(fontFaceQuery(face));
        expect(onLoaded).not.toHaveBeenCalled();
        finish();
        await Promise.resolve();
        await Promise.resolve();
        expect(onLoaded).toHaveBeenCalledWith(face);
        expect(loader.ensure([face])).toBe(true);
    });

    it("is ready without a font set or faces", () => {
        expect(new FontLoader(null, () => {}).ensure([face])).toBe(true);
        expect(new FontLoader({ check: () => false, load: async () => [] }, () => {}).ensure([])).toBe(true);
        expect(fontFaceQuery({ family: "Caveat", weight: 700, style: "italic" })).toBe('italic 700 32px "Caveat"');
    });
});
