// Nonlinear editor timeline with canvas editing, tracks, and CapCut-style tool controls.
"use client";

import { Fragment, forwardRef, memo, useImperativeHandle, useRef, useMemo, useCallback, useState, useEffect, type ForwardedRef } from "react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { useEditorStore, useEditorStoreApi, useShallow } from "../hooks/use-editor-store";
import { useTimelineCallbacks } from "../hooks/use-timeline-callbacks";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useDocumentVisible } from "../hooks/use-document-visible";
import { useTimelineMedia } from "../hooks/use-timeline-media";
import { useTimelineShortcuts } from "../hooks/use-timeline-shortcuts";
import type { TimelineHandle } from "./timeline-handle";
import { useSceneFeatureAdapters, useSceneOverrideAdapters, useTimelineCommandAdapters, useTimelineDataProps } from "./adapters";
import { useTimelineToast } from "../hooks/use-timeline-toast";
import { TrackLabel } from "../parts/track-label";
import { AddTrackButton } from "../parts/add-track-button";
import { CanvasTimeline } from "./canvas/canvas-timeline";
import { sceneSourceSeconds, sceneTimelineSeconds } from "@opennan/timeline-core/timeline/scene-duration";
import { scenesToEngineItems } from "@opennan/timeline-core";
import { buildScenePositionWrites } from "@opennan/timeline-core/timeline/engine/persist";
import { resolveRippleDelete } from "@opennan/timeline-core/timeline/engine/ripple";
import { contentEnd } from "@opennan/timeline-core/timeline/engine/layout";
import { zoomTo, contentWidthPx, MAX_PX_PER_SECOND, resolveWheelZoomStep } from "@opennan/timeline-core/timeline/engine/viewport";
import type { EngineItem, Viewport } from "@opennan/timeline-core/timeline/engine/types";
import { resolveMove } from "@opennan/timeline-core/timeline/engine/move";
import {
  getTimelineTrackHeight,
  getTimelineTrackSortWeight,
  TIMELINE_CONTEXT_MENU_CLASS,
  TIMELINE_CONTEXT_MENU_DANGER_ITEM_CLASS,
  TIMELINE_CONTEXT_MENU_ITEM_CLASS,
  TIMELINE_CONTEXT_MENU_SEPARATOR_CLASS,
  TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS,
  TIMELINE_TOOLBAR_ADD_BUTTON_CLASS,
  TIMELINE_TOOLBAR_BUTTON_ACTIVE_CLASS,
  TIMELINE_TOOLBAR_BUTTON_CLASS,
  TIMELINE_TOOLBAR_BUTTON_DANGER_CLASS,
  TIMELINE_TOOLBAR_CORE_EDIT_GROUP_CLASS,
  TIMELINE_TOOLBAR_ICON_CLASS,
  TIMELINE_TOOLBAR_LEFT_RAIL_CLASS,
  TIMELINE_TOOLBAR_MENU_ITEM_CLASS,
  TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS,
  TIMELINE_TOOLBAR_RIGHT_RAIL_CLASS,
  TIMELINE_TOOLBAR_ROW_CLASS,
  TIMELINE_TOOLBAR_SEPARATOR_CLASS,
  TIMELINE_TOOLBAR_STICKY_MENU_TRIGGER_CLASS,
} from "@opennan/timeline-core/timeline/nle-timeline-layout";
import { parseShotBreakdown, totalShotDuration } from "@opennan/timeline-core/lib/shot-utils";
import { parseSubtitleFile, getTimelineSubtitleImportInputs, splitSubtitleCuesIntoWords } from "@opennan/timeline-core/lib/subtitle-import";
import { StickerPicker } from "../parts/sticker-picker";
import type { TimelineTrack, TimelineClip } from "@opennan/timeline-core/model/timeline";
import type { ClipCommit } from "@opennan/timeline-core/timeline/canvas/types";
import {
  commitTimelineClipCommand,
  commitTimelineClipCreates,
  commitTimelineClipSplits,
  commitTimelineClipUpdates,
  type TimelineClipCreateInput,
  type TimelineClipUpdateCommit,
} from "@opennan/timeline-core/lib/timeline-commits";
import { buildOptimisticClipEffect, type ClipEffect } from "@opennan/timeline-core";
import { loadAudioDuration } from "@opennan/timeline-media/audio-duration";
import { nextTrackForType, resolveNonOverlappingTrackIndex, setTimelineTrackVolume, swapTimelineTrackOrder } from "@opennan/timeline-core/lib/timeline-tracks";
import { defaultPropsFor, templateById } from "../remotion/templates";
import { addStickerClip } from "../editing/library/stickers-tab";
import { clipJunction } from "@opennan/timeline-core/looks/windows";
import { TEXT_TEMPLATE_DRAG_KIND, addTextFromTemplate } from "../editing/library/text-library";
import {
  buildSceneTimelineTrimCardConfig,
  defaultTracks,
  getEditableSceneTransitionTarget,
  getSceneAudioUrl,
  getSceneContentDuration,
  getSceneDuration,
  getSceneStart,
  getSceneTimelineTrimStart,
  isContentBackedScene,
  parseSceneCardConfig,
  getTimelineContextMenuStyle,
  stripVoiceoverLayersFromCardConfig,
  withRequiredBaseTimelineTracks,
  withSceneVideoTracks,
  type EffectDropPreviewLabel,
  type NleTimelineProps,
  type SceneData,
  type TimelineConfirmRequest,
} from "./nle-timeline-utils";
import {
  canPasteTimelineClipboard,
  copyTimelineClips,
  cutTimelineClips,
  duplicateTimelineClips,
  DEFAULT_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  getEditableTimelinePasteInputs,
  getEditableTimelineSelectionClipIds,
  getTimelineCopyTargetClipIds,
  getTimelineCloseGapPlan,
  getTimelineDeleteBatchPlan,
  getTimelineFitZoom,
  getNextTimelineZoom,
  getTimelineAddTextClipInput,
  getTimelinePlayheadCenterScrollLeft,
  getTimelineSelectionFitScrollLeft,
  getTimelineSelectionFitZoom,
  getTimelineRangeSelectionClipIds,
  getTimelinePasteTargetTime,
  getTimelineSelectionAfterDelete,
  getEditableTimelineClipIds,
  getTimelineSetTransitionPresetTargetCommits,
  getTimelineTransitionPresetUpdate,
  normalizeTimelineTransitionType,
  getTimelineSetVisualCropTargetCommits,
  getTimelineRotateVisualTargetCommits,
  getTimelineDeleteTrackUpdates,
  getTimelineToggleHorizontalFlipTargetCommits,
  getTimelineToggleFreezeFrameTargetCommits,
  getTimelineToggleReversePlaybackTargetCommits,
  getTimelineBladeSplitClipId,
  getTimelineBladeSplitClipIdsAtTime,
  getTimelineSplitAllTrackClipIdsAtPlayhead,
  getTimelineSplitTargetAtNearestMarker,
  getTimelineSplitTargetClipIdsAtPlayhead,
  getTimelineTrackSplitTargetClipIdsAtPlayhead,
  getTimelineTrimTargetCommitsToPlayhead,
  pasteTimelineClips,
  rippleDeleteTimelineClips,
  resolveTimelineDropStart,
  type TimelineDuplicateClip,
} from "@opennan/timeline-core/lib/timeline-editing";
import {
  Film,
  Music,
  Plus,
  ZoomIn,
  ZoomOut,
  Undo2,
  Redo2,
  Split,
  Copy,
  Crop,
  ClipboardCopy,
  ClipboardPaste,
  ClipboardX,
  Trash2,
  Eye,
  EyeOff,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  ListCollapse,
  PanelLeftClose,
  PanelRightClose,
  ChevronFirst,
  ChevronLast,
  Magnet,
  MousePointer2,
  Type,
  ImagePlus,
  AlignHorizontalJustifyStart,
  Wand2,
  Crosshair,
  Flag,
  FlipHorizontal2,
  Lock,
  Unlock,
  MoreHorizontal,
  Snowflake,
  SquareScissors,
  ChevronRight,
  Image as ImageIcon,
  Sparkles,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/** Tooltip-wrapped icon button for the toolbar. */
function TipBtn({
  tip,
  shortcut,
  onClick,
  disabled,
  disabledReason,
  className,
  pressed,
  hint,
  testId,
  children,
}: {
  tip: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
  /** A toggle's state (aria-pressed). */
  pressed?: boolean;
  /** A second line in the tooltip. */
  hint?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-flex"
      >
        <button
          type="button"
          aria-label={shortcut ? `${tip} (${shortcut})` : tip}
          aria-pressed={pressed}
          data-testid={testId}
          onClick={onClick}
          disabled={disabled}
          className={`inline-flex items-center justify-center disabled:cursor-not-allowed ${className || ""}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-56 flex-col items-start">
        <span>
          {tip}
          {shortcut && (
            <kbd className="ml-1.5 inline-flex h-4 items-center rounded border border-[rgba(255,255,255,0.15)] bg-[rgba(255,255,255,0.06)] px-1 font-mono text-[9px] text-[#999]">
              {shortcut}
            </kbd>
          )}
        </span>
        {hint && (
          <span className="text-[10px] leading-tight opacity-70">{hint}</span>
        )}
        {disabled && disabledReason && (
          <span className="text-[10px] leading-tight opacity-70">{disabledReason}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** The magnet with beat dots: Snap to beats (phase 11). Lucide's magnet, drawn smaller, over three dots. */
function BeatMagnetIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform="translate(2 0) scale(0.78)">
        <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15" />
        <path d="m5 8 4 4" />
        <path d="m12 15 4 4" />
      </g>
      <circle cx="4" cy="21" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="21" r="1" fill="currentColor" stroke="none" />
      <circle cx="20" cy="21" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Track types offered by the layer list's right-click "Insert layer" entry —
// the same set as the toolbar's Add track button, kept here so the two menus
// cannot drift apart in what they can create.
const TRACK_INSERT_OPTIONS = [
  { type: "video" as const, labelKey: "videoTrack" as const, icon: Film, color: "text-blue-400" },
  { type: "audio" as const, labelKey: "audioTrack" as const, icon: Music, color: "text-emerald-400" },
  { type: "text" as const, labelKey: "textTrack" as const, icon: Type, color: "text-amber-400" },
  { type: "sticker" as const, labelKey: "stickerTrack" as const, icon: ImageIcon, color: "text-pink-400" },
  { type: "effect" as const, labelKey: "effectTrack" as const, icon: Wand2, color: "text-purple-400" },
  { type: "remotion" as const, labelKey: "graphicsTrack" as const, icon: Sparkles, color: "text-white/80" },
];

function NleTimelineImpl({
  shortcutsEnabled = true,
}: NleTimelineProps, ref: ForwardedRef<TimelineHandle>) {
  const { scenes, selectedSceneId, musicUrl, onSelectScene, timelineTracks, timelineClips } = useTimelineDataProps();
  const { onCreateClip, onStartCreateClip, onCreateClips, onUpdateClip, onUpdateClips, onDeleteClip, onDeleteClips, onCommitClipCommand, onSplitClip, onSplitClips, onUpdateTracks, onUndo, onRedo } = useTimelineCommandAdapters();
  const timelineController = useTimelineController();
  const { onSceneOverridesUpdate, onLocalScenePatch } = useSceneOverrideAdapters();
  const { onSaveToSources, onUpdateSceneTransform, onSetSceneTransition } = useSceneFeatureAdapters();
  const t = useTimelineMessages("timeline");
  const tAddTrack = useTimelineMessages("addTrack");
  const docVisible = useDocumentVisible();
  const storeApi = useEditorStoreApi();
  // Local preview of an effect row on a temp clip (was the onClipEffectsAttached host prop).
  const onClipEffectsAttached = useCallback((clipId: string, effects: ClipEffect[]) => {
    const s = storeApi.getState();
    const data = s.timelineData;
    if (!data) return;
    s.setTimelineData({ ...data, clips: data.clips.map((clip) => (clip.id === clipId ? { ...clip, effects } : clip)) });
  }, [storeApi]);
  const callbacks = useTimelineCallbacks();
  const toast = useTimelineToast();
  const media = useTimelineMedia();
  // Use useShallow to prevent re-renders on currentTime changes (60fps during playback)
  // currentTime is read via getState() in event handlers instead
  const {
    timelineZoom,
    setTimelineZoom,
    setSeekRequest,
    setCurrentTime,
    selectedClipId,
    selectedClipIds,
    setSelectedClipIds,
    selectClip,
    selectedTransition,
    clearTransitionSelection,
    clearSelection,
    canUndo,
    canRedo,
    selectedAudioTarget,
    selectAudioTarget,
    setShuttleSpeed,
    musicVolume,
    snapEnabled,
    setSnapEnabled,
    snapToBeats,
    toolMode,
    setToolMode,
    addTextRequest,
    setAddTextRequest,
    addImageRequest,
    setAddImageRequest,
    timelineMarkers,
    addTimelineMarker,
    removeTimelineMarkerNear,
    timelineClipboard,
    setTimelineClipboard,
  } = useEditorStore(useShallow((s) => ({
    timelineZoom: s.timelineZoom,
    setTimelineZoom: s.setTimelineZoom,
    setSeekRequest: s.setSeekRequest,
    setCurrentTime: s.setCurrentTime,
    selectedClipId: s.selectedClipId,
    selectedClipIds: s.selectedClipIds,
    setSelectedClipIds: s.setSelectedClipIds,
    selectClip: s.selectClip,
    selectedTransition: s.selectedTransition,
    clearTransitionSelection: s.clearTransitionSelection,
    clearSelection: s.clearSelection,
    canUndo: s.canUndo,
    canRedo: s.canRedo,
    selectedAudioTarget: s.selectedAudioTarget,
    selectAudioTarget: s.selectAudioTarget,
    setShuttleSpeed: s.setShuttleSpeed,
    musicVolume: s.musicVolume,
    snapEnabled: s.snapEnabled,
    setSnapEnabled: s.setSnapEnabled,
    snapToBeats: s.snapToBeats,
    toolMode: s.toolMode,
    setToolMode: s.setToolMode,
    addTextRequest: s.addTextRequest,
    setAddTextRequest: s.setAddTextRequest,
    addImageRequest: s.addImageRequest,
    setAddImageRequest: s.setAddImageRequest,
    timelineMarkers: s.timelineMarkers,
    addTimelineMarker: s.addTimelineMarker,
    removeTimelineMarkerNear: s.removeTimelineMarkerNear,
    timelineClipboard: s.timelineClipboard,
    setTimelineClipboard: s.setTimelineClipboard,
  })));
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const zoomScrollFrameRef = useRef<number | null>(null);
  const timelineConfirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  // One controller per in-flight drop probe — concurrent drops must not cancel
  // each other; the set exists only so unmount can abort whatever is left.
  const trackDropAudioDurationAbortRef = useRef<Set<AbortController>>(new Set());
  const [musicDuration, setMusicDuration] = useState(0);
  const [timelineConfirm, setTimelineConfirm] = useState<TimelineConfirmRequest | null>(null);
  const [effectDropPreviewLabel, setEffectDropPreviewLabel] = useState<EffectDropPreviewLabel | null>(null);

  const requestTimelineConfirm = useCallback((request: TimelineConfirmRequest) => (
    new Promise<boolean>((resolve) => {
      timelineConfirmResolveRef.current?.(false);
      timelineConfirmResolveRef.current = resolve;
      setTimelineConfirm(request);
    })
  ), []);

  const resolveTimelineConfirm = useCallback((confirmed: boolean) => {
    timelineConfirmResolveRef.current?.(confirmed);
    timelineConfirmResolveRef.current = null;
    setTimelineConfirm(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setMusicDuration(0);
    if (!musicUrl || !docVisible) return;
    loadAudioDuration(musicUrl, { resolveUrl: media.resolveMediaUrl, signal: controller.signal }).then((duration) => {
      if (!controller.signal.aborted) setMusicDuration(duration);
    });
    return () => {
      controller.abort();
    };
  }, [musicUrl, docVisible, media]);

  useEffect(() => () => {
    for (const controller of trackDropAudioDurationAbortRef.current) controller.abort();
    trackDropAudioDurationAbortRef.current.clear();
  }, []);

  const contentDuration = useMemo(() => {
    let sceneMaxEnd = 0;
    let clipMaxEnd = 0;
    let audioMaxEnd = 0;
    for (let i = 0; i < scenes.length; i++) {
      sceneMaxEnd = Math.max(sceneMaxEnd, getSceneStart(scenes[i], scenes, i) + getSceneDuration(scenes[i]));
    }
    for (const clip of timelineClips ?? []) {
      // Skip hidden tracks — the preview filters them out, so counting them
      // here would advertise a seekable range the preview immediately clamps.
      const track = timelineTracks?.find((t) => t.type === clip.trackType && t.index === clip.trackIndex);
      if (track?.visible === false) continue;
      if (clip.trackType === "audio") {
        audioMaxEnd = Math.max(audioMaxEnd, Number(clip.endTime || 0));
        continue;
      }
      clipMaxEnd = Math.max(clipMaxEnd, Number(clip.endTime || 0));
    }
    // Visual clips can extend past the last scene (e.g. a sticker appended at
    // the end) — the playhead must reach them, so take the max instead of
    // letting scenes win outright. Audio stays fallback-only so a long music
    // bed doesn't stretch the timeline.
    const visualMaxEnd = Math.max(sceneMaxEnd, clipMaxEnd);
    return visualMaxEnd > 0 ? visualMaxEnd : audioMaxEnd;
  }, [scenes, timelineClips, timelineTracks]);
  // Keep the timeline scaled to the edit, not the full background music file.
  // Long music can still play underneath, but it should not turn a 15s visual
  // sequence into a multi-minute scroll surface.
  const totalDuration = contentDuration > 0 ? contentDuration : musicDuration;

  // Fit-to-content on open, then hands off. Two past bugs live here:
  //  1. The old effect only ever SHRANK zoom, so a small zoom carried over
  //     from a longer project left a fresh-open project rendered tiny.
  //  2. Its delayed timers kept re-fitting for 3s and overrode the user's own
  //     zoom ("I zoom in and it snaps back"). Once the user zooms manually,
  //     auto-fit must never touch the zoom again for this mount.
  const userZoomedRef = useRef(false);
  //  3. Keying the effect on totalDuration meant every edit that extended the
  //     timeline (dragging a clip right) re-ran auto-fit and rescaled all
  //     clips mid-edit. Fit exactly once per mount, then never again.
  const autoFitDoneRef = useRef(false);
  useEffect(() => {
    if (totalDuration <= 0) return;
    const applyAutoFit = () => {
      if (userZoomedRef.current || autoFitDoneRef.current) return;
      const container = scrollContainerRef.current;
      if (!container || container.clientWidth <= 0) return;
      const fitZoom = getTimelineFitZoom(container.clientWidth, totalDuration);
      if (fitZoom === null) return;
      autoFitDoneRef.current = true;
      const target = Math.min(MAX_PX_PER_SECOND, Math.max(fitZoom, MIN_TIMELINE_ZOOM));
      const currentZoom = storeApi.getState().timelineZoom;
      if (Math.abs(currentZoom - target) > 0.5) setTimelineZoom(target);
    };
    const timeoutIds = [0, 500].map((delay) => window.setTimeout(applyAutoFit, delay));
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(applyAutoFit) : null;
    if (scrollContainerRef.current) observer?.observe(scrollContainerRef.current);
    return () => {
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      observer?.disconnect();
    };
  }, [setTimelineZoom, totalDuration]);

  const selectedTimelineScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedSceneId) ?? null,
    [scenes, selectedSceneId],
  );
  const hasSelectedScene = Boolean(selectedTimelineScene);
  const effectiveTimelineTracks = useMemo(
    () => (timelineTracks?.length
      ? withSceneVideoTracks(withRequiredBaseTimelineTracks(timelineTracks).tracks, scenes, timelineClips)
      : []),
    [timelineTracks, scenes, timelineClips],
  );

  // Sort tracks: text/sticker/remotion/effect → video → audio. Video tracks stack bottom-up
  // (V1 visually lowest, V2 above it) so on-screen position matches the
  // compositor z-order. Other types keep ascending index.
  const sortedTracks = useMemo(() => {
    if (!effectiveTimelineTracks.length) return [];
    return [...effectiveTimelineTracks].sort((a, b) => {
      const typeA = getTimelineTrackSortWeight(a.type);
      const typeB = getTimelineTrackSortWeight(b.type);
      if (typeA !== typeB) return typeA - typeB;
      if (a.type === "video") return b.index - a.index;
      return a.index - b.index;
    });
  }, [effectiveTimelineTracks]);
  const handleEffectDropPreviewChange = useCallback((
    preview: { trackIndex: number; h: number; trackMissing: boolean } | null,
  ) => {
    setEffectDropPreviewLabel(preview?.trackMissing
      ? { trackIndex: preview.trackIndex, height: preview.h }
      : null);
  }, []);
  const hasRealPreviewEffectTrack = useMemo(() => (
    effectDropPreviewLabel
      ? sortedTracks.some((track) => track.type === "effect" && track.index === effectDropPreviewLabel.trackIndex)
      : false
  ), [effectDropPreviewLabel, sortedTracks]);
  const editableSelectedClipIds = useMemo(() => (
    getEditableTimelineSelectionClipIds(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
    )
  ), [selectedClipId, selectedClipIds, timelineClips, timelineTracks]);
  const hasEditableClipSelection = editableSelectedClipIds.size > 0;
  const copyTargetClipIds = useMemo(() => (
    getTimelineCopyTargetClipIds(selectedClipIds, selectedClipId, timelineClips || [], timelineTracks || [])
  ), [selectedClipId, selectedClipIds, timelineClips, timelineTracks]);
  const hasCopyTargetClipSelection = copyTargetClipIds.size > 0;
  const canPasteClipboard = canPasteTimelineClipboard(timelineClipboard, timelineTracks || []);
  const canCreateTimelineClip = Boolean(onCreateClip || onStartCreateClip || onCreateClips);
  const canDeleteTimelineClip = Boolean(onDeleteClip || onDeleteClips);
  const canUpdateTimelineClip = Boolean(onUpdateClip || onUpdateClips);
  const canSplitTimelineClip = Boolean(onSplitClip || onSplitClips);
  const canClearSelectedTransition = selectedTransition?.kind === "scene"
    ? Boolean(onSetSceneTransition)
    : selectedTransition?.kind === "clip"
      ? canUpdateTimelineClip
      : false;
  const needsEditableClipReason = t("selectEditableClipsFirst");
  const needsCopyableClipReason = t("selectCopyableClipsFirst");
  const needsClipboardReason = t("copyClipsFirst");
  const undoUnavailableReason = t("nothingToUndo");
  const redoUnavailableReason = t("nothingToRedo");
  const createUnavailableReason = t("timelineCreateUnavailable");
  const deleteUnavailableReason = t("timelineDeleteUnavailable");
  const updateUnavailableReason = t("timelineUpdateUnavailable");
  const splitUnavailableReason = t("timelineSplitUnavailable");
  const markerRangeReason = t("setMarkerRangeFirst");
  const needsClipOrSceneReason = t("selectEditableClipOrSceneFirst");
  const undoDisabledReason = !canUndo ? undoUnavailableReason : undefined;
  const redoDisabledReason = !canRedo ? redoUnavailableReason : undefined;
  const duplicateDisabledReason = !hasEditableClipSelection ? needsEditableClipReason : !canCreateTimelineClip ? createUnavailableReason : undefined;
  const copyDisabledReason = !hasCopyTargetClipSelection ? needsCopyableClipReason : undefined;
  const cutDisabledReason = !hasEditableClipSelection ? needsEditableClipReason : !canDeleteTimelineClip ? deleteUnavailableReason : undefined;
  const pasteDisabledReason = !canPasteClipboard ? needsClipboardReason : !canCreateTimelineClip ? createUnavailableReason : undefined;
  const selectionOnlyDisabledReason = !hasEditableClipSelection ? needsEditableClipReason : undefined;
  const selectionEditDisabledReason = !hasEditableClipSelection ? needsEditableClipReason : !canUpdateTimelineClip ? updateUnavailableReason : undefined;
  const canDeleteToolbarSelection = Boolean(selectedTransition && canClearSelectedTransition) || hasSelectedScene || (hasEditableClipSelection && canDeleteTimelineClip);
  const deleteToolbarDisabledReason = selectedTransition && !canClearSelectedTransition
    ? updateUnavailableReason
    : !hasEditableClipSelection && !hasSelectedScene && !selectedTransition
    ? needsClipOrSceneReason
    : hasEditableClipSelection && !canDeleteTimelineClip
      ? deleteUnavailableReason
      : undefined;
  const canSceneClipToolSelection = hasSelectedScene || (hasEditableClipSelection && canUpdateTimelineClip);
  const sceneClipToolDisabledReason = !hasEditableClipSelection && !hasSelectedScene
    ? needsClipOrSceneReason
    : hasEditableClipSelection && !canUpdateTimelineClip
      ? updateUnavailableReason
      : undefined;
  const canCropToolbarSelection = (hasEditableClipSelection && canUpdateTimelineClip) || (hasSelectedScene && Boolean(onUpdateSceneTransform));
  const cropToolbarDisabledReason = !hasEditableClipSelection && !hasSelectedScene
    ? needsClipOrSceneReason
    : hasSelectedScene && !onUpdateSceneTransform
      ? updateUnavailableReason
      : hasEditableClipSelection && !canUpdateTimelineClip
        ? updateUnavailableReason
        : undefined;
  const splitDisabledReason = !canSplitTimelineClip ? splitUnavailableReason : undefined;
  const markerDisabledReason = !canSplitTimelineClip ? splitUnavailableReason : timelineMarkers.length === 0 ? markerRangeReason : undefined;
  const deleteEditDisabledReason = !hasEditableClipSelection ? needsEditableClipReason : !canDeleteTimelineClip ? deleteUnavailableReason : !canUpdateTimelineClip ? updateUnavailableReason : undefined;
  const selectCreatedSplitClips = useCallback((created: ({ id?: string | null } | null)[]) => {
    const ids = created
      .map((createdClip) => createdClip?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length > 0) setSelectedClipIds(new Set(ids));
  }, [setSelectedClipIds]);
  const handleCreateTimelineClip = useCallback((input: TimelineClipCreateInput) => {
    if (!canCreateTimelineClip) return;
    // Snapshot BEFORE the async create: placing a clip must never steal an
    // existing selection or flip the user's active properties panel.
    const preState = storeApi.getState();
    const hadSelection = preState.selectedClipIds.size > 0 || preState.selectedClipId !== null ||
      preState.selectedSceneId !== null || preState.selectedTransition !== null || preState.selectedAudioTarget !== null;
    void commitTimelineClipCreates([input], { createClip: onCreateClip, createClips: onCreateClips }).then((created) => {
      const ids = created
        .map((createdClip) => createdClip?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length === 0) toast.error(t("clipCreateFailed"));
      if (ids.length > 0 && !hadSelection) setSelectedClipIds(new Set(ids));
    }).catch(() => toast.error(t("clipCreateFailed")));
  }, [canCreateTimelineClip, onCreateClip, onCreateClips, setSelectedClipIds, t]);

  const clearZoomScrollFrame = useCallback(() => {
    if (zoomScrollFrameRef.current === null) return;
    cancelAnimationFrame(zoomScrollFrameRef.current);
    zoomScrollFrameRef.current = null;
  }, []);
  const requestZoomScrollFrame = useCallback((applyScroll: () => void) => {
    clearZoomScrollFrame();
    zoomScrollFrameRef.current = requestAnimationFrame(() => {
      zoomScrollFrameRef.current = null;
      applyScroll();
    });
  }, [clearZoomScrollFrame]);
  useEffect(() => {
    return () => clearZoomScrollFrame();
  }, [clearZoomScrollFrame]);

  // Every zoom entry point (buttons, ctrl/cmd+wheel, pinch-to-zoom which the
  // browser also reports as a ctrl+wheel event) composes through the engine's
  // zoomAt, reading the CURRENT viewport (store zoom + live DOM scrollLeft/
  // clientWidth) instead of a value captured at mount or a stale closure —
  // that mismatch was the "zoom stops responding after one step" bug.
  const zoomToTarget = useCallback((targetPxPerSecond: number, anchorPx: number) => {
    userZoomedRef.current = true;
    const container = scrollContainerRef.current;
    if (!container) return;
    const currentZoom = storeApi.getState().timelineZoom;
    if (targetPxPerSecond === currentZoom) return;
    const vp: Viewport = {
      pxPerSecond: currentZoom,
      scrollX: container.scrollLeft,
      viewportWidthPx: container.clientWidth,
    };
    const contentEndSeconds = Math.max(totalDuration, contentEnd(scenesToEngineItems(scenes)));
    // Use zoomTo (exact target) rather than zoomAt (factor = target/current,
    // then current*factor) — the discrete zoom-level table's target value is
    // already known exactly, and round-tripping it through a division then a
    // multiplication reintroduces floating-point error that poisons the next
    // level-table comparison. See zoomTo's docstring in engine/viewport.ts.
    const next = zoomTo(vp, targetPxPerSecond, anchorPx, contentEndSeconds);
    setTimelineZoom(next.pxPerSecond);
    requestZoomScrollFrame(() => {
      container.scrollLeft = next.scrollX;
    });
  }, [requestZoomScrollFrame, scenes, setTimelineZoom, totalDuration]);

  const handleZoomIn = useCallback(() => {
    const container = scrollContainerRef.current;
    const currentZoom = storeApi.getState().timelineZoom;
    const anchorPx = container ? container.clientWidth / 2 : 0;
    zoomToTarget(getNextTimelineZoom(currentZoom, 1), anchorPx);
  }, [zoomToTarget]);
  const handleZoomOut = useCallback(() => {
    const container = scrollContainerRef.current;
    const currentZoom = storeApi.getState().timelineZoom;
    const anchorPx = container ? container.clientWidth / 2 : 0;
    zoomToTarget(getNextTimelineZoom(currentZoom, -1), anchorPx);
  }, [zoomToTarget]);
  const handleZoomFit = useCallback(() => {
    userZoomedRef.current = true;
    const container = scrollContainerRef.current;
    if (!container || totalDuration <= 0) return;
    const nextZoom = getTimelineFitZoom(container.clientWidth, totalDuration);
    if (nextZoom === null) return;
    // Compose through the engine's zoomTo (same as zoomToTarget) so the
    // MAX_PX_PER_SECOND clamp and scroll clamp are applied consistently
    // instead of a bespoke Math.min with no scroll clamping.
    const contentEndSeconds = Math.max(totalDuration, contentEnd(scenesToEngineItems(scenes)));
    const vp: Viewport = {
      pxPerSecond: storeApi.getState().timelineZoom,
      scrollX: 0,
      viewportWidthPx: container.clientWidth,
    };
    const next = zoomTo(vp, nextZoom, 0, contentEndSeconds);
    setTimelineZoom(next.pxPerSecond);
    requestZoomScrollFrame(() => {
      container.scrollLeft = next.scrollX;
    });
  }, [requestZoomScrollFrame, scenes, setTimelineZoom, totalDuration]);

  const handleZoomFitSelection = useCallback(() => {
    userZoomedRef.current = true;
    const container = scrollContainerRef.current;
    if (!container) return;
    const nextZoom = getTimelineSelectionFitZoom(
      container.clientWidth,
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
    );
    if (nextZoom === null) return;
    const clampedZoom = Math.min(MAX_PX_PER_SECOND, nextZoom);
    const nextScrollLeft = getTimelineSelectionFitScrollLeft(
      container.clientWidth,
      clampedZoom,
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
    );
    setTimelineZoom(clampedZoom);
    if (nextScrollLeft !== null) {
      requestZoomScrollFrame(() => {
        container.scrollLeft = nextScrollLeft;
      });
    }
  }, [requestZoomScrollFrame, selectedClipId, selectedClipIds, setTimelineZoom, timelineClips, timelineTracks]);

  const handleCenterPlayhead = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const nextScrollLeft = getTimelinePlayheadCenterScrollLeft(
      container.clientWidth,
      timelineZoom,
      storeApi.getState().currentTime,
    );
    if (nextScrollLeft !== null) container.scrollLeft = nextScrollLeft;
  }, [timelineZoom]);

  // Ctrl/cmd+wheel zoom gestures can deliver more than one wheel event per
  // intended "step" — Chromium synthesizes ctrl+wheel as a smooth page-zoom
  // gesture split into a burst of several wheel events with smaller deltaY
  // ticks, and some CDP/CI configurations replay a gesture as multiple
  // events too. Stepping a full discrete zoom level per *event* let one
  // gesture silently consume two-or-more table levels while the opposing
  // gesture only consumed one, so alternating in/out gestures didn't invert
  // each other and the zoom drifted until it got stuck at a level boundary
  // (typically the table minimum) it could no longer escape symmetrically —
  // this was the "zoom freezes" bug. Fix: accumulate deltaY across all wheel
  // events observed within one animation frame and resolve the *net*
  // direction once via resolveWheelZoomStep, so a burst belonging to a single
  // gesture can only ever produce at most one level step.
  const wheelZoomAccumRef = useRef<{ deltaSum: number; pointerXInTimeline: number; rafId: number | null }>({
    deltaSum: 0,
    pointerXInTimeline: 0,
    rafId: null,
  });

  const flushWheelZoom = useCallback(() => {
    const accum = wheelZoomAccumRef.current;
    accum.rafId = null;
    const dir = resolveWheelZoomStep(accum.deltaSum);
    const pointerXInTimeline = accum.pointerXInTimeline;
    accum.deltaSum = 0;
    if (dir === 0) return;
    const currentZoom = storeApi.getState().timelineZoom;
    const nextZoom = getNextTimelineZoom(currentZoom, dir);
    if (nextZoom === currentZoom) {
      // The discrete zoom-level table has no entry below MIN_TIMELINE_ZOOM,
      // but a fit-to-content zoom (e.g. on load, for a short project) can
      // already sit *below* that nominal floor (a continuous value, not a
      // table level). Zooming in from there correctly climbs to the lowest
      // table entry above it, but the very next zoom-out then landed exactly
      // on that same table floor with "nowhere lower to go" — a hard dead
      // end even though the true content-fit minimum is still lower. Instead
      // of no-op'ing, target the actual floor: zoomToTarget clamps against
      // the same minPps zoomTo/zoomAt already use, so this either recovers
      // the pre-table-entry fit zoom or is a genuine no-op if we're truly at
      // the content-fit floor already.
      if (dir === -1 && currentZoom <= MIN_TIMELINE_ZOOM) {
        zoomToTarget(0, pointerXInTimeline);
      }
      return;
    }
    zoomToTarget(nextZoom, pointerXInTimeline);
  }, [zoomToTarget]);

  useEffect(() => {
    return () => {
      const accum = wheelZoomAccumRef.current;
      if (accum.rafId !== null) cancelAnimationFrame(accum.rafId);
    };
  }, []);

  const handleTimelineWheel = useCallback((e: WheelEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Plain wheel / trackpad → horizontal ("landscape") timeline scroll.
    // Map the dominant axis to scrollLeft so a mouse wheel (deltaY) and a
    // trackpad swipe (deltaX) both move the timeline left/right. Only when the
    // timeline actually overflows horizontally, so vertical/page scroll is
    // left alone otherwise.
    if (!e.ctrlKey && !e.metaKey) {
      const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta !== 0 && container.scrollWidth > container.clientWidth) {
        e.preventDefault();
        container.scrollLeft += delta;
      }
      return;
    }

    // Ctrl/Cmd + wheel (and pinch-to-zoom, which browsers report as ctrl+wheel)
    // → zoom around the pointer. Accumulate this event's deltaY and schedule
    // (at most once) a same-frame flush that resolves the net direction and
    // applies a single level step — see flushWheelZoom above.
    e.preventDefault();

    const rect = container.getBoundingClientRect();
    const labelWidth = 112;
    const pointerXInTimeline = Math.max(0, e.clientX - rect.left - labelWidth);

    const accum = wheelZoomAccumRef.current;
    accum.deltaSum += e.deltaY;
    accum.pointerXInTimeline = pointerXInTimeline;
    if (accum.rafId === null) {
      accum.rafId = requestAnimationFrame(flushWheelZoom);
    }
  }, [flushWheelZoom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleTimelineWheelEvent = (e: WheelEvent) => handleTimelineWheel(e);
    container.addEventListener("wheel", handleTimelineWheelEvent, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleTimelineWheelEvent);
    };
  }, [handleTimelineWheel]);

  const handleReorderScenes = useCallback(
    async (activeId: string, overId: string) => {
      const oldIndex = scenes.findIndex((s) => s.id === activeId);
      const newIndex = scenes.findIndex((s) => s.id === overId);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...scenes];
      const [removed] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, removed);
      const sceneIds = reordered.map((s) => s.id);

      await timelineController.execute({ type: "scene.reorder", sceneIds });
    },
    [scenes, timelineController]
  );

  const buildRawScenePositions = useCallback(() => {
    const rawPositions = new Map<string, number>();
    for (const scene of scenes) {
      rawPositions.set(scene.id, getSceneStart(scene, scenes, scenes.indexOf(scene)));
    }
    return rawPositions;
  }, [scenes]);

  const handleMoveSceneTime = useCallback(
    (sceneId: string, newStartSeconds: number, newTrackIndex?: number) => {
      // Push-right per track — scenes on different tracks never push each other.
      const sceneDuration = (s: any) => {
        if (s.videoUrl && s.duration && s.duration > 0) return Number(s.duration);
        const total = totalShotDuration(parseShotBreakdown(s.shotBreakdown));
        if (total > 0) return total;
        return Number(s.duration || 5);
      };
      const newStart = Math.max(0, newStartSeconds);
      const effectiveTrack = (s: any) =>
        s.id === sceneId
          ? (newTrackIndex ?? Number(s.trackIndex || 1))
          : Number(s.trackIndex || 1);
      const effectiveStart = (s: any) =>
        s.id === sceneId ? newStart : getSceneStart(s, scenes, scenes.indexOf(s));

      const byTrack = new Map<number, any[]>();
      for (const s of scenes as any[]) {
        const t = effectiveTrack(s);
        const arr = byTrack.get(t) || [];
        arr.push(s);
        byTrack.set(t, arr);
      }
      const nextPositions = new Map<string, number>();
      for (const [, group] of byTrack) {
        const sorted = [...group].sort((a: any, b: any) => {
          const ea = effectiveStart(a);
          const eb = effectiveStart(b);
          if (ea !== eb) return ea - eb;
          return (a.order ?? 0) - (b.order ?? 0);
        });
        let cursor = 0;
        for (const s of sorted) {
          const sStart = effectiveStart(s);
          const sDur = sceneDuration(s);
          if (sStart < cursor) {
            nextPositions.set(s.id, cursor);
            cursor = cursor + sDur;
          } else {
            nextPositions.set(s.id, sStart);
            cursor = sStart + sDur;
          }
        }
      }

      onSceneOverridesUpdate?.(nextPositions, sceneId, newTrackIndex);

      const originalTrack = scenes.find((scene) => scene.id === sceneId)?.trackIndex ?? 1;
      void timelineController.execute(
        {
          type: "scene.move",
          moves: [{ sceneId, timelinePositionSeconds: Math.max(0.001, newStartSeconds), ...(newTrackIndex !== undefined ? { trackIndex: newTrackIndex } : {}) }],
        },
        { coalesceKey: `scene-move:${sceneId}`, debounceMs: 500, toastOnError: false },
      ).then((result) => {
        if (result.ok || result.superseded) return;
        if (!result.cancelled) toast.error(t("couldNotSavePosition"));
        onSceneOverridesUpdate?.(buildRawScenePositions(), sceneId, originalTrack);
      });
    },
    [buildRawScenePositions, onSceneOverridesUpdate, scenes, t, timelineController, toast]
  );

  const handleMoveSceneTimes = useCallback(
    (updates: { sceneId: string; startTime: number; trackIndex?: number }[], clipUpdates: Array<{ clipId: string; startTime: number; endTime: number; trackType?: string; trackIndex?: number }> = []) => {
      if (updates.length === 0) return;

      const nextPositions = new Map<string, number>();
      for (const scene of scenes) {
        nextPositions.set(scene.id, getSceneStart(scene, scenes, scenes.indexOf(scene)));
      }
      timelineController.cancelPending(false, updates.map((u) => `scene-move:${u.sceneId}`));
      for (const update of updates) {
        // Mirrors the persist clamp: exactly 0 reads as "unpositioned" and
        // collapses the transient layout (see engine/persist.ts).
        nextPositions.set(update.sceneId, Math.max(0.001, update.startTime));
      }

      const firstTrackUpdate = updates.find((u) => u.trackIndex !== undefined);
      const originalTrackForFirstTrackUpdate = firstTrackUpdate
        ? Number((scenes as any[]).find((scene) => scene.id === firstTrackUpdate.sceneId)?.trackIndex ?? 1)
        : undefined;
      onSceneOverridesUpdate?.(
        nextPositions,
        firstTrackUpdate?.sceneId,
        firstTrackUpdate?.trackIndex,
      );

      const resetOptimisticPosition = () => {
        const rawPositions = new Map<string, number>();
        for (const scene of scenes) {
          rawPositions.set(scene.id, getSceneStart(scene, scenes, scenes.indexOf(scene)));
        }
        onSceneOverridesUpdate?.(rawPositions, firstTrackUpdate?.sceneId, originalTrackForFirstTrackUpdate);
      };
      const changeMap = new Map<string, { start: number; trackId: string }>();
      for (const u of updates) {
        const existingTrack = Number((scenes as any[]).find((scene) => scene.id === u.sceneId)?.trackIndex ?? 1);
        changeMap.set(u.sceneId, { start: Math.max(0.001, u.startTime), trackId: `v${u.trackIndex ?? existingTrack}` });
      }
      const writes = buildScenePositionWrites(changeMap, new Set(updates.map((u) => u.sceneId)));
      // Clips the same gesture moved (multi-selection drags, ripple pushes) go in the same command: one undo step.
      void timelineController.execute({ type: "scene.move", moves: writes, ...(clipUpdates.length > 0 ? { clipUpdates } : {}) }, { toastOnError: false }).then((result) => {
        if (result.ok) return;
        toast.error(t("couldNotSavePositions"));
        resetOptimisticPosition();
      });
    },
    [onSceneOverridesUpdate, scenes, t, timelineController, toast],
  );

  const handleReorderShots = useCallback(
    async (sceneId: string, newShotOrder: number[]) => {
      await timelineController.execute({ type: "shot.reorder", sceneId, order: newShotOrder });
    },
    [timelineController],
  );

  const handleMergeShot = useCallback(
    async (
      sourceSceneId: string,
      shotIndex: number,
      targetSceneId: string,
      targetShotIndex?: number,
    ) => {
      await timelineController.execute({ type: "shot.merge", input: { sourceSceneId, shotIndex, targetSceneId, targetShotIndex } });
    },
    [timelineController],
  );

  const handleUpdateSceneDuration = useCallback(
    async (sceneId: string, newStartSeconds: number, newDuration: number) => {
        // NOTE: everything up to the optimistic apply below is PURE and runs
        // before any await — the token fetch alone can take 1.5s+, and the
        // resize must be visible the instant the mouse releases.
        const scene = scenes.find((s: any) => s.id === sceneId);
        if (!scene) return;
        const sceneIndex = scenes.indexOf(scene);
        const oldStart = getSceneStart(scene, scenes, sceneIndex);
        const oldDuration = getSceneDuration(scene);
        const oldEnd = oldStart + oldDuration;

        // Content-backed scenes (copy/source video): an edge drag is a TRIM,
        // persisted as cardConfig timelineTrimStart/End — the exact fields the
        // renderer, preview, and export derive duration from. Writing
        // scene.duration alone did nothing visually (the strip re-derives from
        // shots) while silently corrupting the project length, and let a
        // source video "grow" past its media. Clamp to the content length.
        const contentBacked = isContentBackedScene(scene);
        let optimisticCardConfig: string | null = null;
        if (contentBacked) {
          const baseTrimStart = getSceneTimelineTrimStart(scene);
          const content = getSceneContentDuration(scene);
          // Trims are media (source) seconds; a sped-up scene converts the timeline drag (scene-duration.ts).
          let trimStart = Math.max(0, baseTrimStart + sceneSourceSeconds(scene, newStartSeconds - oldStart));
          let trimEnd = trimStart + sceneSourceSeconds(scene, newDuration);
          if (Number.isFinite(content)) trimEnd = Math.min(trimEnd, content);
          if (trimEnd - trimStart < 0.5) trimStart = Math.max(0, trimEnd - 0.5);
          newDuration = sceneTimelineSeconds(scene, trimEnd - trimStart);
          newStartSeconds = oldStart + sceneTimelineSeconds(scene, trimStart - baseTrimStart);

          optimisticCardConfig = JSON.stringify({
            ...parseSceneCardConfig(scene),
            timelineTrimStart: trimStart,
            timelineTrimEnd: trimEnd,
            // Remember the untrimmed content length so later drags can still
            // clamp (and re-expand back up to it) after the trim is applied.
            ...(Number.isFinite(content) ? { timelineSourceDuration: content } : {}),
          });
        }

        const newEnd = newStartSeconds + newDuration;
        // Ripple delta — applied to every scene that originally started AT OR AFTER
        // this scene's old end (i.e. everything to the right). Positive delta = scenes
        // shift right (duration grew); negative = scenes shift left to close the gap.
        const delta = newEnd - oldEnd;

        // Ripple targets, computed UP FRONT (pure math) so they can be applied
        // optimistically. Growth is gap-aware (engine sweep pushes only real
        // overlaps); shrink slides later scenes left to close the gap.
        let downstreamPositions: { sceneId: string; timelinePositionSeconds: number; trackIndex: number | null }[] = [];
        if (Math.abs(delta) > 0.01) {
          if (delta > 0) {
            const engineItems: EngineItem[] = (scenes as any[]).map((s, i) => ({
              id: s.id,
              trackId: `v${Number(s.trackIndex || 1)}`,
              start: s.id === sceneId ? newStartSeconds : getSceneStart(s, scenes, i),
              duration: s.id === sceneId ? newDuration : getSceneDuration(s),
              kind: "scene" as const,
            }));
            const changes = resolveMove(engineItems, [sceneId], 0);
            downstreamPositions = [...changes.entries()]
              .filter(([id]) => id !== sceneId)
              .map(([id, change]) => ({
                sceneId: id,
                timelinePositionSeconds: change.start,
                trackIndex: null,
              }));
          } else {
            const downstream = (scenes as any[])
              .filter((s) => s.id !== sceneId)
              .filter((s) => getSceneStart(s, scenes, scenes.indexOf(s)) >= oldEnd - 0.01);
            downstreamPositions = downstream.map((s) => {
              const cur = getSceneStart(s, scenes, scenes.indexOf(s));
              return {
                sceneId: s.id,
                timelinePositionSeconds: Math.max(0.001, cur + delta),
                trackIndex: null,
              };
            });
          }
        }

        // Optimistic apply — the strip must show the resize the instant the
        // mouse releases. The server writes below are several sequential
        // round-trips; without this the strip snapped back to the old size
        // until they finished ("what is it waiting for?"). Poll convergence
        // reconciles the overrides afterwards.
        // Generative scenes derive their strip width from the SHOT SUM, not
        // scene.duration — patching duration alone changes nothing on screen
        // until the server's retimed shots arrive. Scale the shots locally
        // with the same proportional rule the backend applies.
        let optimisticShotBreakdown: string | null = null;
        // Stored durations are media seconds; the timeline length is that over the scene speed.
        const newSourceDuration = sceneSourceSeconds(scene, newDuration);
        if (!contentBacked && scene.shotBreakdown && scene.shotBreakdown !== "[]") {
          try {
            const shots = JSON.parse(scene.shotBreakdown);
            if (Array.isArray(shots) && shots.length > 0) {
              const total = shots.reduce((sum: number, sh: any) => sum + (Number(sh?.duration) || 0), 0);
              if (total > 0.01) {
                const k = newSourceDuration / total;
                optimisticShotBreakdown = JSON.stringify(
                  shots.map((sh: any) => ({ ...sh, duration: Math.round((Number(sh?.duration) || 0) * k * 1000) / 1000 })),
                );
              }
            }
          } catch {
            optimisticShotBreakdown = null;
          }
        }
        onLocalScenePatch?.(sceneId, {
          duration: newSourceDuration,
          timelinePositionSeconds: Math.max(0.001, newStartSeconds),
          ...(optimisticShotBreakdown !== null ? { shotBreakdown: optimisticShotBreakdown } : {}),
          ...(optimisticCardConfig !== null ? { cardConfig: optimisticCardConfig } : {}),
        });
        if (downstreamPositions.length > 0) {
          onSceneOverridesUpdate?.(new Map(downstreamPositions.map((d) => [d.sceneId, d.timelinePositionSeconds])));
        }

        const ripple = Math.abs(delta) > 0.01
          ? {
              // trackIndex null meant "keep the track" in the source mutation; SceneMove omits it.
              moves: downstreamPositions.map(({ sceneId: id, timelinePositionSeconds }) => ({ sceneId: id, timelinePositionSeconds })),
              clipUpdates: (timelineClips || []).filter((c) => c.startTime >= oldEnd - 0.01).map((c) => ({
                clipId: c.id,
                startTime: Math.max(0, c.startTime + delta),
                endTime: Math.max(0, c.endTime + delta),
              })),
            }
          : undefined;
        await timelineController.execute({
          type: "scene.trim",
          sceneId,
          mode: contentBacked ? (optimisticCardConfig !== null ? "content" : "none") : "duration",
          duration: newSourceDuration,
          cardConfig: optimisticCardConfig,
          ...(Math.abs(newStartSeconds - oldStart) > 0.01 ? { timelinePositionSeconds: Math.max(0.001, newStartSeconds) } : {}),
          ...(ripple ? { ripple } : {}),
        });
    },
    [onLocalScenePatch, onSceneOverridesUpdate, scenes, timelineClips, timelineController],
  );

  const handleCloseGaps = useCallback(async () => {
      // CapCut-style magnetic timeline:
      // 1. Look at every gap on the V1 video track
      // 2. Build a piecewise-linear mapping:  oldTime → newTime that collapses
      //    each gap entirely
      // 3. Apply that mapping to EVERY scene, EVERY clip on every track (text /
      //    voiceover / audio / sticker / etc), and to whatever else lives by
      //    timeline time. Same shift applied uniformly = nothing drifts out
      //    of sync.
      const sceneDuration = (s: any) => {
        if (s.videoUrl && s.duration && s.duration > 0) return Number(s.duration);
        const total = totalShotDuration(parseShotBreakdown(s.shotBreakdown));
        if (total > 0) return total;
        return Number(s.duration || 5);
      };

      const { gaps, sceneUpdates, clipUpdates } = getTimelineCloseGapPlan({
        scenes: (scenes as any[]).map((scene) => ({
          ...scene,
          duration: sceneDuration(scene),
        })),
        clips: timelineClips || [],
      });

      if (gaps.length === 0) {
        toast.success(t("noGapsFound"));
        return;
      }

      const result = await timelineController.execute({
        type: "scene.move",
        moves: sceneUpdates.map((u) => ({
          sceneId: u.id,
          timelinePositionSeconds: u.pos,
          trackIndex: Number((scenes as any[]).find((s) => s.id === u.id)?.trackIndex || 1),
        })),
        clipUpdates: clipUpdates.map((u) => ({ clipId: u.id, startTime: u.startTime, endTime: u.endTime })),
      }, { toastOnError: false });
      if (!result.ok) {
        toast.error(t("closeGapsFailed"));
        return;
      }
      toast.success(t("closedGapsSummary", { gaps: gaps.length, scenes: sceneUpdates.length, clips: clipUpdates.length }));
  }, [scenes, t, timelineClips, timelineController, toast]);

  const handleDeleteShot = useCallback(
    async (sceneId: string, shotIndex: number) => {
      await timelineController.execute({ type: "shot.delete", sceneId, shotIndex });
    },
    [timelineController],
  );

  const handleExtractShot = useCallback(
    async (
      sceneId: string,
      shotIndex: number,
      newStartSeconds: number,
      newTrackIndex: number,
    ) => {
      await timelineController.execute({ type: "shot.extract", input: { sceneId, shotIndex, timelinePositionSeconds: newStartSeconds, trackIndex: newTrackIndex } });
    },
    [timelineController],
  );

  // Parent (editor-layout) owns the override map + reconcile + order re-sequencing.
  // The scenes prop here already reflects optimistic positions + re-sequenced order.
  const scenesForCanvas = scenes;

  // Keep the canvas clip list limited to persisted timeline clips. Scene audio
  // is represented by the scene/video itself; adding visual-only synthetic A1
  // clips makes the editor look like it created extra audio tracks.
  const _isSyntheticEmbeddedAudio = useCallback(
    (id: string) => id.startsWith("__embedded_audio__"),
    [],
  );

  const clipsWithEmbeddedAudio = useMemo<TimelineClip[]>(() => {
    return timelineClips || [];
  }, [timelineClips]);

  const handleSeek = useCallback(
    (time: number) => {
      const nextTime = Math.max(0, Math.min(totalDuration, time));
      setCurrentTime(nextTime);
      setSeekRequest(nextTime);
      setShuttleSpeed(0);
    },
    [setCurrentTime, setSeekRequest, setShuttleSpeed, totalDuration]
  );

  const handleToggleMarkerAtPlayhead = useCallback(() => {
    const currentTime = storeApi.getState().currentTime;
    const hasMarkerAtPlayhead = timelineMarkers.some((marker) => Math.abs(marker.time - currentTime) <= 0.15); // i18n-ignore — numeric marker hit test
    if (hasMarkerAtPlayhead) {
      removeTimelineMarkerNear(currentTime);
      return;
    }
    addTimelineMarker(currentTime);
  }, [addTimelineMarker, removeTimelineMarkerNear, timelineMarkers]);

  // Audio selection handlers
  const handleSelectMusic = useCallback(() => {
    selectAudioTarget("music");
    // Surface the Music Properties panel (incl. AI generate) immediately —
    // otherwise selecting music leaves the right panel on whatever tab was open.
    callbacks.onOpenMusicPanel?.({ mode: "music" });
  }, [callbacks, selectAudioTarget]);

  const handleSelectVoiceover = useCallback(
    (sceneId: string) => {
      selectAudioTarget({ sceneId, type: "voiceover" });
    },
    [selectAudioTarget]
  );

  const handleSplitSelectedSceneAtPlayhead = useCallback(async (currentTime: number) => {
    if (!selectedTimelineScene) return false;
    const sceneIndex = scenes.findIndex((scene) => scene.id === selectedTimelineScene.id);
    if (sceneIndex < 0) return false;

    const sceneStart = getSceneStart(selectedTimelineScene, scenes, sceneIndex);
    const sceneDuration = getSceneDuration(selectedTimelineScene);
    const sceneEnd = sceneStart + sceneDuration;
    const localSplitTime = currentTime - sceneStart;
    if (currentTime <= sceneStart + 0.1 || currentTime >= sceneEnd - 0.1) return false;

    const mediaUrl = selectedTimelineScene.videoUrl || selectedTimelineScene.sourceVideoUrl;
    if (!mediaUrl) {
      toast.warning(t("sceneSplitNeedsVideo"));
      return true;
    }

    const shouldConvert = selectedTimelineScene.cardType === "source_clip" || await requestTimelineConfirm({
      title: t("confirmSceneSplitTitle"),
      description: t("convertSceneToEditableClipForSplit"),
      confirmLabel: t("confirmConvertAndCut"),
      cancelLabel: t("cancel"),
      intent: "danger",
    });
    if (!shouldConvert) return true;

    const trackIndex = Math.max(1, Number(selectedTimelineScene.trackIndex || 1));
    const baseTrimStart = getSceneTimelineTrimStart(selectedTimelineScene);
    const firstTrimEnd = baseTrimStart + localSplitTime;
    const secondTrimEnd = baseTrimStart + sceneDuration;
    const firstCardConfig = buildSceneTimelineTrimCardConfig(selectedTimelineScene, baseTrimStart, firstTrimEnd);
    const secondCardConfig = buildSceneTimelineTrimCardConfig(selectedTimelineScene, firstTrimEnd, secondTrimEnd);
    const splitAudioUrl = getSceneAudioUrl(selectedTimelineScene);
    const optimisticSceneId = `optimistic-scene-${selectedTimelineScene.id}-${Date.now()}`;
    const result = await timelineController.execute({
      type: "scene.split",
      sceneId: selectedTimelineScene.id,
      atSeconds: currentTime,
      optimistic: {
        sourceSceneId: selectedTimelineScene.id,
        tempSceneId: optimisticSceneId,
        firstScene: {
          id: selectedTimelineScene.id,
          cardType: "source_clip",
          sourceVideoUrl: mediaUrl,
          videoUrl: mediaUrl,
          audioUrl: splitAudioUrl,
          audioText: selectedTimelineScene.audioText ?? null,
          duration: localSplitTime,
          shotBreakdown: "[]",
          cardConfig: firstCardConfig,
          timelinePositionSeconds: sceneStart,
          trackIndex,
        },
        secondScene: {
          ...selectedTimelineScene,
          id: optimisticSceneId,
          order: selectedTimelineScene.order + 1,
          caption: selectedTimelineScene.caption || t("convertedSceneClip"),
          cardType: "source_clip",
          sourceVideoUrl: mediaUrl,
          videoUrl: mediaUrl,
          audioUrl: splitAudioUrl,
          audioText: selectedTimelineScene.audioText ?? null,
          duration: sceneEnd - currentTime,
          shotBreakdown: "[]",
          cardConfig: secondCardConfig,
          timelinePositionSeconds: currentTime,
          trackIndex,
        },
        splitTime: currentTime,
      },
    }, { toastOnError: false });
    if (!result.ok) {
      toast.error(t("sceneSplitFailed"));
      return true;
    }
    toast.success(t("sceneConvertedAndSplit"));
    return true;
  }, [requestTimelineConfirm, scenes, selectedTimelineScene, t, timelineController, toast]);

  // Split selected clip at playhead
  const handleSplitAtPlayhead = useCallback((activeTrackOnly = false) => {
    if (!canSplitTimelineClip) return;
    const currentTime = storeApi.getState().currentTime;
    const getSplitIds = activeTrackOnly ? getTimelineTrackSplitTargetClipIdsAtPlayhead : getTimelineSplitTargetClipIdsAtPlayhead;

    const commitSplitIds = (splitIds: string[]) => {
      if (splitIds.length === 0) {
        toast.warning(t("movePlayheadInsideClipToSplit"));
        return;
      }
      void commitTimelineClipSplits(splitIds, currentTime, { splitClip: onSplitClip, splitClips: onSplitClips })
        .then(selectCreatedSplitClips);
    };

    const hasSelectedTimelineClip = selectedClipIds.size > 0 || Boolean(selectedClipId);
    if (!activeTrackOnly && selectedTimelineScene && !hasSelectedTimelineClip) {
      void handleSplitSelectedSceneAtPlayhead(currentTime).then((handledSceneSplit) => {
        if (handledSceneSplit) return;
        commitSplitIds(getSplitIds(
          timelineClips || [],
          timelineTracks || [],
          selectedClipIds,
          selectedClipId,
          currentTime,
        ));
      });
      return;
    }

    const splitIds = getSplitIds(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
      currentTime,
    );
    if (splitIds.length === 0) {
      void handleSplitSelectedSceneAtPlayhead(currentTime).then((handledSceneSplit) => {
        if (!handledSceneSplit) toast.warning(t("movePlayheadInsideClipToSplit"));
      });
      return;
    }
    commitSplitIds(splitIds);
  }, [canSplitTimelineClip, handleSplitSelectedSceneAtPlayhead, onSplitClip, onSplitClips, selectCreatedSplitClips, selectedClipId, selectedClipIds, selectedTimelineScene, t, timelineClips, timelineTracks]);

  const handleSplitAllTracksAtPlayhead = useCallback(() => {
    if (!canSplitTimelineClip) return;
    const currentTime = storeApi.getState().currentTime;
    const splitIds = getTimelineSplitAllTrackClipIdsAtPlayhead(
      timelineClips || [],
      timelineTracks || [],
      currentTime,
    );
    if (splitIds.length === 0) {
      toast.warning(t("movePlayheadInsideClipToSplit"));
      return;
    }
    void commitTimelineClipSplits(splitIds, currentTime, { splitClip: onSplitClip, splitClips: onSplitClips })
      .then(selectCreatedSplitClips);
  }, [canSplitTimelineClip, onSplitClip, onSplitClips, selectCreatedSplitClips, t, timelineClips, timelineTracks]);

  const handleSplitAtNearestMarker = useCallback(() => {
    if (!canSplitTimelineClip) return;
    const currentTime = storeApi.getState().currentTime;
    const target = getTimelineSplitTargetAtNearestMarker(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
      timelineMarkers,
      currentTime,
    );
    if (!target) return;
    void commitTimelineClipSplits(target.clipIds, target.splitTime, { splitClip: onSplitClip, splitClips: onSplitClips })
      .then(selectCreatedSplitClips);
  }, [canSplitTimelineClip, onSplitClip, onSplitClips, selectCreatedSplitClips, selectedClipId, selectedClipIds, timelineClips, timelineMarkers, timelineTracks]);

  // Track toggle handlers
  const handleToggleTrack = useCallback(
    (trackKey: string, field: "muted" | "locked" | "visible") => {
      if (!onUpdateTracks || !timelineTracks) return;
      const baseTracks = withRequiredBaseTimelineTracks(timelineTracks).tracks;
      const updated = baseTracks.map((t) => {
        const key = `${t.type}-${t.index}`;
        if (key === trackKey) {
          return { ...t, [field]: !t[field] };
        }
        return t;
      });
      onUpdateTracks(updated);
    },
    [timelineTracks, onUpdateTracks]
  );

  // Track fader — scales every clip on the track in preview and export
  const handleSetTrackVolume = useCallback(
    (trackKey: string, volume: number) => {
      if (!onUpdateTracks || !timelineTracks) return;
      const baseTracks = withRequiredBaseTimelineTracks(timelineTracks).tracks;
      const updated = setTimelineTrackVolume(baseTracks, trackKey, volume);
      if (updated === baseTracks) return;
      onUpdateTracks(updated);
    },
    [timelineTracks, onUpdateTracks]
  );

  // Delete track — backend will cascade-delete all clips on that track
  const handleDeleteTrack = useCallback(
    (trackKey: string) => {
      if (!onUpdateTracks || !timelineTracks) return;
      const baseTracks = withRequiredBaseTimelineTracks(timelineTracks).tracks;
      const newTracks = getTimelineDeleteTrackUpdates(baseTracks, trackKey);
      if (newTracks === baseTracks) return;
      onUpdateTracks(newTracks);
    },
    [timelineTracks, onUpdateTracks]
  );

  // Drag-reorder on the label rail: swap two same-type lanes (V1/A1 pinned).
  // Clips on both lanes swap trackIndex with them so content follows its lane.
  const [dragTrackKey, setDragTrackKey] = useState<string | null>(null);
  const [dropTargetTrackKey, setDropTargetTrackKey] = useState<string | null>(null);
  const handleTrackRailDrop = useCallback((sourceKey: string, targetKey: string) => {
    setDragTrackKey(null);
    setDropTargetTrackKey(null);
    if (!onUpdateTracks || !timelineTracks) return;
    const baseTracks = withRequiredBaseTimelineTracks(timelineTracks).tracks;
    const swapped = swapTimelineTrackOrder(baseTracks, sourceKey, targetKey);
    if (!swapped) return;
    const sep = (key: string) => ({ type: key.slice(0, key.lastIndexOf("-")), index: Number(key.slice(key.lastIndexOf("-") + 1)) });
    const a = sep(sourceKey);
    const b = sep(targetKey);
    const clipUpdates = (timelineClips ?? [])
      .filter((clip) => clip.trackType === a.type && (clip.trackIndex === a.index || clip.trackIndex === b.index))
      .map((clip) => ({
        clipId: clip.id,
        startTime: clip.startTime,
        endTime: clip.endTime,
        trackIndex: clip.trackIndex === a.index ? b.index : a.index,
      }));
    void onUpdateTracks(swapped).catch(() => toast.error(t("clipUpdateFailed")));
    if (clipUpdates.length > 0 && (onUpdateClip || onUpdateClips)) {
      void commitTimelineClipUpdates(clipUpdates, { updateClip: onUpdateClip, updateClips: onUpdateClips })
        .catch(() => toast.error(t("clipUpdateFailed")));
    }
  }, [onUpdateTracks, onUpdateClip, onUpdateClips, timelineTracks, timelineClips, t]);

  const getNextTrackForType = useCallback(
    (tracks: TimelineTrack[], type: "video" | "audio" | "text" | "sticker" | "effect" | "remotion"): TimelineTrack =>
      nextTrackForType(tracks, type),
    []
  );

  /** Resolve tracks locally for instant clip placement; persist track adds in the background. */
  const resolveTimelineTracksForType = useCallback(
    (type: "video" | "audio" | "text" | "sticker" | "effect" | "remotion") => {
      const rawBaseTracks = timelineTracks?.length ? timelineTracks : defaultTracks;
      const { tracks: baseTracks, repaired } = timelineTracks?.length
        ? withRequiredBaseTimelineTracks(rawBaseTracks)
        : { tracks: rawBaseTracks, repaired: false };
      const hasEditable = baseTracks.some(
        (track) => track.type === type && !track.locked && track.visible !== false,
      );
      if (hasEditable && !repaired) return baseTracks;
      if (!onUpdateTracks) return null;
      const nextTracks = hasEditable ? baseTracks : [...baseTracks, getNextTrackForType(baseTracks, type)];
      void onUpdateTracks(repaired ? baseTracks : nextTracks).catch(() => undefined);
      return nextTracks;
    },
    [getNextTrackForType, onUpdateTracks, timelineTracks],
  );

  // Add track
  const handleAddTrack = useCallback(
    (type: "video" | "audio" | "text" | "sticker" | "effect" | "remotion") => {
      if (!onUpdateTracks) return;
      const baseTracks = timelineTracks?.length ? withRequiredBaseTimelineTracks(timelineTracks).tracks : defaultTracks;
      onUpdateTracks([...baseTracks, getNextTrackForType(baseTracks, type)]);
    },
    [getNextTrackForType, timelineTracks, onUpdateTracks]
  );

  // Canvas clip commit handler — batches all clip updates from drag
  const handleUpdateClips = useCallback(
    (commits: ClipCommit[]) => {
      if ((!onUpdateClip && !onUpdateClips)) return;
      const updates = commits.flatMap((commit) => {
        if (_isSyntheticEmbeddedAudio(commit.clipId)) return [];
        // Pass through every commit field. Property commits (mute/volume,
        // fades, speed, flips…) arrive on the same channel as drag commits;
        // cherry-picking geometry here silently dropped all of them.
        const input = Object.fromEntries(
          Object.entries(commit).filter(([, value]) => value !== undefined),
        ) as TimelineClipUpdateCommit;
        return [input];
      });
      void commitTimelineClipUpdates(updates, { updateClip: onUpdateClip, updateClips: onUpdateClips })
        .catch(() => toast.error(t("clipUpdateFailed")));
    },
    [onUpdateClip, onUpdateClips, t, _isSyntheticEmbeddedAudio]
  );

  // Canvas delete clips handler (batch)
  const handleDeleteClips = useCallback(
    (clipIds: string[]) => {
      if (!canDeleteTimelineClip) return;
      const plan = getTimelineDeleteBatchPlan(
        timelineClips || [],
        timelineTracks || [],
        new Set(clipIds),
        _isSyntheticEmbeddedAudio,
      );
      if (plan.deleteIds.length === 0) {
        if (plan.blockedSyntheticCount > 0) toast(t("audioLockedDelete"), { icon: "🔒" });
        return;
      }
      if (onDeleteClips) {
        onDeleteClips(plan.deleteIds).catch(() => toast.error(t("someDeletionsFailed")));
      } else if (plan.deleteIds.length === 1) {
        onDeleteClip?.(plan.deleteIds[0]).catch(() => toast.error(t("deleteFailed")));
      } else {
        Promise.all(plan.deleteIds.map((id) => onDeleteClip?.(id))).catch(() => toast.error(t("someDeletionsFailed")));
      }
    },
    [canDeleteTimelineClip, onDeleteClip, onDeleteClips, _isSyntheticEmbeddedAudio, t, timelineClips, timelineTracks]
  );

  const handleDuplicateSelectedClips = useCallback(() => {
    if (!canCreateTimelineClip || editableSelectedClipIds.size === 0) return;
    const realIds = new Set([...editableSelectedClipIds].filter((id) => !_isSyntheticEmbeddedAudio(id)));
    const clips = (timelineClips || []) as unknown as TimelineDuplicateClip[];
    const inputs = duplicateTimelineClips(clips, realIds, timelineTracks || []);
    if (inputs.length === 0) return;
    void commitTimelineClipCreates(inputs, { createClip: onCreateClip, createClips: onCreateClips }).then((created) => {
      const ids = created.filter(Boolean).map((clip) => clip!.id);
      if (ids.length > 0) setSelectedClipIds(new Set(ids));
    }).catch(() => toast.error(t("duplicateFailed")));
  }, [canCreateTimelineClip, editableSelectedClipIds, onCreateClip, onCreateClips, setSelectedClipIds, t, timelineClips, timelineTracks, _isSyntheticEmbeddedAudio]);

  const handleCopySelectedClips = useCallback(() => {
    if (copyTargetClipIds.size === 0) return;
    const clips = (timelineClips || []) as unknown as TimelineDuplicateClip[];
    setTimelineClipboard(copyTimelineClips(clips, copyTargetClipIds, timelineTracks || []));
  }, [copyTargetClipIds, setTimelineClipboard, timelineClips, timelineTracks]);

  // Clicking a timeline "dead zone" — the track-label rail, the strip below
  // the canvas, or the empty area under the last track — deselects everything
  // so the properties panel never keeps showing a stale scene/clip/audio item.
  // The canvas surface owns its own hit-based selection, and interactive
  // elements (track control buttons, add-track, menus) must keep working
  // without clearing. Modifier clicks are left alone so additive selection
  // gestures are never interrupted.
  const handleTimelineDeadZoneMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('canvas, button, input, select, textarea, [role="menu"], [role="dialog"]')) return;
    // Ignore scrollbar grabs on the scroll container itself.
    const container = e.currentTarget;
    const rect = container.getBoundingClientRect();
    if (container.clientWidth > 0 && e.clientX - rect.left >= container.clientWidth) return;
    if (container.clientHeight > 0 && e.clientY - rect.top >= container.clientHeight) return;
    clearSelection();
  }, [clearSelection]);

  const handleSelectTimelineRange = useCallback((direction: -1 | 1) => {
    const rangeIds = getTimelineRangeSelectionClipIds(
      timelineClips || [],
      timelineTracks || [],
      storeApi.getState().currentTime,
      direction,
    );
    setSelectedClipIds(rangeIds);
  }, [setSelectedClipIds, timelineClips, timelineTracks]);

  const handleCutSelectedClips = useCallback(() => {
    if (!canDeleteTimelineClip || editableSelectedClipIds.size === 0) return;
    const realIds = new Set([...editableSelectedClipIds].filter((id) => !_isSyntheticEmbeddedAudio(id)));
    const clips = (timelineClips || []) as unknown as TimelineDuplicateClip[];
    const cut = cutTimelineClips(clips, realIds, timelineTracks || []);
    if (!cut) return;
    setTimelineClipboard(cut.clipboard);
    setSelectedClipIds(getTimelineSelectionAfterDelete(selectedClipIds, new Set(cut.deleteIds), timelineClips || [], timelineTracks || []));
    handleDeleteClips(cut.deleteIds);
  }, [
    canDeleteTimelineClip,
    editableSelectedClipIds,
    handleDeleteClips,
    selectedClipIds,
    setSelectedClipIds,
    setTimelineClipboard,
    timelineClips,
    timelineTracks,
    _isSyntheticEmbeddedAudio,
  ]);

  const handlePasteClipboardClips = useCallback(() => {
    if (!canCreateTimelineClip || !canPasteTimelineClipboard(timelineClipboard, timelineTracks || [])) return;
    const currentTime = storeApi.getState().currentTime;
    const pasteTime = getTimelinePasteTargetTime(timelineClips || [], editableSelectedClipIds, currentTime, timelineTracks || []);
    const inputs = getEditableTimelinePasteInputs(
      pasteTimelineClips(timelineClipboard, pasteTime),
      timelineTracks || [],
      (timelineClips || []) as unknown as TimelineDuplicateClip[],
    );
    if (inputs.length === 0) return;
    void commitTimelineClipCreates(inputs, { createClip: onCreateClip, createClips: onCreateClips }).then((created) => {
      const ids = created.filter(Boolean).map((clip) => clip!.id);
      if (ids.length > 0) setSelectedClipIds(new Set(ids));
    }).catch(() => toast.error(t("pasteFailed")));
  }, [canCreateTimelineClip, editableSelectedClipIds, onCreateClip, onCreateClips, setSelectedClipIds, t, timelineClipboard, timelineClips, timelineTracks]);

  const handleTrimSelectedClipsToPlayhead = useCallback((edge: "start" | "end") => {
    if ((!onUpdateClip && !onUpdateClips)) return;
    const currentTime = storeApi.getState().currentTime;
    const commits = getTimelineTrimTargetCommitsToPlayhead(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
      currentTime,
      edge,
    );
    if (commits.length === 0) return;
    void commitTimelineClipUpdates(commits, { updateClip: onUpdateClip, updateClips: onUpdateClips })
      .catch(() => toast.error(t("clipUpdateFailed")));
  }, [onUpdateClip, onUpdateClips, selectedClipId, selectedClipIds, t, timelineClips, timelineTracks]);

  const handleToggleSelectedClipReversePlayback = useCallback(() => {
    if ((!onUpdateClip && !onUpdateClips)) return;
    const commits = getTimelineToggleReversePlaybackTargetCommits(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
    );
    if (commits.length === 0) return;
    void commitTimelineClipUpdates(commits, { updateClip: onUpdateClip, updateClips: onUpdateClips })
      .catch(() => toast.error(t("clipUpdateFailed")));
  }, [onUpdateClip, onUpdateClips, selectedClipId, selectedClipIds, t, timelineClips, timelineTracks]);

  const handleToggleSelectedFreezeFrame = useCallback(() => {
    if ((!onUpdateClip && !onUpdateClips)) return;
    const commits = getTimelineToggleFreezeFrameTargetCommits(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
    );
    if (commits.length === 0) return;
    void commitTimelineClipUpdates(commits, { updateClip: onUpdateClip, updateClips: onUpdateClips })
      .catch(() => toast.error(t("clipUpdateFailed")));
  }, [onUpdateClip, onUpdateClips, selectedClipId, selectedClipIds, t, timelineClips, timelineTracks]);

  const handleToggleSelectedHorizontalFlip = useCallback(() => {
    if ((!onUpdateClip && !onUpdateClips)) return;
    const commits = getTimelineToggleHorizontalFlipTargetCommits(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
    );
    if (commits.length === 0) return;
    void commitTimelineClipUpdates(commits, { updateClip: onUpdateClip, updateClips: onUpdateClips })
      .catch(() => toast.error(t("clipUpdateFailed")));
  }, [onUpdateClip, onUpdateClips, selectedClipId, selectedClipIds, t, timelineClips, timelineTracks]);

  const handleRotateSelectedVisual = useCallback((deltaDegrees: number) => {
    if ((!onUpdateClip && !onUpdateClips)) return;
    const commits = getTimelineRotateVisualTargetCommits(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
      deltaDegrees,
    );
    if (commits.length === 0) return;
    void commitTimelineClipUpdates(commits, { updateClip: onUpdateClip, updateClips: onUpdateClips })
      .catch(() => toast.error(t("clipUpdateFailed")));
  }, [onUpdateClip, onUpdateClips, selectedClipId, selectedClipIds, t, timelineClips, timelineTracks]);

  const handleSetSelectedVisualCrop = useCallback((crop: { cropLeft: number; cropRight: number; cropTop: number; cropBottom: number }) => {
    if ((!onUpdateClip && !onUpdateClips)) return;
    const commits = getTimelineSetVisualCropTargetCommits(
      timelineClips || [],
      timelineTracks || [],
      selectedClipIds,
      selectedClipId,
      crop,
    );
    if (commits.length === 0) return;
    void commitTimelineClipUpdates(commits, { updateClip: onUpdateClip, updateClips: onUpdateClips })
      .catch(() => toast.error(t("clipUpdateFailed")));
  }, [onUpdateClip, onUpdateClips, selectedClipId, selectedClipIds, t, timelineClips, timelineTracks]);

  const handleDeleteSelectedClips = useCallback(() => {
    if (!canDeleteTimelineClip || editableSelectedClipIds.size === 0) return;
    setSelectedClipIds(getTimelineSelectionAfterDelete(selectedClipIds, editableSelectedClipIds, timelineClips || [], timelineTracks || []));
    handleDeleteClips([...editableSelectedClipIds]);
  }, [canDeleteTimelineClip, editableSelectedClipIds, handleDeleteClips, selectedClipIds, setSelectedClipIds, timelineClips, timelineTracks]);

  const handleRippleDeleteSelectedClips = useCallback(() => {
    if (!canDeleteTimelineClip || (!onUpdateClip && !onUpdateClips) || editableSelectedClipIds.size === 0) return;
    const realIds = new Set([...editableSelectedClipIds].filter((id) => !_isSyntheticEmbeddedAudio(id)));
    const clips = (timelineClips || []) as unknown as TimelineDuplicateClip[];
    const ripple = rippleDeleteTimelineClips(clips, realIds, timelineTracks || []);
    if (!ripple) return;
    setSelectedClipIds(getTimelineSelectionAfterDelete(selectedClipIds, realIds, timelineClips || [], timelineTracks || []));
    void (async () => {
      await commitTimelineClipCommand(
        {
          creates: ripple.creates ?? [],
          updates: ripple.commits,
          deleteIds: ripple.deleteIds,
          description: "Ripple delete timeline clips",
        },
        {
          createClip: onCreateClip ?? (async () => null),
          createClips: onCreateClips,
          updateClip: onUpdateClip,
          updateClips: onUpdateClips,
          deleteClip: onDeleteClip,
          deleteClips: onDeleteClips,
          clipCommand: onCommitClipCommand,
        },
      );
    })().catch(() => toast.error(t("deleteFailed")));
  }, [
    canDeleteTimelineClip,
    editableSelectedClipIds,
    onCreateClip,
    onCreateClips,
    onCommitClipCommand,
    onDeleteClip,
    onDeleteClips,
    onUpdateClip,
    onUpdateClips,
    selectedClipIds,
    setSelectedClipIds,
    t,
    timelineClips,
    timelineTracks,
    _isSyntheticEmbeddedAudio,
  ]);

  // Scene CRUD handlers for context menu. Returns whether the delete actually
  // succeeded so callers (e.g. ripple delete) can avoid acting on a failed
  // mutation.
  const handleDeleteScene = useCallback(
    async (sceneId: string): Promise<boolean> => {
      clearSelection();
      const result = await timelineController.execute({ type: "scene.delete", sceneId }, { toastOnError: false });
      if (!result.ok) {
        toast.error(t("couldNotSavePositions"));
        return false;
      }
      return true;
    },
    [clearSelection, t, timelineController, toast]
  );

  // Ripple delete: delete the scene, then shift every later same-track item
  // left to close the gap. Two sequential mutations (delete, then a position
  // batch write) — see engine/ripple.ts for the pure shift math. The shift
  // write must never fire if the delete itself failed, or later scenes get
  // shifted left onto a scene that's still there (overlap corruption).
  const handleRippleDeleteScene = useCallback(
    async (sceneId: string) => {
      const items = scenesToEngineItems(scenes as SceneData[]);
      const shifts = resolveRippleDelete(items, sceneId);
      const writes = buildScenePositionWrites(shifts, new Set(shifts.keys()));
      clearSelection();
      const result = await timelineController.execute(
        { type: "scene.delete", sceneId, ...(writes.length > 0 ? { ripple: { moves: writes } } : {}) },
        { toastOnError: false },
      );
      if (!result.ok) toast.error(t("deleteFailed"));
    },
    [clearSelection, scenes, t, timelineController, toast]
  );

  const handleAddScene = useCallback(
    async (
      afterOrder: number,
      opts?: {
        cardType?: string;
        sourceVideoUrl?: string;
        startImageUrl?: string;
        videoUrl?: string;
        trackIndex?: number;
        timelinePositionSeconds?: number;
      },
    ) => {
      // Optimistic placeholder mirroring the backend defaults (5s blank scene)
      // so the strip appears the instant the menu entry is clicked instead of
      // after mutation + refetch round-trips.
      const targetTrack = opts?.trackIndex ?? 1;
      const appendPosition = (scenes as SceneData[])
        .filter((s) => Number(s.trackIndex || 1) === targetTrack)
        .reduce((end, s) => Math.max(end, Number(s.timelinePositionSeconds || 0) + Number(s.duration || 5)), 0);
      const tempId = `temp-add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await timelineController.execute({
        type: "scene.add",
        input: {
          afterOrder,
          cardType: opts?.cardType ?? null,
          sourceVideoUrl: opts?.sourceVideoUrl ?? null,
          startImageUrl: opts?.startImageUrl ?? null,
          videoUrl: opts?.videoUrl ?? null,
          trackIndex: opts?.trackIndex,
          timelinePositionSeconds: opts?.timelinePositionSeconds,
        },
        optimistic: {
          id: tempId,
          order: afterOrder + 1,
          caption: "New scene", // i18n-ignore — matches the server-created caption
          cardType: opts?.cardType ?? "ai_video",
          duration: 5,
          timelinePositionSeconds: opts?.timelinePositionSeconds ?? appendPosition,
          trackIndex: targetTrack,
          sourceVideoUrl: opts?.sourceVideoUrl ?? null,
          startImageUrl: opts?.startImageUrl ?? null,
          videoUrl: opts?.videoUrl ?? null,
          status: "completed",
        } as unknown as SceneData,
      }, { toastOnError: false });
      if (!result.ok) toast.error(t("clipCreateFailed"));
    },
    [scenes, t, timelineController, toast]
  );

  const handleDuplicateScene = useCallback(
    async (sceneId: string) => {
      await timelineController.execute({ type: "scene.duplicate", sceneId });
    },
    [timelineController]
  );

  const handleRemoveVoiceover = useCallback(
    (sceneId: string) => {
      const scene = (scenes as SceneData[]).find((s) => s.id === sceneId);
      const nextCardConfig = stripVoiceoverLayersFromCardConfig(scene?.cardConfig);
      void timelineController.execute({
        type: "scene.update",
        sceneId,
        patch: { audioUrl: null, audioText: null, ...(nextCardConfig !== undefined ? { cardConfig: nextCardConfig } : {}) },
      });
    },
    [scenes, timelineController],
  );

  const handleConvertSceneToSourceVideo = useCallback(
    async (sceneId: string) => {
      const scene = (scenes as any[]).find((s) => s.id === sceneId);
      const videoUrl = scene?.videoUrl || scene?.video_url;
      if (!videoUrl) {
        toast.error(t("noVideoToConvert"));
        return;
      }

      const result = await timelineController.execute({ type: "scene.update", sceneId, patch: { cardType: "source_clip", sourceVideoUrl: videoUrl } });
      if (result.ok) toast.success(t("convertedToSource"));
    },
    [scenes, t, timelineController, toast],
  );

  const handleDeleteSelectedTimelineItems = useCallback(() => {
    if (selectedTransition) {
      if (selectedTransition.kind === "scene") {
        if (!onSetSceneTransition) return;
        const sceneTransitionTracks = effectiveTimelineTracks.length > 0 ? effectiveTimelineTracks : defaultTracks;
        if (!getEditableSceneTransitionTarget(scenes, sceneTransitionTracks, selectedTransition.id)) {
          clearTransitionSelection();
          return;
        }
        onSetSceneTransition?.(selectedTransition.id, "none", 0);
      } else {
        if (!canUpdateTimelineClip) return;
        const clearCommits = getTimelineSetTransitionPresetTargetCommits(
          timelineClips || [],
          timelineTracks || [],
          new Set([selectedTransition.id]),
          selectedTransition.id,
          "none",
          0,
        );
        if (clearCommits.length > 0) {
          void commitTimelineClipUpdates(clearCommits, {
            updateClip: onUpdateClip,
            updateClips: onUpdateClips,
          }).catch(() => toast.error(t("clipUpdateFailed")));
        }
      }
      clearTransitionSelection();
      return;
    }
    if (editableSelectedClipIds.size > 0) {
      handleDeleteSelectedClips();
      return;
    }
    if (selectedTimelineScene) {
      handleDeleteScene(selectedTimelineScene.id);
    }
  }, [
    canUpdateTimelineClip,
    clearTransitionSelection,
    effectiveTimelineTracks,
    editableSelectedClipIds,
    handleDeleteScene,
    handleDeleteSelectedClips,
    onSetSceneTransition,
    onUpdateClip,
    onUpdateClips,
    selectedTimelineScene,
    selectedTransition,
    scenes,
    t,
    timelineClips,
    timelineTracks,
  ]);

  const handleRequestConvertSceneToSourceVideo = useCallback(async (sceneId: string, tool: string) => {
    const scene = scenes.find((item) => item.id === sceneId);
    const videoUrl = scene?.videoUrl || scene?.sourceVideoUrl;
    if (!videoUrl) {
      toast.warning(t("sceneToolNeedsVideo"));
      return;
    }
    const shouldConvert = await requestTimelineConfirm({
      title: t("confirmSceneConvertTitle"),
      description: t("convertSceneForTimelineTool", { tool }),
      confirmLabel: t("confirmConvertScene"),
      cancelLabel: t("cancel"),
      intent: "warning",
    });
    if (shouldConvert) await handleConvertSceneToSourceVideo(sceneId);
  }, [handleConvertSceneToSourceVideo, requestTimelineConfirm, scenes, t]);

  const handleToolbarSceneClipToolRequest = useCallback((tool: string) => {
    if (!selectedTimelineScene) return false;
    const videoUrl = selectedTimelineScene.videoUrl || selectedTimelineScene.sourceVideoUrl;
    if (!videoUrl) {
      toast.warning(t("sceneToolNeedsVideo"));
      return true;
    }
    if (selectedTimelineScene.cardType !== "source_clip") {
      void handleRequestConvertSceneToSourceVideo(selectedTimelineScene.id, tool);
      return true;
    }
    toast.warning(t("sceneToolNeedsEditableClip"));
    return true;
  }, [handleRequestConvertSceneToSourceVideo, selectedTimelineScene, t]);

  const handleToolbarToggleFreezeFrame = useCallback(() => {
    if (hasEditableClipSelection) {
      handleToggleSelectedFreezeFrame();
      return;
    }
    handleToolbarSceneClipToolRequest(t("toggleFreezeFrame"));
  }, [handleToolbarSceneClipToolRequest, handleToggleSelectedFreezeFrame, hasEditableClipSelection, t]);

  const handleToolbarToggleReversePlayback = useCallback(() => {
    if (hasEditableClipSelection) {
      handleToggleSelectedClipReversePlayback();
      return;
    }
    handleToolbarSceneClipToolRequest(t("toggleReversePlayback"));
  }, [handleToolbarSceneClipToolRequest, handleToggleSelectedClipReversePlayback, hasEditableClipSelection, t]);

  const handleToolbarToggleHorizontalFlip = useCallback(() => {
    if (hasEditableClipSelection) {
      handleToggleSelectedHorizontalFlip();
      return;
    }
    handleToolbarSceneClipToolRequest(t("toggleHorizontalFlip"));
  }, [handleToolbarSceneClipToolRequest, handleToggleSelectedHorizontalFlip, hasEditableClipSelection, t]);

  const handleToolbarRotateVisualClockwise = useCallback(() => {
    if (hasEditableClipSelection) {
      handleRotateSelectedVisual(90);
      return;
    }
    handleToolbarSceneClipToolRequest(t("rotateVisualClockwise"));
  }, [handleRotateSelectedVisual, handleToolbarSceneClipToolRequest, hasEditableClipSelection, t]);

  const handleToolbarSetVisualCrop = useCallback(() => {
    if (hasEditableClipSelection) {
      handleSetSelectedVisualCrop({ cropLeft: 0.1, cropRight: 0.1, cropTop: 0.1, cropBottom: 0.1 });
      return;
    }
    if (selectedTimelineScene && onUpdateSceneTransform) {
      const currentScale = Number(selectedTimelineScene.transformScale ?? 1) || 1;
      onUpdateSceneTransform(selectedTimelineScene.id, {
        fitMode: "cover",
        transformScale: Math.min(10, Math.max(1.1, currentScale + 0.1)),
      });
      toast.success(t("sceneCropApplied"));
      return;
    }
    handleToolbarSceneClipToolRequest(t("cropPresets"));
  }, [handleSetSelectedVisualCrop, handleToolbarSceneClipToolRequest, hasEditableClipSelection, onUpdateSceneTransform, selectedTimelineScene, t]);

  const handleSplitClipAtTime = useCallback(
    (clipId: string, time: number) => {
      if (!canSplitTimelineClip) return;
      if (_isSyntheticEmbeddedAudio(clipId)) {
        toast(t("audioLockedSplit"), { icon: "🔒" });
        return;
      }
      const splitId = getTimelineBladeSplitClipId(timelineClips || [], timelineTracks || [], clipId, time);
      if (!splitId) return;
      void commitTimelineClipSplits([splitId], time, { splitClip: onSplitClip, splitClips: onSplitClips })
        .then(selectCreatedSplitClips);
    },
    [canSplitTimelineClip, onSplitClip, onSplitClips, selectCreatedSplitClips, t, timelineClips, timelineTracks, _isSyntheticEmbeddedAudio]
  );

  const handleSplitClipIdsAtTime = useCallback(
    (clipIds: string[], time: number) => {
      if (!canSplitTimelineClip || clipIds.length === 0) return;
      const splitIds = clipIds
        .filter((clipId) => {
          if (!_isSyntheticEmbeddedAudio(clipId)) return true;
          toast(t("audioLockedSplit"), { icon: "🔒" });
          return false;
        })
        .map((clipId) => getTimelineBladeSplitClipId(timelineClips || [], timelineTracks || [], clipId, time))
        .filter((clipId): clipId is string => typeof clipId === "string" && clipId.length > 0);
      if (splitIds.length === 0) return;
      void commitTimelineClipSplits(splitIds, time, { splitClip: onSplitClip, splitClips: onSplitClips })
        .then(selectCreatedSplitClips);
    },
    [canSplitTimelineClip, onSplitClip, onSplitClips, selectCreatedSplitClips, t, timelineClips, timelineTracks, _isSyntheticEmbeddedAudio]
  );

  const handleSplitClipsAtTime = useCallback(
    (time: number) => {
      if (!canSplitTimelineClip) return;
      const splitIds = getTimelineBladeSplitClipIdsAtTime(timelineClips || [], timelineTracks || [], time);
      if (splitIds.length === 0) return;
      void commitTimelineClipSplits(splitIds, time, { splitClip: onSplitClip, splitClips: onSplitClips })
        .then(selectCreatedSplitClips);
    },
    [canSplitTimelineClip, onSplitClip, onSplitClips, selectCreatedSplitClips, timelineClips, timelineTracks],
  );

  const handleAddTextClip = useCallback(async (preset: "text" | "caption" | "subtitle" = "text") => {
    if (!canCreateTimelineClip) {
      toast.error(t("timelineCreateUnavailable"));
      return;
    }
    const ct = storeApi.getState().currentTime;
    const tracks = resolveTimelineTracksForType("text");
    if (!tracks) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const input = getTimelineAddTextClipInput(tracks, ct, preset, (timelineClips || []) as unknown as TimelineDuplicateClip[]);
    if (!input) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    handleCreateTimelineClip(input);
  }, [canCreateTimelineClip, resolveTimelineTracksForType, handleCreateTimelineClip, t, timelineClips]);

  const handleAddText = useCallback(() => {
    void handleAddTextClip("text");
  }, [handleAddTextClip]);

  // SRT/VTT subtitle import — parses the file client-side and batch-creates
  // one styled subtitle clip per cue on the first editable text track.
  const subtitleFileInputRef = useRef<HTMLInputElement | null>(null);
  // "line" = one clip per cue; "word" = karaoke-style one clip per word with
  // the cue's timing distributed across its words.
  const subtitleImportModeRef = useRef<"line" | "word">("line");
  const handleImportSubtitlesClick = useCallback((mode: "line" | "word" = "line") => {
    subtitleImportModeRef.current = mode;
    subtitleFileInputRef.current?.click();
  }, []);
  const handleSubtitleFileSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !canCreateTimelineClip) return;
    let cues: ReturnType<typeof parseSubtitleFile>;
    try {
      cues = parseSubtitleFile(await file.text());
    } catch {
      toast.error(t("subtitleImportFailed"));
      return;
    }
    if (cues.length === 0) {
      toast.error(t("subtitleImportEmpty"));
      return;
    }
    const tracks = resolveTimelineTracksForType("text");
    if (!tracks) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const isKaraoke = subtitleImportModeRef.current === "word";
    const importCues = isKaraoke ? splitSubtitleCuesIntoWords(cues) : cues;
    const inputs = getTimelineSubtitleImportInputs(
      importCues,
      tracks,
      "subtitle",
      isKaraoke ? { fontSize: 64, fontWeight: "800", bgColor: "#FF5700", strokeWidth: 0 } : null,
      (timelineClips || []) as unknown as TimelineDuplicateClip[],
    );
    if (inputs.length === 0) {
      toast.error(t("subtitleImportEmpty"));
      return;
    }
    try {
      const created = await commitTimelineClipCreates(inputs, { createClip: onCreateClip, createClips: onCreateClips });
      const ids = created
        .map((createdClip) => createdClip?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length === 0) {
        toast.error(t("clipCreateFailed"));
        return;
      }
      setSelectedClipIds(new Set(ids));
      toast.success(t("subtitleImportSuccess", { count: ids.length }));
    } catch {
      toast.error(t("clipCreateFailed"));
    }
  }, [canCreateTimelineClip, onCreateClip, onCreateClips, resolveTimelineTracksForType, setSelectedClipIds, t, timelineClips]);

  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [trackCtxMenu, setTrackCtxMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  // "Insert layer" submenu inside the track right-click menu — the layer list
  // is where people reach for a new track, so it offers the same track types
  // as the toolbar's Add track button instead of sending them hunting for it.
  const [trackCtxInsertOpen, setTrackCtxInsertOpen] = useState(false);

  const handleAddStickerConfirm = useCallback(async (url: string) => {
    if (!url.trim() || !canCreateTimelineClip) return;
    const stickerTracks = resolveTimelineTracksForType("sticker");
    if (!stickerTracks) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const stickerTrack = stickerTracks.find((t) => t.type === "sticker" && !t.locked && t.visible !== false);
    const trackIndex = stickerTrack?.index ?? 1;
    const ct = storeApi.getState().currentTime;
    // Never stack on an existing sticker — land in the nearest free spot.
    const blockers = ((timelineClips || []) as unknown as TimelineDuplicateClip[])
      .filter((clip) => clip.trackType === "sticker" && clip.trackIndex === trackIndex);
    const startTime = resolveTimelineDropStart(ct, 5, blockers);
    if (startTime === null) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    handleCreateTimelineClip({
      trackType: "sticker",
      trackIndex,
      startTime,
      endTime: startTime + 5,
      mediaUrl: url.trim(),
      positionX: 0.5,
      positionY: 0.5,
      scale: 1,
      opacity: 1,
    });
  }, [canCreateTimelineClip, resolveTimelineTracksForType, handleCreateTimelineClip, t, timelineClips]);

  // Add an EFFECT LAYER: a time-ranged segment on its own "Effects" track,
  // like a text layer. The effect itself is stored as a ClipEffect attached to
  // the new clip; it applies to the video beneath it for its duration.
  const handleAddEffectLayer = useCallback((effectId: string, name: string, atTime?: number, preferredTrackIndex?: number) => {
    if (!canCreateTimelineClip) return;
    // Resolve the row locally (a drop may target a new effect row), then write track + clip + effect row as one
    // command (effect.layer.add): one undo step, and no empty layer when any write fails.
    const rawBaseTracks = timelineTracks?.length ? timelineTracks : defaultTracks;
    const { tracks: baseTracks } = timelineTracks?.length ? withRequiredBaseTimelineTracks(rawBaseTracks) : { tracks: rawBaseTracks };
    const hasEditable = baseTracks.some((tk) => tk.type === "effect" && !tk.locked && tk.visible !== false);
    const tracks = hasEditable ? baseTracks : [...baseTracks, getNextTrackForType(baseTracks, "effect")];
    const editableEffectTracks = tracks.filter((tk) => tk.type === "effect" && !tk.locked && tk.visible !== false);
    const preferredTrack = typeof preferredTrackIndex === "number"
      ? editableEffectTracks.find((tk) => tk.index === preferredTrackIndex)
      : undefined;
    if (typeof preferredTrackIndex === "number" && !preferredTrack) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const fallbackTrack = [...editableEffectTracks].sort((a, b) => a.index - b.index)[0];
    const trackIndex = preferredTrack?.index ?? fallbackTrack?.index;
    if (!trackIndex) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const ct = atTime ?? storeApi.getState().currentTime;
    // Never stack on an existing effect segment — land in the nearest free spot.
    const blockers = ((timelineClips || []) as unknown as TimelineDuplicateClip[])
      .filter((clip) => clip.trackType === "effect" && clip.trackIndex === trackIndex);
    const startTime = resolveTimelineDropStart(ct, 3, blockers);
    if (startTime === null) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const started = timelineController.start({
      type: "effect.layer.add", effectId, label: name, trackIndex, startTime, endTime: startTime + 3, tracks,
    });
    const tempId = started.optimistic.clipIds[0];
    if (tempId) setSelectedClipIds(new Set([tempId]));
    void started.settled.then((result) => {
      const createdId = result.createdClipIds?.[0];
      if (!result.ok || !createdId) {
        if (!result.superseded && !result.cancelled) toast.error(t("clipCreateFailed"));
        return;
      }
      const prev = storeApi.getState().selectedClipIds;
      if (tempId && !prev.has(tempId)) return;
      setSelectedClipIds(new Set([createdId]));
    });
  }, [
    canCreateTimelineClip,
    getNextTrackForType,
    setSelectedClipIds,
    storeApi,
    t,
    timelineClips,
    timelineController,
    timelineTracks,
  ]);

  // Resolve which graphics track a new clip lands on, or report why it can't.
  // Shared by the built-in template path and the user's library.
  const resolveRemotionTrackIndex = useCallback((preferredTrackIndex?: number): number | null => {
    const tracks = resolveTimelineTracksForType("remotion");
    if (!tracks) return null;
    const editableRemotionTracks = tracks.filter((tk) => tk.type === "remotion" && !tk.locked && tk.visible !== false);
    const preferredTrack = typeof preferredTrackIndex === "number"
      ? editableRemotionTracks.find((tk) => tk.index === preferredTrackIndex)
      : undefined;
    if (typeof preferredTrackIndex === "number" && !preferredTrack) return null;
    const fallbackTrack = [...editableRemotionTracks].sort((a, b) => a.index - b.index)[0];
    return preferredTrack?.index ?? fallbackTrack?.index ?? null;
  }, [resolveTimelineTracksForType]);

  // Create the clip and keep the selection pointed at it once the server
  // assigns a real id. Same handoff for templates and library graphics.
  const createRemotionClip = useCallback((input: TimelineClipCreateInput) => {
    if (onStartCreateClip) {
      const { tempId, settled } = onStartCreateClip(input);
      setSelectedClipIds(new Set([tempId]));
      void settled.then((created) => {
        if (!created?.id) {
          toast.error(t("clipCreateFailed"));
          return;
        }
        const prev = storeApi.getState().selectedClipIds;
        if (!prev.has(tempId)) return;
        const next = new Set(prev);
        next.delete(tempId);
        next.add(created.id);
        setSelectedClipIds(next);
      });
      return;
    }

    handleCreateTimelineClip(input);
  }, [onStartCreateClip, handleCreateTimelineClip, setSelectedClipIds, t]);

  // Drop a GRAPHICS clip (Remotion template) on the graphics track at the
  // playhead. The Graphics gallery panel dispatches this when a card is clicked.
  const handleAddRemotionGraphic = useCallback((templateId: string, atTime?: number, preferredTrackIndex?: number) => {
    if (!canCreateTimelineClip) {
      toast.error(t("timelineCreateUnavailable"));
      return;
    }
    const template = templateById(templateId);
    if (!template) return;
    const trackIndex = resolveRemotionTrackIndex(preferredTrackIndex);
    if (!trackIndex) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const ct = atTime ?? storeApi.getState().currentTime;
    createRemotionClip({
      trackType: "remotion",
      trackIndex,
      startTime: ct,
      endTime: ct + 4,
      label: template.name,
      remotionTemplateId: templateId,
      remotionPropsJson: JSON.stringify(defaultPropsFor(templateId)),
    });
  }, [canCreateTimelineClip, resolveRemotionTrackIndex, createRemotionClip, t]);

  // Drop a graphic from the user's library. The clip only carries the id —
  // the graphic's code is resolved server-side at export.
  const handleAddCustomGraphic = useCallback((
    graphic: { id: string; name: string; durationSeconds?: number },
    atTime?: number,
    preferredTrackIndex?: number,
  ) => {
    if (!canCreateTimelineClip) {
      toast.error(t("timelineCreateUnavailable"));
      return;
    }
    const trackIndex = resolveRemotionTrackIndex(preferredTrackIndex);
    if (!trackIndex) {
      toast.error(t("clipCreateFailed"));
      return;
    }
    const ct = atTime ?? storeApi.getState().currentTime;
    const duration = Math.max(0.5, graphic.durationSeconds || 3);
    createRemotionClip({
      trackType: "remotion",
      trackIndex,
      startTime: ct,
      endTime: ct + duration,
      label: graphic.name,
      customGraphicId: graphic.id,
    });
  }, [canCreateTimelineClip, resolveRemotionTrackIndex, createRemotionClip, t]);

  useImperativeHandle(ref, () => ({
    splitAtPlayhead: (options) => handleSplitAtPlayhead(Boolean(options?.activeTrackOnly)),
    addEffectLayer: (effectId, name) => { void handleAddEffectLayer(effectId, name || "Effect"); },
    addGraphic: (input) => {
      if (input.templateId) handleAddRemotionGraphic(input.templateId);
      else if (input.customGraphicId) {
        handleAddCustomGraphic({ id: input.customGraphicId, name: input.name || "", durationSeconds: input.durationSeconds });
      }
    },
  }), [handleAddCustomGraphic, handleAddEffectLayer, handleAddRemotionGraphic, handleSplitAtPlayhead]);

  // Drop an AI video clip on the video track at the current playhead.
  // mediaUrl is null until the user fills in a prompt and hits Generate from
  // the properties panel; the row otherwise behaves like any other clip.
  const handleAddAiGenerate = useCallback(() => {
    if (!canCreateTimelineClip) return;
    const videoTrack = sortedTracks.find((t) => t.type === "video");
    const trackIndex = videoTrack?.index ?? 1;
    const ct = storeApi.getState().currentTime;
    handleCreateTimelineClip({
      trackType: "video",
      trackIndex,
      startTime: ct,
      endTime: ct + 5,
      mediaType: "ai_generate",
      label: "AI video", // i18n-ignore
      positionX: 0.5,
      positionY: 0.5,
      scale: 1,
      opacity: 1,
    });
  }, [canCreateTimelineClip, handleCreateTimelineClip, sortedTracks]);

  // T keyboard shortcut → add text clip
  useEffect(() => {
    if (addTextRequest !== null) {
      void handleAddTextClip(addTextRequest.preset);
      setAddTextRequest(null);
    }
  }, [addTextRequest, handleAddTextClip, setAddTextRequest]);

  // Delete key (editor-layout) → delete selected scene/transition/audio target
  // through the same handler as the toolbar trash button.
  const deleteSelectionRequest = useEditorStore((s) => s.deleteSelectionRequest);
  const setDeleteSelectionRequest = useEditorStore((s) => s.setDeleteSelectionRequest);
  useEffect(() => {
    if (deleteSelectionRequest !== null) {
      handleDeleteSelectedTimelineItems();
      setDeleteSelectionRequest(null);
    }
  }, [deleteSelectionRequest, handleDeleteSelectedTimelineItems, setDeleteSelectionRequest]);

  useTimelineShortcuts([
    { match: (e) => (e.key === "z" || e.key === "Z") && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey, run: handleZoomFit },
    { match: (e) => (e.key === "z" || e.key === "Z") && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey, run: handleZoomFitSelection },
    { match: (e) => (e.key === "z" || e.key === "Z") && !e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey, run: handleCenterPlayhead },
  ], { enabled: shortcutsEnabled, rootRef: scrollContainerRef });

  // Sources panel image click → add sticker clip
  useEffect(() => {
    if (addImageRequest) {
      void handleAddStickerConfirm(addImageRequest);
      setAddImageRequest(null);
    }
  }, [addImageRequest, handleAddStickerConfirm, setAddImageRequest]);

  // Drop handler for adding clips from media panel drag
  const handleTrackDrop = useCallback(
    async (trackType: string, trackIndex: number, time: number, data: Record<string, unknown>) => {
      // Transition card dropped → attach it to the clip under the cursor (the
      // transition lives on that clip's junction with the next clip).
      if (data?.kind === "transition" && typeof data.transitionId === "string") {
        // Dropped on a scene → set the scene's visual transition (its cut to the next scene).
        const dropSceneId = data.sceneId as string | undefined;
        if (dropSceneId && onSetSceneTransition) {
          const sceneTransitionTracks = effectiveTimelineTracks.length > 0 ? effectiveTimelineTracks : defaultTracks;
          if (!getEditableSceneTransitionTarget(scenes, sceneTransitionTracks, dropSceneId)) return;
          // NaN: the transition's own default duration (looks/transitions.ts).
          onSetSceneTransition(dropSceneId, normalizeTimelineTransitionType(data.transitionId), Number.NaN);
          return;
        }
        // Dropped on an upper-track video/image clip → the transition goes on its cut (its own cut to the
        // next touching clip, else the previous clip's cut into it): a centered window like a scene cut.
        const dropClipId = data.clipId as string | undefined;
        const junction = dropClipId ? clipJunction(timelineClips ?? [], dropClipId) : null;
        const dropClip = dropClipId ? timelineClips?.find((c) => c.id === dropClipId) : undefined;
        const dropTrack = dropClip ? effectiveTimelineTracks.find((tr) => tr.type === "video" && tr.index === dropClip.trackIndex) : undefined;
        if (!junction || dropTrack?.locked) return;
        const result = await timelineController.execute({ type: "transition.set", clipId: junction.outgoingId, transition: normalizeTimelineTransitionType(data.transitionId) });
        if (result.ok) storeApi.getState().selectTransition({ kind: "clip", id: junction.outgoingId });
        return;
      }

      if (!canCreateTimelineClip) return;

      // Remotion graphic dropped from the Graphics library.
      if (data?.kind === "remotion" && typeof data.templateId === "string") {
        handleAddRemotionGraphic(data.templateId, Math.max(0, time), trackIndex);
        return;
      }

      // Bundled sticker from the Stickers library: a 3 s clip at the drop time, on the sticker track under the
      // cursor (else a free or new sticker track).
      if (data?.kind === "sticker" && typeof data.stickerId === "string") {
        const placed = await addStickerClip(timelineController, storeApi, data.stickerId, Math.max(0, time), {
          preferredTrackIndex: trackType === "sticker" ? trackIndex : undefined,
          label: typeof data.name === "string" ? data.name : undefined,
        });
        if (!placed.ok) toast.error(t("clipCreateFailed"));
        return;
      }

      // Text template from the Text library: its text clip (style + animation) at the drop time, on the text
      // track under the cursor when free (else a free or new text track); one undo step.
      if (data?.kind === TEXT_TEMPLATE_DRAG_KIND && typeof data.templateId === "string") {
        const placed = await addTextFromTemplate(timelineController, storeApi, data.templateId, {
          at: Math.max(0, time), preferredTrackIndex: trackType === "text" ? trackIndex : undefined,
        });
        if (!placed.ok) toast.error(t("clipCreateFailed"));
        return;
      }

      // Effect card dropped from the Effects library → add a clean 3s effect
      // layer at the DROP POINT (matches the pre-drop ghost). Fixed 3s width so
      // it never stretches into a full-width bar.
      if (data?.kind === "effect" && typeof data.effectId === "string") {
        // Onto a scene or a visual clip: that item's own effect stack (one undoable command).
        if (typeof data.sceneId === "string" || typeof data.clipId === "string") {
          const target = typeof data.sceneId === "string" ? { sceneId: data.sceneId } : { clipId: data.clipId as string };
          void timelineController.execute({ type: "clip.effect.add", ...target, effectId: data.effectId });
          return;
        }
        void handleAddEffectLayer(data.effectId, (data.name as string) || "Effect", Math.max(0, time), trackIndex);
        return;
      }

      if (data?.kind === "filter" && typeof data.filterId === "string" && (typeof data.sceneId === "string" || typeof data.clipId === "string")) {
        const target = typeof data.sceneId === "string" ? { sceneId: data.sceneId } : { clipId: data.clipId as string };
        void timelineController.execute({ type: "look.set", ...target, filter: data.filterId, intensity: 0.8 });
        return;
      }

      const isAudioPayload = data?.mediaType === "audio" || data?.sourceType != null;
      const isImagePayload = data?.mediaType === "image";
      const isVideoPayload = data?.mediaType === "video";

      // Block non-media drops (e.g. website URLs, Instagram links)
      if (!isAudioPayload && !isImagePayload && !isVideoPayload && data?.mediaType === "url") return;
      if (!isAudioPayload && !isImagePayload && !isVideoPayload && !data?.url) return;

      // Video dropped on the main track (V1) becomes a main-track clip (a source-clip scene) at the drop
      // point, snapped to a neighbour's edge so cuts touch (transitions need touching clips); a point
      // inside another clip appends after the last one.
      if (isVideoPayload && trackType === "video" && trackIndex === 1 && typeof data.url === "string") {
        const lane = (scenes as SceneData[])
          .map((s, i) => ({ s, start: getSceneStart(s, scenes as SceneData[], i), end: getSceneStart(s, scenes as SceneData[], i) + getSceneDuration(s) }))
          .filter((entry) => Number(entry.s.trackIndex || 1) === 1);
        const length = typeof data.duration === "number" && data.duration > 0 ? data.duration : 5;
        const laneEnd = lane.reduce((end, entry) => Math.max(end, entry.end), 0);
        let at = Math.max(0, time);
        const snapEdge = lane.map((entry) => entry.end).concat(lane.map((entry) => entry.start - length)).find((edge) => Math.abs(edge - at) <= 0.35 && edge >= 0);
        if (snapEdge !== undefined) at = snapEdge;
        if (lane.some((entry) => at < entry.end - 0.001 && at + length > entry.start + 0.001)) at = laneEnd;
        await timelineController.execute({
          type: "scene.add",
          input: {
            afterOrder: (scenes as SceneData[]).reduce((max, s) => Math.max(max, s.order), -1),
            cardType: "source_clip",
            sourceVideoUrl: data.url,
            trackIndex: 1,
            timelinePositionSeconds: at > 0 ? at : 0.001,
            duration: length,
            caption: typeof data.name === "string" ? data.name : undefined,
          },
        });
        return;
      }

      const resolvedTrackType = isAudioPayload ? "audio" : (isVideoPayload || isImagePayload) ? "video" : trackType;
      let resolvedTrackIndex = trackIndex;

      // Video AND image clips live on overlay lanes (V2+) — V1 is the scene
      // strip, and images share the video lane family (no separate image
      // track). Route the drop to an editable overlay video track, creating
      // one optimistically when the project has none.
      if (isVideoPayload || isImagePayload) {
        const baseVideoTracks = timelineTracks?.length
          ? withRequiredBaseTimelineTracks(timelineTracks).tracks
          : defaultTracks;
        const overlayVideoTracks = baseVideoTracks
          .filter((track) => track.type === "video" && track.index >= 2 && !track.locked && track.visible !== false)
          .sort((a, b) => a.index - b.index);
        const requestedVideoTrack = trackType === "video" && trackIndex >= 2
          ? overlayVideoTracks.find((track) => track.index === trackIndex)
          : undefined;
        if (requestedVideoTrack) {
          resolvedTrackIndex = requestedVideoTrack.index;
        } else if (overlayVideoTracks.length > 0) {
          resolvedTrackIndex = overlayVideoTracks[0].index;
        } else if (onUpdateTracks) {
          const newVideoTrack = getNextTrackForType(baseVideoTracks, "video");
          void onUpdateTracks([...baseVideoTracks, newVideoTrack]).catch(() => undefined);
          resolvedTrackIndex = newVideoTrack.index;
        } else {
          toast.error(t("clipCreateFailed"));
          return;
        }
      }

      if (isAudioPayload) {
        const baseAudioTracks = timelineTracks?.length
          ? withRequiredBaseTimelineTracks(timelineTracks).tracks
          : defaultTracks;
        const targetedAudioTrack = trackType === "audio"
          ? baseAudioTracks.find((track) => track.type === "audio" && track.index === trackIndex)
          : null;
        if (targetedAudioTrack && (targetedAudioTrack.locked || targetedAudioTrack.visible === false)) {
          toast.error(t("clipCreateFailed"));
          return;
        }
        const persistedAudioTracks = timelineTracks?.filter((track) => track.type === "audio") ?? [];
        const hasEditableAudioTrack = baseAudioTracks.some((track) => (
          track.type === "audio" && !track.locked && track.visible !== false
        ));
        if (!hasEditableAudioTrack && persistedAudioTracks.length > 0) {
          toast.error(t("clipCreateFailed"));
          return;
        }
        const audioTracks = resolveTimelineTracksForType("audio");
        if (!audioTracks) {
          toast.error(t("clipCreateFailed"));
          return;
        }
        const editableAudioTracks = audioTracks
          .filter((track) => track.type === "audio" && !track.locked && track.visible !== false)
          .sort((a, b) => a.index - b.index);
        const requestedAudioTrack =
          trackType === "audio"
            ? editableAudioTracks.find((track) => track.index === trackIndex)
            : undefined;
        resolvedTrackIndex = requestedAudioTrack?.index ?? editableAudioTracks[0]?.index ?? 1;
      }

      // Block drops on V1 — it's the scene track, not a clip track. Audio,
      // image, and video payloads route to their own editable tracks above
      // before this guard.
      if (trackType === "video" && trackIndex === 1 && !isAudioPayload && !isImagePayload && !isVideoPayload) return;

      // For audio, prefer real media metadata. Source/generated records can
      // carry stale durations, which makes a long music file appear short.
      let clipDuration =
        !isAudioPayload && typeof data?.duration === "number" && Number.isFinite(data.duration) && data.duration > 0
          ? data.duration
          : 0;

      // Probe real duration when the payload didn't carry one — a dropped
      // video must land at its actual length, never a fake 5s default. The
      // Audio element parses mp4 container metadata too, so one prober
      // covers both audio and video URLs.
      if (!clipDuration && (isAudioPayload || isVideoPayload) && data.url) {
        const controller = new AbortController();
        trackDropAudioDurationAbortRef.current.add(controller);
        try {
          clipDuration = await loadAudioDuration(data.url as string, { resolveUrl: media.resolveMediaUrl, signal: controller.signal });
          if (controller.signal.aborted) return;
        } finally {
          trackDropAudioDurationAbortRef.current.delete(controller);
        }
      }

      if (!clipDuration && isAudioPayload && typeof data?.duration === "number" && Number.isFinite(data.duration) && data.duration > 0) {
        clipDuration = data.duration;
      }

      if (!clipDuration) clipDuration = 5;

      // A dropped clip must never land on top of an existing clip — that
      // visually swallows whatever was already on the lane. Prefer the lane
      // the drop targeted; when it's occupied at the drop range, bump to the
      // next free lane of the same type, creating a new track when all are
      // full. Runs after the duration probe so the overlap window is real.
      if (isVideoPayload || isImagePayload || isAudioPayload) {
        const dropType = isAudioPayload ? "audio" : "video";
        const overlapBaseTracks = timelineTracks?.length
          ? withRequiredBaseTimelineTracks(timelineTracks).tracks
          : defaultTracks;
        const editableIndices = overlapBaseTracks
          .filter((track) => (
            track.type === dropType && !track.locked && track.visible !== false &&
            (dropType !== "video" || track.index >= 2)
          ))
          .map((track) => track.index)
          .sort((a, b) => a - b);
        const candidates = [resolvedTrackIndex, ...editableIndices.filter((i) => i !== resolvedTrackIndex)];
        const freeIndex = resolveNonOverlappingTrackIndex(
          timelineClips ?? [], dropType, candidates, time, time + clipDuration,
        );
        if (freeIndex != null) {
          resolvedTrackIndex = freeIndex;
        } else if (onUpdateTracks) {
          const bumpTrack = getNextTrackForType(overlapBaseTracks, dropType);
          void onUpdateTracks([...overlapBaseTracks, bumpTrack]).catch(() => undefined);
          resolvedTrackIndex = bumpTrack.index;
        }
      }

      handleCreateTimelineClip({
        trackType: resolvedTrackType,
        trackIndex: resolvedTrackIndex,
        startTime: time,
        endTime: time + clipDuration,
        mediaUrl: data.url || null,
        mediaType: data.mediaType || (resolvedTrackType === "audio" ? "audio" : "uploaded"),
        label: data.name || null,
        thumbnailUrl: data.thumbnail || null,
        textContent: resolvedTrackType === "text" ? (data.text || "Text") : null,
        // Images composite like overlays — centered, full opacity by default.
        ...(isImagePayload ? { positionX: 0.5, positionY: 0.5, scale: 1, opacity: 1 } : {}),
      });
    },
    [canCreateTimelineClip, handleCreateTimelineClip, effectiveTimelineTracks, sortedTracks, handleAddEffectLayer, handleAddRemotionGraphic, timelineClips, timelineTracks, onUpdateClip, onUpdateClips, onUpdateTracks, onSetSceneTransition, resolveTimelineTracksForType, getNextTrackForType, t, media, timelineController, storeApi]
  );

  const trackContentWidth = Math.max(
    contentWidthPx(Math.max(totalDuration, contentEnd(scenesToEngineItems(scenes))), timelineZoom),
    100,
  );
  const effectDropPreviewLabelNode = effectDropPreviewLabel && !hasRealPreviewEffectTrack ? (
    <div
      data-testid="effect-track-preview-label"
      className="flex items-center justify-center border-b border-dashed border-purple-400/30 bg-purple-500/10 px-1"
      style={{ height: effectDropPreviewLabel.height }}
    >
      <div className="flex items-center gap-1">
        <Wand2 className="h-3 w-3 text-purple-400/70" />
        <span className="text-[9px] font-semibold text-purple-200/80">
          {`E${effectDropPreviewLabel.trackIndex}`}
        </span>
      </div>
    </div>
  ) : null;
  const firstVideoTrackLabelIndex = sortedTracks.findIndex((track) => track.type === "video");

  return (
    <div className="h-full flex flex-col border-t border-[rgba(255,255,255,0.14)] bg-[#0A0A0B] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <Dialog open={Boolean(timelineConfirm)} onOpenChange={(open) => { if (!open) resolveTimelineConfirm(false); }}>
        <DialogContent showCloseButton={false} className="w-[min(420px,calc(100vw-32px))] max-w-none gap-0 rounded-lg border border-[rgba(255,255,255,0.10)] bg-[#17171A] p-0 text-[#F2F2F4] ring-0">
          <DialogHeader className="gap-3 border-b border-[rgba(255,255,255,0.08)] px-4 py-4">
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${timelineConfirm?.intent === "danger" ? "bg-red-500/12 text-red-300" : "bg-amber-400/12 text-amber-300"}`}>
                <SquareScissors className="h-4 w-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <DialogTitle className="text-[15px] font-semibold leading-5 text-[#F2F2F4]">
                  {timelineConfirm?.title}
                </DialogTitle>
                <DialogDescription className="text-[13px] leading-5 text-[#B8B8C0]">
                  {timelineConfirm?.description}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="m-0 flex-row justify-end gap-2 rounded-none border-t-0 bg-[#141416] px-4 py-3">
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center rounded-md border border-[rgba(255,255,255,0.10)] bg-[#202024] px-3 text-[13px] font-medium text-[#D9D9DE] hover:bg-[#28282D] focus:outline-none focus:ring-2 focus:ring-[var(--on-ring)]"
              onClick={() => resolveTimelineConfirm(false)}
            >
              {timelineConfirm?.cancelLabel}
            </button>
            <button
              type="button"
              className={`inline-flex h-8 items-center justify-center rounded-md px-3 text-[13px] font-semibold text-white focus:outline-none focus:ring-2 ${timelineConfirm?.intent === "danger" ? "bg-red-500 hover:bg-red-400 focus:ring-red-300/45" : "bg-[var(--on-primary)] !text-[var(--on-primary-foreground)] hover:bg-[var(--on-primary-hover)] focus:ring-[var(--on-ring)]"}`}
              onClick={() => resolveTimelineConfirm(true)}
            >
              {timelineConfirm?.confirmLabel}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Toolbar row */}
      <TooltipProvider delay={300}>
      <div className={TIMELINE_TOOLBAR_ROW_CLASS}>
        {/* Left: editing controls */}
        <div className={TIMELINE_TOOLBAR_LEFT_RAIL_CLASS}>
          <div className="relative">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger render={<span />} className="inline-flex">
                  <DropdownMenuTrigger
                    aria-label={t("addClip")}
                    disabled={!canCreateTimelineClip}
                    className={TIMELINE_TOOLBAR_ADD_BUTTON_CLASS}
                  >
                    <Plus className={TIMELINE_TOOLBAR_ICON_CLASS} />
                    <span>{t("addClip")}</span>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-56 flex-col items-start">
                  <span>{canCreateTimelineClip ? t("addClip") : createUnavailableReason}</span>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" sideOffset={6} collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }} className={TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS}>
                <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleAddText} disabled={!canCreateTimelineClip} disabledReason={createUnavailableReason}>
                  <span className="flex items-center gap-2"><Type className="h-3.5 w-3.5" />{t("addText")}</span>
                  <DropdownMenuShortcut>T</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={() => { void handleAddTextClip("caption"); }} disabled={!canCreateTimelineClip} disabledReason={createUnavailableReason}>
                  <span className="flex items-center gap-2"><Type className="h-3.5 w-3.5" />{t("addCaptionClip")}</span>
                  <DropdownMenuShortcut>⇧T</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={() => { void handleAddTextClip("subtitle"); }} disabled={!canCreateTimelineClip} disabledReason={createUnavailableReason}>
                  <span className="flex items-center gap-2"><Type className="h-3.5 w-3.5" />{t("addSubtitleClip")}</span>
                  <DropdownMenuShortcut>⌥T</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={() => handleImportSubtitlesClick("line")} disabled={!canCreateTimelineClip} disabledReason={createUnavailableReason}>
                  <span className="flex items-center gap-2"><Type className="h-3.5 w-3.5" />{t("importSubtitles")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={() => handleImportSubtitlesClick("word")} disabled={!canCreateTimelineClip} disabledReason={createUnavailableReason}>
                  <span className="flex items-center gap-2"><Type className="h-3.5 w-3.5" />{t("importSubtitlesKaraoke")}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator className={TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS} />
                <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleAddAiGenerate} disabled={!canCreateTimelineClip} disabledReason={createUnavailableReason}>
                  <span className="flex items-center gap-2"><Wand2 className="h-3.5 w-3.5" />{t("addAiVideoClip")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={() => setShowStickerPicker((v) => !v)} disabled={!canCreateTimelineClip} disabledReason={createUnavailableReason}>
                  <span className="flex items-center gap-2"><ImagePlus className="h-3.5 w-3.5" />{t("addSticker")}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input
              ref={subtitleFileInputRef}
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              className="hidden"
              data-testid="subtitle-import-input"
              onChange={(e) => { void handleSubtitleFileSelected(e); }}
            />
            {showStickerPicker && (
              <div className="absolute left-0 top-8 z-50 h-72 w-72 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#141416] shadow-xl">
                <StickerPicker
                  onSelect={(url, emoji) => {
                    void (async () => {
                      const tracks = resolveTimelineTracksForType("sticker");
                      if (!tracks) {
                        toast.error(t("clipCreateFailed"));
                        return;
                      }
                      const stickerTrack = tracks.find((t) => t.type === "sticker" && !t.locked && t.visible !== false);
                      const trackIndex = stickerTrack?.index ?? 1;
                      const ct = storeApi.getState().currentTime;
                      handleCreateTimelineClip({
                        trackType: "sticker",
                        trackIndex,
                        startTime: ct,
                        endTime: ct + 5,
                        mediaUrl: url || null,
                        textContent: url ? null : emoji,
                        positionX: 0.5,
                        positionY: 0.5,
                        scale: 1,
                        opacity: 1,
                      });
                      setShowStickerPicker(false);
                    })();
                  }}
                />
              </div>
            )}
          </div>
          <span className={TIMELINE_TOOLBAR_SEPARATOR_CLASS} aria-hidden="true" />

          <TipBtn tip={t("select")} shortcut="V" onClick={() => setToolMode("select")} className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} ${toolMode === "select" ? TIMELINE_TOOLBAR_BUTTON_ACTIVE_CLASS : ""}`}>
            <MousePointer2 className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("selectBeforePlayhead")} shortcut="Shift+A" onClick={() => handleSelectTimelineRange(-1)} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <ChevronFirst className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("selectAfterPlayhead")} shortcut="A" onClick={() => handleSelectTimelineRange(1)} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <ChevronLast className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <span className={TIMELINE_TOOLBAR_SEPARATOR_CLASS} aria-hidden="true" />

          <div className={TIMELINE_TOOLBAR_CORE_EDIT_GROUP_CLASS}>
            <TipBtn tip={t("undo")} shortcut="⌘Z" onClick={() => { void onUndo?.(); }} disabled={!canUndo} disabledReason={undoDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
              <Undo2 className={TIMELINE_TOOLBAR_ICON_CLASS} />
            </TipBtn>
            <TipBtn tip={t("redo")} shortcut="⌘⇧Z / Ctrl+Y" onClick={() => { void onRedo?.(); }} disabled={!canRedo} disabledReason={redoDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
              <Redo2 className={TIMELINE_TOOLBAR_ICON_CLASS} />
            </TipBtn>
          </div>
          <span className={TIMELINE_TOOLBAR_SEPARATOR_CLASS} aria-hidden="true" />

          <TipBtn tip={t("splitAtPlayhead")} shortcut="⌘B" onClick={() => handleSplitAtPlayhead()} disabled={!canSplitTimelineClip} disabledReason={splitDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <SquareScissors className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("deleteSelected")} shortcut={t("deleteShortcut")} onClick={handleDeleteSelectedTimelineItems} disabled={!canDeleteToolbarSelection} disabledReason={deleteToolbarDisabledReason} className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} ${TIMELINE_TOOLBAR_BUTTON_DANGER_CLASS}`}>
            <Trash2 className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("trimStartToPlayhead")} shortcut="Q" onClick={() => handleTrimSelectedClipsToPlayhead("start")} disabled={!hasEditableClipSelection || !canUpdateTimelineClip} disabledReason={selectionEditDisabledReason} className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} ${TIMELINE_TOOLBAR_BUTTON_DANGER_CLASS}`}>
            <PanelLeftClose className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("trimEndToPlayhead")} shortcut="W" onClick={() => handleTrimSelectedClipsToPlayhead("end")} disabled={!hasEditableClipSelection || !canUpdateTimelineClip} disabledReason={selectionEditDisabledReason} className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} ${TIMELINE_TOOLBAR_BUTTON_DANGER_CLASS}`}>
            <PanelRightClose className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <span className={TIMELINE_TOOLBAR_SEPARATOR_CLASS} aria-hidden="true" />

          <TipBtn tip={t("toggleMarker")} shortcut="M" onClick={handleToggleMarkerAtPlayhead} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <Flag className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <span className={TIMELINE_TOOLBAR_SEPARATOR_CLASS} aria-hidden="true" />

          <TipBtn tip={t("toggleFreezeFrame")} onClick={handleToolbarToggleFreezeFrame} disabled={!canSceneClipToolSelection} disabledReason={sceneClipToolDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <Snowflake className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("toggleReversePlayback")} onClick={handleToolbarToggleReversePlayback} disabled={!canSceneClipToolSelection} disabledReason={sceneClipToolDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <RotateCcw className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("toggleHorizontalFlip")} shortcut="⌥⇧H" onClick={handleToolbarToggleHorizontalFlip} disabled={!canSceneClipToolSelection} disabledReason={sceneClipToolDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <FlipHorizontal2 className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("rotateVisualClockwise")} shortcut="⌥⇧R" onClick={handleToolbarRotateVisualClockwise} disabled={!canSceneClipToolSelection} disabledReason={sceneClipToolDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <RotateCw className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <TipBtn tip={t("cropPresets")} onClick={handleToolbarSetVisualCrop} disabled={!canCropToolbarSelection} disabledReason={cropToolbarDisabledReason} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
            <Crop className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          <span className={TIMELINE_TOOLBAR_SEPARATOR_CLASS} aria-hidden="true" />

          <TipBtn tip={snapEnabled ? t("snapOn") : t("snapOff")} onClick={() => setSnapEnabled(!snapEnabled)} className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} ${snapEnabled ? TIMELINE_TOOLBAR_BUTTON_ACTIVE_CLASS : ""}`}>
            <Magnet className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>
          {/* Snap to beats (phase 11): beat dots of audio clips join the snap points. */}
          <TipBtn
            tip={t("snapToBeats")}
            hint={snapToBeats ? t("snapToBeatsOnHint") : t("snapToBeatsOffHint")}
            pressed={snapToBeats}
            testId="toolbar-snap-to-beats"
            onClick={() => { void timelineController.execute({ type: "view.update", snapToBeats: !snapToBeats }); }}
            className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} ${snapToBeats ? TIMELINE_TOOLBAR_BUTTON_ACTIVE_CLASS : ""}`}
          >
            <BeatMagnetIcon className={TIMELINE_TOOLBAR_ICON_CLASS} />
          </TipBtn>

          {/* Secondary edit tools */}
          <DropdownMenu>
            <div className={TIMELINE_TOOLBAR_STICKY_MENU_TRIGGER_CLASS}>
              <DropdownMenuTrigger
                aria-label={t("editActions")}
                title={t("editActions")}
                className={TIMELINE_TOOLBAR_BUTTON_CLASS}
              >
                <MoreHorizontal className={TIMELINE_TOOLBAR_ICON_CLASS} />
              </DropdownMenuTrigger>
            </div>
            <DropdownMenuContent align="start" sideOffset={6} className={TIMELINE_TOOLBAR_ADVANCED_MENU_CLASS}>
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={() => { void onUndo?.(5); }} disabled={!canUndo} title={!canUndo ? undoDisabledReason : undefined}>
                <span className="flex items-center gap-2"><Undo2 className="h-3.5 w-3.5" />{t("undoFive")}</span>
                <DropdownMenuShortcut>⌘⌥Z</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={() => { void onRedo?.(5); }} disabled={!canRedo} title={!canRedo ? redoDisabledReason : undefined}>
                <span className="flex items-center gap-2"><Redo2 className="h-3.5 w-3.5" />{t("redoFive")}</span>
                <DropdownMenuShortcut>⌘⌥⇧Z</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator className={TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS} />
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleSplitAllTracksAtPlayhead} disabled={!canSplitTimelineClip} title={!canSplitTimelineClip ? splitDisabledReason : undefined}>
                <span className="flex items-center gap-2"><Split className="h-3.5 w-3.5" />{t("splitAllTracksAtPlayhead")}</span>
                <DropdownMenuShortcut>⌘⌥⇧B</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleSplitAtNearestMarker} disabled={!canSplitTimelineClip || timelineMarkers.length === 0} title={!canSplitTimelineClip || timelineMarkers.length === 0 ? markerDisabledReason : undefined}>
                <span className="flex items-center gap-2"><Split className="h-3.5 w-3.5" />{t("splitAtNearestMarker")}</span>
                <DropdownMenuShortcut>⌘⇧B</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator className={TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS} />
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleDuplicateSelectedClips} disabled={!hasEditableClipSelection || !canCreateTimelineClip} title={!hasEditableClipSelection || !canCreateTimelineClip ? duplicateDisabledReason : undefined}>
                <span className="flex items-center gap-2"><Copy className="h-3.5 w-3.5" />{t("duplicateSelected")}</span>
                <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleCopySelectedClips} disabled={!hasCopyTargetClipSelection} title={!hasCopyTargetClipSelection ? copyDisabledReason : undefined}>
                <span className="flex items-center gap-2"><ClipboardCopy className="h-3.5 w-3.5" />{t("copySelected")}</span>
                <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleCutSelectedClips} disabled={!hasEditableClipSelection || !canDeleteTimelineClip} title={!hasEditableClipSelection || !canDeleteTimelineClip ? cutDisabledReason : undefined}>
                <span className="flex items-center gap-2"><ClipboardX className="h-3.5 w-3.5 text-red-300" />{t("cutSelected")}</span>
                <DropdownMenuShortcut>⌘X</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handlePasteClipboardClips} disabled={!canPasteClipboard || !canCreateTimelineClip} title={!canPasteClipboard || !canCreateTimelineClip ? pasteDisabledReason : undefined}>
                <span className="flex items-center gap-2"><ClipboardPaste className="h-3.5 w-3.5" />{t("pasteClips")}</span>
                <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator className={TIMELINE_TOOLBAR_MENU_SEPARATOR_CLASS} />
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleRippleDeleteSelectedClips} disabled={!hasEditableClipSelection || !canDeleteTimelineClip || !canUpdateTimelineClip} title={!hasEditableClipSelection || !canDeleteTimelineClip || !canUpdateTimelineClip ? deleteEditDisabledReason : undefined}>
                <span className="flex items-center gap-2"><ListCollapse className="h-3.5 w-3.5 text-red-300" />{t("rippleDeleteSelected")}</span>
                <DropdownMenuShortcut>⇧Del</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem className={TIMELINE_TOOLBAR_MENU_ITEM_CLASS} onClick={handleCloseGaps}>
                <span className="flex items-center gap-2"><AlignHorizontalJustifyStart className="h-3.5 w-3.5" />{t("closeGaps")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

        </div>

        {/* Right: info + zoom */}
        <div className={TIMELINE_TOOLBAR_RIGHT_RAIL_CLASS}>
          <span className="text-[9px] text-[#555] tabular-nums">{t("sceneCount", { n: scenes.length })}</span>
          <div className="flex items-center gap-0.5">
            <TipBtn tip={t("zoomOut")} shortcut="-" onClick={handleZoomOut} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
              <ZoomOut className={TIMELINE_TOOLBAR_ICON_CLASS} />
            </TipBtn>
            <TipBtn tip={t("fitToView")} shortcut="⇧Z" onClick={handleZoomFit} className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} w-auto px-2 text-[10px]`}>
              {t("fit")}
            </TipBtn>
            <TipBtn tip={t("fitSelectionToView")} shortcut="⌥⇧Z" onClick={handleZoomFitSelection} disabled={!hasEditableClipSelection} disabledReason={selectionOnlyDisabledReason} className={`${TIMELINE_TOOLBAR_BUTTON_CLASS} w-auto px-2 text-[10px]`}>
              {t("fitSelection")}
            </TipBtn>
            <TipBtn tip={t("centerPlayhead")} shortcut="⌥Z" onClick={handleCenterPlayhead} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
              <Crosshair className={TIMELINE_TOOLBAR_ICON_CLASS} />
            </TipBtn>
            <TipBtn tip={t("zoomIn")} shortcut="+" onClick={handleZoomIn} className={TIMELINE_TOOLBAR_BUTTON_CLASS}>
              <ZoomIn className={TIMELINE_TOOLBAR_ICON_CLASS} />
            </TipBtn>
          </div>
        </div>
      </div>
      </TooltipProvider>

      {/* Tracks area — single scroll container so labels + content scroll together */}
      <div
        ref={scrollContainerRef}
        data-testid="timeline-tracks-scroll"
        className="flex-1 min-h-0 overflow-auto scrollbar-thin"
        onMouseDown={handleTimelineDeadZoneMouseDown}
      >
        <div className="relative flex" style={{ minWidth: `${trackContentWidth + 112}px` }}>
          {/* Sticky track labels column */}
          <div className="w-28 shrink-0 sticky left-0 z-30 bg-[#0A0A0B] border-r border-[rgba(255,255,255,0.06)]">
            {/* Ruler spacer */}
            <div className="h-5 border-b border-[rgba(255,255,255,0.06)]" />

            {/* Track labels matching canvas layout order */}
            {sortedTracks.map((track, index) => {
              const key = `${track.type}-${track.index}`;
              return (
                <Fragment key={key}>
                  {index === firstVideoTrackLabelIndex && effectDropPreviewLabelNode}
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("application/x-track-key", key);
                      setDragTrackKey(key);
                    }}
                    onDragEnd={() => { setDragTrackKey(null); setDropTargetTrackKey(null); }}
                    onDragOver={(e) => {
                      if (!dragTrackKey || dragTrackKey === key) return;
                      // Only same-type lanes are swappable; V1/A1 stay pinned.
                      const sameType = dragTrackKey.slice(0, dragTrackKey.lastIndexOf("-")) === key.slice(0, key.lastIndexOf("-"));
                      const pinned = key === "video-1" || key === "audio-1" || dragTrackKey === "video-1" || dragTrackKey === "audio-1";
                      if (!sameType || pinned) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dropTargetTrackKey !== key) setDropTargetTrackKey(key);
                    }}
                    onDragLeave={() => { if (dropTargetTrackKey === key) setDropTargetTrackKey(null); }}
                    onDrop={(e) => {
                      const source = e.dataTransfer.getData("application/x-track-key") || dragTrackKey;
                      if (!source) return;
                      e.preventDefault();
                      e.stopPropagation();
                      handleTrackRailDrop(source, key);
                    }}
                    className={dropTargetTrackKey === key ? "bg-white/10 outline outline-1 -outline-offset-1 outline-white/40" : dragTrackKey === key ? "opacity-60" : undefined}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setTrackCtxInsertOpen(false);
                      setTrackCtxMenu({ key, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <TrackLabel
                      track={track}
                      onToggleMute={() => handleToggleTrack(key, "muted")}
                      onToggleLock={() => handleToggleTrack(key, "locked")}
                      onToggleVisible={() => handleToggleTrack(key, "visible")}
                      onSetVolume={(volume) => handleSetTrackVolume(key, volume)}
                    />
                  </div>
                </Fragment>
              );
            })}
            {sortedTracks.length > 0 && firstVideoTrackLabelIndex < 0 && effectDropPreviewLabelNode}

            {/* Fallback labels when no track data yet. Effect rows are created
                only as real tracks or temporary drag/drop previews. */}
            {sortedTracks.length === 0 && (
              <>
                {effectDropPreviewLabelNode}
                <div
                  className="flex items-center justify-center border-b border-[rgba(255,255,255,0.04)]"
                  style={{ height: getTimelineTrackHeight("video") }}
                >
                  <div className="flex items-center gap-1">
                    <Film className="h-3 w-3 text-blue-400/70" />
                    <span className="text-[9px] text-[#6B6B73] font-semibold">V1</span>
                  </div>
                </div>
                <div
                  className="flex items-center justify-center border-b border-[rgba(255,255,255,0.04)]"
                  style={{ height: getTimelineTrackHeight("audio") }}
                >
                  <div className="flex items-center gap-1">
                    <Music className="h-3 w-3 text-emerald-400/70" />
                    <span className="text-[9px] text-[#6B6B73] font-semibold">A1</span>
                  </div>
                </div>
              </>
            )}

            {/* Add track button */}
            <AddTrackButton onAddTrack={handleAddTrack} onSelectMusic={handleSelectMusic} />
          </div>

          {/* Track content area — replaced by single canvas */}
          <div className="relative shrink-0" style={{ width: `${trackContentWidth}px` }}>
            <CanvasTimeline
              shortcutsEnabled={shortcutsEnabled}
              scenes={scenesForCanvas}
              tracks={sortedTracks.length > 0 ? sortedTracks : defaultTracks}
              clips={clipsWithEmbeddedAudio}
              markers={timelineMarkers}
              selectedSceneId={selectedSceneId}
              zoom={timelineZoom}
              totalDuration={totalDuration}
              musicUrl={musicUrl}
              musicVolume={musicVolume}
              selectedAudioTarget={selectedAudioTarget}
              onSelectClip={selectClip}
              onSelectScene={onSelectScene}
              onUpdateClips={handleUpdateClips}
              onSetSceneTransition={onSetSceneTransition}
              onEffectDropPreviewChange={handleEffectDropPreviewChange}
              onSeek={handleSeek}
              onSelectMusic={handleSelectMusic}
              onSelectVoiceover={handleSelectVoiceover}
              onReorderScenes={handleReorderScenes}
              onMoveSceneTime={handleMoveSceneTime}
              onMoveSceneTimes={handleMoveSceneTimes}
              onReorderShots={timelineController.capabilities.reorderShots ? handleReorderShots : undefined}
              onExtractShot={timelineController.capabilities.extractShot ? handleExtractShot : undefined}
              onMergeShot={timelineController.capabilities.mergeShot ? handleMergeShot : undefined}
              onDeleteShot={timelineController.capabilities.deleteShot ? handleDeleteShot : undefined}
              onUpdateSceneDuration={handleUpdateSceneDuration}
              onDeleteClips={handleDeleteClips}
              onTrackDrop={handleTrackDrop}
              onDeleteScene={handleDeleteScene}
              onRippleDeleteScene={handleRippleDeleteScene}
              onAddScene={handleAddScene}
              onDuplicateScene={handleDuplicateScene}
              onRemoveVoiceover={handleRemoveVoiceover}
              onSplitClip={handleSplitClipAtTime}
              onSplitClips={handleSplitClipIdsAtTime}
              onSplitClipsAtTime={handleSplitClipsAtTime}
              onConvertSceneToSourceVideo={(sceneId) => { void handleRequestConvertSceneToSourceVideo(sceneId, t("blade")); }}
              onCreateClip={onCreateClip}
              onCreateClips={onCreateClips}
              onSaveToSources={onSaveToSources}
              onDoubleClickScene={(sceneId, shotIndex) => {
                storeApi.getState().selectScene(sceneId);
                callbacks.onOpenSceneDetails?.({ sceneId, shotIndex });
              }}
            />
          </div>
        </div>
      </div>

      {/* Track right-click context menu */}
      {trackCtxMenu && (() => {
        const trackContextTrack = sortedTracks.find((track) => `${track.type}-${track.index}` === trackCtxMenu.key);
        const trackContextBaseTracks = timelineTracks
          ? withRequiredBaseTimelineTracks(timelineTracks).tracks
          : null;
        const trackContextDeleteUpdates = trackContextBaseTracks
          ? getTimelineDeleteTrackUpdates(trackContextBaseTracks, trackCtxMenu.key)
          : null;
        const canDeleteContextTrack = Boolean(
          trackContextBaseTracks && trackContextDeleteUpdates !== trackContextBaseTracks,
        );
        if (!trackContextTrack) return null;
        const isAudioTrack = trackContextTrack.type === "audio";
        const trackContextMenuHeight = (canDeleteContextTrack ? 96 : 64) + (trackCtxInsertOpen ? 168 : 28);
        return (
          <>
            <div
              className="fixed inset-0 z-[999]"
              onClick={() => { setTrackCtxMenu(null); setTrackCtxInsertOpen(false); }}
            />
            <div
              className={TIMELINE_CONTEXT_MENU_CLASS}
              style={getTimelineContextMenuStyle(trackCtxMenu.x, trackCtxMenu.y, 224, trackContextMenuHeight)}
            >
              {/* Insert layer — expands in place so the menu never needs a
                  hover-only flyout that a touch/trackpad user cannot reach. */}
              {(
                <>
                  <button
                    type="button"
                    className={TIMELINE_CONTEXT_MENU_ITEM_CLASS}
                    aria-expanded={trackCtxInsertOpen}
                    onClick={() => setTrackCtxInsertOpen((prev) => !prev)}
                  >
                    <span className="flex items-center gap-2">
                      <Plus className="h-3.5 w-3.5" />
                      {t("insertLayer")}
                    </span>
                    <ChevronRight className={`h-3 w-3 transition-transform ${trackCtxInsertOpen ? "rotate-90" : ""}`} />
                  </button>
                  {trackCtxInsertOpen && TRACK_INSERT_OPTIONS.map((option) => (
                    <button
                      key={option.type}
                      type="button"
                      className={`${TIMELINE_CONTEXT_MENU_ITEM_CLASS} pl-8`}
                      onClick={() => {
                        handleAddTrack(option.type);
                        setTrackCtxInsertOpen(false);
                        setTrackCtxMenu(null);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <option.icon className={`h-3.5 w-3.5 ${option.color}`} />
                        {tAddTrack(option.labelKey)}
                      </span>
                    </button>
                  ))}
                  <div className={TIMELINE_CONTEXT_MENU_SEPARATOR_CLASS} />
                </>
              )}
              <button
                type="button"
                className={TIMELINE_CONTEXT_MENU_ITEM_CLASS}
                onClick={() => {
                  handleToggleTrack(trackCtxMenu.key, isAudioTrack ? "muted" : "visible");
                  setTrackCtxMenu(null);
                }}
              >
                <span className="flex items-center gap-2">
                  {isAudioTrack ? (
                    trackContextTrack.muted ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />
                  ) : (
                    trackContextTrack.visible === false ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />
                  )}
                  {isAudioTrack
                    ? (trackContextTrack.muted ? t("unmute") : t("mute"))
                    : (trackContextTrack.visible === false ? t("showTrack") : t("hideTrack"))}
                </span>
              </button>
              <button
                type="button"
                className={TIMELINE_CONTEXT_MENU_ITEM_CLASS}
                onClick={() => {
                  handleToggleTrack(trackCtxMenu.key, "locked");
                  setTrackCtxMenu(null);
                }}
              >
                <span className="flex items-center gap-2">
                  {trackContextTrack.locked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                  {trackContextTrack.locked ? t("unlockTrack") : t("lockTrack")}
                </span>
              </button>
              {canDeleteContextTrack && (
                <>
                  <div className={TIMELINE_CONTEXT_MENU_SEPARATOR_CLASS} />
                  <button
                    type="button"
                    className={`${TIMELINE_CONTEXT_MENU_ITEM_CLASS} ${TIMELINE_CONTEXT_MENU_DANGER_ITEM_CLASS}`}
                    onClick={() => {
                      handleDeleteTrack(trackCtxMenu.key);
                      setTrackCtxMenu(null);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("deleteTrack")}
                    </span>
                  </button>
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}

// Memoized with an explicit comparator so preview-only parent state updates
// cannot redraw the heavy canvas timeline unless timeline data actually changed.
export const NleTimeline = memo(forwardRef(NleTimelineImpl));
