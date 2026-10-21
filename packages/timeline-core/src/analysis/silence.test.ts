import { describe, expect, it } from "vitest";
import { detectSilences } from "./silence";

const RATE = 16_000;

/** Segments of tone (amplitude) or silence (0), seconds. */
function signal(parts: Array<[seconds: number, amplitude: number]>, noise = 0): Float32Array {
    const total = parts.reduce((sum, [s]) => sum + Math.round(s * RATE), 0);
    const pcm = new Float32Array(total);
    let at = 0;
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (const [seconds, amplitude] of parts) {
        const n = Math.round(seconds * RATE);
        for (let i = 0; i < n; i += 1) pcm[at + i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE) + noise * rand();
        at += n;
    }
    return pcm;
}

describe("detectSilences", () => {
    it("finds a gap between tones, padded on both sides", () => {
        expect(detectSilences(signal([[1, 0.5], [1, 0], [1, 0.5]]), RATE)).toEqual([{ start: 1.08, end: 1.92 }]);
    });

    it("does not pad a silence at the start or the end (no sound there)", () => {
        expect(detectSilences(signal([[0.5, 0], [1, 0.5], [0.6, 0]]), RATE)).toEqual([{ start: 0, end: 0.42 }, { start: 1.58, end: 2.1 }]);
    });

    it("ignores gaps shorter than minSilence and honours the options", () => {
        const pcm = signal([[1, 0.5], [0.3, 0], [1, 0.5], [0.5, 0], [1, 0.5]]);
        expect(detectSilences(pcm, RATE)).toEqual([{ start: 2.38, end: 2.72 }]);
        expect(detectSilences(pcm, RATE, { minSilence: 0.2, padding: 0 })).toEqual([{ start: 1, end: 1.3 }, { start: 2.3, end: 2.8 }]);
    });

    it("treats quiet noise under the threshold as silence and louder noise as sound", () => {
        const quiet = signal([[1, 0.5], [1, 0], [1, 0.5]], 0.01); // uniform noise: RMS about -45 dBFS
        expect(detectSilences(quiet, RATE)).toEqual([{ start: 1.08, end: 1.92 }]);
        expect(detectSilences(quiet, RATE, { thresholdDb: -50 })).toEqual([]);
    });

    it("drops a silence the padding would swallow, and handles empty input", () => {
        expect(detectSilences(signal([[1, 0.5], [0.36, 0], [1, 0.5]]), RATE, { padding: 0.2 })).toEqual([]);
        expect(detectSilences(new Float32Array(0), RATE)).toEqual([]);
        expect(detectSilences(signal([[1, 0]]), RATE)).toEqual([{ start: 0, end: 1 }]);
    });
});
