import { boxBlurRgba } from "./box-blur";

function image(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) data.set(fill(x, y), (y * w + x) * 4);
    return data;
}

describe("boxBlurRgba", () => {
    it("is the identity at radius 0 and does not mutate its input", () => {
        const src = image(5, 4, (x, y) => [x * 40, y * 50, 7, (x + y) * 20]);
        const copy = new Uint8ClampedArray(src);
        expect(Array.from(boxBlurRgba(src, 5, 4, 0))).toEqual(Array.from(src));
        boxBlurRgba(src, 5, 4, 3);
        expect(Array.from(src)).toEqual(Array.from(copy));
    });

    it("preserves a flat image exactly", () => {
        const src = image(9, 7, () => [200, 100, 50, 180]);
        expect(Array.from(boxBlurRgba(src, 9, 7, 4))).toEqual(Array.from(src));
    });

    it("spreads a centred dot symmetrically and keeps its mass", () => {
        const w = 41;
        const src = image(w, w, (x, y) => (x === 20 && y === 20 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
        const out = boxBlurRgba(src, w, w, 3);
        const alpha = (x: number, y: number) => out[(y * w + x) * 4 + 3];
        for (let y = 0; y < w; y += 1) {
            for (let x = 0; x < w; x += 1) {
                expect(alpha(x, y)).toBe(alpha(w - 1 - x, y));
                expect(alpha(x, y)).toBe(alpha(x, w - 1 - y));
                expect(alpha(x, y)).toBe(alpha(y, x));
            }
        }
        expect(alpha(20, 20)).toBeGreaterThan(0);
        expect(alpha(20, 20)).toBeLessThan(255);
        expect(alpha(20, 20)).toBeGreaterThan(alpha(23, 20));
        let mass = 0;
        for (let i = 3; i < out.length; i += 4) mass += out[i];
        expect(Math.abs(mass - 255)).toBeLessThan(60);
        // premultiplied: coloured pixels keep their colour where alpha is non-zero
        expect(out[(20 * w + 21) * 4]).toBe(255);
    });

    it("does not bleed colour from transparent pixels (premultiplied)", () => {
        const src = image(6, 1, (x) => (x < 3 ? [255, 0, 0, 0] : [0, 0, 255, 255]));
        const out = boxBlurRgba(src, 6, 1, 1);
        for (let x = 0; x < 6; x += 1) if (out[x * 4 + 3] > 0) expect(out[x * 4]).toBe(0);
    });

    it("is deterministic", () => {
        const src = image(13, 11, (x, y) => [(x * 37 + y * 11) % 256, (x * y) % 256, (x ^ y) * 9 % 256, (x * 19 + y * 23) % 256]);
        expect(Array.from(boxBlurRgba(src, 13, 11, 2))).toEqual(Array.from(boxBlurRgba(src, 13, 11, 2)));
    });
});
