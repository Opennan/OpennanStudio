// The editor host's side of motion tracking (phase 10d). The controller plans which frames to analyse
// (tracking/plan.ts) and hands the job to the host, which decodes the frames and runs the tracker (timeline-react:
// mediabunny + a Web Worker). Hosts without video decoding (headless MCP) have no tracker: `tracking.run` then
// reports `unavailable`.
import type { SourceSize, TrackingFrame } from "./plan";
import type { TrackRegion, TrackSample, TrackerOptions } from "./tracker";

export interface TrackingJob {
    owner: { clipId: string } | { sceneId: string };
    /** The tracked item's media (resolve through the host's media environment). */
    mediaUrl: string;
    /** Item-local times and the media seconds to decode for each. */
    frames: TrackingFrame[];
    /** The frame the region was drawn on: tracking runs forward from it and backward to the first frame. */
    startIndex: number;
    region: TrackRegion;
    fps: number;
    options?: TrackerOptions;
}

export interface TrackingJobContext {
    /** Aborting stops the job: the worker is terminated and the decoder closed. */
    signal?: AbortSignal;
    /** Frames done over frames planned, 0..1. */
    onProgress?(fraction: number): void;
}

export interface TrackingJobOutcome {
    /** One sample per planned frame, in frame order (times are the frames' item-local times). */
    samples?: TrackSample[];
    /** The decoded video's pixel size. */
    source?: SourceSize;
    unavailable?: boolean;
    cancelled?: boolean;
    error?: string;
}

export interface MotionTrackerHost {
    track(job: TrackingJob, context: TrackingJobContext): Promise<TrackingJobOutcome>;
    /**
     * Boxes at scale 1 (frame fractions) of clips the host has laid out (text, stickers, videos), for followers
     * whose box the core cannot know. Missing ids are mapped as small boxes (reported as approximate).
     */
    anchors?(clipIds: string[]): Record<string, SourceSize | undefined>;
}

/** What a successful `tracking.run` returns as its CommandResult output. */
export interface TrackingRunOutput {
    samples: TrackSample[];
    source: SourceSize | null;
    fps: number;
    /** Samples marked lost (the position held). */
    lost: number;
}
