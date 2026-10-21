import { afterEach, describe, expect, it, vi } from "vitest";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { keyframeLut } from "../lane-look-plan";
import { ClipLookCache, drawClipThroughLook } from "./clip-look";
import { RecordingContext, testClip } from "./test-fixtures";

// A stand-in renderer (as lane-look-overlay.test.tsx): every stage returns a token frame.
const fake = {
    isLost: false,
    canvas: { tag: "gl-canvas" },
    upload: vi.fn((_source: unknown, width: number, height: number) => ({ id: "u", width, height })),
    resize: vi.fn((_frame: unknown, width: number, height: number) => ({ id: "r", width, height })),
    lutMix: vi.fn((_frame: unknown, ..._rest: unknown[]) => ({ id: "m", width: 2, height: 2 })),
    look: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    legacy: vi.fn((_frame: unknown, ..._rest: unknown[]) => ({ id: "l", width: 2, height: 2 })),
    presentRegion: vi.fn((_frame: unknown, width: number, height: number) => ({ x: 0, y: 7, width, height })),
    releaseAll: vi.fn(),
};
const renderer = fake as unknown as LookRenderer;
const source = { tag: "video" } as unknown as TexImageSource;

afterEach(() => vi.clearAllMocks());

const keyed = (extra: Record<string, unknown> = {}) => testClip({
    id: "k",
    keyframesJson: JSON.stringify([
        { time: 0, adj_exposure: 0 },
        { time: 2, adj_exposure: 40 },
    ]),
    ...extra,
});

describe("ClipLookCache", () => {
    it("gives a plain clip its static look and no mix", () => {
        const cache = new ClipLookCache();
        expect(cache.at(testClip(), 1)).toEqual({ plan: null, mix: null, legacy: null });
        const graded = cache.at(testClip({ visualFilter: "noir" }), 1);
        expect(graded.plan).not.toBeNull();
        expect(graded.mix).toBeNull();
    });

    it("cross-fades the CLUTs of the keyframes around the time with the eased weight", () => {
        const cache = new ClipLookCache();
        const clip = keyed();
        const look = cache.at(clip, 0.5);
        expect(look.mix).not.toBeNull();
        const source = { kind: "clip" as const, ...clip };
        const points = JSON.parse(clip.keyframesJson!);
        expect(look.mix!.a.key).toBe(keyframeLut(source, points, 0).key);
        expect(look.mix!.b.key).toBe(keyframeLut(source, points, 2).key);
        expect(look.mix!.a.key).not.toBe(look.mix!.b.key);
        // Linear easing (no easing key): a quarter of the way.
        expect(look.mix!.w).toBeCloseTo(0.25);
        // Nothing else in the look: no remaining steps.
        expect(look.plan).toBeNull();
    });

    it("rebuilds when the keyframes change and reuses CLUTs while they do not", () => {
        const cache = new ClipLookCache();
        const clip = keyed();
        const first = cache.at(clip, 0.5).mix!;
        const again = cache.at({ ...clip }, 1.5).mix!;
        expect(again.a).toBe(first.a);
        expect(again.w).toBeCloseTo(0.75);
        const edited = keyed({ keyframesJson: JSON.stringify([{ time: 0, adj_exposure: 0 }, { time: 2, adj_exposure: -40 }]) });
        expect(cache.at(edited, 0.5).mix!.b.key).not.toBe(first.b.key);
    });

    it("reads a clip object's look fields once (no per-frame stringify), and prunes clips that are gone", () => {
        const cache = new ClipLookCache();
        let reads = 0;
        const clip = testClip({ id: "fx", visualFilter: "noir" });
        const effects = [{ id: "e", effectId: "fx_blur", order: 0, paramsJson: "{}", enabled: true }];
        Object.defineProperty(clip, "effects", { get: () => { reads += 1; return effects; } });
        const first = cache.at(clip, 0);
        const readsAfterFirst = reads;
        for (let i = 1; i < 10; i += 1) expect(cache.at(clip, i / 30)).toEqual(first);
        expect(reads).toBe(readsAfterFirst);
        cache.at(testClip({ id: "other" }), 0);
        expect(cache.size).toBe(2);
        cache.retain(new Set(["other"]));
        expect(cache.size).toBe(1);
    });

    it("keeps effects and spatial steps after the mix", () => {
        const cache = new ClipLookCache();
        const look = cache.at(keyed({ effects: [{ id: "e", effectId: "fx_blur", order: 0, paramsJson: "{}", enabled: true }] } as never), 1);
        expect(look.mix).not.toBeNull();
        expect(look.plan).not.toBeNull();
    });
});

