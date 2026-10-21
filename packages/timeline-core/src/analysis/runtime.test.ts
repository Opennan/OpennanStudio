import { describe, expect, it } from "vitest";
import { analysisRuntime } from "./runtime";
import { detectBeats, BEAT_DEFAULTS, MAX_BEATS } from "./beats";
import { detectSilences, SILENCE_DEFAULTS } from "./silence";

const RATE = 16_000;

function toneGapTone(): Float32Array {
    const pcm = new Float32Array(RATE * 3);
    for (let i = 0; i < pcm.length; i += 1) {
        const t = i / RATE;
        pcm[i] = t < 1 || t >= 2 ? 0.5 * Math.sin(2 * Math.PI * 220 * t) : 0;
    }
    return pcm;
}

function clicks(bpm: number, seconds: number): Float32Array {
    const pcm = new Float32Array(Math.round(seconds * RATE));
    for (let t = 0.1; t < seconds - 0.05; t += 60 / bpm) {
        const start = Math.round(t * RATE);
        for (let i = 0; i < 480 && start + i < pcm.length; i += 1) pcm[start + i] += 0.8 * Math.exp(-i / 96) * Math.sin((2 * Math.PI * 1000 * i) / RATE);
    }
    return pcm;
}

describe("analysisRuntime", () => {
    it("is self-contained, so a worker can run it from its source text", () => {
        const runtime = new Function(`return (${analysisRuntime.toString()})();`)() as ReturnType<typeof analysisRuntime>;
        const pcm = toneGapTone();
        expect(runtime.detectSilences(pcm, RATE)).toEqual(detectSilences(pcm, RATE));
        const music = clicks(120, 8);
        const beats = runtime.detectBeats(music, RATE);
        expect(beats).toEqual(detectBeats(music, RATE));
        expect(Math.abs(beats.bpm - 120)).toBeLessThanOrEqual(1);
    });

    it("backs the exported detectors and their defaults", () => {
        const runtime = analysisRuntime();
        expect(SILENCE_DEFAULTS).toEqual({ thresholdDb: -40, minSilence: 0.35, padding: 0.08 });
        expect(BEAT_DEFAULTS).toEqual({ minBpm: 70, maxBpm: 180 });
        expect(MAX_BEATS).toBe(4000);
        expect(runtime.detectSilences(toneGapTone(), RATE)).toEqual([{ start: 1.08, end: 1.92 }]);
    });
});
