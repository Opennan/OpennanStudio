// The copy's shot finder in the page: how two small frames differ, and which times it samples.
import { frameDifference, sampleTimes } from "./story-shots";

describe("story shots", () => {
    it("measures the colour change of two frames from 0 (same) to 1 (black to white)", () => {
        const black = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
        const white = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
        expect(frameDifference(black, black)).toBe(0);
        expect(frameDifference(black, white)).toBe(1);
        expect(frameDifference(black, new Uint8ClampedArray([51, 51, 51, 255, 0, 0, 0, 255]))).toBeCloseTo(0.1, 5);
    });

    it("samples six frames a second, fewer on a long video, never past the end", () => {
        expect(sampleTimes(2)).toEqual([0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1, 7 / 6, 8 / 6, 9 / 6, 10 / 6, 11 / 6]);
        const long = sampleTimes(3600);
        expect(long.length).toBeLessThanOrEqual(1500);
        expect(long.at(-1)!).toBeLessThan(3600);
        expect(sampleTimes(0.1).length).toBe(2);
    });
});
