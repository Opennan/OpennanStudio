// ai.run (spec §5.1.1): the controller runs a provider capability through the host's onAiRun handler and
// places the result. These types are the structural twins of @opennan/provider-sdk's AiRun*Like types
// (createAiRunner(registry) fits onAiRun as is); timeline-core does not import the SDK.
import type { ControllerSnapshot } from "./timeline-controller";

export interface CaptionCueWord {
    start: number;
    end: number;
    text: string;
}

export interface CaptionCue {
    startTime: number;
    endTime: number;
    text: string;
    /** Word timings in absolute (timeline) seconds like the cue; placement stores them clip-local in captionWordsJson. */
    words?: CaptionCueWord[];
}

/** The timeline item an AI tool ran on: a clip, or a scene (videos on V1 are scenes). */
export interface AiTargetRef {
    clipId?: string;
    sceneId?: string;
}

/** A result file after the host stored it in the project's media library. */
export interface AiMediaRef {
    url: string;
    name?: string;
    mimeType?: string;
    durationSeconds?: number;
    /** Which file among several (a stem: "vocals", "instrumental", "drums", "bass", "other"). */
    role?: string;
    /** Pixel size of a picture or video result, when the host knows it (stack-video keeps the source's size on screen). */
    width?: number;
    height?: number;
}

/** The source-media range a result covers (the clip's used range Studio sent, or its first N seconds). */
export interface AiSourceRange {
    startSeconds: number;
    endSeconds: number;
}

/**
 * Where an ai.run result goes (phase 11 adds every kind but captions-track). Each one is written as one persisted
 * command: one undo step.
 * - captions-track: a new "Captions" text track with one clip per cue (cue times are timeline seconds). `style`:
 *   "caption", "subtitle", or a caption style id (text/captions.ts); unknown ids fall back to "caption".
 * - captions-track-translated: a new captions track above the source track (`sourceTrackIndex`, text tracks) with the
 *   same timings; `untranslated` lists cue indexes that kept the source text; keepSource false deletes the source cues.
 * - replace-audio: new audio track(s) aligned to the source item's window over `range`; the source's own audio muted.
 * - stack-video: the result on a new video track directly above the source over `range`, same transform and look; the
 *   source hidden (opacity 0) unless hideSource is false, its audio muted only with muteSource; the result muted.
 *   `sourceSize` (the pixel size Studio sent) with the media's width/height keeps a resized result (an upscale) at the
 *   source's size on screen; `audioClipId` (lip sync's audio) takes the scene's sound when a scene is muted.
 * - insert-media: generated files on a free or new track at `at` (timeline seconds).
 */
export type AiPlacement =
    | { kind: "captions-track"; style: string; cues: CaptionCue[]; label?: string }
    | { kind: "captions-track-translated"; sourceTrackIndex: number; language: string; keepSource: boolean; style?: string; cues: CaptionCue[]; untranslated?: number[] }
    | { kind: "replace-audio"; source: AiTargetRef; media: AiMediaRef[]; range?: AiSourceRange }
    | {
        kind: "stack-video"; source: AiTargetRef; media: AiMediaRef; range?: AiSourceRange; hideSource?: boolean; muteSource?: boolean;
        sourceSize?: { width: number; height: number }; audioClipId?: string;
    }
    | { kind: "insert-media"; at: number; media: AiMediaRef[] };

export type AiPlacementKind = AiPlacement["kind"];

export interface AiRunRequest {
    capability: string;
    input: unknown;
    placeAt?: Record<string, unknown>;
}

export interface AiRunProgress {
    jobId: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    /** 0..1 */
    progress?: number;
    message?: string;
    /** false once cancel can no longer stop the job: it will finish and be charged. */
    cancellable?: boolean;
}

export interface AiRunContext {
    snapshot: ControllerSnapshot;
    signal?: AbortSignal;
    onProgress?(progress: AiRunProgress): void;
}

export interface AiRunOutcome {
    jobId?: string;
    /** The job's result (a Transcript for audio.transcribe). */
    output?: unknown;
    placement?: AiPlacement;
    error?: string;
    /** No provider offers the capability (CommandResult.unavailable). */
    unavailable?: boolean;
    cancelled?: boolean;
}
