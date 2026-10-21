"use client";

// Preview panel compositor for scene playback and timeline overlays: V2+ media, built-in graphics, text/stickers,
// and the effect layers over all of them (the exports' stacking).
import React, { useContext, useRef, useCallback, useEffect, useMemo, useState } from "react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { ScenePreview, type ScenePreviewHandle } from "./scene-preview";
import { getPreviewScreenFrame } from "./preview-screen-frame";
import { useEditorStore, useEditorStoreApi } from "../hooks/use-editor-store";
import { useDocumentVisible } from "../hooks/use-document-visible";
import { useTimelineConfig, useTimelineMedia } from "../hooks/use-timeline-media";
import { usePreviewDataProps } from "./adapters";
import { parsePreviewTextStyle, type PreviewTextStyle } from "@opennan/timeline-core/lib/preview-text-draw";
import { fontFacesForStyle } from "@opennan/timeline-core/text/fonts";
import { stickerBox } from "@opennan/timeline-core/stickers/catalog";
import { sceneTimelineSeconds } from "@opennan/timeline-core/timeline/scene-duration";
import { clipMediaStart } from "@opennan/timeline-core/motion/speed";
import { cachedClipSpeedProfile, mediaTimeAt, syncMediaElement, targetRate } from "./speed-sync";
import { filterPreviewTimelineClips } from "@opennan/timeline-core/lib/preview-timeline-clips";
import {
  applyDragOverride, baseTransform, clipBaseAt, clipMotionAt, overlayRectOf, overrideSettled, placedBox, textLayoutScale,
  type ClipMotionSample, type DragOverride, type FrameRect, type OverlayRect, type PlacedBox,
} from "./motion/clip-motion";
import { TextStateBitmapCache, clipTextStateAt, type CanvasLike } from "./motion/text-state-cache";
import { StickerImageCache, type ImageLike } from "./motion/sticker-image-cache";
import { FontLoader } from "./motion/font-loader";
import { useDragCommit, useSceneTransformCommit, sceneBaseAt, type SceneOverride } from "./motion/drag-commit";
import {
  anchoredCornerScale, boxFromRect, cornerCursor, hitTestHandles, pointerAngle, rotateKnobOffset, snapRotation,
  solveAnchoredPosition, toScreen, unwrapDelta, CORNER_HANDLE_RADIUS, CORNER_SIGNS, ROTATE_KNOB_RADIUS, type Corner, type HandleBox,
} from "./motion/handles";
import {
  boundsOfBox, frameSnapTargets, itemSnapTargets, mergeSnapTargets, snapMove, translateBounds, SNAP_THRESHOLD_PX,
  type SnapBounds, type SnapGuide, type SnapTargets,
} from "./motion/snapping";
import { sceneCanTransform, sceneHandleGeometry, sceneOffsetForCentre, sceneSourceSize, type SceneHandleGeometry } from "./motion/scene-handles";
import { drawMaskChrome, hitTestMask, maskDragPatch, maskScreenGeometry, maskSpecAt, type MaskDragStart, type MaskHandleKind, type MaskScreenGeometry } from "./motion/mask-handles";
import { clipTakesMask, parseMask, type MaskPatch } from "@opennan/timeline-core/looks/masks";
import {
  drawTrackRegionChrome, hitTestTrackRegion, sourceToScreen, trackRegionDrag, trackRegionGeometry,
  type TrackRegionDragStart, type TrackRegionGeometry, type TrackRegionHit,
} from "./motion/track-region";
import type { TrackingOwner, TrackingRegionState, TrackingResultState } from "@opennan/timeline-core";
import { TimelineContext } from "../provider/context";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { getSceneDuration, getSceneStart } from "@opennan/timeline-core/timeline/scene-timing";
import { prepareEffectLayers, sceneEffectPseudoClips, type PreparedEffectLayer, type SceneEffectEntry } from "@opennan/timeline-media/effects/effect-layer-prep";
import { isBuiltinEffect } from "@opennan/timeline-core/looks/effects";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { ClipLookCache, drawClipThroughLook } from "./motion/clip-look";
import { LayerMaskCache, paintMaskedLayer, type LayerRect } from "./motion/layer-mask";
import { clipLanePlan, clipWindowsAt, windowStillFrame, type ClipWindowFrame, type ClipWindowSide, type StillFrame } from "./motion/clip-windows";
import { drawClipWindow, type WindowSideDraw } from "./motion/clip-window-draw";
import { FrameSnapshots } from "@opennan/timeline-media/looks/frame-snapshots";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import { drawSceneFootage } from "./motion/scene-footage";
import { applyPreviewDrop, parsePreviewDrop, previewDropAccepts, previewDropBox, previewDropPosition } from "./motion/preview-drop";
import type { PreviewTextContext } from "@opennan/timeline-core/lib/preview-text-draw";
import { useTimelineController } from "../hooks/use-timeline-controller";
import { useTimelineToast } from "../hooks/use-timeline-toast";
import { spanPlans } from "./lane-look-overlay";
import { useLookRenderer } from "./use-look-renderer";
import { getSceneTimelineStart } from "@opennan/timeline-core/timeline/canvas/scene-position";
import { EffectRenderer } from "@opennan/timeline-media/effects/effect-renderer";
import { useEffectCatalog } from "../hooks/use-effect-catalog";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import type { RemotionTransformOverride } from "../remotion/remotion-layer";
import { measureRemotionContentRect } from "./remotion-content-bounds";
import { remotionLayerPlacement } from "../remotion/remotion-transform";
import { graphicsAssetImage, graphicsAssetSettled, loadGraphicsFonts } from "../remotion/graphics-assets";
import { isBuiltinGraphics } from "@opennan/timeline-core/graphics/render";
import { GraphicsLayerCache, graphicsBoundsFractions, paintGraphicsLayer } from "./motion/graphics-layer";
import { clampGroupFactor, gestureBox, groupScaleFactor, unionBox, type GroupGesture } from "./motion/group-transform";
import { collectGroupItems, groupGestureCommand, type GroupCapture } from "./motion/group-items";
import type { EditorCommand } from "@opennan/timeline-core/controller/commands";
import { Check, ChevronDown, Loader2, Maximize2, Minimize2, Pause, Play, StepBack, StepForward } from "lucide-react";

interface SceneData {
  id: string;
  order: number;
  startTime: string;
  endTime: string;
  caption: string;
  startImageUrl: string | null;
  endImageUrl: string | null;
  videoUrl: string | null;
  sourceVideoUrl?: string | null;
  videoStoryboardUrl?: string | null;
  videoStoryboardRawUrl?: string | null;
  cardConfig?: string | null;
  cardType?: string | null;
  duration?: number | null;
  fitMode?: "contain" | "cover" | "fill" | null;
  transformScale?: number | null;
  transformOffsetX?: number | null;
  transformOffsetY?: number | null;
  status: string;
  timelinePositionSeconds?: number | null;
  /** Scene-attached GL effect stack (clip_effects.scene_id rows). */
  effects?: SceneEffectEntry[] | null;
}

// PreviewPanel takes no props: data and writes come from usePreviewDataProps() (./adapters).

// ── Helpers ──────────────────────────────────────────────

function parseAspectRatio(aspectRatio?: string) {
  const m = aspectRatio?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!m) return 16 / 9;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

function timeToSeconds(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(t) || 0;
}

function parseSceneCardConfig(scene: SceneData): Record<string, unknown> {
  if (!scene.cardConfig) return {};
  try {
    const config = JSON.parse(scene.cardConfig);
    return config && typeof config === "object" && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

function getSceneDurationSeconds(scene: SceneData): number {
  const config = parseSceneCardConfig(scene);
  const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
  const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
  if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
    return sceneTimelineSeconds(scene, trimEnd - trimStart);
  }
  return sceneTimelineSeconds(scene, scene.duration || (timeToSeconds(scene.endTime) - timeToSeconds(scene.startTime)) || 5);
}

function getPreviewDuration(scenes: SceneData[], clips: TimelineClip[]): number {
  const clipsDuration = clips.reduce((max, clip) => Math.max(max, Number(clip.endTime) || 0), 0);
  let scenesDuration = 0;
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index];
    scenesDuration = Math.max(
      scenesDuration,
      getSceneTimelineStart(scene, scenes, index, getSceneDurationSeconds)
        + getSceneDurationSeconds(scene),
    );
  }
  // Overlay/effect clips may extend the edit, but a short effect segment must
  // never shorten the underlying video and clamp playback at the effect's end.
  return Math.max(scenesDuration, clipsDuration);
}

