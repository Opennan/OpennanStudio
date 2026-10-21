import { describe, expect, it, vi } from "vitest";
import { applySceneMask, objectFitRect, sceneMaskLayer } from "./scene-mask-css";

describe("objectFitRect", () => {
    it("matches object-fit contain, cover, and fill inside the element box", () => {
        expect(objectFitRect("contain", { w: 1920, h: 1080 }, { w: 400, h: 400 })).toEqual({ x: 0, y: 87.5, w: 400, h: 225 });
        expect(objectFitRect("cover", { w: 1920, h: 1080 }, { w: 400, h: 400 })).toEqual({ x: -155.55555555555554, y: 0, w: 711.1111111111111, h: 400 });
        expect(objectFitRect("fill", { w: 1920, h: 1080 }, { w: 400, h: 400 })).toEqual({ x: 0, y: 0, w: 400, h: 400 });
        expect(objectFitRect(null, { w: 0, h: 0 }, { w: 400, h: 300 })).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    });
});

describe("sceneMaskLayer", () => {
    const scene = { id: "s", fitMode: "contain" as const, maskJson: '{"shape":"circle"}' };

    it("is null without a mask, else the fitted rect, a capped image size, and a key that changes with keyframed values", () => {
        expect(sceneMaskLayer({ id: "s" }, { w: 1920, h: 1080 }, { w: 400, h: 400 }, 0)).toBeNull();
        const layer = sceneMaskLayer(scene, { w: 1920, h: 1080 }, { w: 400, h: 400 }, 0)!;
        expect(layer.rect).toEqual({ x: 0, y: 87.5, w: 400, h: 225 });
        expect(layer.image).toEqual({ w: 256, h: 144 });
        const keyed = { ...scene, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 2, mask_x: 0.8 }] }) };
        const a = sceneMaskLayer(keyed, { w: 1920, h: 1080 }, { w: 400, h: 400 }, 0.5)!;
        const b = sceneMaskLayer(keyed, { w: 1920, h: 1080 }, { w: 400, h: 400 }, 1)!;
        expect(a.key).not.toBe(b.key);
        expect(a.image.w).toBeLessThanOrEqual(160);
        expect(a.spec.x).toBeCloseTo(0.35, 9);
    });
});

describe("applySceneMask", () => {
    it("sets the mask image at the fitted rect once per key, and clears it when the mask goes", () => {
        const el = document.createElement("video");
        const render = vi.fn(() => "data:image/png;base64,AAAA");
        const layer = sceneMaskLayer({ id: "s", maskJson: '{"shape":"star"}' }, { w: 1920, h: 1080 }, { w: 400, h: 400 }, 0)!;
        applySceneMask(el, layer, render);
        applySceneMask(el, layer, render);
        expect(render).toHaveBeenCalledTimes(1);
        expect(el.style.getPropertyValue("mask-image")).toBe('url("data:image/png;base64,AAAA")');
        expect(el.style.getPropertyValue("mask-size")).toBe("400px 225px");
        expect(el.style.getPropertyValue("mask-position")).toBe("0px 87.5px");
        expect(el.style.getPropertyValue("mask-repeat")).toBe("no-repeat");
        applySceneMask(el, null, render);
        expect(el.style.getPropertyValue("mask-image")).toBe("");
    });
});
