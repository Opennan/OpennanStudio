import { detectBeats, detectSilences } from "@opennan/timeline-core";
import { analysisWorkerSource, createInlineAnalysisChannel } from "./analysis-worker";
import { createMonoResampler, downmixToMono, toMonoAt, type AnalysisAudioDecoder } from "./audio-decoder";
import { createBrowserAnalyzer } from "./browser-analyzer";

const RATE = 16_000;
const media = { resolveMediaUrl: (url: string) => `https://cdn.test/${url}` };

/** tone 1 s · silence 1 s · tone 1 s at `rate`. */
function toneGapTone(rate = RATE): Float32Array {
    const pcm = new Float32Array(rate * 3);
    for (let i = 0; i < pcm.length; i += 1) {
        const t = i / rate;
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

const fixedDecoder = (pcm: Float32Array | null): AnalysisAudioDecoder & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
        calls,
        async decode(...args) {
            calls.push(args);
            args[4].onProgress?.(0.5);
            return pcm ? pcm.slice() : null;
        },
    };
};

describe("downmix and resample", () => {
    it("averages channels into mono", () => {
        expect(Array.from(downmixToMono([Float32Array.from([1, 0.5, -1]), Float32Array.from([0, 0.5, 1])]))).toEqual([0.5, 0.5, 0]);
        const one = Float32Array.from([0.1, 0.2]);
        expect(downmixToMono([one])).toBe(one);
        expect(downmixToMono([]).length).toBe(0);
    });

    it("converts 48 kHz stereo to 16 kHz mono: length, level, and pitch kept", () => {
        const from = 48_000;
        const left = new Float32Array(from);
        const right = new Float32Array(from);
        for (let i = 0; i < from; i += 1) {
            left[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / from);
            right[i] = left[i];
        }
        const mono = toMonoAt([left, right], from, RATE);
        expect(mono.length).toBe(RATE);
        const rms = Math.sqrt(mono.reduce((s, v) => s + v * v, 0) / mono.length);
        expect(rms).toBeGreaterThan(0.38);
        expect(rms).toBeLessThan(0.43);
        // Zero crossings of a 440 Hz tone over one second: about 880.
        let crossings = 0;
        for (let i = 1; i < mono.length; i += 1) if ((mono[i - 1] < 0) !== (mono[i] < 0)) crossings += 1;
        expect(Math.abs(crossings - 880)).toBeLessThanOrEqual(4);
    });

    it("streams in chunks exactly like one pass, at awkward rates, and upsamples by holding", () => {
        const from = 44_100;
        const signal = new Float32Array(from * 2).map((_, i) => Math.sin(i / 7));
        const whole = toMonoAt([signal], from, RATE);
        const streamed = createMonoResampler(from, RATE);
        for (let at = 0; at < signal.length; at += 999) streamed.push(signal.subarray(at, Math.min(signal.length, at + 999)));
        const chunked = streamed.finish();
        expect(chunked.length).toBe(whole.length);
        expect(Math.abs(chunked.length - 2 * RATE)).toBeLessThanOrEqual(1);
        expect(Array.from(chunked.slice(0, 50))).toEqual(Array.from(whole.slice(0, 50)));
        const up = toMonoAt([Float32Array.from([0.25, 0.5])], 8_000, RATE);
        expect(Array.from(up)).toEqual([0.25, 0.25, 0.5, 0.5]);
    });
});

describe("analysis channel", () => {
    it("runs the detectors in-process with the worker's protocol", async () => {
        const channel = createInlineAnalysisChannel();
        const pcm = toneGapTone();
        expect(await channel.run("silences", pcm.slice(), RATE, { thresholdDb: -40 })).toEqual({ silences: detectSilences(pcm, RATE, { thresholdDb: -40 }) });
        const music = clicks(120, 6);
        expect(await channel.run("beats", music.slice(), RATE)).toEqual({ beats: detectBeats(music, RATE) });
        channel.dispose();
        await expect(channel.run("silences", pcm, RATE)).rejects.toThrow(/stopped/);
    });

    it("builds a worker script that runs on its own", async () => {
        const replies: unknown[] = [];
        const self: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: unknown): void } = { onmessage: null, postMessage: (m) => replies.push(m) };
        new Function("self", analysisWorkerSource())(self);
        self.onmessage!({ data: { id: 7, kind: "silences", pcm: toneGapTone(), sampleRate: RATE } });
        self.onmessage!({ data: { id: 8, kind: "nope", pcm: new Float32Array(1), sampleRate: RATE } });
        expect(replies).toEqual([{ id: 7, silences: [{ start: 1.08, end: 1.92 }] }, { id: 8, error: "unknown analysis kind nope" }]);
    });
});

