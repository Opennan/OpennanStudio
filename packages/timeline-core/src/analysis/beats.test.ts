import { describe, expect, it } from "vitest";
import { detectBeats } from "./beats";

const RATE = 16_000;

/** A click track: a short decaying 1 kHz burst on every beat (plus an accent every 4), over faint noise. */
function clickTrack(bpm: number, seconds: number, offset: number, noise = 0.002): { pcm: Float32Array; beats: number[] } {
    const pcm = new Float32Array(Math.round(seconds * RATE));
    let seed = 7;
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = noise * (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
    const beats: number[] = [];
    for (let k = 0, t = offset; t < seconds - 0.05; k += 1, t = offset + (k * 60) / bpm) {
        beats.push(t);
        const start = Math.round(t * RATE);
        const amplitude = k % 4 === 0 ? 0.9 : 0.6;
        for (let i = 0; i < Math.round(0.03 * RATE) && start + i < pcm.length; i += 1) {
            pcm[start + i] += amplitude * Math.exp(-i / (0.006 * RATE)) * Math.sin((2 * Math.PI * 1000 * i) / RATE);
        }
    }
    return { pcm, beats };
}

function expectBeats(result: { bpm: number; times: number[] }, bpm: number, beats: number[]) {
    expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(1);
    // Every true beat has a detected beat within 20 ms, and nothing extra is found.
    for (const beat of beats) expect(Math.min(...result.times.map((t) => Math.abs(t - beat)))).toBeLessThanOrEqual(0.02);
    expect(result.times.length).toBe(beats.length);
}

describe("detectBeats", () => {
    it("finds 120 BPM and every click of a click track within 20 ms", () => {
        const { pcm, beats } = clickTrack(120, 20, 0.25);
        expectBeats(detectBeats(pcm, RATE), 120, beats);
    });

    it("finds 95 BPM", () => {
        const { pcm, beats } = clickTrack(95, 24, 0.4);
        expectBeats(detectBeats(pcm, RATE), 95, beats);
    });

    it("follows the BPM range", () => {
        const { pcm } = clickTrack(150, 16, 0.1);
        expect(Math.abs(detectBeats(pcm, RATE).bpm - 150)).toBeLessThanOrEqual(1);
        // Limited to 60..100 BPM, the same track counts every other click.
        expect(Math.abs(detectBeats(pcm, RATE, { minBpm: 60, maxBpm: 100 }).bpm - 75)).toBeLessThanOrEqual(1);
    });

    it("answers no beats for silence or too little audio", () => {
        expect(detectBeats(new Float32Array(RATE * 5), RATE)).toEqual({ bpm: 0, times: [] });
        expect(detectBeats(new Float32Array(RATE), RATE)).toEqual({ bpm: 0, times: [] });
    });
});
