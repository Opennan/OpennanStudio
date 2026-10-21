// Local media analysis (phase 11): `analysis.run` asks the editor host to decode a clip's used range and run the pure
// detectors (analysis/silence.ts, analysis/beats.ts) — the browser host decodes with mediabunny in a worker, like the
// 10d motion tracker. The command changes nothing; applying a result is its own command (cuts.apply, beats.set), one
// undo step. Times in a job and its outcome are source-media seconds; the controller maps them to the timeline.

/** A half-open range of seconds. */
export interface TimeRange {
    start: number;
    end: number;
}

export interface SilenceOptions {
    /** Level under which audio counts as silence, dBFS (default -40). */
    thresholdDb?: number;
    /** Shortest silence worth cutting, seconds (default 0.35). */
    minSilence?: number;
    /** Audio kept on each side of a cut, seconds (default 0.08). */
    padding?: number;
}

export interface BeatOptions {
    /** Tempo search range, beats per minute (default 70..180). */
    minBpm?: number;
    maxBpm?: number;
}

export type AnalysisKind = "silences" | "beats";

export interface AnalysisJob {
    kind: AnalysisKind;
    /** The clip's media URL (resolved by the host's media environment). */
    mediaUrl: string;
    startSeconds: number;
    endSeconds: number;
    options: SilenceOptions | BeatOptions;
}

export interface AnalysisJobContext {
    signal?: AbortSignal;
    /** 0..1 */
    onProgress?(fraction: number): void;
}

export interface AnalysisJobOutcome {
    /** silences: ranges to cut (padding already applied), source seconds. */
    silences?: TimeRange[];
    /** beats: tempo and beat times, source seconds. */
    beats?: { bpm: number; times: number[] };
    unavailable?: boolean;
    cancelled?: boolean;
    error?: string;
}

export interface MediaAnalyzerHost {
    analyze(job: AnalysisJob, context: AnalysisJobContext): Promise<AnalysisJobOutcome>;
}
