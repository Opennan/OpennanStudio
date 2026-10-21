import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, clampLayout, loadLayout, resizeBy, saveLayout } from "./editor-layout";

describe("editor layout", () => {
    it("clamps every panel and falls back to defaults", () => {
        expect(clampLayout({ library: 10, inspector: 9999, timeline: Number.NaN })).toEqual({ library: 220, inspector: 480, timeline: DEFAULT_LAYOUT.timeline });
    });

    it("persists and reloads, surviving broken storage", () => {
        const store = new Map<string, string>();
        const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
        saveLayout({ library: 333, inspector: 300, timeline: 250 }, storage);
        expect(JSON.parse(store.get(LAYOUT_STORAGE_KEY)!)).toEqual({ library: 333, inspector: 300, timeline: 250 });
        expect(loadLayout(storage)).toEqual({ library: 333, inspector: 300, timeline: 250 });
        expect(loadLayout({ getItem: () => "{oops" })).toEqual(DEFAULT_LAYOUT);
        expect(loadLayout({ getItem: () => { throw new Error("blocked"); } })).toEqual(DEFAULT_LAYOUT);
        expect(() => saveLayout(DEFAULT_LAYOUT, { setItem: () => { throw new Error("full"); } })).not.toThrow();
    });

    it("resizes in the drag direction", () => {
        expect(resizeBy(DEFAULT_LAYOUT, "library", 40, 1).library).toBe(340);
        expect(resizeBy(DEFAULT_LAYOUT, "inspector", 40, -1).inspector).toBe(280);
        expect(resizeBy(DEFAULT_LAYOUT, "timeline", -1000, -1).timeline).toBe(640);
    });
});