describe("createBrowserAnalyzer", () => {
    it("decodes the range and returns silences in source seconds", async () => {
        const decoder = fixedDecoder(toneGapTone());
        const progress: number[] = [];
        const analyzer = createBrowserAnalyzer({ media, decoders: [decoder], createChannel: createInlineAnalysisChannel });
        const outcome = await analyzer.analyze(
            { kind: "silences", mediaUrl: "a.mp4", startSeconds: 10, endSeconds: 13, options: {} },
            { onProgress: (p) => progress.push(p) },
        );
        expect(outcome).toEqual({ silences: [{ start: 11.08, end: 11.92 }] });
        expect(decoder.calls[0].slice(0, 4)).toEqual(["https://cdn.test/a.mp4", { credentials: "omit" }, { start: 10, end: 13 }, RATE]);
        expect(progress[0]).toBeCloseTo(0.425);
        expect(progress[progress.length - 1]).toBe(1);
    });

    it("returns beats in source seconds", async () => {
        const analyzer = createBrowserAnalyzer({ media, decoders: [fixedDecoder(clicks(120, 6))], createChannel: createInlineAnalysisChannel });
        const outcome = await analyzer.analyze({ kind: "beats", mediaUrl: "m.mp3", startSeconds: 2, endSeconds: 8, options: {} }, {});
        expect(Math.abs(outcome.beats!.bpm - 120)).toBeLessThanOrEqual(1);
        expect(outcome.beats!.times[0]).toBeCloseTo(2.1, 1);
    });

    it("falls back to the next decoder, and is unavailable when none can decode", async () => {
        const first = fixedDecoder(null);
        const broken: AnalysisAudioDecoder = { decode: async () => { throw new Error("bad codec"); } };
        const second = fixedDecoder(toneGapTone());
        const analyzer = createBrowserAnalyzer({ media, decoders: [first, broken, second], createChannel: createInlineAnalysisChannel });
        expect((await analyzer.analyze({ kind: "silences", mediaUrl: "a.mp4", startSeconds: 0, endSeconds: 3, options: {} }, {})).silences).toHaveLength(1);
        expect(first.calls).toHaveLength(1);
        const none = createBrowserAnalyzer({ media, decoders: [fixedDecoder(null)], createChannel: createInlineAnalysisChannel });
        expect(await none.analyze({ kind: "silences", mediaUrl: "a.mp4", startSeconds: 0, endSeconds: 3, options: {} }, {})).toMatchObject({ unavailable: true });
        const failing = createBrowserAnalyzer({ media, decoders: [broken], createChannel: createInlineAnalysisChannel });
        expect(await failing.analyze({ kind: "silences", mediaUrl: "a.mp4", startSeconds: 0, endSeconds: 3, options: {} }, {})).toEqual({ error: "could not decode the audio: bad codec" });
    });

    it("cancel during the decode or the detectors stops both", async () => {
        const abort = new AbortController();
        let release!: () => void;
        const slow: AnalysisAudioDecoder = {
            decode: (_url, _init, _range, _rate, context) => new Promise((resolve, reject) => {
                context.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                release = () => resolve(toneGapTone());
            }),
        };
        const analyzer = createBrowserAnalyzer({ media, decoders: [slow], createChannel: createInlineAnalysisChannel });
        const pending = analyzer.analyze({ kind: "silences", mediaUrl: "a.mp4", startSeconds: 0, endSeconds: 3, options: {} }, { signal: abort.signal });
        await Promise.resolve();
        abort.abort();
        expect(await pending).toEqual({ cancelled: true });
        expect(release).toBeTypeOf("function");

        // Cancel while the worker runs: the channel is disposed (the worker terminated) and the run reports cancelled.
        const abort2 = new AbortController();
        const dispose = vi.fn();
        const working = createBrowserAnalyzer({
            media, decoders: [fixedDecoder(toneGapTone())],
            createChannel: () => {
                const inner = createInlineAnalysisChannel();
                return {
                    run: (...args) => {
                        const running = inner.run(...args);
                        abort2.abort();
                        return running;
                    },
                    dispose: () => {
                        dispose();
                        inner.dispose();
                    },
                };
            },
        });
        expect(await working.analyze({ kind: "silences", mediaUrl: "a.mp4", startSeconds: 0, endSeconds: 3, options: {} }, { signal: abort2.signal })).toEqual({ cancelled: true });
        expect(dispose).toHaveBeenCalled();
    });
});