function formatPreviewClock(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalSeconds = Math.floor(safeSeconds);
  const frames = Math.floor((safeSeconds - totalSeconds) * 30);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const wholeSeconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

// Text/sticker overlays must letterbox EXACTLY like ScenePreview places the
// video, or drags land offset from the visible frame and clamp before
// reaching its edges. Delegate to the shared helper ScenePreview uses.
function projectFrameRect(projectRatio: number, hostW: number, hostH: number) {
  const { w, h } = getPreviewScreenFrame({ w: hostW, h: hostH }, projectRatio);
  return {
    x: (hostW - w) / 2,
    y: (hostH - h) / 2,
    w,
    h,
  };
}

/** Frame CSS px per export-reference px (text and sticker px are authored at ≈1080p, as the export draws them). */
function frameScaleOf(projectRatio: number, frameH: number): number {
  const exportRefW = projectRatio > 1 ? 1920 : 1080;
  const exportRefH = exportRefW / projectRatio;
  return frameH > 0 && exportRefH > 0 ? frameH / exportRefH : 1;
}

// Text style parsing and transforms live in timeline-core so the export draws text identically.
type ParsedTextStyle = PreviewTextStyle;
const parseTextStyle: (json: string | null) => ParsedTextStyle = parsePreviewTextStyle;

type HitResult =
  | { type: "overlay"; clipId: string }
  | { type: "resize"; clipId: string; corner: Corner }
  | { type: "rotate"; clipId: string }
  | { type: "scene"; sceneId: string; handle: "body" | "rotate" | Corner }
  /** The group box of a multi-selection (phase 10c): move, corner scale, or rotate every selected item. */
  | { type: "group"; handle: "body" | "rotate" | Corner }
  | null;

/** A group gesture in progress (phase 10c): the items captured at pointer-down and the live command's coalesceKey. */
interface GroupDragState {
  type: "move" | "scale" | "rotate";
  startX: number;
  startY: number;
  /** Pointer at pointer-down (canvas px). */
  start: { x: number; y: number };
  frame: FrameRect;
  startBox: HandleBox;
  center: { x: number; y: number };
  capture: GroupCapture;
  snapTargets?: SnapTargets;
  startBounds: SnapBounds;
  lastAngle: number;
  turned: number;
  gesture: string;
  /** The item a plain click grabbed: selected alone when the pointer is released without a change. */
  clicked: { clipId?: string; sceneId?: string } | null;
  /** The last command written (live, then settled on release). */
  last: EditorCommand | null;
}

/** Knob-offset id of the group chrome. */
const GROUP_CHROME_ID = "\u0000group";

/**
 * One transform gesture (phase 10b). Clips (V2+ video/image, text, stickers, graphics) edit a live drag
 * override and commit once on release; scenes write through the controller on every move with one
 * coalesceKey (ScenePreview draws them from the store) and settle on release: one undo step either way.
 * Clip origins are base values (positions 0..1 of the free space); scene origins are offsets in percent.
 */
interface DragState {
  type: "move" | "resize" | "rotate";
  target: "clip" | "scene";
  /** Clip id or scene id. */
  id: string;
  /** Graphics clip: full-frame layer placement, scaled and rotated about the layer centre. */
  remotion: boolean;
  startX: number;
  startY: number;
  origPosX: number;
  origPosY: number;
  origScale: number;
  origRotation: number;
  corner?: Corner;
  /** Frame rect at pointer-down (canvas px). */
  frame: FrameRect;
  /** Visual box at pointer-down: snapping bounds, the resize anchor, and the rotation pivot. */
  startBox?: HandleBox;
  startBounds?: SnapBounds;
  snapTargets?: SnapTargets;
  /** Clips: the box the position anchors across (visual scale), so pixels map to positions exactly. */
  anchorW?: number;
  anchorH?: number;
  /** Animation dx/dy in px (visual centre minus resting centre), constant during the gesture. */
  animOffsetX: number;
  animOffsetY: number;
  // Graphics resize snapshot: centre and pointer distance at pointer-down (canvas px).
  centerX?: number;
  centerY?: number;
  origDist?: number;
  // Rotation: last pointer angle and the accumulated turn (degrees), unwrapped across ±180°.
  lastAngle?: number;
  turned?: number;
  /** Scene live writes share this coalesceKey (one undo entry). */
  gesture: string;
}

type OverrideState = DragOverride;

type CachedPreviewImage = {
  img: HTMLImageElement;
  onLoad: () => void;
  onError: () => void;
};

/** Emoji stickers: 64 reference px glyphs in a 1.2× square box at clip scale 1 (the export's emoji raster). */
const EMOJI_REFERENCE_PX = 64;
const EMOJI_BOX_RATIO = 1.2;
/** A text corner drag redraws its bitmap at the exact scale once the scale has held still this long. */
const TEXT_DRAG_SETTLE_MS = 150;

function createOffscreenCanvas(width: number, height: number): CanvasLike {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const PREVIEW_ASPECT_RATIOS = ["9:16", "16:9", "1:1", "4:5", "4:3"] as const;

/** Transform limits of a gesture (the inspector's scale range). */
const MIN_TRANSFORM_SCALE = 0.1;
const MAX_TRANSFORM_SCALE = 5;
/** Scene offsets stay within ±200 % of the frame. */
const MAX_SCENE_OFFSET = 200;
/** Scene live writes wait for the release (which re-sends with SETTLE): never earlier. */
const SCENE_LIVE_DEBOUNCE_MS = 10 * 60 * 1000;
const SCENE_SETTLE_DEBOUNCE_MS = 1;
/** Hover cursors of the mask handles (phase 10c). */
const MASK_CURSORS: Record<MaskHandleKind, string> = { move: "move", width: "ew-resize", height: "ns-resize", corner: "nwse-resize", rotate: "grab", feather: "ns-resize" };
/** Arrow-key nudges within this window coalesce into one undo step. */
const NUDGE_DEBOUNCE_MS = 500;

/** Selection chrome colours, read from the theme tokens (10a: the selection ring and snap line are white). */
interface ChromeColors {
  ring: string;
  snap: string;
  handleFill: string;
  handleStroke: string;
}

const DEFAULT_CHROME_COLORS: ChromeColors = {
  ring: "rgba(255, 255, 255, 0.9)",
  snap: "rgba(255, 255, 255, 0.75)",
  handleFill: "#ffffff",
  handleStroke: "#111113",
};

function readChromeColors(el: Element | null): ChromeColors {
  if (!el || typeof getComputedStyle !== "function") return DEFAULT_CHROME_COLORS;
  try {
    const styles = getComputedStyle(el);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    return {
      ring: token("--timeline-selection-ring", DEFAULT_CHROME_COLORS.ring),
      snap: token("--timeline-snap-line", DEFAULT_CHROME_COLORS.snap),
      handleFill: token("--on-primary", DEFAULT_CHROME_COLORS.handleFill),
      handleStroke: token("--on-primary-foreground", DEFAULT_CHROME_COLORS.handleStroke),
    };
  } catch {
    return DEFAULT_CHROME_COLORS;
  }
}

/** Selection box, corner handles, and (optionally) the rotate knob on its stem, in the box's rotated frame. */
function drawTransformChrome(ctx: CanvasRenderingContext2D, box: HandleBox, colors: ChromeColors, rotate: boolean, knobOffset: number) {
  ctx.save();
  ctx.translate(box.cx, box.cy);
  if (box.rotation) ctx.rotate(box.rotation);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  const x = -box.w / 2;
  const y = -box.h / 2;
  ctx.strokeStyle = colors.ring;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, box.w, box.h);
  const handle = (hx: number, hy: number, radius: number) => {
    ctx.beginPath();
    ctx.arc(hx, hy, radius, 0, Math.PI * 2);
    ctx.fillStyle = colors.handleFill;
    ctx.fill();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = colors.handleStroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  if (rotate) {
    const ky = y - knobOffset;
    // Stem from the top edge to the knob (inside the box when the knob is tucked in).
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(0, knobOffset >= 0 ? ky + ROTATE_KNOB_RADIUS : ky - ROTATE_KNOB_RADIUS);
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    handle(0, ky, ROTATE_KNOB_RADIUS);
    // A small circular arrow glyph in the knob.
    ctx.beginPath();
    ctx.arc(0, ky, ROTATE_KNOB_RADIUS * 0.45, -Math.PI * 0.35, Math.PI * 1.25);
    ctx.strokeStyle = colors.handleStroke;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }
  for (const [sx, sy] of CORNER_SIGNS) handle((sx * box.w) / 2, (sy * box.h) / 2, CORNER_HANDLE_RADIUS);
  ctx.restore();
}

/** Snap guides: lines across the frame. */
function drawSnapGuides(ctx: CanvasRenderingContext2D, guides: SnapGuide[], frame: FrameRect, color: string) {
  if (guides.length === 0) return;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (const guide of guides) {
    ctx.beginPath();
    if (guide.axis === "x") {
      const gx = Math.round(guide.pos) + 0.5;
      ctx.moveTo(gx, frame.y);
      ctx.lineTo(gx, frame.y + frame.h);
    } else {
      const gy = Math.round(guide.pos) + 0.5;
      ctx.moveTo(frame.x, gy);
      ctx.lineTo(frame.x + frame.w, gy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** A thin ring around one member of a group selection (phase 10c). */
function drawMemberRing(ctx: CanvasRenderingContext2D, box: HandleBox, color: string) {
  ctx.save();
  ctx.translate(box.cx, box.cy);
  if (box.rotation) ctx.rotate(box.rotation);
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(-box.w / 2, -box.h / 2, box.w, box.h);
  ctx.restore();
}

const clampNumber = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Proportional glyph so each ratio is recognizable before reading its label. */
function RatioGlyph({ ratio, active }: { ratio: string; active: boolean }) {
  const [w, h] = ratio.split(":").map((part) => Number(part) || 1);
  const box = 16;
  const scale = box / Math.max(w, h);
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
      <span
        className={`block rounded-[2px] border transition-colors ${active ? "border-white/60 bg-white/25" : "border-[#7B7B85] bg-white/[0.06]"}`}
        style={{ width: `${Math.round(w * scale)}px`, height: `${Math.round(h * scale)}px` }}
      />
    </span>
  );
}

/** Ratio picker: custom popover instead of a native select so the menu matches editor chrome. */
function PreviewRatioMenu({
  aspectRatio,
  onAspectRatioChange,
}: {
  aspectRatio?: string;
  onAspectRatioChange?: (aspectRatio: string) => Promise<void> | void;
}) {
  const t = useTimelineMessages("previewPanel");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = aspectRatio || "16:9";
  const disabled = !onAspectRatioChange;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={t("previewRatio")}
        title={t("previewRatio")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-semibold uppercase tracking-wide outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--on-ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? "border-white/40 bg-white/10 text-white"
            : "border-[rgba(255,255,255,0.09)] bg-[rgba(255,255,255,0.035)] text-[#C6C6CE] hover:bg-white/[0.08] hover:text-white"
        }`}
      >
        <RatioGlyph ratio={current} active={open} />
        <span className="tabular-nums">{current}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180 text-white" : "text-[#6E6E78]"}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("previewRatioOptions")}
          className="absolute bottom-[calc(100%+6px)] right-0 z-50 min-w-[132px] overflow-hidden rounded-lg border border-[rgba(255,255,255,0.09)] bg-[#131317] p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.9)]"
        >
          {PREVIEW_ASPECT_RATIOS.map((ratio) => {
            const selected = ratio === current;
            return (
              <button
                key={ratio}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setOpen(false);
                  if (!selected) void onAspectRatioChange?.(ratio);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-medium transition-colors ${
                  selected ? "bg-white/12 text-white" : "text-[#C6C6CE] hover:bg-white/[0.07] hover:text-white"
                }`}
              >
                <RatioGlyph ratio={ratio} active={selected} />
                <span className="flex-1 tabular-nums">{ratio}</span>
                <Check className={`h-3 w-3 ${selected ? "opacity-100" : "opacity-0"}`} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PreviewStateBadge({ isBackendSyncing }: { isBackendSyncing?: boolean }) {
  const sceneT = useTimelineMessages("scenePreview");
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const previewState = isBackendSyncing
    ? { label: sceneT("syncingEdit"), icon: "spinner" as const, tone: "syncing" as const }
    : isPlaying
      ? { label: sceneT("playing"), icon: "play" as const, tone: "live" as const }
      : { label: sceneT("paused"), icon: "pause" as const, tone: "idle" as const };

  return (
    <div
      data-preview-state-badge
      className={[
        "pointer-events-none absolute left-3 top-3 z-[6] flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium backdrop-blur-sm",
        previewState.tone === "syncing"
          ? "border-white/25 bg-white/70 text-white"
          : previewState.tone === "live"
            ? "border-emerald-400/25 bg-emerald-950/65 text-emerald-100"
            : "border-white/10 bg-black/35 text-white/70",
      ].join(" ")}
      aria-live="polite"
    >
      {previewState.icon === "spinner" && <Loader2 className="h-3 w-3 animate-spin" />}
      {previewState.icon === "play" && <Play className="h-3 w-3" />}
      {previewState.icon === "pause" && <Pause className="h-3 w-3" />}
      <span>{previewState.label}</span>
    </div>
  );
}

function PreviewPlaybackClock({ totalDuration }: { totalDuration: number }) {
  const storeApi = useEditorStoreApi();
  const currentTimeRef = useRef<HTMLSpanElement | null>(null);
  const totalDurationText = useMemo(() => formatPreviewClock(totalDuration), [totalDuration]);

  useEffect(() => {
    const syncClock = (time: number) => {
      if (!currentTimeRef.current) return;
      currentTimeRef.current.textContent = formatPreviewClock(time);
    };

    syncClock(storeApi.getState().currentTime);
    return storeApi.subscribe((state) => state.currentTime, syncClock);
  }, []);

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.035)] px-2 py-1 font-mono text-[11px] tabular-nums leading-none">
      <span ref={currentTimeRef} className="font-semibold text-[var(--on-foreground)]">
        {formatPreviewClock(storeApi.getState().currentTime)}
      </span>
      <span className="text-[#4A4A52]">/</span>
      <span className="text-[var(--on-muted-foreground)]">{totalDurationText}</span>
    </div>
  );
}

function PreviewPlaybackControls({
  totalDuration,
  aspectRatio,
  onAspectRatioChange,
  fullscreenTargetRef,
}: {
  totalDuration: number;
  aspectRatio?: string;
  onAspectRatioChange?: (aspectRatio: string) => Promise<void> | void;
  fullscreenTargetRef: React.RefObject<HTMLDivElement | null>;
}) {
  const timelineT = useTimelineMessages("timeline");
  const previewT = useTimelineMessages("previewPanel");
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setFrameStepRequest = useEditorStore((s) => s.setFrameStepRequest);
  const setPlayRequest = useEditorStore((s) => s.setPlayRequest);
  const setShuttleSpeed = useEditorStore((s) => s.setShuttleSpeed);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pendingPlayRequestFrameRef = useRef<number | null>(null);
  const pendingPlayRequestTimeoutRef = useRef<number | null>(null);

  const togglePlayback = useCallback(() => {
    setShuttleSpeed(0);
    if (pendingPlayRequestFrameRef.current !== null) {
      cancelAnimationFrame(pendingPlayRequestFrameRef.current);
      pendingPlayRequestFrameRef.current = null;
    }
    if (pendingPlayRequestTimeoutRef.current !== null) {
      window.clearTimeout(pendingPlayRequestTimeoutRef.current);
      pendingPlayRequestTimeoutRef.current = null;
    }
    if (isPlaying) {
      setPlayRequest("pause");
      return;
    }
    pendingPlayRequestFrameRef.current = requestAnimationFrame(() => {
      pendingPlayRequestFrameRef.current = null;
      pendingPlayRequestTimeoutRef.current = window.setTimeout(() => {
        pendingPlayRequestTimeoutRef.current = null;
        setPlayRequest("play");
      }, 0);
    });
  }, [isPlaying, setPlayRequest, setShuttleSpeed]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === fullscreenTargetRef.current);
    };
    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, [fullscreenTargetRef]);

  useEffect(() => () => {
    if (pendingPlayRequestFrameRef.current !== null) {
      cancelAnimationFrame(pendingPlayRequestFrameRef.current);
      pendingPlayRequestFrameRef.current = null;
    }
    if (pendingPlayRequestTimeoutRef.current !== null) {
      window.clearTimeout(pendingPlayRequestTimeoutRef.current);
      pendingPlayRequestTimeoutRef.current = null;
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    void fullscreenTargetRef.current?.requestFullscreen?.();
  }, [fullscreenTargetRef]);

  const buttonClass = "flex h-8 w-8 items-center justify-center rounded-lg text-[#A9A9B2] transition-colors hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--on-ring)] active:scale-[0.94]";

  return (
    <div
      data-preview-playback-controls
      className="relative flex h-11 shrink-0 items-center gap-2 border-t border-[rgba(255,255,255,0.07)] bg-gradient-to-b from-[#101013] to-[#08080A] px-3"
    >
      <div className="flex min-w-[150px] items-center gap-2">
        <PreviewPlaybackClock totalDuration={totalDuration} />
      </div>

      <div className="mx-auto flex items-center gap-1.5">
        <button type="button" title={timelineT("previousFrame")} aria-label={timelineT("previousFrame")} onClick={() => setFrameStepRequest(-1)} className={buttonClass}>
          <StepBack className="h-4 w-4" />
        </button>
        <button
          type="button"
          title={isPlaying ? timelineT("pause") : timelineT("play")}
          aria-label={isPlaying ? timelineT("pause") : timelineT("play")}
          onClick={togglePlayback}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--on-ring)] active:scale-[0.94] ${
            isPlaying
              ? "bg-[var(--on-fill-strong)] text-[var(--on-foreground-strong)] ring-1 ring-inset ring-[var(--on-border-hover)] hover:bg-[var(--on-accent)]"
              : "bg-[var(--on-primary)] text-[var(--on-primary-foreground)] shadow-[var(--on-shadow-glow)] hover:bg-[var(--on-primary-hover)]"
          }`}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-[1px] h-4 w-4 fill-current" />}
        </button>
        <button type="button" title={timelineT("nextFrame")} aria-label={timelineT("nextFrame")} onClick={() => setFrameStepRequest(1)} className={buttonClass}>
          <StepForward className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-w-[150px] items-center justify-end gap-1.5">
        <PreviewRatioMenu aspectRatio={aspectRatio} onAspectRatioChange={onAspectRatioChange} />
        <div className="mx-0.5 h-4 w-px bg-[rgba(255,255,255,0.08)]" aria-hidden="true" />
        <button
          type="button"
          title={previewT(isFullscreen ? "exitFullscreen" : "fullscreen")}
          aria-label={previewT(isFullscreen ? "exitFullscreen" : "fullscreen")}
          onClick={toggleFullscreen}
          className={buttonClass}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────

interface EditingState {
  clipId: string;
  mode: "text" | "sticker";
  text: string;
  originalText: string;
  rect: { x: number; y: number; w: number; h: number };
  // text-mode only
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  textAlign?: "left" | "center" | "right";
  bgColor?: string;
}

function PreviewPanelImpl() {
  const { scenes, selectedScene, musicUrl, aspectRatio, onSceneChange, timelineClips, timelineTracks, isBackendSyncing, onAspectRatioChange, onUpdateClip, onUpdateSceneTransform } = usePreviewDataProps();
  const storeApi = useEditorStoreApi();
  const media = useTimelineMedia();
  const { debugHooks } = useTimelineConfig();
  const t = useTimelineMessages("previewPanel");
  const docVisible = useDocumentVisible();
  const docVisibleRef = useRef(docVisible);
  const scenePreviewRef = useRef<ScenePreviewHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Stable accessor for the effect overlay (avoids restarting its GL loop).
  const editInputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef<EditingState | null>(null);
  editingRef.current = editing;

  // Stable refs for RAF loop (avoid re-creating RAF on every render)
  const mediaRectRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  // VISUAL boxes (with motion: animation offsets, scale, flips) for hit tests, selection, and handles.
  const overlayRectsRef = useRef<Map<string, OverlayRect>>(new Map());
  // BASE boxes (keyframed/static position, scale, rotation plus the live drag, no animation): where each
  // item rests, for snapping and transform handles built on top of the drag model.
  const baseRectsRef = useRef<Map<string, OverlayRect>>(new Map());
  // Bumped when an asset arrives (image, sticker, font) so the frame-skip key changes and the frame redraws.
  const assetVersionRef = useRef(0);
  const textBitmapsRef = useRef<TextStateBitmapCache | null>(null);
  // The text corner drag's last scale and when it last changed (the bitmap is redrawn once it holds still).
  const textDragSettleRef = useRef<{ clipId: string; scale: number; since: number } | null>(null);
  textBitmapsRef.current ??= new TextStateBitmapCache(createOffscreenCanvas);
  const stickerImagesRef = useRef<StickerImageCache | null>(null);
  stickerImagesRef.current ??= new StickerImageCache({
    createImage: () => new Image() as unknown as ImageLike,
    onLoad: () => {
      assetVersionRef.current += 1;
      if (docVisibleRef.current) requestCompositorDrawRef.current();
    },
  });
  const fontLoaderRef = useRef<FontLoader | null>(null);
  fontLoaderRef.current ??= new FontLoader(typeof document !== "undefined" && document.fonts ? document.fonts : null, () => {
    // Bitmaps drawn with the fallback font are stale now.
    textBitmapsRef.current?.clear();
    assetVersionRef.current += 1;
    requestCompositorDrawRef.current();
  });
  const imageCacheRef = useRef<Map<string, CachedPreviewImage>>(new Map());
  const MAX_IMAGE_CACHE = 50;
  const clearCachedImage = useCallback((url: string) => {
    const cached = imageCacheRef.current.get(url);
    if (!cached) return;
    cached.img.onload = null;
    cached.img.onerror = null;
    cached.img.src = "";
    imageCacheRef.current.delete(url);
  }, []);
  const clearImageCache = useCallback(() => {
    for (const url of Array.from(imageCacheRef.current.keys())) clearCachedImage(url);
  }, [clearCachedImage]);
  const cacheImage = useCallback((url: string, cached: CachedPreviewImage) => {
    if (imageCacheRef.current.size >= MAX_IMAGE_CACHE) {
      // Evict oldest entry
      const firstKey = imageCacheRef.current.keys().next().value;
      if (firstKey) clearCachedImage(firstKey);
    }
    imageCacheRef.current.set(url, cached);
  }, [clearCachedImage]);
  // V2+ overlay VIDEO clips — hidden <video> elements the compositor draws
  // frames from, so overlay clips actually render above the V1 scene in
  // preview (export composites them; preview previously dropped them).
  // Their embedded audio plays too (export mixes it — parity), gated by the
  // clip volume and the video track's fader/mute.
  const overlayVideoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const timelineTracksRef = useRef<TimelineTrack[] | undefined>(timelineTracks);
  useEffect(() => { timelineTracksRef.current = timelineTracks; }, [timelineTracks]);
  useEffect(() => {
    if (!debugHooks) return;
    // Debug handle for the detached overlay <video> pool (not in the DOM, so
    // devtools/console can't reach them any other way).
    (window as unknown as Record<string, unknown>).__opennanOverlayVids = overlayVideoElsRef.current;
    (window as unknown as Record<string, unknown>).__opennanPreviewClips = () => clipsRef.current;
    // Export golden snapshots crop to the project frame, in viewport px.
    // Item boxes and the group box in viewport px (phase 10c e2e: preview multi-select).
    (window as unknown as Record<string, unknown>).__opennanPreviewBoxes = () => {
      const host = canvasRef.current?.getBoundingClientRect();
      if (!host) return null;
      const toViewport = (b: HandleBox) => ({ cx: host.left + b.cx, cy: host.top + b.cy, w: b.w, h: b.h, rotation: b.rotation });
      const items: Record<string, ReturnType<typeof toViewport>> = {};
      overlayRectsRef.current.forEach((rect, id) => { items[id] = toViewport(boxFromRect(rect)); });
      for (const entry of sceneBoxesRef.current) items[entry.sceneId] = toViewport(entry.geometry.visual);
      return { items, group: groupBoxRef.current ? toViewport(groupBoxRef.current) : null };
    };
    (window as unknown as Record<string, unknown>).__opennanPreviewFrameRect = () => {
      const host = containerRef.current?.getBoundingClientRect();
      const frame = mediaRectRef.current;
      return host ? { x: host.left + frame.x, y: host.top + frame.y, w: frame.w, h: frame.h } : null;
    };
  }, [debugHooks]);
  const getOverlayVideoEl = useCallback((clipId: string, mediaUrl: string) => {
    let vid = overlayVideoElsRef.current.get(clipId);
    if (vid && vid.dataset.srcKey !== mediaUrl) {
      vid.pause();
      vid.src = "";
      overlayVideoElsRef.current.delete(clipId);
      vid = undefined;
    }
    if (!vid) {
      vid = document.createElement("video");
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = "auto";
      vid.crossOrigin = "anonymous";
      vid.dataset.srcKey = mediaUrl;
      vid.src = media.resolveMediaUrl(mediaUrl);
      // Redraw when frames become available — including after a seek, which
      // drops readyState and would otherwise leave the overlay undrawn until
      // the next unrelated draw trigger.
      const redraw = () => requestCompositorDrawRef.current();
      vid.addEventListener("loadeddata", redraw);
      vid.addEventListener("canplay", redraw);
      vid.addEventListener("seeked", redraw);
      // The media proxy occasionally 503s a range request, which puts the
      // element in a terminal error state — retry a few times so one flaky
      // response doesn't permanently blank the overlay.
      let retries = 0;
      const el = vid;
      el.addEventListener("error", () => {
        if (retries >= 3) return;
        retries += 1;
        const at = el.currentTime;
        setTimeout(() => {
          if (overlayVideoElsRef.current.get(clipId) !== el) return;
          el.load();
          el.currentTime = at;
        }, 800 * retries);
      });
      el.addEventListener("loadeddata", () => { retries = 0; });
      overlayVideoElsRef.current.set(clipId, vid);
    }
    return vid;
  }, [media]);
  useEffect(() => () => {
    for (const vid of overlayVideoElsRef.current.values()) {
      vid.pause();
      vid.src = "";
    }
    overlayVideoElsRef.current.clear();
  }, []);
  const dragRef = useRef<DragState | null>(null);
  // Multi-selection (phase 10c): the selected clip and scene sets, the group box drawn last, and a group gesture.
  const selectedClipIdsRef = useRef<Set<string>>(storeApi.getState().selectedClipIds);
  const selectedSceneIdsRef = useRef<Set<string>>(storeApi.getState().selectedSceneIds);
  const selectionVersionRef = useRef(0);
  const groupBoxRef = useRef<HandleBox | null>(null);
  const groupDragRef = useRef<GroupDragState | null>(null);
  const groupGestureRef = useRef<GroupGesture | null>(null);
  // Snap guides of the gesture in progress (drawn across the frame).
  const guidesRef = useRef<SnapGuide[]>([]);
  // The last scene values a live gesture wrote (re-sent on release to settle the coalesced write).
  const sceneGestureRef = useRef<SceneOverride | null>(null);
  const gestureSeqRef = useRef(0);
  const chromeColorsRef = useRef<ChromeColors>(DEFAULT_CHROME_COLORS);
  // Visible transformable scenes at the playhead (topmost first) with their boxes, and the selected scene
  // whose handles are shown (paused, visible, transformable), recomputed every draw.
  const sceneBoxesRef = useRef<Array<{ sceneId: string; geometry: SceneHandleGeometry }>>([]);
  const sceneChromeIdRef = useRef<string | null>(null);
  // Rotate-knob offset of the chrome drawn last (negative: tucked inside the box), for hit tests.
  const knobOffsetRef = useRef<{ id: string; offset: number } | null>(null);
  const overrideRef = useRef<OverrideState | null>(null);
  const overrideClipIdRef = useRef<string | null>(null);
  const dragFrameRef = useRef(0);
  // Graphics render in the DOM (Remotion player), so their live drag values
  // must reach React — the canvas-only ref override can't move them.
  const [remotionOverride, setRemotionOverride] = useState<RemotionTransformOverride | null>(null);
  const remotionLayerRectsRef = useRef<Map<string, OverlayRect>>(new Map());
  // The part of each graphic's layer that paints (fractions of the layer), measured while the layer is upright.
  const remotionContentFractionsRef = useRef<Map<string, { x0: number; y0: number; x1: number; y1: number }>>(new Map());
  // Built-in graphics drawn on this canvas while it composites (phase 11): one full-frame layer per clip.
  const graphicsLayersRef = useRef<GraphicsLayerCache | null>(null);
  const graphicsFontsRequestedRef = useRef(false);

  // Frame skip tracking — avoid redrawing when nothing changed
  const lastVideoTimeRef = useRef(-1);
  const lastOverlayKeyRef = useRef("");
  const clipsVersionRef = useRef(0);
  const requestCompositorDrawRef = useRef<() => void>(() => {});

  // Canvas bypass: when no overlays are visible, show video directly (skip expensive drawImage)
  const [needsCanvas, setNeedsCanvas] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const needsCanvasRef = useRef(false);
  // True when the canvas must take pointer events — either it draws the
  // overlays, or a DOM-rendered graphic is on screen and must stay draggable.
  const [capturePointer, setCapturePointer] = useState(false);
  const capturePointerRef = useRef(false);
  useEffect(() => { docVisibleRef.current = docVisible; }, [docVisible]);
  useEffect(() => {
    const clearAll = () => {
      clearImageCache();
      textBitmapsRef.current?.clear();
      stickerImagesRef.current?.clear();
    };
    if (!docVisible) clearAll();
    return clearAll;
  }, [clearImageCache, docVisible]);
  const filteredTimelineClips = useMemo(
    () => filterPreviewTimelineClips(timelineClips, timelineTracks),
    [timelineClips, timelineTracks],
  );
  const previewDuration = useMemo(
    () => getPreviewDuration(scenes, filteredTimelineClips),
    [scenes, filteredTimelineClips],
  );

  // Store subscriptions (read via refs to avoid RAF dependency)
  const initialEditorState = storeApi.getState();
  const currentTimeRef = useRef(initialEditorState.currentTime);
  const selectedClipIdRef = useRef<string | null>(initialEditorState.selectedClipId);
  const clipsRef = useRef<TimelineClip[]>([]);
  const selectedSceneRef = useRef(selectedScene);
  selectedSceneRef.current = selectedScene;
  const selectedSceneIdRef = useRef<string | null>(initialEditorState.selectedSceneId);
  const isPlayingRef = useRef(initialEditorState.isPlaying);
  const maskEditingRef = useRef(initialEditorState.maskEditing);
  // A mask handle drag in progress (phase 10c): live mask.set writes coalesced into one undo step.
  const maskDragRef = useRef<{ owner: { clipId: string } | { sceneId: string }; gesture: string; last: MaskPatch | null } | null>(null);
  // Ends the mask drag in progress (removes its window listeners and settles its live write); unmount calls it.
  const maskDragEndRef = useRef<(() => void) | null>(null);
  useEffect(() => () => maskDragEndRef.current?.(), []);
  // Motion tracking (phase 10d): the Track tab's region box and the last track's path, drawn over the tracked item.
  const trackingRegionRef = useRef<TrackingRegionState | null>(initialEditorState.trackingRegion);
  const trackingResultRef = useRef<TrackingResultState | null>(initialEditorState.trackingResult);
  const trackingVersionRef = useRef(0);
  // Ends the region drag in progress; unmount calls it.
  const trackDragEndRef = useRef<(() => void) | null>(null);
  useEffect(() => () => trackDragEndRef.current?.(), []);
  // Scene timeline ranges (the controller's timing: scene-timing.ts), for scene handles at the playhead.
  const sceneRanges = useMemo(
    () => scenes.map((scene, index) => ({ scene, start: getSceneStart(scene, scenes, index), duration: getSceneDuration(scene) })),
    [scenes],
  );
  const sceneRangesRef = useRef(sceneRanges);
  const scenesVersionRef = useRef(0);
  useEffect(() => {
    sceneRangesRef.current = sceneRanges;
    scenesVersionRef.current += 1;
    requestCompositorDrawRef.current();
  }, [sceneRanges]);

  // Keep refs in sync — also clear drag override when data arrives
  useEffect(() => {
    clipsRef.current = filteredTimelineClips;
    clipsVersionRef.current += 1;
    // Override no longer needed once dragged clip data catches up.
    if (overrideClipIdRef.current && !dragRef.current) {
      const overrideClip = filteredTimelineClips.find((clip) => clip.id === overrideClipIdRef.current);
      if (!overrideClip || overrideSettled(overrideClip, overrideRef.current, currentTimeRef.current - overrideClip.startTime)) {
        overrideClipIdRef.current = null;
        overrideRef.current = null;
        setRemotionOverride(null);
      }
    }
    requestCompositorDrawRef.current();
  }, [filteredTimelineClips]);
  useEffect(() => {
    const state = storeApi.getState();
    currentTimeRef.current = state.currentTime;
    selectedClipIdRef.current = state.selectedClipId;
    const unsub1 = storeApi.subscribe((s) => s.currentTime, (currentTime) => {
      currentTimeRef.current = currentTime;
      requestCompositorDrawRef.current();
    });
    const unsub2 = storeApi.subscribe((s) => s.selectedClipId, (selectedClipId) => {
      selectedClipIdRef.current = selectedClipId;
      requestCompositorDrawRef.current();
    });
    // Scene handles show only for a scene the user picked, not one synced to the playhead by a seek.
    selectedSceneIdRef.current = state.sceneSelectedByUser ? state.selectedSceneId : null;
    isPlayingRef.current = state.isPlaying;
    const unsub3 = storeApi.subscribe((s) => (s.sceneSelectedByUser ? s.selectedSceneId : null), (selectedSceneId) => {
      selectedSceneIdRef.current = selectedSceneId;
      requestCompositorDrawRef.current();
    });
    const unsub4 = storeApi.subscribe((s) => s.isPlaying, (isPlaying) => {
      isPlayingRef.current = isPlaying;
      requestCompositorDrawRef.current();
    });
    const unsub6 = storeApi.subscribe((s) => [s.selectedClipIds, s.selectedSceneIds] as const, ([clipIds, sceneIds]) => {
      selectedClipIdsRef.current = clipIds;
      selectedSceneIdsRef.current = sceneIds;
      selectionVersionRef.current += 1;
      requestCompositorDrawRef.current();
    }, { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] });
    // Mask handles (phase 10c) while the inspector's Mask tab is open.
    maskEditingRef.current = state.maskEditing;
    const unsub5 = storeApi.subscribe((s) => s.maskEditing, (maskEditing) => {
      maskEditingRef.current = maskEditing;
      requestCompositorDrawRef.current();
    });
    trackingRegionRef.current = state.trackingRegion;
    trackingResultRef.current = state.trackingResult;
    const unsub7 = storeApi.subscribe((s) => [s.trackingRegion, s.trackingResult] as const, ([region, result]) => {
      trackingRegionRef.current = region;
      trackingResultRef.current = result;
      trackingVersionRef.current += 1;
      requestCompositorDrawRef.current();
    }, { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] });
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); unsub7(); };
  }, []);

  const setSelectedClipIds = useEditorStore((s) => s.setSelectedClipIds);

  // ── Library drops onto the preview (stickers, text templates) ──
  // The item lands at the playhead with its centre on the drop point (motion/preview-drop.ts); the frame
  // shows a subtle highlight while a card the preview takes is over it.
  const controller = useTimelineController();
  const toast = useTimelineToast();
  const tTimeline = useTimelineMessages("timeline");
  const [dropFrame, setDropFrame] = useState<FrameRect | null>(null);
  const dropMeasureRef = useRef<PreviewTextContext | null | undefined>(undefined);
  const hostFrame = useCallback((): { frame: FrameRect; left: number; top: number; ratio: number } | null => {
    const host = containerRef.current?.getBoundingClientRect();
    if (!host || host.width <= 0 || host.height <= 0) return null;
    const ratio = parseAspectRatio(aspectRatio);
    return { frame: projectFrameRect(ratio, host.width, host.height), left: host.left, top: host.top, ratio };
  }, [aspectRatio]);
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!previewDropAccepts(Array.from(e.dataTransfer?.types ?? []))) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const frame = hostFrame()?.frame ?? null;
    setDropFrame((prev) => (prev && frame && prev.x === frame.x && prev.y === frame.y && prev.w === frame.w && prev.h === frame.h ? prev : frame));
  }, [hostFrame]);
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropFrame(null);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    setDropFrame(null);
    const payload = parsePreviewDrop(e.dataTransfer?.getData("application/json"));
    if (!payload) return;
    e.preventDefault();
    const host = hostFrame();
    if (!host) return;
    if (dropMeasureRef.current === undefined) {
      // One measuring context for text boxes (null where canvas 2D is unavailable).
      try {
        dropMeasureRef.current = (document.createElement("canvas").getContext("2d") as PreviewTextContext | null) ?? null;
      } catch {
        dropMeasureRef.current = null;
      }
    }
    const box = previewDropBox(payload, host.frame, frameScaleOf(host.ratio, host.frame.h), dropMeasureRef.current ?? null);
    const position = previewDropPosition(host.frame, box, { x: e.clientX - host.left, y: e.clientY - host.top });
    void applyPreviewDrop(controller, storeApi, payload, storeApi.getState().currentTime, position).then((ok) => {
      if (!ok) toast.error(tTimeline("clipCreateFailed"));
    });
  }, [controller, hostFrame, storeApi, tTimeline, toast]);

  // ── Effect layers over the FULL composite ──
  // Export bakes GLSL effect layers onto the final composited frame (footage
  // + overlays + text). When the compositor canvas is active, we mirror that:
  // build an offscreen composite (footage from the DOM video's on-screen rect
  // + this canvas's overlay content), run the effect stack over it, and stamp
  // the result back — suppressing ScenePreview's footage-only effect pass.
  // Built-in effects on scenes are part of each scene's look (the main-track look overlay); legacy
  // catalog (GLSL) effects on scenes stay pseudo effect clips over the scene, as the export's GL layers.
  // Effect-track clips composite here: built-in effects through the looks renderer, catalog effects
  // through the legacy EffectRenderer.
  const legacySceneEffectClips = useMemo(
    () => sceneEffectPseudoClips(scenes, (scene) => {
      const index = scenes.findIndex((s) => s.id === scene.id);
      const start = index < 0 ? 0 : getSceneTimelineStart(scene, scenes, index, getSceneDurationSeconds);
      return { start, end: start + getSceneDurationSeconds(scene) };
    }, (effectId) => !isBuiltinEffect(effectId)),
    [scenes],
  );
  const builtinSpanClips = useMemo(
    () => filteredTimelineClips.filter((c) => c.trackType === "effect" && c.effects?.some((e) => e.enabled && isBuiltinEffect(e.effectId))),
    [filteredTimelineClips],
  );
  const builtinSpanClipsRef = useRef(builtinSpanClips);
  builtinSpanClipsRef.current = builtinSpanClips;
  const effectSourceClips = useMemo(
    () => [
      ...filteredTimelineClips.map((c) => (c.trackType === "effect" && c.effects?.some((e) => isBuiltinEffect(e.effectId))
        ? { ...c, effects: c.effects.filter((e) => !isBuiltinEffect(e.effectId)) }
        : c)),
      ...legacySceneEffectClips,
    ],
    [filteredTimelineClips, legacySceneEffectClips],
  );
  const hasEnabledEffectClips = useMemo(
    () => effectSourceClips.some((c) => c.trackType === "effect" && c.effects?.some((e) => e.enabled)),
    [effectSourceClips],
  );
  const lookRenderer = useLookRenderer(true);
  const lookRendererRef = useRef<LookRenderer | null>(null);
  lookRendererRef.current = lookRenderer;
  // Per-clip looks (static, or the Adjust-keyframe CLUT cross-fade), memoized on the fields they read.
  const clipLooksRef = useRef<ClipLookCache | null>(null);
  clipLooksRef.current ??= new ClipLookCache();
  // Deleted clips leave the look cache (with their keyframe CLUTs).
  useEffect(() => {
    const ids = new Set(filteredTimelineClips.map((clip) => clip.id));
    clipLooksRef.current?.retain(ids);
    graphicsLayersRef.current?.retain(ids);
  }, [filteredTimelineClips]);
  // Clip-cut transitions (phase 10b): held and live-handle frames of the side that is not on screen (hidden
  // elements of their own), and the two frame-sized layers a window blends.
  const clipSnapshotsRef = useRef<FrameSnapshots | null>(null);
  const windowLayersRef = useRef<[HTMLCanvasElement, HTMLCanvasElement] | null>(null);
  // Masked text and stickers (phase 10d): their mask-only plans and the offscreen layer they are masked on.
  const layerMasksRef = useRef<LayerMaskCache | null>(null);
  layerMasksRef.current ??= new LayerMaskCache();
  const maskLayerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    // Hidden (and on unmount): release the hidden decoders and snapshots so they stop buffering; the next
    // visible draw makes them again.
    const release = () => {
      clipSnapshotsRef.current?.dispose();
      clipSnapshotsRef.current = null;
    };
    if (!docVisible) release();
    return release;
  }, [docVisible]);
  const { items: effectDefs } = useEffectCatalog("effect", { enabled: hasEnabledEffectClips });
  const effectDefsById = useMemo(() => new Map(effectDefs.map((d) => [d.id, d])), [effectDefs]);
  const preparedEffectLayers = useMemo<PreparedEffectLayer[]>(
    () => (hasEnabledEffectClips ? prepareEffectLayers(effectSourceClips, effectDefsById, timelineTracks) : []),
    [hasEnabledEffectClips, effectSourceClips, effectDefsById, timelineTracks],
  );
  const preparedEffectLayersRef = useRef(preparedEffectLayers);
  useEffect(() => {
    preparedEffectLayersRef.current = preparedEffectLayers;
    requestCompositorDrawRef.current();
  }, [preparedEffectLayers]);
  const effectGlRef = useRef<{ renderer: EffectRenderer; canvas: HTMLCanvasElement } | null>(null);
  // GL failure is React STATE (mirrored into a ref for the draw loop): the
  // suppression prop must flip off in the same commit that records the
  // failure, or ScenePreview's fallback pass stays disabled until an
  // unrelated render happens and effects silently vanish in between.
  const [effectGlFailed, setEffectGlFailed] = useState(false);
  const effectGlFailedRef = useRef(false);
  const markEffectGlFailed = useCallback(() => {
    effectGlFailedRef.current = true;
    effectGlRef.current?.renderer.destroy();
    effectGlRef.current = null;
    setEffectGlFailed(true);
  }, []);
  const effectCompositeRef = useRef<HTMLCanvasElement | null>(null);
  const getEffectGl = useCallback(() => {
    if (effectGlFailedRef.current) return null;
    if (effectGlRef.current) return effectGlRef.current;
    try {
      const glCanvas = document.createElement("canvas");
      const renderer = new EffectRenderer(glCanvas);
      effectGlRef.current = { renderer, canvas: glCanvas };
      return effectGlRef.current;
    } catch {
      markEffectGlFailed();
      return null;
    }
  }, [markEffectGlFailed]);
  useEffect(() => () => {
    effectGlRef.current?.renderer.destroy();
    effectGlRef.current = null;
  }, []);
  // Effects apply over everything below them (phase 11), so ScenePreview's footage-only effect passes never run
  // while this compositor can run them: an active effect turns the compositor on instead. They stay only as the
  // fallback when it cannot (no looks renderer for built-in effects, GL failed for catalog effects).
  const suppressSceneEffectLayer = (builtinSpanClips.length > 0 && Boolean(lookRenderer)) || (preparedEffectLayers.length > 0 && !effectGlFailed);


  const onUpdateClipRef = useRef(onUpdateClip);
  onUpdateClipRef.current = onUpdateClip;
  // Drags commit through keyframe.set / clip.update with history (one undo step per drag).
  const commitDrag = useDragCommit();
  const commitDragRef = useRef(commitDrag);
  commitDragRef.current = commitDrag;
  // Scene gestures write scene.update / keyframe.set (sceneId) through the controller.
  const commitScene = useSceneTransformCommit();
  const commitSceneRef = useRef(commitScene);
  commitSceneRef.current = commitScene;
  // Unmounting mid-gesture settles a live scene write instead of leaving it parked until its long debounce.
  useEffect(() => () => {
    const d = dragRef.current;
    const last = sceneGestureRef.current;
    if (d?.target === "scene" && last) void commitSceneRef.current(d.id, last, { coalesceKey: d.gesture, debounceMs: SCENE_SETTLE_DEBOUNCE_MS });
  }, []);

  // ── Preview viewport visibility ──
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      const visibleFrame = requestAnimationFrame(() => setPreviewVisible(true));
      return () => cancelAnimationFrame(visibleFrame);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setPreviewVisible(entry.isIntersecting);
      },
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // ── Canvas sizing via ResizeObserver ──
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw > 0 && ch > 0) {
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        chromeColorsRef.current = readChromeColors(canvas);
        requestCompositorDrawRef.current();
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ── Chrome colours follow the theme ──
  // The selection ring and snap line come from theme tokens: read them on mount and again whenever the
  // theme on <html> (class, data-theme, inline tokens) or the system colour scheme changes.
  useEffect(() => {
    const refresh = () => {
      chromeColorsRef.current = readChromeColors(canvasRef.current);
      assetVersionRef.current += 1;
      requestCompositorDrawRef.current();
    };
    refresh();
    const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(refresh) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    const scheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    scheme?.addEventListener?.("change", refresh);
    return () => {
      observer?.disconnect();
      scheme?.removeEventListener?.("change", refresh);
    };
  }, []);

  // ── RAF draw loop ──
  useEffect(() => {
    if (!docVisible || !previewVisible) return;
    let running = true;
    let frameId: number | null = null;
    let scheduled = false;
    const shouldKeepDrawing = () => dragRef.current !== null;

    const clearScheduled = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      scheduled = false;
    };

    const scheduleNextDraw = () => {
      if (!running || scheduled) return;
      scheduled = true;
      frameId = requestAnimationFrame(() => {
        frameId = null;
        scheduled = false;
        draw();
      });
    };

    const requestImmediateDraw = () => {
      if (!running) return;
      if (scheduled) return;
      clearScheduled();
      scheduleNextDraw();
    };

    requestCompositorDrawRef.current = requestImmediateDraw;
    // Graphics layers resolve asset URLs through this run's media environment.
    graphicsLayersRef.current = null;

    const draw = () => {
      if (!running) return;
      const canvas = canvasRef.current;
      if (!canvas) { if (shouldKeepDrawing()) scheduleNextDraw(); return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { if (shouldKeepDrawing()) scheduleNextDraw(); return; }

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Check if we can skip this frame (nothing changed)
      const video = scenePreviewRef.current?.getActiveVideo();
      const videoTime = video && video.readyState >= 2 ? video.currentTime : -1;
      const time = currentTimeRef.current;
      const clips = clipsRef.current;
      const selId = selectedClipIdRef.current;
      const selSceneId = selectedSceneIdRef.current;
      const playingNow = isPlayingRef.current;
      const overlayKey = `${w.toFixed(1)}x${h.toFixed(1)}|${dpr}|${time.toFixed(3)}|${selId}|${selSceneId}|${selectionVersionRef.current}|${playingNow}|${scenesVersionRef.current}|${overrideClipIdRef.current}|${clipsVersionRef.current}|${dragFrameRef.current}|${assetVersionRef.current}|${maskEditingRef.current}|${trackingVersionRef.current}|${
        overrideRef.current ? `${overrideRef.current.posX},${overrideRef.current.posY},${overrideRef.current.scale},${overrideRef.current.rotation}` : ""
      }`;

      if (
        videoTime === lastVideoTimeRef.current &&
        videoTime >= 0 &&
        overlayKey === lastOverlayKeyRef.current &&
        !dragRef.current
      ) {
        // Nothing changed — skip this frame
        if (shouldKeepDrawing()) scheduleNextDraw();
        return;
      }
      lastVideoTimeRef.current = videoTime;
      lastOverlayKeyRef.current = overlayKey;

      // Determine if video content is available (needed for overlay check below).
      // Text/sticker coordinates are relative to the project screen frame,
      // not the source media's native aspect. Otherwise a 9:16 project snaps
      // back to a 16:9-looking canvas whenever an overlay is visible.
      const projectRatio = parseAspectRatio(aspectRatio);
      const frameRect = projectFrameRect(projectRatio, w, h);
      const mr = frameRect;
      mediaRectRef.current = mr;
      // Text/sticker px are authored in EXPORT-resolution pixels (≈1080p tall).
      // Scale them to the live on-screen preview frame so on-screen size matches
      // the exported video AND tracks window resize — mr.h is recomputed every
      // draw, so text now rescales with the frame (fixes both the "huge text in
      // preview" and "doesn't resize" issues). A larger mr.h in fullscreen scales
      // up automatically, replacing the old fullscreen-only special case.
      const frameScale = frameScaleOf(projectRatio, mr.h);

      // 3. Check for text/sticker overlays + V2+ overlay video clips
      const visible = clips.filter(
        (c) => (c.trackType === "text" || c.trackType === "sticker") && time >= c.startTime && time < c.endTime
      );
      // Overlay video clips render on this canvas too — above the V1 scene,
      // below text/stickers — matching the export compositor's stacking.
      const visibleOverlayVideos = clips
        .filter((c) => c.trackType === "video" && (c.trackIndex ?? 2) >= 2 && !!c.mediaUrl && time >= c.startTime && time < c.endTime)
        .sort((a, b) => (a.trackIndex ?? 2) - (b.trackIndex ?? 2));
      // Graphics clips: built-in ones are drawn on this canvas while it composites (below text, phase 11); otherwise
      // (and custom-code ones always) they paint themselves in the DOM under this canvas, which only tracks their
      // on-screen box so they can be selected, dragged and resized like any other overlay.
      const visibleRemotion = clips
        .filter((c) => c.trackType === "remotion" && time >= c.startTime && time < c.endTime)
        .sort((a, b) => (a.trackIndex ?? 1) - (b.trackIndex ?? 1));

      // ── Effect layers at the playhead (phase 11) ──
      // Effects apply over everything below them — media, graphics, text, stickers — as in both exports, so an
      // active effect always turns the compositor on (ScenePreview never runs one over the footage alone).
      const activeEffectStacks = effectGlFailedRef.current ? [] : preparedEffectLayersRef.current
        .filter((layer) => time >= layer.startTime && time < layer.endTime)
        .flatMap((layer) => layer.renderEffects);
      const activeBuiltinSpans = lookRendererRef.current && !lookRendererRef.current.isLost ? spanPlans(builtinSpanClipsRef.current, time) : [];
      const effectActive = activeEffectStacks.length > 0 || activeBuiltinSpans.length > 0;

      // The compositor runs for text/stickers, V2+ media, and active effects. While it runs it draws the built-in
      // graphics itself (the DOM layer leaves them out: ScenePreview canvasGraphics).
      const shouldNeedCanvas = visible.length > 0 || visibleOverlayVideos.length > 0 || effectActive;

      // On-screen box of every visible graphic (phase 10c): the full-frame layer placed by the shared motion model
      // (remotionLayerPlacement, the transform the DOM layer gets), framed to what the composition paints — the
      // bounds the renderer returned when this canvas draws it, else measured in the DOM.
      const remotionRects = new Map<string, OverlayRect>();
      const remotionPlacements = new Map<string, { placed: ReturnType<typeof remotionLayerPlacement>; layerBox: HandleBox }>();
      const remotionRectOf = (layerBox: HandleBox, f: { x0: number; y0: number; x1: number; y1: number }): OverlayRect => {
        const centre = toScreen(layerBox, ((f.x0 + f.x1) / 2 - 0.5) * layerBox.w, ((f.y0 + f.y1) / 2 - 0.5) * layerBox.h);
        const cw = (f.x1 - f.x0) * layerBox.w;
        const ch = (f.y1 - f.y0) * layerBox.h;
        return { x: centre.x - cw / 2, y: centre.y - ch / 2, w: cw, h: ch, rot: layerBox.rotation, px: centre.x, py: centre.y };
      };
      const canvasClientRect = visibleRemotion.length > 0 ? canvas.getBoundingClientRect() : null;
      for (const clip of visibleRemotion) {
        const override = overrideClipIdRef.current === clip.id ? overrideRef.current : null;
        const placed = remotionLayerPlacement(clip, time - clip.startTime, override ? { clipId: clip.id, positionX: override.posX, positionY: override.posY, scale: override.scale, rotation: override.rotation } : null);
        const layerBox: HandleBox = {
          cx: mr.x + mr.w / 2 + placed.x * mr.w,
          cy: mr.y + mr.h / 2 + placed.y * mr.h,
          w: mr.w * placed.scale * Math.abs(placed.scaleX),
          h: mr.h * placed.scale,
          rotation: (placed.rotation * Math.PI) / 180,
        };
        remotionLayerRectsRef.current.set(clip.id, { x: layerBox.cx - layerBox.w / 2, y: layerBox.cy - layerBox.h / 2, w: layerBox.w, h: layerBox.h, rot: layerBox.rotation, px: layerBox.cx, py: layerBox.cy });
        remotionPlacements.set(clip.id, { placed, layerBox });
        // Prefer the box the graphic actually paints — a full-frame selection rect is meaningless to drag or resize.
        // A graphic this canvas draws takes the renderer's bounds (set where it is drawn, below). A DOM layer's
        // painted part is measured as fractions of the layer while it is upright (a rotated layer reuses the last
        // fractions); a composition that paints nothing measurable (canvas/WebGL) keeps the whole layer.
        const drawnHere = shouldNeedCanvas && isBuiltinGraphics(clip);
        const layerEl = !drawnHere && canvasClientRect && Math.abs(placed.rotation) < 0.01
          ? (containerRef.current ?? document).querySelector<HTMLElement>(`[data-remotion-clip-id="${CSS.escape(clip.id)}"]`)
          : null;
        if (layerEl) {
          const content = measureRemotionContentRect(layerEl);
          const outer = layerEl.getBoundingClientRect();
          if (content && outer.width > 0 && outer.height > 0) {
            remotionContentFractionsRef.current.set(clip.id, {
              x0: (content.x - outer.left) / outer.width, y0: (content.y - outer.top) / outer.height,
              x1: (content.x + content.w - outer.left) / outer.width, y1: (content.y + content.h - outer.top) / outer.height,
            });
          } else {
            remotionContentFractionsRef.current.delete(clip.id);
          }
        }
        remotionRects.set(clip.id, remotionRectOf(layerBox, remotionContentFractionsRef.current.get(clip.id) ?? { x0: 0, y0: 0, x1: 1, y1: 1 }));
      }

      // Graphics alone do NOT force the compositing swap: outside it they paint themselves in the DOM under this
      // canvas and only need it to CAPTURE POINTERS so they can be selected/dragged, which is tracked separately.

      // ── Scenes at the playhead (phase 10b handles) ──
      // The media rect of every visible transformable scene (topmost track first) for click-to-select, and
      // the selected one's handles while paused: the canvas then captures the pointer like for overlays.
      const sceneBoxes: Array<{ sceneId: string; trackIndex: number; geometry: SceneHandleGeometry }> = [];
      let activeSceneId: string | null | undefined;
      for (const range of sceneRangesRef.current) {
        if (time < range.start || time >= range.start + range.duration) continue;
        if (!sceneCanTransform(range.scene)) continue;
        const hasStoredSize = Number(range.scene.sourceWidth) > 0 && Number(range.scene.sourceHeight) > 0;
        if (!hasStoredSize && activeSceneId === undefined) activeSceneId = scenePreviewRef.current?.getActiveScene()?.id ?? null;
        const sourceVideo = !hasStoredSize && activeSceneId === range.scene.id && video && video.readyState >= 1 ? video : null;
        const source = sceneSourceSize(range.scene, sourceVideo, mr);
        sceneBoxes.push({
          sceneId: range.scene.id,
          trackIndex: range.scene.trackIndex ?? 1,
          geometry: sceneHandleGeometry(range.scene, range.duration, time - range.start, mr, source),
        });
      }
      sceneBoxes.sort((a, b) => b.trackIndex - a.trackIndex);
      sceneBoxesRef.current = sceneBoxes;
      // Two or more selected items show one group box instead of an item's handles (paused, or during a group gesture).
      const groupClipIds = selectedClipIdsRef.current;
      const groupSceneIds = selectedSceneIdsRef.current;
      const groupActive = groupClipIds.size + groupSceneIds.size >= 2 && (!playingNow || groupDragRef.current !== null);
      const groupVisible = groupActive && (
        clips.some((c) => groupClipIds.has(c.id) && time >= c.startTime && time < c.endTime) || sceneBoxes.some((b) => groupSceneIds.has(b.sceneId))
      );
      const sceneChromeId = !groupActive && selSceneId && !selId && (!playingNow || dragRef.current?.target === "scene") && sceneBoxes.some((b) => b.sceneId === selSceneId)
        ? selSceneId
        : null;
      sceneChromeIdRef.current = sceneChromeId;

      /** Snap guides and the selected item's chrome, above everything (after the effect pass). */
      const drawChrome = (rects: Map<string, OverlayRect>) => {
        const colors = chromeColorsRef.current;
        if (dragRef.current || groupDragRef.current) drawSnapGuides(ctx, guidesRef.current, mr, colors.snap);
        if (groupActive) {
          // Every selected item gets a thin ring; the group box (union of their boxes, or the box the gesture moves) gets
          // the handles.
          const boxes: HandleBox[] = [];
          for (const id of groupClipIds) {
            const rect = rects.get(id);
            if (rect) boxes.push(boxFromRect(rect));
          }
          for (const entry of sceneBoxes) if (groupSceneIds.has(entry.sceneId)) boxes.push(entry.geometry.visual);
          const drag = groupDragRef.current;
          const gesture = groupGestureRef.current;
          const box = drag ? (gesture ? gestureBox(drag.startBox, gesture) : drag.startBox) : unionBox(boxes);
          groupBoxRef.current = box;
          if (!box) {
            knobOffsetRef.current = null;
            return;
          }
          for (const member of boxes) drawMemberRing(ctx, member, colors.ring);
          const offset = rotateKnobOffset(box, { w, h });
          knobOffsetRef.current = { id: GROUP_CHROME_ID, offset };
          drawTransformChrome(ctx, box, colors, true, offset);
          return;
        }
        groupBoxRef.current = null;
        // Motion tracking (phase 10d): the region box (and the last track's path) replace the item's transform chrome.
        const trackTarget = trackTargetFrom(rects, sceneBoxes);
        if (trackTarget) {
          knobOffsetRef.current = null;
          drawTrackRegionChrome(ctx, trackTarget.geometry, colors, trackPathFor(trackTarget.owner, trackTarget.geometry, time - trackTarget.start));
          return;
        }
        // Mask editing (phase 10c): the selected item's mask outline and handles replace its transform chrome.
        const maskTarget = maskTargetFrom(rects, sceneBoxes);
        if (maskTarget) {
          knobOffsetRef.current = null;
          drawMaskChrome(ctx, maskTarget.geometry, colors);
          return;
        }
        const selRect = selId ? rects.get(selId) : undefined;
        let chrome: { id: string; box: HandleBox; rotate: boolean } | null = null;
        if (selRect && selId) {
          chrome = { id: selId, box: boxFromRect(selRect), rotate: true };
        } else if (sceneChromeId) {
          const entry = sceneBoxes.find((b) => b.sceneId === sceneChromeId);
          if (entry) chrome = { id: sceneChromeId, box: entry.geometry.visual, rotate: true };
        }
        if (!chrome) {
          knobOffsetRef.current = null;
          return;
        }
        const offset = rotateKnobOffset(chrome.box, { w, h });
        knobOffsetRef.current = { id: chrome.id, offset };
        drawTransformChrome(ctx, chrome.box, colors, chrome.rotate, offset);
      };

      // A graphic covers the whole frame, so capturing pointers for every
      // visible one would block scene pan/zoom entirely. Only the SELECTED
      // graphic arms the canvas — selection is the user asking to move it.
      const shouldCapturePointer = shouldNeedCanvas || visibleRemotion.some((c) => c.id === selId) || sceneChromeId !== null || dragRef.current !== null || trackingRegionRef.current !== null
        || groupVisible || groupDragRef.current !== null;
      if (shouldCapturePointer !== capturePointerRef.current) {
        capturePointerRef.current = shouldCapturePointer;
        setCapturePointer(shouldCapturePointer);
      }
      if (shouldNeedCanvas !== needsCanvasRef.current) {
        needsCanvasRef.current = shouldNeedCanvas;
        setNeedsCanvas(shouldNeedCanvas);
      }

      // When no overlays are active, skip canvas draw entirely — ScenePreview
      // is visible and handles playback directly (saves ~8MB/frame copy).
      if (!shouldNeedCanvas) {
        ctx.clearRect(0, 0, w, h);
        // Graphics still need their box tracked (hit-testing) and, when one is
        // selected, its selection frame drawn over the DOM layer.
        overlayRectsRef.current = remotionRects;
        baseRectsRef.current = new Map();
        drawChrome(remotionRects);
        if (shouldKeepDrawing()) scheduleNextDraw();
        return;
      }

      // ── Clip-cut transition windows (phase 10b, motion/clip-windows.ts) ──
      // Touching V2+ clips joined by a library transition blend inside a window centered on their cut. The side
      // that is not on screen shows a still: the incoming clip's first frame, the outgoing clip's last frame, or
      // its real media past the cut (live handle) from a hidden decoder. Paused, the canvas keeps its frame
      // until that exact still is ready (the snapshot redraws); playing never waits (held frame instead).
      const lanePlan = clipLanePlan(clips);
      /** The cached preview image of `url` once decoded (loading it on first use; the load redraws). */
      const previewImage = (url: string): HTMLImageElement | null => {
        let img = imageCacheRef.current.get(url)?.img;
        if (!img) {
          img = new Image();
          img.crossOrigin = "anonymous";
          const onLoad = () => {
            assetVersionRef.current += 1;
            if (docVisibleRef.current) requestCompositorDrawRef.current();
          };
          img.onload = onLoad;
          img.onerror = onLoad;
          cacheImage(url, { img, onLoad, onError: onLoad });
          img.src = media.resolveMediaUrl(url);
        }
        return img.complete && img.naturalWidth > 0 ? img : null;
      };
      const windowFor = new Map<string, { window: ClipWindowFrame; still: ClipWindowSide; frame: StillFrame | null }>();
      const looksRenderer = lookRendererRef.current;
      // Chain clips drop the fades their windows replace — only where the windows can be drawn (WebGL2).
      const drawnClip = (clip: TimelineClip) => (looksRenderer && !looksRenderer.isLost ? lanePlan.renderClip(clip) : clip);
      const isImageClipOf = (clip: TimelineClip) => clip.mediaType === "image" || /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(clip.mediaUrl ?? "");
      if (lanePlan.windows.length > 0 && looksRenderer && !looksRenderer.isLost) {
        const snapshots = clipSnapshotsRef.current ??= new FrameSnapshots({ resolveUrl: (url) => media.resolveMediaUrl(url), onReady: () => requestCompositorDrawRef.current() });
        snapshots.beginDraw();
        // The outgoing video's file length decides its live handle: its element (made near the cut) knows it.
        for (const planned of lanePlan.windows) {
          if (Math.abs(time - planned.a.endTime) <= planned.half && planned.a.mediaUrl && !isImageClipOf(planned.a)) getOverlayVideoEl(planned.a.id, planned.a.mediaUrl);
        }
        const durationOf = (url: string) => {
          for (const element of overlayVideoElsRef.current.values()) {
            if (element.dataset.srcKey === url && Number.isFinite(element.duration) && element.duration > 0) return element.duration;
          }
          return snapshots.liveDuration(url);
        };
        const stillFrame = (side: ClipWindowSide): StillFrame | "wait" | null => {
          const url = side.clip.mediaUrl!;
          if (isImageClipOf(side.clip)) {
            const img = previewImage(url);
            if (img) return { source: img, width: img.naturalWidth, height: img.naturalHeight };
            // A finished image with no pixels failed to load: never wait for it.
            return playingNow || imageCacheRef.current.get(url)?.img.complete ? null : "wait";
          }
          return windowStillFrame(side, snapshots, playingNow);
        };
        let wait = false;
        for (const window of clipWindowsAt(lanePlan, time, durationOf)) {
          const live = window.a.live ? window.a : window.b;
          const still = window.a.live ? window.b : window.a;
          const frame = stillFrame(still);
          if (frame === "wait") wait = true;
          else windowFor.set(live.clip.id, { window, still, frame });
        }
        if (wait) {
          lastOverlayKeyRef.current = "";
          if (shouldKeepDrawing()) scheduleNextDraw();
          return;
        }
      }

      // Canvas is transparent over the live ScenePreview. It must draw only
      // text/sticker overlays, otherwise the video changes style when text appears.
      ctx.clearRect(0, 0, w, h);

      // ── Motion placement (phase 10b) ──
      // Every overlay is placed like the export places it (motion/clip-motion.ts placedBox): the
      // keyframed/static base, the animation and legacy fades/motion preset on top (clipMotionAt), and a
      // live drag override per channel (applyDragOverride: the drag edits the base, the motion stays on top).
      const newRects = new Map<string, OverlayRect>();
      const newBaseRects = new Map<string, OverlayRect>();
      const dragOverrideFor = (clipId: string) => (overrideClipIdRef.current === clipId ? overrideRef.current : null);
      /** Registers the visual and base boxes of `clip` (box = its size at clip scale 1) and returns the visual one. */
      const placeClip = (clipId: string, box: { w: number; h: number }, sample: ClipMotionSample): { visual: PlacedBox; opacity: number } => {
        const override = dragOverrideFor(clipId);
        const transform = applyDragOverride(sample, override);
        const visual = placedBox(mr, box, transform);
        newRects.set(clipId, overlayRectOf(visual));
        newBaseRects.set(clipId, overlayRectOf(placedBox(mr, box, baseTransform(sample, override))));
        return { visual, opacity: transform.opacity };
      };
      /** Paints into the placed box (centre-origin, rotated frame); the selection chrome is drawn last (drawChrome). */
      const paintPlaced = (_clipId: string, visual: PlacedBox, opacity: number, paint: (x: number, y: number, w: number, h: number) => void) => {
        ctx.save();
        ctx.translate(visual.cx, visual.cy);
        if (visual.rotation) ctx.rotate(visual.rotation);
        const x = -visual.w / 2;
        const y = -visual.h / 2;
        if (opacity > 0 && visual.w > 0 && visual.h > 0) {
          ctx.globalAlpha = opacity;
          paint(x, y, visual.w, visual.h);
        }
        ctx.restore();
      };

      /**
       * Draws a clip's window (when it is the live side of one) instead of the clip alone; false when there is
       * none or the renderer cannot, so the caller paints the clip as usual.
       */
      const paintWindow = (clip: TimelineClip, source: TexImageSource, sw: number, sh: number, local: number): boolean => {
        const entry = windowFor.get(clip.id);
        const def = entry ? transitionById(entry.window.transitionId) : null;
        if (!entry || !entry.frame || !def || !looksRenderer) return false;
        const layers = windowLayersRef.current ??= [document.createElement("canvas"), document.createElement("canvas")];
        const sideDraw = (sideClip: TimelineClip, sideLocal: number, image: TexImageSource, width: number, height: number, override: DragOverride | null): WindowSideDraw => ({
          box: { w: width * frameScale, h: height * frameScale },
          transform: applyDragOverride(clipMotionAt(sideClip, sideLocal), override),
          paint: (layer, x, y, dw, dh) => {
            if (!drawClipThroughLook(layer, looksRenderer, clipLooksRef.current!.at(sideClip, sideLocal), image, width, height, x, y, dw, dh, sideLocal, dpr, frameScale)) {
              layer.drawImage(image as CanvasImageSource, x, y, dw, dh);
            }
          },
        });
        const liveSide = sideDraw(lanePlan.renderClip(clip), local, source, sw, sh, dragOverrideFor(clip.id));
        const stillSide = sideDraw(entry.still.clip, entry.still.local, entry.frame.source, entry.frame.width, entry.frame.height, null);
        const [a, b] = entry.window.a.live ? [liveSide, stillSide] : [stillSide, liveSide];
        return drawClipWindow(ctx, looksRenderer, mr, dpr, def, entry.window.p, a, b, layers);
      };

      // ── V2+ overlay video clips (below text/stickers) ──
      const storeState = storeApi.getState();
      const overlayPlaying = storeState.isPlaying;
      for (const clip of visibleOverlayVideos) {
        const local = time - clip.startTime;
        // Image clips share the video lane family — draw stills from the
        // image cache; only real video URLs get a <video> element.
        const isImageClip = clip.mediaType === "image" || /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(clip.mediaUrl!);
        if (isImageClip) {
          const imgKey = clip.mediaUrl!;
          let cached = imageCacheRef.current.get(imgKey);
          let img = cached?.img;
          if (!img) {
            img = new Image();
            img.crossOrigin = "anonymous";
            const onLoad = () => {
              assetVersionRef.current += 1;
              if (docVisibleRef.current) requestCompositorDrawRef.current();
            };
            img.onload = onLoad;
            img.onerror = onLoad;
            cached = { img, onLoad, onError: onLoad };
            cacheImage(imgKey, cached);
            img.src = media.resolveMediaUrl(imgKey);
          }
          if (img.complete && img.naturalWidth > 0) {
            const still = img;
            const drawn = drawnClip(clip);
            // Export composites the overlay at native pixels × clip scale on the export-resolution frame.
            const { visual, opacity } = placeClip(clip.id, { w: still.naturalWidth * frameScale, h: still.naturalHeight * frameScale }, clipMotionAt(drawn, local));
            if (paintWindow(clip, still, still.naturalWidth, still.naturalHeight, local)) continue;
            paintPlaced(clip.id, visual, opacity, (x, y, dw, dh) => {
              if (!drawClipThroughLook(ctx, lookRendererRef.current, clipLooksRef.current!.at(drawn, local), still, still.naturalWidth, still.naturalHeight, x, y, dw, dh, local, dpr, frameScale)) {
                ctx.drawImage(still, x, y, dw, dh);
              }
            });
          }
          continue;
        }
        const vid = getOverlayVideoEl(clip.id, clip.mediaUrl!);
        // Speed (phase 10b): constant speed, curves and legacy ramps through the clip's exact time map from
        // its trimStart (like the export's overlay input), at the instantaneous rate; outside the browser's
        // rate range the element is held and stepped by seeking (speed-sync.ts).
        const overlayProfile = cachedClipSpeedProfile(clip);
        const overlayLength = Math.max(0, clip.endTime - clip.startTime);
        const desired = mediaTimeAt(overlayProfile, time - clip.startTime, overlayLength, clipMediaStart(clip));
        const overlayTarget = targetRate(overlayProfile, time - clip.startTime, overlayLength);
        // Embedded audio follows the clip volume × the video track's fader,
        // silenced by the track mute — mirrors the export mix.
        const overlayTrack = timelineTracksRef.current?.find(
          (tr) => tr.type === "video" && tr.index === (clip.trackIndex ?? 2)
        );
        const overlayTrackVol = Number(overlayTrack?.volume ?? 1);
        const overlayClipVol = Number(clip.volume ?? 1);
        const overlayEffVol = Math.max(0, Math.min(1,
          (Number.isFinite(overlayClipVol) ? overlayClipVol : 1) * (Number.isFinite(overlayTrackVol) ? overlayTrackVol : 1)
        ));
        vid.muted = Boolean(overlayTrack?.muted) || overlayEffVol <= 0.001;
        vid.volume = overlayEffVol;
        if (overlayPlaying) {
          if (vid.paused && !overlayTarget.seek) vid.play().catch(() => {});
          // Only hard-correct on real drift (0.35 s, as before) — constant reseeks stutter decode; smaller
          // drift is nudged ±2%.
          if (vid.readyState >= 1) syncMediaElement(vid, { desired, playing: true, target: overlayTarget, preservePitch: overlayProfile.preservePitch, hardSeekDrift: 0.35 });
        } else {
          if (!vid.paused) vid.pause();
          if (vid.readyState >= 1) syncMediaElement(vid, { desired, playing: false, target: overlayTarget, preservePitch: overlayProfile.preservePitch });
        }
        if (vid.readyState < 2 || vid.videoWidth <= 0) continue;

        // Export composites the overlay at native pixels × clip scale on the export-resolution frame.
        const drawn = drawnClip(clip);
        const { visual, opacity } = placeClip(clip.id, { w: vid.videoWidth * frameScale, h: vid.videoHeight * frameScale }, clipMotionAt(drawn, local));
        if (paintWindow(clip, vid, vid.videoWidth, vid.videoHeight, local)) continue;
        paintPlaced(clip.id, visual, opacity, (x, y, dw, dh) => {
          if (!drawClipThroughLook(ctx, lookRendererRef.current, clipLooksRef.current!.at(drawn, local), vid, vid.videoWidth, vid.videoHeight, x, y, dw, dh, local, dpr, frameScale)) {
            ctx.drawImage(vid, x, y, dw, dh);
          }
        });
      }
      // Pause any overlay video element whose clip is no longer on screen.
      const visibleOverlayIds = new Set(visibleOverlayVideos.map((c) => c.id));
      overlayVideoElsRef.current.forEach((vid, id) => {
        if (!visibleOverlayIds.has(id) && !vid.paused) vid.pause();
      });

      // ── Built-in graphics (above V2+ media, below text/stickers; phase 11) ──
      // In track order, like both exports: the 10d renderer's template frame on a full-frame layer, placed by the
      // shared motion model (live drag included). Its bounds frame the selection box. The DOM graphics layer leaves
      // these clips out while this canvas composites (ScenePreview canvasGraphics); custom-code graphics stay there.
      const builtinGraphics = visibleRemotion.filter((clip) => isBuiltinGraphics(clip));
      if (builtinGraphics.length > 0) {
        const graphicsLayers = graphicsLayersRef.current ??= new GraphicsLayerCache({
          createCanvas: () => document.createElement("canvas"),
          assetImage: (url, owner) => graphicsAssetImage(media.resolveMediaUrl(url), `compositor:${owner}`, () => {
            assetVersionRef.current += 1;
            requestCompositorDrawRef.current();
          }),
          assetSettled: (url) => graphicsAssetSettled(media.resolveMediaUrl(url)),
        });
        if (!graphicsFontsRequestedRef.current) {
          graphicsFontsRequestedRef.current = true;
          void loadGraphicsFonts().then(() => {
            graphicsLayersRef.current?.invalidate();
            assetVersionRef.current += 1;
            requestCompositorDrawRef.current();
          });
        }
        // The layer at device pixels (at most 2×, like the DOM layer).
        const layerDensity = Math.min(2, dpr);
        for (const clip of builtinGraphics) {
          const placement = remotionPlacements.get(clip.id);
          if (!placement) continue;
          const layer = graphicsLayers.frame(clip, time - clip.startTime, mr.w * layerDensity, mr.h * layerDensity);
          if (!layer) continue;
          const fractions = graphicsBoundsFractions(layer);
          if (fractions) remotionContentFractionsRef.current.set(clip.id, fractions);
          remotionRects.set(clip.id, remotionRectOf(placement.layerBox, fractions ?? remotionContentFractionsRef.current.get(clip.id) ?? { x0: 0, y0: 0, x1: 1, y1: 1 }));
          paintGraphicsLayer(ctx, layer, placement.placed, mr);
        }
      }

      const textBitmaps = textBitmapsRef.current;
      const stickerImages = stickerImagesRef.current;
      const fontLoader = fontLoaderRef.current;
      const maskLayerCanvas = (width: number, height: number) => {
        const canvas = maskLayerCanvasRef.current ??= document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      };
      /**
       * Paints a text or sticker layer (phase 10d): through its mask (in the item box `box`, on the bitmap's `outer`
       * rect) when it has one and the renderer can, else as is.
       */
      const paintLayer = (clip: TimelineClip, local: number, outer: LayerRect, box: LayerRect, paint: (target: CanvasRenderingContext2D) => void) => {
        const plan = layerMasksRef.current!.planFor(clip);
        if (plan && paintMaskedLayer(ctx, looksRenderer, plan, local, dpr, outer, box, (layer) => paint(layer), maskLayerCanvas)) return;
        paint(ctx);
      };
      for (const clip of visible) {
        const local = time - clip.startTime;
        const sample = clipMotionAt(clip, local);

        if (clip.trackType === "text" && textBitmaps) {
          // The current raster state (typewriter, wipe, blur, glow, letters, karaoke) drawn by the export
          // rasterizer's code into a cached bitmap, laid out at the export's raster scale and placed with motion.
          fontLoader?.ensure(fontFacesForStyle(clip.textStyle));
          const { state } = clipTextStateAt(clip, local);
          const dragScale = dragOverrideFor(clip.id)?.scale;
          const layoutScale = dragScale ?? textLayoutScale(clip);
          // A corner drag reuses the last bitmap, scaled, while the scale keeps changing; it is drawn at the
          // exact scale once the scale holds still (TEXT_DRAG_SETTLE_MS) and on release.
          const resizing = dragRef.current?.type === "resize" && dragRef.current.id === clip.id && dragScale !== undefined;
          let reuseScaled = false;
          if (resizing) {
            const settle = textDragSettleRef.current;
            const now = performance.now();
            if (!settle || settle.clipId !== clip.id || settle.scale !== layoutScale) {
              textDragSettleRef.current = { clipId: clip.id, scale: layoutScale, since: now };
              reuseScaled = true;
            } else {
              reuseScaled = now - settle.since < TEXT_DRAG_SETTLE_MS;
            }
          } else if (textDragSettleRef.current?.clipId === clip.id) {
            textDragSettleRef.current = null;
          }
          const bitmap = textBitmaps.get({
            clipId: clip.id, text: clip.textContent || "", textStyle: clip.textStyle, state,
            layoutScale, frameScale, frameWidth: mr.w, density: dpr,
          }, { reuseScaled });
          if (bitmap && bitmap.layoutScale > 0) {
            const { visual, opacity } = placeClip(clip.id, { w: bitmap.boxW / bitmap.layoutScale, h: bitmap.boxH / bitmap.layoutScale }, sample);
            paintPlaced(clip.id, visual, opacity, (x, y, dw, dh) => {
              if (bitmap.boxW <= 0 || bitmap.boxH <= 0) return;
              const sx = dw / bitmap.boxW;
              const sy = dh / bitmap.boxH;
              const outer = { x: x - bitmap.bleed * sx, y: y - bitmap.bleed * sy, w: bitmap.canvas.width * bitmap.pxSize * sx, h: bitmap.canvas.height * bitmap.pxSize * sy };
              paintLayer(clip, local, outer, { x, y, w: dw, h: dh }, (target) => target.drawImage(bitmap.canvas as HTMLCanvasElement, outer.x, outer.y, outer.w, outer.h));
            });
          }
          continue;
        }
        if (clip.trackType !== "sticker") continue;
        const bundledBox = clip.stickerId ? stickerBox(clip.stickerId, mr.h) : null;
        if (clip.stickerId && bundledBox && stickerImages) {
          // Bundled sticker: the catalog SVG decoded at a size bucket ≥ the drawn device size.
          const stickerId = clip.stickerId;
          const { visual, opacity } = placeClip(clip.id, { w: bundledBox.width, h: bundledBox.height }, sample);
          const image = stickerImages.get(stickerId, Math.max(visual.w, visual.h) * dpr);
          paintPlaced(clip.id, visual, opacity, (x, y, dw, dh) => {
            if (!image) return;
            const rect = { x, y, w: dw, h: dh };
            paintLayer(clip, local, rect, rect, (target) => target.drawImage(image as unknown as HTMLImageElement, x, y, dw, dh));
          });
          continue;
        }
        if (clip.mediaUrl) {
          const imgKey = clip.mediaUrl;
          const previewImageUrl = media.resolveMediaUrl(imgKey);
          let cached = imageCacheRef.current.get(imgKey);
          let img = cached?.img;
          if (!img) {
            img = new Image();
            img.crossOrigin = "anonymous";
            const created = img;
            const onLoad = () => {
              if (imageCacheRef.current.get(imgKey)?.img !== created) return;
              assetVersionRef.current += 1;
              if (docVisibleRef.current) requestCompositorDrawRef.current();
            };
            img.onload = onLoad;
            img.onerror = onLoad;
            cached = { img, onLoad, onError: onLoad };
            cacheImage(imgKey, cached);
            img.src = previewImageUrl;
          }
          if (img.complete && img.naturalWidth > 0) {
            const still = img;
            // Export composites image stickers at native pixels × clip scale on the export-resolution frame.
            const { visual, opacity } = placeClip(clip.id, { w: still.naturalWidth * frameScale, h: still.naturalHeight * frameScale }, sample);
            paintPlaced(clip.id, visual, opacity, (x, y, dw, dh) => {
              const rect = { x, y, w: dw, h: dh };
              paintLayer(clip, local, rect, rect, (target) => target.drawImage(still, x, y, dw, dh));
            });
          }
          continue;
        }
        if (clip.textContent) {
          // Emoji sticker: a system-font glyph in a square box (64 reference px × 1.2 at clip scale 1).
          const text = clip.textContent;
          const side = EMOJI_REFERENCE_PX * EMOJI_BOX_RATIO * frameScale;
          const { visual, opacity } = placeClip(clip.id, { w: side, h: side }, sample);
          paintPlaced(clip.id, visual, opacity, (x, y, dw, dh) => {
            // The glyph may overhang its box: a masked emoji is drawn on a quarter-box margin (the export pads its raster).
            const outer = { x: x - dw / 4, y: y - dh / 4, w: dw * 1.5, h: dh * 1.5 };
            paintLayer(clip, local, outer, { x, y, w: dw, h: dh }, (target) => {
              target.translate(x + dw / 2, y + dh / 2);
              target.scale(dw / dh, 1);
              target.font = `${dh / EMOJI_BOX_RATIO}px sans-serif`;
              target.textAlign = "center";
              target.textBaseline = "middle";
              target.fillText(text, 0, 0);
            });
          });
        }
      }
      // ── Graphics clips' boxes (built-in ones drawn above; custom-code pixels come from the DOM layer) ──
      remotionRects.forEach((rect, clipId) => {
        newRects.set(clipId, rect);
      });

      overlayRectsRef.current = newRects;
      baseRectsRef.current = newBaseRects;

      // ── Effect layers over the FULL composite (export parity) ──
      // Both exports run effects over everything below them: scene lanes, V2+ media, graphics, text and stickers.
      // Build footage + this canvas (V2+ media, built-in graphics, text, stickers) offscreen, run the active effect
      // stack, stamp back into the frame rect. ScenePreview never runs effect layers while this compositor can
      // (suppressSceneEffectLayer), so effects are never applied twice. Custom-code graphics (DOM only) are under
      // the stamp: exports leave them out.
      const laneCanvas = scenePreviewRef.current?.getLaneCanvas?.() ?? null;
      // With no scene at the playhead the export's base is black: nothing to wait for.
      const sceneAtPlayhead = sceneRangesRef.current.some((range) => time >= range.start && time < range.start + range.duration);
      const footageReady = Boolean(laneCanvas) || Boolean(video && video.readyState >= 2 && video.videoWidth > 0) || !sceneAtPlayhead;
      if (effectActive && footageReady) {
        const gl = activeEffectStacks.length > 0 ? getEffectGl() : null;
        if (gl || activeEffectStacks.length === 0) {
          try {
            // Composite at DEVICE pixels — a CSS-pixel composite would be
            // downsampled then re-upscaled onto the dpr-scaled canvas,
            // blurring the whole effected frame on high-DPI displays.
            const compW = Math.max(2, Math.round(mr.w * dpr));
            const compH = Math.max(2, Math.round(mr.h * dpr));
            let comp = effectCompositeRef.current;
            if (!comp) {
              comp = document.createElement("canvas");
              effectCompositeRef.current = comp;
            }
            if (comp.width !== compW || comp.height !== compH) {
              comp.width = compW;
              comp.height = compH;
            }
            const compCtx = comp.getContext("2d");
            if (compCtx) {
              // Footage: use the DOM video's on-screen rect so scene
              // transforms (pan/scale) stay faithful in effect mode.
              compCtx.fillStyle = "#000";
              compCtx.fillRect(0, 0, compW, compH);
              if (sceneAtPlayhead) {
                // Scene lanes, lowest track first. A still scene from its element's on-screen box; a scene with
                // motion (animation, keyframed transform, rotation, opacity) through its placement at its local
                // time (scene-footage.ts), since a CSS-transformed element's box is not where its pixels are.
                const cr = canvas.getBoundingClientRect();
                const drawScene = (sceneId: string, element: HTMLVideoElement) => {
                  const range = sceneRangesRef.current.find((r) => r.scene.id === sceneId);
                  const vr = element.getBoundingClientRect();
                  drawSceneFootage(
                    compCtx,
                    { element, width: element.videoWidth, height: element.videoHeight },
                    range?.scene ?? { id: "" },
                    range?.duration ?? 0,
                    time - (range?.start ?? 0),
                    { width: compW, height: compH },
                    { x: (vr.left - cr.left - mr.x) * dpr, y: (vr.top - cr.top - mr.y) * dpr, w: vr.width * dpr, h: vr.height * dpr },
                  );
                };
                const sceneVideos = scenePreviewRef.current?.getSceneVideos?.() ?? [];
                if (laneCanvas) {
                  // The main-track look overlay already holds the lane frame (looks, transitions); V2+ scene lanes
                  // go over it.
                  compCtx.drawImage(laneCanvas, 0, 0, compW, compH);
                  for (const entry of sceneVideos) if (entry.trackIndex >= 2) drawScene(entry.sceneId, entry.video);
                } else if (sceneVideos.length > 0) {
                  for (const entry of sceneVideos) drawScene(entry.sceneId, entry.video);
                } else if (video) {
                  const activeScene = scenePreviewRef.current?.getActiveScene?.() ?? null;
                  drawScene(activeScene?.id ?? "", video);
                }
              }
              // Overlays: this canvas's frame-rect region (backing store is
              // dpr-scaled).
              compCtx.drawImage(
                canvas,
                mr.x * dpr, mr.y * dpr, mr.w * dpr, mr.h * dpr,
                0, 0, compW, compH,
              );
              let result: CanvasImageSource = comp;
              let resultRect = { x: 0, y: 0, width: compW, height: compH };
              if (gl && activeEffectStacks.length > 0) {
                gl.renderer.render(comp, activeEffectStacks, time);
                result = gl.canvas;
              }
              const looks = lookRendererRef.current;
              if (looks && activeBuiltinSpans.length > 0) {
                let frame = looks.upload(result as TexImageSource, compW, compH);
                for (const span of activeBuiltinSpans) frame = looks.look(frame, span.plan, span.local);
                // The shared canvas only grows: its region holds this frame.
                resultRect = looks.presentRegion(frame, compW, compH);
                looks.releaseAll();
                result = looks.canvas as CanvasImageSource;
              }
              ctx.clearRect(mr.x, mr.y, mr.w, mr.h);
              ctx.drawImage(result, resultRect.x, resultRect.y, resultRect.width, resultRect.height, mr.x, mr.y, mr.w, mr.h);
            }
          } catch {
            // GL hiccup — leave the un-effected composite; the state flip
            // un-suppresses ScenePreview's footage pass in the same commit.
            markEffectGlFailed();
          }
        }
      }

      drawChrome(newRects);
      if (shouldKeepDrawing()) scheduleNextDraw();
    };

    scheduleNextDraw();
    return () => {
      running = false;
      requestCompositorDrawRef.current = () => {};
      clearScheduled();
    };
  }, [aspectRatio, cacheImage, docVisible, previewVisible, getOverlayVideoEl, getEffectGl, markEffectGlFailed, media]);

  // ── Motion tracking target (phase 10d) ──
  /** The Track tab's item when it is on screen: its owner, timeline start, and the region box geometry. */
  const trackTargetFrom = useCallback((rects: Map<string, OverlayRect>, sceneBoxes: Array<{ sceneId: string; geometry: SceneHandleGeometry }>): {
    owner: TrackingOwner; start: number; geometry: TrackRegionGeometry;
  } | null => {
    const tracking = trackingRegionRef.current;
    if (!tracking) return null;
    if ("clipId" in tracking.owner) {
      const clipId = tracking.owner.clipId;
      const clip = clipsRef.current.find((c) => c.id === clipId);
      const rect = rects.get(clipId);
      if (!clip || !rect) return null;
      return { owner: tracking.owner, start: clip.startTime, geometry: trackRegionGeometry(boxFromRect(rect), tracking.region, { x: Boolean(clip.horizontalFlip), y: Boolean(clip.verticalFlip) }) };
    }
    const sceneId = tracking.owner.sceneId;
    const entry = sceneBoxes.find((b) => b.sceneId === sceneId);
    const range = sceneRangesRef.current.find((r) => r.scene.id === sceneId);
    if (!entry || !range) return null;
    return { owner: tracking.owner, start: range.start, geometry: trackRegionGeometry(entry.geometry.visual, tracking.region) };
  }, []);

  /** The last track of `owner` on screen (in the item's current box) and its point at item-local `local`. */
  const trackPathFor = useCallback((owner: TrackingOwner, geometry: TrackRegionGeometry, local: number) => {
    const result = trackingResultRef.current;
    if (!result || JSON.stringify(result.owner) !== JSON.stringify(owner) || result.samples.length === 0) return undefined;
    const points = result.samples.map((sample) => sourceToScreen(geometry.item, geometry.flip, sample));
    let nearest = 0;
    for (let i = 1; i < result.samples.length; i += 1) {
      if (Math.abs(result.samples[i].time - local) < Math.abs(result.samples[nearest].time - local)) nearest = i;
    }
    const inside = local >= result.samples[0].time - 0.05 && local <= result.samples[result.samples.length - 1].time + 0.05;
    return { points, current: inside ? points[nearest] : null };
  }, []);

  /** A region drag: every move rewrites the store's region (view state, no command); pointer-up ends it. */
  function startTrackRegionDrag(e: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement, geometry: TrackRegionGeometry, hit: TrackRegionHit, pointer: { x: number; y: number }) {
    trackDragEndRef.current?.();
    const tracking = trackingRegionRef.current;
    if (!tracking) return;
    e.preventDefault();
    const start: TrackRegionDragStart = { item: geometry.item, flip: geometry.flip, region: tracking.region, hit, pointer };
    const onMove = (ev: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      const current = storeApi.getState().trackingRegion;
      if (!current || JSON.stringify(current.owner) !== JSON.stringify(tracking.owner)) return;
      storeApi.getState().setTrackingRegion({ owner: current.owner, region: trackRegionDrag(start, { x: ev.clientX - box.left, y: ev.clientY - box.top }) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (trackDragEndRef.current === onUp) trackDragEndRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    trackDragEndRef.current = onUp;
  }

  // The overlay boxes this preview laid out, for tracking.apply's followers (box at scale 1, frame fractions).
  const overlayAnchors = useContext(TimelineContext)?.overlayAnchors;
  useEffect(() => {
    if (!overlayAnchors) return;
    const provide = (clipIds: string[]) => {
      const out: Record<string, { width: number; height: number } | undefined> = {};
      const frame = mediaRectRef.current;
      if (!frame || !(frame.w > 0) || !(frame.h > 0)) return out;
      const time = currentTimeRef.current;
      for (const id of clipIds) {
        const rect = baseRectsRef.current.get(id);
        const clip = clipsRef.current.find((c) => c.id === id);
        if (!rect || !clip || rect.anchorW === undefined || rect.anchorH === undefined) continue;
        const scale = clipBaseAt(clip, time - clip.startTime).scale;
        if (!(scale > 0)) continue;
        out[id] = { width: rect.anchorW / scale / frame.w, height: rect.anchorH / scale / frame.h };
      }
      return out;
    };
    overlayAnchors.current = provide;
    return () => {
      if (overlayAnchors.current === provide) overlayAnchors.current = null;
    };
  }, [overlayAnchors]);

  // ── Mask target (phase 10c) ──
  /**
   * The selected video/image clip or scene with a mask while the Mask tab is open: its owner, the item's visual
   * box on screen, and the mask geometry at the playhead (keyframes evaluated). Null otherwise.
   */
  const maskTargetFrom = useCallback((rects: Map<string, OverlayRect>, sceneBoxes: Array<{ sceneId: string; geometry: SceneHandleGeometry }>): {
    owner: { clipId: string } | { sceneId: string }; geometry: MaskScreenGeometry; start: MaskDragStart["mask"];
  } | null => {
    if (!maskEditingRef.current) return null;
    const time = currentTimeRef.current;
    const selId = selectedClipIdRef.current;
    if (selId) {
      const clip = clipsRef.current.find((c) => c.id === selId);
      const rect = rects.get(selId);
      const spec = clip && clipTakesMask(clip) ? parseMask(clip.maskJson) : null;
      if (!clip || !rect || !spec) return null;
      const mask = maskSpecAt(spec, parseTimelineKeyframes(clip.keyframesJson), time - clip.startTime);
      return { owner: { clipId: clip.id }, geometry: maskScreenGeometry(boxFromRect(rect), mask), start: mask };
    }
    const sceneId = sceneChromeIdRef.current;
    const entry = sceneId ? sceneBoxes.find((b) => b.sceneId === sceneId) : undefined;
    const range = sceneId ? sceneRangesRef.current.find((r) => r.scene.id === sceneId) : undefined;
    const spec = range ? parseMask(range.scene.maskJson) : null;
    if (!entry || !range || !spec) return null;
    const mask = maskSpecAt(spec, parseTimelineKeyframes(range.scene.keyframesJson), time - range.start);
    return { owner: { sceneId: range.scene.id }, geometry: maskScreenGeometry(entry.geometry.visual, mask), start: mask };
  }, []);

  // ── Hit test ──
  const knobOffsetFor = (id: string) => (knobOffsetRef.current?.id === id ? knobOffsetRef.current.offset : undefined);
  /** Items only (no group mapping); `handles`: the single selected item's handles count. */
  const itemHitTest = useCallback((cx: number, cy: number, handles: boolean): HitResult => {
    const selId = handles ? selectedClipIdRef.current : null;
    const clips = clipsRef.current;
    // Handles of the selected clip first (rotate knob, corners), in its rotated frame.
    if (selId) {
      const rect = overlayRectsRef.current.get(selId);
      if (rect) {
        const hit = hitTestHandles(boxFromRect(rect), cx, cy, { rotateOffset: knobOffsetFor(selId) });
        if (hit?.kind === "rotate") return { type: "rotate", clipId: selId };
        if (hit?.kind === "corner") return { type: "resize", clipId: selId, corner: hit.corner };
      }
    }
    // Then the selected scene's handles.
    const sceneChromeId = sceneChromeIdRef.current;
    const chromeScene = sceneChromeId ? sceneBoxesRef.current.find((b) => b.sceneId === sceneChromeId) : undefined;
    if (chromeScene) {
      const hit = hitTestHandles(chromeScene.geometry.visual, cx, cy, { rotateOffset: knobOffsetFor(chromeScene.sceneId) });
      if (hit?.kind === "rotate") return { type: "scene", sceneId: chromeScene.sceneId, handle: "rotate" };
      if (hit?.kind === "corner") return { type: "scene", sceneId: chromeScene.sceneId, handle: hit.corner };
    }
    // Overlay bodies (last drawn = top)
    const time = currentTimeRef.current;
    const visible = clips.filter(
      (c) => (
        c.trackType === "text" || c.trackType === "sticker" ||
        (c.trackType === "video" && (c.trackIndex ?? 2) >= 2 && !!c.mediaUrl)
      ) && time >= c.startTime && time < c.endTime
    );
    for (let i = visible.length - 1; i >= 0; i--) {
      const clip = visible[i];
      const rect = overlayRectsRef.current.get(clip.id);
      if (!rect) continue;
      if (hitTestHandles(boxFromRect(rect), cx, cy, { handles: false })) {
        return { type: "overlay", clipId: clip.id };
      }
    }
    // Graphics next: a graphic covers the whole frame, so hit-testing it first
    // would make every text/sticker under it unclickable.
    const visibleRemotion = clips
      .filter((c) => c.trackType === "remotion" && time >= c.startTime && time < c.endTime)
      .sort((a, b) => (a.trackIndex ?? 1) - (b.trackIndex ?? 1));
    for (let i = visibleRemotion.length - 1; i >= 0; i--) {
      const clip = visibleRemotion[i];
      const rect = overlayRectsRef.current.get(clip.id);
      if (!rect) continue;
      if (hitTestHandles(boxFromRect(rect), cx, cy, { handles: false })) {
        return { type: "overlay", clipId: clip.id };
      }
    }
    // Scenes last: an empty area of the frame over a scene's media selects (and drags) that scene, the
    // selected scene before the topmost one.
    if (chromeScene && hitTestHandles(chromeScene.geometry.visual, cx, cy, { handles: false })) {
      return { type: "scene", sceneId: chromeScene.sceneId, handle: "body" };
    }
    for (const entry of sceneBoxesRef.current) {
      if (hitTestHandles(entry.geometry.visual, cx, cy, { handles: false })) return { type: "scene", sceneId: entry.sceneId, handle: "body" };
    }
    return null;
  }, []);

  // With a group box (phase 10c): its handles first, then a selected item or the box interior moves the group; an
  // unselected item over it still selects that item.
  const hitTest = useCallback((cx: number, cy: number): HitResult => {
    const group = groupBoxRef.current;
    if (!group) return itemHitTest(cx, cy, true);
    const handle = hitTestHandles(group, cx, cy, { rotateOffset: knobOffsetFor(GROUP_CHROME_ID) });
    if (handle?.kind === "rotate") return { type: "group", handle: "rotate" };
    if (handle?.kind === "corner") return { type: "group", handle: handle.corner };
    const hit = itemHitTest(cx, cy, false);
    if (hit?.type === "overlay" && selectedClipIdsRef.current.has(hit.clipId)) return { type: "group", handle: "body" };
    if (hit?.type === "scene" && selectedSceneIdsRef.current.has(hit.sceneId)) return { type: "group", handle: "body" };
    if (hit?.type === "overlay") return hit;
    if (hitTestHandles(group, cx, cy, { handles: false })) return { type: "group", handle: "body" };
    return hit;
  }, [itemHitTest]);

  /** Edges and centres of every other visible item (snap targets besides the frame). */
  const otherItemBounds = useCallback((exceptId: string): SnapBounds[] => {
    const bounds: SnapBounds[] = [];
    overlayRectsRef.current.forEach((rect, id) => {
      if (id !== exceptId) bounds.push(boundsOfBox(boxFromRect(rect)));
    });
    for (const entry of sceneBoxesRef.current) {
      if (entry.sceneId !== exceptId) bounds.push(boundsOfBox(entry.geometry.visual));
    }
    return bounds;
  }, []);

  // ── Group gestures (phase 10c) ──
  // Every move writes ONE items.transform for all items through the controller with one coalesceKey (the store
  // updates live, ScenePreview and the compositor draw from it); the release settles it: one undo step.
  const startGroupDrag = useCallback((e: React.PointerEvent<HTMLCanvasElement>, handle: "body" | "rotate" | Corner, cx: number, cy: number) => {
    const canvas = canvasRef.current;
    const startBox = groupBoxRef.current;
    if (!canvas || !startBox) return;
    const frame = { ...mediaRectRef.current };
    const capture = collectGroupItems({
      clips: clipsRef.current, time: currentTimeRef.current, frame, visualRects: overlayRectsRef.current, baseRects: baseRectsRef.current,
      sceneBoxes: sceneBoxesRef.current, sceneRanges: sceneRangesRef.current, clipIds: selectedClipIdsRef.current, sceneIds: selectedSceneIdsRef.current,
    });
    if (capture.items.length === 0) return;
    const type = handle === "body" ? "move" : handle === "rotate" ? "rotate" : "scale";
    const center = { x: startBox.cx, y: startBox.cy };
    const clickedHit = itemHitTest(cx, cy, false);
    const others: SnapBounds[] = [];
    overlayRectsRef.current.forEach((r, id) => { if (!selectedClipIdsRef.current.has(id)) others.push(boundsOfBox(boxFromRect(r))); });
    for (const entry of sceneBoxesRef.current) if (!selectedSceneIdsRef.current.has(entry.sceneId)) others.push(boundsOfBox(entry.geometry.visual));
    const drag: GroupDragState = {
      type, startX: e.clientX, startY: e.clientY, start: { x: cx, y: cy }, frame, startBox, center, capture,
      snapTargets: type === "move" ? mergeSnapTargets(frameSnapTargets(frame), itemSnapTargets(others)) : undefined,
      startBounds: boundsOfBox(startBox),
      lastAngle: pointerAngle(center.x, center.y, cx, cy),
      turned: 0,
      gesture: `preview-transform:group:${++gestureSeqRef.current}`,
      clicked: clickedHit?.type === "overlay" ? { clipId: clickedHit.clipId } : clickedHit?.type === "scene" ? { sceneId: clickedHit.sceneId } : null,
      last: null,
    };
    canvas.setPointerCapture(e.pointerId);
    groupDragRef.current = drag;
    groupGestureRef.current = null;
    guidesRef.current = [];
    if (type === "rotate") canvas.style.cursor = "grabbing";
    dragFrameRef.current += 1;
    requestCompositorDrawRef.current();
    // Followers (selected items off the playhead, phase 10d) scale by the same factor: their scales bound it too.
    const scaleLimits = [...capture.items.map((item) => item.scale), ...(capture.followers ?? []).map((follower) => follower.scale)];

    const onPointerMove = (ev: PointerEvent) => {
      const d = groupDragRef.current;
      if (!d) return;
      const canvasRect = canvas.getBoundingClientRect();
      const mx = ev.clientX - canvasRect.left;
      const my = ev.clientY - canvasRect.top;
      let gesture: GroupGesture;
      if (d.type === "move") {
        let dx = ev.clientX - d.startX;
        let dy = ev.clientY - d.startY;
        // A click with a little pointer jitter is a click (it selects the grabbed item alone), not a move.
        if (!d.last && Math.hypot(dx, dy) < 3) return;
        let guides: SnapGuide[] = [];
        if (!(ev.ctrlKey || ev.metaKey) && d.snapTargets) {
          const snap = snapMove(translateBounds(d.startBounds, dx, dy), d.snapTargets, SNAP_THRESHOLD_PX);
          dx += snap.dx;
          dy += snap.dy;
          guides = snap.guides;
        }
        guidesRef.current = guides;
        gesture = { kind: "move", dx, dy };
      } else if (d.type === "scale") {
        const factor = clampGroupFactor(groupScaleFactor(d.center, d.start, { x: mx, y: my }), scaleLimits, MIN_TRANSFORM_SCALE, MAX_TRANSFORM_SCALE);
        gesture = { kind: "scale", center: d.center, factor };
      } else {
        const angle = pointerAngle(d.center.x, d.center.y, mx, my);
        d.turned += unwrapDelta(d.lastAngle, angle);
        d.lastAngle = angle;
        // Shift: 15° steps; otherwise a 3° magnet to 0/90/180/270.
        gesture = { kind: "rotate", center: d.center, degrees: round(snapRotation(d.turned, { shift: ev.shiftKey }).degrees, 2) };
      }
      groupGestureRef.current = gesture;
      const command = groupGestureCommand(d.capture, gesture, d.frame);
      if (command && JSON.stringify(command) !== JSON.stringify(d.last)) {
        d.last = command;
        void controller.execute(command, { coalesceKey: d.gesture, debounceMs: SCENE_LIVE_DEBOUNCE_MS });
      }
      dragFrameRef.current += 1;
      requestCompositorDrawRef.current();
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      const d = groupDragRef.current;
      groupDragRef.current = null;
      groupGestureRef.current = null;
      guidesRef.current = [];
      if (d?.type === "rotate") canvas.style.cursor = "grab";
      dragFrameRef.current += 1;
      requestCompositorDrawRef.current();
      if (!d) return;
      // Settle the coalesced live write: one backend write, one undo step.
      if (d.last) {
        void controller.execute(d.last, { coalesceKey: d.gesture, debounceMs: SCENE_SETTLE_DEBOUNCE_MS });
        return;
      }
      // A click without a change on one of the selected items selects just that item.
      if (d.clicked?.clipId) setSelectedClipIds(new Set([d.clicked.clipId]));
      else if (d.clicked?.sceneId) storeApi.getState().selectScene(d.clicked.sceneId);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }, [controller, itemHitTest, setSelectedClipIds, storeApi]);

  // ── Pointer handlers ──
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    // Keyboard nudges go to the preview once it was clicked.
    canvas.focus?.({ preventScroll: true });
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // Shift/Cmd/Ctrl+click adds the item under the pointer to the selection or removes it (phase 10c, CapCut).
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const item = itemHitTest(cx, cy, false);
      if (item?.type === "overlay") storeApi.getState().toggleItemInSelection({ clipId: item.clipId });
      else if (item?.type === "scene") storeApi.getState().toggleItemInSelection({ sceneId: item.sceneId });
      requestCompositorDrawRef.current();
      return;
    }

    // Mask editing (phase 10c): mask handles first; the rest of the item does not move while the mask is edited.
    // Motion tracking (phase 10d): the region box takes the pointer anywhere on the tracked item.
    const trackTarget = trackTargetFrom(overlayRectsRef.current, sceneBoxesRef.current);
    if (trackTarget) {
      const trackHit = hitTestTrackRegion(trackTarget.geometry, cx, cy);
      if (trackHit) {
        startTrackRegionDrag(e, canvas, trackTarget.geometry, trackHit, { x: cx, y: cy });
        return;
      }
    }
    const maskTarget = maskTargetFrom(overlayRectsRef.current, sceneBoxesRef.current);
    if (maskTarget) {
      const kind = hitTestMask(maskTarget.geometry, cx, cy);
      if (kind) {
        startMaskDrag(e, canvas, maskTarget, kind, { x: cx, y: cy });
        return;
      }
      if (hitTestHandles(maskTarget.geometry.item, cx, cy, { handles: false })) return;
    }

    const hit = hitTest(cx, cy);

    if (!hit) {
      selectedClipIdRef.current = null;
      selectedSceneIdRef.current = null;
      setSelectedClipIds(new Set());
      return;
    }
    if (hit.type === "group") {
      startGroupDrag(e, hit.handle, cx, cy);
      return;
    }

    const frame = { ...mediaRectRef.current };
    const time = currentTimeRef.current;
    let drag: DragState;

    if (hit.type === "scene") {
      const entry = sceneBoxesRef.current.find((b) => b.sceneId === hit.sceneId);
      if (!entry) return;
      selectedClipIdRef.current = null;
      selectedSceneIdRef.current = hit.sceneId;
      storeApi.getState().selectScene(hit.sceneId);
      const { visual, baseValues, animOffset } = entry.geometry;
      drag = {
        type: hit.handle === "body" ? "move" : hit.handle === "rotate" ? "rotate" : "resize",
        target: "scene",
        id: hit.sceneId,
        remotion: false,
        startX: e.clientX,
        startY: e.clientY,
        origPosX: baseValues.offsetX,
        origPosY: baseValues.offsetY,
        origScale: baseValues.scale,
        origRotation: baseValues.rotation,
        corner: typeof hit.handle === "number" ? hit.handle : undefined,
        frame,
        startBox: visual,
        startBounds: boundsOfBox(visual),
        animOffsetX: animOffset.x,
        animOffsetY: animOffset.y,
        gesture: `preview-transform:scene:${hit.sceneId}:${++gestureSeqRef.current}`,
      };
    } else {
      const clip = clipsRef.current.find((c) => c.id === hit.clipId);
      if (!clip) return;
      selectedClipIdRef.current = hit.clipId;
      selectedSceneIdRef.current = null;
      setSelectedClipIds(new Set([hit.clipId]));
      const remotion = clip.trackType === "remotion";
      // Baseline from the BASE values at the playhead (keyframes or static fields, no animation): a keyframed
      // clip's static positionX/scale can be far from what's on screen, and the drag edits the base while the
      // animation stays on top.
      const baseAtDown = clipBaseAt(clip, time - clip.startTime);
      // The visual box (what the pointer grabbed): its anchor size maps pointer pixels to position
      // fractions exactly; it is the resize anchor and the rotation pivot.
      const visualRect = overlayRectsRef.current.get(hit.clipId);
      const layerRect = remotion ? (remotionLayerRectsRef.current.get(hit.clipId) ?? visualRect) : visualRect;
      const startBox = visualRect ? boxFromRect(visualRect) : undefined;
      const anchorW = visualRect ? (visualRect.anchorW ?? visualRect.w) : undefined;
      const anchorH = visualRect ? (visualRect.anchorH ?? visualRect.h) : undefined;
      // Animation dx/dy (visual centre minus where the base position anchors the box).
      const animOffsetX = startBox && anchorW !== undefined && !remotion
        ? startBox.cx - (frame.x + baseAtDown.posX * Math.max(0, frame.w - anchorW) + anchorW / 2)
        : 0;
      const animOffsetY = startBox && anchorH !== undefined && !remotion
        ? startBox.cy - (frame.y + baseAtDown.posY * Math.max(0, frame.h - anchorH) + anchorH / 2)
        : 0;
      drag = {
        type: hit.type === "resize" ? "resize" : hit.type === "rotate" ? "rotate" : "move",
        target: "clip",
        id: hit.clipId,
        remotion,
        startX: e.clientX,
        startY: e.clientY,
        origPosX: baseAtDown.posX,
        origPosY: baseAtDown.posY,
        origScale: baseAtDown.scale,
        origRotation: baseAtDown.rotation,
        corner: hit.type === "resize" ? hit.corner : undefined,
        frame,
        startBox,
        startBounds: startBox ? boundsOfBox(startBox) : undefined,
        anchorW,
        anchorH,
        animOffsetX,
        animOffsetY,
        gesture: `preview-transform:clip:${hit.clipId}:${++gestureSeqRef.current}`,
        ...(remotion && layerRect ? (() => {
          // Graphics scale their full-frame layer about its centre (getRemotionLayerTransform).
          const c = { x: layerRect.x + layerRect.w / 2, y: layerRect.y + layerRect.h / 2 };
          return { centerX: c.x, centerY: c.y, origDist: Math.hypot(cx - c.x, cy - c.y) };
        })() : {}),
      };
      overrideClipIdRef.current = hit.clipId;
      overrideRef.current = null;
    }
    if (drag.type === "move") {
      drag.snapTargets = mergeSnapTargets(frameSnapTargets(frame), itemSnapTargets(otherItemBounds(drag.id)));
    }
    if (drag.type === "rotate" && drag.startBox) {
      // Graphics turn about their layer's centre (the CSS transform origin), other items about their box centre.
      if (drag.remotion && drag.centerX !== undefined && drag.centerY !== undefined) drag.startBox = { ...drag.startBox, cx: drag.centerX, cy: drag.centerY };
      drag.lastAngle = pointerAngle(drag.startBox.cx, drag.startBox.cy, cx, cy);
      drag.turned = 0;
    }
    canvas.setPointerCapture(e.pointerId);
    dragRef.current = drag;
    guidesRef.current = [];
    sceneGestureRef.current = null;
    if (drag.type === "rotate") canvas.style.cursor = "grabbing";
    dragFrameRef.current += 1;
    requestCompositorDrawRef.current();

    const isRemotionDrag = drag.remotion;
    const publishRemotionOverride = () => {
      if (!isRemotionDrag) return;
      const override = overrideRef.current;
      setRemotionOverride({
        clipId: drag.id,
        positionX: override?.posX,
        positionY: override?.posY,
        scale: override?.scale,
        rotation: override?.rotation,
      });
    };

    const onPointerMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const fr = d.frame;
      const canvasRect = canvas.getBoundingClientRect();
      const mx = ev.clientX - canvasRect.left;
      const my = ev.clientY - canvasRect.top;
      let clipOverride: DragOverride | null = null;
      let sceneOverride: SceneOverride | null = null;

      if (d.type === "move") {
        let dx = ev.clientX - d.startX;
        let dy = ev.clientY - d.startY;
        // Snapping (Ctrl/Cmd held: free): the box centre to centre lines, its edges to edges.
        let guides: SnapGuide[] = [];
        if (!(ev.ctrlKey || ev.metaKey) && d.startBounds && d.snapTargets) {
          const snap = snapMove(translateBounds(d.startBounds, dx, dy), d.snapTargets, SNAP_THRESHOLD_PX);
          dx += snap.dx;
          dy += snap.dy;
          guides = snap.guides;
        }
        guidesRef.current = guides;
        if (d.target === "scene") {
          sceneOverride = {
            offsetX: round(clampNumber(d.origPosX + (fr.w > 0 ? (dx / fr.w) * 100 : 0), -MAX_SCENE_OFFSET, MAX_SCENE_OFFSET), 4),
            offsetY: round(clampNumber(d.origPosY + (fr.h > 0 ? (dy / fr.h) * 100 : 0), -MAX_SCENE_OFFSET, MAX_SCENE_OFFSET), 4),
          };
        } else if (d.remotion) {
          // Graphics translate across the WHOLE frame (getRemotionLayerTransform).
          clipOverride = {
            posX: clampNumber(d.origPosX + (fr.w > 0 ? dx / fr.w : 0), 0, 1),
            posY: clampNumber(d.origPosY + (fr.h > 0 ? dy / fr.h : 0), 0, 1),
          };
        } else {
          // Positions are fractions of the REMAINING space (frame minus the box), as the export anchors
          // them; the centre may reach the frame edges (CapCut lets items hang half off-frame). A box that
          // covers an axis is pinned there by the placement: that axis does not move.
          const axis = (orig: number, delta: number, size: number, anchor: number | undefined) => {
            const box = anchor ?? 0;
            const span = size - box;
            if (!(span > 0.5)) return orig;
            return clampNumber(orig + delta / span, -box / 2 / span, (size - box / 2) / span);
          };
          clipOverride = { posX: axis(d.origPosX, dx, fr.w, d.anchorW), posY: axis(d.origPosY, dy, fr.h, d.anchorH) };
        }
      } else if (d.type === "rotate") {
        if (!d.startBox || d.lastAngle === undefined) return;
        const angle = pointerAngle(d.startBox.cx, d.startBox.cy, mx, my);
        d.turned = (d.turned ?? 0) + unwrapDelta(d.lastAngle, angle);
        d.lastAngle = angle;
        // Shift: 15° steps; otherwise a 3° magnet to 0/90/180/270.
        const rotation = round(snapRotation(d.origRotation + d.turned, { shift: ev.shiftKey }).degrees, 2);
        if (d.target === "scene") sceneOverride = { rotation };
        else clipOverride = { rotation };
      } else if (d.remotion) {
        // Graphics: scale from the pointer distance to the layer centre at pointer-down.
        if (d.centerX === undefined || d.centerY === undefined || d.origDist === undefined) return;
        const factor = d.origDist > 5 ? Math.hypot(mx - d.centerX, my - d.centerY) / d.origDist : 1;
        clipOverride = { scale: clampNumber(d.origScale * factor, MIN_TRANSFORM_SCALE, MAX_TRANSFORM_SCALE) };
      } else {
        // Corner scale: uniform, the opposite corner fixed (Alt/Option: about the centre).
        if (!d.startBox || d.corner === undefined || !(d.origScale > 0)) return;
        const scaled = anchoredCornerScale({
          box: d.startBox,
          corner: d.corner,
          pointer: { x: mx, y: my },
          aboutCenter: ev.altKey,
          minFactor: MIN_TRANSFORM_SCALE / d.origScale,
          maxFactor: MAX_TRANSFORM_SCALE / d.origScale,
        });
        const scale = d.origScale * scaled.factor;
        if (d.target === "scene") {
          const offsets = ev.altKey ? null : sceneOffsetForCentre(fr, { x: scaled.cx, y: scaled.cy }, { x: d.animOffsetX, y: d.animOffsetY });
          sceneOverride = {
            scale: round(scale, 4),
            ...(offsets ? { offsetX: round(offsets.offsetX, 4), offsetY: round(offsets.offsetY, 4) } : {}),
          };
        } else {
          // The position that puts the new box's centre where the anchor wants it (export placement inverted);
          // an axis the box covers stays pinned (the placement ignores the position there).
          const aw = (d.anchorW ?? d.startBox.w) * scaled.factor;
          const ah = (d.anchorH ?? d.startBox.h) * scaled.factor;
          clipOverride = {
            scale,
            posX: solveAnchoredPosition(fr.x, fr.w, aw, scaled.cx, d.animOffsetX) ?? d.origPosX,
            posY: solveAnchoredPosition(fr.y, fr.h, ah, scaled.cy, d.animOffsetY) ?? d.origPosY,
          };
        }
      }

      if (d.target === "scene") {
        if (!sceneOverride) return;
        const last = sceneGestureRef.current;
        if (last && JSON.stringify(last) === JSON.stringify(sceneOverride)) return;
        sceneGestureRef.current = sceneOverride;
        // Live: optimistic store write now, one backend write + one undo entry when the gesture settles.
        void commitSceneRef.current(d.id, sceneOverride, { coalesceKey: d.gesture, debounceMs: SCENE_LIVE_DEBOUNCE_MS });
      } else {
        overrideRef.current = clipOverride;
        publishRemotionOverride();
      }
      dragFrameRef.current += 1;
      requestCompositorDrawRef.current();
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      const d = dragRef.current;
      dragRef.current = null;
      guidesRef.current = [];
      if (d?.type === "rotate") canvas.style.cursor = "grab";
      dragFrameRef.current += 1;
      requestCompositorDrawRef.current();
      if (!d) return;

      if (d.target === "scene") {
        const last = sceneGestureRef.current;
        sceneGestureRef.current = null;
        // Settle the coalesced live write: one backend write, one undo step.
        if (last) void commitSceneRef.current(d.id, last, { coalesceKey: d.gesture, debounceMs: SCENE_SETTLE_DEBOUNCE_MS });
        return;
      }
      const override = overrideRef.current;
      // DON'T clear overrideRef/overrideClipIdRef here —
      // they stay active until optimistic clip data arrives (prevents snap-back)
      if (!override) return;
      // Keyframed channels key the playhead (keyframe.set), static ones update the fields (clip.update);
      // one command with history, so the drag is one undo step. A failed write drops the override.
      void commitDragRef.current(d.id, override).then((ok) => {
        if (ok || overrideRef.current !== override) return;
        overrideClipIdRef.current = null;
        overrideRef.current = null;
        if (isRemotionDrag) setRemotionOverride(null);
        dragFrameRef.current += 1;
        requestCompositorDrawRef.current();
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }, [hitTest, itemHitTest, otherItemBounds, setSelectedClipIds, startGroupDrag, storeApi, maskTargetFrom, trackTargetFrom]);

  /**
   * A mask handle drag: every move writes `mask.set` with the dragged fields (a keyed channel keys the playhead)
   * under one coalesce key (optimistic store update, so the preview follows live); the release settles it into
   * one backend write and one undo step, as scene gestures do.
   */
  function startMaskDrag(
    e: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement,
    target: { owner: { clipId: string } | { sceneId: string }; geometry: MaskScreenGeometry; start: MaskDragStart["mask"] },
    kind: MaskHandleKind, pointer: { x: number; y: number },
  ) {
    maskDragEndRef.current?.();
    const start: MaskDragStart = { item: target.geometry.item, mask: target.start, kind, pointer };
    const gesture = `preview-mask:${"clipId" in target.owner ? target.owner.clipId : target.owner.sceneId}:${++gestureSeqRef.current}`;
    const state = { owner: target.owner, gesture, last: null as MaskPatch | null };
    maskDragRef.current = state;
    canvas.setPointerCapture(e.pointerId);
    if (kind === "rotate") canvas.style.cursor = "grabbing";
    const send = (patch: MaskPatch, debounceMs: number) => void controller.execute(
      { type: "mask.set", ...state.owner, mask: patch },
      { coalesceKey: gesture, debounceMs },
    );
    const onMove = (ev: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      const patch = maskDragPatch(start, { x: ev.clientX - box.left, y: ev.clientY - box.top }, { shift: ev.shiftKey });
      if (state.last && JSON.stringify(state.last) === JSON.stringify(patch)) return;
      state.last = patch;
      send(patch, SCENE_LIVE_DEBOUNCE_MS);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (maskDragEndRef.current === onUp) maskDragEndRef.current = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (kind === "rotate") canvas.style.cursor = "grab";
      if (maskDragRef.current === state) maskDragRef.current = null;
      // Settle the coalesced live write: one backend write, one undo step (also on unmount mid-drag).
      if (state.last) send(state.last, SCENE_SETTLE_DEBOUNCE_MS);
      requestCompositorDrawRef.current();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    maskDragEndRef.current = onUp;
  }

  // ── Keyboard nudge ──
  // Arrows move the selected clip or scene 1 px (Shift: 10 px) while the preview has focus; a burst of
  // nudges coalesces into one undo step. Delete stays with the editor's shortcuts.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const dir = e.key === "ArrowLeft" ? [-1, 0] : e.key === "ArrowRight" ? [1, 0] : e.key === "ArrowUp" ? [0, -1] : e.key === "ArrowDown" ? [0, 1] : null;
    if (!dir || e.altKey || e.ctrlKey || e.metaKey || dragRef.current || editingRef.current) return;
    const step = e.shiftKey ? 10 : 1;
    const frame = mediaRectRef.current;
    const state = storeApi.getState();
    // A group selection nudges every selected item (phase 10c; items off the playhead follow, 10d), one undo step per burst.
    if (groupBoxRef.current) {
      const capture = collectGroupItems({
        clips: clipsRef.current, time: state.currentTime, frame, visualRects: overlayRectsRef.current, baseRects: baseRectsRef.current,
        sceneBoxes: sceneBoxesRef.current, sceneRanges: sceneRangesRef.current, clipIds: state.selectedClipIds, sceneIds: state.selectedSceneIds,
      });
      const command = groupGestureCommand(capture, { kind: "move", dx: dir[0] * step, dy: dir[1] * step }, frame);
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      void controller.execute(command, { coalesceKey: "preview-nudge:group", debounceMs: NUDGE_DEBOUNCE_MS });
      return;
    }
    const clipId = state.selectedClipId;
    if (clipId) {
      const clip = state.timelineData?.clips.find((c) => c.id === clipId);
      const rect = overlayRectsRef.current.get(clipId);
      if (!clip || !rect) return;
      e.preventDefault();
      e.stopPropagation();
      const base = clipBaseAt(clip, state.currentTime - clip.startTime);
      const override: DragOverride = {};
      if (clip.trackType === "remotion") {
        if (dir[0] && frame.w > 0) override.posX = clampNumber(base.posX + (dir[0] * step) / frame.w, 0, 1);
        if (dir[1] && frame.h > 0) override.posY = clampNumber(base.posY + (dir[1] * step) / frame.h, 0, 1);
      } else {
        const spanW = frame.w - (rect.anchorW ?? rect.w);
        const spanH = frame.h - (rect.anchorH ?? rect.h);
        if (dir[0] && spanW > 0.5) override.posX = base.posX + (dir[0] * step) / spanW;
        if (dir[1] && spanH > 0.5) override.posY = base.posY + (dir[1] * step) / spanH;
      }
      if (override.posX === undefined && override.posY === undefined) return;
      // The store moves now (optimistic); a lingering drag override must not mask it.
      if (overrideClipIdRef.current === clipId) {
        overrideClipIdRef.current = null;
        overrideRef.current = null;
      }
      void commitDragRef.current(clipId, override, { coalesceKey: `preview-nudge:clip:${clipId}`, debounceMs: NUDGE_DEBOUNCE_MS });
      return;
    }
    const sceneId = sceneChromeIdRef.current;
    if (!sceneId) return;
    const range = sceneRangesRef.current.find((r) => r.scene.id === sceneId);
    if (!range) return;
    e.preventDefault();
    e.stopPropagation();
    const base = sceneBaseAt(range.scene, state.currentTime - range.start);
    const override: SceneOverride = {};
    if (dir[0] && frame.w > 0) override.offsetX = round(base.offsetX + ((dir[0] * step) / frame.w) * 100, 4);
    if (dir[1] && frame.h > 0) override.offsetY = round(base.offsetY + ((dir[1] * step) / frame.h) * 100, 4);
    void commitSceneRef.current(sceneId, override, { coalesceKey: `preview-nudge:scene:${sceneId}`, debounceMs: NUDGE_DEBOUNCE_MS });
  }, [controller, storeApi]);

  // ── Inline text editing ──
  const commitEdit = useCallback(() => {
    const prev = editingRef.current;
    if (!prev) return;
    setEditing(null);
    if (prev.mode === "sticker") {
      const nextUrl = prev.text.trim();
      if (nextUrl && nextUrl !== prev.originalText.trim()) {
        onUpdateClipRef.current?.(prev.clipId, { mediaUrl: nextUrl });
      }
    } else {
      if (prev.text !== prev.originalText) {
        onUpdateClipRef.current?.(prev.clipId, { textContent: prev.text });
      }
    }
  }, []);

  const cancelEdit = useCallback(() => setEditing(null), []);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const time = currentTimeRef.current;
    const clips = clipsRef.current;
    const visible = clips.filter(
      (c) => (c.trackType === "text" || c.trackType === "sticker") && time >= c.startTime && time < c.endTime
    );

    for (let i = visible.length - 1; i >= 0; i--) {
      const clip = visible[i];
      const clipRect = overlayRectsRef.current.get(clip.id);
      if (!clipRect) continue;
      if (hitTestHandles(boxFromRect(clipRect), cx, cy, { handles: false })) {
        setSelectedClipIds(new Set([clip.id]));

        if (clip.trackType === "sticker") {
          setEditing({
            clipId: clip.id,
            mode: "sticker",
            text: clip.mediaUrl || "",
            originalText: clip.mediaUrl || "",
            rect: { ...clipRect },
          });
        } else {
          const style = parseTextStyle(clip.textStyle || null);
          // Match the canvas draw: export-authored px × effective (keyframed)
          // scale × preview frame scale — clip.scale alone rendered the
          // textarea at export size, huge next to the drawn text.
          const editScale = clipMotionAt(clip, time - clip.startTime).scale;
          const projectRatio = parseAspectRatio(aspectRatio);
          const exportRefH = (projectRatio > 1 ? 1920 : 1080) / projectRatio;
          const mrNow = mediaRectRef.current;
          const editFrameScale = mrNow.h > 0 && exportRefH > 0 ? mrNow.h / exportRefH : 1;
          setEditing({
            clipId: clip.id,
            mode: "text",
            text: clip.textContent || "",
            originalText: clip.textContent || "",
            rect: { ...clipRect },
            fontSize: style.fontSize * editScale * editFrameScale,
            color: style.color,
            fontFamily: style.fontFamily,
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            textDecoration: style.textDecoration,
            textAlign: style.textAlign,
            bgColor: style.bgColor,
          });
        }

        setTimeout(() => {
          const el = editInputRef.current;
          if (el) { el.focus(); el.select(); }
        }, 0);
        return;
      }
    }
  }, [aspectRatio, setSelectedClipIds]);

  // Cursor on hover
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current || maskDragRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const trackTarget = trackTargetFrom(overlayRectsRef.current, sceneBoxesRef.current);
    if (trackTarget) {
      const trackHit = hitTestTrackRegion(trackTarget.geometry, e.clientX - rect.left, e.clientY - rect.top);
      if (trackHit) {
        canvas.style.cursor = trackHit.kind === "move" ? "move" : trackHit.kind === "draw" ? "crosshair" : cornerCursor(trackHit.corner, trackTarget.geometry.frame);
        return;
      }
    }
    const maskTarget = maskTargetFrom(overlayRectsRef.current, sceneBoxesRef.current);
    if (maskTarget) {
      const kind = hitTestMask(maskTarget.geometry, e.clientX - rect.left, e.clientY - rect.top);
      if (kind) {
        canvas.style.cursor = MASK_CURSORS[kind];
        return;
      }
    }
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    const selectedBox = (): HandleBox | null => {
      const clipRect = hit?.type === "resize" ? overlayRectsRef.current.get(hit.clipId) : undefined;
      if (clipRect) return boxFromRect(clipRect);
      const entry = hit?.type === "scene" ? sceneBoxesRef.current.find((b) => b.sceneId === hit.sceneId) : undefined;
      return entry ? entry.geometry.visual : null;
    };
    if (hit?.type === "group") {
      const group = groupBoxRef.current;
      canvas.style.cursor = hit.handle === "rotate" ? "grab" : hit.handle === "body" ? "move" : group ? cornerCursor(hit.handle, group) : "nwse-resize";
      return;
    }
    if (hit?.type === "rotate" || (hit?.type === "scene" && hit.handle === "rotate")) canvas.style.cursor = "grab";
    else if (hit?.type === "resize" || (hit?.type === "scene" && typeof hit.handle === "number")) {
      const corner = hit.type === "resize" ? hit.corner : (hit.handle as Corner);
      const box = selectedBox();
      canvas.style.cursor = box ? cornerCursor(corner, box) : "nwse-resize";
    } else if (hit?.type === "overlay" || hit?.type === "scene") canvas.style.cursor = "move";
    else canvas.style.cursor = "default";
  }, [hitTest, maskTargetFrom, trackTargetFrom]);

  return (
    <div ref={rootRef} className="flex flex-col h-full bg-[#0A0A0B]">
      {/* Header */}
      <div className="flex items-center px-3 py-1.5 border-b border-[rgba(255,255,255,0.06)] shrink-0">
        <span className="text-[11px] font-semibold text-[#A0A0A8] uppercase tracking-wider">{t("preview")}</span>
        {selectedScene && (
          <span className="text-[10px] text-[#555] tabular-nums ml-2">{t("sceneN", { n: selectedScene.order + 1 })}</span>
        )}
        {aspectRatio && (
          <span className="text-[9px] text-[#444] ml-auto">{aspectRatio}</span>
        )}
      </div>

      {/* Preview area */}
      <div
        ref={containerRef}
        data-testid="preview-drop-area"
        className="flex-1 min-h-0 relative bg-black"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* ScenePreview stays visible under transparent overlay canvas so text mode does not restyle video playback. */}
        <div className="absolute inset-0" style={{ zIndex: needsCanvas ? 0 : 2, opacity: 1, pointerEvents: capturePointer ? "none" : "auto" }}>
          <ScenePreview
            ref={scenePreviewRef}
            suppressEffectLayer={suppressSceneEffectLayer}
            canvasGraphics={needsCanvas}
            scene={selectedScene}
            scenes={scenes}
            musicUrl={musicUrl}
             onSceneChange={onSceneChange}
             timelineClips={filteredTimelineClips}
             timelineTracks={timelineTracks}
             projectAspectRatio={aspectRatio}
            onUpdateSceneTransform={onUpdateSceneTransform}
            remotionTransformOverride={remotionOverride}
          />
        </div>

        <PreviewStateBadge isBackendSyncing={isBackendSyncing} />

        {/* Canvas: composites V2+ media, built-in graphics, text/stickers and effect layers, plus selection handles (hidden when none) */}
        <canvas
          ref={canvasRef}
          data-preview-canvas
          tabIndex={0}
          aria-label={t("preview")}
          className="absolute inset-0 w-full h-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--on-ring)]"
          style={{ zIndex: 2, display: "block", opacity: capturePointer ? 1 : 0, pointerEvents: capturePointer ? "auto" : "none", touchAction: "none" }}
          onPointerDown={handlePointerDown}
          onKeyDown={handleKeyDown}
          onMouseMove={handleMouseMove}
          onDoubleClick={handleDoubleClick}
        />

        {/* Drop highlight over the project frame while a sticker or text template card is dragged over it */}
        {dropFrame && (
          <div
            data-testid="preview-drop-highlight"
            aria-hidden="true"
            className="pointer-events-none absolute"
            style={{
              left: dropFrame.x,
              top: dropFrame.y,
              width: dropFrame.w,
              height: dropFrame.h,
              zIndex: 4,
              background: "var(--on-fill-subtle)",
              boxShadow: "inset 0 0 0 2px var(--on-ring)",
            }}
          />
        )}

        {/* Inline editor — text clip: textarea over clip; sticker: URL input at top of clip */}
        {editing && editing.mode === "text" && (
          <textarea
            ref={editInputRef as React.RefObject<HTMLTextAreaElement>}
            value={editing.text}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setEditing((prev) => prev ? { ...prev, text: e.target.value } : null)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); }
              if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
            }}
            style={{
              position: "absolute",
              left: editing.rect.x,
              top: editing.rect.y,
              width: Math.max(editing.rect.w, 80),
              minWidth: Math.max(editing.rect.w, 60),
              minHeight: editing.rect.h,
              zIndex: 10,
              background: editing.bgColor || "rgba(0,0,0,0.55)",
              color: editing.color,
              fontSize: editing.fontSize,
              fontFamily: editing.fontFamily,
              fontWeight: editing.fontWeight,
              fontStyle: editing.fontStyle,
              textDecoration: editing.textDecoration,
              textAlign: editing.textAlign,
              border: "1.5px solid rgba(255,255,255,0.85)",
              borderRadius: 3,
              padding: "4px 8px",
              outline: "none",
              resize: "none",
              overflow: "auto",
              lineHeight: 1.3,
              boxSizing: "border-box",
            }}
          />
        )}
        {editing && editing.mode === "sticker" && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: Math.max(4, editing.rect.x),
              top: Math.max(4, editing.rect.y - 36),
              zIndex: 10,
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(20,20,24,0.95)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              padding: "4px 6px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
            }}
          >
            <span style={{ fontSize: 10, color: "#888", whiteSpace: "nowrap" }}>{t("imageUrl")}</span>
            <input
              ref={editInputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={editing.text}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setEditing((prev) => prev ? { ...prev, text: e.target.value } : null)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
                if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
              }}
              placeholder="https://..."
              style={{
                width: 220,
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontSize: 11,
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 4,
                padding: "3px 6px",
                outline: "none",
              }}
            />
          </div>
        )}
      </div>

      <PreviewPlaybackControls
        totalDuration={previewDuration}
        aspectRatio={aspectRatio}
        onAspectRatioChange={onAspectRatioChange}
        fullscreenTargetRef={rootRef}
      />
    </div>
  );
}

// Memoized so editor-layout re-renders (e.g. selection / panel toggles) that
// don't change this panel's props skip re-rendering the preview compositor.
export const PreviewPanel = React.memo(PreviewPanelImpl);
