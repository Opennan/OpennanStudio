// Audio for local analysis (phase 11): a media range decoded to mono PCM at 16 kHz (what the detectors read). mediabunny
// (WebCodecs, the same library as the timeline thumbnails and the motion tracker) decodes just the range; WebAudio's
// decodeAudioData of the whole file is the fallback where mediabunny cannot decode the track. Channels are averaged to
// mono and the rate is converted by a streaming box filter (each output sample is the mean of the source samples it
// covers; upsampling holds the last value), simple and enough for level and onset analysis.

export const ANALYSIS_SAMPLE_RATE = 16_000;

export interface DecodeRange {
    /** Source seconds. */
    start: number;
    end: number;
}

export interface DecodeContext {
    signal?: AbortSignal;
    /** 0..1 of the range decoded. */
    onProgress?(fraction: number): void;
}

export interface AnalysisAudioDecoder {
    /** Mono PCM at `sampleRate` of the range (already resolved URL), or null when this browser cannot decode it. */
    decode(url: string, init: RequestInit | undefined, range: DecodeRange, sampleRate: number, context: DecodeContext): Promise<Float32Array | null>;
}

export class DecodeAborted extends Error {
    constructor() {
        super("the decode was cancelled");
    }
}

/** The mean of the channels, sample by sample (one channel comes back as is). */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
    if (channels.length === 0) return new Float32Array(0);
    if (channels.length === 1) return channels[0];
    const length = Math.min(...channels.map((c) => c.length));
    const out = new Float32Array(length);
    const scale = 1 / channels.length;
    for (const channel of channels) for (let i = 0; i < length; i += 1) out[i] += channel[i] * scale;
    return out;
}

export interface MonoResampler {
    push(mono: Float32Array): void;
    /** Everything pushed, at the target rate. */
    finish(): Float32Array;
}

/** A streaming rate converter for mono chunks (see the header); `expectedSeconds` sizes the first buffer. */
export function createMonoResampler(fromRate: number, toRate: number, expectedSeconds = 0): MonoResampler {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error("sample rates must be positive");
    const step = fromRate / toRate;
    let out = new Float32Array(Math.max(1024, Math.ceil(expectedSeconds * toRate) + 16));
    let length = 0;
    let next = step;
    let index = 0;
    let sum = 0;
    let count = 0;
    let last = 0;
    const emit = (value: number) => {
        if (length === out.length) {
            const grown = new Float32Array(out.length * 2);
            grown.set(out);
            out = grown;
        }
        out[length++] = value;
    };
    return {
        push(mono) {
            for (let i = 0; i < mono.length; i += 1) {
                sum += mono[i];
                count += 1;
                index += 1;
                while (index >= next - 1e-9) {
                    last = count > 0 ? sum / count : last;
                    emit(last);
                    sum = 0;
                    count = 0;
                    next += step;
                }
            }
        },
        finish() {
            if (count > 0) {
                emit(sum / count);
                sum = 0;
                count = 0;
            }
            return out.slice(0, length);
        },
    };
}

/** Converts whole channels at once (the WebAudio fallback and tests). */
export function toMonoAt(channels: readonly Float32Array[], fromRate: number, toRate: number): Float32Array {
    const resampler = createMonoResampler(fromRate, toRate, (channels[0]?.length ?? 0) / fromRate);
    resampler.push(downmixToMono(channels));
    return resampler.finish();
}

function channelsOf(buffer: AudioBuffer, from: number, to: number): Float32Array[] {
    const out: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) out.push(buffer.getChannelData(c).subarray(from, to));
    return out;
}

const check = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DecodeAborted();
};

/** mediabunny: one Input per decode, AudioBufferSink over the primary audio track, only the range. */
export const mediabunnyAudioDecoder: AnalysisAudioDecoder = {
    async decode(url, init, range, sampleRate, context) {
        if (typeof AudioBuffer === "undefined") return null;
        const mb = await import("mediabunny");
        check(context.signal);
        const input = new mb.Input({ source: new mb.UrlSource(url, init ? { requestInit: init } : undefined), formats: mb.ALL_FORMATS });
        const stop = () => input.dispose();
        context.signal?.addEventListener("abort", stop, { once: true });
        try {
            const track = await input.getPrimaryAudioTrack();
            if (!track || !(await track.canDecode())) return null;
            check(context.signal);
            const sink = new mb.AudioBufferSink(track);
            const span = Math.max(1e-6, range.end - range.start);
            let resampler: MonoResampler | null = null;
            for await (const { buffer, timestamp, duration } of sink.buffers(range.start, range.end)) {
                check(context.signal);
                const rate = buffer.sampleRate;
                resampler ??= createMonoResampler(rate, sampleRate, span);
                const from = Math.max(0, Math.round((range.start - timestamp) * rate));
                const to = Math.min(buffer.length, Math.round((range.end - timestamp) * rate));
                if (to > from) resampler.push(downmixToMono(channelsOf(buffer, from, to)));
                context.onProgress?.(Math.max(0, Math.min(1, (timestamp + duration - range.start) / span)));
            }
            check(context.signal);
            return resampler ? resampler.finish() : new Float32Array(0);
        } catch (error) {
            if (context.signal?.aborted) throw new DecodeAborted();
            throw error;
        } finally {
            context.signal?.removeEventListener("abort", stop);
            input.dispose();
        }
    },
};

type AudioContextLike = { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>; close?(): Promise<void> };

/** WebAudio: the whole file fetched and decoded, then cut to the range. */
export const webAudioDecoder: AnalysisAudioDecoder = {
    async decode(url, init, range, sampleRate, context) {
        const scope = globalThis as unknown as { OfflineAudioContext?: new (channels: number, length: number, rate: number) => AudioContextLike };
        if (!scope.OfflineAudioContext || typeof fetch === "undefined") return null;
        const response = await fetch(url, { ...(init ?? {}), ...(context.signal ? { signal: context.signal } : {}) });
        if (!response.ok) throw new Error(`could not load the media (HTTP ${response.status})`);
        const data = await response.arrayBuffer();
        check(context.signal);
        const audio = await new scope.OfflineAudioContext(1, 1, 44_100).decodeAudioData(data);
        check(context.signal);
        const from = Math.max(0, Math.floor(range.start * audio.sampleRate));
        const to = Math.min(audio.length, Math.ceil(range.end * audio.sampleRate));
        context.onProgress?.(1);
        if (to <= from) return new Float32Array(0);
        return toMonoAt(channelsOf(audio, from, to), audio.sampleRate, sampleRate);
    },
};
