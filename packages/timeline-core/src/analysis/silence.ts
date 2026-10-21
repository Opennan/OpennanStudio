// Silence detection (phase 11, "Remove silences"): RMS level over 10 ms windows; a run of windows under the threshold
// that lasts at least `minSilence` is a silence, shrunk by `padding` on each side that borders sound so cuts keep a
// little breath around speech. A silence that starts at the very beginning (or ends at the very end) of the analysed
// audio has no sound on that side, so that side is not padded. Pure; times are seconds from the first sample. The
// implementation lives in the self-contained analysisRuntime() (runtime.ts) so a worker can run it too.
import type { SilenceOptions, TimeRange } from "./host";
import { analysisRuntime } from "./runtime";

const runtime = analysisRuntime();

export const SILENCE_DEFAULTS = runtime.defaults.silence;
/** Analysis window, seconds. */
export const SILENCE_WINDOW_SECONDS = runtime.defaults.silenceWindowSeconds;

/** Silences in mono PCM (samples in -1..1), seconds from the first sample, ordered, non-overlapping. */
export function detectSilences(pcm: Float32Array, sampleRate: number, options: SilenceOptions = {}): TimeRange[] {
    return runtime.detectSilences(pcm, sampleRate, options);
}
