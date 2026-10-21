"use client";

// Interactive canvas timeline with clip, scene, track, and drag-drop editing.
import { useRef, useEffect, useCallback, useMemo, useState } from "react";
import { useEditorStore, useEditorStoreApi, useShallow } from "../../hooks/use-editor-store";
import { useTimelineCallbacks } from "../../hooks/use-timeline-callbacks";
import type { ChatReference } from "../../types/host-requests";
import type { AudioTarget } from "@opennan/timeline-core";
import type { TimelineTrack, TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { CanvasState, DragState, TrackLayoutEntry, SceneData, ClipCommit, HitResult, TimelineMarker } from "@opennan/timeline-core/timeline/canvas/types";
import { beatTimesOnTimeline } from "@opennan/timeline-core/analysis/beat-plan";
import { snapBeatTimes } from "@opennan/timeline-core/timeline/canvas/snap-engine";
import { getKeyframeItemGeometry, KEYFRAME_MARKER_INSET, renderTimeline, RULER_HEIGHT, getSceneDuration, getSceneStart, getSceneResizeBounds, getSceneTrimStart, getPreviousSameTrackEnd, planClipFilmstrip, planSceneFilmstrip } from "@opennan/timeline-core/timeline/canvas/timeline-renderer";
import { hitDetect, getCursorForHit, getEffectLayerDropPreview, getRemotionLayerDropPreview, getMediaLayerDropPreview, getTransitionDropTarget, shotIndexForScene, shotInsertIndexForScene, type EffectLayerDropPreview } from "@opennan/timeline-core/timeline/canvas/hit-detector";
import { getSceneTransitionMarkers, getTransitionMarkers, getTransitionJunctions, getSceneTransitionJunctions, hasTransitionMarker, DEFAULT_TRANSITION_DURATION } from "@opennan/timeline-core/timeline/canvas/transition-markers";
import { isLaneClip } from "@opennan/timeline-core/looks/windows";
import { parseCachedShotBreakdown } from "@opennan/timeline-core/lib/shot-utils";
import { hasReadOnlyShots } from "../../editing/read-only-shots";
import { loadAudioDuration } from "@opennan/timeline-media/audio-duration";
import { useTimelineConfig, useTimelineMedia } from "../../hooks/use-timeline-media";
import { useDocumentVisible } from "../../hooks/use-document-visible";
import { getTimelineTrackHeight, getTimelineTrackSortWeight } from "@opennan/timeline-core/timeline/nle-timeline-layout";
import { createIdleDrag, startDrag, updateDrag, endDrag, getMoveDragDelta } from "@opennan/timeline-core/timeline/canvas/drag-controller";
import { computeContextActionClipIds, computeMarqueeHitClipIds, computeMarqueeHitSceneIds, computeMarqueeSelection, computeSelection, type MarqueeSelectionMode } from "@opennan/timeline-core/timeline/canvas/multi-select";
import { createThumbnailCache } from "@opennan/timeline-media/thumbnail-generator";
import { createWaveformCache } from "@opennan/timeline-media/waveform-generator";
import { resolveMove } from "@opennan/timeline-core/timeline/engine/move";
import { scenesToEngineItems } from "@opennan/timeline-core/timeline/engine/scene-items";
import { contentEnd } from "@opennan/timeline-core/timeline/engine/layout";
import { contentWidthPx, edgeScrollVelocity, clampScroll } from "@opennan/timeline-core/timeline/engine/viewport";
import {
    Trash2,
    ChevronsLeft,
    Flag,
    Plus,
    Copy,
    CopyPlus,
    ClipboardCopy,
    ClipboardPaste,
    ClipboardX,
    Play,
    Replace,
    ArrowUpFromLine,
    FileAudio,
    FolderOpen,
    MoveRight,
    EyeOff,
    PanelLeftClose,
    PanelRightClose,
    RotateCcw,
    RotateCw,
    Scissors,
    Snowflake,
    SkipBack,
    SkipForward,
    SlidersHorizontal,
    StepBack,
    StepForward,
    Type,
    Volume2,
    VolumeX,
    Wand2,
    Film,
    Music,
    Image as ImageIcon,
    Paintbrush,
    PaintBucket,
} from "lucide-react";
import { useTimelineUpload } from "../../hooks/use-timeline-upload";
import { useTimelineToast } from "../../hooks/use-timeline-toast";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { useTimelineMessages } from "../../hooks/use-timeline-messages";
import { attributeShortcutLabel, useAttributeActions } from "../../editing/attributes/use-attribute-actions";
import { acceptedAttributeKinds } from "@opennan/timeline-core/attributes/attributes";
import type { MessageKey } from "../../i18n/format";
import { useTimelineKeyframes } from "./keyframe-interaction";
import { KeyframeKeyboardLayer } from "./keyframe-keyboard-layer";
import { deleteSelectedItems, isMixedSelection } from "../../editing/multi-selection";
import { AiMenuRows } from "../../ai/ai-menu-rows";
import { aiItemKind } from "../../ai/ai-tab";
import {
    commitTimelineClipCreates,
    type TimelineClipCreateInput,
} from "@opennan/timeline-core/lib/timeline-commits";
import {
  CTX_MENU_SHELL_CLASS,
  CtxItem,
  CtxSeparator,
  RichCtxItem,
  getContextMenuEstimatedHeight,
  getContextMenuStyle,
} from "./canvas-context-menu";
import {
  PLAYBACK_SCROLL_AHEAD_RATIO,
  PLAYBACK_SCROLL_EDGE_MARGIN_PX,
  TIMELINE_LABEL_COL_WIDTH,
  TIMELINE_MEDIA_OVERSCAN_PX,
  areTimelineDropGhostsEqual,
  collectCopyVideoPanelCropUrls,
  constrainBackwardDelta,
  getEditableCanvasSceneTransitionTarget,
  getSceneResizePreview,
  getSceneVoiceoverUrl,
  getTextTimelineClipKind,
  getTextTimelineClipLabelKey,
  getTimelineLibraryDragKind,
  getTimelineMediaDragDuration,
  isAudioTimelineClip,
  isEditableCanvasSceneTrack,
  isEditableTrackLayout,
  isTextTimelineClip,
  isTimelineTextEditingTarget,
  isVisualTimelineClip,
  type TimelineDropGhost,
} from "@opennan/timeline-core/timeline/canvas/canvas-timeline-utils";
import {
    canPasteTimelineClipboard,
    copyTimelineClips,
    cutTimelineClips,
    duplicateTimelineClips,
    getEditableTimelinePasteInputs,
    getEditableTimelineClipIds,
    getTimelineDeleteBatchPlan,
    getTimelineDetachAudioPlan,
    getSeparateVoiceoverAudioInput,
    getTimelineInsertPastePlan,
    getTimelineOverwritePastePlan,
    getTimelineResetClipVolumeTargetCommits,
    getTimelineResetVisualTransformTargetCommits,
    getTimelineSelectionAfterDelete,
    getTimelineSetFadeEdgeTargetCommits,
    getTimelineSetFadeTargetCommits,
    getTimelineSpeedPresetTargetIds,
    speedRampRequest,
    getTimelineSetVisualOpacityTargetCommits,
    getTimelineSetTextStylePresetTargetCommits,
    getTimelineBladeSplitClipId,
    getTimelineToggleClipMuteTargetCommits,
    getTimelineToggleClipVisibilityTargetCommits,
    getTimelineToggleFreezeFrameTargetCommits,
    getTimelineToggleHorizontalFlipTargetCommits,
    getTimelineToggleReversePlaybackTargetCommits,
    getTimelineRotateVisualTargetCommits,
    pasteTimelineClips,
    shouldCanvasHandleTimelineDelete,
    type TimelineDuplicateClip,
    type TimelineInsertPastePlan,
    type TimelineOverwritePastePlan,
} from "@opennan/timeline-core/lib/timeline-editing";

interface CanvasTimelineProps {
  scenes: SceneData[];
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  markers?: TimelineMarker[];
  selectedSceneId: string | null;
  zoom: number;
  totalDuration: number;
  musicUrl: string | null;
  musicVolume: number;
  selectedAudioTarget: AudioTarget | null;
  onSelectClip: (id: string) => void;
  onSelectScene: (id: string) => void;
  onUpdateClips: (commits: ClipCommit[]) => void;
  /** Set/clear a scene's visual transition (crossfade/dissolve/fade); "none" clears it. */
  onSetSceneTransition?: (sceneId: string, transitionType: string, durationSeconds: number) => void;
  /** Mirrors a missing effects-row preview into the parent sticky track rail. */
  onEffectDropPreviewChange?: (preview: EffectLayerDropPreview | null) => void;
  onSeek: (time: number) => void;
  onSelectMusic: () => void;
  onSelectVoiceover: (sceneId: string) => void;
  onReorderScenes: (activeId: string, overId: string) => void;
  /** Called when the user drops a scene strip — may change both start time and video track. */
  onMoveSceneTime?: (sceneId: string, newStartSeconds: number, newTrackIndex?: number) => void;
  /** Batch scene move that persists the exact canvas-previewed positions. */
  /** `clipUpdates` (phase 10c): clips moved by the same gesture, written in the same command (one undo step). */
  onMoveSceneTimes?: (updates: { sceneId: string; startTime: number; trackIndex?: number }[], clipUpdates?: ClipCommit[]) => void;
  /** Reorder shots within a scene after the user drags one to a new index. */
  onReorderShots?: (sceneId: string, newShotOrder: number[]) => void;
  /** Extract a shot into a new scene at the given timeline position + track. */
  onExtractShot?: (sceneId: string, shotIndex: number, newStartSeconds: number, newTrackIndex: number) => void;
  /** Merge a shot from source scene into target scene's shot list at `targetShotIndex`
   * (append if undefined). Source scene is deleted if it ends up empty. */
  onMergeShot?: (
    sourceSceneId: string,
    shotIndex: number,
    targetSceneId: string,
    targetShotIndex?: number,
  ) => void;
  /** Delete a shot from a scene. Scene is removed if it has no shots left. */
  onDeleteShot?: (sceneId: string, shotIndex: number) => void;
  /** Change a scene's total duration by dragging its left/right edge. */
  onUpdateSceneDuration?: (sceneId: string, newStartSeconds: number, newDuration: number) => void;
  onDeleteClips: (clipIds: string[]) => void;
  onTrackDrop?: (trackType: string, trackIndex: number, time: number, data: any) => void;
  onDeleteScene?: (sceneId: string) => void;
  /** Delete a scene and shift every later same-track item left to close the gap. */
  onRippleDeleteScene?: (sceneId: string) => void;
  onAddScene?: (
    afterOrder: number,
    opts?: { cardType?: string; sourceVideoUrl?: string; startImageUrl?: string; videoUrl?: string; trackIndex?: number; timelinePositionSeconds?: number },
  ) => void;
  onDuplicateScene?: (sceneId: string) => void;
  onRemoveVoiceover?: (sceneId: string) => void;
  onSplitClip?: (clipId: string, time: number) => void;
  onSplitClips?: (clipIds: string[], time: number) => void;
  onSplitClipsAtTime?: (time: number) => void;
  onConvertSceneToSourceVideo?: (sceneId: string) => void;
  onCreateClip?: (input: TimelineClipCreateInput) => Promise<TimelineClip | null>; // i18n-ignore
  onCreateClips?: (inputs: TimelineClipCreateInput[]) => Promise<(TimelineClip | null)[]>; // i18n-ignore
  onSaveToSources?: (url: string, name: string, size: number, mimeType: string) => Promise<void>; // i18n-ignore
  /** Per-scene deepfake — adds a "Deepfake video" entry to the right-click
   * menu when the user clicks a video clip that already has a stitched mp4. */
  onDeepfakeScene?: (sceneId: string) => Promise<void> | void;
  onDoubleClickScene?: (sceneId: string, shotIndex: number) => void;
  /** False disables this instance's scene copy/paste/delete keyboard handler. */
  shortcutsEnabled?: boolean;
}

export function CanvasTimeline({
  scenes,
  tracks: rawTracks,
  clips,
  markers = [],
  selectedSceneId,
  zoom,
  totalDuration,
  musicUrl,
  musicVolume,
  selectedAudioTarget,
  onSelectScene,
  onUpdateClips,
  onSetSceneTransition,
  onEffectDropPreviewChange,
  onSeek,
  onSelectMusic,
  onSelectVoiceover,
  onMoveSceneTime,
  onMoveSceneTimes,
  onReorderShots,
  onExtractShot,
  onMergeShot,
  onDeleteShot,
  onUpdateSceneDuration,
  onDeleteClips,
  onTrackDrop,
  onDeleteScene,
  onRippleDeleteScene,
  onAddScene,
  onDuplicateScene,
  onRemoveVoiceover,
  onSplitClip,
  onSplitClipsAtTime,
  onConvertSceneToSourceVideo,
  onCreateClip,
  onCreateClips,
  onSaveToSources,
  onDeepfakeScene,
  onDoubleClickScene,
  shortcutsEnabled = true,
}: CanvasTimelineProps) {
  const t = useTimelineMessages("canvasTimeline");
  const storeApi = useEditorStoreApi();
  const callbacks = useTimelineCallbacks();
  const toast = useTimelineToast();
  const media = useTimelineMedia();
  const timelineController = useTimelineController();
  const attributeActions = useAttributeActions();
  const hasAttributeClipboard = useEditorStore((s) => s.attributeClipboard !== null);
  const { theme, debugHooks } = useTimelineConfig();
  const docVisible = useDocumentVisible();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadOverlayRef = useRef<HTMLDivElement | null>(null);
  const updatePlayheadOverlayRef = useRef<(time: number) => void>(() => {});
  const containerRef = useRef<HTMLDivElement>(null);
  const [timelineVisible, setTimelineVisible] = useState(false);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const pendingAudioDropRef = useRef<{ trackType: string; trackIndex: number; time: number } | null>(null);
  const audioDurationAbortRef = useRef<AbortController | null>(null);
  const stickerFileInputRef = useRef<HTMLInputElement>(null);
  // Scene-creation file inputs (imported video + imported image).
  const sceneVideoFileInputRef = useRef<HTMLInputElement>(null);
  const sceneImageFileInputRef = useRef<HTMLInputElement>(null);
  const pendingSceneAddRef = useRef<{ afterOrder: number; trackIndex?: number; timelinePositionSeconds?: number } | null>(null);
  const pendingStickerDropRef = useRef<{ trackIndex: number; time: number } | null>(null);
  const { upload, reset } = useTimelineUpload();
  const rafRef = useRef<number>(0);
  const needsRenderRef = useRef(true);
  const renderLoopActiveRef = useRef(false);
  const wakeRenderLoopRef = useRef<(() => void) | null>(null);
  const dragRef = useRef<DragState>(createIdleDrag());
  const hoveredClipRef = useRef<string | null>(null);
  // When the user mouses-down on an already-multi-selected clip without a modifier,
  // we keep the multi-selection so the drag controller can move all selected clips.
  // If the user releases without moving (a click, not a drag), we shrink the
  // selection to just that clip on mouseup.
  const pendingSelectReplaceRef = useRef<string | null>(null);
  // Rubber-band / marquee selection: drag empty timeline space to draw a box
  // and select every clip it intersects. Box is in canvas coords.
  const marqueeRef = useRef<{
    startX: number; startY: number; currentX: number; currentY: number;
    mode: MarqueeSelectionMode; baseSelection: Set<string>; baseSceneSelection: Set<string>;
  } | null>(null);
  const marqueeBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeOverlayRef = useRef<HTMLDivElement | null>(null);
  const marqueePreviewSelectionRef = useRef<Set<string> | null>(null);
  const marqueePreviewSceneSelectionRef = useRef<Set<string> | null>(null);
  const thumbnailCacheRef = useRef(createThumbnailCache(media));
  const waveformCacheRef = useRef(createWaveformCache(media));
  const scrollLeftRef = useRef(0);
  const sizeRef = useRef({ width: 0, height: 0 });
  // Real horizontally-scrolling ancestor. The canvas host div is nested a
  // couple of wrappers below it, so `containerRef.parentElement` is NOT the
  // scroller — reading/writing scrollLeft there silently no-ops (playhead
  // auto-follow, edge auto-scroll, space-pan, and viewport culling all died
  // that way). Resolved once per mount by walking up for overflow-x.
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const viewportLayerRef = useRef<HTMLDivElement | null>(null);
  const getScrollParent = useCallback((): HTMLElement | null => {
    if (scrollParentRef.current?.isConnected) return scrollParentRef.current;
    let node = containerRef.current?.parentElement ?? null;
    while (node) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") break;
      node = node.parentElement;
    }
    scrollParentRef.current = node;
    return node;
  }, []);
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const panDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null>(null);
  const clipDragLinkedSceneOriginalsRef = useRef<Map<string, { startTime: number; trackIndex: number }>>(new Map());
  const playheadRippleDragRef = useRef<{
    startWorldX: number;
    currentWorldX: number;
    startTime: number;
    armed: boolean;
    sceneOriginals: Map<string, { startTime: number; trackIndex: number }>;
    clipOriginals: Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>;
  } | null>(null);
  const spacePressedRef = useRef(false);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    hit: HitResult;
  } | null>(null);
  // Sub-menu inside the "Add scene" popup — tracks whether we're on the main
  // type chooser or on the URL-paste / file-picker sub-panel for a specific type.
  const [addSceneSub, setAddSceneSub] = useState<"root" | "video-url" | "image-url" | null>(null);
  // Timeline keyframe diamonds (phase 10c): select, seek, retime, delete, easing menu.
  const keyframes = useTimelineKeyframes({
    getState: () => getDragBuildState(),
    getCanvasRect: () => canvasRef.current?.getBoundingClientRect() ?? null,
    requestRender: () => {
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    },
    setCursor: (cursor) => {
      if (canvasRef.current) canvasRef.current.style.cursor = cursor;
    },
  }, { shortcutsEnabled });
  const [addSceneUrl, setAddSceneUrl] = useState("");

  // Voiceover lock state
  const [unlockedVoiceovers, setUnlockedVoiceovers] = useState<Set<string>>(new Set());
  const voiceoverOffsetsRef = useRef<Map<string, number>>(new Map());
  // Persistent shot selection. Set by a double-click on a shot inside a scene.
  // Stays visible (yellow outline) until the user clicks elsewhere or drags it.
  const [selectedShot, setSelectedShot] = useState<{ sceneId: string; shotIndex: number } | null>(null);
  // Selected scenes live in the store with the clips (phase 10c multi-select), so the preview, the inspector,
  // and the shortcuts see one selection.
  const selectedSceneIds = useEditorStore((s) => s.selectedSceneIds);
  const setSelectedSceneIds = useCallback((ids: Set<string>) => storeApi.getState().setSelectedSceneIds(ids), [storeApi]);
  // Cmd+C'd scene ids — pasted via duplicateScene on Cmd+V.
  const sceneClipboardRef = useRef<string[]>([]);
  // Pre-drop ghost shown while dragging an effect or transition card over the timeline.
  const [timelineDropGhost, setTimelineDropGhost] = useState<TimelineDropGhost | null>(null);
  const timelineDropGhostRef = useRef<TimelineDropGhost | null>(null);
  const pendingTimelineDropGhostRef = useRef<TimelineDropGhost | null>(null);
  const timelineDropGhostFrameRef = useRef<number | null>(null);
  const pendingScrubSeekRef = useRef<number | null>(null);
  const scrubSeekFrameRef = useRef<number | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const pendingTimelineWheelDeltaRef = useRef(0);
  const pendingTimelineWheelScrollParentRef = useRef<HTMLElement | null>(null);
  const timelineWheelFrameRef = useRef<number | null>(null);
  const voDragRef = useRef<{ sceneId: string; startX: number; origOffset: number } | null>(null);
  // Scene timeline drag — grab a scene strip and slide it horizontally to a new absolute
  // start time. Armed once the pointer moves past a 6 px threshold (so plain clicks still
  // just select). On release, calls onMoveSceneTime(sceneId, newStartSeconds) which the
  // parent routes to the updateSceneTimelinePosition mutation (push-right applies).
  const sceneTimeDragRef = useRef<{
    sceneId: string;
    origStart: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    linkedClipOriginals: Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>;
    linkedSceneOriginals: Map<string, { startTime: number; trackIndex: number }>;
    didSelectSceneOnMouseDown: boolean;
    armed: boolean;
  } | null>(null);
  // Latest resolveMove() result for the active scene drag — computed once per
  // mousemove in buildState and re-read (not recomputed) by the mouseup commit
  // handlers so preview and commit always agree on the same placement.
  const sceneDragChangesRef = useRef<Map<string, { start: number; trackId: string }> | null>(null);
  // Shot-level drag: entered when a scene is clicked twice in quick succession.
  // Drag inside the source scene reorders shots; drag outside extracts to a new
  // scene. `armed` flips once the pointer moves past the threshold.
  const shotDragRef = useRef<{
    sceneId: string;
    shotIndex: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    armed: boolean;
  } | null>(null);
  // Tracks the last mousedown on a scene so the next quick-second click on the
  // same scene can enter shot-drag mode (browsers fire `dblclick` AFTER both
  // mouseups, which is too late for a drag gesture).
  const lastSceneClickRef = useRef<{
    sceneId: string;
    time: number;
    x: number;
    y: number;
  } | null>(null);
  // Scene-edge resize drag: grab the left or right edge of a scene strip to
  // shrink/extend its duration. On release we call onUpdateSceneDuration.
  // Preview-only easing state for pushed/crossed neighbors during a scene drag.
  const sceneDragPreviewLerpRef = useRef<Map<string, number>>(new Map());
  // Ruler marker drag: move the flag; plain click seeks to it.
  const markerDragRef = useRef<{ markerId: string; startX: number; moved: boolean } | null>(null);
  const sceneResizeDragRef = useRef<{
    sceneId: string;
    edge: "left" | "right";
    origStart: number;
    origDuration: number;
    /** Content clamp (see getSceneResizeBounds) — rides into getSceneResizePreview. */
    maxDuration: number;
    minStart: number;
    /** Other scene/clip boundary times the dragged edge magnetizes to. */
    snapTimes: number[];
    startX: number;
    currentX: number;
    armed: boolean;
  } | null>(null);
  // Transition duration drag — grabbing the left/right end of a transition
  // shape stretches the overlap symmetrically around the cut.
  const transitionResizeDragRef = useRef<{
    id: string;
    kind: "clip" | "scene";
    edge: "left" | "right";
    transitionType: string;
    origDuration: number;
    maxDuration: number;
    startX: number;   // world px
    currentX: number; // world px
    armed: boolean;
  } | null>(null);
  // Junction drop guides while a transition card is dragged from the library.
  const transitionDropGuidesRef = useRef<import("@opennan/timeline-core/timeline/canvas/transition-markers").TransitionJunction[] | null>(null);
  // Committed resize that stays visible until the server-side update lands in
  // `scenes`. Without this the strip briefly snaps back to its old size after
  // mouseup (bad feel). Cleared by an effect once `scene.duration` matches.
  const pendingResizeRef = useRef<{
    sceneId: string;
    newStart: number;
    newDuration: number;
  } | null>(null);

  const {
    selectedClipId,
    selectedClipIds,
    setSelectedClipIds,
    selectedTransition,
    selectTransition,
    clearTransitionSelection,
    snapEnabled,
    snapToBeats,
    aiActivity,
    aiCutPreview,
    setShuttleSpeed,
    toolMode,
    timelineClipboard,
  } = useEditorStore(
    useShallow((s) => ({
      selectedClipId: s.selectedClipId,
      selectedClipIds: s.selectedClipIds,
      setSelectedClipIds: s.setSelectedClipIds,
      selectedTransition: s.selectedTransition,
      selectTransition: s.selectTransition,
      clearTransitionSelection: s.clearTransitionSelection,
      snapEnabled: s.snapEnabled,
      snapToBeats: s.snapToBeats,
      aiActivity: s.aiActivity,
      aiCutPreview: s.aiCutPreview,
      setShuttleSpeed: s.setShuttleSpeed,
      toolMode: s.toolMode,
      timelineClipboard: s.timelineClipboard,
    }))
  );
  const canCreateCanvasClip = Boolean(onCreateClip || onCreateClips);
  // Beat snap targets (phase 11), only while Snap to beats is on.
  const beatTimes = useMemo(() => (snapToBeats ? beatTimesOnTimeline(clips) : undefined), [snapToBeats, clips]);
  const openMusicPropertiesMode = useCallback((mode: "music" | "sfx", time?: number, trackIndex?: number) => {
    if (typeof time === "number" && Number.isFinite(time)) {
      onSeek(Math.max(0, time));
    }
    onSelectMusic();
    // Issue the mode/target request synchronously (no setTimeout). An already-
    // mounted panel reacts to the event (React batches both updates, no flip); a
    // panel that mounts after the tab switch reads it via the pending request.
    callbacks.onOpenMusicPanel?.({
      mode,
      ...(typeof trackIndex === "number" && Number.isFinite(trackIndex) ? { trackIndex } : {}),
      ...(typeof time === "number" && Number.isFinite(time) ? { startTime: Math.max(0, time) } : {}),
    });
  }, [callbacks, onSeek, onSelectMusic]);

  const commitCanvasCreates = useCallback((inputs: TimelineClipCreateInput[], failureMessageKey: "clipUpdateFailed" | "duplicateFailed" | "pasteFailed") => {
    if (!canCreateCanvasClip || inputs.length === 0) return;
    void commitTimelineClipCreates(inputs, { createClip: onCreateClip, createClips: onCreateClips })
      .then((created) => {
        const ids = created
          .map((clip) => clip?.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        if (ids.length > 0) setSelectedClipIds(new Set(ids));
      })
      .catch(() => toast.error(t(failureMessageKey)));
  }, [canCreateCanvasClip, onCreateClip, onCreateClips, setSelectedClipIds, t, toast]);

  const commitCanvasInsertPastePlan = useCallback((plan: TimelineInsertPastePlan) => {
    if (plan.commits.length > 0) onUpdateClips(plan.commits);
    commitCanvasCreates(plan.inputs, "clipUpdateFailed");
  }, [commitCanvasCreates, onUpdateClips]);

  const commitCanvasOverwritePastePlan = useCallback((plan: TimelineOverwritePastePlan) => {
    if (plan.commits.length > 0) onUpdateClips(plan.commits);
    if (plan.deleteIds.length > 0) {
      setSelectedClipIds(getTimelineSelectionAfterDelete(selectedClipIds, new Set(plan.deleteIds), clips, rawTracks));
      onDeleteClips(plan.deleteIds);
    }
    commitCanvasCreates(plan.inputs, "clipUpdateFailed");
  }, [clips, commitCanvasCreates, onDeleteClips, onUpdateClips, rawTracks, selectedClipIds, setSelectedClipIds]);

  // When the user is on the Chat tab, every scene/clip they click on the
  // timeline gets suggested as a reference chip in the chat composer. Lets
  // them collect references without dragging from a canvas (which has no
  // native HTML5 drag-source).
  const suggestChatReference = useCallback((ref: Record<string, unknown>) => {
    callbacks.onSuggestChatReference?.(ref as unknown as ChatReference);
  }, [callbacks]);
  const updateMarqueePreview = useCallback((
    box: { x: number; y: number; w: number; h: number } | null,
    selection: Set<string> | null,
  ) => {
    marqueeBoxRef.current = box;
    marqueePreviewSelectionRef.current = selection;
    const overlay = marqueeOverlayRef.current;
    if (!overlay) return;
    if (!box || box.w <= 1 || box.h <= 1) {
      overlay.style.display = "none";
      return;
    }
    overlay.style.display = "block";
    overlay.style.left = `${box.x}px`;
    overlay.style.top = `${box.y}px`;
    overlay.style.width = `${box.w}px`;
    overlay.style.height = `${box.h}px`;
  }, []);
  const updateVoiceoverOffset = useCallback((sceneId: string, offset: number) => {
    const next = new Map(voiceoverOffsetsRef.current);
    next.set(sceneId, offset);
    voiceoverOffsetsRef.current = next;
  }, []);
  const commitTimelineDropGhost = useCallback((ghost: TimelineDropGhost | null) => {
    if (areTimelineDropGhostsEqual(timelineDropGhostRef.current, ghost)) return;
    timelineDropGhostRef.current = ghost;
    setTimelineDropGhost(ghost);
  }, []);
  const scheduleTimelineDropGhost = useCallback((ghost: TimelineDropGhost | null) => {
    pendingTimelineDropGhostRef.current = ghost;
    if (timelineDropGhostFrameRef.current !== null) return;

    timelineDropGhostFrameRef.current = requestAnimationFrame(() => {
      timelineDropGhostFrameRef.current = null;
      const nextGhost = pendingTimelineDropGhostRef.current;
      pendingTimelineDropGhostRef.current = null;
      commitTimelineDropGhost(nextGhost);
    });
  }, [commitTimelineDropGhost]);
  const clearTimelineDropGhost = useCallback(() => {
    if (timelineDropGhostFrameRef.current !== null) {
      cancelAnimationFrame(timelineDropGhostFrameRef.current);
      timelineDropGhostFrameRef.current = null;
    }
    pendingTimelineDropGhostRef.current = null;
    commitTimelineDropGhost(null);
    if (transitionDropGuidesRef.current) {
      transitionDropGuidesRef.current = null;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    }
  }, [commitTimelineDropGhost]);
  const scheduleScrubSeek = useCallback((time: number) => {
    pendingScrubSeekRef.current = time;
    if (scrubSeekFrameRef.current !== null) return;

    scrubSeekFrameRef.current = requestAnimationFrame(() => {
      scrubSeekFrameRef.current = null;
      const nextTime = pendingScrubSeekRef.current;
      pendingScrubSeekRef.current = null;
      if (nextTime !== null) onSeek(nextTime);
    });
  }, [onSeek]);
  // The canvas palette comes from the provider theme; the long-lived render
  // loop reads it through a ref and repaints when it changes.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => {
    needsRenderRef.current = true;
    wakeRenderLoopRef.current?.();
  }, [theme]);
  useEffect(() => () => {
    if (timelineDropGhostFrameRef.current !== null) {
      cancelAnimationFrame(timelineDropGhostFrameRef.current);
      timelineDropGhostFrameRef.current = null;
    }
    if (scrubSeekFrameRef.current !== null) {
      cancelAnimationFrame(scrubSeekFrameRef.current);
      scrubSeekFrameRef.current = null;
    }
    if (timelineWheelFrameRef.current !== null) {
      cancelAnimationFrame(timelineWheelFrameRef.current);
      timelineWheelFrameRef.current = null;
    }
    pendingScrubSeekRef.current = null;
    pendingTimelineWheelDeltaRef.current = 0;
    pendingTimelineWheelScrollParentRef.current = null;
  }, []);
  const bladeXRef = useRef<number | null>(null);
  // Leaving blade mode via keyboard (V/Escape) must clear the preview line
  // immediately — it was previously only cleared on the next mouse move.
  useEffect(() => {
    if (toolMode !== "blade" && bladeXRef.current !== null) {
      bladeXRef.current = null;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    }
  }, [toolMode]);

  // Compute sorted track layout entries.
  // Text/sticker/effect tracks sit above video; audio stays below video.
  // While dragging an effect before an effects track exists, insert a virtual
  // E row so the drop ghost reserves space instead of covering V1.
  // Video tracks stack bottom-up (V1 at the visual bottom, V2 above V1) to match compositor z-order.
  const trackLayout = useMemo((): TrackLayoutEntry[] => {
    const shouldShowVirtualEffectTrack =
      timelineDropGhost?.kind === "effect" &&
      timelineDropGhost.trackMissing &&
      !rawTracks.some((track) => track.type === "effect" && !track.locked && track.visible !== false);
    const maxEffectIndex = rawTracks
      .filter((track) => track.type === "effect")
      .reduce((maxIndex, track) => Math.max(maxIndex, track.index), 0);
    const layoutTracks: Array<TimelineTrack & { virtual?: boolean }> = shouldShowVirtualEffectTrack
      ? [
          ...rawTracks,
          {
            type: "effect",
            index: maxEffectIndex + 1,
            label: `E${maxEffectIndex + 1}`,
            muted: false,
            locked: false,
            visible: true,
            volume: 1,
            virtual: true,
          },
        ]
      : rawTracks;
    const sorted = [...layoutTracks].sort((a, b) => {
      const typeA = getTimelineTrackSortWeight(a.type);
      const typeB = getTimelineTrackSortWeight(b.type);
      if (typeA !== typeB) return typeA - typeB;
      if (a.type === "video") return b.index - a.index;
      return a.index - b.index;
    });

    const entries: TrackLayoutEntry[] = [];
    let y = 0;

    for (const track of sorted) {
      const h = getTimelineTrackHeight(track.type);
      entries.push({
        key: `${track.type}-${track.index}`,
        type: track.type,
        index: track.index,
        y,
        height: h,
        track: track.virtual ? null : track,
        virtual: Boolean(track.virtual),
        locked: track.locked,
        muted: track.muted,
        visible: track.visible,
      });
      y += h;
    }

    return entries;
  }, [rawTracks, timelineDropGhost]);

  // The selected item's diamonds as drawn, for the keyboard layer (phase 10d): follows zoom, layout, selection, and edits.
  const keyframeGeometry = useMemo(
    () => getKeyframeItemGeometry({ clips, scenes, tracks: trackLayout, zoom, selectedClipIds, selectedSceneId } as unknown as CanvasState),
    [clips, scenes, trackLayout, zoom, selectedClipIds, selectedSceneId],
  );
  const focusCanvas = useCallback(() => canvasRef.current?.focus({ preventScroll: true }), []);

  const getSceneStartForTimeline = useCallback((scene: SceneData): number => {
    const sceneIndex = scenes.indexOf(scene);
    return getSceneStart(scene, scenes, sceneIndex);
  }, [scenes]);

  const getSceneDurationById = useCallback((sceneId: string): number => {
    const scene = scenes.find((s) => s.id === sceneId);
    return scene ? getSceneDuration(scene) : 0;
  }, [scenes]);

  const getGroupEnd = useCallback((
    sceneOriginals: Map<string, { startTime: number; trackIndex: number }>,
    clipOriginals: Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>,
  ): number => {
    let groupEnd = 0;
    for (const [sceneId, orig] of sceneOriginals) {
      groupEnd = Math.max(groupEnd, orig.startTime + getSceneDurationById(sceneId));
    }
    for (const [, orig] of clipOriginals) {
      groupEnd = Math.max(groupEnd, orig.endTime);
    }
    return groupEnd;
  }, [getSceneDurationById]);

  const collectRippleRight = useCallback((
    groupEnd: number,
    deltaSeconds: number,
    sceneOriginals: Map<string, { startTime: number; trackIndex: number }>,
    clipOriginals: Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>,
  ) => {
    const rippleScenes = new Map<string, { startTime: number; trackIndex: number }>();
    const rippleClips = new Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>();
    if (deltaSeconds <= 0.001) return { rippleScenes, rippleClips, pushDelta: 0 };

    // Only items on the SAME tracks as the moved group ripple. Dragging a V1
    // clip must never shove V2/A1 items along with it — other lanes are
    // independent, exactly like the gap measurement below already assumed.
    const occupiedTracks = new Set<string>();
    for (const orig of sceneOriginals.values()) occupiedTracks.add(`video-${orig.trackIndex || 1}`);
    for (const orig of clipOriginals.values()) occupiedTracks.add(`${orig.trackType}-${orig.trackIndex}`);

    for (const scene of scenes) {
      if (sceneOriginals.has(scene.id)) continue;
      if (!occupiedTracks.has(`video-${scene.trackIndex || 1}`)) continue;
      const startTime = getSceneStartForTimeline(scene);
      if (startTime >= groupEnd - 0.001) {
        rippleScenes.set(scene.id, { startTime, trackIndex: scene.trackIndex || 1 });
      }
    }

    for (const clip of clips) {
      if (clipOriginals.has(clip.id)) continue;
      if (!occupiedTracks.has(`${clip.trackType}-${clip.trackIndex}`)) continue;
      if (clip.startTime >= groupEnd - 0.001) {
        rippleClips.set(clip.id, {
          startTime: clip.startTime,
          endTime: clip.endTime,
          trackType: clip.trackType,
          trackIndex: clip.trackIndex,
        });
      }
    }

    // Slide-into-space first: the moved group fills any free gap before it,
    // and later items only get pushed by the amount the group actually
    // overlaps them (CapCut/reference behavior — moving right with room to
    // spare must NOT shift the whole timeline). The gap is measured against
    // items on the SAME tracks as the moved group — a subtitle on the text
    // track sitting right after the cut must not cancel a video-track gap.
    let nearestStart = Number.POSITIVE_INFINITY;
    for (const orig of rippleScenes.values()) {
      if (occupiedTracks.has(`video-${orig.trackIndex || 1}`)) nearestStart = Math.min(nearestStart, orig.startTime);
    }
    for (const orig of rippleClips.values()) {
      if (occupiedTracks.has(`${orig.trackType}-${orig.trackIndex}`)) nearestStart = Math.min(nearestStart, orig.startTime);
    }
    // No same-track item ahead at all → pure slide, nothing to push.
    const gap = Number.isFinite(nearestStart) ? Math.max(0, nearestStart - groupEnd) : Number.POSITIVE_INFINITY;
    const pushDelta = Number.isFinite(gap) ? Math.max(0, deltaSeconds - gap) : 0;
    if (pushDelta <= 0.001) {
      rippleScenes.clear();
      rippleClips.clear();
      return { rippleScenes, rippleClips, pushDelta: 0 };
    }
    return { rippleScenes, rippleClips, pushDelta };
  }, [clips, getSceneStartForTimeline, scenes]);

  // Build canvas state snapshot — reads currentTime from store (not prop) to avoid re-render cascade
  // Max end-time (seconds) each scene/clip may be resized to, from measured source
  // footage length. Feeds the resize clamp so a clip can't be dragged past its source.
  const sourceDurations = useEditorStore((s) => s.sourceDurations);
  const maxEndById = useMemo(() => {
    const m = new Map<string, number>();
    for (const sc of scenes) {
      const d = sourceDurations.get(sc.id);
      if (d && d > 0) m.set(sc.id, getSceneStartForTimeline(sc) + d);
    }
    for (const c of clips) {
      const d = sourceDurations.get(c.id);
      if (d && d > 0) m.set(c.id, c.startTime + Math.max(0.1, d - (c.trimStart ?? 0)));
    }
    return m;
  }, [scenes, clips, sourceDurations, getSceneStartForTimeline]);

  // Shared with the mouseup commit handlers so hover-track detection during a
  // drag matches exactly what gets committed (preview === commit).
  const findBestTrackIdx = useCallback((tracks: TrackLayoutEntry[], cursorY: number): number | undefined => {
    let bestTrackIdx: number | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const t of tracks) {
      if (t.type !== "video" || t.visible === false) continue;
      const centerY = t.y + t.height / 2;
      const d = Math.abs(centerY - cursorY);
      if (d < bestDist) {
        bestDist = d;
        bestTrackIdx = t.index;
      }
    }
    return bestTrackIdx;
  }, []);

  const buildState = useCallback((): CanvasState => {
    // Expose the live scene-drag delta to the renderer so the strip tracks the cursor
    // in real time (no waiting for the server round-trip on mouseup).
    let sceneTimelineDrag: { sceneId: string; deltaX: number; deltaY: number } | null = null;
    let linkedClipDragPositions: CanvasState["linkedClipDragPositions"] = null;
    let linkedSceneDragPositions: CanvasState["linkedSceneDragPositions"] = null;
    const sd = sceneTimeDragRef.current;
    if (sd && sd.armed) {
      const deltaX = sd.currentX - sd.startX;
      const requestedDeltaSeconds = deltaX / zoom;
      const clampedDeltaSeconds = constrainBackwardDelta(
        requestedDeltaSeconds,
        [
          ...[...sd.linkedSceneOriginals.values()].map((orig) => orig.startTime),
          ...[...sd.linkedClipOriginals.values()].map((orig) => orig.startTime),
        ],
        0,
      );
      // ONE resolveMove call resolves both the clamp (left drags) and the
      // ripple-right push for every scene on the video tracks — preview here
      // and commit in the mouseup handlers read the same Map shape (same
      // targetTrackId/primaryId args), so what the user sees while dragging
      // is exactly what gets committed on mouseup.
      const engineItems = scenesToEngineItems(scenes);
      const previewCursorY = sd.currentY - RULER_HEIGHT;
      const previewTrackIdx = findBestTrackIdx(trackLayout, previewCursorY);
      const previewTargetTrackId = previewTrackIdx != null ? `v${previewTrackIdx}` : undefined;
      const changes = resolveMove(
        engineItems,
        [...sd.linkedSceneOriginals.keys()],
        clampedDeltaSeconds,
        previewTargetTrackId,
        sd.sceneId,
      );
      sceneDragChangesRef.current = changes;
      const primaryChange = changes.get(sd.sceneId);
      const deltaSeconds = primaryChange ? primaryChange.start - sd.origStart : clampedDeltaSeconds;
      sceneTimelineDrag = {
        sceneId: sd.sceneId,
        deltaX: deltaSeconds * zoom,
        deltaY: sd.currentY - sd.startY,
      };
      if (sd.linkedClipOriginals.size > 0) {
        linkedClipDragPositions = new Map();
        for (const [clipId, orig] of sd.linkedClipOriginals) {
          const duration = orig.endTime - orig.startTime;
          const startTime = Math.max(0, orig.startTime + deltaSeconds);
          linkedClipDragPositions.set(clipId, { startTime, endTime: startTime + duration });
        }
      }
      for (const [sceneId, change] of changes) {
        if (sceneId === sd.sceneId) continue;
        linkedSceneDragPositions ??= new Map();
        // Ease pushed/crossed neighbors toward their target instead of
        // teleporting the instant a midpoint is crossed — the hop reads as
        // glitchy at full speed. Converges in a few frames; the COMMIT still
        // uses the exact engine result, only the preview is smoothed.
        const prev = sceneDragPreviewLerpRef.current.get(sceneId);
        const eased = prev === undefined || Math.abs(prev - change.start) < 0.02
          ? change.start
          : prev + (change.start - prev) * 0.35;
        sceneDragPreviewLerpRef.current.set(sceneId, eased);
        linkedSceneDragPositions.set(sceneId, { startTime: eased });
      }
      // Neighbors that returned to their stored spot (no engine entry this
      // frame) ease back home too.
      for (const [sceneId, prev] of sceneDragPreviewLerpRef.current) {
        if (changes.has(sceneId) || sceneId === sd.sceneId) continue;
        const idx = scenes.findIndex((sc) => sc.id === sceneId);
        if (idx < 0) { sceneDragPreviewLerpRef.current.delete(sceneId); continue; }
        const home = getSceneStartForTimeline(scenes[idx]);
        if (Math.abs(prev - home) < 0.02) {
          sceneDragPreviewLerpRef.current.delete(sceneId);
          continue;
        }
        const eased = prev + (home - prev) * 0.35;
        sceneDragPreviewLerpRef.current.set(sceneId, eased);
        linkedSceneDragPositions ??= new Map();
        linkedSceneDragPositions.set(sceneId, { startTime: eased });
      }
      if (deltaSeconds > 0.001) {
        // Clips (audio/text/etc.) linked to no scene still ripple when pushed
        // past by the group's new end — the engine only models scenes today,
        // so this clip-only half keeps using the existing ripple helper.
        const groupEnd = getGroupEnd(sd.linkedSceneOriginals, sd.linkedClipOriginals);
        const { rippleClips, pushDelta } = collectRippleRight(
          groupEnd,
          deltaSeconds,
          sd.linkedSceneOriginals,
          sd.linkedClipOriginals,
        );
        if (rippleClips.size > 0) {
          linkedClipDragPositions ??= new Map();
          for (const [clipId, orig] of rippleClips) {
            const duration = orig.endTime - orig.startTime;
            const startTime = orig.startTime + pushDelta;
            linkedClipDragPositions.set(clipId, { startTime, endTime: startTime + duration });
          }
        }
      }
    } else if (dragRef.current.mode === "move" && dragRef.current.committed) {
      const clipOriginals = dragRef.current.originals;
      const deltaSeconds = getMoveDragDelta(
        dragRef.current,
        ({
          scenes,
          tracks: trackLayout,
          clips,
          markers,
      selectedMarkerId: storeApi.getState().selectedMarkerId,
          selectedClipIds,
          selectedSceneIds,
          selectedSceneId,
          selectedAudioTarget,
          selectedTransition,
          zoom,
          scrollLeft: scrollLeftRef.current,
          currentTime: storeApi.getState().currentTime,
          totalDuration,
          musicUrl,
          musicVolume,
          snapEnabled,
          snapToBeats,
          beatTimes,
          hoveredClipId: hoveredClipRef.current,
          containerWidth: containerRef.current?.clientWidth ?? 0,
          containerHeight: containerRef.current?.clientHeight ?? 0,
          toolMode,
          bladeX: null,
          unlockedVoiceovers,
          voiceoverOffsets: voiceoverOffsetsRef.current,
          maxEndById,
        } satisfies CanvasState),
        [...clipDragLinkedSceneOriginalsRef.current.values()].map((orig) => orig.startTime),
      );
      if (clipDragLinkedSceneOriginalsRef.current.size > 0) {
        linkedSceneDragPositions = new Map();
        for (const [sceneId, orig] of clipDragLinkedSceneOriginalsRef.current) {
          linkedSceneDragPositions.set(sceneId, {
            startTime: Math.max(0, orig.startTime + deltaSeconds),
          });
        }
      }
      if (deltaSeconds > 0.001) {
        const groupEnd = getGroupEnd(clipDragLinkedSceneOriginalsRef.current, clipOriginals);
        const { rippleScenes, rippleClips, pushDelta } = collectRippleRight(
          groupEnd,
          deltaSeconds,
          clipDragLinkedSceneOriginalsRef.current,
          clipOriginals,
        );
        for (const [sceneId, orig] of rippleScenes) {
          linkedSceneDragPositions ??= new Map();
          linkedSceneDragPositions.set(sceneId, { startTime: orig.startTime + pushDelta });
        }
        if (rippleClips.size > 0) {
          linkedClipDragPositions ??= new Map();
          for (const [clipId, orig] of rippleClips) {
            const duration = orig.endTime - orig.startTime;
            const startTime = orig.startTime + pushDelta;
            linkedClipDragPositions.set(clipId, { startTime, endTime: startTime + duration });
          }
        }
      }
    } else if (
      (dragRef.current.mode === "resize-left" || dragRef.current.mode === "resize-right") &&
      dragRef.current.committed &&
      dragRef.current.clipId &&
      dragRef.current.resizeTime !== null
    ) {
      const orig = dragRef.current.originals.get(dragRef.current.clipId);
      if (orig) {
        const trackKey = `${orig.trackType}-${orig.trackIndex}`;
        const deltaSeconds = dragRef.current.mode === "resize-right"
          ? dragRef.current.resizeTime - orig.endTime
          : dragRef.current.resizeTime - orig.startTime;
        if (Math.abs(deltaSeconds) > 0.001) {
          linkedClipDragPositions = new Map();
          for (const clip of clips) {
            if (clip.id === dragRef.current.clipId) continue;
            if (`${clip.trackType}-${clip.trackIndex}` !== trackKey) continue;
            const shouldShift = dragRef.current.mode === "resize-right"
              ? clip.startTime >= orig.endTime - 0.001
              : clip.endTime <= orig.startTime + 0.001;
            if (!shouldShift) continue;
            linkedClipDragPositions.set(clip.id, {
              startTime: Math.max(0, clip.startTime + deltaSeconds),
              endTime: Math.max(0.1, clip.endTime + deltaSeconds),
            });
          }
        }
      }
    } else if (playheadRippleDragRef.current && playheadRippleDragRef.current.armed) {
      const pd = playheadRippleDragRef.current;
      const requestedDeltaSeconds = (pd.currentWorldX - pd.startWorldX) / zoom;
      const deltaSeconds = constrainBackwardDelta(
        requestedDeltaSeconds,
        [
          ...[...pd.sceneOriginals.values()].map((orig) => orig.startTime),
          ...[...pd.clipOriginals.values()].map((orig) => orig.startTime),
        ],
        pd.startTime,
      );
      if (Math.abs(deltaSeconds) > 0.001) {
        linkedSceneDragPositions = new Map();
        linkedClipDragPositions = new Map();
        for (const [sceneId, orig] of pd.sceneOriginals) {
          linkedSceneDragPositions.set(sceneId, { startTime: orig.startTime + deltaSeconds });
        }
        for (const [clipId, orig] of pd.clipOriginals) {
          const duration = orig.endTime - orig.startTime;
          const startTime = orig.startTime + deltaSeconds;
          linkedClipDragPositions.set(clipId, { startTime, endTime: startTime + duration });
        }
      }
    }
    let shotDrag: CanvasState["shotDrag"] = null;
    const shd = shotDragRef.current;
    if (shd) {
      shotDrag = {
        sceneId: shd.sceneId,
        shotIndex: shd.shotIndex,
        cursorWorldX: shd.currentX + scrollLeftRef.current,
        cursorY: shd.currentY,
      };
    }
    let sceneEdgeResize: CanvasState["sceneEdgeResize"] = null;
    const srd = sceneResizeDragRef.current;
    if (srd && srd.armed) {
      const resizePreview = getSceneResizePreview(srd, zoom);
      if (srd.edge === "right") {
        sceneEdgeResize = {
          sceneId: srd.sceneId,
          edge: "right",
          newStart: resizePreview.newStart,
          newDuration: resizePreview.newDuration,
          snapTime: resizePreview.snapTime,
        };
      } else {
        sceneEdgeResize = {
          sceneId: srd.sceneId,
          edge: "left",
          newStart: resizePreview.newStart,
          newDuration: resizePreview.newDuration,
          snapTime: resizePreview.snapTime,
        };
      }
      if (Math.abs(resizePreview.deltaEnd) > 0.001) {
        const oldEnd = srd.origStart + srd.origDuration;
        linkedSceneDragPositions = new Map();
        linkedClipDragPositions = new Map();
        for (const scene of scenes) {
          if (scene.id === srd.sceneId) continue;
          const startTime = getSceneStartForTimeline(scene);
          if (startTime < oldEnd - 0.001) continue;
          linkedSceneDragPositions.set(scene.id, {
            startTime: Math.max(0, startTime + resizePreview.deltaEnd),
          });
        }
        for (const clip of clips) {
          if (clip.startTime < oldEnd - 0.001) continue;
          const duration = clip.endTime - clip.startTime;
          const startTime = Math.max(0, clip.startTime + resizePreview.deltaEnd);
          linkedClipDragPositions.set(clip.id, { startTime, endTime: startTime + duration });
        }
      }
    } else if (pendingResizeRef.current) {
      // Keep showing the committed dimensions until the server round-trip lands.
      // `pending` suppresses the size badge — it's only for the live drag.
      const pr = pendingResizeRef.current;
      sceneEdgeResize = {
        sceneId: pr.sceneId,
        edge: "right",
        newStart: pr.newStart,
        newDuration: pr.newDuration,
        pending: true,
      };
    }
    // Live transition duration preview (symmetric stretch around the cut).
    let transitionResize: CanvasState["transitionResize"] = null;
    const trd = transitionResizeDragRef.current;
    if (trd && trd.armed) {
      const deltaSec = (trd.currentX - trd.startX) / zoom;
      const durationDelta = (trd.edge === "right" ? 1 : -1) * deltaSec * 2;
      transitionResize = {
        id: trd.id,
        kind: trd.kind,
        durationSeconds: Math.min(trd.maxDuration, Math.max(0.1, trd.origDuration + durationDelta)),
      };
    }

    return {
      scenes,
      tracks: trackLayout,
      clips,
      markers,
      selectedMarkerId: storeApi.getState().selectedMarkerId,
      selectedClipIds: marqueePreviewSelectionRef.current ?? selectedClipIds,
      selectedSceneIds: marqueePreviewSceneSelectionRef.current ?? selectedSceneIds,
      selectedSceneId,
      selectedAudioTarget,
      selectedTransition,
      zoom,
      scrollLeft: scrollLeftRef.current,
      currentTime: storeApi.getState().currentTime,
      totalDuration,
      musicUrl,
      musicVolume,
      snapEnabled,
      hoveredClipId: hoveredClipRef.current,
      containerWidth: sizeRef.current.width,
      containerHeight: sizeRef.current.height,
      toolMode,
      bladeX: bladeXRef.current,
      unlockedVoiceovers,
      voiceoverOffsets: voiceoverOffsetsRef.current,
      maxEndById,
      sceneTimelineDrag,
      linkedClipDragPositions,
      linkedSceneDragPositions,
      shotDrag,
      selectedShot,
      sceneEdgeResize,
      transitionResize,
      transitionDropGuides: transitionDropGuidesRef.current,
      ...keyframes.overlayState(),
      snapToBeats,
      beatTimes,
      aiActivity,
      cutPreview: aiCutPreview,
    };
  }, [collectRippleRight, findBestTrackIdx, getGroupEnd, scenes, trackLayout, clips, markers, selectedClipIds, selectedSceneIds, selectedSceneId, selectedAudioTarget, selectedTransition, zoom, totalDuration, musicUrl, musicVolume, snapEnabled, snapToBeats, beatTimes, aiActivity, aiCutPreview, toolMode, unlockedVoiceovers, selectedShot]);

  useEffect(() => () => {
    audioDurationAbortRef.current?.abort();
    audioDurationAbortRef.current = null;
  }, []);

  // Timeline viewport visibility
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      const visibleFrame = requestAnimationFrame(() => setTimelineVisible(true));
      return () => cancelAnimationFrame(visibleFrame);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setTimelineVisible(entry.isIntersecting);
      },
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Request a canvas re-render
  const requestRender = useCallback(() => {
    needsRenderRef.current = true;
    wakeRenderLoopRef.current?.();
  }, []);

  // Connect caches to trigger re-render. As each frame finishes decoding we also
  // re-run the media request so filmstrip frames that were throttled by the
  // concurrency cap get queued — this self-terminates once everything is cached.
  const requestMediaRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onThumbUpdate = () => {
      requestRender();
      requestMediaRef.current?.();
    };
    thumbnailCacheRef.current.onUpdate = onThumbUpdate;
    waveformCacheRef.current.onUpdate = requestRender;
    return () => {
      thumbnailCacheRef.current.onUpdate = null;
      waveformCacheRef.current.onUpdate = null;
    };
  }, [requestRender]);

  useEffect(() => {
    if (docVisible && timelineVisible) return;
    audioDurationAbortRef.current?.abort();
    audioDurationAbortRef.current = null;
    reset();
  }, [docVisible, reset, timelineVisible]);

  // Request waveform for music URL
  useEffect(() => {
    if (musicUrl && docVisible && timelineVisible) {
      waveformCacheRef.current.request(musicUrl);
    }
  }, [musicUrl, docVisible, timelineVisible]);

  // Clear the pending resize override once the server-updated scene lands.
  // Compare against the DERIVED start/duration (what the renderer draws), not
  // raw fields — scenes without an explicit timelinePositionSeconds derive
  // their start from stacking order, and comparing against the raw null/0
  // meant the override never matched and the committed preview stuck forever.
  useEffect(() => {
    const pr = pendingResizeRef.current;
    if (!pr) return;
    const sceneIndex = scenes.findIndex((s) => s.id === pr.sceneId);
    if (sceneIndex < 0) {
      // Scene deleted while pending — drop the stale override.
      pendingResizeRef.current = null;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }
    const sc = scenes[sceneIndex];
    const serverDur = getSceneDuration(sc);
    const serverStart = getSceneStart(sc, scenes, sceneIndex);
    if (
      Math.abs(serverDur - pr.newDuration) < 0.11 &&
      Math.abs(serverStart - pr.newStart) < 0.11
    ) {
      pendingResizeRef.current = null;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    }
  }, [scenes]);

  const requestVisibleTimelineMedia = useCallback(() => {
    if (!docVisible || !timelineVisible) {
      waveformCacheRef.current.cancelUnused(new Set());
      thumbnailCacheRef.current.cancelUnused(new Set());
      return;
    }
    if (storeApi.getState().isPlaying) {
      waveformCacheRef.current.cancelUnused(new Set());
      thumbnailCacheRef.current.cancelUnused(new Set());
      return;
    }
    const visibleLeftPx = Math.max(0, scrollLeftRef.current - TIMELINE_MEDIA_OVERSCAN_PX);
    const visibleRightPx = scrollLeftRef.current + sizeRef.current.width + TIMELINE_MEDIA_OVERSCAN_PX;
    const visibleStartSec = visibleLeftPx / zoom;
    const visibleEndSec = visibleRightPx / zoom;
    const activeWaveformUrls = new Set<string>();
    const activeThumbnailUrls = new Set<string>();
    const visibleTrackKeys = new Set(
      trackLayout.filter((track) => track.visible !== false).map((track) => track.key),
    );
    const shouldRequestTrackMedia = (type: string, index: number) => {
      const safeIndex = Number.isFinite(index) && index >= 1 ? index : 1;
      return visibleTrackKeys.has(`${type}-${safeIndex}`);
    };
    if (musicUrl && visibleTrackKeys.has("audio-1")) activeWaveformUrls.add(musicUrl);

    for (const clip of clips) {
      if (!shouldRequestTrackMedia(clip.trackType, Number(clip.trackIndex ?? 1))) continue;
      if (clip.trackType === "audio" && clip.mediaUrl) {
        if (clip.endTime < visibleStartSec || clip.startTime > visibleEndSec) continue;
        activeWaveformUrls.add(clip.mediaUrl);
        waveformCacheRef.current.request(clip.mediaUrl);
      } else if (clip.trackType === "video" || clip.trackType === "sticker") {
        if (clip.endTime < visibleStartSec || clip.startTime > visibleEndSec) continue;
        const widthPx = Math.max(1, (clip.endTime - clip.startTime) * zoom);
        const plan = planClipFilmstrip(clip, widthPx);
        if (plan) {
          activeThumbnailUrls.add(plan.url);
          thumbnailCacheRef.current.request(plan.url, plan.isVideo ? plan.times : [0]);
        }
      }
    }
    waveformCacheRef.current.cancelUnused(activeWaveformUrls);

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (!shouldRequestTrackMedia("video", Number(scene.trackIndex ?? 1))) continue;
      const sceneStart = getSceneStart(scene, scenes, i);
      const sceneEnd = sceneStart + getSceneDuration(scene);
      if (sceneEnd < visibleStartSec || sceneStart > visibleEndSec) continue;

      const sceneWidthPx = Math.max(getSceneDuration(scene) * zoom, 2);
      const plan = planSceneFilmstrip(scene, scenes, i, sceneWidthPx);
      if (plan) {
        activeThumbnailUrls.add(plan.url);
        thumbnailCacheRef.current.request(plan.url, plan.isVideo ? plan.times : [0]);
      }
      // Also preload end images for CONTINUE fallback
      const endUrl = scene.endImageThumbUrl || scene.endImageUrl;
      if (endUrl) {
        activeThumbnailUrls.add(endUrl);
        thumbnailCacheRef.current.request(endUrl, [0]);
      }
      if (scene.shotBreakdown) {
        const shots = parseCachedShotBreakdown(scene.shotBreakdown);
        for (const cropUrl of collectCopyVideoPanelCropUrls(shots)) {
          activeThumbnailUrls.add(cropUrl);
          thumbnailCacheRef.current.request(cropUrl, [0]);
        }
        for (const shot of shots) {
          // After Detect (before any storyboard/panel is built) only source_frame_url
          // exists — request it too so the timeline renderer can draw each shot's
          // opening frame from the raw video instead of an empty block.
          const kurl = shot.keyframe_url || shot.panel_url || (shot as { source_frame_url?: string | null }).source_frame_url;
          if (kurl) {
            activeThumbnailUrls.add(kurl);
            thumbnailCacheRef.current.request(kurl, [0]);
          }
        }
      }
    }
    thumbnailCacheRef.current.cancelUnused(activeThumbnailUrls);
  }, [clips, docVisible, musicUrl, scenes, timelineVisible, trackLayout, zoom]);

  // Request visible timeline media only; scroll/resize ask for more as needed.
  useEffect(() => {
    requestMediaRef.current = requestVisibleTimelineMedia;
    requestVisibleTimelineMedia();
  }, [requestVisibleTimelineMedia]);

  // Mark dirty when props change (NOT currentTime — handled by RAF loop reading from store)
  useEffect(() => {
    needsRenderRef.current = true;
    wakeRenderLoopRef.current?.();
  }, [scenes, trackLayout, clips, markers, selectedClipIds, selectedSceneIds, selectedSceneId, selectedAudioTarget, selectedTransition, zoom, totalDuration, musicUrl, musicVolume, snapEnabled, snapToBeats, aiActivity, aiCutPreview, toolMode]);

  // Dev-only debug hook: exposes current scene strip rects so e2e smoke tests
  // can assert on layout/zoom/drag behavior without brittle pixel guessing.
  // Reads scrollLeftRef live at call time so it never returns a stale snapshot.
  useEffect(() => {
    if (!debugHooks) return;
    (window as any).__timelineDebugRects = () =>
      scenes.map((scene, i) => {
        const startSeconds = getSceneStart(scene, scenes, i);
        const track = trackLayout.find((t) => t.type === "video" && t.index === Number((scene as any).trackIndex || 1));
        return {
          id: scene.id,
          x: startSeconds * zoom - scrollLeftRef.current,
          y: RULER_HEIGHT + (track?.y ?? 0),
          startSeconds,
          duration: getSceneDuration(scene),
          order: (scene as any).order,
          caption: (scene.caption || "").slice(0, 20),
          selected: scene.id === selectedSceneId,
        };
      });
    // The selected item's keyframe diamonds in canvas pixels (phase 10c e2e).
    (window as any).__timelineDebugKeyframes = () => {
      const state = buildStateRef.current();
      const geometry = getKeyframeItemGeometry(state);
      if (!geometry) return null;
      const d = Math.max(0.001, geometry.duration);
      return {
        clipId: geometry.clipId ?? null,
        sceneId: geometry.sceneId ?? null,
        start: geometry.start,
        duration: geometry.duration,
        // The diamond the canvas rings for keyboard focus (phase 10d), item-local seconds.
        focusedTime: state.focusedKeyframe?.time ?? null,
        diamonds: geometry.times.map((time) => ({
          time,
          x: geometry.x + (time / d) * geometry.w - state.scrollLeft,
          y: geometry.y + geometry.h - KEYFRAME_MARKER_INSET,
        })),
      };
    };
    // Track rows in canvas pixels (phase 10c e2e: marquee gestures).
    (window as any).__timelineDebugTracks = () => trackLayout.map((t) => ({ key: t.key, type: t.type, index: t.index, y: RULER_HEIGHT + t.y, height: t.height }));
    (window as any).__timelineDebugMarkers = () => ({
      markers: (storeApi.getState().timelineMarkers || []).map((m) => ({ id: m.id, time: m.time })),
      selectedMarkerId: storeApi.getState().selectedMarkerId,
      zoom,
      scrollLeft: scrollLeftRef.current,
    });
    return () => {
      delete (window as any).__timelineDebugRects;
      delete (window as any).__timelineDebugKeyframes;
      delete (window as any).__timelineDebugMarkers;
      delete (window as any).__timelineDebugTracks;
    };
  }, [debugHooks, scenes, trackLayout, zoom, selectedSceneId]);

  // Clear stale selected transitions when moving/resizing/deleting makes their
  // visible cut marker disappear. Otherwise the properties panel can keep
  // editing a final or non-adjacent item that no longer has a transition slot.
  useEffect(() => {
    if (!selectedTransition) return;
    const currentTransitionMarkers = [
      ...getTransitionMarkers(clips, trackLayout, zoom),
      ...getSceneTransitionMarkers(
        scenes,
        trackLayout,
        zoom,
        (index) => getSceneStart(scenes[index], scenes, index) + getSceneDuration(scenes[index]),
        (index) => getSceneStart(scenes[index], scenes, index),
      ),
    ];
    if (selectedTransition && !hasTransitionMarker(currentTransitionMarkers, selectedTransition)) {
      clearTransitionSelection();
    }
  }, [clearTransitionSelection, clips, scenes, selectedTransition, trackLayout, zoom]);

  // RAF loop — stable ref to buildState so effect doesn't re-run on every prop change
  const buildStateRef = useRef(buildState);
  buildStateRef.current = buildState;
  // Last state produced by the render loop. Idle hover hit-detection reuses it
  // (with a refreshed scrollLeft) instead of rebuilding the full CanvasState on
  // every mousemove. If the timeline changed, a render was already requested,
  // so the cached state is at most one frame stale — fine for cursor hover.
  const lastBuiltStateRef = useRef<CanvasState | null>(null);

  // During an active drag the committed clip/scene data a drag update reads
  // (clips, tracks, zoom, snapEnabled, maxEndById, totalDuration) cannot
  // change — only scrollLeft can. Reuse the render loop's last state instead
  // of paying a full buildState (ripple maps, constraint scans) per mousemove.
  const getDragBuildState = useCallback((): CanvasState => {
    const cached = lastBuiltStateRef.current;
    if (cached) {
      return cached.scrollLeft === scrollLeftRef.current
        ? cached
        : { ...cached, scrollLeft: scrollLeftRef.current };
    }
    return buildStateRef.current();
  }, []);

  useEffect(() => {
    updatePlayheadOverlayRef.current = (time) => {
      if (!playheadOverlayRef.current) return;
      // Canvas coords — the overlay lives in the sticky viewport layer.
      playheadOverlayRef.current.style.transform = `translate3d(${time * zoom - scrollLeftRef.current}px, 0, 0)`;
    };
    updatePlayheadOverlayRef.current(storeApi.getState().currentTime);
  }, [zoom]);

  useEffect(() => {
    if (!docVisible || !timelineVisible) return;
    needsRenderRef.current = true;
    wakeRenderLoopRef.current?.();
    renderLoopActiveRef.current = true;

    let stopped = false;

    const scheduleFrame = () => {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(loop);
    };

    const wakeRenderLoop = () => {
      if (stopped || renderLoopActiveRef.current) return;
      renderLoopActiveRef.current = true;
      scheduleFrame();
    };
    wakeRenderLoopRef.current = wakeRenderLoop;

    const loop = () => {
      const storeTime = storeApi.getState().currentTime;
      const canvas = canvasRef.current;
      updatePlayheadOverlayRef.current(storeTime);

      if (needsRenderRef.current) {
        // Full canvas render only when the static timeline changes. The live
        // playhead moves through a DOM overlay so playback ticks don't redraw
        // clips, thumbnails, waveforms, and markers.
        needsRenderRef.current = false;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            const state = buildStateRef.current();
            state.currentTime = storeTime;
            lastBuiltStateRef.current = state;
            renderTimeline(ctx, state, dragRef.current, thumbnailCacheRef.current, waveformCacheRef.current, { drawPlayhead: false, theme: themeRef.current, devicePixelRatio: window.devicePixelRatio || 1 });
            // While any scene shows the processing overlay keep repainting so
            // its spinner animates (read from freshly built state — no stale
            // closure over `scenes`).
            if (state.scenes?.some((sc: { status?: string }) =>
              sc.status === "video_generating" || sc.status === "images_generating" || sc.status === "face_swapping")) {
              needsRenderRef.current = true;
            }
          }
        }
      }
      if (needsRenderRef.current) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        renderLoopActiveRef.current = false;
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      renderLoopActiveRef.current = false;
      if (wakeRenderLoopRef.current === wakeRenderLoop) {
        wakeRenderLoopRef.current = null;
      }
      cancelAnimationFrame(rafRef.current);
    };
  }, [docVisible, timelineVisible]); // stable except when tab/viewport visibility sleeps/wakes the loop

  // Resize observer for HiDPI canvas sizing.
  //
  // The canvas is VIEWPORT sized, not content sized: it sticks to the left of
  // the scroll port (past the label column) and the renderer translates by
  // -scrollLeft. A content-sized canvas grew with zoom — at 400 px/s on a
  // 4-minute project that is 115000x124 CSS px (232 MB of backing store, past
  // Chrome's max canvas dimension), so the whole timeline painted blank. It
  // also defeated the renderer's viewport culling, since culling bounds are
  // derived from containerWidth.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const applySize = () => {
      const scrollParent = getScrollParent();
      const height = container.clientHeight;
      const width = Math.max(
        1,
        Math.min(
          container.clientWidth,
          (scrollParent?.clientWidth ?? container.clientWidth) - TIMELINE_LABEL_COL_WIDTH,
        ),
      );
      if (sizeRef.current.width === width && sizeRef.current.height === height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (viewportLayerRef.current) viewportLayerRef.current.style.width = `${width}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
      }
      sizeRef.current = { width, height };
      requestVisibleTimelineMedia();
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    };

    const ro = new ResizeObserver(applySize);
    ro.observe(container);
    const scrollParent = getScrollParent();
    if (scrollParent) ro.observe(scrollParent);
    applySize();
    return () => ro.disconnect();
  }, [getScrollParent, requestVisibleTimelineMedia]);

  // Handle scroll on parent container
  useEffect(() => {
    const container = getScrollParent();
    if (!container) return;
    // The canvas redraw is already coalesced by the dirty-flag RAF loop. Media
    // planning (filmstrip/waveform requests) is heavier, so coalesce it to once
    // per animation frame instead of running on every scroll event (which can
    // fire many times per frame during fast scroll or playback auto-scroll).
    let mediaRaf: number | null = null;
    const onScroll = () => {
      scrollLeftRef.current = container.scrollLeft;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      if (mediaRaf === null) {
        mediaRaf = requestAnimationFrame(() => {
          mediaRaf = null;
          requestVisibleTimelineMedia();
        });
      }
    };
    scrollLeftRef.current = container.scrollLeft;
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (mediaRaf !== null) cancelAnimationFrame(mediaRaf);
    };
  }, [requestVisibleTimelineMedia]);

  // Auto-scroll to keep playhead visible — uses store subscription (not prop) to avoid re-renders
  const prevTimeRef = useRef(0);
  const prevPlayingRef = useRef(storeApi.getState().isPlaying);
  useEffect(() => {
    const unsubTime = storeApi.subscribe((s) => s.currentTime, (ct) => {
      const timeChanged = ct !== prevTimeRef.current;
      if (!timeChanged) return;
      prevTimeRef.current = ct;
      updatePlayheadOverlayRef.current(ct);
      // Paused seeks repaint once so the keyframe diamond under the playhead lights up (phase 10b).
      if (!storeApi.getState().isPlaying) {
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
      }

      // Don't auto-scroll during drag operations
      if (dragRef.current.mode !== "idle") return;
      if (sceneTimeDragRef.current || sceneResizeDragRef.current || shotDragRef.current || panDragRef.current) return;

      const scrollParent = getScrollParent();
      if (!scrollParent) return;

      const playheadX = ct * zoom;
      const labelColWidth = 112; // sticky label column
      const viewLeft = scrollParent.scrollLeft;
      const viewRight = viewLeft + scrollParent.clientWidth - labelColWidth;
      const isPlaying = storeApi.getState().isPlaying;
      const edgeMargin = isPlaying ? PLAYBACK_SCROLL_EDGE_MARGIN_PX : 60;
      const aheadPx = isPlaying ? scrollParent.clientWidth * PLAYBACK_SCROLL_AHEAD_RATIO : edgeMargin;

      if (playheadX < viewLeft + edgeMargin) {
        scrollParent.scrollLeft = Math.max(0, playheadX - aheadPx);
      } else if (playheadX > viewRight - edgeMargin) {
        scrollParent.scrollLeft = playheadX - scrollParent.clientWidth + labelColWidth + aheadPx;
      }
    });
    const unsubPlaying = storeApi.subscribe((s) => s.isPlaying, (isPlaying) => {
      const playingChanged = isPlaying !== prevPlayingRef.current;
      if (!playingChanged) return;
      prevPlayingRef.current = isPlaying;
      requestRender();
    });
    return () => {
      unsubTime();
      unsubPlaying();
    };
  }, [requestRender, zoom]);

  // ── Mouse events ────────────────────────────────────────

  const getCanvasPos = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const getWorldX = useCallback((canvasX: number) => canvasX + scrollLeftRef.current, []);

  const maybeAutoScrollX = useCallback((clientX: number): boolean => {
    const scrollParent = getScrollParent();
    if (!scrollParent) return false;
    const rect = scrollParent.getBoundingClientRect();
    const velocity = edgeScrollVelocity(clientX - rect.left, rect.width);
    if (velocity === 0) return false;
    const before = scrollParent.scrollLeft;
    const nextVp = clampScroll(
      { pxPerSecond: zoom, scrollX: before + velocity, viewportWidthPx: rect.width },
      contentEnd(scenesToEngineItems(scenes)),
    );
    scrollParent.scrollTo({ left: nextVp.scrollX, top: scrollParent.scrollTop });
    if (scrollParent.scrollLeft === before) return false;
    scrollLeftRef.current = scrollParent.scrollLeft;
    needsRenderRef.current = true;
    wakeRenderLoopRef.current?.();
    return true;
  }, [scenes, zoom]);

  const startPanDrag = useCallback((e: React.MouseEvent) => {
    const scrollParent = getScrollParent();
    if (!scrollParent) return;
    panDragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startScrollLeft: scrollParent.scrollLeft,
      startScrollTop: scrollParent.scrollTop,
    };
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = "grabbing";
  }, []);

  const updatePanDrag = useCallback((clientX: number, clientY: number): boolean => {
    const pan = panDragRef.current;
    const scrollParent = getScrollParent();
    if (!pan || !scrollParent) return false;
    scrollParent.scrollTo({
      left: Math.max(0, pan.startScrollLeft - (clientX - pan.startClientX)),
      top: Math.max(0, pan.startScrollTop - (clientY - pan.startClientY)),
    });
    scrollLeftRef.current = scrollParent.scrollLeft;
    needsRenderRef.current = true;
    wakeRenderLoopRef.current?.();
    return true;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && (spacePressedRef.current || e.altKey))) {
      e.preventDefault();
      startPanDrag(e);
      return;
    }
    if (toolMode === "hand" && e.button === 0) {
      e.preventDefault();
      startPanDrag(e);
      return;
    }
    if (e.button !== 0) return; // left click only
    const pos = getCanvasPos(e);
    const state = buildState();
    const hit = hitDetect(pos.x, pos.y, state);
    if (keyframes.handleMouseDown(e, hit)) return;

    if (!hit) {
      setSelectedClipIds(new Set());
      setSelectedSceneIds(new Set());
      if (selectedShot) setSelectedShot(null);
      if (selectedTransition) clearTransitionSelection();
      if (storeApi.getState().selectedMarkerId) storeApi.getState().setSelectedMarkerId(null);
      return;
    }
    // Clicking anything that is not a marker drops the active marker selection
    // (so a later Delete goes back to acting on scenes/clips).
    if (hit.type !== "marker" && storeApi.getState().selectedMarkerId) {
      storeApi.getState().setSelectedMarkerId(null);
    }
    // Any click that lands somewhere OTHER than the current selected shot's
    // scene clears the persistent shot selection.
    if (selectedShot && !(hit.type === "scene" && hit.sceneId === selectedShot.sceneId)) {
      setSelectedShot(null);
    }

    // Transition edge grabbed → start a duration drag (symmetric around the cut).
    if ((hit.type === "transition-resize-left" || hit.type === "transition-resize-right") && (hit.clipId || hit.sceneId)) {
      const kind = hit.sceneId ? "scene" as const : "clip" as const;
      const id = hit.sceneId ?? hit.clipId!;
      const marker = [
        ...getTransitionMarkers(clips, state.tracks, zoom),
        ...getSceneTransitionMarkers(
          scenes, state.tracks, zoom,
          (i) => getSceneStart(scenes[i], scenes, i) + getSceneDuration(scenes[i]),
          (i) => getSceneStart(scenes[i], scenes, i),
        ),
      ].find((m) => m.kind === kind && m.id === id);
      if (marker) {
        transitionResizeDragRef.current = {
          id,
          kind,
          edge: hit.type === "transition-resize-left" ? "left" : "right",
          transitionType: marker.transitionType,
          origDuration: marker.durationSeconds,
          maxDuration: marker.maxDurationSeconds,
          startX: getWorldX(pos.x),
          currentX: getWorldX(pos.x),
          armed: false,
        };
        selectTransition({ kind, id });
        setSelectedSceneIds(new Set());
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
    }

    // Transition marker clicked → select it (for highlight + Delete). It never
    // starts a drag, and any other click clears the transition selection.
    if (hit.type === "transition" && (hit.clipId || hit.sceneId)) {
      selectTransition(hit.sceneId ? { kind: "scene", id: hit.sceneId } : { kind: "clip", id: hit.clipId! });
      setSelectedSceneIds(new Set());
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }
    if (selectedTransition) clearTransitionSelection();

    // Blade mode — split clips. Parent owns any conversion confirmation UI so
    // canvas never falls back to browser alerts.
    if (toolMode === "blade") {
      if (hit.type === "clip" && hit.clipId) {
        if (e.shiftKey && onSplitClipsAtTime) {
          onSplitClipsAtTime(hit.time);
          needsRenderRef.current = true;
          wakeRenderLoopRef.current?.();
          return;
        }
        if (!onSplitClip) return;
        const splitId = getTimelineBladeSplitClipId(clips || [], rawTracks, hit.clipId, hit.time);
        if (!splitId) return;
        onSplitClip(splitId, hit.time);
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
      if (hit.type === "scene" && hit.sceneId && onConvertSceneToSourceVideo) {
        const scene = scenes.find((s) => s.id === hit.sceneId);
        const isGeneratedVideo = scene?.cardType !== "source_clip" && !!scene?.videoUrl;
        if (isGeneratedVideo) {
          onConvertSceneToSourceVideo(hit.sceneId);
          needsRenderRef.current = true;
          wakeRenderLoopRef.current?.();
          return;
        }
      }
      // A clip's resize edge still means "cut here" in blade mode — the
      // natural blade target is a clip boundary, which hit-detects as a
      // resize zone. Never fall through and start a resize drag.
      if ((hit.type === "resize-left" || hit.type === "resize-right") && hit.clipId && onSplitClip) {
        const splitId = getTimelineBladeSplitClipId(clips || [], rawTracks, hit.clipId, hit.time);
        if (splitId) {
          onSplitClip(splitId, hit.time);
          needsRenderRef.current = true;
          wakeRenderLoopRef.current?.();
        }
        return;
      }
      // Blade never starts drags/marquee — only ruler scrubbing falls through.
      if (hit.type !== "ruler") return;
    }

    switch (hit.type) {
      case "marker": {
        if (hit.markerId) {
          markerDragRef.current = { markerId: hit.markerId, startX: getWorldX(pos.x), moved: false };
        }
        break;
      }
      case "ruler": {
        playheadRippleDragRef.current = null;
        dragRef.current = {
          ...createIdleDrag(),
          mode: "ruler-scrub",
          startX: pos.x,
          startY: pos.y,
          currentX: pos.x,
          currentY: pos.y,
        };
        onSeek(hit.time);
        setShuttleSpeed(0);
        break;
      }

      case "scene": {
        if (hit.sceneId) {
          // Compute which shot is under the cursor (for selection/drag checks).
          const sc = scenes.find((s) => s.id === hit.sceneId);
          const sIdx = sc ? scenes.indexOf(sc) : -1;
          let shotIndex = 0;
          let sceneStart = 0;
          // -1 = scene has no parseable shot LIST (e.g. podcast scenes store an
          // object breakdown). Such scenes must never enter shot-drag mode —
          // extract/reorder/merge would send a fake shotIndex the backend rejects.
          let hasShotList = false;
          if (sc && sIdx >= 0) {
            sceneStart = getSceneStart(sc, scenes, sIdx);
            const rawShotIndex = shotIndexForScene(sc, sceneStart, hit.time);
            // Shots made on opennan.com are read only here (phase 9a.1): no shot drag on such scenes.
            hasShotList = rawShotIndex >= 0 && !hasReadOnlyShots(sc);
            shotIndex = Math.max(0, rawShotIndex);
          }

          // Enter shot-drag mode when:
          //  (a) a shot is already ACTIVE (yellow) on this scene — any drag
          //      on this scene moves THAT shot, no matter where in the scene
          //      the click lands, OR
          //  (b) this is a quick-second mousedown on the same scene (≤550ms,
          //      ≤6px) — so the user can double-click-and-drag in one motion.
          const now = performance.now();
          const last = lastSceneClickRef.current;
          const quickSecond =
            last &&
            last.sceneId === hit.sceneId &&
            now - last.time < 550 &&
            Math.abs(last.x - pos.x) < 6 &&
            Math.abs(last.y - pos.y) < 6;
          const hasActiveShotOnScene =
            selectedShot && selectedShot.sceneId === hit.sceneId;
          const isMixedOrSceneMultiSelection =
            selectedSceneIds.size > 1 || selectedClipIds.size > 0;

          if (hasShotList && (hasActiveShotOnScene || (quickSecond && !isMixedOrSceneMultiSelection)) && sc) {
            const draggedShotIndex = hasActiveShotOnScene
              ? selectedShot!.shotIndex
              : shotIndex;
            shotDragRef.current = {
              sceneId: hit.sceneId,
              shotIndex: draggedShotIndex,
              startX: pos.x,
              startY: pos.y,
              currentX: pos.x,
              currentY: pos.y,
              armed: false,
            };
            sceneTimeDragRef.current = null;
      sceneDragPreviewLerpRef.current.clear();
            setSelectedShot({ sceneId: hit.sceneId, shotIndex: draggedShotIndex });
            lastSceneClickRef.current = null;
            if (sc) {
              const shots = parseCachedShotBreakdown<{
                keyframe_url?: string | null;
                end_keyframe_url?: string | null;
                video_url?: string | null;
                panel_url?: string | null;
                prompt?: string | null;
                duration?: number | string | null;
              }>(sc.shotBreakdown);
              const shotData = shots[draggedShotIndex] ?? null;
              suggestChatReference({
                type: "shot",
                label: `Scene ${(sc.order ?? 0) + 1} · Shot ${draggedShotIndex + 1}`,
                sceneId: sc.id,
                sceneOrder: (sc.order ?? 0) + 1,
                shotIndex: draggedShotIndex,
                mediaUrl: shotData?.keyframe_url || shotData?.video_url || shotData?.panel_url || shotData?.end_keyframe_url || null,
                prompt: shotData?.prompt ?? null,
                duration: shotData?.duration ?? null,
              });
            }
          } else {
            // First click on a scene — remember for quick-second detection and
            // prime the regular scene drag. Clear any previous shot selection.
            if (selectedShot) setSelectedShot(null);
            lastSceneClickRef.current = { sceneId: hit.sceneId, time: now, x: pos.x, y: pos.y };
            // Shift/Cmd/Ctrl+click toggles the scene in the selection (CapCut); a plain click on a scene that is part of
            // a multi-selection keeps the selection so the drag moves all of it; any other plain click selects the scene.
            const multiModifier = e.shiftKey || e.ctrlKey || e.metaKey;
            const inMultiSelection = selectedSceneIds.has(hit.sceneId) && selectedSceneIds.size + selectedClipIds.size > 1;
            let nextSelectedSceneIds = selectedSceneIds;
            if (multiModifier) {
              nextSelectedSceneIds = new Set(selectedSceneIds);
              if (nextSelectedSceneIds.has(hit.sceneId)) {
                nextSelectedSceneIds.delete(hit.sceneId);
              } else {
                nextSelectedSceneIds.add(hit.sceneId);
              }
              setSelectedSceneIds(nextSelectedSceneIds);
            } else if (inMultiSelection) {
              nextSelectedSceneIds = selectedSceneIds;
            } else {
              nextSelectedSceneIds = new Set();
              // Clicking the scene that is already the only selection keeps it (no transient empty selection).
              if (!(selectedSceneIds.size === 1 && selectedSceneIds.has(hit.sceneId) && selectedClipIds.size === 0)) setSelectedSceneIds(nextSelectedSceneIds);
            }
            const linkedClipOriginals = new Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>();
            for (const clipId of multiModifier || inMultiSelection ? selectedClipIds : []) {
              const clip = clips.find((c) => c.id === clipId);
              if (!clip) continue;
              linkedClipOriginals.set(clipId, {
                startTime: clip.startTime,
                endTime: clip.endTime,
                trackType: clip.trackType,
                trackIndex: clip.trackIndex,
              });
            }
            const preserveClipSelectionForSceneDrag = linkedClipOriginals.size > 0 || nextSelectedSceneIds.size > 0;
            if (!preserveClipSelectionForSceneDrag && !multiModifier) {
              onSelectScene(hit.sceneId);
              if (sc) {
                // Prefer the shot under the cursor when available. Chat actions
                // like edit/regenerate need shot refs, while scene refs remain
                // the fallback for scenes without a shot breakdown.
                const shots = parseCachedShotBreakdown<{
                  keyframe_url?: string | null;
                  end_keyframe_url?: string | null;
                  video_url?: string | null;
                  panel_url?: string | null;
                  prompt?: string | null;
                  duration?: number | string | null;
                }>(sc.shotBreakdown);
                const shotData = shots.length > 0 && shotIndex >= 0 && shotIndex < shots.length
                  ? shots[shotIndex]
                  : null;
                if (shotData) {
                  suggestChatReference({
                    type: "shot",
                    label: `Scene ${(sc.order ?? 0) + 1} · Shot ${shotIndex + 1}`,
                    sceneId: sc.id,
                    sceneOrder: (sc.order ?? 0) + 1,
                    shotIndex,
                    mediaUrl: shotData.keyframe_url || shotData.video_url || shotData.panel_url || shotData.end_keyframe_url || null,
                    prompt: shotData.prompt ?? null,
                    duration: shotData.duration ?? null,
                  });
                } else {
                  suggestChatReference({
                    type: "scene",
                    label: `Scene ${(sc.order ?? 0) + 1}`,
                    sceneId: sc.id,
                    sceneOrder: (sc.order ?? 0) + 1,
                    mediaUrl: sc.videoUrl || sc.startImageUrl || sc.videoStoryboardRawUrl || sc.videoStoryboardUrl || sc.sourceVideoUrl || null,
                    prompt: sc.caption,
                    duration: getSceneDuration(sc),
                  });
                }
              }
            }
            if (sc) {
              // Use absolute timeline position if migrated; otherwise fall
              // back to the cumulative end-to-end layout (same rule as the
              // renderer / hit detector). Without this, unmigrated projects
              // would send origStart = 0 for every scene, causing a drag on
              // scene 2+ to snap toward the beginning of the timeline.
              const sIdx = scenes.indexOf(sc);
              const origStart = getSceneStart(sc, scenes, sIdx);
              const dragSceneIds = nextSelectedSceneIds.size > 0
                ? new Set(nextSelectedSceneIds)
                : new Set([hit.sceneId]);
              dragSceneIds.add(hit.sceneId);
              const linkedSceneOriginals = new Map<string, { startTime: number; trackIndex: number }>();
              for (const sceneId of dragSceneIds) {
                const scene = scenes.find((s) => s.id === sceneId);
                if (!scene) continue;
                const sceneIndex = scenes.indexOf(scene);
                const startTime = getSceneStart(scene, scenes, sceneIndex);
                linkedSceneOriginals.set(sceneId, {
                  startTime,
                  trackIndex: scene.trackIndex || 1,
                });
              }
              sceneTimeDragRef.current = {
                sceneId: hit.sceneId,
                origStart,
                startX: getWorldX(pos.x),
                startY: pos.y,
                currentX: getWorldX(pos.x),
                currentY: pos.y,
                linkedClipOriginals,
                linkedSceneOriginals,
                didSelectSceneOnMouseDown: !preserveClipSelectionForSceneDrag,
                armed: false,
              };
            }
          }
        }
        break;
      }

      case "clip": {
        if (!hit.clipId) break;
        const noMod = !(e.ctrlKey || e.metaKey || e.shiftKey);
        const alreadySelected = selectedClipIds.has(hit.clipId) && selectedClipIds.size + selectedSceneIds.size > 1;
        // Scenes that move with this clip: the selected ones while the clip stays part of a multi-selection.
        let nextSceneSelection: Set<string> = new Set();

        // Preserve multi-selection when grabbing a clip that's already part of it.
        // Otherwise the click would shrink the selection to just this clip BEFORE
        // the drag controller sees the rest, and a multi-clip drag would silently
        // collapse to a single-clip drag. We defer the "replace" behavior until
        // mouseup (only if the user clicked without dragging).
        let nextSelection: Set<string>;
        if (alreadySelected && noMod) {
          nextSelection = selectedClipIds;
          nextSceneSelection = selectedSceneIds;
          // Remember to replace on mouseup if no drag commits.
          pendingSelectReplaceRef.current = hit.clipId;
        } else {
          // Shift/Cmd/Ctrl+click toggles the clip in the selection and keeps the selected scenes (CapCut).
          nextSelection = computeSelection(
            hit.clipId,
            selectedClipIds,
            clips,
            { ctrl: !noMod, shift: false },
            rawTracks,
          );
          if (noMod) {
            setSelectedClipIds(nextSelection);
          } else {
            nextSceneSelection = selectedSceneIds;
            storeApi.getState().setSelection({ clipIds: nextSelection, sceneIds: selectedSceneIds });
          }
          pendingSelectReplaceRef.current = null;
          const clickedClip = clips.find((c) => c.id === hit.clipId);
          if (clickedClip) {
            suggestChatReference({
              type: "timeline_clip",
              label: clickedClip.label || `${clickedClip.trackType} clip`,
              clipId: clickedClip.id,
              trackType: clickedClip.trackType,
              trackIndex: clickedClip.trackIndex,
              startTime: clickedClip.startTime,
              endTime: clickedClip.endTime,
              mediaUrl: clickedClip.mediaUrl || null,
            });
          }
        }

        // Only start move drag if clip's track is editable.
        const moveClip = clips.find(c => c.id === hit.clipId);
        const moveTrackKey = moveClip ? `${moveClip.trackType}-${moveClip.trackIndex}` : null;
        const moveTrack = moveTrackKey ? state.tracks.find(t => t.key === moveTrackKey) : null;
        if (!moveTrack?.locked && moveTrack?.visible !== false) {
          const linkedSceneOriginals = new Map<string, { startTime: number; trackIndex: number }>();
          for (const sceneId of nextSceneSelection) {
            const scene = scenes.find((s) => s.id === sceneId);
            if (!scene) continue;
            const sceneIndex = scenes.indexOf(scene);
            const startTime = getSceneStart(scene, scenes, sceneIndex);
            linkedSceneOriginals.set(sceneId, {
              startTime,
              trackIndex: scene.trackIndex || 1,
            });
          }
          clipDragLinkedSceneOriginalsRef.current = linkedSceneOriginals;
          dragRef.current = startDrag("move", hit.clipId, nextSelection, state, getWorldX(pos.x), pos.y);
        }
        break;
      }

      case "resize-left":
      case "resize-right": {
        // Scene resize — grabs the left/right edge of a scene strip.
        if (hit.sceneId) {
          const sc = scenes.find((s) => s.id === hit.sceneId);
          if (sc) {
            const sIdx = scenes.indexOf(sc);
            const origStart = getSceneStart(sc, scenes, sIdx);
            const bounds = getSceneResizeBounds(sc, origStart);
            // The MEASURED media duration is the source of truth for how long
            // the scene can get — shot breakdowns get rewritten by retimes, so
            // shot-sum-based bounds can be poisoned by a previous over-stretch.
            const measured = sourceDurations.get(sc.id);
            const measuredMax = measured && measured > 0
              ? Math.max(0.5, measured - getSceneTrimStart(sc))
              : Number.POSITIVE_INFINITY;
            // Measured media length OVERRIDES the shot-sum bound when known —
            // taking the min let a shot-retime-poisoned bound (e.g. a scene
            // shrunk to 0.5s) pin the clamp forever, making re-expansion
            // impossible.
            const contentMax = Number.isFinite(measuredMax) ? measuredMax : bounds.maxDuration;
            // Left edge can never expand into the previous same-track video.
            const prevEnd = getPreviousSameTrackEnd(
              scenes, clips, sc.id, origStart, sc.trackIndex || 1,
              (other) => getSceneStart(other, scenes, scenes.indexOf(other)),
              getSceneDuration,
            );
            // Snap targets: every OTHER scene's start/end, every clip edge,
            // and time 0 — so resizing one track lines up exactly with another.
            const resizeSnapTimes: number[] = [];
            if (snapEnabled) {
              resizeSnapTimes.push(0);
              for (let si = 0; si < scenes.length; si++) {
                const other = scenes[si];
                if (other.id === sc.id) continue;
                const os = getSceneStart(other, scenes, si);
                resizeSnapTimes.push(os, os + getSceneDuration(other));
              }
              for (const cl of clips) {
                resizeSnapTimes.push(cl.startTime, cl.endTime);
              }
              resizeSnapTimes.push(...snapBeatTimes({ snapToBeats: storeApi.getState().snapToBeats, clips }));
            }
            sceneResizeDragRef.current = {
              sceneId: hit.sceneId,
              edge: hit.type === "resize-left" ? "left" : "right",
              origStart,
              origDuration: getSceneDuration(sc),
              maxDuration: contentMax,
              minStart: Math.max(bounds.minStart, prevEnd),
              snapTimes: resizeSnapTimes,
              startX: getWorldX(pos.x),
              currentX: getWorldX(pos.x),
              armed: false,
            };
            onSelectScene(hit.sceneId);
          }
          break;
        }
        if (!hit.clipId) break;
        // Only allow resize if clip's track is editable.
        const resizeClip = clips.find(c => c.id === hit.clipId);
        const resizeTrackKey = resizeClip ? `${resizeClip.trackType}-${resizeClip.trackIndex}` : null;
        const resizeTrack = resizeTrackKey ? state.tracks.find(t => t.key === resizeTrackKey) : null;
        if (resizeTrack?.locked || resizeTrack?.visible === false) break;
        setSelectedClipIds(new Set([hit.clipId]));
        dragRef.current = startDrag(
          hit.type === "resize-left" ? "resize-left" : "resize-right",
          hit.clipId, new Set([hit.clipId]), state, getWorldX(pos.x), pos.y
        );
        break;
      }

      case "music": {
        // Don't seek — seeking triggers selectScene which clears selectedAudioTarget
        onSelectMusic();
        break;
      }

      case "voiceover": {
        if (hit.sceneId) {
          // If unlocked, start drag
          if (unlockedVoiceovers.has(hit.sceneId)) {
            voDragRef.current = {
              sceneId: hit.sceneId,
              startX: pos.x + state.scrollLeft,
              origOffset: voiceoverOffsetsRef.current.get(hit.sceneId) || 0,
            };
          }
          onSelectVoiceover(hit.sceneId);
        }
        break;
      }

      case "voiceover-lock": {
        if (hit.sceneId) {
          setUnlockedVoiceovers((prev) => {
            const next = new Set(prev);
            if (next.has(hit.sceneId!)) {
              next.delete(hit.sceneId!);
            } else {
              next.add(hit.sceneId!);
            }
            return next;
          });
        }
        break;
      }

      case "track-empty": {
        // Start rubber-band marquee. Hold Shift/Cmd/Ctrl to add, or Alt/Option
        // to subtract from the current selection; plain marquee replaces it.
        const mode: MarqueeSelectionMode = e.altKey
          ? "subtract"
          : e.shiftKey || e.ctrlKey || e.metaKey
            ? "add"
            : "replace";
        marqueeRef.current = {
          startX: pos.x, startY: pos.y, currentX: pos.x, currentY: pos.y,
          mode,
          baseSelection: mode === "replace" ? new Set() : new Set(selectedClipIds),
          baseSceneSelection: mode === "replace" ? new Set() : new Set(selectedSceneIds),
        };
        if (mode === "replace") setSelectedClipIds(new Set());
        if (mode === "replace") setSelectedSceneIds(new Set());
        break;
      }
    }

    needsRenderRef.current = true;

    wakeRenderLoopRef.current?.();
  }, [buildState, clearTransitionSelection, getCanvasPos, getWorldX, clips, scenes, selectedClipIds, selectedSceneId, selectedSceneIds, selectedShot, selectedTransition, selectTransition, setSelectedClipIds, onSelectScene, onSeek, onSelectMusic, onSelectVoiceover, setShuttleSpeed, sourceDurations, unlockedVoiceovers, toolMode, onSplitClip, onSplitClipsAtTime, onConvertSceneToSourceVideo, startPanDrag]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = getCanvasPos(e);
    lastPointerPosRef.current = pos;
    if (updatePanDrag(e.clientX, e.clientY)) return;
    if (keyframes.isDragging()) return;

    const drag = dragRef.current;

    if (playheadRippleDragRef.current) {
      maybeAutoScrollX(e.clientX);
      const worldX = getWorldX(pos.x);
      playheadRippleDragRef.current.currentWorldX = Math.max(0, worldX);
      if (!playheadRippleDragRef.current.armed) {
        if (Math.abs(worldX - playheadRippleDragRef.current.startWorldX) > 3) {
          playheadRippleDragRef.current.armed = true;
        }
      }
      if (playheadRippleDragRef.current.armed) {
        const time = playheadRippleDragRef.current.currentWorldX / buildState().zoom;
        scheduleScrubSeek(Math.max(0, time));
      }
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // Marquee (rubber-band) selection — recompute hit clips on every move so
    // the highlighted set updates live as the user drags.
    if (marqueeRef.current) {
      marqueeRef.current.currentX = pos.x;
      marqueeRef.current.currentY = pos.y;
      const m = marqueeRef.current;
      const x0 = Math.min(m.startX, m.currentX);
      const x1 = Math.max(m.startX, m.currentX);
      const y0 = Math.min(m.startY, m.currentY);
      const y1 = Math.max(m.startY, m.currentY);

      const state = buildState();
      const hitIds = computeMarqueeHitClipIds({
        clips,
        tracks: state.tracks,
        rect: { x0, x1, y0, y1 },
        scrollLeft: state.scrollLeft,
        zoom: state.zoom,
        rulerHeight: RULER_HEIGHT,
      });
      const nextSelection = computeMarqueeSelection({
        baseSelection: m.baseSelection,
        hitClipIds: hitIds,
        mode: m.mode,
      });
      // Scene strips the box touches join the selection too (phase 10c).
      const hitSceneIds = computeMarqueeHitSceneIds({
        scenes: scenes.map((scene, index) => {
          const start = getSceneStart(scene, scenes, index);
          return { id: scene.id, trackIndex: scene.trackIndex || 1, start, end: start + getSceneDuration(scene) };
        }),
        tracks: state.tracks,
        rect: { x0, x1, y0, y1 },
        scrollLeft: state.scrollLeft,
        zoom: state.zoom,
        rulerHeight: RULER_HEIGHT,
      });
      marqueePreviewSceneSelectionRef.current = computeMarqueeSelection({ baseSelection: m.baseSceneSelection, hitClipIds: hitSceneIds, mode: m.mode });
      updateMarqueePreview({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, nextSelection);
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // Ruler marker drag — move the flag live.
    if (markerDragRef.current) {
      const md = markerDragRef.current;
      const worldX = getWorldX(pos.x);
      if (!md.moved && Math.abs(worldX - md.startX) > 3) md.moved = true;
      if (md.moved) {
        storeApi.getState().moveTimelineMarker(md.markerId, Math.max(0, worldX / zoom));
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
      }
      return;
    }

    // Scene edge-resize drag.
    if (sceneResizeDragRef.current) {
      maybeAutoScrollX(e.clientX);
      sceneResizeDragRef.current.currentX = getWorldX(pos.x);
      if (!sceneResizeDragRef.current.armed) {
        if (Math.abs(sceneResizeDragRef.current.currentX - sceneResizeDragRef.current.startX) > 3) {
          sceneResizeDragRef.current.armed = true;
        }
      }
      const canvas = canvasRef.current;
      if (canvas && canvas.style.cursor !== "col-resize") canvas.style.cursor = "col-resize";
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // Shot-level drag — takes priority over scene drag once primed.
    if (shotDragRef.current) {
      maybeAutoScrollX(e.clientX);
      shotDragRef.current.currentX = pos.x;
      shotDragRef.current.currentY = pos.y;
      if (!shotDragRef.current.armed) {
        const dx = pos.x - shotDragRef.current.startX;
        const dy = pos.y - shotDragRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) shotDragRef.current.armed = true;
      }
      const canvas = canvasRef.current;
      if (canvas && canvas.style.cursor !== "grabbing") canvas.style.cursor = "grabbing";
      // Always re-render so the ghost tracks the cursor even during the 3px dead-zone.
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // Scene timeline drag — pick up the scene; ghost follows cursor.
    // Threshold 3 px so plain clicks stay as pure selection.
    if (sceneTimeDragRef.current) {
      maybeAutoScrollX(e.clientX);
      sceneTimeDragRef.current.currentX = getWorldX(pos.x);
      sceneTimeDragRef.current.currentY = pos.y;
      if (!sceneTimeDragRef.current.armed) {
        const dx = sceneTimeDragRef.current.currentX - sceneTimeDragRef.current.startX;
        const dy = pos.y - sceneTimeDragRef.current.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) sceneTimeDragRef.current.armed = true;
      }
      if (sceneTimeDragRef.current.armed) {
        const canvas = canvasRef.current;
        if (canvas && canvas.style.cursor !== "grabbing") canvas.style.cursor = "grabbing";
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
    }

    // Voiceover drag (unlocked block repositioning)
    if (voDragRef.current) {
      const state = getDragBuildState();
      const worldX = pos.x + state.scrollLeft;
      const deltaTime = (worldX - voDragRef.current.startX) / state.zoom;
      const newOffset = voDragRef.current.origOffset + deltaTime;
      updateVoiceoverOffset(voDragRef.current.sceneId, newOffset);
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "grabbing";
      return;
    }

    if (drag.mode !== "idle") {
      if (drag.mode === "ruler-scrub") {
        // Ruler scrub — seek as we move
        const state = getDragBuildState();
        const worldX = pos.x + state.scrollLeft;
        const time = Math.max(0, Math.min(state.totalDuration, worldX / state.zoom));
        scheduleScrubSeek(time);
        dragRef.current = { ...drag, currentX: pos.x, currentY: pos.y };
      } else {
        // Clip drag/resize — update drag state
        maybeAutoScrollX(e.clientX);
        const state = getDragBuildState();
        dragRef.current = updateDrag(drag, getWorldX(pos.x), pos.y, state);
      }
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // Hover detection for cursor. Reuse the most recently rendered state
    // (only the scroll offset can have changed cheaply) to avoid rebuilding the
    // full CanvasState on every idle mousemove.
    let state = lastBuiltStateRef.current;
    if (state) {
      if (state.scrollLeft !== scrollLeftRef.current) {
        state = { ...state, scrollLeft: scrollLeftRef.current };
      }
    } else {
      state = buildState();
    }
    const hit = hitDetect(pos.x, pos.y, state);
    const newHovered = hit?.clipId || null;
    if (newHovered !== hoveredClipRef.current) {
      hoveredClipRef.current = newHovered;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    }

    // Blade mode — update preview line position
    if (toolMode === "blade") {
      const worldX = pos.x + state.scrollLeft;
      bladeXRef.current = worldX;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    } else if (bladeXRef.current !== null) {
      bladeXRef.current = null;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    }

    // Update cursor — show grab cursor for unlocked voiceover blocks
    const canvas = canvasRef.current;
    if (canvas) {
      if (hit?.type === "voiceover" && hit.sceneId && unlockedVoiceovers.has(hit.sceneId)) {
        canvas.style.cursor = "grab";
      } else {
        canvas.style.cursor = getCursorForHit(hit, false, toolMode);
      }
    }
  }, [buildState, getCanvasPos, getDragBuildState, getWorldX, maybeAutoScrollX, scheduleScrubSeek, unlockedVoiceovers, toolMode, updateMarqueePreview, updatePanDrag, updateVoiceoverOffset]);

  const linkedSceneClipCommits = useCallback((sd: NonNullable<typeof sceneTimeDragRef.current>, deltaSeconds: number, state: CanvasState): ClipCommit[] => {
    if (sd.linkedClipOriginals.size === 0 || Math.abs(deltaSeconds) <= 0.001) return [];
    const commits: ClipCommit[] = [];
    for (const [clipId, orig] of sd.linkedClipOriginals) {
      const track = state.tracks.find((t) => t.type === orig.trackType && t.index === orig.trackIndex);
      if (track?.locked || track?.visible === false) continue;
      const duration = orig.endTime - orig.startTime;
      const startTime = Math.max(0, orig.startTime + deltaSeconds);
      commits.push({
        clipId,
        startTime,
        endTime: startTime + duration,
      });
    }
    return commits;
  }, []);

  const commitLinkedScenes = useCallback((sd: NonNullable<typeof sceneTimeDragRef.current>, deltaSeconds: number) => {
    if (!onMoveSceneTime || sd.linkedSceneOriginals.size <= 1 || Math.abs(deltaSeconds) <= 0.001) return;
    for (const [sceneId, orig] of sd.linkedSceneOriginals) {
      if (sceneId === sd.sceneId) continue;
      onMoveSceneTime(sceneId, Math.max(0, orig.startTime + deltaSeconds), orig.trackIndex);
    }
  }, [onMoveSceneTime]);

  // Single resolveMove call for the scene-drag commit path — same math the
  // buildState preview used, so what the user saw while dragging is exactly
  // what gets committed.
  const getSceneDragChanges = useCallback((sd: NonNullable<typeof sceneTimeDragRef.current>, state: CanvasState, currentWorldX = sd.currentX, targetTrackIndex?: number) => {
    const requestedDeltaSeconds = (currentWorldX - sd.startX) / state.zoom;
    const clampedDeltaSeconds = constrainBackwardDelta(
      requestedDeltaSeconds,
      [
        ...[...sd.linkedSceneOriginals.values()].map((orig) => orig.startTime),
        ...[...sd.linkedClipOriginals.values()].map((orig) => orig.startTime),
      ],
      0,
    );
    const engineItems = scenesToEngineItems(scenes);
    const targetTrackId = targetTrackIndex != null ? `v${targetTrackIndex}` : undefined;
    // targetTrackId (from vertical drag position) only ever applies to the
    // primary scene the user grabbed — other multi-selected scenes keep their
    // own tracks. sd.sceneId is that primary/anchor scene.
    return resolveMove(engineItems, [...sd.linkedSceneOriginals.keys()], clampedDeltaSeconds, targetTrackId, sd.sceneId);
  }, [scenes]);

  const getClipDragDelta = useCallback((drag: NonNullable<typeof dragRef.current>, state: CanvasState) => {
    return getMoveDragDelta(
      drag,
      state,
      [...clipDragLinkedSceneOriginalsRef.current.values()].map((orig) => orig.startTime),
    );
  }, []);

  const buildRippleRightUpdates = useCallback((
    groupEnd: number,
    deltaSeconds: number,
    sceneOriginals: Map<string, { startTime: number; trackIndex: number }>,
    clipOriginals: Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>,
  ) => {
    if (deltaSeconds <= 0.001) return [];
    const { rippleScenes, pushDelta } = collectRippleRight(groupEnd, deltaSeconds, sceneOriginals, clipOriginals);
    return [...rippleScenes].map(([sceneId, orig]) => ({
      sceneId,
      startTime: orig.startTime + pushDelta,
      trackIndex: orig.trackIndex,
    }));
  }, [collectRippleRight]);

  // Scene moves and the clips the same gesture moves: one command (one undo step) when the host takes both (phase 10c).
  const commitExactSceneUpdates = useCallback((updates: { sceneId: string; startTime: number; trackIndex?: number }[], clipCommits: ClipCommit[] = []) => {
    if (updates.length === 0) {
      if (clipCommits.length > 0) onUpdateClips(clipCommits);
      return;
    }
    if (onMoveSceneTimes) {
      const byId = new Map<string, { sceneId: string; startTime: number; trackIndex?: number }>();
      for (const update of updates) byId.set(update.sceneId, update);
      onMoveSceneTimes([...byId.values()], clipCommits);
      return;
    }
    for (const update of updates) {
      onMoveSceneTime?.(update.sceneId, update.startTime, update.trackIndex);
    }
    if (clipCommits.length > 0) onUpdateClips(clipCommits);
  }, [onMoveSceneTime, onMoveSceneTimes, onUpdateClips]);

  const rippleRightClipCommits = useCallback((
    groupEnd: number,
    deltaSeconds: number,
    sceneOriginals: Map<string, { startTime: number; trackIndex: number }>,
    clipOriginals: Map<string, { startTime: number; endTime: number; trackType: string; trackIndex: number }>,
    state: CanvasState,
  ): ClipCommit[] => {
    if (deltaSeconds <= 0.001) return [];
    const { rippleClips, pushDelta } = collectRippleRight(groupEnd, deltaSeconds, sceneOriginals, clipOriginals);
    const commits: ClipCommit[] = [];
    for (const [clipId, orig] of rippleClips) {
      const track = state.tracks.find((t) => t.type === orig.trackType && t.index === orig.trackIndex);
      if (track?.locked || track?.visible === false) continue;
      const duration = orig.endTime - orig.startTime;
      const startTime = orig.startTime + pushDelta;
      commits.push({ clipId, startTime, endTime: startTime + duration });
    }
    return commits;
  }, [collectRippleRight]);

  const commitPlayheadRipple = useCallback((pd: NonNullable<typeof playheadRippleDragRef.current>, state: CanvasState) => {
    if (!pd.armed) {
      onSeek(pd.startTime);
      return;
    }
    const signedDeltaSeconds = (pd.currentWorldX - pd.startWorldX) / state.zoom;
    const deltaSeconds = constrainBackwardDelta(
      signedDeltaSeconds,
      [
        ...[...pd.sceneOriginals.values()].map((orig) => orig.startTime),
        ...[...pd.clipOriginals.values()].map((orig) => orig.startTime),
      ],
      pd.startTime,
    );
    if (Math.abs(deltaSeconds) <= 0.001) return;
    commitExactSceneUpdates([...pd.sceneOriginals].map(([sceneId, orig]) => ({
      sceneId,
      startTime: orig.startTime + deltaSeconds,
      trackIndex: orig.trackIndex,
    })));
    const commits: ClipCommit[] = [];
    for (const [clipId, orig] of pd.clipOriginals) {
      const track = state.tracks.find((t) => t.type === orig.trackType && t.index === orig.trackIndex);
      if (track?.locked || track?.visible === false) continue;
      const duration = orig.endTime - orig.startTime;
      const startTime = orig.startTime + deltaSeconds;
      commits.push({ clipId, startTime, endTime: startTime + duration });
    }
    if (commits.length > 0) onUpdateClips(commits);
  }, [commitExactSceneUpdates, onSeek, onUpdateClips]);

  const handleMouseUp = useCallback(() => {
    if (markerDragRef.current) {
      const md = markerDragRef.current;
      markerDragRef.current = null;
      if (!md.moved) {
        // Plain click on the flag: make it the ACTIVE selection (so Delete
        // removes the marker, not the selected scene). No seek — jumping the
        // playhead on select made the timeline "move" under the user; use the
        // split/snap-to-marker tools to jump intentionally.
        storeApi.getState().setSelectedMarkerId(md.markerId);
      }
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    if (panDragRef.current) {
      panDragRef.current = null;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "default";
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    if (playheadRippleDragRef.current) {
      const pd = playheadRippleDragRef.current;
      playheadRippleDragRef.current = null;
      commitPlayheadRipple(pd, buildState());
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // End marquee — selection was already updated live on mousemove. Just
    // tear down the box.
    if (marqueeRef.current) {
      marqueeRef.current = null;
      const marqueeClips = marqueePreviewSelectionRef.current;
      const marqueeScenes = marqueePreviewSceneSelectionRef.current;
      marqueePreviewSceneSelectionRef.current = null;
      if (marqueeClips || marqueeScenes) {
        storeApi.getState().setSelection({ clipIds: marqueeClips ?? selectedClipIds, sceneIds: marqueeScenes ?? selectedSceneIds });
      }
      updateMarqueePreview(null, null);
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // End scene-edge resize — compute new start + duration and commit.
    if (sceneResizeDragRef.current) {
      const rd = sceneResizeDragRef.current;
      sceneResizeDragRef.current = null;
      if (rd.armed && onUpdateSceneDuration) {
        const state = buildState();
        const resizePreview = getSceneResizePreview(rd, state.zoom);
        const newStart = resizePreview.newStart;
        const newDur = resizePreview.newDuration;
        // Clamped no-op drag (e.g. stretching past the real footage): nothing
        // to save, and holding a pending override would freeze the size badge
        // on screen until the 15s failsafe.
        if (Math.abs(newStart - rd.origStart) < 0.01 && Math.abs(newDur - rd.origDuration) < 0.01) {
          const canvas = canvasRef.current;
          if (canvas) canvas.style.cursor = "default";
          needsRenderRef.current = true;
          wakeRenderLoopRef.current?.();
          return;
        }
        // Hold the committed override visible until the server reply updates scenes.
        const committedResize = { sceneId: rd.sceneId, newStart, newDuration: newDur };
        pendingResizeRef.current = committedResize;
        // Failsafe: a failed or hung save must never freeze the preview — drop
        // the override after 15s if the server data still hasn't matched it.
        window.setTimeout(() => {
          if (pendingResizeRef.current === committedResize) {
            pendingResizeRef.current = null;
            needsRenderRef.current = true;
            wakeRenderLoopRef.current?.();
          }
        }, 15000);
        onUpdateSceneDuration(rd.sceneId, newStart, newDur);
      }
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "default";
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // End shot drag — either reorder within source scene or extract to a new scene.
    if (shotDragRef.current) {
      const sd = shotDragRef.current;
      shotDragRef.current = null;
      if (sd.armed) {
        const state = buildState();
        const cursorWorldX = sd.currentX + state.scrollLeft;
        const dropTime = cursorWorldX / state.zoom;
        const cursorY = sd.currentY - RULER_HEIGHT;
        // Determine which video track the cursor is over at release.
        let dropTrackIdx: number | undefined;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const t of state.tracks) {
          if (t.type !== "video" || t.visible === false) continue;
          const centerY = t.y + t.height / 2;
          const d = Math.abs(centerY - cursorY);
          if (d < bestDist) {
            bestDist = d;
            dropTrackIdx = t.index;
          }
        }
        const sourceScene = scenes.find((s) => s.id === sd.sceneId);
        if (sourceScene) {
          const sourceIdx = scenes.indexOf(sourceScene);
          const sourceStart = getSceneStart(sourceScene, scenes, sourceIdx);
          const sourceTrack = sourceScene.trackIndex || 1;
          // Find the scene under the cursor by full spatial overlap (X and Y),
          // not just "nearest track". If the cursor is precisely on top of a
          // scene strip, that scene wins even if the nearest-track snap would
          // have picked a different row.
          const getStart = (s: SceneData, i: number) => getSceneStart(s, scenes, i);
          const cursorLocalY = sd.currentY - RULER_HEIGHT;
          let hoverScene: SceneData | null = null;
          let hoverStart = 0;
          for (let i = 0; i < scenes.length; i++) {
            const s = scenes[i];
            const sTrack = s.trackIndex || 1;
            const vt = state.tracks.find((t) => t.type === "video" && t.index === sTrack);
            if (!vt || vt.visible === false) continue;
            const st = getStart(s, i);
            const en = st + getSceneDuration(s);
            const trackTop = vt.y;
            const trackBottom = vt.y + vt.height;
            if (
              dropTime >= st &&
              dropTime < en &&
              cursorLocalY >= trackTop &&
              cursorLocalY < trackBottom
            ) {
              hoverScene = s;
              hoverStart = st;
              break;
            }
          }

          if (hoverScene && hoverScene.id === sourceScene.id && onReorderShots) {
            // Dropped inside the SAME scene → reorder shots.
            const insertIdx = shotInsertIndexForScene(sourceScene, sourceStart, dropTime);
            // Translate gap-index to move-destination. When moving forward past
            // the removed slot, the target decreases by 1 after splice.
            let destIdx = insertIdx;
            if (destIdx > sd.shotIndex) destIdx -= 1;
            if (destIdx !== sd.shotIndex) {
              const shots = parseCachedShotBreakdown(sourceScene.shotBreakdown);
              if (shots.length > 0) {
                const newOrder = shots.map((_, i) => i);
                const [moved] = newOrder.splice(sd.shotIndex, 1);
                newOrder.splice(destIdx, 0, moved);
                onReorderShots(sd.sceneId, newOrder);
              }
            }
          } else if (hoverScene && hoverScene.id !== sourceScene.id && onMergeShot) {
            // Dropped on a DIFFERENT scene → merge the shot into that scene.
            const targetShotIdx = shotInsertIndexForScene(hoverScene, hoverStart, dropTime);
            onMergeShot(sd.sceneId, sd.shotIndex, hoverScene.id, targetShotIdx);
          } else if (onExtractShot) {
            // Dropped in empty space → extract to a new standalone scene.
            onExtractShot(
              sd.sceneId,
              sd.shotIndex,
              Math.max(0, dropTime),
              dropTrackIdx ?? sourceTrack,
            );
          }
        }
        // Drag committed — drop the shot selection so the yellow outline
        // disappears and the user can immediately start a fresh interaction.
        setSelectedShot(null);
      }
      // If !armed, keep selectedShot as-is (user may want to drag again).
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "default";
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // End scene timeline drag — commit new start and (if cursor moved to a
    // different video track) new track index.
    if (sceneTimeDragRef.current) {
      const sd = sceneTimeDragRef.current;
      sceneTimeDragRef.current = null;
      sceneDragPreviewLerpRef.current.clear();
      if (sd.armed && onMoveSceneTime) {
        const state = buildState();
        // Determine drop track: pick the visible video track whose center Y is
        // closest to the cursor Y. Cursor Y is in canvas-local coords; track.y is
        // relative to the ruler.
        const cursorY = sd.currentY - RULER_HEIGHT;
        const bestTrackIdx = findBestTrackIdx(state.tracks, cursorY);
        const changes = getSceneDragChanges(sd, state, sd.currentX, bestTrackIdx);
        const primaryChange = changes.get(sd.sceneId);
        const dxSeconds = primaryChange ? primaryChange.start - sd.origStart : 0;
        const sceneUpdates = [...changes].map(([sceneId, change]) => ({
          sceneId,
          startTime: change.start,
          trackIndex: Number(change.trackId.slice(1)),
        }));
        commitExactSceneUpdates(sceneUpdates, [
          ...linkedSceneClipCommits(sd, dxSeconds, state),
          ...rippleRightClipCommits(getGroupEnd(sd.linkedSceneOriginals, sd.linkedClipOriginals), dxSeconds, sd.linkedSceneOriginals, sd.linkedClipOriginals, state),
        ]);
      } else if (!sd.didSelectSceneOnMouseDown) {
        onSelectScene(sd.sceneId);
      }
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "default";
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    // End voiceover drag
    if (voDragRef.current) {
      voDragRef.current = null;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    const drag = dragRef.current;
    if (drag.mode === "idle") return;

    if (drag.mode === "ruler-scrub") {
      dragRef.current = createIdleDrag();
      clipDragLinkedSceneOriginalsRef.current = new Map();
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      return;
    }

    if (drag.committed) {
      const state = buildState();
      const commits = endDrag(drag, state);
      if (drag.mode === "move") {
        // The clips, the scenes selected with them, and what they push right: one command (phase 10c).
        const deltaSeconds = getClipDragDelta(drag, state);
        commitExactSceneUpdates([
          ...[...clipDragLinkedSceneOriginalsRef.current].map(([sceneId, orig]) => ({
            sceneId,
            startTime: Math.max(0, orig.startTime + deltaSeconds),
            trackIndex: orig.trackIndex,
          })),
          ...buildRippleRightUpdates(
            getGroupEnd(clipDragLinkedSceneOriginalsRef.current, drag.originals),
            deltaSeconds,
            clipDragLinkedSceneOriginalsRef.current,
            drag.originals,
          ),
        ], [
          ...commits,
          ...rippleRightClipCommits(getGroupEnd(clipDragLinkedSceneOriginalsRef.current, drag.originals), deltaSeconds, clipDragLinkedSceneOriginalsRef.current, drag.originals, state),
        ]);
      } else if (commits.length > 0) {
        onUpdateClips(commits);
      }
      // A real drag happened — keep the multi-selection.
      pendingSelectReplaceRef.current = null;
    } else if (pendingSelectReplaceRef.current) {
      // Mouse-down was on an already-multi-selected clip and no drag committed:
      // treat as a click and shrink the selection to just that clip now.
      setSelectedClipIds(new Set([pendingSelectReplaceRef.current]));
      pendingSelectReplaceRef.current = null;
    }

    dragRef.current = createIdleDrag();
    clipDragLinkedSceneOriginalsRef.current = new Map();
    needsRenderRef.current = true;
    wakeRenderLoopRef.current?.();
  }, [buildRippleRightUpdates, buildState, commitExactSceneUpdates, linkedSceneClipCommits, commitLinkedScenes, commitPlayheadRipple, rippleRightClipCommits, getClipDragDelta, getGroupEnd, getSceneDragChanges, onMoveSceneTime, onSelectScene, onUpdateClips, setSelectedClipIds, updateMarqueePreview]);

  const scheduleTimelineWheelScroll = useCallback((scrollParent: HTMLElement, delta: number) => {
    pendingTimelineWheelScrollParentRef.current = scrollParent;
    pendingTimelineWheelDeltaRef.current += delta;
    if (timelineWheelFrameRef.current !== null) return;

    timelineWheelFrameRef.current = requestAnimationFrame(() => {
      timelineWheelFrameRef.current = null;
      const scrollParent = pendingTimelineWheelScrollParentRef.current;
      const nextDelta = pendingTimelineWheelDeltaRef.current;
      pendingTimelineWheelScrollParentRef.current = null;
      pendingTimelineWheelDeltaRef.current = 0;
      if (!scrollParent || nextDelta === 0) return;

      scrollParent.scrollTo({
        left: Math.max(0, scrollParent.scrollLeft + nextDelta),
        top: scrollParent.scrollTop,
      });
      scrollLeftRef.current = scrollParent.scrollLeft;
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    });
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    const scrollParent = getScrollParent();
    if (!scrollParent || e.ctrlKey || e.metaKey) return;

    const horizontalIntent = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY); // i18n-ignore
    const canScrollVertically = scrollParent.scrollHeight > scrollParent.clientHeight + 1;
    if (!horizontalIntent && canScrollVertically) return;

    e.preventDefault();
    const delta = horizontalIntent
      ? e.deltaX + (e.shiftKey ? e.deltaY : 0)
      : e.deltaY;
    scheduleTimelineWheelScroll(scrollParent, delta);
  }, [scheduleTimelineWheelScroll]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheelEvent = (e: WheelEvent) => handleWheel(e);
    canvas.addEventListener("wheel", handleWheelEvent, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheelEvent);
    };
  }, [handleWheel]);

  // Keyboard: Delete / Backspace removes selected scene items; clip deletion is
  // handled by the editor-level shortcut handler to avoid duplicate mutations.
  // Cmd/Ctrl+C / +V copy-paste SCENE strips (clips have their own clipboard in
  // the editor-level handler — scene strips aren't timeline clips, so without
  // this the shortcuts silently do nothing on them).
  useEffect(() => {
    if (!shortcutsEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      // Another handler (e.g. the editor-level marker delete) already consumed
      // this keypress; acting again here deletes a second thing.
      if (e.defaultPrevented) return;
      // Ignore when typing in an input/textarea/contenteditable.
      const tgtEl = e.target as HTMLElement | null;
      if (tgtEl && (tgtEl.tagName === "INPUT" || tgtEl.tagName === "TEXTAREA" || tgtEl.isContentEditable)) return;
      // A real text selection on the page means the user is copying text, not
      // scene strips — let the browser's native Cmd/Ctrl+C through.
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
      }
      if ((e.key === "c" || e.key === "C") && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const ids = selectedSceneIds.size > 0
          ? [...selectedSceneIds]
          : selectedSceneId ? [selectedSceneId] : [];
        if (ids.length > 0) {
          e.preventDefault();
          sceneClipboardRef.current = ids;
          return;
        }
      }
      if ((e.key === "v" || e.key === "V") && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const copied = sceneClipboardRef.current.filter((id) => scenes.some((s) => s.id === id));
        if (copied.length > 0 && onDuplicateScene) {
          e.preventDefault();
          for (const id of copied) onDuplicateScene(id);
          return;
        }
      }
      if (!shouldCanvasHandleTimelineDelete(e)) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      // A selected transition deletes first (clears the clip's or scene's junction transition).
      if (selectedTransition) {
        e.preventDefault();
        if (selectedTransition.kind === "scene") {
          if (!getEditableCanvasSceneTransitionTarget(scenes, rawTracks, selectedTransition.id)) {
            clearTransitionSelection();
            return;
          }
          onSetSceneTransition?.(selectedTransition.id, "none", 0);
        } else {
          // transition.set (phase 10b): one undoable command that also clears fades an old preset wrote.
          void timelineController.execute({ type: "transition.set", clipId: selectedTransition.id, transition: "none" });
        }
        clearTransitionSelection();
        return;
      }
      // An actively-selected marker owns the Delete key — otherwise deleting a
      // clicked marker nuked the selected SCENE instead.
      const activeMarkerId = storeApi.getState().selectedMarkerId;
      if (activeMarkerId) {
        e.preventDefault();
        storeApi.getState().removeTimelineMarker(activeMarkerId);
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
      // Several items with scenes among them: one items.delete (one undo step; phase 10c).
      if (isMixedSelection(storeApi.getState())) {
        e.preventDefault();
        void deleteSelectedItems(timelineController, storeApi);
        return;
      }
      if (selectedSceneIds.size > 0 && onDeleteScene) {
        e.preventDefault();
        const editableSceneIds = [...selectedSceneIds].filter((sceneId) => (
          isEditableCanvasSceneTrack(scenes, rawTracks, sceneId)
        ));
        if (editableSceneIds.length === 0) {
          setSelectedSceneIds(new Set());
          return;
        }
        for (const sceneId of editableSceneIds) {
          onDeleteScene(sceneId);
        }
        setSelectedSceneIds(new Set());
        return;
      }
      if (selectedSceneId && onDeleteScene) {
        e.preventDefault();
        if (!isEditableCanvasSceneTrack(scenes, rawTracks, selectedSceneId)) return;
        onDeleteScene(selectedSceneId);
        return;
      }
      if (selectedShot && onDeleteShot) {
        e.preventDefault();
        const shotScene = scenes.find((s) => s.id === selectedShot.sceneId);
        if (!isEditableCanvasSceneTrack(scenes, rawTracks, selectedShot.sceneId) || (shotScene && hasReadOnlyShots(shotScene))) {
          setSelectedShot(null);
          return;
        }
        onDeleteShot(selectedShot.sceneId, selectedShot.shotIndex);
        setSelectedShot(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    onDeleteScene,
    onDuplicateScene,
    onDeleteShot,
    selectedSceneId,
    selectedSceneIds,
    selectedShot,
    setSelectedSceneIds,
    setSelectedShot,
    selectedTransition,
    clearTransitionSelection,
    scenes,
    clips,
    rawTracks,
    onUpdateClips,
    onSetSceneTransition,
    shortcutsEnabled,
  ]);

  // Global mouseup listener (for drags that go outside canvas)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panDragRef.current) {
        panDragRef.current = null;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = "default";
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      if (playheadRippleDragRef.current) {
        const pd = playheadRippleDragRef.current;
        playheadRippleDragRef.current = null;
        commitPlayheadRipple(pd, buildState());
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      // Commit a transition duration drag.
      if (transitionResizeDragRef.current) {
        const trd = transitionResizeDragRef.current;
        transitionResizeDragRef.current = null;
        if (trd.armed) {
          const deltaSec = (trd.currentX - trd.startX) / zoom;
          const durationDelta = (trd.edge === "right" ? 1 : -1) * deltaSec * 2;
          const newDuration = Math.round(
            Math.min(trd.maxDuration, Math.max(0.1, trd.origDuration + durationDelta)) * 10,
          ) / 10;
          if (Math.abs(newDuration - trd.origDuration) > 0.01) {
            if (trd.kind === "scene") {
              onSetSceneTransition?.(trd.id, trd.transitionType, newDuration);
            } else {
              // transition.set: a clip-cut window keeps its type (no legacy preset fades written).
              void timelineController.execute({ type: "transition.set", clipId: trd.id, transition: trd.transitionType, duration: newDuration });
            }
          }
        }
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      // End shot drag on global mouseup (mirrors the in-canvas mouseup path).
      if (shotDragRef.current) {
        const sd = shotDragRef.current;
        shotDragRef.current = null;
        if (sd.armed) {
          const canvas = canvasRef.current;
          const rect = canvas?.getBoundingClientRect();
          const posX = rect ? e.clientX - rect.left : sd.currentX;
          const posY = rect ? e.clientY - rect.top : sd.currentY;
          const state = buildState();
          const cursorWorldX = posX + state.scrollLeft;
          const dropTime = cursorWorldX / state.zoom;
          const cursorY = posY - RULER_HEIGHT;
          let dropTrackIdx: number | undefined;
          let bestDist = Number.POSITIVE_INFINITY;
          for (const t of state.tracks) {
            if (t.type !== "video" || t.visible === false) continue;
            const centerY = t.y + t.height / 2;
            const d = Math.abs(centerY - cursorY);
            if (d < bestDist) {
              bestDist = d;
              dropTrackIdx = t.index;
            }
          }
          const sourceScene = scenes.find((s) => s.id === sd.sceneId);
          if (sourceScene) {
            const sourceIdx = scenes.indexOf(sourceScene);
            const sourceStart = getSceneStart(sourceScene, scenes, sourceIdx);
            const sourceTrack = sourceScene.trackIndex || 1;
            const getStart = (s: SceneData, i: number) => getSceneStart(s, scenes, i);
            const cursorLocalYg = posY - RULER_HEIGHT;
            let hoverScene: SceneData | null = null;
            let hoverStart = 0;
            for (let i = 0; i < scenes.length; i++) {
              const s = scenes[i];
              const sTrack = s.trackIndex || 1;
              const vt = state.tracks.find((t) => t.type === "video" && t.index === sTrack);
              if (!vt || vt.visible === false) continue;
              const st = getStart(s, i);
              const en = st + getSceneDuration(s);
              const trackTop = vt.y;
              const trackBottom = vt.y + vt.height;
              if (
                dropTime >= st &&
                dropTime < en &&
                cursorLocalYg >= trackTop &&
                cursorLocalYg < trackBottom
              ) {
                hoverScene = s;
                hoverStart = st;
                break;
              }
            }
            if (hoverScene && hoverScene.id === sourceScene.id && onReorderShots) {
              const insertIdx = shotInsertIndexForScene(sourceScene, sourceStart, dropTime);
              let destIdx = insertIdx;
              if (destIdx > sd.shotIndex) destIdx -= 1;
              if (destIdx !== sd.shotIndex) {
                const shots = parseCachedShotBreakdown(sourceScene.shotBreakdown);
                if (shots.length > 0) {
                  const newOrder = shots.map((_, i) => i);
                  const [moved] = newOrder.splice(sd.shotIndex, 1);
                  newOrder.splice(destIdx, 0, moved);
                  onReorderShots(sd.sceneId, newOrder);
                }
              }
            } else if (hoverScene && hoverScene.id !== sourceScene.id && onMergeShot) {
              const targetShotIdx = shotInsertIndexForScene(hoverScene, hoverStart, dropTime);
              onMergeShot(sd.sceneId, sd.shotIndex, hoverScene.id, targetShotIdx);
            } else if (onExtractShot) {
              onExtractShot(
                sd.sceneId,
                sd.shotIndex,
                Math.max(0, dropTime),
                dropTrackIdx ?? sourceTrack,
              );
            }
          }
        }
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = "default";
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
      // End scene-strip drag on global mouseup — commits the drop even if the
      // cursor left the canvas before release. Without this the drag ref stays
      // stuck and the user appears to be frozen holding the scene.
      if (sceneTimeDragRef.current) {
        const sd = sceneTimeDragRef.current;
        sceneTimeDragRef.current = null;
      sceneDragPreviewLerpRef.current.clear();
        if (sd.armed && onMoveSceneTime) {
          const canvas = canvasRef.current;
          const rect = canvas?.getBoundingClientRect();
          const posX = rect ? e.clientX - rect.left : sd.currentX;
          const posY = rect ? e.clientY - rect.top : sd.currentY;
          const state = buildState();
          const cursorY = posY - RULER_HEIGHT;
          const bestTrackIdx = findBestTrackIdx(state.tracks, cursorY);
          const changes = getSceneDragChanges(sd, state, posX + state.scrollLeft, bestTrackIdx);
          const primaryChange = changes.get(sd.sceneId);
          const dxSeconds = primaryChange ? primaryChange.start - sd.origStart : 0;
          const sceneUpdates = [...changes].map(([sceneId, change]) => ({
            sceneId,
            startTime: change.start,
            trackIndex: Number(change.trackId.slice(1)),
          }));
          commitExactSceneUpdates(sceneUpdates, [
            ...linkedSceneClipCommits(sd, dxSeconds, state),
            ...rippleRightClipCommits(getGroupEnd(sd.linkedSceneOriginals, sd.linkedClipOriginals), dxSeconds, sd.linkedSceneOriginals, sd.linkedClipOriginals, state),
          ]);
        } else if (!sd.didSelectSceneOnMouseDown) {
          onSelectScene(sd.sceneId);
        }
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = "default";
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
      // End voiceover drag on global mouseup
      if (voDragRef.current) {
        voDragRef.current = null;
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
      if (dragRef.current.mode !== "idle") {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        if (dragRef.current.mode === "ruler-scrub") {
          dragRef.current = createIdleDrag();
          clipDragLinkedSceneOriginalsRef.current = new Map();
        } else if (dragRef.current.committed) {
          const state = buildState();
          dragRef.current = { ...dragRef.current, currentX: pos.x + state.scrollLeft, currentY: pos.y };
          const commits = endDrag(dragRef.current, state);
          if (dragRef.current.mode === "move") {
            const deltaSeconds = getClipDragDelta(dragRef.current, state);
            commitExactSceneUpdates([
              ...[...clipDragLinkedSceneOriginalsRef.current].map(([sceneId, orig]) => ({
                sceneId,
                startTime: Math.max(0, orig.startTime + deltaSeconds),
                trackIndex: orig.trackIndex,
              })),
              ...buildRippleRightUpdates(
                getGroupEnd(clipDragLinkedSceneOriginalsRef.current, dragRef.current.originals),
                deltaSeconds,
                clipDragLinkedSceneOriginalsRef.current,
                dragRef.current.originals,
              ),
            ], [
              ...commits,
              ...rippleRightClipCommits(getGroupEnd(clipDragLinkedSceneOriginalsRef.current, dragRef.current.originals), deltaSeconds, clipDragLinkedSceneOriginalsRef.current, dragRef.current.originals, state),
            ]);
          } else if (commits.length > 0) {
            onUpdateClips(commits);
          }
          dragRef.current = createIdleDrag();
          clipDragLinkedSceneOriginalsRef.current = new Map();
        } else {
          dragRef.current = createIdleDrag();
          clipDragLinkedSceneOriginalsRef.current = new Map();
        }
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
      }
    };
    window.addEventListener("mouseup", handler);
    return () => window.removeEventListener("mouseup", handler);
  }, [buildRippleRightUpdates, buildState, commitExactSceneUpdates, linkedSceneClipCommits, commitLinkedScenes, commitPlayheadRipple, rippleRightClipCommits, getClipDragDelta, getGroupEnd, getSceneDragChanges, onUpdateClips, onMoveSceneTime, onSelectScene, onSetSceneTransition, onReorderShots, onExtractShot, onMergeShot, scenes, clips, rawTracks, zoom]);

  // Global mousemove for drags outside canvas. Extracted so the edge
  // auto-scroll ticker can replay the last pointer position: holding the
  // cursor still inside the edge zone keeps scrolling AND keeps the drag
  // target following the viewport (mousemove alone stops when the cursor stops).
  useEffect(() => {
    let edgeScrollTicker: number | null = null;
    let lastClient: { x: number; y: number } | null = null;

    const isAnyDragActive = () =>
      dragRef.current.mode !== "idle" ||
      !!sceneTimeDragRef.current ||
      !!shotDragRef.current ||
      !!sceneResizeDragRef.current ||
      !!transitionResizeDragRef.current ||
      !!playheadRippleDragRef.current ||
      !!voDragRef.current;

    const stopTicker = () => {
      if (edgeScrollTicker !== null) {
        clearInterval(edgeScrollTicker);
        edgeScrollTicker = null;
      }
    };

    const ensureTicker = () => {
      if (edgeScrollTicker !== null || !isAnyDragActive()) return;
      edgeScrollTicker = window.setInterval(() => {
        if (!lastClient || !isAnyDragActive()) {
          stopTicker();
          return;
        }
        processPointerDrag(lastClient.x, lastClient.y);
      }, 16);
    };

    const processPointerDrag = (clientX: number, clientY: number) => {
      lastClient = { x: clientX, y: clientY };
      ensureTicker();
      const pointerCanvas = canvasRef.current;
      if (pointerCanvas) {
        const pointerRect = pointerCanvas.getBoundingClientRect();
        lastPointerPosRef.current = { x: clientX - pointerRect.left, y: clientY - pointerRect.top };
      }
      if (updatePanDrag(clientX, clientY)) return;

      if (playheadRippleDragRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        maybeAutoScrollX(clientX);
        const worldX = clientX - rect.left + scrollLeftRef.current;
        playheadRippleDragRef.current.currentWorldX = Math.max(0, worldX);
        if (!playheadRippleDragRef.current.armed) {
          if (Math.abs(worldX - playheadRippleDragRef.current.startWorldX) > 3) {
            playheadRippleDragRef.current.armed = true;
          }
        }
        if (playheadRippleDragRef.current.armed) {
          const time = playheadRippleDragRef.current.currentWorldX / getDragBuildState().zoom;
          scheduleScrubSeek(Math.max(0, time));
        }
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      if (transitionResizeDragRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const trd = transitionResizeDragRef.current;
        trd.currentX = clientX - rect.left + scrollLeftRef.current;
        if (!trd.armed && Math.abs(trd.currentX - trd.startX) > 3) trd.armed = true;
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      if (sceneResizeDragRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const posX = clientX - rect.left;
        maybeAutoScrollX(clientX);
        sceneResizeDragRef.current.currentX = posX + scrollLeftRef.current;
        if (!sceneResizeDragRef.current.armed) {
          if (Math.abs(sceneResizeDragRef.current.currentX - sceneResizeDragRef.current.startX) > 3) {
            sceneResizeDragRef.current.armed = true;
          }
        }
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      if (shotDragRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        maybeAutoScrollX(clientX);
        shotDragRef.current.currentX = clientX - rect.left;
        shotDragRef.current.currentY = clientY - rect.top;
        if (!shotDragRef.current.armed) {
          const dx = shotDragRef.current.currentX - shotDragRef.current.startX;
          const dy = shotDragRef.current.currentY - shotDragRef.current.startY;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) shotDragRef.current.armed = true;
        }
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      if (sceneTimeDragRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const posX = clientX - rect.left;
        const posY = clientY - rect.top;
        maybeAutoScrollX(clientX);
        sceneTimeDragRef.current.currentX = posX + scrollLeftRef.current;
        sceneTimeDragRef.current.currentY = posY;
        if (!sceneTimeDragRef.current.armed) {
          const dx = sceneTimeDragRef.current.currentX - sceneTimeDragRef.current.startX;
          const dy = sceneTimeDragRef.current.currentY - sceneTimeDragRef.current.startY;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) sceneTimeDragRef.current.armed = true;
        }
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }

      // Handle voiceover drag outside canvas
      if (voDragRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const posX = clientX - rect.left;
        const state = getDragBuildState();
        const worldX = posX + state.scrollLeft;
        const deltaTime = (worldX - voDragRef.current.startX) / state.zoom;
        const newOffset = voDragRef.current.origOffset + deltaTime;
        updateVoiceoverOffset(voDragRef.current.sceneId, newOffset);
        needsRenderRef.current = true;
        wakeRenderLoopRef.current?.();
        return;
      }
      if (dragRef.current.mode === "idle") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const pos = { x: clientX - rect.left, y: clientY - rect.top };

      if (dragRef.current.mode === "ruler-scrub") {
        const state = getDragBuildState();
        const worldX = pos.x + state.scrollLeft;
        const time = Math.max(0, Math.min(state.totalDuration, worldX / state.zoom));
        scheduleScrubSeek(time);
        dragRef.current = { ...dragRef.current, currentX: pos.x, currentY: pos.y };
      } else {
        maybeAutoScrollX(clientX);
        const state = getDragBuildState();
        dragRef.current = updateDrag(dragRef.current, pos.x + state.scrollLeft, pos.y, state);
      }
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
    };

    const handler = (e: MouseEvent) => processPointerDrag(e.clientX, e.clientY);
    const stopOnMouseUp = () => {
      stopTicker();
      lastClient = null;
    };
    window.addEventListener("mousemove", handler);
    window.addEventListener("mouseup", stopOnMouseUp);
    return () => {
      stopTicker();
      window.removeEventListener("mousemove", handler);
      window.removeEventListener("mouseup", stopOnMouseUp);
    };
  }, [getDragBuildState, maybeAutoScrollX, scheduleScrubSeek, updatePanDrag, updateVoiceoverOffset]);

  const restoreCursorFromLastPointer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pos = lastPointerPosRef.current;
    if (!pos) {
      canvas.style.cursor = getCursorForHit(null, false, toolMode);
      return;
    }
    const state = buildState();
    const hit = hitDetect(pos.x, pos.y, state);
    if (hit?.type === "voiceover" && hit.sceneId && unlockedVoiceovers.has(hit.sceneId)) {
      canvas.style.cursor = "grab";
      return;
    }
    canvas.style.cursor = getCursorForHit(hit, false, toolMode);
  }, [buildState, toolMode, unlockedVoiceovers]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTimelineTextEditingTarget(e.target)) return;
      if (e.code !== "Space") return;
      spacePressedRef.current = true;
      if (canvasRef.current) canvasRef.current.style.cursor = "grab";
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isTimelineTextEditingTarget(e.target)) return;
      if (e.code !== "Space") return;
      spacePressedRef.current = false;
      restoreCursorFromLastPointer();
    };
    const onBlur = () => {
      spacePressedRef.current = false;
      restoreCursorFromLastPointer();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [restoreCursorFromLastPointer]);

  // Drag & drop from media panel
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const dragKind = getTimelineLibraryDragKind(e.dataTransfer);
    const pos = getCanvasPos(e as any);
    const state = buildState();

    if (dragKind === "effect") {
      const effectPreview = getEffectLayerDropPreview(pos.x, state, pos.y);
      scheduleTimelineDropGhost({ kind: "effect", ...effectPreview });
      onEffectDropPreviewChange?.(effectPreview.trackMissing ? effectPreview : null);
      return;
    }

    if (dragKind === "remotion") {
      const remotionPreview = getRemotionLayerDropPreview(pos.x, state, pos.y);
      scheduleTimelineDropGhost({ kind: "remotion", ...remotionPreview });
      onEffectDropPreviewChange?.(null);
      return;
    }

    if (dragKind === "media-video" || dragKind === "media-audio" || dragKind === "media-image") {
      const mediaKind = dragKind.slice("media-".length) as "video" | "audio" | "image";
      const mediaPreview = getMediaLayerDropPreview(
        mediaKind, pos.x, state, pos.y,
        getTimelineMediaDragDuration(e.dataTransfer),
      );
      scheduleTimelineDropGhost({ kind: "media", mediaKind, ...mediaPreview });
      onEffectDropPreviewChange?.(null);
      return;
    }

    if (dragKind === "transition") {
      onEffectDropPreviewChange?.(null);
      // Show ALL junction drop guides (valid purple / invalid red) while the
      // card is over the timeline, so legal landing spots read at a glance.
      // Library transitions go on scene cuts and on upper-track video/image clip cuts (phase 10b).
      transitionDropGuidesRef.current = [
        ...getSceneTransitionJunctions(
          scenes, state.tracks, state.zoom, DEFAULT_TRANSITION_DURATION,
          (i) => getSceneStart(scenes[i], scenes, i) + getSceneDuration(scenes[i]),
          (i) => getSceneStart(scenes[i], scenes, i),
        ),
        ...getTransitionJunctions(clips.filter(isLaneClip), state.tracks, state.zoom, DEFAULT_TRANSITION_DURATION),
      ];
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      const target = getTransitionDropTarget(pos.x, pos.y, state);
      if (!target?.trackKey) {
        scheduleTimelineDropGhost(null);
        return;
      }
      const targetTrack = state.tracks.find((track) => track.key === target.trackKey);
      if (!targetTrack) {
        scheduleTimelineDropGhost(null);
        return;
      }
      // Junction under the cursor decides validity (too-short neighbors reject).
      const targetWorldX = target.time * state.zoom;
      const nearest = transitionDropGuidesRef.current
        .reduce<{ d: number; valid: boolean } | null>((best, g) => {
          const d = Math.abs(g.worldX - targetWorldX);
          return !best || d < best.d ? { d, valid: g.valid } : best;
        }, null);
      scheduleTimelineDropGhost({
        kind: "transition",
        x: target.time * state.zoom - state.scrollLeft,
        y: RULER_HEIGHT + targetTrack.y + targetTrack.height / 2,
        rowY: RULER_HEIGHT + targetTrack.y,
        rowH: targetTrack.height,
        labelW: 88,
        labelH: 22,
        valid: nearest ? nearest.d < 24 && nearest.valid : true,
      });
      return;
    }

    clearTimelineDropGhost();
    onEffectDropPreviewChange?.(null);
  }, [getCanvasPos, buildState, clips, scenes, onEffectDropPreviewChange, scheduleTimelineDropGhost, clearTimelineDropGhost]);

  const handleDragLeave = useCallback(() => {
    clearTimelineDropGhost();
    onEffectDropPreviewChange?.(null);
  }, [clearTimelineDropGhost, onEffectDropPreviewChange]);

  useEffect(() => {
    const clearDropGhost = () => {
      clearTimelineDropGhost();
      onEffectDropPreviewChange?.(null);
    };
    window.addEventListener("dragend", clearDropGhost);
    window.addEventListener("drop", clearDropGhost);
    return () => {
      window.removeEventListener("dragend", clearDropGhost);
      window.removeEventListener("drop", clearDropGhost);
    };
  }, [clearTimelineDropGhost, onEffectDropPreviewChange]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    clearTimelineDropGhost();
    onEffectDropPreviewChange?.(null);
    if (!onTrackDrop) return;
    const dataStr = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
    if (!dataStr) return;
    try {
      const data = JSON.parse(dataStr);
      const pos = getCanvasPos(e as any);
      const state = buildState();
      const hit = hitDetect(pos.x, pos.y, state);

      // Effect cards: accept a drop ANYWHERE on the timeline (it always lands as
      // a layer at the playhead), so the user doesn't have to aim at a track row.
      // Looks change the item under the cursor: not on a locked or hidden track, or a locked clip (as edits).
      const trackBlocked = (type: string, index: number) => {
        const row = rawTracks.find((t) => t.type === type && t.index === index);
        return Boolean(row?.locked || row?.visible === false);
      };
      const hitBlocked = (): boolean => {
        if (hit?.type === "scene" && hit.sceneId) {
          const scene = scenes.find((s) => s.id === hit.sceneId);
          return trackBlocked("video", Number(scene?.trackIndex || 1));
        }
        if (hit?.type === "clip" && hit.clipId) {
          const target = clips.find((c) => c.id === hit.clipId);
          return !target || target.locked || trackBlocked(target.trackType, target.trackIndex);
        }
        return false;
      };
      if ((data?.kind === "effect" || data?.kind === "filter") && hitBlocked()) return;

      if (data?.kind === "effect") {
        // Dropped ON a main-track clip or a visual layer clip: the effect joins that item's stack.
        if (hit?.type === "scene" && hit.sceneId) {
          onTrackDrop("effect", 0, hit.time, { ...data, sceneId: hit.sceneId });
          return;
        }
        if (hit?.type === "clip" && hit.clipId) {
          const target = clips.find((c) => c.id === hit.clipId);
          if (target && (target.trackType === "video" || target.trackType === "sticker")) {
            onTrackDrop("effect", 0, hit.time, { ...data, clipId: hit.clipId });
            return;
          }
        }
        const effectPreview = getEffectLayerDropPreview(pos.x, state, pos.y);
        onTrackDrop("effect", effectPreview.trackIndex, effectPreview.time, data);
        return;
      }

      // Filter cards apply to the clip or main-track clip under the cursor.
      if (data?.kind === "filter" && typeof data.filterId === "string") {
        if (hit?.type === "scene" && hit.sceneId) onTrackDrop("filter", 0, hit.time, { ...data, sceneId: hit.sceneId });
        else if (hit?.type === "clip" && hit.clipId) onTrackDrop("filter", 0, hit.time, { ...data, clipId: hit.clipId });
        return;
      }

      if (data?.kind === "remotion" && typeof data.templateId === "string") {
        const remotionPreview = getRemotionLayerDropPreview(pos.x, state, pos.y);
        onTrackDrop("remotion", remotionPreview.trackIndex, remotionPreview.time, data);
        return;
      }

      // Sticker cards: accept a drop anywhere. The NLE handler keeps a sticker-track target (refusing a locked one),
      // else lands on a free sticker track or adds one.
      if (data?.kind === "sticker" && typeof data.stickerId === "string") {
        const dropTime = Math.max(0, (pos.x + state.scrollLeft) / state.zoom);
        const stickerIndex = hit?.trackKey?.startsWith("sticker-") ? parseInt(hit.trackKey.split("-")[1], 10) : 0;
        onTrackDrop("sticker", stickerIndex, dropTime, data);
        return;
      }

      // Transition drop → target the clip OR scene under the cursor. Dropping ON
      // a clip yields a clipId hit; dropping ON a scene yields a sceneId hit.
      if (data?.kind === "transition") {
        const transitionTarget = getTransitionDropTarget(pos.x, pos.y, state);
        if (!transitionTarget) return;
        // Reject drops on junctions whose shorter neighbor can't host the
        // default transition duration.
        const dropJunctions = [
          ...getSceneTransitionJunctions(
            scenes, state.tracks, state.zoom, DEFAULT_TRANSITION_DURATION,
            (i) => getSceneStart(scenes[i], scenes, i) + getSceneDuration(scenes[i]),
            (i) => getSceneStart(scenes[i], scenes, i),
          ),
          ...getTransitionJunctions(clips.filter(isLaneClip), state.tracks, state.zoom, DEFAULT_TRANSITION_DURATION),
        ];
        const dropWorldX = transitionTarget.time * state.zoom;
        const nearestJunction = dropJunctions.reduce<{ d: number; valid: boolean } | null>((best, g) => {
          const d = Math.abs(g.worldX - dropWorldX);
          return !best || d < best.d ? { d, valid: g.valid } : best;
        }, null);
        if (nearestJunction && nearestJunction.d < 24 && !nearestJunction.valid) return;
        onTrackDrop("transition", 0, transitionTarget.time, {
          ...data,
          clipId: transitionTarget.clipId,
          sceneId: transitionTarget.sceneId,
        });
        return;
      }

      // Video AND image drops: accept ANYWHERE on the timeline. V1 is the
      // scene lane, so the NLE handler routes them to an overlay video track
      // (V2+), creating one when none exists — a drop must never vanish.
      // Images share the video lane family (no separate image track).
      if (data?.mediaType === "video" || data?.mediaType === "image") {
        const dropTime = Math.max(0, (pos.x + state.scrollLeft) / state.zoom);
        const requestedVideoIndex = hit?.trackKey?.startsWith("video-")
          ? parseInt(hit.trackKey.split("-")[1], 10)
          : 0;
        onTrackDrop("video", requestedVideoIndex, dropTime, data);
        return;
      }

      const isAudioPayload = data?.mediaType === "audio" || data?.sourceType != null;

      // Audio media drops: accept ANYWHERE too — the pre-drop ghost shows a
      // landing row even when the cursor isn't over a track hit, so bailing
      // on !hit would silently swallow a drop the ghost promised. Route to
      // the same destination the ghost previewed; the NLE handler
      // re-validates locked/hidden tracks and creates missing ones.
      if (!hit && isAudioPayload) {
        const preview = getMediaLayerDropPreview("audio", pos.x, state, pos.y);
        onTrackDrop("audio", preview.trackIndex, preview.time, data);
        return;
      }

      if (!hit) return;

      // Audio drops on A1 track: allow even when hit is "music" or "voiceover"
      // (those hits have no trackKey, but we still want to create a clip)
      if (isAudioPayload && (hit.type === "music" || hit.type === "voiceover" || hit.type === "voiceover-lock")) {
        const a1Track = state.tracks.find(t => t.key === "audio-1");
        if (!a1Track?.locked && a1Track?.visible !== false) {
          onTrackDrop("audio", 1, hit.time, data);
        }
        return;
      }

      if (hit.trackKey) {
        // Prevent drop on locked or hidden tracks.
        const dropTrack = state.tracks.find(t => t.key === hit.trackKey);
        if (dropTrack?.locked || dropTrack?.visible === false) return;
        const [type, indexStr] = hit.trackKey.split("-");
        onTrackDrop(type, parseInt(indexStr), hit.time, data);
      }
    } catch {}
  }, [getCanvasPos, buildState, clips, scenes, rawTracks, onTrackDrop, onEffectDropPreviewChange, clearTimelineDropGhost]);

  // Double-click: scene → open properties; empty track → add clip
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const pos = getCanvasPos(e);
    const state = buildState();
    const hit = hitDetect(pos.x, pos.y, state);
    if (!hit) return;

    // Double-click on a scene SELECTS the specific shot under the cursor.
    // That selection persists (yellow outline) until the user clicks elsewhere
    // or drags it. A third click (on the selected shot) enters drag mode.
    if (hit.type === "scene" && hit.sceneId) {
      onSelectScene(hit.sceneId);
      const scene = scenes.find(s => s.id === hit.sceneId);
      const sceneIdx = scenes.findIndex(s => s.id === hit.sceneId);
      let shotIndex = 0;
      if (scene && sceneIdx >= 0) {
        const sceneStart = getSceneStart(scene, scenes, sceneIdx);
        shotIndex = Math.max(0, shotIndexForScene(scene, sceneStart, hit.time));
      }
      // Shots made on opennan.com are read only here (phase 9a.1): the scene is selected, no shot.
      if (scene && hasReadOnlyShots(scene)) setSelectedShot(null);
      else setSelectedShot({ sceneId: hit.sceneId, shotIndex });
      // Stop scene drag that the mousedown primed — we're in shot-selection
      // mode now, not scene-drag.
      sceneTimeDragRef.current = null;
      sceneDragPreviewLerpRef.current.clear();
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      onDoubleClickScene?.(hit.sceneId, shotIndex);
      return;
    }

    if (hit.type !== "track-empty" || !hit.trackKey) return;

    const [trackType, indexStr] = hit.trackKey.split("-");
    const trackIndex = parseInt(indexStr || "1");

    // Video tracks host scenes now (V1 base + V2+ overlays) — never auto-create
    // a placeholder overlay clip on double-click. Use drag-from-sources or the
    // right-click menu to add overlay video explicitly.
    if (trackType === "video") return;
    // A1 is the voiceover/music track; don't create on it.
    if (trackType === "audio" && trackIndex === 1) return;
    // Graphics clips need a template/prompt — they're added from the Graphics
    // gallery, never as empty placeholders.
    if (trackType === "remotion") return;

    // Don't create on locked or hidden tracks
    const trackLayout = state.tracks.find(t => t.key === hit.trackKey);
    if (trackLayout?.locked || trackLayout?.visible === false) return;

    commitCanvasCreates([{
      trackType,
      trackIndex,
      startTime: Math.max(0, hit.time),
      endTime: Math.max(0, hit.time) + 5,
      textContent: trackType === "text" ? "Text" : null,
      label: trackType === "text" ? "Text" : null,
    }], "clipUpdateFailed");
  }, [buildState, commitCanvasCreates, getCanvasPos, onSelectScene, onDoubleClickScene]);

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const pos = getCanvasPos(e);
    const state = buildState();
    const hit = hitDetect(pos.x, pos.y, state);
    if (!hit) return;
    if (keyframes.handleContextMenu(e, hit)) {
      setCtxMenu(null);
      return;
    }

    // Right-clicking a transition marker selects it and opens a one-item menu.
    if (hit.type === "transition" && (hit.clipId || hit.sceneId)) {
      selectTransition(hit.sceneId ? { kind: "scene", id: hit.sceneId } : { kind: "clip", id: hit.clipId! });
      setSelectedSceneIds(new Set());
      if (selectedShot) setSelectedShot(null);
      needsRenderRef.current = true;
      wakeRenderLoopRef.current?.();
      setCtxMenu({ x: e.clientX, y: e.clientY, hit });
      return;
    }

    if (selectedTransition) clearTransitionSelection();

    // Only show context menu for actionable targets
    if (hit.type === "scene" || hit.type === "voiceover" || hit.type === "voiceover-lock" || hit.type === "clip" ||
        hit.type === "music" || hit.type === "track-empty" || hit.type === "marker" || hit.type === "ruler") {
      setAddSceneSub("root");
      setAddSceneUrl("");
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        hit,
      });
    }
  }, [buildState, clearTransitionSelection, getCanvasPos, selectedShot, selectedTransition, selectTransition]);

  // Close context menu on click anywhere and on wheel/scroll outside it.
  // Wheel WITHIN the menu scrolls the menu's own overflow (long menus),
  // and must never move the timeline or dismiss the menu.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onWheel = (e: WheelEvent) => {
      const menu = ctxMenuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) {
        // Consume the wheel entirely: scroll the dropdown's own content and
        // stop the event so it can never chain into the timeline scroller.
        e.preventDefault();
        e.stopPropagation();
        menu.scrollTop += e.deltaY;
        return;
      }
      setCtxMenu(null);
    };
    // Only timeline scroll containers should dismiss the menu — unrelated
    // scrollers (e.g. the chat panel autoscrolling) must leave it alone.
    const onScroll = (e: Event) => {
      const canvas = canvasRef.current;
      if (!canvas || !(e.target instanceof Node) || !e.target.contains(canvas)) return;
      setCtxMenu(null);
    };
    window.addEventListener("mousedown", close);
    // passive:false — we must preventDefault wheel inside the menu so the
    // browser never scrolls the timeline container underneath it.
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [ctxMenu]);

  // Context menu action helpers
  const ctxSceneData = ctxMenu?.hit.sceneId
    ? scenes.find(s => s.id === ctxMenu.hit.sceneId)
    : null;

  // Total scrollable width — content end considers both the non-engine
  // totalDuration prop (accounts for clips/audio, which the engine does not
  // yet model) and the engine's scene-only contentEnd, then pads/clamps
  // through the engine so drag-to-edge auto-expand works consistently with
  // zoom/scroll math elsewhere.
  const trackContentWidth = Math.max(
    contentWidthPx(Math.max(totalDuration, contentEnd(scenesToEngineItems(scenes))), zoom),
    100,
  );
  // Total track height for canvas sizing
  const totalTrackHeight = trackLayout.reduce((h, t) => Math.max(h, t.y + t.height), 0) + RULER_HEIGHT; // i18n-ignore
  const renderedTrackHeight =
    timelineDropGhost?.kind === "effect" && timelineDropGhost.trackMissing
      ? Math.max(totalTrackHeight, timelineDropGhost.y + timelineDropGhost.h)
      : totalTrackHeight;

  const handleAudioFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !pendingAudioDropRef.current) return;
    audioDurationAbortRef.current?.abort();
    const controller = new AbortController();
    audioDurationAbortRef.current = controller;
    const { trackType, trackIndex, time } = pendingAudioDropRef.current;
    pendingAudioDropRef.current = null;
    const toastId = toast.loading(t("uploadingFile", { name: file.name }));
    try {
      const url = await upload(file);
      if (controller.signal.aborted) {
        toast.dismiss(toastId);
        return;
      }
      const duration = await loadAudioDuration(url, { fallbackSeconds: 30, resolveUrl: media.resolveMediaUrl, signal: controller.signal });
      if (controller.signal.aborted) {
        toast.dismiss(toastId);
        return;
      }
      commitCanvasCreates([{ trackType, trackIndex, startTime: time, endTime: time + duration, mediaUrl: url, mediaType: "audio", label: file.name }], "clipUpdateFailed");
      // Also save to Sources panel so it appears there for reuse
      onSaveToSources?.(url, file.name, file.size, file.type || "audio/mpeg");
      toast.success(t("audioAdded"), { id: toastId });
    } catch {
      if (controller.signal.aborted) {
        toast.dismiss(toastId);
        return;
      }
      toast.error(t("uploadFailed"), { id: toastId });
    } finally {
      if (audioDurationAbortRef.current === controller) audioDurationAbortRef.current = null;
    }
  }, [commitCanvasCreates, upload, onSaveToSources, t, toast]);

  // Scene-create from imported video / image.
  const handleSceneVideoFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !pendingSceneAddRef.current) return;
    const { afterOrder, trackIndex, timelinePositionSeconds } = pendingSceneAddRef.current;
    pendingSceneAddRef.current = null;
    const toastId = toast.loading(t("uploadingFile", { name: file.name }));
    try {
      const url = await upload(file);
      onAddScene?.(afterOrder, { cardType: "source_clip", sourceVideoUrl: url, trackIndex, timelinePositionSeconds });
      onSaveToSources?.(url, file.name, file.size, file.type || "video/mp4");
      toast.success(t("videoSceneAdded"), { id: toastId });
    } catch {
      toast.error(t("uploadFailed"), { id: toastId });
    }
  }, [upload, onAddScene, onSaveToSources, t, toast]);

  const handleSceneImageFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !pendingSceneAddRef.current) return;
    const { afterOrder, trackIndex, timelinePositionSeconds } = pendingSceneAddRef.current;
    pendingSceneAddRef.current = null;
    const toastId = toast.loading(t("uploadingFile", { name: file.name }));
    try {
      const url = await upload(file);
      onAddScene?.(afterOrder, { cardType: "image", startImageUrl: url, trackIndex, timelinePositionSeconds });
      onSaveToSources?.(url, file.name, file.size, file.type || "image/png");
      toast.success(t("imageSceneAdded"), { id: toastId });
    } catch {
      toast.error(t("uploadFailed"), { id: toastId });
    }
  }, [upload, onAddScene, onSaveToSources, t, toast]);

  const handleStickerFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !pendingStickerDropRef.current) return;
    const { trackIndex, time } = pendingStickerDropRef.current;
    pendingStickerDropRef.current = null;
    const toastId = toast.loading(t("uploadingFile", { name: file.name }));
    try {
      const url = await upload(file);
      commitCanvasCreates([{ trackType: "sticker", trackIndex, startTime: time, endTime: time + 5, mediaUrl: url, label: file.name, positionX: 0.5, positionY: 0.5, scale: 1, opacity: 1 }], "clipUpdateFailed");
      onSaveToSources?.(url, file.name, file.size, file.type || "image/png");
      toast.success(t("imageAdded"), { id: toastId });
    } catch {
      toast.error(t("uploadFailed"), { id: toastId });
    }
  }, [commitCanvasCreates, upload, onSaveToSources, t, toast]);

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      style={{ height: `${renderedTrackHeight}px`, width: `${trackContentWidth}px`, minWidth: `${trackContentWidth}px` }}
    >
      <input ref={audioFileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleAudioFileSelect} />
      <input ref={stickerFileInputRef} type="file" accept="image/*" className="hidden" onChange={handleStickerFileSelect} />
      <input ref={sceneVideoFileInputRef} type="file" accept="video/*" className="hidden" onChange={handleSceneVideoFileSelect} />
      <input ref={sceneImageFileInputRef} type="file" accept="image/*" className="hidden" onChange={handleSceneImageFileSelect} />
      {/* Viewport layer — sticks just past the label column so the canvas and
          every canvas-coordinate overlay (drop ghosts, marquee) stay glued to
          the visible scroll port instead of spanning the whole timeline. */}
      <div
        ref={viewportLayerRef}
        className="sticky top-0 z-0"
        style={{ left: `${TIMELINE_LABEL_COL_WIDTH}px`, height: "100%" }}
      >
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          if (bladeXRef.current !== null) {
            bladeXRef.current = null;
            needsRenderRef.current = true;
            wakeRenderLoopRef.current?.();
          }
        }}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        // Programmatic focus only (after the last keyframe is deleted from the keyboard), never a tab stop.
        tabIndex={-1}
        className="absolute inset-0 block outline-none"
      />
      <div
        ref={playheadOverlayRef}
        data-testid="canvas-timeline-playhead-overlay"
        className="pointer-events-none absolute left-0 top-0 bottom-0 z-20 will-change-transform"
        style={{ transform: "translate3d(0, 0, 0)" }}
      >
        <div className="absolute left-[-5px] top-0 h-0 w-0 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent border-t-white" />
        <div className="absolute left-[-0.5px] top-0 bottom-0 w-px bg-white/90" />
      </div>

      {/* Pre-drop ghost: shows where dragged effects/transitions will land. */}
      {timelineDropGhost?.kind === "effect" && timelineDropGhost.trackMissing && (
        <div
          className="absolute pointer-events-none z-0 rounded-[3px] border border-dashed border-purple-400/40 bg-purple-500/10"
          style={{
            left: 0,
            top: timelineDropGhost.y,
            width: "100%",
            height: timelineDropGhost.h,
          }}
        />
      )}
      {timelineDropGhost?.kind === "effect" && (
        <div
          className="absolute pointer-events-none z-10 rounded-[3px] border border-purple-400/80 bg-purple-500/25 flex items-center px-1.5"
          style={{
            left: timelineDropGhost.x,
            top: timelineDropGhost.y,
            width: timelineDropGhost.w,
            height: timelineDropGhost.h,
          }}
        >
          <span className="text-[10px] text-purple-100 truncate">{t("ghostEffect")}</span>
        </div>
      )}
      {timelineDropGhost?.kind === "remotion" && timelineDropGhost.trackMissing && (
        <div
          className="absolute pointer-events-none z-0 rounded-[3px] border border-dashed border-violet-400/40 bg-violet-500/10"
          style={{
            left: 0,
            top: timelineDropGhost.y,
            width: "100%",
            height: timelineDropGhost.h,
          }}
        />
      )}
      {timelineDropGhost?.kind === "remotion" && (
        <div
          className="absolute pointer-events-none z-10 rounded-[3px] border border-white/80 bg-white/25 flex items-center px-1.5"
          style={{
            left: timelineDropGhost.x,
            top: timelineDropGhost.y,
            width: timelineDropGhost.w,
            height: timelineDropGhost.h,
          }}
        >
          <span className="text-[10px] text-white truncate">{t("ghostGraphic")}</span>
        </div>
      )}
      {timelineDropGhost?.kind === "media" && timelineDropGhost.trackMissing && (
        <div
          className="absolute pointer-events-none z-0 rounded-[3px] border border-dashed border-white/40 bg-white/10"
          style={{
            left: 0,
            top: timelineDropGhost.y,
            width: "100%",
            height: timelineDropGhost.h,
          }}
        />
      )}
      {timelineDropGhost?.kind === "media" && (
        <div
          data-testid="media-drop-ghost"
          className="absolute pointer-events-none z-10 overflow-hidden rounded-md border border-white/90 bg-gradient-to-b from-white/50 to-white/40 shadow-[0_2px_10px_rgba(255,255,255,0.175)] flex items-center gap-1.5 px-2"
          style={{
            left: timelineDropGhost.x,
            top: timelineDropGhost.y + 2,
            width: timelineDropGhost.w,
            height: Math.max(18, timelineDropGhost.h - 4),
          }}
        >
          {timelineDropGhost.mediaKind === "audio"
            ? <Music className="h-3 w-3 shrink-0 text-white" />
            : timelineDropGhost.mediaKind === "image"
              ? <ImageIcon className="h-3 w-3 shrink-0 text-white" />
              : <Film className="h-3 w-3 shrink-0 text-white" />}
          <span className="text-[10px] font-medium text-white truncate capitalize">{timelineDropGhost.mediaKind}</span>{/* i18n-ignore */}
        </div>
      )}
      {timelineDropGhost?.kind === "transition" && (
        <>
          <div
            data-testid="transition-drop-placeholder"
            className="absolute pointer-events-none z-0 rounded-[4px] border border-dashed border-white/60 bg-white/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
            style={{
              left: Math.max(0, timelineDropGhost.x - 18),
              top: timelineDropGhost.rowY + 2,
              width: 36,
              height: Math.max(18, timelineDropGhost.rowH - 4),
            }}
          />
          <div
            data-testid="transition-drop-label"
            className="absolute pointer-events-none z-10 flex items-center justify-center rounded-[4px] border border-white/90 bg-white/30 px-2 text-[10px] font-semibold text-white shadow-[0_0_0_2px_rgba(255,255,255,0.08)]"
            style={{
              left: Math.max(0, timelineDropGhost.x - timelineDropGhost.labelW / 2),
              top: timelineDropGhost.y - timelineDropGhost.labelH / 2,
              width: timelineDropGhost.labelW,
              height: timelineDropGhost.labelH,
            }}
          >
            {t("ghostTransition")}
          </div>
        </>
      )}

      {/* Marquee selection overlay — positioned imperatively during drag. */}
      <div
        ref={marqueeOverlayRef}
        className="absolute pointer-events-none border border-primary/60 bg-primary/10 rounded-[2px]"
        style={{ display: "none" }}
      />
      </div>

      {/* Keyboard keyframes (phase 10d): hidden focusable diamonds over the drawn ones, in world coordinates. */}
      <KeyframeKeyboardLayer
        geometry={keyframeGeometry}
        clips={clips}
        scenes={scenes}
        keyframes={keyframes}
        onEmpty={focusCanvas}
      />

      {keyframes.menu}

      {/* Right-click context menu */}
      {ctxMenu && (() => {
        const menuTrackType =
          ctxMenu.hit.type === "track-empty" && ctxMenu.hit.trackKey
            ? ctxMenu.hit.trackKey.split("-")[0]
            : null;
        const isVideoAddSceneMenu = menuTrackType === "video";
        const menuWidth = isVideoAddSceneMenu ? 260 : 256;
        const menuMaxHeight = isVideoAddSceneMenu && addSceneSub === "root" ? 460 : 720;
        const menuClip = ctxMenu.hit.type === "clip" && ctxMenu.hit.clipId
          ? clips.find((clip) => clip.id === ctxMenu.hit.clipId)
          : null;
        if (ctxMenu.hit.type === "clip" && ctxMenu.hit.clipId && !menuClip) return null;
        if (ctxMenu.hit.type === "scene" && ctxMenu.hit.sceneId && !isEditableCanvasSceneTrack(scenes, rawTracks, ctxMenu.hit.sceneId)) {
          return null;
        }
        if (ctxMenu.hit.type === "transition") {
          const transitionTarget = ctxMenu.hit.sceneId
            ? { kind: "scene" as const, id: ctxMenu.hit.sceneId }
            : ctxMenu.hit.clipId
              ? { kind: "clip" as const, id: ctxMenu.hit.clipId }
              : null;
          if (!transitionTarget) return null;
          const currentTransitionMarkers = [
            ...getTransitionMarkers(clips, trackLayout, zoom),
            ...getSceneTransitionMarkers(
              scenes,
              trackLayout,
              zoom,
              (index) => getSceneStart(scenes[index], scenes, index) + getSceneDuration(scenes[index]),
              (index) => getSceneStart(scenes[index], scenes, index),
            ),
          ];
          if (!hasTransitionMarker(currentTransitionMarkers, transitionTarget)) return null;
        }
        if (ctxMenu.hit.type === "clip" && ctxMenu.hit.clipId) {
          const menuClipEditableIds = getEditableTimelineClipIds(clips, rawTracks, new Set([ctxMenu.hit.clipId]));
          if (!menuClipEditableIds.has(ctxMenu.hit.clipId)) return null;
        }
        const canPasteContextClipboard = canPasteTimelineClipboard(timelineClipboard, rawTracks);
        const canShowContextPasteActions = canCreateCanvasClip && canPasteContextClipboard;
        const menuEstimatedHeight = Math.min(
          getContextMenuEstimatedHeight(ctxMenu.hit.type, menuTrackType, addSceneSub, menuClip, canShowContextPasteActions),
          menuMaxHeight,
        );

        return (
        <div
          ref={ctxMenuRef}
          className={CTX_MENU_SHELL_CLASS}
          style={getContextMenuStyle(ctxMenu.x, ctxMenu.y, menuWidth, menuEstimatedHeight)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Ruler: drop a bookmark/marker exactly where the user right-clicked. */}
          {ctxMenu.hit.type === "ruler" && (
            <CtxItem
              icon={<Flag className="h-3 w-3" />}
              label={t("addMarkerHere")}
              onClick={() => {
                storeApi.getState().addTimelineMarker(Math.max(0, ctxMenu.hit.time));
                setCtxMenu(null);
              }}
            />
          )}
          {/* Scene context menu */}
          {ctxMenu.hit.type === "marker" && ctxMenu.hit.markerId && (
            <CtxItem
              icon={<Trash2 className="h-3 w-3" />}
              label={t("deleteThisMarker")}
              destructive
              onClick={() => {
                storeApi.getState().removeTimelineMarker(ctxMenu.hit.markerId!);
                setCtxMenu(null);
              }}
            />
          )}
          {ctxMenu.hit.type === "scene" && ctxMenu.hit.sceneId && (() => {
            // Only offer the per-shot delete action when a shot is actively
            // selected (via double-clicking into the scene), not on every
            // scene right-click.
            const hitSceneId = ctxMenu.hit.sceneId;
            const hitScene = scenes.find((s) => s.id === hitSceneId);
            const ctxShotIndex =
              selectedShot && selectedShot.sceneId === hitSceneId && !(hitScene && hasReadOnlyShots(hitScene)) ? selectedShot.shotIndex : -1;
            return (
              <>
                {/* Edit is the FIRST row here too — it opens the scene's video
                    in the shared edit modal with the scene attached to the AI,
                    matching the clip menu. */}
                {hitScene && (hitScene as { videoUrl?: string | null }).videoUrl && (
                  <>
                    <CtxItem
                      icon={
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="6" width="14" height="12" rx="2" />
                          <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
                          <path d="M11 12h.01" />
                        </svg>
                      }
                      label={t("editVideo")}
                      disabled={["video_generating", "images_generating", "face_swapping"].includes((hitScene as { status?: string }).status || "")}
                      onClick={() => {
                        callbacks.onOpenSceneEdit?.({ sceneId: hitSceneId, tool: "editvideo" });
                        setCtxMenu(null);
                      }}
                    />
                    {onDeepfakeScene && (
                      <CtxItem
                        icon={
                          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 7V5a2 2 0 0 1 2-2h2" />
                            <path d="M17 3h2a2 2 0 0 1 2 2v2" />
                            <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
                            <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
                            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                            <path d="M9 9h.01" />
                            <path d="M15 9h.01" />
                          </svg>
                        }
                        label={t("deepfakeVideo")}
                        disabled={["video_generating", "images_generating", "face_swapping"].includes((hitScene as { status?: string }).status || "")}
                        onClick={() => {
                          void onDeepfakeScene(hitSceneId);
                          setCtxMenu(null);
                        }}
                      />
                    )}
                    <CtxSeparator />
                  </>
                )}
                {/* AI tools (phase 11): prices on the right; rows that need a choice open the inspector's AI tab. */}
                <AiMenuRows target={{ sceneId: hitSceneId }} kind="scene" onClose={() => setCtxMenu(null)} />
                <CtxSeparator />

	                <CtxItem
	                  icon={<Plus className="h-3 w-3" />}
	                  label={t("insertBeforeScene", { n: (ctxSceneData?.order ?? 0) + 1 })}
	                  onClick={() => {
                    onAddScene?.((ctxSceneData?.order ?? 0) - 1);
                    setCtxMenu(null);
                  }}
                />
	                <CtxItem
	                  icon={<Plus className="h-3 w-3" />}
	                  label={t("insertAfterScene", { n: (ctxSceneData?.order ?? 0) + 1 })}
	                  onClick={() => {
                    onAddScene?.(ctxSceneData?.order ?? 0);
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<Copy className="h-3 w-3" />}
                  label={t("duplicateScene")}
                  onClick={() => {
                    onDuplicateScene?.(hitSceneId);
                    setCtxMenu(null);
                  }}
                />
                {/* Copy / paste attributes (phase 10c): a multi-scene selection that holds this scene takes the paste. */}
                <CtxItem
                  icon={<Paintbrush className="h-3 w-3" />}
                  label={t("copyAttributes")}
                  shortcut={attributeShortcutLabel("C")}
                  onClick={() => {
                    if (hitScene) attributeActions.copy({ kind: "scene", scene: hitScene });
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<PaintBucket className="h-3 w-3" />}
                  label={t("pasteAttributes")}
                  shortcut={attributeShortcutLabel("V")}
                  disabled={!hasAttributeClipboard}
                  onClick={() => {
                    const ids = selectedSceneIds.has(hitSceneId) && selectedSceneIds.size > 1 ? [...selectedSceneIds] : [hitSceneId];
                    attributeActions.openPaste(ids.filter((id) => isEditableCanvasSceneTrack(scenes, rawTracks, id)).map((sceneId) => ({ sceneId })));
                    setCtxMenu(null);
                  }}
                />
	                {/* Media plumbing. The AI edits (edit, background removal,
	                    deepfake) are the first group of this menu. Processing
	                    scenes stay movable but can't start ANOTHER action until
	                    the job finishes. */}
                {hitScene && (hitScene as { videoUrl?: string | null }).videoUrl && (
                  <CtxItem
                    icon={
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 10v3" /><path d="M6 6v11" /><path d="M10 3v18" /><path d="M14 8v7" /><path d="M18 5v13" /><path d="M22 10v3" />
                      </svg>
                    }
                    label={t("detachAudioShort")}
                    disabled
                    onClick={() => {
                      const sceneIdx = scenes.findIndex((s) => s.id === hitSceneId);
                      const start = hitScene && sceneIdx >= 0 ? getSceneStart(hitScene, scenes, sceneIdx) : 0;
                      void timelineController.execute({ type: "ai.run", capability: "opennan.copy-video", input: { sceneId: hitSceneId, action: "detach", timelineStart: start } });
                      setCtxMenu(null);
                    }}
                  />
                )}
                {/* Destructive actions last, narrowest scope first. */}
                <CtxSeparator />
                {ctxShotIndex >= 0 && onDeleteShot && (
                  <CtxItem
                    icon={<Trash2 className="h-3 w-3" />}
                    label={t("deleteShot", { n: ctxShotIndex + 1 })}
                    destructive
                    onClick={() => {
                      onDeleteShot(hitSceneId, ctxShotIndex);
                      setSelectedShot(null);
                      setCtxMenu(null);
                    }}
                  />
                )}
                <CtxItem
                  icon={<Trash2 className="h-3 w-3" />}
                  label={t("deleteScene")}
                  destructive
                  onClick={() => {
                    onDeleteScene?.(hitSceneId);
                    setCtxMenu(null);
                  }}
                />
                {onRippleDeleteScene && (
                  <CtxItem
                    icon={<ChevronsLeft className="h-3 w-3" />}
                    label={t("rippleDeleteScene")}
                    destructive
                    onClick={() => {
                      onRippleDeleteScene(hitSceneId);
                      setCtxMenu(null);
                    }}
                  />
                )}
              </>
            );
          })()}

          {/* Voiceover context menu */}
          {(ctxMenu.hit.type === "voiceover" || ctxMenu.hit.type === "voiceover-lock") && ctxMenu.hit.sceneId && (() => {
            const a1TrackLayout = trackLayout.find((track) => track.key === "audio-1");
            if (!isEditableTrackLayout(a1TrackLayout)) return null;
            return (
              <>
                <CtxItem
                  icon={<FolderOpen className="h-3 w-3" />}
                  label={t("importAudioClip")}
                  onClick={() => {
                    pendingAudioDropRef.current = { trackType: "audio", trackIndex: 1, time: Math.max(0, ctxMenu.hit.time) };
                    audioFileInputRef.current?.click();
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<FileAudio className="h-3 w-3" />}
                  label={t("separateAudio")}
                  disabled={!canCreateCanvasClip}
                  onClick={() => {
                    const sceneId = ctxMenu.hit.sceneId!;
                    const voiceoverScene = scenes.find((scene) => scene.id === sceneId);
                    const audioUrl = voiceoverScene ? getSceneVoiceoverUrl(voiceoverScene) : null;
                    if (!canCreateCanvasClip || !audioUrl) { setCtxMenu(null); return; }
                    const separateInput = getSeparateVoiceoverAudioInput({
                      audioUrl,
                      startTime: getSceneStartForTimeline(voiceoverScene!) + (voiceoverOffsetsRef.current.get(sceneId) || 0),
                      duration: getSceneDurationById(sceneId),
                      audioTrackIndex: 1,
                    });
                    onRemoveVoiceover?.(sceneId);
                    commitCanvasCreates([separateInput], "clipUpdateFailed");
                    setCtxMenu(null);
                  }}
                />
                <CtxSeparator />
                <CtxItem
                  icon={<Trash2 className="h-3 w-3" />}
                  label={t("removeVoiceover")}
                  destructive
                  onClick={() => {
                    onRemoveVoiceover?.(ctxMenu.hit.sceneId!);
                    setCtxMenu(null);
                  }}
                />
              </>
            );
          })()}

          {/* Transition marker context menu */}
          {ctxMenu.hit.type === "transition" && (ctxMenu.hit.clipId || ctxMenu.hit.sceneId) && (
            <CtxItem
              icon={<Trash2 className="h-3 w-3" />}
              label={t("deleteTransition")}
              destructive
              onClick={() => {
                if (ctxMenu.hit.sceneId) {
                  onSetSceneTransition?.(ctxMenu.hit.sceneId, "none", 0);
                } else {
                  const clipId = ctxMenu.hit.clipId!;
                  void timelineController.execute({ type: "transition.set", clipId, transition: "none" });
                }
                clearTransitionSelection();
                setCtxMenu(null);
              }}
            />
          )}

          {/* Clip context menu */}
          {ctxMenu.hit.type === "clip" && ctxMenu.hit.clipId && (() => {
            const contextClip = clips.find((clip) => clip.id === ctxMenu.hit.clipId);
            if (!contextClip) return null;
            const ctxIsAudio = isAudioTimelineClip(contextClip);
            const ctxIsVideo = contextClip.trackType === "video";
            const ctxIsText = isTextTimelineClip(contextClip);
            const ctxIsEffect = contextClip.trackType === "effect";
            const ctxIsVisual = isVisualTimelineClip(contextClip);
            const ctxHasAudio = ctxIsAudio || ctxIsVideo;
            const ctxAiKind = aiItemKind({ clip: contextClip });
            const ctxActionIds = computeContextActionClipIds(ctxMenu.hit.clipId!, selectedClipIds);
            const ctxPrimaryId = selectedClipId ?? ctxMenu.hit.clipId!;
            const ctxApply = (commits: ClipCommit[]) => {
              if (commits.length > 0) onUpdateClips(commits);
              setCtxMenu(null);
            };
            // Speed presets are one speed.set (length, keyframes, curve, and pushed clips stay consistent).
            const ctxSpeed = (request: { speed?: number; curve?: { id: string; points: Array<[number, number]> } | null }) => {
              const clipIds = getTimelineSpeedPresetTargetIds(clips, rawTracks, ctxActionIds, ctxPrimaryId);
              if (clipIds.length > 0) void timelineController.execute({ type: "speed.set", clipIds, ...request });
              setCtxMenu(null);
            };
            return (
              <>
                {/* Edit is the FIRST row: the clicked clip opens the shared clip
                    edit modal (ClipEditDialog) scoped to that clip alone — AI
                    chat with only this clip attached, plus the Manual tab.
                    Images ride on video lanes, so the media type picks the
                    label. Everything below is clipboard / mechanical editing. */}
                {ctxIsVideo && contextClip.mediaUrl && (
                  <CtxItem
                    icon={
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="6" width="14" height="12" rx="2" />
                        <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
                        <path d="M11 12h.01" />
                      </svg>
                    }
                    label={contextClip.mediaType === "image" ? t("editImage") : t("editVideo")}
                    onClick={() => {
                      setSelectedClipIds(new Set([contextClip.id]));
                      callbacks.onOpenClipEdit?.({
                        clipId: contextClip.id,
                        kind: contextClip.mediaType === "image" ? "image" : "video",
                      });
                      setCtxMenu(null);
                    }}
                  />
                )}
                {ctxIsAudio && (
                  <CtxItem
                    icon={<SlidersHorizontal className="h-3 w-3" />}
                    label={t("editAudio")}
                    onClick={() => {
                      setSelectedClipIds(new Set([contextClip.id]));
                      callbacks.onOpenClipEdit?.({ clipId: contextClip.id, kind: "audio" });
                      setCtxMenu(null);
                    }}
                  />
                )}
                {ctxIsText && (
                  <CtxItem
                    icon={<Wand2 className="h-3 w-3" />}
                    label={t("editTextWithAi")}
                    onClick={() => {
                      setSelectedClipIds(new Set([contextClip.id]));
                      callbacks.onOpenChatEdit?.({
                        kind: "text",
                        reference: {
                          type: "timeline_clip",
                          clipId: contextClip.id,
                          trackType: contextClip.trackType,
                          trackIndex: contextClip.trackIndex,
                          startTime: contextClip.startTime,
                          endTime: contextClip.endTime,
                          label: getTextTimelineClipKind(contextClip) === "caption" ? t("captionClip") : t("subtitleClip"),
                          prompt: contextClip.textContent || contextClip.label || null,
                        },
                      });
                      setCtxMenu(null);
                    }}
                  />
                )}
                {/* AI tools (phase 11): the tools that fit the clip, prices on the right. */}
                {ctxAiKind && (
                  <>
                    <CtxSeparator />
                    <AiMenuRows target={{ clipId: contextClip.id }} kind={ctxAiKind} onClose={() => setCtxMenu(null)} />
                  </>
                )}
                {(ctxIsVideo || ctxIsAudio || ctxIsText) && <CtxSeparator />}

                {/* Clipboard — shared by every clip type */}
                <CtxItem
                  icon={<CopyPlus className="h-3 w-3" />}
                  label={ctxIsText ? t(getTextTimelineClipLabelKey(contextClip, "duplicate") as MessageKey<"canvasTimeline">) : t("duplicateClip")}
                  onClick={() => {
                    if (!canCreateCanvasClip) return;
                    const editableDuplicateIds = getEditableTimelineClipIds(clips, rawTracks, ctxActionIds);
                    const inputs = duplicateTimelineClips(clips as unknown as TimelineDuplicateClip[], editableDuplicateIds, rawTracks);
                    if (inputs.length === 0) { setCtxMenu(null); return; }
                    commitCanvasCreates(inputs, "duplicateFailed");
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<ClipboardCopy className="h-3 w-3" />}
                  label={ctxIsText ? t(getTextTimelineClipLabelKey(contextClip, "copy") as MessageKey<"canvasTimeline">) : t("copyClip")}
                  shortcut="⌘ C"
                  onClick={() => {
                    storeApi.getState().setTimelineClipboard(
                      copyTimelineClips(clips as unknown as TimelineDuplicateClip[], ctxActionIds, rawTracks),
                    );
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<ClipboardX className="h-3 w-3" />}
                  label={t("cutClip")}
                  shortcut="⌘ X"
                  onClick={() => {
                    const editableCutIds = getEditableTimelineClipIds(clips, rawTracks, ctxActionIds);
                    const cut = cutTimelineClips(clips as unknown as TimelineDuplicateClip[], editableCutIds, rawTracks);
                    if (cut) {
                      storeApi.getState().setTimelineClipboard(cut.clipboard);
                      setSelectedClipIds(getTimelineSelectionAfterDelete(selectedClipIds, new Set(cut.deleteIds), clips, rawTracks));
                      onDeleteClips(cut.deleteIds);
                    }
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<ClipboardPaste className="h-3 w-3" />}
                  label={t("pasteClip")}
                  shortcut="⌘ V"
                  disabled={!canCreateCanvasClip || !canPasteContextClipboard}
                  onClick={() => {
                    if (!canCreateCanvasClip) return;
                    const inputs = getEditableTimelinePasteInputs(
                      pasteTimelineClips(timelineClipboard, Math.max(0, ctxMenu.hit.time)),
                      rawTracks,
                      clips as unknown as TimelineDuplicateClip[],
                    );
                    if (inputs.length === 0) { setCtxMenu(null); return; }
                    commitCanvasCreates(inputs, "pasteFailed");
                    setCtxMenu(null);
                  }}
                />
                {/* Copy / paste attributes (phase 10c): paste goes to the selection that holds this clip. */}
                {acceptedAttributeKinds({ kind: "clip", clip: contextClip }).length > 0 && (
                  <>
                    <CtxItem
                      icon={<Paintbrush className="h-3 w-3" />}
                      label={t("copyAttributes")}
                      shortcut={attributeShortcutLabel("C")}
                      onClick={() => {
                        attributeActions.copy({ kind: "clip", clip: contextClip });
                        setCtxMenu(null);
                      }}
                    />
                    <CtxItem
                      icon={<PaintBucket className="h-3 w-3" />}
                      label={t("pasteAttributes")}
                      shortcut={attributeShortcutLabel("V")}
                      disabled={!hasAttributeClipboard}
                      onClick={() => {
                        const ids = [...getEditableTimelineClipIds(clips, rawTracks, ctxActionIds)];
                        attributeActions.openPaste((ids.length > 0 ? ids : [contextClip.id]).map((clipId) => ({ clipId })));
                        setCtxMenu(null);
                      }}
                    />
                  </>
                )}

                {/* Split at the right-click position — parity with the toolbar/⌘B
                    tool so a cut is one gesture away from the clip itself. */}
                {onSplitClip && (
                  <CtxItem
                    icon={<Scissors className="h-3 w-3" />}
                    label={t("splitAtPlayhead")}
                    onClick={() => {
                      const splitId = getTimelineBladeSplitClipId(clips || [], rawTracks, ctxMenu.hit.clipId!, ctxMenu.hit.time);
                      if (splitId) onSplitClip(splitId, ctxMenu.hit.time);
                      setCtxMenu(null);
                    }}
                  />
                )}

                {/* Speed & time — video clips */}
                {ctxIsVideo && (
                  <>
                    <CtxSeparator />
                    <CtxItem icon={<SkipBack className="h-3 w-3" />} label={t("setSpeedHalf")} onClick={() => ctxSpeed({ speed: 0.5, curve: null })} />
                    <CtxItem icon={<Play className="h-3 w-3" />} label={t("setSpeedNormal")} onClick={() => ctxSpeed({ speed: 1, curve: null })} />
                    <CtxItem icon={<SkipForward className="h-3 w-3" />} label={t("setSpeedDouble")} onClick={() => ctxSpeed({ speed: 2, curve: null })} />
                    <CtxItem icon={<StepForward className="h-3 w-3" />} label={t("setSpeedRampMontage")} onClick={() => ctxSpeed(speedRampRequest("montage"))} />
                    <CtxItem icon={<StepBack className="h-3 w-3" />} label={t("setSpeedRampHero")} onClick={() => ctxSpeed(speedRampRequest("hero"))} />
                    <CtxItem icon={<RotateCcw className="h-3 w-3" />} label={t("toggleReversePlayback")} onClick={() => ctxApply(getTimelineToggleReversePlaybackTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                    <CtxItem icon={<Snowflake className="h-3 w-3" />} label={t("toggleFreezeFrame")} onClick={() => ctxApply(getTimelineToggleFreezeFrameTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                  </>
                )}

                {/* Audio — video clips (embedded audio) and audio clips */}
                {ctxHasAudio && (
                  <>
                    <CtxSeparator />
                    {/* "Edit audio" lives in the first row of this menu. */}
                    {ctxIsVideo && (
                      <CtxItem
                        icon={<FileAudio className="h-3 w-3" />}
                        label={t("detachAudio")}
                        disabled={!canCreateCanvasClip}
                        onClick={() => {
                          if (!canCreateCanvasClip) return;
                          const detachAudioPlan = getTimelineDetachAudioPlan(clips as unknown as TimelineDuplicateClip[], rawTracks, ctxActionIds, ctxPrimaryId);
                          if (detachAudioPlan.updates.length > 0) onUpdateClips(detachAudioPlan.updates);
                          commitCanvasCreates(detachAudioPlan.creates, "clipUpdateFailed");
                          setCtxMenu(null);
                        }}
                      />
                    )}
                    <CtxItem icon={<VolumeX className="h-3 w-3" />} label={t("toggleClipMute")} onClick={() => ctxApply(getTimelineToggleClipMuteTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                    <CtxItem icon={<Volume2 className="h-3 w-3" />} label={t("resetClipVolume")} onClick={() => ctxApply(getTimelineResetClipVolumeTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                    <CtxItem icon={<PanelLeftClose className="h-3 w-3" />} label={t("setFadeInHalfSecond")} onClick={() => ctxApply(getTimelineSetFadeEdgeTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, "in", 0.5))} />
                    <CtxItem icon={<PanelRightClose className="h-3 w-3" />} label={t("setFadeOutHalfSecond")} onClick={() => ctxApply(getTimelineSetFadeEdgeTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, "out", 0.5))} />
                    <CtxItem icon={<RotateCcw className="h-3 w-3" />} label={t("clearFades")} onClick={() => ctxApply(getTimelineSetFadeTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, 0, 0))} />
                  </>
                )}

                {/* Transform — video and graphic/sticker clips */}
                {ctxIsVisual && (
                  <>
                    <CtxSeparator />
                    <CtxItem icon={<Replace className="h-3 w-3" />} label={t("toggleHorizontalFlip")} onClick={() => ctxApply(getTimelineToggleHorizontalFlipTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                    <CtxItem icon={<RotateCw className="h-3 w-3" />} label={t("rotateVisualClockwise")} onClick={() => ctxApply(getTimelineRotateVisualTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, 90))} />
                    <CtxItem icon={<RotateCcw className="h-3 w-3" />} label={t("resetVisualTransform")} onClick={() => ctxApply(getTimelineResetVisualTransformTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                    <CtxItem icon={<EyeOff className="h-3 w-3" />} label={t("toggleClipVisibility")} onClick={() => ctxApply(getTimelineToggleClipVisibilityTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                    <CtxItem icon={<EyeOff className="h-3 w-3" />} label={t("setOpacity50")} onClick={() => ctxApply(getTimelineSetVisualOpacityTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, 0.5))} />
                    <CtxItem icon={<EyeOff className="h-3 w-3" />} label={t("setOpacity100")} onClick={() => ctxApply(getTimelineSetVisualOpacityTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, 1))} />
                  </>
                )}

                {/* Text presets */}
                {ctxIsText && (
                  <>
                    <CtxSeparator />
                    <CtxItem icon={<Type className="h-3 w-3" />} label={t("setTextStyleTitle")} onClick={() => ctxApply(getTimelineSetTextStylePresetTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, "title"))} />
                    <CtxItem icon={<Type className="h-3 w-3" />} label={t("setTextStyleCaption")} onClick={() => ctxApply(getTimelineSetTextStylePresetTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, "caption"))} />
                    <CtxItem icon={<Type className="h-3 w-3" />} label={t("setTextStyleSubtitle")} onClick={() => ctxApply(getTimelineSetTextStylePresetTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId, "subtitle"))} />
                    <CtxItem icon={<EyeOff className="h-3 w-3" />} label={t("toggleClipVisibility")} onClick={() => ctxApply(getTimelineToggleClipVisibilityTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                  </>
                )}

                {/* Effect overlay */}
                {ctxIsEffect && (
                  <>
                    <CtxSeparator />
                    <CtxItem icon={<EyeOff className="h-3 w-3" />} label={t("toggleClipVisibility")} onClick={() => ctxApply(getTimelineToggleClipVisibilityTargetCommits(clips, rawTracks, ctxActionIds, ctxPrimaryId))} />
                  </>
                )}

                {/* Delete — shared by every clip type */}
                <CtxSeparator />
                <CtxItem
                  icon={<Trash2 className="h-3 w-3" />}
                  label={ctxIsText ? t(getTextTimelineClipLabelKey(contextClip, "delete") as MessageKey<"canvasTimeline">) : t("deleteClip")}
                  destructive
                  shortcut="⌫"
                  onClick={() => {
                    const plan = getTimelineDeleteBatchPlan(clips, rawTracks, ctxActionIds, () => false);
                    if (plan.deleteIds.length > 0) {
                      setSelectedClipIds(getTimelineSelectionAfterDelete(selectedClipIds, new Set(plan.deleteIds), clips, rawTracks));
                      onDeleteClips(plan.deleteIds);
                    }
                    setCtxMenu(null);
                  }}
                />
              </>
            );
          })()}

          {/* Empty track context menu */}
          {ctxMenu.hit.type === "track-empty" && (() => {
            const tk = ctxMenu.hit.trackKey || "";
            const trackType = tk.split("-")[0];
            const trackIndex = parseInt(tk.split("-")[1] || "1");
            const emptyTrackLayout = trackLayout.find((track) => track.key === tk);
            if (!isEditableTrackLayout(emptyTrackLayout)) return null;
            const renderEmptyTrackPasteItems = () => (
              <>
                <CtxItem
                  icon={<ClipboardPaste className="h-3 w-3" />}
                  label={t("pasteClip")}
                  disabled={!canCreateCanvasClip || !canPasteContextClipboard}
                  onClick={() => {
                    if (!canCreateCanvasClip) return;
                    const inputs = getEditableTimelinePasteInputs(
                      pasteTimelineClips(timelineClipboard, Math.max(0, ctxMenu.hit.time)),
                      rawTracks,
                      clips as unknown as TimelineDuplicateClip[],
                    );
                    if (inputs.length === 0) {
                      setCtxMenu(null);
                      return;
                    }
                    commitCanvasCreates(inputs, "pasteFailed");
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<MoveRight className="h-3 w-3" />}
                  label={t("insertPasteClips")}
                  disabled={!canCreateCanvasClip || !canPasteContextClipboard}
                  onClick={() => {
                    if (!canCreateCanvasClip) return;
                    const emptyTrackInsertPastePlan = getTimelineInsertPastePlan({
                      clipboard: timelineClipboard,
                      clips: clips as unknown as TimelineDuplicateClip[],
                      tracks: rawTracks,
                      startTime: Math.max(0, ctxMenu.hit.time),
                    });
                    commitCanvasInsertPastePlan(emptyTrackInsertPastePlan);
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<Replace className="h-3 w-3" />}
                  label={t("overwritePasteClips")}
                  disabled={!canCreateCanvasClip || !canPasteContextClipboard}
                  onClick={() => {
                    if (!canCreateCanvasClip) return;
                    const emptyTrackOverwritePastePlan = getTimelineOverwritePastePlan({
                      clipboard: timelineClipboard,
                      clips: clips as unknown as TimelineDuplicateClip[],
                      tracks: rawTracks,
                      startTime: Math.max(0, ctxMenu.hit.time),
                    });
                    commitCanvasOverwritePastePlan(emptyTrackOverwritePastePlan);
                    setCtxMenu(null);
                  }}
                />
              </>
            );
            // Right-click on EMPTY space of a video track → rich "add scene"
            // chooser. Shows each scene type with icon + description.
            if (trackType === "video") {
              const afterOrder = scenes.length - 1;
              // Place the new scene on the video track that was right-clicked
              // (trackKey is "video-<index>"), not always V1, starting at the
              // clicked time (push-right on the server resolves any overlap).
              const addSceneTrackIndex = Number(ctxMenu.hit.trackKey?.split("-").pop()) || 1;
              // Snap near-zero placements to exactly 0 — a 0.1s leftover from
              // the click position creates a visible start gap and a playhead/
              // preview mismatch the user can't explain.
              const addSceneAtSecondsRaw = Math.max(0, ctxMenu.hit.time);
              const addSceneAtSeconds = addSceneAtSecondsRaw < 0.25 ? 0 : addSceneAtSecondsRaw;
              const addSceneOpts = { trackIndex: addSceneTrackIndex, timelinePositionSeconds: addSceneAtSeconds };
              // URL sub-panel for Video clip or Still image.
              if (addSceneSub === "video-url" || addSceneSub === "image-url") {
                const isVideo = addSceneSub === "video-url";
                return (
                  <div className="w-full">
                    <div className="px-2.5 pt-1.5 pb-1 text-[9px] font-medium uppercase tracking-wide text-[#6B6B73]">
                      {isVideo ? t("videoClipPasteUrl") : t("stillImagePasteUrl")}
                    </div>
                    <div className="px-2.5 py-1.5 flex gap-1.5">
                      <input
                        type="url"
                        autoFocus
                        placeholder={isVideo ? "https://…/video.mp4" : "https://…/image.jpg"}
                        value={addSceneUrl}
                        onChange={(e) => setAddSceneUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && addSceneUrl.trim()) {
                            const u = addSceneUrl.trim();
                            onAddScene?.(afterOrder, isVideo
                              ? { cardType: "source_clip", sourceVideoUrl: u, ...addSceneOpts }
                              : { cardType: "image", startImageUrl: u, ...addSceneOpts });
                            setAddSceneUrl("");
                            setAddSceneSub(null);
                            setCtxMenu(null);
                          }
                          if (e.key === "Escape") {
                            setAddSceneSub("root");
                            setAddSceneUrl("");
                          }
                        }}
                        className="min-w-0 flex-1 bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.1)] rounded px-2 py-1 text-[10px] text-white outline-none focus:border-primary/50"
                      />
                      <button
                        className="px-2 py-1 text-[10px] font-medium rounded bg-primary/80 text-white hover:bg-primary transition-colors disabled:opacity-40"
                        disabled={!addSceneUrl.trim()}
                        onClick={() => {
                          const u = addSceneUrl.trim();
                          if (!u) return;
                          onAddScene?.(afterOrder, isVideo
                            ? { cardType: "source_clip", sourceVideoUrl: u, ...addSceneOpts }
                            : { cardType: "image", startImageUrl: u, ...addSceneOpts });
                          setAddSceneUrl("");
                          setAddSceneSub(null);
                          setCtxMenu(null);
                        }}
                      >
                        {t("add")}
                      </button>
                    </div>
                    <button
                      className="flex items-center gap-1 w-full px-2.5 py-1 text-[10px] text-[#8B8B93] hover:text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                      onClick={() => {
                        setAddSceneSub("root");
                        setAddSceneUrl("");
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2L3 5l3 3" /></svg>
                      {t("back")}
                    </button>
                  </div>
                );
              }
              return (
                <div className="w-full">
                  {canShowContextPasteActions ? (
                    <>
                      {renderEmptyTrackPasteItems()}
                      <CtxSeparator />
                    </>
                  ) : null}
                  <div className="px-2.5 pt-1.5 pb-1 text-[9px] font-medium uppercase tracking-wide text-[#6B6B73]">
                    {t("addScene")}
                  </div>
                  <RichCtxItem
                    title={t("aiVideo")}
                    icon={
                      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2l1.8 4.2L18 8l-4.2 1.8L12 14l-1.8-4.2L6 8l4.2-1.8L12 2z" />
                        <path d="M5 16l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z" />
                        <path d="M19 14l.8 1.6 1.6.8-1.6.8L19 19l-.8-1.8-1.6-.8 1.6-.8L19 14z" />
                      </svg>
                    }
                    iconTint="text-violet-400"
                    onClick={() => {
                      onAddScene?.(afterOrder, { cardType: "ai_video", ...addSceneOpts });
                      setCtxMenu(null);
                    }}
                  />
                  {/* Copy video — same Add-Scene tier as AI Video / Upload / etc.
                      Clicking creates a scene with cardType="copy_video" so the
                      dedicated Copy-Video panel (source upload, face detection,
                      character mapping) takes over. */}
                  <RichCtxItem
                    title={t("copyVideo")}
                    icon={
                      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="6" width="18" height="12" rx="2" />
                        <circle cx="9" cy="11" r="1.5" />
                        <path d="M12 11s1 1.5 2 1.5 2-1.5 2-1.5" />
                        <path d="M21 9l1 1-1 1" />
                      </svg>
                    }
                    iconTint="text-fuchsia-400"
                    onClick={() => {
                      onAddScene?.(afterOrder, { cardType: "copy_video", ...addSceneOpts });
                      setCtxMenu(null);
                    }}
                  />
                  <RichCtxItem
                    title={t("uploadVideo")}
                    icon={
                      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="5" width="20" height="14" rx="2" />
                        <path d="M10 9l5 3-5 3V9z" fill="currentColor" />
                      </svg>
                    }
                    iconTint="text-sky-400"
                    onClick={() => {
                      pendingSceneAddRef.current = { afterOrder, ...addSceneOpts };
                      sceneVideoFileInputRef.current?.click();
                      setCtxMenu(null);
                    }}
                  />
                  <RichCtxItem
                    title={t("videoUrl")}
                    icon={
                      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
                        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
                      </svg>
                    }
                    iconTint="text-cyan-400"
                    onClick={() => {
                      setAddSceneSub("video-url");
                      setAddSceneUrl("");
                    }}
                  />
                  <RichCtxItem
                    title={t("uploadImage")}
                    icon={
                      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <circle cx="9" cy="10" r="1.8" fill="currentColor" />
                        <path d="M3 17l5-4 4 3 4-3 5 4" />
                      </svg>
                    }
                    iconTint="text-emerald-400"
                    onClick={() => {
                      pendingSceneAddRef.current = { afterOrder, ...addSceneOpts };
                      sceneImageFileInputRef.current?.click();
                      setCtxMenu(null);
                    }}
                  />
                  <RichCtxItem
                    title={t("imageUrl")}
                    icon={
                      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
                        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
                      </svg>
                    }
                    iconTint="text-lime-400"
                    onClick={() => {
                      setAddSceneSub("image-url");
                      setAddSceneUrl("");
                    }}
                  />
                  <RichCtxItem
                    title={t("podcast")}
                    icon={
                      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="3" width="6" height="11" rx="3" />
                        <path d="M5 11a7 7 0 0 0 14 0" />
                        <path d="M12 18v3" />
                      </svg>
                    }
                    iconTint="text-orange-400"
                    onClick={() => {
                      onAddScene?.(afterOrder, { cardType: "podcast", ...addSceneOpts });
                      setCtxMenu(null);
                    }}
                  />
                </div>
              );
            }
            const typeLabel = trackType === "text" ? "text" : trackType === "audio" ? "audio" : trackType === "sticker" ? "sticker" : "video";
            if (trackType === "audio") {
              return (
                <>
                  <CtxItem
                    icon={<FolderOpen className="h-3 w-3" />}
                    label={t("importAudioFile")}
                    onClick={() => {
                      pendingAudioDropRef.current = { trackType, trackIndex, time: Math.max(0, ctxMenu.hit.time) };
                      audioFileInputRef.current?.click();
                      setCtxMenu(null);
                    }}
                  />
                  <CtxItem
                    icon={<Wand2 className="h-3 w-3" />}
                    label={t("generateMusic")}
                    onClick={() => {
                      openMusicPropertiesMode("music", ctxMenu.hit.time, trackIndex);
                      setCtxMenu(null);
                    }}
                  />
                  <CtxItem
                    icon={<FileAudio className="h-3 w-3" />}
                    label={t("generateSoundEffect")}
                    onClick={() => {
                      openMusicPropertiesMode("sfx", ctxMenu.hit.time, trackIndex);
                      setCtxMenu(null);
                    }}
                  />
                  {canShowContextPasteActions ? (
                    <>
                      <CtxSeparator />
                      {renderEmptyTrackPasteItems()}
                    </>
                  ) : null}
                </>
              );
            }
            if (trackType === "remotion") {
              // Graphics clips come from the Graphics gallery (they need a
              // template/prompt) — only offer paste here.
              return canShowContextPasteActions ? renderEmptyTrackPasteItems() : null;
            }
            if (trackType === "sticker") {
              return (
                <>
                  {canShowContextPasteActions ? (
                    <>
                      {renderEmptyTrackPasteItems()}
                      <CtxSeparator />
                    </>
                  ) : null}
                  <CtxItem
                    icon={<Plus className="h-3 w-3" />}
                    label={t("addImageSticker")}
                    onClick={() => {
                      pendingStickerDropRef.current = { trackIndex, time: Math.max(0, ctxMenu.hit.time) };
                      stickerFileInputRef.current?.click();
                      setCtxMenu(null);
                    }}
                  />
                </>
              );
            }
            return (
              <>
                {canShowContextPasteActions ? (
                  <>
                    {renderEmptyTrackPasteItems()}
                    <CtxSeparator />
                  </>
                ) : null}
                <CtxItem
                  icon={<Plus className="h-3 w-3" />}
                  label={t("addTypedClipHere", { type: typeLabel })}
                  onClick={() => {
                    commitCanvasCreates([{
                      trackType,
                      trackIndex,
                      startTime: Math.max(0, ctxMenu.hit.time),
                      endTime: Math.max(0, ctxMenu.hit.time) + 5,
                      textContent: trackType === "text" ? "Text" : null,
                      label: trackType === "text" ? "Text" : null,
                    }], "clipUpdateFailed");
                    setCtxMenu(null);
                  }}
                />
              </>
            );
          })()}

          {/* Music context menu */}
          {ctxMenu.hit.type === "music" && (() => {
            const a1TrackLayout = trackLayout.find((track) => track.key === "audio-1");
            if (!isEditableTrackLayout(a1TrackLayout)) return null;
            return (
              <>
                <CtxItem
                  icon={<FolderOpen className="h-3 w-3" />}
                  label={t("importAudioClip")}
                  onClick={() => {
                    pendingAudioDropRef.current = { trackType: "audio", trackIndex: 1, time: Math.max(0, ctxMenu.hit.time) };
                    audioFileInputRef.current?.click();
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<Wand2 className="h-3 w-3" />}
                  label={t("generateMusic")}
                  onClick={() => {
                    openMusicPropertiesMode("music", ctxMenu.hit.time, 1);
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<FileAudio className="h-3 w-3" />}
                  label={t("generateSoundEffect")}
                  onClick={() => {
                    openMusicPropertiesMode("sfx", ctxMenu.hit.time, 1);
                    setCtxMenu(null);
                  }}
                />
                <CtxItem
                  icon={<ArrowUpFromLine className="h-3 w-3" />}
                  label={t("musicProperties")}
                  onClick={() => {
                    openMusicPropertiesMode("music", ctxMenu.hit.time, 1);
                    setCtxMenu(null);
                  }}
                />
                {canShowContextPasteActions && (
                  <>
                    <CtxSeparator />
                    <CtxItem
                      icon={<ClipboardPaste className="h-3 w-3" />}
                      label={t("pasteClip")}
                      onClick={() => {
                        const inputs = getEditableTimelinePasteInputs(
                          pasteTimelineClips(timelineClipboard, Math.max(0, ctxMenu.hit.time)),
                          rawTracks,
                          clips as unknown as TimelineDuplicateClip[],
                        );
                        if (inputs.length === 0) {
                          setCtxMenu(null);
                          return;
                        }
                        commitCanvasCreates(inputs, "pasteFailed");
                        setCtxMenu(null);
                      }}
                    />
                    <CtxItem
                      icon={<MoveRight className="h-3 w-3" />}
                      label={t("insertPasteClips")}
                      onClick={() => {
                        const musicInsertPastePlan = getTimelineInsertPastePlan({
                          clipboard: timelineClipboard,
                          clips: clips as unknown as TimelineDuplicateClip[],
                          tracks: rawTracks,
                          startTime: Math.max(0, ctxMenu.hit.time),
                        });
                        commitCanvasInsertPastePlan(musicInsertPastePlan);
                        setCtxMenu(null);
                      }}
                    />
                    <CtxItem
                      icon={<Replace className="h-3 w-3" />}
                      label={t("overwritePasteClips")}
                      onClick={() => {
                        const musicOverwritePastePlan = getTimelineOverwritePastePlan({
                          clipboard: timelineClipboard,
                          clips: clips as unknown as TimelineDuplicateClip[],
                          tracks: rawTracks,
                          startTime: Math.max(0, ctxMenu.hit.time),
                        });
                        commitCanvasOverwritePastePlan(musicOverwritePastePlan);
                        setCtxMenu(null);
                      }}
                    />
                  </>
                )}
              </>
            );
          })()}
        </div>
        );
      })()}
    </div>
  );
}
