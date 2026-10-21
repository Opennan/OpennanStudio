// A graphics clip's layer is always the full preview frame; the selection box
// must hug what the composition actually paints.
import { describe, it, expect, beforeEach } from "vitest";
import { measureRemotionContentRect } from "./remotion-content-bounds";

function rect(el: HTMLElement, x: number, y: number, w: number, h: number) {
    el.getBoundingClientRect = () => ({
        x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
        toJSON: () => ({}),
    }) as DOMRect;
}

describe("measureRemotionContentRect", () => {
    let layer: HTMLElement;

    beforeEach(() => {
        document.body.innerHTML = "";
        layer = document.createElement("div");
        document.body.appendChild(layer);
        rect(layer, 0, 0, 1000, 500);
    });

    it("returns the union of painting children, not the full frame", () => {
        const wrapper = document.createElement("div");
        rect(wrapper, 0, 0, 1000, 500); // full-bleed wrapper — skipped
        const title = document.createElement("div");
        title.textContent = "Hello";
        rect(title, 200, 100, 300, 60);
        const badge = document.createElement("img");
        rect(badge, 600, 300, 100, 100);
        wrapper.append(title, badge);
        layer.appendChild(wrapper);

        expect(measureRemotionContentRect(layer)).toEqual({ x: 200, y: 100, w: 500, h: 300 });
    });

    it("ignores hidden and zero-size elements", () => {
        const hidden = document.createElement("div");
        hidden.textContent = "gone";
        hidden.style.display = "none";
        rect(hidden, 0, 0, 400, 400);
        const tiny = document.createElement("div");
        tiny.textContent = "x";
        rect(tiny, 10, 10, 1, 1);
        const shown = document.createElement("div");
        shown.textContent = "here";
        rect(shown, 100, 100, 50, 20);
        layer.append(hidden, tiny, shown);

        expect(measureRemotionContentRect(layer)).toEqual({ x: 100, y: 100, w: 50, h: 20 });
    });

    it("returns null when nothing measurable paints, so callers fall back", () => {
        const empty = document.createElement("div");
        rect(empty, 0, 0, 300, 200); // no text, no background, no border
        layer.appendChild(empty);

        expect(measureRemotionContentRect(layer)).toBeNull();
    });

    it("clamps content that overflows the layer, matching the export crop", () => {
        const wide = document.createElement("div");
        wide.textContent = "overflowing";
        rect(wide, -100, 50, 400, 100);
        layer.appendChild(wide);

        expect(measureRemotionContentRect(layer)).toEqual({ x: 0, y: 50, w: 300, h: 100 });
    });
});
