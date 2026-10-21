// The browser's MediaAnalyzerHost (phase 11): `analysis.run` decodes the item's used range to mono 16 kHz PCM
// (audio-decoder.ts: mediabunny, else WebAudio) and runs timeline-core's detectors in a worker (analysis-worker.ts).
// Results come back in source seconds, as the controller expects. Cancel (the signal) stops the decode and terminates
// the worker. TimelineProvider makes this the default analyzer (its `analyzer` prop: null turns analysis off).
import type { AnalysisJob, AnalysisJobContext, AnalysisJobOutcome, MediaAnalyzerHost } from "@opennan/timeline-core";
import { mediaRequestInit, type MotionTrackerHostOptions } from "../tracking/motion-tracker-host";
import { createDefaultAnalysisChannel, type AnalysisChannel } from "./analysis-worker";
import { ANALYSIS_SAMPLE_RATE, DecodeAborted, mediabunnyAudioDecoder, webAudioDecoder, type AnalysisAudioDecoder } from "./audio-decoder";

export interface BrowserAnalyzerOptions {
    media: MotionTrackerHostOptions["media"];
    /** Tried in order until one decodes (default: mediabunny, then WebAudio). */
    decoders?: AnalysisAudioDecoder[];
    createChannel?: () => AnalysisChannel;
    sampleRate?: number;
}

/** Share of the progress bar the decode takes; the detectors take the rest. */
const DECODE_SHARE = 0.85;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function createBrowserAnalyzer(options: BrowserAnalyzerOptions): MediaAnalyzerHost {
    const decoders = options.decoders ?? [mediabunnyAudioDecoder, webAudioDecoder];
    const createChannel = options.createChannel ?? createDefaultAnalysisChannel;
    const sampleRate = options.sampleRate ?? ANALYSIS_SAMPLE_RATE;
    return {
        async analyze(job: AnalysisJob, context: AnalysisJobContext): Promise<AnalysisJobOutcome> {
            const { signal } = context;
            if (signal?.aborted) return { cancelled: true };
            if (job.kind !== "silences" && job.kind !== "beats") return { error: `unknown analysis kind ${String(job.kind)}` };
            const range = { start: Math.max(0, job.startSeconds), end: Math.max(job.startSeconds, job.endSeconds) };
            if (!(range.end > range.start)) return { error: "the clip has no length to analyse" };
            let pcm: Float32Array | null = null;
            let lastError: unknown = null;
            try {
                const url = options.media.resolveMediaUrl(job.mediaUrl);
                const init = await mediaRequestInit(options.media, url);
                for (const decoder of decoders) {
                    if (signal?.aborted) return { cancelled: true };
                    try {
                        pcm = await decoder.decode(url, init, range, sampleRate, {
                            signal,
                            onProgress: (fraction) => context.onProgress?.(Math.max(0, Math.min(1, fraction)) * DECODE_SHARE),
                        });
                    } catch (error) {
                        if (error instanceof DecodeAborted || signal?.aborted) return { cancelled: true };
                        lastError = error;
                        pcm = null;
                    }
                    if (pcm) break;
                }
            } catch (error) {
                if (signal?.aborted) return { cancelled: true };
                return { error: `could not open the media: ${error instanceof Error ? error.message : String(error)}` };
            }
            if (signal?.aborted) return { cancelled: true };
            if (!pcm) {
                if (lastError) return { error: `could not decode the audio: ${lastError instanceof Error ? lastError.message : String(lastError)}` };
                return { unavailable: true, error: "this browser cannot decode the clip's audio" };
            }
            const channel = createChannel();
            const stop = () => channel.dispose();
            signal?.addEventListener("abort", stop, { once: true });
            try {
                const result = await channel.run(job.kind, pcm, sampleRate, job.options);
                if (signal?.aborted) return { cancelled: true };
                context.onProgress?.(1);
                const offset = range.start;
                if (job.kind === "silences") {
                    return { silences: (result.silences ?? []).map((r) => ({ start: round6(r.start + offset), end: round6(r.end + offset) })) };
                }
                const beats = result.beats ?? { bpm: 0, times: [] };
                return { beats: { bpm: beats.bpm, times: beats.times.map((t) => round6(t + offset)) } };
            } catch (error) {
                if (signal?.aborted) return { cancelled: true };
                return { error: error instanceof Error ? error.message : String(error) };
            } finally {
                signal?.removeEventListener("abort", stop);
                channel.dispose();
            }
        },
    };
}
