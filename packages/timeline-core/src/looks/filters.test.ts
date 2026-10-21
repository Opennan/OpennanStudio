import { describe, expect, it } from "vitest";
import { FILTER_CATEGORIES, FILTERS, filterById, filterPixel, normalizeFilterId } from "./filters";
import type { Rgb } from "./color";

const SAMPLES: Rgb[] = [
    [0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.9, 0.2, 0.1], [0.1, 0.6, 0.2], [0.2, 0.3, 0.9], [0.95, 0.75, 0.6], [0.05, 0.1, 0.15],
];

describe("filters", () => {
    it("ships 30 presets, 5 in each of 6 categories, with unique ids", () => {
        expect(FILTERS).toHaveLength(30);
        expect(FILTER_CATEGORIES).toEqual(["life", "movies", "retro", "bw", "food", "landscape"]);
        for (const category of FILTER_CATEGORIES) expect(FILTERS.filter((f) => f.category === category)).toHaveLength(5);
        expect(new Set(FILTERS.map((f) => f.id)).size).toBe(30);
    });

    it("keeps every output in range and changes the image", () => {
        for (const filter of FILTERS) {
            let changed = 0;
            for (const rgb of SAMPLES) {
                const out = filterPixel(filter.id, rgb, 1);
                expect(out.every((x) => Number.isFinite(x) && x >= 0 && x <= 1), filter.id).toBe(true);
                changed += Math.abs(out[0] - rgb[0]) + Math.abs(out[1] - rgb[1]) + Math.abs(out[2] - rgb[2]);
            }
            expect(changed, filter.id).toBeGreaterThan(0.2);
        }
    });

    it("black and white presets give neutral gray", () => {
        for (const filter of FILTERS.filter((f) => f.category === "bw" && f.id !== "selenium" && f.id !== "blue_tone")) {
            for (const rgb of SAMPLES) {
                const [r, g, b] = filterPixel(filter.id, rgb, 1);
                expect(Math.abs(r - g) + Math.abs(g - b), filter.id).toBeLessThan(1e-9);
            }
        }
    });

    it("mixes by intensity: 0 is identity, 0.5 is halfway", () => {
        const rgb: Rgb = [0.6, 0.4, 0.3];
        expect(filterPixel("teal_orange", rgb, 0)).toEqual(rgb);
        const full = filterPixel("teal_orange", rgb, 1);
        const half = filterPixel("teal_orange", rgb, 0.5);
        half.forEach((x, i) => expect(x).toBeCloseTo((rgb[i] + full[i]) / 2, 12));
    });

    it("maps legacy and unknown ids", () => {
        expect(normalizeFilterId("warm")).toBe("warm");
        expect(normalizeFilterId("CINEMATIC")).toBe("cinematic");
        expect(normalizeFilterId("nope")).toBe("none");
        expect(normalizeFilterId(null)).toBe("none");
        expect(filterById("none")).toBeNull();
        expect(filterPixel("none", [0.3, 0.2, 0.1], 1)).toEqual([0.3, 0.2, 0.1]);
    });
});
