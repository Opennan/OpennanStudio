// Public API of @opennan/timeline-core.
export const TIMELINE_CORE_VERSION = "0.14.0";

export type * from "./model";
export type { SceneData, StoryboardSheet, TimelineMarker, TrackLayoutEntry, CanvasState, HitResult, DragState, SnapPoint, ClipCommit } from "./timeline/canvas/types";

export { getSceneStart, getSceneDuration, parseSceneCardConfig } from "./timeline/scene-timing";

export * as engine from "./timeline/engine/move";
export * as engineLayout from "./timeline/engine/layout";
export * as engineRipple from "./timeline/engine/ripple";
export * as enginePersist from "./timeline/engine/persist";
export * as engineViewport from "./timeline/engine/viewport";

export * as canvas from "./timeline/canvas/timeline-renderer";
export * as hitDetector from "./timeline/canvas/hit-detector";
export * as snap from "./timeline/canvas/snap-engine";
export * as drag from "./timeline/canvas/drag-controller";
export * as multiSelect from "./timeline/canvas/multi-select";
export * as transitionMarkers from "./timeline/canvas/transition-markers";
export * as colors from "./timeline/canvas/colors";
export * as layout from "./timeline/nle-timeline-layout";

export * as editing from "./lib/timeline-editing";
export * as textStyle from "./lib/timeline-text-style";
export * as animationPresets from "./lib/timeline-animation-presets";
export * as tracks from "./lib/timeline-tracks";
export * as commits from "./lib/timeline-commits";
export * as history from "./lib/timeline-history";
export * as localHistory from "./lib/local-timeline-history";
export * as syncQueue from "./lib/timeline-sync-queue";
export * as shots from "./lib/shot-utils";
export * as keyframes from "./lib/keyframe-interpolation";
export * as textLayout from "./lib/preview-text-layout";
export * as exportArgs from "./lib/local-export";
export type { LocalSyncOp, LocalSyncQueueRow } from "./lib/sync-queue-types";

// ── phase 2 runtime ──────────────────────────────────────
export { createEditorStore } from "./store/editor-store";
export type {
    EditorState, EditorStore, SelectedTransition, TimelineToolMode, AddTextClipRequest,
    FrameStepRequest, OptimisticSceneSplit, SceneOverridesCapture, SelectedKeyframe, KeyframeGraphState, TrackingOwner, TrackingRegionState, TrackingResultState, AiCutPreview, AiActivity,
} from "./store/editor-store";
export {
    selectLiveScenes, selectTimelineClips, selectTimelineTracks, selectIsBackendSyncing, computeLiveScenes,
    getEditorSceneDuration, getEditorSceneStart,
} from "./store/live-scenes";

