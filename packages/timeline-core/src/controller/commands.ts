// EditorCommand (spec §5.1.1, extended per the phase 2 plan): every editor
// action is a typed, serializable command executed by TimelineController.
import type { AiRunProgress } from "./ai-run";
import type { AdjustmentPatch } from "../looks/adjust";
import type { AttributeKind, AttributeSnapshot, AttributeTarget } from "../attributes/attributes";
import type { EasingId } from "../motion/easing";
import type { MaskPatch } from "../looks/masks";
import type { AnimationSlot } from "../motion/types";
import type { AudioTarget } from "../model/editor";
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import type { TimelineClipCommand } from "../lib/timeline-commits";
import type { TimelineClipboard } from "../lib/timeline-editing";
import type { ClipTransformPatch, ItemTarget, ItemTransform, SceneTransformPatch } from "./items-plan";
import type {
    AddSceneInput,
    ClipEffectPatch,
    CreateClipInput,
    ExtractShotInput,
    MergeShotInput,
    ProjectMeta,
    RemovedTrackRef,
    SceneMove,
    TimelineClipUpdate,
} from "../backend/types";
import type { OptimisticSceneSplit, SelectedTransition, TimelineToolMode } from "../store/editor-store";
import type { SourceSize, TrackingFollower } from "../tracking/plan";
import type { TrackRegion, TrackSample } from "../tracking/tracker";
import type { BeatOptions, SilenceOptions } from "../analysis/host";
import type { CaptionCueWord } from "./ai-run";

export interface TrackRef {
    type: string;
    index: number;
}

