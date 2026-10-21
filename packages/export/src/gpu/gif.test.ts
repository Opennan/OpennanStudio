import { gifEnd, gifFrameDurations, gifPick, gifPlays, gifTimeline, parseGif, type GifInfo } from "./gif";

/** A minimal GIF89a: no colour tables, one GCE per frame with the given delay, an optional NETSCAPE loop block. */
function gifBytes(delays: number[], loop: number | null): Uint8Array {
    const out: number[] = [...new TextEncoder().encode("GIF89a"), 4, 0, 3, 0, 0, 0, 0];
    if (loop !== null) out.push(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, loop & 255, loop >> 8, 0);
    for (const delay of delays) {
        out.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0);
        out.push(0x2c, 0, 0, 0, 0, 4, 0, 3, 0, 0, 2, 2, 0x4c, 0x01, 0);
    }
    out.push(0x3b);
    return new Uint8Array(out);
}

describe("GIF timing (ffmpeg's GIF demuxer with -ignore_loop 0)", () => {
    it("reads size, delays, and the loop count from the blocks", () => {
        expect(parseGif(gifBytes([5, 0, 12], 0))).toEqual({ width: 4, height: 3, delays: [5, 0, 12], loopCount: 0 });
        expect(parseGif(gifBytes([7], null)).loopCount).toBeNull();
        expect(() => parseGif(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow();
    });

    it("plays a 0 cs delay as 10 cs and loops as the loop count says", () => {
        const info: GifInfo = { width: 4, height: 3, delays: [5, 1, 0, 3], loopCount: 2 };
        expect(gifFrameDurations(info)).toEqual([0.05, 0.01, 0.1, 0.03]);
        expect(gifPlays(info)).toBe(2);
        expect(gifPlays({ ...info, loopCount: 0 })).toBe(Infinity);
        expect(gifPlays({ ...info, loopCount: null })).toBe(1);
        expect(gifEnd(info)).toBeCloseTo(0.38, 9);
        expect(gifTimeline(info, 0.3).map((f) => [f.time, f.image])).toEqual([[0, 0], [0.05, 1], [0.06, 2], [0.16, 3], [0.19, 0], [0.24, 1], [0.25, 2]]);
    });

    it("picks the frame at a time, ends with the last play, and reverses the read span", () => {
        const info: GifInfo = { width: 4, height: 3, delays: [10, 20], loopCount: 0 };
        expect(gifPick(info, 0)).toBe(0);
        expect(gifPick(info, 0.099)).toBe(0);
        expect(gifPick(info, 0.1)).toBe(1);
        expect(gifPick(info, 0.31)).toBe(0);
        expect(gifPick(info, 100.35)).toBe(1);
        expect(gifPick({ ...info, loopCount: null }, 0.31)).toBeNull();
        // 0.65 s of frames: 0 (0), 1 (0.1), 0 (0.3), 1 (0.4), 0 (0.6) → backwards 0, 1, 0, 1, 0.
        expect(gifPick(info, 0, { span: 0.65 })).toBe(0);
        expect(gifPick(info, 0.1, { span: 0.7 })).toBe(1);
    });
});