export {
    ATTRIBUTE_KINDS, ATTRIBUTE_KIND_DEFS, acceptedAttributeKinds, isAttributeSnapshot, planAttributePaste, replaceKeyframeChannels, snapshotAttributes,
} from "./attributes/attributes";
export type {
    AttributeEffectRow, AttributeItem, AttributeKind, AttributePastePlan, AttributePasteReport, AttributePasteState, AttributeSkipReason,
    AttributeSnapshot, AttributeTarget,
} from "./attributes/attributes";
export { TimelineController } from "./controller/timeline-controller";
export type { TimelineControllerOptions, ControllerSnapshot, ExportCommandOutcome, HistoryDepth, ExternalSnapshot } from "./controller/timeline-controller";
export type {
    AiRunRequest, AiRunContext, AiRunOutcome, AiRunProgress, AiPlacement, AiPlacementKind, AiTargetRef, AiMediaRef, AiSourceRange, CaptionCue, CaptionCueWord,
} from "./controller/ai-run";
export type { MediaAnalyzerHost, AnalysisJob, AnalysisJobContext, AnalysisJobOutcome, AnalysisKind, SilenceOptions, BeatOptions, TimeRange } from "./analysis/host";
export { detectSilences, SILENCE_DEFAULTS } from "./analysis/silence";
export { detectBeats, BEAT_DEFAULTS, MAX_BEATS, type BeatResult } from "./analysis/beats";
export { findFillers, fillerLanguage, guessWordsLanguage, FILLER_WORDS, FILLER_DEFAULT_PADDING, type FillerResult, type FillerWord } from "./analysis/fillers";
export {
    planCuts, mergeTimeRanges, clampTimeRanges, keptRanges, removedBefore, rippleTime, sourceRangesToTimeline, timelineRangesToSource, MAX_CUT_RANGES,
    type CutsPlan, type CutsState,
} from "./analysis/cuts";
export {
    beatTimesOnTimeline, clipBeatTimes, parseBeatsJson, planBeatsJson, planAutoCut, MIN_AUTO_CUT_SECONDS, type AutoCutPlan, type AutoCutRequest, type AutoCutState,
} from "./analysis/beat-plan";
export { AI_TOOL_IDS, PAID_AI_TOOLS, AI_TOOL_LIMITS, AI_TOOL_NAMES, CAPTION_SEGMENT_OVERHEAD, UPSCALE_RESOLUTIONS, MATTING_BACKGROUNDS, planAiTool } from "./ai/tools";
export {
    aiMediaSource, aiMediaSourceError, aiMediaSourceResult, clipMediaStart, isShotSequencedScene, mediaFileName, sceneMediaUrl, sourceToTimeline, timelineToSource,
} from "./ai/sources";
export type { AiMediaSource, AiMediaSourceResult, AiMediaKind, AiSnapshot } from "./ai/sources";
export type { AiToolId, AiToolParams, AiToolPlan, AiToolPlanResult, AiToolUnits, AiToolLimit, UpscaleResolution, MattingBackground } from "./ai/tools";
export { planCaptionPlacement, CAPTIONS_TRACK_LABEL, type CaptionPlacementPlan } from "./lib/caption-placement";
export { planAiPlacement, type AiPlacementPlan, type AiPlacementState } from "./lib/ai-placement";
export {
    REEL_LAYOUT, LAYOUT_PRESETS, applyReelLayout, planReelLayout, reelScenePatch, reelTitleStyle, titlePositionY, filmOffsetPercent,
    type LayoutPreset, type ReelClip, type ReelExecutor, type ReelLayoutInput, type ReelLayoutOutcome, type ReelLayoutPlan, type ReelLayoutState, type ReelPlanResult,
} from "./layout/reel";
export { asCreateClipInput, isLocalCommand } from "./controller/commands";
export type { EditorCommand, EditorCommandType, CommandResult, ExecuteOptions, StartedCommand, TimelineToast, TimelineToastKind, TrackRef } from "./controller/commands";
export { DEFAULT_COMMAND_ERROR_MESSAGES, DEFAULT_FALLBACK_ERROR_MESSAGE } from "./controller/messages";
export type { MotionTrackerHost, TrackingJob, TrackingJobContext, TrackingJobOutcome, TrackingRunOutput } from "./tracking/host";
export type {
    SourceSize, TrackingApplied, TrackingFollower, TrackingFrame, TrackingReport, TrackingSkipReason, TrackingSkipped,
} from "./tracking/plan";
export type { LumaFrame, TrackRegion, TrackSample, TrackerOptions } from "./tracking/tracker";
export { timelineDurationSeconds } from "./controller/frame-renderer";
export type { FrameRenderer, FrameRequest, RenderedFrame, PreviewFrameOptions, PreviewFrameResult } from "./controller/frame-renderer";

export type * from "./backend/types";
export { TimelineTimeoutError, CommandUnavailableError, withTimeout, GLOBAL_SCHEDULER, type Scheduler } from "./backend/errors";
export { LocalBackend, LOCAL_MEDIA_URL_PREFIX, DEFAULT_PROJECT_NAME, createEmptyProject, type LocalBackendOptions } from "./backend/local-backend";
export { createMemoryPersistence, createIndexedDbPersistence, type LocalPersistence, type LocalProjectState, type IndexedDbPersistenceOptions } from "./backend/persistence";

export { buildOptimisticClipEffect } from "./model/effects";
export {
    DEFAULT_TIMELINE_THEME, resolveTimelineTheme, applyTimelineTheme, readThemeFromCss,
    type TimelineTheme, type TimelineThemeOverrides,
} from "./timeline/canvas/colors";
export { scenesToEngineItems } from "./timeline/engine/scene-items";
export { planSourceClipSceneSplit, type SceneSplitPlan } from "./timeline/scene-split-plan";
export * as sceneHelpers from "./timeline/scene-helpers";
export * as optimistic from "./lib/timeline-optimistic";
export * as subtitles from "./lib/subtitle-import";
