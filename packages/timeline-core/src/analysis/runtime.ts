// The local audio detectors (phase 11) as ONE self-contained function: analysisRuntime() references nothing outside its
// own body but globals such as Math and typed arrays, so a Web Worker can run it from its source text (timeline-react's
// browser analyzer builds its blob worker from analysisRuntime.toString(), as the 10d motion tracker does). silence.ts
// and beats.ts are thin wrappers over one runtime instance; the algorithms are documented there.
import type { BeatOptions, SilenceOptions, TimeRange } from "./host";

export interface BeatResult {
    bpm: number;
    times: number[];
}

export interface AnalysisRuntime {
    defaults: {
        silence: { readonly thresholdDb: -40; readonly minSilence: 0.35; readonly padding: 0.08 };
        /** Silence analysis window, seconds. */
        silenceWindowSeconds: number;
        beat: { readonly minBpm: 70; readonly maxBpm: 180 };
        /** Most beats kept. */
        maxBeats: number;
    };
    detectSilences(pcm: Float32Array, sampleRate: number, options?: SilenceOptions): TimeRange[];
    detectBeats(pcm: Float32Array, sampleRate: number, options?: BeatOptions): BeatResult;
    onsetEnvelope(pcm: Float32Array, sampleRate: number): { envelope: Float64Array; hop: number };
}