export type EditorCommand =
    /** `tracks`: a full track list to write first (a clip on a new track), in the same undo step. */
    | { type: "clip.create"; input: CreateClipInput | CreateClipInput[]; tracks?: TimelineTrack[] }
    | { type: "clip.update"; clipIds: string[]; patch: Partial<Omit<TimelineClip, "id" | "projectId">> }
    | { type: "clip.updateMany"; updates: TimelineClipUpdate[] }
    | { type: "clip.move"; clipIds: string[]; deltaSeconds: number; targetTrack?: TrackRef }
    | { type: "clip.split"; clipIds: string[]; atSeconds: number }
    | { type: "clip.delete"; clipIds: string[] }
    | { type: "clip.batch"; command: TimelineClipCommand }
    /** Adds a stack row to a clip or (sceneId) a scene. */
    /** `targets` (phase 10c): adds the row to every listed clip and scene in one undo step (clipId/sceneId are then ignored). */
    | { type: "clip.effect.add"; clipId?: string; sceneId?: string; targets?: ItemTarget[]; effectId: string; params?: Record<string, unknown> | null; index?: number }
    | { type: "clip.effect.update"; effectRowId: string; patch: ClipEffectPatch }
    | { type: "clip.effect.remove"; effectRowId: string }
    /** `effectRowIds`: the owner's whole stack in the new order. */
    | { type: "clip.effect.reorder"; clipId?: string; sceneId?: string; effectRowIds: string[] }
    | { type: "track.update"; tracks: TimelineTrack[]; removed?: RemovedTrackRef[] }
    /** Sets (or with "none" removes) the transition at the cut after a scene or a video clip. */
    | { type: "transition.set"; sceneId?: string; clipId?: string; transition: string; duration?: number }
    /** Sets one transition on every editable scene cut, one undo step. */
    | { type: "transition.applyAll"; transition: string; duration?: number }
    /** Filter, intensity (0..1), and Adjust controls of a clip or scene. adjustments null resets all; a null control resets it. */
    /** `targets` (phase 10c): every listed clip and scene in one undo step; adjustments apply to each item's own values. */
    | { type: "look.set"; sceneId?: string; clipId?: string; targets?: ItemTarget[]; filter?: string; intensity?: number; adjustments?: AdjustmentPatch | null }
    /** Sets (animationId null: removes) the in / out / combo / loop animation of a clip or scene. A combo replaces in and out. */
    | { type: "animation.set"; clipId?: string; sceneId?: string; targets?: ItemTarget[]; slot: AnimationSlot; animationId: string | null; duration?: number }
    /** Adds or updates the keyframe at item-local `time` with channel values (item units); optional easing of the segment it starts. */
    | { type: "keyframe.set"; clipId?: string; sceneId?: string; time: number; values: Record<string, number>; easing?: EasingId; bezier?: [number, number, number, number] }
    /** Removes channels (default: all) from the keyframe at item-local `time`. */
    | { type: "keyframe.remove"; clipId?: string; sceneId?: string; time: number; channels?: string[] }
    | { type: "keyframe.easing"; clipId?: string; sceneId?: string; time: number; easing: EasingId; bezier?: [number, number, number, number] }
    /**
     * Moves the keyframe at item-local `from` (within 1 ms) to `to` (clamped to the item). `channels`: move only those
     * (the point splits). Landing on another keyframe merges into it, the moved values and easing winning. `values`:
     * channel values written at the destination in the same step (a graph drag that changes time and value).
     */
    | { type: "keyframe.retime"; clipId?: string; sceneId?: string; from: number; to: number; channels?: string[]; values?: Record<string, number> }
    /**
     * Mask of a scene or a video, image, text, or sticker clip (phase 10c/10d, looks/masks.ts): a patch merges into the
     * current mask (a new mask starts from the shape's defaults); null removes it with its mask_* keyframes. A patched
     * field whose channel is keyed is written as a keyframe at item-local `time` (default: the playhead). `replace` starts
     * from the shape's defaults and drops the mask keyframes (Reset). One undo step; locked tracks are refused.
     * `targets` (phase 10d group mode): the same patch on every listed item that takes a mask (others and locked items
     * are skipped), each keyed at its own playhead time (`time` is ignored), in one undo step.
     */
    | { type: "mask.set"; clipId?: string; sceneId?: string; targets?: ItemTarget[]; mask: MaskPatch | null; time?: number; replace?: boolean }
    /**
     * Speed of a clip or scene: constant speed (0.1..100), a curve (null removes it), keep pitch. The item's length follows
     * its source span; later scenes on the track ripple, overlapping clips on the track are pushed. `clipIds` sets several
     * clips in one undo step. Inside a coalesced gesture (same coalesceKey) every step is planned from the state before
     * the gesture, so the saved write always equals what the timeline shows.
     */
    | { type: "speed.set"; clipId?: string; clipIds?: string[]; sceneId?: string; speed?: number; curve?: { id: string; points: Array<[number, number]> } | null; preservePitch?: boolean }
    /**
     * Copy attributes → paste attributes (phase 10c): the chosen kinds (default: every kind the source has) of a
     * live clip or scene, or of a stored snapshot (store attributeClipboard), onto clips and scenes. Speed follows
     * speed.set (length, keyframes, ripple, push), effect stacks are replaced by copies with fresh row ids. Kinds a
     * target cannot take and locked targets are skipped; `output` reports `{ applied, skipped }`. One undo step.
     */
    | { type: "attributes.paste"; source: AttributeTarget | AttributeSnapshot; targets: AttributeTarget[]; attributes?: AttributeKind[] }
    /** Merges a text style patch into text clips (a null value removes the key). */
    | { type: "text.style.set"; clipIds: string[]; patch: Record<string, unknown> }
    | { type: "text.template.apply"; clipIds: string[]; templateId: string }
    /** A caption style on caption clips: the given ids, else every caption clip on `trackIndex`, else every caption clip. */
    | { type: "caption.style.apply"; clipIds?: string[]; trackIndex?: number; styleId: string }
    /** An effect-track clip with one effect (a new effect track when none is free): one undo step. */
    /** `tracks`: the full track list to write first when the caller already resolved a new effect row (timeline drops). */
    | { type: "effect.layer.add"; effectId: string; startTime: number; endTime: number; trackIndex?: number; label?: string; params?: Record<string, unknown> | null; tracks?: TimelineTrack[] }
    // ── multi-item commands (phase 10c): one undo entry for every item ──
    /** Deletes clips and scenes (items on locked or hidden tracks are skipped; scenes do not ripple, as a single scene delete). */
    | { type: "items.delete"; clipIds?: string[]; sceneIds?: string[] }
    /**
     * Copies clips and scenes keeping their relative timing. The copies' group starts at `at` (timeline seconds), default
     * right after the selection; scene copies never overlap other scenes on their track (the group moves later).
     */
    | { type: "items.duplicate"; clipIds?: string[]; sceneIds?: string[]; at?: number }
    /** Pastes a clipboard of clips and scenes (scenes are copied while they still exist) with its group starting at `at`. */
    | { type: "items.paste"; clipboard: TimelineClipboard; at: number }
    /**
     * Group transform: static fields and/or a keyframe at item-local `keyframe.time` per item (clips: positionX/Y 0..1, scale,
     * rotationDegrees; scenes: transformOffsetX/Y percent, transformScale, rotationDegrees; keyframe channels position_x,
     * position_y, scale, rotation_degrees in the item's units). `keyframesJson` (phase 10d) replaces an item's whole
     * keyframes: a group gesture on an item off the playhead moves its base values and every keyframe of the touched
     * channels (items-plan.ts transformDeltaPatch), written as absolute values.
     */
    | { type: "items.transform"; clips?: Array<ItemTransform<ClipTransformPatch>>; scenes?: Array<ItemTransform<SceneTransformPatch>> }
    // ── motion tracking (phase 10d, tracking/plan.ts) ──
    /**
     * Tracks `region` (source frame fractions, top-left + size) drawn on the frame at item-local `time` of a video clip or
     * main-track scene through the item (or `range`, item-local seconds), forward and backward, on the host's tracker.
     * Changes nothing: `output` is TrackingRunOutput (samples with item-local times, source fractions, confidence, lost).
     * Hosts without video decoding report `unavailable`. ExecuteOptions.signal cancels, onProgress reports progress.
     */
    | { type: "tracking.run"; clipId?: string; sceneId?: string; region: TrackRegion; time: number; range?: { start: number; end: number }; fps?: number }
    /**
     * Makes followers move with tracked samples (a tracking.run output) of the clip or scene: position keyframes of text,
     * sticker, graphics, and upper-track video clips and main-track scenes, or mask_x/mask_y keyframes of the tracked
     * item's own mask (`{ mask: true }`). Each follower keeps its offset from where it is when the track first covers it.
     * Locked followers, effect layers (no position parameter), audio, and followers outside the span are skipped;
     * `output` reports `{ applied, skipped }`. One undo step.
     */
    | { type: "tracking.apply"; clipId?: string; sceneId?: string; samples: TrackSample[]; source?: SourceSize | null; followers: TrackingFollower[] }
    // ── AI in the editor: local analysis, ripple cuts, beats (phase 11, analysis/*) ──
    /**
     * Finds silences or beats in the used range of an audio/video clip or a scene on the host's analyzer (a worker in the
     * browser). Changes nothing: `output` is `{ kind: "silences", ranges }` or `{ kind: "beats", bpm, times }` with times in
     * timeline seconds, plus `sourceRanges` / `sourceTimes` in source seconds. Hosts without audio decoding report
     * `unavailable`. ExecuteOptions.signal cancels, onProgress reports progress.
     */
    | { type: "analysis.run"; kind: "silences" | "beats"; clipId?: string; sceneId?: string; options?: SilenceOptions | BeatOptions }
    /**
     * Finds filler words ("um", "uh", "เอ่อ", "えーと", ...) in word timings: `words` (timeline seconds) or, when absent, the
     * caption words over the item's window. Pure; changes nothing; `output` is `{ ranges, words }` in timeline seconds.
     */
    | { type: "analysis.fillers"; clipId?: string; sceneId?: string; language?: string; words?: CaptionCueWord[]; padding?: number }
    /**
     * Ripple-deletes timeline ranges from a clip or scene and its linked items (captions inside the ranges, audio that owns
     * or detaches from the same media): each gap closes on the item's track and later items on other unlocked tracks move
     * left by the removed time; unlinked items spanning a range stay. One undo step.
     */
    | { type: "cuts.apply"; clipId?: string; sceneId?: string; ranges: Array<{ start: number; end: number }> }
    /** Sets (null clears) the beat times of an audio clip, in source seconds (stored as beatsJson). One undo step. */
    | { type: "beats.set"; clipId: string; beats: number[] | null }
    /**
     * Re-times clips/scenes so each cut lands on a beat of `beatClipId` (default: the first audio clip with beats under
     * them), every `every` beats (default 1), laid end to end from the first item's start, later items rippled. One undo step.
     */
    | { type: "beats.autoCut"; clipIds?: string[]; sceneIds?: string[]; beatClipId?: string; every?: number }
    | { type: "scene.move"; moves: SceneMove[]; clipUpdates?: TimelineClipUpdate[] }
    | {
        type: "scene.trim";
        sceneId: string;
        /** content: trim fixed media (cardConfig); duration: re-time generative shots;
         *  none: only the position/ripple changed (nle-timeline.tsx:1465-1510 branches). */
        mode: "content" | "duration" | "none";
        duration: number;
        cardConfig?: string | null;
        /** Set when the left edge moved. */
        timelinePositionSeconds?: number;
        ripple?: { moves: SceneMove[]; clipUpdates: TimelineClipUpdate[] };
    }
    | { type: "scene.split"; sceneId: string; atSeconds: number; optimistic?: OptimisticSceneSplit }
    | { type: "scene.add"; input: AddSceneInput; optimistic?: SceneData }
    | { type: "scene.delete"; sceneId: string; ripple?: { moves: SceneMove[] } }
    | { type: "scene.duplicate"; sceneId: string }
    | { type: "scene.update"; sceneId: string; patch: Partial<Omit<SceneData, "id">> }
    | { type: "scene.reorder"; sceneIds: string[] }
    | { type: "shot.reorder"; sceneId: string; order: number[] }
    | { type: "shot.merge"; input: MergeShotInput }
    | { type: "shot.delete"; sceneId: string; shotIndex: number }
    | { type: "shot.extract"; input: ExtractShotInput }
    | { type: "project.update"; patch: Partial<Omit<ProjectMeta, "id">> }
    | { type: "marker.add"; time: number; label?: string }
    | { type: "marker.move"; markerId: string; time: number }
    | { type: "marker.remove"; markerId?: string; near?: number; thresholdSeconds?: number }
    | { type: "playhead.seek"; seconds: number }
    | {
        type: "selection.set";
        clipIds?: string[];
        /** Phase 10c: selects these scenes together with `clipIds` (omitted: none); replaces the whole selection. */
        sceneIds?: string[];
        sceneId?: string | null;
        transition?: SelectedTransition | null;
        audioTarget?: AudioTarget | null;
        markerId?: string | null;
    }
    /** snapToBeats (phase 11): beat times of audio clips join the snap points. */
    | { type: "view.update"; zoom?: number; tool?: TimelineToolMode; snap?: boolean; snapToBeats?: boolean }
    | { type: "playback.set"; playing?: boolean; shuttleSpeed?: number }
    | { type: "clipboard.set"; clipboard: TimelineClipboard | null }
    | { type: "history.undo"; steps?: number }
    | { type: "history.redo"; steps?: number }
    | { type: "export.start"; options: Record<string, unknown> }
    /** Stops a running export (phase 10d); `jobId` (from export.start) must match the running one when given. */
    | { type: "export.cancel"; jobId?: string }
    | { type: "ai.run"; capability: string; input: unknown; placeAt?: Record<string, unknown> };