describe("drawClipThroughLook", () => {
    it("requests the CLUT mix before the rest of the look and stamps the result", () => {
        const ctx = new RecordingContext();
        const cache = new ClipLookCache();
        const clip = keyed();
        const look = cache.at(clip, 1);
        const ok = drawClipThroughLook(ctx as unknown as CanvasRenderingContext2D, renderer, look, source, 640, 360, -50, -25, 100, 50, 1, 1);
        expect(ok).toBe(true);
        expect(fake.lutMix).toHaveBeenCalledTimes(1);
        const [frame, a, b, w] = fake.lutMix.mock.calls[0] as [{ id: string }, { key: string }, { key: string }, number];
        expect(frame.id).toBe("r");
        expect(a.key).toBe(look.mix!.a.key);
        expect(b.key).toBe(look.mix!.b.key);
        expect(w).toBeCloseTo(0.5);
        expect(fake.presentRegion).toHaveBeenCalledTimes(1);
        // The region of the (grow-only) shared canvas the frame went into.
        expect(ctx.named("drawImage")[0].args).toEqual([fake.canvas, 0, 7, 100, 50, -50, -25, 100, 50]);
    });

    it("runs only the look without keyframes, and declines without a look or renderer", () => {
        const ctx = new RecordingContext();
        const cache = new ClipLookCache();
        const look = cache.at(testClip({ visualFilter: "noir" }), 1);
        expect(drawClipThroughLook(ctx as unknown as CanvasRenderingContext2D, renderer, look, source, 64, 36, 0, 0, 10, 10, 1, 1)).toBe(true);
        expect(fake.lutMix).not.toHaveBeenCalled();
        expect(fake.look).toHaveBeenCalledTimes(1);
        expect(drawClipThroughLook(ctx as unknown as CanvasRenderingContext2D, renderer, { plan: null, mix: null, legacy: null }, source, 64, 36, 0, 0, 10, 10, 1, 1)).toBe(false);
        expect(drawClipThroughLook(ctx as unknown as CanvasRenderingContext2D, null, look, source, 64, 36, 0, 0, 10, 10, 1, 1)).toBe(false);
    });

    it("falls back (false) when the renderer throws", () => {
        const ctx = new RecordingContext();
        fake.lutMix.mockImplementationOnce(() => { throw new Error("lost"); });
        const look = new ClipLookCache().at(keyed(), 1);
        expect(drawClipThroughLook(ctx as unknown as CanvasRenderingContext2D, renderer, look, source, 64, 36, 0, 0, 10, 10, 1, 1)).toBe(false);
        expect(fake.releaseAll).toHaveBeenCalled();
        expect(ctx.named("drawImage")).toHaveLength(0);
    });
});

describe("ClipLookCache masks (phase 10c)", () => {
    it("a masked clip has a plan ending in the mask, rebuilt when the mask changes", () => {
        const cache = new ClipLookCache();
        const first = cache.at(testClip({ id: "m", maskJson: '{"shape":"circle"}' }), 0);
        expect(first.plan?.steps.map((s) => s.kind)).toEqual(["mask"]);
        const moved = cache.at(testClip({ id: "m", maskJson: '{"shape":"circle","x":0.3}' }), 0);
        expect(moved.plan).not.toBe(first.plan);
        const step = moved.plan!.steps[0];
        expect(step.kind === "mask" && step.mask.x).toBe(0.3);
    });
});

describe("legacy blur, chroma key, and blend modes in the preview (phase 10d)", () => {
    it("gives a clip its legacy ops in the export's plane modes", () => {
        const cache = new ClipLookCache();
        const video = cache.at(testClip({ mediaUrl: "/m/v.mp4", blurStrength: 3, chromaKeyEnabled: true, blendMode: "screen" }), 0);
        expect(video.legacy).toMatchObject({ blur: { radius: 3, mode: "yuv420" }, chromaKey: { subsampled: true }, eq: { luma: [3686, 30], chroma: null } });
        // After a look the planes are RGB, so the key runs per pixel.
        const graded = cache.at(testClip({ mediaUrl: "/m/v.mp4", visualFilter: "noir", chromaKeyEnabled: true }), 0);
        expect(graded.legacy!.chromaKey!.subsampled).toBe(false);
        const png = cache.at(testClip({ mediaUrl: "/m/s.png", mediaType: "image", blurStrength: 2 }), 0);
        expect(png.legacy!.blur).toEqual({ radius: 2, mode: "rgb" });
    });

    it("draws a clip with only legacy ops through the renderer, the blur scaled to the drawn size", () => {
        const ctx = new RecordingContext();
        const look = new ClipLookCache().at(testClip({ mediaUrl: "/m/v.mp4", blurStrength: 8 }), 0);
        // 200 CSS px at dpr 2 for a preview frame at a quarter of the export's 1080p reference: 8 × 0.25 × 2 = 4 px.
        expect(drawClipThroughLook(ctx as never, renderer, look, source, 640, 360, 0, 0, 200, 112.5, 0, 2, 0.25)).toBe(true);
        expect(fake.legacy).toHaveBeenCalledTimes(1);
        expect(fake.legacy.mock.calls[0][1]).toEqual({ blur: { radius: 4, mode: "yuv420" }, chromaKey: null, eq: null });
    });
});