/** The detectors' whole implementation, closed over nothing (see the header). */
export function analysisRuntime(): AnalysisRuntime {
    const SILENCE_DEFAULTS = { thresholdDb: -40, minSilence: 0.35, padding: 0.08 } as const;
    const SILENCE_WINDOW_SECONDS = 0.01;
    const BEAT_DEFAULTS = { minBpm: 70, maxBpm: 180 } as const;
    const MAX_BEATS = 4000;
    const HOP_SECONDS = 0.01;
    const FRAME_SECONDS = 0.032;
    /** DP spacing penalty (Ellis's alpha). */
    const TIGHTNESS = 100;
    const SNAP_SECONDS = 0.03;

    const round3 = (x: number) => Math.round(x * 1000) / 1000;

    function detectSilences(pcm: Float32Array, sampleRate: number, options: SilenceOptions = {}): TimeRange[] {
        const thresholdDb = Number.isFinite(options.thresholdDb) ? options.thresholdDb! : SILENCE_DEFAULTS.thresholdDb;
        const minSilence = Number.isFinite(options.minSilence) && options.minSilence! >= 0 ? options.minSilence! : SILENCE_DEFAULTS.minSilence;
        const padding = Number.isFinite(options.padding) && options.padding! >= 0 ? options.padding! : SILENCE_DEFAULTS.padding;
        if (!(sampleRate > 0) || pcm.length === 0) return [];
        const window = Math.max(1, Math.round(sampleRate * SILENCE_WINDOW_SECONDS));
        const total = pcm.length / sampleRate;
        const threshold = 10 ** (thresholdDb / 20);
        const ranges: TimeRange[] = [];
        let runStart = -1;
        const close = (endSample: number) => {
            const start = runStart / sampleRate;
            const end = endSample / sampleRate;
            runStart = -1;
            if (end - start < minSilence - 1e-9) return;
            const from = start > 1e-9 ? start + padding : 0;
            const to = end < total - 1e-9 ? end - padding : total;
            if (to - from > 1e-6) ranges.push({ start: round3(from), end: round3(to) });
        };
        for (let offset = 0; offset < pcm.length; offset += window) {
            const end = Math.min(pcm.length, offset + window);
            let sum = 0;
            for (let i = offset; i < end; i += 1) sum += pcm[i] * pcm[i];
            const rms = Math.sqrt(sum / (end - offset));
            if (rms < threshold) {
                if (runStart < 0) runStart = offset;
            } else if (runStart >= 0) {
                close(offset);
            }
        }
        if (runStart >= 0) close(pcm.length);
        return ranges;
    }

    /** In-place radix-2 FFT (re, im of length n = 2^k). */
    function fft(re: Float64Array, im: Float64Array): void {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i += 1) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                const r = re[i];
                re[i] = re[j];
                re[j] = r;
                const m = im[i];
                im[i] = im[j];
                im[j] = m;
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const angle = (-2 * Math.PI) / len;
            const wr = Math.cos(angle);
            const wi = Math.sin(angle);
            for (let i = 0; i < n; i += len) {
                let cr = 1;
                let ci = 0;
                for (let k = 0; k < len / 2; k += 1) {
                    const a = i + k;
                    const b = a + len / 2;
                    const tr = re[b] * cr - im[b] * ci;
                    const ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                    const next = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = next;
                }
            }
        }
    }

    /** Onset strength per hop: half-wave rectified log-magnitude flux, frame k centred on sample k·hop. */
    function onsetEnvelope(pcm: Float32Array, sampleRate: number): { envelope: Float64Array; hop: number } {
        const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
        let n = 1;
        while (n < sampleRate * FRAME_SECONDS) n <<= 1;
        const frames = Math.floor(pcm.length / hop) + 1;
        const envelope = new Float64Array(frames);
        const window = new Float64Array(n);
        for (let i = 0; i < n; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        let previous = new Float64Array(n / 2);
        let current = new Float64Array(n / 2);
        for (let k = 0; k < frames; k += 1) {
            const start = k * hop - n / 2;
            for (let i = 0; i < n; i += 1) {
                const s = start + i;
                re[i] = s >= 0 && s < pcm.length ? pcm[s] * window[i] : 0;
                im[i] = 0;
            }
            fft(re, im);
            let flux = 0;
            for (let b = 1; b < n / 2; b += 1) {
                current[b] = Math.log1p(1000 * Math.hypot(re[b], im[b]));
                if (k > 0) flux += Math.max(0, current[b] - previous[b]);
            }
            envelope[k] = flux;
            const swap = previous;
            previous = current;
            current = swap;
        }
        return { envelope, hop };
    }

    /** The best period (frames, fractional) inside the BPM range, from the envelope's autocorrelation. */
    function estimatePeriod(onset: Float64Array, fps: number, minBpm: number, maxBpm: number): number | null {
        const minLag = Math.max(1, Math.floor((60 / maxBpm) * fps));
        const maxLag = Math.min(onset.length - 2, Math.ceil((60 / minBpm) * fps));
        if (maxLag <= minLag) return null;
        const ac = new Float64Array(maxLag + 2);
        for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1 && lag < onset.length; lag += 1) {
            let sum = 0;
            for (let i = lag; i < onset.length; i += 1) sum += onset[i] * onset[i - lag];
            ac[lag] = sum / (onset.length - lag);
        }
        let best = -1;
        let bestScore = 0;
        for (let lag = minLag; lag <= maxLag; lag += 1) {
            const bpm = (60 * fps) / lag;
            // A mild preference for tempos near 120 BPM breaks near ties between related tempos.
            const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.4) ** 2);
            const score = ac[lag] * weight;
            if (score > bestScore) {
                bestScore = score;
                best = lag;
            }
        }
        if (best < 0) return null;
        const a = ac[best - 1] ?? 0;
        const b = ac[best];
        const c = ac[best + 1] ?? 0;
        const denom = a - 2 * b + c;
        const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
        return best + shift;
    }

    /** Beat frames by dynamic programming over the onset envelope. */
    function trackBeats(onset: Float64Array, period: number): number[] {
        const n = onset.length;
        const score = new Float64Array(n);
        const back = new Int32Array(n).fill(-1);
        const lo = Math.max(1, Math.round(period / 2));
        const hi = Math.max(lo + 1, Math.round(period * 2));
        for (let t = 0; t < n; t += 1) {
            let best = 0;
            let from = -1;
            for (let tau = t - hi; tau <= t - lo; tau += 1) {
                if (tau < 0) continue;
                const gap = Math.log((t - tau) / period);
                const value = score[tau] - TIGHTNESS * gap * gap;
                if (from < 0 || value > best) {
                    best = value;
                    from = tau;
                }
            }
            score[t] = onset[t] + (from >= 0 ? Math.max(0, best) : 0);
            back[t] = from >= 0 && best > 0 ? from : -1;
        }
        // The last beat: the best score within the final period.
        let end = n - 1;
        for (let t = Math.max(0, n - Math.ceil(period)); t < n; t += 1) if (score[t] > score[end]) end = t;
        const beats: number[] = [];
        for (let t = end; t >= 0; t = back[t]) {
            beats.push(t);
            if (back[t] < 0) break;
        }
        return beats.reverse();
    }

    /** Fine (1 ms) positive-slope envelope of the waveform, to snap beats onto their transients. */
    function fineOnsets(pcm: Float32Array, sampleRate: number): { rise: Float64Array; step: number } {
        const step = Math.max(1, Math.round(sampleRate / 1000));
        const count = Math.floor(pcm.length / step);
        const level = new Float64Array(count);
        for (let k = 0; k < count; k += 1) {
            let peak = 0;
            for (let i = k * step; i < (k + 1) * step; i += 1) peak = Math.max(peak, Math.abs(pcm[i]));
            level[k] = peak;
        }
        const rise = new Float64Array(count);
        for (let k = 1; k < count; k += 1) rise[k] = Math.max(0, level[k] - level[k - 1]);
        return { rise, step };
    }

    function detectBeats(pcm: Float32Array, sampleRate: number, options: BeatOptions = {}): BeatResult {
        const minBpm = Number.isFinite(options.minBpm) && options.minBpm! > 0 ? options.minBpm! : BEAT_DEFAULTS.minBpm;
        const maxBpm = Number.isFinite(options.maxBpm) && options.maxBpm! > minBpm ? options.maxBpm! : Math.max(minBpm + 1, BEAT_DEFAULTS.maxBpm);
        if (!(sampleRate > 0) || pcm.length < sampleRate * 2) return { bpm: 0, times: [] };
        const { envelope, hop } = onsetEnvelope(pcm, sampleRate);
        const fps = sampleRate / hop;
        // Remove the slow trend (a moving mean over ~0.5 s) and normalise.
        const half = Math.round(fps * 0.25);
        const onset = new Float64Array(envelope.length);
        let peak = 0;
        for (let i = 0; i < envelope.length; i += 1) {
            let sum = 0;
            let count = 0;
            for (let j = Math.max(0, i - half); j <= Math.min(envelope.length - 1, i + half); j += 1) {
                sum += envelope[j];
                count += 1;
            }
            onset[i] = Math.max(0, envelope[i] - sum / count);
            peak = Math.max(peak, onset[i]);
        }
        if (!(peak > 1e-9)) return { bpm: 0, times: [] };
        for (let i = 0; i < onset.length; i += 1) onset[i] /= peak;
        const period = estimatePeriod(onset, fps, minBpm, maxBpm);
        if (!period) return { bpm: 0, times: [] };
        const frames = trackBeats(onset, period);
        const { rise, step } = fineOnsets(pcm, sampleRate);
        const reach = Math.round((SNAP_SECONDS * sampleRate) / step);
        const duration = pcm.length / sampleRate;
        let times = frames.map((frame) => {
            const centre = Math.round((frame * hop) / step);
            let best = -1;
            let bestRise = 0;
            for (let k = Math.max(1, centre - reach); k <= Math.min(rise.length - 1, centre + reach); k += 1) {
                if (rise[k] > bestRise) {
                    bestRise = rise[k];
                    best = k;
                }
            }
            const seconds = best >= 0 ? (best * step) / sampleRate : (frame * hop) / sampleRate;
            return Math.round(Math.min(duration, Math.max(0, seconds)) * 1000) / 1000;
        });
        times = times.filter((t, i) => i === 0 || t > times[i - 1] + 1e-6).slice(0, MAX_BEATS);
        // Tempo from the beats themselves (least squares over beat index), else the autocorrelation period.
        let bpm = (60 * fps) / period;
        if (times.length >= 4) {
            const m = times.length;
            const meanI = (m - 1) / 2;
            const meanT = times.reduce((a, b) => a + b, 0) / m;
            let num = 0;
            let den = 0;
            times.forEach((t, i) => {
                num += (i - meanI) * (t - meanT);
                den += (i - meanI) ** 2;
            });
            if (num > 0) bpm = 60 / (num / den);
        }
        return { bpm: Math.round(bpm * 100) / 100, times };
    }

    return {
        defaults: { silence: SILENCE_DEFAULTS, silenceWindowSeconds: SILENCE_WINDOW_SECONDS, beat: BEAT_DEFAULTS, maxBeats: MAX_BEATS },
        detectSilences,
        detectBeats,
        onsetEnvelope,
    };
}
