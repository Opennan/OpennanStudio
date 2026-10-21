import { maskLook } from "@opennan/timeline-core/looks/look-plan";
import { paintMaskedLayer, LayerMaskCache } from "./layer-mask";
import { RecordingContext, recordingCanvasFactory, testClip } from "./test-fixtures";

function fakeRenderer() {
    return {
        isLost: false,
        canvas: { tag: "gl-canvas" },
        upload: vi.fn((_source: unknown, width: number, height: number) => ({ id: "u", width, height })),
        look: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
        presentRegion: vi.fn((_frame: unknown, width: number, height: number) => ({ x: 0, y: 4, width, height })),
        releaseAll: vi.fn(),
    };
}

const text = testClip({ id: "t", trackType: "text", trackIndex: 1, textContent: "Hi", maskJson: '{"shape":"circle","width":0.5,"height":0.5}' });

describe("paintMaskedLayer (phase 10d)", () => {
    it("draws the layer into a device-size canvas, masks it in the item box's device pixels, and draws it back over the outer rect", () => {
        const renderer = fakeRenderer();
        const { createCanvas, contexts } = recordingCanvasFactory();
        const ctx = new RecordingContext();
        const plan = maskLook({ kind: "clip", ...text })!;
        const drawn: unknown[] = [];
        const ok = paintMaskedLayer(ctx as never, renderer as never, plan, 1.25, 2, { x: -60, y: -30, w: 120, h: 60 }, { x: -50, y: -20, w: 100, h: 40 }, (layer, x, y, w, h) => {
            drawn.push([x, y, w, h]);
            layer.drawImage("bitmap" as never, x, y, w, h);
        }, createCanvas as never);
        expect(ok).toBe(true);
        // The layer canvas: outer × dpr, its transform mapping the outer rect onto it.
        const layer = contexts[0];
        expect(layer.canvas).toMatchObject({ width: 240, height: 120 });
        expect(layer.named("setTransform")[0].args).toEqual([2, 0, 0, 2, 120, 60]);
        expect(drawn).toEqual([[-60, -30, 120, 60]]);
        // The mask pass at keyframe time t, in the box: (10, 10) bitmap px from the corner, 100 × 40, at dpr 2.
        expect(renderer.upload).toHaveBeenCalledWith(layer.canvas, 240, 120);
        const [, lookPlan, t, keyframeTime, box] = renderer.look.mock.calls[0];
        expect(lookPlan).toBe(plan);
        expect([t, keyframeTime]).toEqual([1.25, 1.25]);
        expect(box).toEqual({ x: 20, y: 20, width: 200, height: 80 });
        // Drawn back from the presented region onto the outer rect.
        expect(ctx.named("drawImage")[0].args).toEqual([renderer.canvas, 0, 4, 240, 120, -60, -30, 120, 60]);
        expect(renderer.releaseAll).toHaveBeenCalled();
    });

    it("caps the layer at 2048 device px (keeping the aspect) and returns false without a renderer, a plan, or on a GL failure", () => {
        const renderer = fakeRenderer();
        const { createCanvas, contexts } = recordingCanvasFactory();
        const plan = maskLook({ kind: "clip", ...text })!;
        const big = { x: 0, y: 0, w: 2000, h: 1000 };
        expect(paintMaskedLayer(new RecordingContext() as never, renderer as never, plan, 0, 2, big, big, () => {}, createCanvas as never)).toBe(true);
        expect(contexts[0].canvas).toMatchObject({ width: 2048, height: 1024 });
        expect(renderer.look.mock.calls[0][4]).toEqual({ x: 0, y: 0, width: 2048, height: 1024 });
        expect(paintMaskedLayer(new RecordingContext() as never, null, plan, 0, 1, big, big, () => {}, createCanvas as never)).toBe(false);
        expect(paintMaskedLayer(new RecordingContext() as never, renderer as never, null, 0, 1, big, big, () => {}, createCanvas as never)).toBe(false);
        const lost = { ...fakeRenderer(), isLost: true };
        expect(paintMaskedLayer(new RecordingContext() as never, lost as never, plan, 0, 1, big, big, () => {}, createCanvas as never)).toBe(false);
        const failing = { ...fakeRenderer(), look: vi.fn(() => { throw new Error("gl"); }) };
        expect(paintMaskedLayer(new RecordingContext() as never, failing as never, plan, 0, 1, big, big, () => {}, createCanvas as never)).toBe(false);
        expect(failing.releaseAll).toHaveBeenCalled();
    });
});

describe("LayerMaskCache", () => {
    it("is the clip's mask-only plan, memoized per clip object; null for clips without a mask", () => {
        const cache = new LayerMaskCache();
        const plan = cache.planFor(text);
        expect(plan?.steps.map((step) => step.kind)).toEqual(["mask"]);
        expect(cache.planFor(text)).toBe(plan);
        expect(cache.planFor({ ...text, maskJson: null })).toBeNull();
        expect(cache.planFor(testClip({ trackType: "audio", maskJson: text.maskJson }))).toBeNull();
    });
});