export type EditorCommandType = EditorCommand["type"];

export interface CommandResult {
    ok: boolean;
    changed: { clips?: string[]; scenes?: string[]; tracks?: boolean };
    createdClipIds?: string[];
    createdSceneIds?: string[];
    jobId?: string;
    error?: string;
    /** A newer command with the same coalesceKey replaced this one. */
    superseded?: boolean;
    /** Cancelled before sending (hidden tab, dispose). */
    cancelled?: boolean;
    /** The backend or runtime lacks this capability (UI shows guidance, no toast). */
    unavailable?: boolean;
    /**
     * ai.run: the provider job's result (a Transcript for audio.transcribe); attributes.paste and tracking.apply:
     * `{ applied, skipped }`; tracking.run: TrackingRunOutput.
     */
    output?: unknown;
}

export interface ExecuteOptions {
    coalesceKey?: string;
    debounceMs?: number;
    recordHistory?: boolean;
    toastOnError?: boolean;
    /** ai.run, tracking.run: aborting cancels the job. */
    signal?: AbortSignal;
    /** ai.run: the provider job's progress; tracking.run: `{ jobId: "tracking", status: "running", progress }`. */
    onProgress?(progress: AiRunProgress): void;
}

export interface StartedCommand {
    optimistic: { clipIds: string[]; sceneIds: string[] };
    settled: Promise<CommandResult>;
}

export type TimelineToastKind = "success" | "error" | "warning" | "info" | "loading";

export interface TimelineToast {
    id?: string;
    kind: TimelineToastKind;
    message: string;
    icon?: string;
    /** One button on the toast (phase 11: "Retry" on a failed AI run); clicking it also dismisses the toast. */
    action?: { label: string; run(): void };
}

const LOCAL_TYPES = new Set<EditorCommandType>([
    "marker.add", "marker.move", "marker.remove", "playhead.seek", "selection.set",
    "view.update", "playback.set", "clipboard.set",
]);

export function isLocalCommand(command: EditorCommand): boolean {
    return LOCAL_TYPES.has(command.type);
}

/** For call sites whose inputs are typed Record<string, unknown> (nle-timeline-utils.ts:63-65). */
export function asCreateClipInput(input: Record<string, unknown>): CreateClipInput {
    const startTime = Number(input.startTime);
    const endTime = Number(input.endTime);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        throw new Error("clip.create input needs numeric startTime and endTime");
    }
    return { ...input, startTime, endTime };
}
