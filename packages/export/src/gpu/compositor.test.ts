// GpuCompositor pass order with a recording renderer (no GL): each layer runs source → bitmap size → crop → look →
// legacy (blur, chroma key, eq) → mosaic → flips/fades, then the composite, as compile/overlays.ts orders its filters.
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { GpuCompositor } from "./compositor";
import type { LayerOp } from "./plan";

function recordingRenderer() {
    const log: string[] = [];
    const frame = (width: number, height: number) => ({ width, height });
    const pass = (name: string) => (f: { width: number; height: number }) => {
        log.push(name);
        return frame(f.width, f.height);
    };
    const renderer = {
        canvas: {},
        isLost: false,
        fill: (w: number, h: number) => frame(w, h),
        upload: (_s: unknown, w: number, h: number) => {
            log.push("upload");
            return frame(w, h);
        },
        resize: (_f: unknown, w: number, h: number) => {
            log.push("resize");
            return frame(w, h);
        },
        downscale: (_f: unknown, w: number, h: number) => frame(w, h),
        crop: pass("crop"),
        look: pass("look"),
        lutMix: pass("lutMix"),
        legacy: (f: { width: number; height: number }, ops: unknown) => {
            log.push(`legacy:${JSON.stringify(ops)}`);
            return frame(f.width, f.height);
        },
        nearest: (_f: unknown, w: number, h: number) => {
            log.push("nearest");
            return frame(w, h);
        },
        adjustLayer: pass("adjustLayer"),
        composite: (base: unknown) => {
            log.push("composite");
            return base;
        },
        present: () => log.push("present"),
        releaseAll: () => undefined,
    };
    return { renderer: renderer as unknown as LookRenderer, log };
}

const layer = (patch: Partial<LayerOp>): LayerOp => ({
    kind: "layer", source: { kind: "image", url: "/m/s.png" }, bitmap: { width: 40, height: 20 }, crop: null, look: null, mosaic: 0,
    fadeAlpha: 1, dip: null, flipX: false, flipY: false, opacity: 1, place: { cx: 50, cy: 50, width: 40, height: 20, rotation: 0 },
    ...patch,
});

const sources = { frame: async () => null, image: async () => ({ width: 40, height: 20, close() {} }) as unknown as ImageBitmap, raster: async () => null };

describe("GpuCompositor", () => {
    it("runs the legacy ops after the look and before the mosaic", async () => {
        const { renderer, log } = recordingRenderer();
        const compositor = new GpuCompositor(renderer, { width: 100, height: 100 }, sources);
        const legacy = { blur: { radius: 3, mode: "rgb" as const }, chromaKey: null, eq: null };
        await compositor.render([layer({ look: { plan: { steps: [] } as never, mix: null, time: 0, keyframeTime: 0 }, mosaic: 4, legacy })]);
        expect(log).toEqual(["upload", "resize", "crop", "look", `legacy:${JSON.stringify(legacy)}`, "nearest", "nearest", "adjustLayer", "composite", "present"].filter((s) => s !== "crop"));
    });

    it("skips the legacy step for layers without legacy ops", async () => {
        const { renderer, log } = recordingRenderer();
        await new GpuCompositor(renderer, { width: 100, height: 100 }, sources).render([layer({})]);
        expect(log.some((entry) => entry.startsWith("legacy"))).toBe(false);
    });
});
