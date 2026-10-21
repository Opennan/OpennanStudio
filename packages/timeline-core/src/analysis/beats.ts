// Beat detection (phase 11, "Detect beats"): an onset-strength envelope (log spectral flux, 10 ms hop), the tempo
// from its autocorrelation inside the BPM range, beats placed by dynamic programming (Ellis 2007: each beat rewards
// onset strength and penalises spacing away from the period, so a drifting tempo is followed), and every beat snapped to
// the steepest rise of the waveform's envelope within ±30 ms for millisecond accuracy. Pure; seconds from the first
// sample. The implementation lives in the self-contained analysisRuntime() (runtime.ts) so a worker can run it too.
import type { BeatOptions } from "./host";
import { analysisRuntime, type BeatResult } from "./runtime";

export type { BeatResult } from "./runtime";

const runtime = analysisRuntime();

export const BEAT_DEFAULTS = runtime.defaults.beat;
/** Most beats kept (beats.set accepts up to this many). */
export const MAX_BEATS = runtime.defaults.maxBeats;

/** Onset strength per hop: half-wave rectified log-magnitude flux, frame k centred on sample k·hop. */
export function onsetEnvelope(pcm: Float32Array, sampleRate: number): { envelope: Float64Array; hop: number } {
    return runtime.onsetEnvelope(pcm, sampleRate);
}

/** Tempo and beat times of mono PCM (seconds from the first sample). Silence or too little audio gives no beats. */
export function detectBeats(pcm: Float32Array, sampleRate: number, options: BeatOptions = {}): BeatResult {
    return runtime.detectBeats(pcm, sampleRate, options);
}
