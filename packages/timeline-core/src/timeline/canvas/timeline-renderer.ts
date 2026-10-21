// Renders the canvas timeline, including live drag, snap, and ripple previews.
import { sceneTimelineSeconds } from "../scene-duration";
import type { CanvasState, DragState, TrackLayoutEntry, WaveformData, SceneData } from "./types";
import type { TimelineClip } from "../../model/timeline";
import { COLORS, applyTimelineTheme, getClipColors, getTickInterval, type TimelineTheme } from "./colors";
import { parseCachedShotBreakdown, totalShotDuration, shotVisualDuration, shotDurationSeconds } from "../../lib/shot-utils";
import { TIMELINE_TRACK_HEIGHT_COMPACT, TIMELINE_TRACK_HEIGHT_VIDEO } from "../nle-timeline-layout";
import { getTransitionMarkers, getSceneTransitionMarkers, TRANSITION_MARKER_SIZE } from "./transition-markers";
import { getSceneTimelineStart, hasExplicitSceneTimelinePositions } from "./scene-position";
import { getCachedClipKeyframeTimes, parseCachedSceneCardConfig, parseCachedTextStyle } from "./timeline-json-cache";
import { clipCacheKey, getCachedClipBitmap, renderClipToCache } from "./clip-render-cache";
import { getTimelineTextClipKind } from "../../lib/timeline-text-style";
import { clipBeatTimes } from "../../analysis/beat-plan";

const RULER_HEIGHT = 20;
const TRACK_HEIGHT = TIMELINE_TRACK_HEIGHT_VIDEO;
const TRACK_HEIGHT_SMALL = TIMELINE_TRACK_HEIGHT_COMPACT;
// Edge grab zone (px). Wide enough to grab without pixel-hunting — the drawn
// bracket handles match this width so what you see is what you can grab.
const RESIZE_ZONE = 10;

// Transition marker (bowtie on the cut) — dark glass tile. The live values
// come from COLORS (themeable via --timeline-transition-* CSS tokens); these
// exports are the defaults, kept for the render tests.
export const TRANSITION_MARKER_BG = COLORS.transitionBg;
export const TRANSITION_MARKER_BG_SELECTED = COLORS.transitionBgSelected;
const TRANSITION_MARKER_GLYPH = "#FFFFFF";
const TRANSITION_MARKER_GLYPH_SELECTED = "#FFFFFF";

// ── Video filmstrip planning ───────────────────────────────
// CapCut-style frame strip for video/sticker clips. The renderer and the
// canvas media-request loop both call this so the requested frame times match
// exactly the times the renderer reads back from the thumbnail cache (the cache
// keys frames by url + time.toFixed(2)).
const VIDEO_FILMSTRIP_SLICE_PX = 80;
const VIDEO_FILMSTRIP_MAX_SLICES = 10;
const VIDEO_URL_RE = /\.(mp4|mov|m4v|webm|mkv|avi)([?#]|$)/i;

type FilmstripClip = Pick<
  TimelineClip,
  "trackType" | "mediaType" | "mediaUrl" | "thumbnailUrl" | "startTime" | "endTime" | "trimStart" | "trimEnd" | "playbackSpeed"
>;

export interface ClipFilmstripPlan {
  url: string;
  isVideo: boolean;
  /** Source-video times (seconds), left→right across the clip. */
  times: number[];
}

export function planClipFilmstrip(clip: FilmstripClip, widthPx: number): ClipFilmstripPlan | null {
  if (clip.trackType !== "video" && clip.trackType !== "sticker") return null;
  const url = clip.mediaUrl || clip.thumbnailUrl;
  if (!url) return null;

  const isVideo = clip.mediaType === "video" || VIDEO_URL_RE.test(url);
  if (!isVideo) {
    const imageUrl = clip.thumbnailUrl || clip.mediaUrl;
    return imageUrl ? { url: imageUrl, isVideo: false, times: [0] } : null;
  }

  const clipDur = Math.max(0.1, clip.endTime - clip.startTime);
  const speed = Number.isFinite(clip.playbackSpeed) && clip.playbackSpeed > 0 ? clip.playbackSpeed : 1;
  const trimStart = clip.trimStart;
  const trimEnd = clip.trimEnd;
  const srcStart = Number.isFinite(trimStart as number) ? Math.max(0, trimStart as number) : 0;
  const srcEnd =
    Number.isFinite(trimEnd as number) && (trimEnd as number) > srcStart
      ? (trimEnd as number)
      : srcStart + clipDur * speed;
  const span = Math.max(0.1, srcEnd - srcStart);
  const count = Math.max(1, Math.min(VIDEO_FILMSTRIP_MAX_SLICES, Math.ceil(widthPx / VIDEO_FILMSTRIP_SLICE_PX)));

  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    times.push(Math.round((srcStart + span * ((i + 0.5) / count)) * 100) / 100);
  }
  return { url, isVideo: true, times };
}

// ── Helpers ────────────────────────────────────────────────

function timeToSeconds(t: string): number {
  const clean = t.replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3)
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  return 0;
}

function getTimelineTrimDuration(scene: SceneData): number | null {
  const config = parseSceneCardConfig(scene);
  const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
  const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
  if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd)) return null;
  if (trimEnd <= trimStart) return null;
  return trimEnd - trimStart;
}

// Memoize derived scene timing by object identity. These run many times per
// canvas redraw (and getSceneStart is O(n) per call → O(n^2) per frame).
// Scenes are recreated immutably on edits, so identity-keyed caches stay
// correct and old entries are GC'd automatically.
const sceneDurationCache = new WeakMap<SceneData, number>();
const sceneStartCache = new WeakMap<SceneData[], Map<number, number>>();

function getSceneDuration(scene: SceneData): number {
  const cached = sceneDurationCache.get(scene);
  if (cached !== undefined) return cached;
  const value = computeSceneDuration(scene);
  sceneDurationCache.set(scene, value);
  return value;
}

function computeSceneDuration(scene: SceneData): number {
  return sceneTimelineSeconds(scene, computeSceneSourceDuration(scene));
}

function computeSceneSourceDuration(scene: SceneData): number {
  const trimDuration = getTimelineTrimDuration(scene);
  if (trimDuration !== null) return trimDuration;

  // Prefer the LONGER of (DB metadata, sum-of-shots) when the scene has a
  // stitched video. The auto-stitch path can write a truncated
  // `scene.duration` (only counts shots that have video_url), so the sum is
  // a recovery floor that lets the timeline clip span the full mp4 even
  // when the DB metadata is stale.
  let shotSum = 0;
  if (scene.shotBreakdown && scene.shotBreakdown !== "[]") {
    const shots = parseCachedShotBreakdown(scene.shotBreakdown);
    if (shots.length > 0) {
      shotSum = totalShotDuration(shots);
    }
  }
  if (scene.cardType === "copy_video" && shotSum > 0) return shotSum;
  if (scene.videoUrl && scene.duration && scene.duration > 0) {
    return shotSum > scene.duration ? shotSum : scene.duration;
  }
  if (shotSum > 0) return shotSum;
  return scene.duration || (timeToSeconds(scene.endTime) - timeToSeconds(scene.startTime)) || 5;
}

/** Trim-in point (seconds into the scene's content) currently applied on the timeline. */
export function getSceneTrimStart(scene: SceneData): number {
  const config = parseSceneCardConfig(scene);
  const value = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** True when the scene strip plays fixed media. A generated (ai_video) scene
 *  with a stitched videoUrl is fixed footage too — stretching it past the real
 *  video just froze the last frame, so every scene playing video clamps. */
export function isContentBackedScene(scene: SceneData): boolean {
  return scene.cardType === "copy_video" || scene.cardType === "source_clip" || Boolean(scene.sourceVideoUrl) || Boolean(scene.videoUrl);
}

/** Total CONTENT length behind a scene strip, ignoring any timeline trim.
 *  Resize clamps against this so a source-backed scene can never be dragged
 *  longer than the media it plays. Returns Infinity when unknown. */
export function getSceneContentDuration(scene: SceneData): number {
  const config = parseSceneCardConfig(scene);
  const stored = Number(config.timelineSourceDuration);
  let shotSum = 0;
  if (scene.shotBreakdown && scene.shotBreakdown !== "[]") {
    const shots = parseCachedShotBreakdown(scene.shotBreakdown);
    if (shots.length > 0) shotSum = totalShotDuration(shots);
  }
  // The stored source length is the truth when present; shot sums get
  // rewritten by duration retimes, so using max() lets a shrink poison the
  // bound and block re-expansion.
  const storedKnown = Number.isFinite(stored) && stored > 0 ? stored : 0;
  const known = storedKnown > 0 ? storedKnown : shotSum;
  if (known > 0) return known;
  // No shots and no stored source length. If the scene has never been
  // trimmed, its duration IS the content length; once trimmed we can no
  // longer infer the source length, so don't clamp.
  const trimmed = getTimelineTrimDuration(scene);
  if (trimmed === null && scene.videoUrl && scene.duration && scene.duration > 0) return scene.duration;
  return Number.POSITIVE_INFINITY;
}

/** Clamp bounds for a scene-strip edge resize. Content-backed scenes cannot
 *  grow past their media (that just froze/looped the last frame and silently
 *  corrupted the project duration); generative scenes stay unclamped since
 *  their shots are retimed proportionally on save. */
export function getSceneResizeBounds(scene: SceneData, origStart: number): { maxDuration: number; minStart: number } {
  const trimStart = getSceneTrimStart(scene);
  if (!isContentBackedScene(scene)) {
    return { maxDuration: Number.POSITIVE_INFINITY, minStart: 0 };
  }
  const content = getSceneContentDuration(scene);
  return {
    maxDuration: Number.isFinite(content) ? Math.max(0.5, content - trimStart) : Number.POSITIVE_INFINITY,
    minStart: Math.max(0, origStart - trimStart),
  };
}

/** End time (seconds) of the closest same-track item (scene or video clip)
 *  that finishes at or before `origStart`. Left-edge scene resize clamps its
 *  new start here so expanding a scene can never overlap the previous video. */
export function getPreviousSameTrackEnd(
  scenes: SceneData[],
  clips: Array<Pick<TimelineClip, "id" | "trackType" | "trackIndex" | "startTime" | "endTime">>,
  sceneId: string,
  origStart: number,
  trackIndex: number,
  resolveSceneStart: (scene: SceneData) => number,
  resolveSceneDuration: (scene: SceneData) => number,
): number {
  let prevEnd = 0;
  for (const other of scenes) {
    if (other.id === sceneId) continue;
    if ((other.trackIndex || 1) !== trackIndex) continue;
    const end = resolveSceneStart(other) + resolveSceneDuration(other);
    if (end <= origStart + 0.001) prevEnd = Math.max(prevEnd, end);
  }
  for (const clip of clips) {
    if (clip.trackType !== "video" || clip.trackIndex !== trackIndex) continue;
    if (clip.endTime <= origStart + 0.001) prevEnd = Math.max(prevEnd, clip.endTime);
  }
  return prevEnd;
}

function constrainMoveDelta(deltaTime: number, starts: number[]): number {
  if (deltaTime >= 0) return deltaTime;
  const minStart = starts.length > 0 ? Math.min(...starts) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(minStart)) return deltaTime;
  return Math.max(deltaTime, -minStart);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function getClipKeyframeMarkerTimes(clip: TimelineClip): number[] {
  const duration = Math.max(0, clip.endTime - clip.startTime);
  return getCachedClipKeyframeTimes(clip.keyframesJson, duration);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

type CopyVideoPanelCropSource = {
  shot_index?: number | null;
  copy_video_master_panel_crops?: Record<string, string> | null;
  copy_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
  ai_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
};

function buildCopyVideoPanelCropMap(shots: CopyVideoPanelCropSource[]): Map<number, string> {
  const crops = new Map<number, string>();
  const head = shots[0];
  if (!head) return crops;

  const addCrops = (panelCrops?: Record<string, string> | null) => {
    if (!panelCrops) return;
    for (const [rawIndex, rawUrl] of Object.entries(panelCrops)) {
      const index = Number(rawIndex);
      const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (Number.isFinite(index) && url) {
        crops.set(index, url);
      }
    }
  };

  addCrops(head.copy_video_master_panel_crops);
  for (const sheet of head.copy_video_storyboards || []) {
    addCrops(sheet.panel_crops);
  }
  return crops;
}

function getCopyVideoPanelCropUrl(
  crops: Map<number, string>,
  shot: CopyVideoPanelCropSource,
  shotArrayIndex: number,
): string | null {
  const shotIndex = typeof shot.shot_index === "number" ? shot.shot_index : shotArrayIndex;
  return crops.get(shotIndex) || null;
}

function buildAiVideoPanelCropMap(shots: CopyVideoPanelCropSource[]): Map<number, string> {
  const crops = new Map<number, string>();
  const head = shots[0];
  if (!head) return crops;

  const addCrops = (panelCrops?: Record<string, string> | null) => {
    if (!panelCrops) return;
    for (const [rawIndex, rawUrl] of Object.entries(panelCrops)) {
      const index = Number(rawIndex);
      const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (Number.isFinite(index) && url) {
        crops.set(index, url);
      }
    }
  };

  for (const sheet of head.ai_video_storyboards || []) {
    addCrops(sheet.panel_crops);
  }
  return crops;
}

function getAiVideoPanelCropUrl(
  crops: Map<number, string>,
  shot: CopyVideoPanelCropSource,
  shotArrayIndex: number,
): string | null {
  const shotIndex = typeof shot.shot_index === "number" ? shot.shot_index : shotArrayIndex;
  return crops.get(shotIndex) || null;
}

/**
 * Resolve a scene's absolute timeline start.
 *
 * A project is "timeline-migrated" if ANY scene has timelinePositionSeconds > 0.
 * In that mode we trust the tp field for every scene (including legitimately-zero ones
 * like the first scene) — this prevents scenes from collapsing on top of each other
 * when only SOME scenes have been dragged.
 *
 * Projects with NO migrated scenes fall back to end-to-end cumulative layout.
 */
function getSceneStart(scene: SceneData, scenes: SceneData[], index: number): number {
  let perArray = sceneStartCache.get(scenes);
  if (!perArray) {
    perArray = new Map<number, number>();
    sceneStartCache.set(scenes, perArray);
  }
  const cached = perArray.get(index);
  if (cached !== undefined) return cached;
  const value = getSceneTimelineStart(scene, scenes, index, getSceneDuration);
  perArray.set(index, value);
  return value;
}

/**
 * Run the same push-right layout the backend applies on commit.
 * Given scenes and the dragged scene's proposed new start, returns a
 * map of sceneId → effective start seconds that resolves any overlap.
 * Identical algo to backend `update_scene_timeline_position` so the preview
 * during drag matches exactly what will be saved.
 */
function getSceneBoundaries(scenes: SceneData[]): number[] {
  const migrated = hasExplicitSceneTimelinePositions(scenes);
  if (migrated) {
    const edges = new Set<number>([0]);
    for (let i = 0; i < scenes.length; i++) {
      const start = getSceneStart(scenes[i], scenes, i);
      edges.add(start);
      edges.add(start + getSceneDuration(scenes[i]));
    }
    return [...edges].sort((a, b) => a - b);
  }

  const edges = new Set<number>([0]);
  for (let i = 0; i < scenes.length; i++) {
    const start = getSceneStart(scenes[i], scenes, i);
    edges.add(start);
    edges.add(start + getSceneDuration(scenes[i]));
  }
  return [...edges].sort((a, b) => a - b);
}

// ── Render environment: theme and device pixel ratio are injected (spec §5.1) ──
export interface RenderEnvironmentOptions {
  theme?: TimelineTheme;
  devicePixelRatio?: number;
}

let currentDevicePixelRatio = 1;

export function prepareRenderEnvironment(options: RenderEnvironmentOptions): void {
  if (options.theme) applyTimelineTheme(options.theme);
  currentDevicePixelRatio = options.devicePixelRatio
    ?? (typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1);
}

export function getCurrentRenderDevicePixelRatio(): number {
  return currentDevicePixelRatio;
}

// ── Main render function ───────────────────────────────────

export function renderTimeline(
  ctx: CanvasRenderingContext2D,
  state: CanvasState,
  drag: DragState,
  thumbnailCache?: { get(url: string, time: number): ImageBitmap | undefined },
  waveformCache?: { get(url: string): WaveformData | undefined },
  options: { drawPlayhead?: boolean } & RenderEnvironmentOptions = {},
) {
  prepareRenderEnvironment(options);
  const { scrollLeft, containerWidth, containerHeight } = state;
  const shouldDrawPlayhead = options.drawPlayhead !== false;

  ctx.clearRect(0, 0, containerWidth, containerHeight);

  ctx.save();
  ctx.translate(-scrollLeft, 0);

  // 1. Track backgrounds
  drawTrackBackgrounds(ctx, state);

  // 2. Scene boundary lines
  drawSceneBoundaries(ctx, state);

  // 3-6. Clip bodies (scenes on V1, music on A1, extra clips)
  drawAllClips(ctx, state, drag, thumbnailCache, waveformCache);

  // 6b. Transition markers (bowtie on the cut), on top of the clips
  drawTransitionMarkers(ctx, state);

  // 6b'. Ranges a silences / fillers preview would cut (phase 11)
  drawCutPreview(ctx, state);

  // 6c. The selected keyframe and a keyframe retime ghost (phase 10c)
  drawKeyframeOverlay(ctx, state);

  // 7. Drop-zone highlight (cross-track drag)
  drawDropZone(ctx, state, drag);

  // 9. Drag alignment, continuity, and snap guide lines
  drawDragAlignmentGuides(ctx, state, drag);
  drawSameTrackDropStatus(ctx, state, drag);
  if (drag.mode !== "idle" && drag.snapTime !== null) {
    drawSnapLine(ctx, state, drag.snapTime, drag.snapSource, drag.snapEdge);
  }
  // Scene-strip edge resize: the magnet still snaps (canvas-timeline-utils),
  // but no yellow guide — that visual is reserved for MOVE drags.

  // 9.5. Live time readout while moving or trimming
  drawDragTimeBadge(ctx, state, drag);

  // 10. Blade preview line
  if (state.toolMode === "blade" && state.bladeX !== null) {
    drawBladeLine(ctx, state, state.bladeX);
  }

  // 11. Ruler + markers
  drawRuler(ctx, state);
  drawMarkers(ctx, state);

  // 12. Playhead
  if (shouldDrawPlayhead) drawPlayhead(ctx, state);

  ctx.restore();
}

// ── Live drag time badge ──────────────────────────────────
// CapCut-style readout while moving or trimming: live start–end while a clip
// slides, the new duration while an edge trims. Drawn just above the dragged
// row so the user can land an edit precisely without guessing.

function formatBadgeSeconds(seconds: number): string {
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = total - mins * 60;
  return mins > 0 ? `${mins}:${secs.toFixed(1).padStart(4, "0")}` : `${secs.toFixed(1)}s`;
}

function drawBadge(ctx: CanvasRenderingContext2D, state: CanvasState, text: string, worldX: number, topY: number) {
  ctx.font = "9px -apple-system, system-ui, sans-serif";
  const padX = 5;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 15;
  // Keep the badge inside the visible viewport horizontally.
  const minX = state.scrollLeft + 2;
  const maxX = state.scrollLeft + state.containerWidth - w - 2;
  const bx = Math.max(minX, Math.min(worldX - w / 2, maxX));
  const by = Math.max(RULER_HEIGHT + 1, topY);
  ctx.fillStyle = "rgba(17, 19, 27, 0.95)";
  roundRect(ctx, bx, by, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = 1;
  roundRect(ctx, bx + 0.5, by + 0.5, w - 1, h - 1, 4);
  ctx.stroke();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + padX, by + h / 2 + 0.5);
}

// Badge Y above the track — but the top track's "above" is the ruler (visually
// crammed under the toolbar), so there the badge drops INSIDE the strip instead.
function badgeTopY(layout: TrackLayoutEntry | undefined): number {
  const above = (layout ? RULER_HEIGHT + layout.y : RULER_HEIGHT) - 17;
  if (above >= RULER_HEIGHT + 2) return above;
  return (layout ? RULER_HEIGHT + layout.y : RULER_HEIGHT) + 4;
}

export function drawDragTimeBadge(ctx: CanvasRenderingContext2D, state: CanvasState, drag: DragState) {
  // Scene strip edge trim (V1 boxes). Pending (post-commit, waiting for the
  // server) keeps the strip size but must not keep the badge on screen.
  // Scene strip edge trim (V1 boxes). Pending (post-commit, waiting for the
  // server) keeps the strip size but must not keep the badge on screen.
  const sceneResize = state.sceneEdgeResize;
  if (sceneResize && !sceneResize.pending) {
    const scene = state.scenes.find((s) => s.id === sceneResize.sceneId);
    const layout = state.tracks.find((t) => t.key === `video-${scene?.trackIndex || 1}`);
    const topY = badgeTopY(layout);
    const edgeX = (sceneResize.edge === "left"
      ? sceneResize.newStart
      : sceneResize.newStart + sceneResize.newDuration) * state.zoom;
    drawBadge(ctx, state, formatBadgeSeconds(sceneResize.newDuration), edgeX, topY);
    return;
  }
  if (sceneResize) return;

  if (!drag.committed || !drag.clipId) return;
  if (drag.mode !== "move" && drag.mode !== "resize-left" && drag.mode !== "resize-right") return;
  const orig = drag.originals.get(drag.clipId);
  if (!orig) return;

  let startTime = orig.startTime;
  let endTime = orig.endTime;
  if (drag.mode === "move") {
    const rawDt = (drag.currentX - drag.startX) / state.zoom;
    const dt = drag.moveDeltaTime ?? drag.snapDeltaTime ?? rawDt;
    startTime = Math.max(0, orig.startTime + dt);
    endTime = startTime + (orig.endTime - orig.startTime);
  } else if (drag.mode === "resize-left") {
    startTime = drag.resizeTime ?? startTime;
  } else {
    endTime = drag.resizeTime ?? endTime;
  }

  const trackKey = drag.mode === "move" && drag.targetTrackKey
    ? drag.targetTrackKey
    : `${orig.trackType}-${orig.trackIndex}`;
  const layout = state.tracks.find((t) => t.key === trackKey);
  const topY = badgeTopY(layout);
  const text = drag.mode === "move"
    ? `${formatBadgeSeconds(startTime)} – ${formatBadgeSeconds(endTime)}`
    : formatBadgeSeconds(endTime - startTime);
  const anchorX = (drag.mode === "resize-right" ? endTime : startTime) * state.zoom;
  drawBadge(ctx, state, text, anchorX, topY);
}

// ── Transition markers ────────────────────────────────────

// Bowtie ⧓ centered on each transition clip's cut. Drawn inside the
// scroll-translated context, so worldX (time*zoom) maps to the right screen X.
export function drawTransitionMarkers(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const markers = [
    ...getTransitionMarkers(state.clips, state.tracks, state.zoom),
    ...getSceneTransitionMarkers(
      state.scenes,
      state.tracks,
      state.zoom,
      (i) => getSceneStart(state.scenes[i], state.scenes, i) + getSceneDuration(state.scenes[i]),
      (i) => getSceneStart(state.scenes[i], state.scenes, i),
    ),
  ];
  drawTransitionDropGuides(ctx, state);
  if (markers.length === 0) return;

  const size = TRANSITION_MARKER_SIZE;
  const tri = size * 0.28;

  for (const m of markers) {
    const cx = m.worldX;
    const cy = RULER_HEIGHT + m.centerY;
    const selected = state.selectedTransition?.kind === m.kind && state.selectedTransition?.id === m.id;
    const resizing = state.transitionResize?.kind === m.kind && state.transitionResize?.id === m.id;
    const durationSeconds = resizing ? state.transitionResize!.durationSeconds : m.durationSeconds;
    const wPx = Math.max(size, durationSeconds * state.zoom);
    const halfW = wPx / 2;
    const halfH = size / 2;

    // Spanning shape sized by duration, centered on the cut (fillRect keeps
    // it crisp and test-observable).
    ctx.fillStyle = selected || resizing ? COLORS.transitionBgSelected : COLORS.transitionBg;
    ctx.fillRect(cx - halfW, cy - halfH, wPx, size);
    // Glass edge: a light border always, brighter when selected.
    ctx.strokeStyle = selected || resizing ? COLORS.transitionBorderSelected : COLORS.transitionBorder;
    ctx.lineWidth = selected || resizing ? 1.5 : 1;
    ctx.strokeRect(cx - halfW, cy - halfH, wPx, size);
    if (selected || resizing) {
      // Duration edge handles. Wide shapes get inner handles; minimum-size
      // shapes get handles just OUTSIDE so they stay grabbable when selected.
      ctx.fillStyle = TRANSITION_MARKER_GLYPH_SELECTED;
      if (wPx > size + 12) {
        ctx.fillRect(cx - halfW + 1.5, cy - halfH + 3, 2, size - 6);
        ctx.fillRect(cx + halfW - 3.5, cy - halfH + 3, 2, size - 6);
      } else {
        ctx.fillRect(cx - halfW - 4, cy - halfH + 3, 2, size - 6);
        ctx.fillRect(cx + halfW + 2, cy - halfH + 3, 2, size - 6);
      }
    }

    // Two triangles meeting at the center → a bowtie / )( straddling the cut.
    ctx.fillStyle = selected || resizing ? TRANSITION_MARKER_GLYPH_SELECTED : TRANSITION_MARKER_GLYPH;
    ctx.beginPath();
    ctx.moveTo(cx - tri, cy - tri);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx - tri, cy + tri);
    ctx.closePath();
    ctx.moveTo(cx + tri, cy - tri);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + tri, cy + tri);
    ctx.closePath();
    ctx.fill();

    // Live duration badge above the shape while resizing.
    if (resizing) {
      const label = `${durationSeconds.toFixed(1)}s`; // i18n-ignore
      ctx.font = "9px -apple-system, system-ui, sans-serif";
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = "rgba(17,19,27,0.95)";
      ctx.fillRect(cx - tw / 2, cy - halfH - 16, tw, 13);
      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy - halfH - 9.5);
      ctx.textAlign = "left";
    }
  }
}

// Junction drop guides while a transition card is dragged from the panel:
// valid cuts get a purple ring, invalid (too-short neighbor) a red slashed one.
export const TRANSITION_GUIDE_VALID = "rgba(255,255,255,0.85)";
export const TRANSITION_GUIDE_INVALID = "rgba(239,68,68,0.9)";

function drawTransitionDropGuides(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const guides = state.transitionDropGuides;
  if (!guides || guides.length === 0) return;
  const r = TRANSITION_MARKER_SIZE / 2 + 2;
  for (const g of guides) {
    const cx = g.worldX;
    const cy = RULER_HEIGHT + g.centerY;
    ctx.strokeStyle = g.valid ? TRANSITION_GUIDE_VALID : TRANSITION_GUIDE_INVALID;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(g.valid ? [] : [3, 2]);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (!g.valid) {
      // No-entry slash.
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.7, cy + r * 0.7);
      ctx.lineTo(cx + r * 0.7, cy - r * 0.7);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

// ── Drop-zone highlight ───────────────────────────────────

function drawDropZone(
  ctx: CanvasRenderingContext2D,
  state: CanvasState,
  drag: DragState,
) {
  if (drag.mode !== "move" || !drag.committed || !drag.targetTrackKey || !drag.clipId) return;

  const orig = drag.originals.get(drag.clipId);
  if (!orig) return;

  const origTrackKey = `${orig.trackType}-${orig.trackIndex}`;
  if (drag.targetTrackKey === origTrackKey) return; // same track — no highlight needed

  const targetLayout = state.tracks.find(t => t.key === drag.targetTrackKey);
  if (!targetLayout) return;
  if (targetLayout.locked || targetLayout.visible === false) return;

  const { scrollLeft, totalDuration, zoom, containerWidth } = state;
  const totalWidth = Math.max(totalDuration * zoom, containerWidth);

  // Strong highlight on entire target track row
  ctx.fillStyle = "rgba(52, 211, 153, 0.15)";
  ctx.fillRect(scrollLeft, RULER_HEIGHT + targetLayout.y, totalWidth, targetLayout.height);

  // Bright top + bottom border
  ctx.fillStyle = "rgba(52, 211, 153, 0.7)";
  ctx.fillRect(scrollLeft, RULER_HEIGHT + targetLayout.y, totalWidth, 2);
  ctx.fillRect(scrollLeft, RULER_HEIGHT + targetLayout.y + targetLayout.height - 2, totalWidth, 2);

  // Ghost outline showing exact clip landing position
  const dt = constrainMoveDelta(
    (drag.currentX - drag.startX) / zoom,
    [...drag.originals.values()].map((item) => item.startTime),
  );
  const ghostStart = Math.max(0, orig.startTime + dt);
  const ghostEnd = ghostStart + (orig.endTime - orig.startTime);
  const gx = ghostStart * zoom;
  const gw = Math.max((ghostEnd - ghostStart) * zoom, 4);
  const gy = RULER_HEIGHT + targetLayout.y + 2;
  const gh = targetLayout.height - 4;

  ctx.save();
  ctx.strokeStyle = "rgba(52, 211, 153, 0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(gx + 1, gy + 1, gw - 2, gh - 2);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(52, 211, 153, 0.12)";
  ctx.fillRect(gx + 1, gy + 1, gw - 2, gh - 2);
  ctx.restore();
}

// ── 1. Track backgrounds ──────────────────────────────────

function drawTrackBackgrounds(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const { tracks, scrollLeft, containerWidth, totalDuration, zoom } = state;
  const totalWidth = Math.max(totalDuration * zoom, containerWidth);

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    ctx.fillStyle = i % 2 === 0 ? COLORS.trackBgEven : COLORS.trackBgOdd;
    ctx.fillRect(scrollLeft, RULER_HEIGHT + t.y, totalWidth, t.height);

    // Track separator
    ctx.fillStyle = COLORS.trackBorder;
    ctx.fillRect(scrollLeft, RULER_HEIGHT + t.y + t.height - 0.5, totalWidth, 0.5);
  }
}

// ── 2. Scene boundary lines ───────────────────────────────

function drawSceneBoundaries(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const edges = getSceneBoundaries(state.scenes);
  const totalTracksHeight = state.tracks.reduce((h, t) => Math.max(h, t.y + t.height), 0); // i18n-ignore

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = COLORS.sceneBoundary;
  ctx.lineWidth = 1;

  for (const edge of edges) {
    if (edge <= 0) continue;
    const x = edge * state.zoom;
    ctx.beginPath();
    ctx.moveTo(x, RULER_HEIGHT);
    ctx.lineTo(x, RULER_HEIGHT + totalTracksHeight);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// ── 3-8. All clips ────────────────────────────────────────

function drawAllClips(
  ctx: CanvasRenderingContext2D,
  state: CanvasState,
  drag: DragState,
  thumbnailCache?: { get(url: string, time: number): ImageBitmap | undefined },
  waveformCache?: { get(url: string): WaveformData | undefined },
) {
  const { scenes, tracks, clips, zoom, scrollLeft, containerWidth, selectedClipIds, selectedSceneId, selectedSceneIds } = state;

  // Viewport culling bounds (in seconds)
  const viewLeft = scrollLeft / zoom - 2;
  const viewRight = (scrollLeft + containerWidth) / zoom + 2;

  // Find A1 + video track layouts. Scenes can live on any visible V-track.
  const a1Track = tracks.find(t => t.key === "audio-1");
  const videoTracks = tracks.filter(
    (t) => t.type === "video" && t.visible !== false,
  );
  const videoTrackByIndex = new Map<number, TrackLayoutEntry>();
  for (const vt of videoTracks) videoTrackByIndex.set(vt.index, vt);

  // ── Draw scene clips across all video tracks ──────────
  // Drag-and-drop: the dragged scene follows the cursor. Others don't move.
  if (videoTracks.length > 0) {
    const activeSceneDrag = state.sceneTimelineDrag;
    let draggedSceneRef: SceneData | null = null;
    let draggedProposedStart = 0;
    if (activeSceneDrag) {
      const draggedScene = scenes.find((s) => s.id === activeSceneDrag.sceneId);
      if (draggedScene) {
        const i = scenes.indexOf(draggedScene);
        const origStart = getSceneStart(draggedScene, scenes, i);
        draggedProposedStart = Math.max(0, origStart + activeSceneDrag.deltaX / zoom);
        draggedSceneRef = draggedScene;
      }
    }
    const draggedId = draggedSceneRef?.id ?? null;

    const edgeResize = state.sceneEdgeResize;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      if (scene.id === draggedId) continue; // render dragged last on top
      const tIdx = scene.trackIndex || 1;
      const vt = videoTrackByIndex.get(tIdx);
      if (!vt) continue; // track hidden or not yet created
      let dur = getSceneDuration(scene);
      let startTime = getSceneStart(scene, scenes, i);
      const linkedScenePreview = state.linkedSceneDragPositions?.get(scene.id);
      if (linkedScenePreview) {
        startTime = linkedScenePreview.startTime;
      }
      // Live edge-resize preview — override persisted dimensions with proposed ones.
      if (edgeResize && edgeResize.sceneId === scene.id) {
        startTime = edgeResize.newStart;
        dur = edgeResize.newDuration;
      }
      const endTime = startTime + dur;
      if (endTime < viewLeft || startTime > viewRight) continue;
      const x = startTime * zoom;
      const w = Math.max(dur * zoom, 2);
      const y = RULER_HEIGHT + vt.y + 2;
      const h = vt.height - 4;
      // Keep the selection ring visible while the user resizes the scene.
      const isSelected =
        selectedSceneId === scene.id ||
        selectedSceneIds.has(scene.id) ||
        (edgeResize !== null && edgeResize !== undefined && edgeResize.sceneId === scene.id);
      drawSceneClip(ctx, scene, scenes, i, x, y, w, h, isSelected, zoom, thumbnailCache);
      const sceneActivity = state.aiActivity?.[scene.id];
      if (sceneActivity) drawAiProgress(ctx, sceneActivity, x, y, w, h);
      // Keyframe diamonds on the selected scene (phase 10b), the one under the playhead filled white.
      if (selectedSceneId === scene.id && scene.keyframesJson) {
        drawKeyframeMarkers(ctx, getCachedClipKeyframeTimes(scene.keyframesJson, dur), dur, x, y, w, h, state.currentTime - startTime);
      }

      // Scene resize feedback is the single gray badge in drawDragTimeBadge —
      // the yellow CapCut tooltip doubled it up, so it's gone.
    }

    if (draggedSceneRef && activeSceneDrag) {
      const idx = scenes.indexOf(draggedSceneRef);
      const dur = getSceneDuration(draggedSceneRef);
      const gx = draggedProposedStart * zoom;
      const gw = Math.max(dur * zoom, 2);
      const originTrackIdx = draggedSceneRef.trackIndex || 1;
      const originTrack = videoTrackByIndex.get(originTrackIdx);
      const baseY = (originTrack ? RULER_HEIGHT + originTrack.y + 2 : RULER_HEIGHT + 2);
      const gh = (originTrack?.height ?? TRACK_HEIGHT) - 4;
      // Clip lifts with the cursor (CapCut-style pick-up feel).
      const gy = baseY + activeSceneDrag.deltaY;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 6;
      drawSceneClip(ctx, draggedSceneRef, scenes, idx, gx, gy, gw, gh, true, zoom, thumbnailCache);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = COLORS.selectionRing;
      ctx.lineWidth = 2;
      roundRect(ctx, gx, gy, gw, gh, 2);
      ctx.stroke();
      ctx.restore();

      // Yellow time tooltip — MOVE drags only (resize keeps the gray badge).
      drawSceneMoveTooltip(ctx, gx, gy, gh, draggedProposedStart, dur);

      // Drop-target indicator — which track the cursor is hovering + X position.
      // Snap the vertical band to the nearest visible V-track based on cursor Y.
      const cursorY = baseY + activeSceneDrag.deltaY + gh / 2;
      let targetTrack = originTrack ?? videoTracks[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const vt of videoTracks) {
        const centerY = RULER_HEIGHT + vt.y + vt.height / 2;
        const d = Math.abs(centerY - cursorY);
        if (d < bestDist) {
          bestDist = d;
          targetTrack = vt;
        }
      }
      if (targetTrack) {
        const dropY = RULER_HEIGHT + targetTrack.y + 2;
        const dropH = targetTrack.height - 4;
        ctx.save();
        ctx.strokeStyle = COLORS.alignmentGuide;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        roundRect(ctx, gx, dropY, gw, dropH, 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Persistent shot selection — the shot the user double-clicked stays
    // outlined in yellow until they click elsewhere or drag it away.
    const sel = state.selectedShot;
    if (sel) {
      const selScene = scenes.find((s) => s.id === sel.sceneId);
      if (selScene && selScene.shotBreakdown) {
        const shots = parseCachedShotBreakdown(selScene.shotBreakdown);
        if (shots[sel.shotIndex]) {
          const sIdx = scenes.indexOf(selScene);
          const sStart = getSceneStart(selScene, scenes, sIdx);
          let cum = 0;
          for (let i = 0; i < sel.shotIndex; i++) cum += shotDurationSeconds(shots[i]) || 5;
          const shotStart = sStart + cum;
          const shotDur = shotDurationSeconds(shots[sel.shotIndex]) || 5;
          const vt = videoTrackByIndex.get(selScene.trackIndex || 1);
          if (vt) {
            const sy = RULER_HEIGHT + vt.y + 2;
            const sh = vt.height - 4;
            const sxa = shotStart * zoom;
            const shw = shotDur * zoom;
            ctx.save();
            ctx.strokeStyle = "rgba(251, 191, 36, 1)";
            ctx.lineWidth = 2.5;
            ctx.setLineDash([]);
            roundRect(ctx, sxa - 1, sy - 1, shw + 2, sh + 2, 3);
            ctx.stroke();
            ctx.restore();
          }
        }
      }
    }

    // Shot-drag feedback: highlight the source shot and draw a ghost with the
    // shot's own keyframe image at the cursor so the user sees what they're
    // moving.
    const shotDrag = state.shotDrag;
    if (shotDrag) {
      const sourceScene = scenes.find((s) => s.id === shotDrag.sceneId);
      if (sourceScene && sourceScene.shotBreakdown) {
        {
          interface ShotEntry {
            duration?: string | number;
            keyframe_url?: string | null;
            panel_url?: string | null;
            shot_index?: number | null;
            copy_video_master_panel_crops?: Record<string, string> | null;
            copy_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
          }
          const shots = parseCachedShotBreakdown<ShotEntry>(sourceScene.shotBreakdown);
          const shot = shots[shotDrag.shotIndex];
          if (shot) {
            const copyVideoPanelCrops = sourceScene.cardType === "copy_video"
              ? buildCopyVideoPanelCropMap(shots)
              : new Map<number, string>();
            const sIdx = scenes.indexOf(sourceScene);
            const sStart = getSceneStart(sourceScene, scenes, sIdx);
            let cum = 0;
            for (let i = 0; i < shotDrag.shotIndex; i++) {
              cum += shotDurationSeconds(shots[i]) || 5;
            }
            const shotStart = sStart + cum;
            const shotDur = shotDurationSeconds(shot) || 5;
            const srcTrack = videoTrackByIndex.get(sourceScene.trackIndex || 1);
            if (srcTrack) {
              const sy = RULER_HEIGHT + srcTrack.y + 2;
              const sh = srcTrack.height - 4;
              const sxa = shotStart * zoom;
              const sxb = shotStart * zoom + shotDur * zoom;
              // Source highlight — yellow outline around the shot being moved.
              ctx.save();
              ctx.strokeStyle = "rgba(251, 191, 36, 0.95)";
              ctx.lineWidth = 2;
              ctx.setLineDash([]);
              roundRect(ctx, sxa, sy, sxb - sxa, sh, 2);
              ctx.stroke();
              ctx.restore();

              // ── Drop-position preview ──
              // Mirror the commit logic: find which scene the cursor is over.
              const cursorTime = shotDrag.cursorWorldX / zoom;
              // Snap cursor Y to nearest visible video track.
              let targetTrack: typeof srcTrack = srcTrack;
              let bestDist = Number.POSITIVE_INFINITY;
              for (const vt of videoTracks) {
                const cy = RULER_HEIGHT + vt.y + vt.height / 2;
                const d = Math.abs(cy - shotDrag.cursorY);
                if (d < bestDist) {
                  bestDist = d;
                  targetTrack = vt;
                }
              }
              // Find the scene under the cursor on the target track.
              let hoverScene: typeof sourceScene | null = null;
              let hoverStart = 0;
              for (let i = 0; i < scenes.length; i++) {
                const s = scenes[i];
                if ((s.trackIndex || 1) !== targetTrack.index) continue;
                const st = getSceneStart(s, scenes, i);
                const en = st + getSceneDuration(s);
                if (cursorTime >= st && cursorTime < en) {
                  hoverScene = s;
                  hoverStart = st;
                  break;
                }
              }
              const srcTrackIdx = sourceScene.trackIndex || 1;
              const hoverIsSource =
                hoverScene && hoverScene.id === sourceScene.id && targetTrack.index === srcTrackIdx;

              if (hoverScene && hoverIsSource) {
                // Intra-scene reorder — vertical yellow line at the target gap.
                const total = shots.reduce((a, s) => a + shotVisualDuration(s), 0) || 1;
                const scale = total / getSceneDuration(sourceScene);
                const offShot = Math.max(0, (cursorTime - hoverStart) * scale);
                // Gap index 0..shots.length based on left/right-half of each shot.
                let insertIdx = shots.length;
                {
                  let acc = 0;
                  for (let i = 0; i < shots.length; i++) {
                    const d = shotVisualDuration(shots[i]);
                    if (offShot < acc + d) {
                      insertIdx = offShot < acc + d / 2 ? i : i + 1;
                      break;
                    }
                    acc += d;
                  }
                }
                let insAcc = 0;
                for (let i = 0; i < insertIdx; i++) insAcc += shotVisualDuration(shots[i]);
                const ix = (hoverStart + insAcc / scale) * zoom;
                const iy = RULER_HEIGHT + srcTrack.y;
                const ih = srcTrack.height;
                ctx.save();
                ctx.strokeStyle = "rgba(251, 191, 36, 1)";
                ctx.lineWidth = 3;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(ix, iy);
                ctx.lineTo(ix, iy + ih);
                ctx.stroke();
                ctx.fillStyle = "rgba(251, 191, 36, 1)";
                ctx.beginPath();
                ctx.moveTo(ix - 5, iy - 2);
                ctx.lineTo(ix + 5, iy - 2);
                ctx.lineTo(ix, iy + 4);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
              } else if (hoverScene) {
                // Merge into a DIFFERENT scene — green glowing border on the
                // target scene AND a precise insertion line between its shots.
                const hvIdx = scenes.indexOf(hoverScene);
                const hvStart = getSceneStart(hoverScene, scenes, hvIdx);
                const hvDur = getSceneDuration(hoverScene);
                const hvx = hvStart * zoom;
                const hvy = RULER_HEIGHT + targetTrack.y + 2;
                const hvw = Math.max(hvDur * zoom, 4);
                const hvh = targetTrack.height - 4;
                ctx.save();
                ctx.strokeStyle = "rgba(52, 211, 153, 1)";
                ctx.lineWidth = 3;
                ctx.setLineDash([]);
                roundRect(ctx, hvx - 1, hvy - 1, hvw + 2, hvh + 2, 4);
                ctx.stroke();
                ctx.restore();

                // Resolve target shot gap using the same scaling the renderer
                // uses for drawing target shots within the scene strip.
                const tgtShots = parseCachedShotBreakdown<ShotEntry>(hoverScene.shotBreakdown);
                const tgtTotal = tgtShots.reduce((a, s) => a + shotVisualDuration(s), 0) || 1;
                const tgtScale = hvDur > 0 ? tgtTotal / hvDur : 1;
                const offInTgt = Math.max(0, (cursorTime - hvStart) * tgtScale);
                // Gap index 0..tgtShots.length — right half of a shot = after it.
                let tgtIdx = tgtShots.length;
                {
                  let acc = 0;
                  for (let i = 0; i < tgtShots.length; i++) {
                    const d = shotVisualDuration(tgtShots[i]);
                    if (offInTgt < acc + d) {
                      tgtIdx = offInTgt < acc + d / 2 ? i : i + 1;
                      break;
                    }
                    acc += d;
                  }
                }
                // X of the insertion boundary, scaled back to visual time.
                let tgtAcc = 0;
                for (let i = 0; i < tgtIdx; i++) {
                  tgtAcc += shotVisualDuration(tgtShots[i]);
                }
                const insVisualOffset = tgtTotal > 0 ? (tgtAcc / tgtScale) : 0;
                const insX = (hvStart + insVisualOffset) * zoom;
                const insY = RULER_HEIGHT + targetTrack.y;
                const insH = targetTrack.height;
                ctx.save();
                ctx.strokeStyle = "rgba(52, 211, 153, 1)";
                ctx.lineWidth = 3;
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(insX, insY);
                ctx.lineTo(insX, insY + insH);
                ctx.stroke();
                ctx.fillStyle = "rgba(52, 211, 153, 1)";
                ctx.beginPath();
                ctx.moveTo(insX - 5, insY - 2);
                ctx.lineTo(insX + 5, insY - 2);
                ctx.lineTo(insX, insY + 4);
                ctx.closePath();
                ctx.fill();
                // "+ Add shot here" label near the insertion line.
                ctx.font = "bold 10px -apple-system, system-ui, sans-serif";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(`+ Insert at ${tgtIdx + 1}`, insX + 6, insY - 10);
                ctx.restore();
              } else {
                // Empty space — extract to new scene. Dashed yellow outline.
                const dropX = Math.max(0, cursorTime) * zoom;
                const dropW = Math.max(shotDur * zoom, 4);
                const dropY = RULER_HEIGHT + targetTrack.y + 2;
                const dropH = targetTrack.height - 4;
                ctx.save();
                ctx.strokeStyle = "rgba(251, 191, 36, 0.85)";
                ctx.setLineDash([5, 3]);
                ctx.lineWidth = 2;
                roundRect(ctx, dropX, dropY, dropW, dropH, 3);
                ctx.stroke();
                ctx.fillStyle = "rgba(251, 191, 36, 0.9)";
                ctx.font = "bold 11px -apple-system, system-ui, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("+ New scene", dropX + dropW / 2, dropY - 10);
                ctx.restore();
              }

              // Ghost with the shot's keyframe image at cursor.
              const ghostW = Math.max(sxb - sxa, 40);
              const ghostH = sh * 0.9;
              const ghostX = shotDrag.cursorWorldX - ghostW / 2;
              const ghostY = shotDrag.cursorY - ghostH / 2;
              const cropUrl = sourceScene.cardType === "copy_video"
                ? getCopyVideoPanelCropUrl(copyVideoPanelCrops, shot, shotDrag.shotIndex)
                : null;
              const thumbUrl = sourceScene.cardType === "copy_video"
                ? (cropUrl || shot.panel_url || shot.keyframe_url || null)
                : (shot.keyframe_url || shot.panel_url || cropUrl || null);
              ctx.save();
              ctx.shadowColor = "rgba(0,0,0,0.55)";
              ctx.shadowBlur = 14;
              ctx.shadowOffsetY = 5;
              // Fill background first so we always see a rectangle if the
              // thumbnail hasn't loaded yet.
              ctx.fillStyle = "rgba(30, 30, 36, 0.95)";
              roundRect(ctx, ghostX, ghostY, ghostW, ghostH, 3);
              ctx.fill();
              ctx.restore();
              // Clip to the ghost shape before drawing the image.
              ctx.save();
              roundRect(ctx, ghostX, ghostY, ghostW, ghostH, 3);
              ctx.clip();
              if (thumbUrl && thumbnailCache) {
                const bitmap = thumbnailCache.get(thumbUrl, 0);
                if (bitmap) {
                  const imgA = bitmap.width / bitmap.height;
                  const boxA = ghostW / ghostH;
                  let srcW = bitmap.width, srcH = bitmap.height, srcX = 0, srcY = 0;
                  if (imgA > boxA) {
                    srcW = bitmap.height * boxA;
                    srcX = (bitmap.width - srcW) / 2;
                  } else {
                    srcH = bitmap.width / boxA;
                    srcY = (bitmap.height - srcH) / 2;
                  }
                  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, ghostX, ghostY, ghostW, ghostH);
                }
              }
              // Dim gradient so the label stays readable.
              const g = ctx.createLinearGradient(ghostX, ghostY, ghostX, ghostY + ghostH);
              g.addColorStop(0, "rgba(0,0,0,0.1)");
              g.addColorStop(1, "rgba(0,0,0,0.55)");
              ctx.fillStyle = g;
              ctx.fillRect(ghostX, ghostY, ghostW, ghostH);
              ctx.restore();
              // Bright yellow outline so the ghost reads as "being carried".
              ctx.save();
              ctx.strokeStyle = "rgba(251, 191, 36, 1)";
              ctx.lineWidth = 2;
              roundRect(ctx, ghostX, ghostY, ghostW, ghostH, 3);
              ctx.stroke();
              // Label with shot number.
              ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
              ctx.font = "bold 10px -apple-system, system-ui, sans-serif";
              ctx.textAlign = "left";
              ctx.textBaseline = "bottom";
              ctx.fillText(
                `Shot ${shotDrag.shotIndex + 1}`,
                ghostX + 4,
                ghostY + ghostH - 3,
              );
              ctx.restore();
            }
          }
        }
      }
    }
  }

  // ── Draw A1 music + voiceovers ───────────────────────
  if (a1Track && a1Track.visible !== false) {
    drawMusicTrack(ctx, state, a1Track, waveformCache);
    drawVoiceovers(ctx, state, a1Track);
  }

  // ── Draw extra track clips ───────────────────────────
  for (const clip of clips) {
    const trackKey = `${clip.trackType}-${clip.trackIndex}`;
    let layout = tracks.find(t => t.key === trackKey);
    if (!layout) continue;
    if (layout.visible === false) continue;

    // Get effective position (may be modified by drag)
    let startTime = clip.startTime;
    let endTime = clip.endTime;
    const linkedScenePreview = state.linkedClipDragPositions?.get(clip.id);
    if (linkedScenePreview) {
      startTime = linkedScenePreview.startTime;
      endTime = linkedScenePreview.endTime;
    }
    const isDraggingThis = drag.mode !== "idle" && drag.originals.has(clip.id);
    if (isDraggingThis) {
      const orig = drag.originals.get(clip.id)!;
      if (drag.mode === "move") {
        const rawDt = (drag.currentX - drag.startX) / zoom;
        const dt = constrainMoveDelta(
          drag.moveDeltaTime ?? drag.snapDeltaTime ?? rawDt,
          [...drag.originals.values()].map((item) => item.startTime),
        );
        startTime = Math.max(0, orig.startTime + dt);
        endTime = startTime + (orig.endTime - orig.startTime);
        // Show clip on target track row during cross-track drag
        if (clip.id === drag.clipId && drag.targetTrackKey) {
          const targetLayout = tracks.find(t => t.key === drag.targetTrackKey);
          if (targetLayout && !targetLayout.locked && targetLayout.visible !== false) layout = targetLayout;
        }
      } else if (drag.mode === "resize-left" && drag.clipId === clip.id) {
        const dt = (drag.currentX - drag.startX) / zoom;
        startTime = drag.resizeTime ?? Math.max(0, Math.min(orig.endTime - 0.1, orig.startTime + dt));
        endTime = orig.endTime;
      } else if (drag.mode === "resize-right" && drag.clipId === clip.id) {
        const dt = (drag.currentX - drag.startX) / zoom;
        endTime = drag.resizeTime ?? Math.max(orig.startTime + 0.1, orig.endTime + dt);
        startTime = orig.startTime;
      }
    }

    if (endTime < viewLeft || startTime > viewRight) continue;

    const x = startTime * zoom;
    const w = Math.max((endTime - startTime) * zoom, 4);
    const y = RULER_HEIGHT + layout.y + 2;
    const h = layout.height - 4;
    const isSelected = selectedClipIds.has(clip.id);
    const isHovered = state.hoveredClipId === clip.id;
    const alpha = isDraggingThis && drag.mode === "move" ? 0.7 : 1;
    ctx.globalAlpha = alpha;

    drawClipBody(ctx, clip, x, y, w, h, isSelected, isHovered, waveformCache, thumbnailCache);
    // Phase 11 overlays, after the cached body bitmap so they never go stale in it: beat dots and AI job progress.
    if (clip.trackType === "audio" && clip.beatsJson) drawBeatDots(ctx, clip, x, y, w, h, zoom);
    const clipActivity = state.aiActivity?.[clip.id];
    if (clipActivity) drawAiProgress(ctx, clipActivity, x, y, w, h);
    // The selected clip's keyframe under the playhead, filled white over the cached markers.
    if (isSelected && clip.keyframesJson) {
      drawKeyframeMarkers(ctx, getClipKeyframeMarkerTimes(clip), endTime - startTime, x, y, w, h, state.currentTime - startTime, true);
    }

    // CapCut-style transition badge at the clip's trailing junction (where it
    // blends into the next clip). The bowtie ")(" sits on the seam.
    const transType = (clip as { transitionType?: string }).transitionType;
    if (transType && transType !== "none") {
      const jx = x + w;
      const jy = y + h / 2;
      const rad = Math.min(8, h / 2 - 1);
      ctx.save();
      // backing circle
      ctx.fillStyle = "rgba(10,10,11,0.92)";
      ctx.beginPath();
      ctx.arc(jx, jy, rad + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // bowtie ")(" — two arcs facing each other
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(jx - rad * 0.55, jy, rad * 0.7, -Math.PI / 2.3, Math.PI / 2.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(jx + rad * 0.55, jy, rad * 0.7, Math.PI - Math.PI / 2.3, Math.PI + Math.PI / 2.3);
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }
}

// ── AI overlays (phase 11) ────────────────────────────────

/** Smallest gap between two drawn beat dots, px: denser beats are thinned so the dots stay readable. */
export const BEAT_DOT_MIN_GAP = 4;
export const BEAT_DOT_SIZE = 3;

/**
 * World x of each beat dot of an audio clip whose box is drawn at [x, x + w] (its live drag position), thinned to at
 * least BEAT_DOT_MIN_GAP px apart.
 */
export function planBeatDots(clip: TimelineClip, zoom: number, x: number, w: number): number[] {
  const out: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const time of clipBeatTimes(clip)) {
    const px = x + (time - clip.startTime) * zoom;
    if (px < x || px > x + w) continue;
    if (px - last < BEAT_DOT_MIN_GAP) continue;
    out.push(px);
    last = px;
  }
  return out;
}

function drawBeatDots(ctx: CanvasRenderingContext2D, clip: TimelineClip, x: number, y: number, w: number, h: number, zoom: number) {
  const dots = planBeatDots(clip, zoom, x, w);
  if (dots.length === 0) return;
  ctx.save();
  ctx.fillStyle = COLORS.beatDot;
  const size = BEAT_DOT_SIZE;
  const top = y + h - size - 3;
  for (const px of dots) ctx.fillRect(Math.round(px - size / 2), Math.round(top), size, size);
  ctx.restore();
}

/** A thin line along the bottom of an item: its AI job's progress (a dim full-width track when unknown). */
function drawAiProgress(ctx: CanvasRenderingContext2D, activity: { progress?: number; changed?: boolean }, x: number, y: number, w: number, h: number) {
  if (activity.changed) {
    drawAiChanged(ctx, x, y, w, h);
    return;
  }
  const lineH = 2;
  const top = y + h - lineH;
  ctx.save();
  ctx.fillStyle = COLORS.aiProgressTrack;
  ctx.fillRect(x, top, w, lineH);
  const progress = activity.progress;
  if (typeof progress === "number" && Number.isFinite(progress)) {
    ctx.fillStyle = COLORS.aiProgress;
    ctx.fillRect(x, top, Math.max(0, Math.min(1, progress)) * w, lineH);
  }
  ctx.restore();
}

/** An item the AI director just changed (phase 9b): a dashed outline and a small "AI" tag (never colour alone). */
function drawAiChanged(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.strokeStyle = COLORS.aiChanged;
  ctx.lineWidth = 1.5;
  ctx.setLineDash?.([4, 3]);
  ctx.strokeRect(x + 0.75, y + 0.75, Math.max(0, w - 1.5), Math.max(0, h - 1.5));
  ctx.setLineDash?.([]);
  if (w >= 22 && h >= 14) {
    const tagW = 18;
    const tagH = 12;
    ctx.fillStyle = COLORS.aiChangedTag;
    ctx.fillRect(x + 2, y + 2, tagW, tagH);
    ctx.fillStyle = COLORS.aiChangedText;
    ctx.font = "600 9px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("AI", x + 2 + tagW / 2, y + 2 + tagH / 2 + 0.5);
  }
  ctx.restore();
}

/** Ghost regions over every track for the ranges a silences / fillers preview would cut. */
function drawCutPreview(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const preview = state.cutPreview;
  if (!preview || preview.ranges.length === 0) return;
  const top = RULER_HEIGHT;
  const height = Math.max(0, state.containerHeight - RULER_HEIGHT);
  const viewLeft = state.scrollLeft;
  const viewRight = state.scrollLeft + state.containerWidth;
  ctx.save();
  for (const range of preview.ranges) {
    const x0 = range.start * state.zoom;
    const x1 = range.end * state.zoom;
    if (x1 < viewLeft || x0 > viewRight || !(x1 > x0)) continue;
    ctx.fillStyle = COLORS.cutPreviewFill;
    ctx.fillRect(x0, top, Math.max(1, x1 - x0), height);
    ctx.fillStyle = COLORS.cutPreviewBorder;
    ctx.fillRect(x0, top, 1, height);
    ctx.fillRect(Math.max(x0, x1 - 1), top, 1, height);
  }
  ctx.restore();
}

// ── Scene clip on V1 ──────────────────────────────────────

function parseSceneCardConfig(scene: SceneData): Record<string, unknown> {
  const config = parseCachedSceneCardConfig(scene.cardConfig);
  return config;
}

function getSceneTimelineTrim(scene: SceneData, sceneDur: number): { start: number; end: number } {
  const config = parseSceneCardConfig(scene);
  const trimStart = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
  const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd ?? trimStart + sceneDur);
  const start = Number.isFinite(trimStart) && trimStart > 0 ? trimStart : 0;
  const end = Number.isFinite(trimEnd) && trimEnd > start ? trimEnd : start + sceneDur;
  return { start, end };
}

// Single-strip (no per-shot keyframes) plan for a scene clip. Prefers a still
// image; otherwise samples the generated/source video across its trimmed span so
// AI-video scenes (which often have no still image) still show a frame filmstrip.
// The renderer and the canvas media-request loop both call this so the requested
// frame times match the times the renderer reads back from the thumbnail cache.
const SCENE_FILMSTRIP_SLICE_PX = 72;
const SCENE_FILMSTRIP_MAX_SLICES = 12;

export interface SceneFilmstripPlan {
  url: string;
  isVideo: boolean;
  times: number[];
  /** Alpha-cutout webm (bg removed): draw a checkerboard behind the frames. */
  alpha?: boolean;
}

export function planSceneFilmstrip(
  scene: SceneData,
  scenes: SceneData[],
  idx: number,
  widthPx: number,
): SceneFilmstripPlan | null {
  const isContinue = scene.transition === "continue" && idx > 0;
  // Background-removed renders are alpha webm cutouts — thumb from the CUTOUT
  // itself (over a checkerboard) so the strip shows the background is gone.
  const isAlphaCutout = !!scene.videoUrl && /_human_cutout\.webm(\?|$)/.test(scene.videoUrl);
  const videoUrl = scene.videoUrl || scene.sourceVideoUrl;
  const stillUrl =
    scene.startImageThumbUrl ||
    scene.startImageUrl ||
    scene.videoPosterUrl ||
    (!videoUrl ? scene.videoStoryboardRawUrl || scene.videoStoryboardUrl : null) ||
    (isContinue ? scenes[idx - 1]?.endImageThumbUrl || scenes[idx - 1]?.endImageUrl : null);
  // Never fall back to stills for a bg-removed scene — posters/keyframes
  // predate the removal and resurrect the old background in the strip.
  if (stillUrl && !isAlphaCutout) return { url: stillUrl, isVideo: false, times: [0] };

  if (!videoUrl) return null;

  const sceneDur = getSceneDuration(scene);
  const trim = getSceneTimelineTrim(scene, sceneDur);
  const span = Math.max(0.1, trim.end - trim.start);
  const count = Math.max(1, Math.min(SCENE_FILMSTRIP_MAX_SLICES, Math.ceil(widthPx / SCENE_FILMSTRIP_SLICE_PX)));
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    times.push(Math.round((trim.start + span * ((i + 0.5) / count)) * 100) / 100);
  }
  return { url: videoUrl, isVideo: true, times, alpha: isAlphaCutout };
}

// Small two-tone checkerboard: the universal "this area is transparent" cue
// behind alpha-cutout filmstrip frames.
function drawAlphaChecker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const cell = 6;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#3A3A40";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#2C2C31";
  for (let cy = 0; cy * cell < h; cy++) {
    for (let cx = 0; cx * cell < w; cx++) {
      if ((cx + cy) % 2 === 0) ctx.fillRect(x + cx * cell, y + cy * cell, cell, cell);
    }
  }
  ctx.restore();
}

function drawSceneClip(
  ctx: CanvasRenderingContext2D,
  scene: SceneData,
  scenes: SceneData[],
  idx: number,
  x: number, y: number, w: number, h: number,
  isSelected: boolean,
  zoom: number,
  thumbnailCache?: { get(url: string, time: number): ImageBitmap | undefined },
) {
  ctx.save();

  // Clip region
  roundRect(ctx, x, y, w, h, 2);
  ctx.clip();

  // Background
  ctx.fillStyle = COLORS.video.fill;
  ctx.fillRect(x, y, w, h);

  // ── Per-shot thumbnails ──────────────────────────────────
  const isContinue = scene.transition === "continue" && idx > 0;

  interface ShotEntry {
    duration?: string | number;
    keyframe_url?: string | null;
    panel_url?: string | null;
    source_frame_url?: string | null;
    shot_index?: number | null;
    copy_video_master_panel_crops?: Record<string, string> | null;
    copy_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
    ai_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
    copy_video_source_video_url?: string | null;
    copy_video_trim_start?: number | null;
  }
  const shots: ShotEntry[] = parseCachedShotBreakdown(scene.shotBreakdown);

  const sceneDur = getSceneDuration(scene);

  // For copy_video, each shot points at a source video segment. Even without a
  // generated keyframe we can render the source-video frame at trim_start so
  // the strip shows the actual content the user will be copying.
  const isCopyVideoScene = scene.cardType === "copy_video";
  const copyVideoPanelCrops = isCopyVideoScene
    ? buildCopyVideoPanelCropMap(shots)
    : new Map<number, string>();
  const aiVideoPanelCrops = scene.cardType === "ai_video"
    ? buildAiVideoPanelCropMap(shots)
    : new Map<number, string>();
  const anyShotHasThumb = shots.some(
    (s, shotIndex) => s.keyframe_url || s.panel_url ||
      getCopyVideoPanelCropUrl(copyVideoPanelCrops, s, shotIndex) ||
      getAiVideoPanelCropUrl(aiVideoPanelCrops, s, shotIndex) ||
      (isCopyVideoScene && (s.source_frame_url || s.copy_video_source_video_url || scene.sourceVideoUrl)),
  );
  let drewMedia = false;
  if (shots.length > 0 && anyShotHasThumb && thumbnailCache) {
    drewMedia = true;
    // Draw each shot's keyframe in its proportional time slice
    let shotOffset = 0;
    for (let shotIndex = 0; shotIndex < shots.length; shotIndex++) {
      const shot = shots[shotIndex];
      const shotDur = shotVisualDuration(shot);
      const shotW = (shotDur / sceneDur) * w;
      const shotX = x + (shotOffset / sceneDur) * w;
      // Prefer generated keyframe; before any storyboard is built, fall back to
      // the per-shot original-video keyframe image (source_frame_url) so the
      // timeline shows the original breakdown. Only if that's missing do we drop
      // to decoding the source video at the shot's trim_start.
      const cropUrl = isCopyVideoScene
        ? getCopyVideoPanelCropUrl(copyVideoPanelCrops, shot, shotIndex)
        : getAiVideoPanelCropUrl(aiVideoPanelCrops, shot, shotIndex);
      const thumbUrl = isCopyVideoScene
        ? (cropUrl || shot.panel_url || shot.keyframe_url || shot.source_frame_url || shot.copy_video_source_video_url || scene.sourceVideoUrl || null)
        : (shot.keyframe_url || shot.panel_url || cropUrl || null);
      const thumbTime = (isCopyVideoScene && thumbUrl && thumbUrl === (shot.copy_video_source_video_url || scene.sourceVideoUrl))
        ? Number(shot.copy_video_trim_start || 0)
        : 0;
      if (thumbUrl) {
        const bitmap = thumbnailCache.get(thumbUrl, thumbTime);
        if (bitmap) {
          const imgAspect = bitmap.width / bitmap.height;
          const sliceAspect = shotW / h;
          let sw = bitmap.width, sh = bitmap.height, sx = 0, sy = 0;
          if (imgAspect > sliceAspect) {
            sw = bitmap.height * sliceAspect;
            sx = (bitmap.width - sw) / 2;
          } else {
            sh = bitmap.width / sliceAspect;
            sy = (bitmap.height - sh) / 2;
          }
          ctx.drawImage(bitmap, sx, sy, sw, sh, shotX, y, shotW, h);
        }
      }
      // Divider between shots (skip last)
      if (shotOffset + shotDur < sceneDur - 0.05) {
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(shotX + shotW - 0.5, y, 1, h);
      }
      shotOffset += shotDur;
    }
  } else if (thumbnailCache) {
    // Fallback: still image or a video filmstrip covering the whole scene.
    const plan = planSceneFilmstrip(scene, scenes, idx, w);
    if (plan) {
      drewMedia = true;
      const count = plan.times.length;
      for (let i = 0; i < count; i++) {
        const sliceX = x + (w / count) * i;
        const sliceW = i === count - 1 ? x + w - sliceX : w / count;
        const bitmap = thumbnailCache.get(plan.url, plan.isVideo ? plan.times[i] : 0);
        if (bitmap && plan.alpha) drawAlphaChecker(ctx, sliceX, y, sliceW, h);
        if (bitmap) {
          const imgAspect = bitmap.width / bitmap.height;
          const clipAspect = sliceW / h;
          let sw = bitmap.width, sh = bitmap.height, sx = 0, sy = 0;
          if (imgAspect > clipAspect) {
            sw = bitmap.height * clipAspect;
            sx = (bitmap.width - sw) / 2;
          } else {
            sh = bitmap.width / clipAspect;
            sy = (bitmap.height - sh) / 2;
          }
          ctx.drawImage(bitmap, sx, sy, sw, sh, sliceX, y, sliceW, h);
        }
      }
    }
  }

  // Empty scene (no keyframes/media yet) — without this it renders as a bare
  // dark rectangle that is nearly invisible on the timeline, yet still blocks
  // drags. Hatch it and label it so the user can SEE what's occupying space.
  if (!drewMedia) {
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    for (let hx = x - h; hx < x + w; hx += 7) {
      ctx.beginPath();
      ctx.moveTo(hx, y + h);
      ctx.lineTo(hx + h, y);
      ctx.stroke();
    }
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (w > 40) {
      ctx.font = "8px -apple-system, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("empty scene", x + w / 2, y + h / 2);
      ctx.textAlign = "left";
    }
  }

  // Darken gradient overlay
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, "rgba(0,0,0,0.4)");
  grad.addColorStop(0.4, "rgba(0,0,0,0)");
  grad.addColorStop(0.7, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Status dot (top-left)
  drawStatusDot(ctx, scene.status, x + 6, y + 5);

  // Processing lock overlay — matting / generation running on this scene.
  // Dim + diagonal stripes + animated spinner + label so the user sees the
  // strip is busy and locked (selection still works; move/trim disabled).
  if (scene.status === "video_generating" || scene.status === "images_generating" || scene.status === "face_swapping") {
    ctx.save();
    ctx.fillStyle = "rgba(10,10,12,0.55)";
    ctx.fillRect(x, y, w, h);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 4;
    for (let sx = x - h; sx < x + w; sx += 14) {
      ctx.beginPath();
      ctx.moveTo(sx, y + h);
      ctx.lineTo(sx + h, y);
      ctx.stroke();
    }
    // Spinner arc (animates because the render loop repaints continuously
    // while any scene is generating — see needsRender wake below).
    const t = (Date.now() % 1000) / 1000;
    const cx2 = x + w / 2;
    const cy2 = y + h / 2 - (w > 90 ? 6 : 0);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx2, cy2, 7, t * Math.PI * 2, t * Math.PI * 2 + Math.PI * 1.4);
    ctx.stroke();
    if (w > 90) {
      ctx.font = "8px -apple-system, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("Processing…", cx2, cy2 + 12);
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  // Frame consistency warning
  if (scene.frameConsistencyScore != null && scene.frameConsistencyScore < 70 && w > 30) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    roundRect(ctx, x + w - 14, y + 2, 12, 12, 2);
    ctx.fill();
    // Triangle warning icon
    ctx.fillStyle = COLORS.warningBadge;
    ctx.beginPath();
    ctx.moveTo(x + w - 8, y + 4);
    ctx.lineTo(x + w - 4, y + 12);
    ctx.lineTo(x + w - 12, y + 12);
    ctx.closePath();
    ctx.fill();
  }

  // Caption (bottom)
  if (w > 80) {
    ctx.font = "8px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    const caption = scene.caption.startsWith("[INSTRUMENTAL")
      ? scene.caption.replace("[INSTRUMENTAL - ", "").replace("[INSTRUMENTAL]", "Instrumental").replace("]", "")
      : scene.caption;
    const maxChars = Math.floor(w / 5);
    const truncated = caption.length > maxChars ? caption.slice(0, maxChars) + "..." : caption;
    ctx.fillText(truncated, x + 3, y + h - 2);
  }

  // Shot breakdown dashed separators
  if (scene.shotBreakdown) {
    const shots = parseCachedShotBreakdown<{ prompt: string; duration: string }>(scene.shotBreakdown);
    if (shots.length > 1) {
      const sceneDur = getSceneDuration(scene);
      let cumShotTime = 0;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.5;
      for (let si = 0; si < shots.length - 1; si++) {
        cumShotTime += shotDurationSeconds(shots[si]);
        const shotX = x + (cumShotTime / sceneDur) * w;
        ctx.beginPath();
        ctx.moveTo(shotX, y + 2);
        ctx.lineTo(shotX, y + h - 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (w > 60) {
        const shotLabel = `${shots.length}`;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        const slW = ctx.measureText(shotLabel).width + 8;
        roundRect(ctx, x + w - slW - 2, y + h - 14, slW, 11, 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.font = "bold 7px -apple-system, system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(shotLabel, x + w - slW / 2 - 2, y + h - 8.5);
      }
    }
  }

  // Card type badge
  if (w > 50 && scene.cardType && scene.cardType !== "ai_video") {
    const hasOverlay = !!(scene as any).overlayText;
    const label = scene.cardType === "image"
      ? `${(scene.duration || 5).toFixed(1)}s${hasOverlay ? " clip" : " img"}`
      : scene.cardType.replace(/_/g, " ");
    ctx.font = "7px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = scene.cardType === "podcast"
      ? "rgba(251, 146, 60, 0.8)"
      : hasOverlay ? "rgba(96, 165, 250, 0.9)" : "rgba(56, 189, 248, 0.8)";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, x + 3, y + h - 11);
  }

  // Overlay text badge (short clips)
  if (w > 100 && (scene as any).overlayText) {
    ctx.font = "bold 7px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = "rgba(251, 191, 36, 0.8)";
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    const ot = (scene as any).overlayText as string;
    const maxC = Math.floor((w - 20) / 4);
    const trunc = ot.length > maxC ? ot.slice(0, maxC) + "..." : ot;
    ctx.fillText(trunc, x + w - 4, y + 4);
    ctx.textAlign = "left";
  }

  // CONTINUE indicator (left edge)
  if (isContinue) {
    ctx.fillStyle = COLORS.continueEdge;
    ctx.fillRect(x, y, 2, h);
  }

  // ── Type accent + icon ─────────────────────────────────
  // A left-edge stripe colored per scene type + a small glyph in the top-left
  // corner so the user can tell video / image / podcast / AI apart at a glance
  // (CapCut-style). Also matches what resize does: images stretch freely, video
  // clips clamp to source duration (hence the distinct color).
  const cardType = scene.cardType || "ai_video";
  let accent = "rgba(255, 255, 255, 0.55)"; // neutral — AI video
  if (cardType === "image") accent = "rgba(52, 211, 153, 0.95)"; // emerald
  else if (cardType === "source_clip") accent = "rgba(56, 189, 248, 0.95)"; // sky
  else if (cardType === "podcast") accent = "rgba(251, 146, 60, 0.95)"; // orange
  else if (cardType === "live_portrait") accent = "rgba(236, 72, 153, 0.95)"; // pink

  // Left-edge accent stripe (skip if CONTINUE stripe already claimed the spot).
  if (!isContinue) {
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, 2.5, h);
  }

  // Type glyph badge top-left (only when strip is wide enough).
  if (w > 28) {
    const bx = x + 5;
    const by = y + 3;
    const bw = 16;
    const bh = 12;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(ctx, bx, by, bw, bh, 2);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    if (cardType === "image") {
      // Mountain-in-frame
      ctx.strokeRect(cx - 4, cy - 3, 8, 6);
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy + 2);
      ctx.lineTo(cx - 1, cy);
      ctx.lineTo(cx + 1, cy + 1);
      ctx.lineTo(cx + 3, cy - 1);
      ctx.stroke();
    } else if (cardType === "source_clip") {
      // Play triangle in rect
      ctx.strokeRect(cx - 4, cy - 3, 8, 6);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(cx - 1, cy - 2);
      ctx.lineTo(cx + 2, cy);
      ctx.lineTo(cx - 1, cy + 2);
      ctx.closePath();
      ctx.fill();
    } else if (cardType === "podcast") {
      // Mic (rounded rect + base line)
      ctx.beginPath();
      ctx.arc(cx, cy - 1, 2, Math.PI, 0);
      ctx.lineTo(cx + 2, cy + 1);
      ctx.arc(cx, cy + 1, 2, 0, Math.PI);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 3, cy + 2);
      ctx.arc(cx, cy + 2, 3, Math.PI, 0, true);
      ctx.stroke();
    } else if (cardType === "live_portrait") {
      // Face circle
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx - 1.2, cy - 0.5, 0.6, 0, Math.PI * 2);
      ctx.arc(cx + 1.2, cy - 0.5, 0.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // AI sparkle
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 3);
      ctx.lineTo(cx + 1, cy - 1);
      ctx.lineTo(cx + 3, cy);
      ctx.lineTo(cx + 1, cy + 1);
      ctx.lineTo(cx, cy + 3);
      ctx.lineTo(cx - 1, cy + 1);
      ctx.lineTo(cx - 3, cy);
      ctx.lineTo(cx - 1, cy - 1);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.restore();

  // Type-colored border ring (thin) so even an un-selected strip reads as its type.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 2);
  ctx.stroke();

  // Selection ring — the theme's (white) outer outline, thick enough to be unmistakable.
  // Drawn AFTER the type-colored border so the selection state wins visually.
  if (isSelected) {
    ctx.strokeStyle = COLORS.selectionRing;
    ctx.lineWidth = 2.5;
    roundRect(ctx, x - 1.5, y - 1.5, w + 3, h + 3, 4);
    ctx.stroke();
    // Trim brackets on the selected scene strip — same affordance as clips,
    // so the resize edges are visible instead of an invisible 10px zone.
    drawClipTrimHandles(ctx, x, y, w, h, true, false);
  }
}

// ── Status dot ────────────────────────────────────────────

function drawStatusDot(ctx: CanvasRenderingContext2D, status: string, cx: number, cy: number) {
  const r = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  switch (status) {
    case "video_ready":
      ctx.fillStyle = COLORS.statusReady;
      break;
    case "images_ready":
      ctx.fillStyle = COLORS.statusImages;
      break;
    case "images_generating":
    case "video_generating":
      ctx.fillStyle = COLORS.statusGenerating;
      break;
    case "face_swapping":
      ctx.fillStyle = COLORS.statusFaceSwap;
      break;
    case "planned":
      ctx.fillStyle = COLORS.statusPlanned;
      break;
    default:
      ctx.fillStyle = COLORS.statusDefault;
  }
  ctx.fill();
}

// ── Music track on A1 ─────────────────────────────────────

function drawMusicTrack(
  ctx: CanvasRenderingContext2D,
  state: CanvasState,
  a1Layout: TrackLayoutEntry,
  waveformCache?: { get(url: string): WaveformData | undefined },
) {
  if (!state.musicUrl) return;

  const x = 2;
  const y = RULER_HEIGHT + a1Layout.y + 2;
  const w = Math.max(state.totalDuration * state.zoom - 4, 4);
  const h = a1Layout.height - 4;
  const isSelected = state.selectedAudioTarget === "music";
  const vol = state.musicVolume;
  const volPct = vol;

  // Clip background
  roundRect(ctx, x, y, w, h, 2);
  ctx.fillStyle = COLORS.musicFill;
  ctx.fill();
  ctx.strokeStyle = isSelected ? COLORS.musicBorderSelected : COLORS.musicBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Volume fill
  const fillH = h * volPct;
  ctx.save();
  roundRect(ctx, x, y, w, h, 2);
  ctx.clip();
  ctx.fillStyle = COLORS.musicVolumeFill;
  ctx.fillRect(x, y + h - fillH, w, fillH);
  ctx.restore();

  // Volume line
  const volY = y + h - fillH;
  ctx.strokeStyle = COLORS.musicVolumeLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, volY);
  ctx.lineTo(x + w, volY);
  ctx.stroke();

  // Volume label
  const volLabel = `${Math.round(vol * 100)}%`;
  ctx.font = "bold 7px -apple-system, system-ui, sans-serif";
  ctx.fillStyle = "rgba(16, 185, 129, 0.8)";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "right";
  ctx.fillText(volLabel, x + w - 4, volY - 2);

  // Waveform (real or fake)
  const waveData = waveformCache?.get(state.musicUrl);
  ctx.save();
  roundRect(ctx, x, y, w, h, 2);
  ctx.clip();

  if (waveData) {
    drawRealWaveform(ctx, waveData, x, y + h - fillH, w, fillH, COLORS.musicWaveform);
  } else {
    drawFakeWaveform(ctx, x, y + h - fillH, w, fillH, COLORS.musicWaveform, vol);
  }
  ctx.restore();

  // Music icon
  ctx.fillStyle = COLORS.audio.text;
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText("\u266A", x + 4, y + h - fillH + 14);
}

// ── Voiceovers on A1 ──────────────────────────────────────

// After split-by-speaker the backend points scene.audioUrl at a generated
// "-silence" file purely to keep the embedded video audio suppressed while
// the real voices live as timeline clips. It carries no user content, so the
// timeline must not draw (or hit-test) a voiceover block for it.
export function isSilencePlaceholderSceneAudio(scene: Pick<SceneData, "audioUrl">): boolean {
  const pathname = (scene.audioUrl || "").split(/[?#]/)[0];
  // Match only the backend's generated placeholder (upload_audio with
  // suffix="-silence" → generated/audio-ai/<uuid4>-silence.<ext>), never a
  // user upload that merely contains "silence" in its filename.
  return /\/generated\/audio-ai\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-silence\.[a-z0-9]+$/i.test(pathname);
}

function drawVoiceovers(ctx: CanvasRenderingContext2D, state: CanvasState, a1Layout: TrackLayoutEntry) {
  const { scenes, zoom, selectedAudioTarget, unlockedVoiceovers, voiceoverOffsets } = state;
  let cumTime = 0;

  for (const scene of scenes) {
    const dur = getSceneDuration(scene);
    const startTime = cumTime;
    cumTime += dur;

    if (!scene.audioUrl || isSilencePlaceholderSceneAudio(scene)) continue;
    // Podcast scenes with a rendered video: the voiceover is baked into the
    // video itself — a separate VO strip is redundant noise, hide it.
    if (scene.cardType === "podcast" && scene.videoUrl) continue;

    const offset = voiceoverOffsets.get(scene.id) || 0;
    const voTime = startTime + offset;
    const x = voTime * zoom + 2;
    const w = Math.max(dur * zoom - 4, 16);
    const y = RULER_HEIGHT + a1Layout.y + 2;
    const h = a1Layout.height - 4;
    const isVoSelected = selectedAudioTarget != null && typeof selectedAudioTarget === "object" && selectedAudioTarget.sceneId === scene.id;
    const isUnlocked = unlockedVoiceovers.has(scene.id);

    // Background
    roundRect(ctx, x, y, w, h, 3);
    ctx.fillStyle = COLORS.voiceover.fill;
    ctx.fill();
    ctx.strokeStyle = isVoSelected ? "rgba(255, 255, 255, 0.5)" : COLORS.voiceover.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Character circle with "VO" initials
    const circleR = Math.min(8, (h - 4) / 2);
    const circleX = x + 4 + circleR;
    const circleY = y + h / 2;
    ctx.beginPath();
    ctx.arc(circleX, circleY, circleR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fill();
    ctx.font = `bold ${Math.max(7, circleR)}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("VO", circleX, circleY + 0.5);

    // Transcription text
    const textLeft = circleX + circleR + 4;
    const lockSpace = 18;
    const availTextW = w - (textLeft - x) - lockSpace;
    if (availTextW > 20 && scene.audioText) {
      ctx.font = "8px -apple-system, system-ui, sans-serif";
      ctx.fillStyle = COLORS.voiceover.label;
      ctx.textAlign = "left";
      const maxChars = Math.floor(availTextW / 4.5);
      const text = scene.audioText.length > maxChars ? scene.audioText.slice(0, maxChars) + "\u2026" : scene.audioText;
      ctx.fillText(text, textLeft, y + h / 2);
    }

    // Lock/unlock icon (right side)
    const lockSize = 10;
    const lockX = x + w - lockSize - 5;
    const lockY = y + h / 2;
    ctx.save();
    ctx.fillStyle = isUnlocked ? "rgba(250, 204, 21, 0.7)" : "rgba(167, 139, 250, 0.5)";
    ctx.strokeStyle = isUnlocked ? "rgba(250, 204, 21, 0.7)" : "rgba(167, 139, 250, 0.5)";
    ctx.lineWidth = 1.2;

    if (isUnlocked) {
      // Open lock icon
      const lw = lockSize * 0.6;
      const lh = lockSize * 0.45;
      const lx = lockX - lw / 2;
      const ly = lockY + 0.5;
      // Lock body
      ctx.fillRect(lx, ly, lw, lh);
      // Shackle (open)
      ctx.beginPath();
      ctx.arc(lockX, ly - 1, lw * 0.35, Math.PI, 0);
      ctx.stroke();
    } else {
      // Closed lock icon
      const lw = lockSize * 0.6;
      const lh = lockSize * 0.45;
      const lx = lockX - lw / 2;
      const ly = lockY + 0.5;
      // Lock body
      ctx.fillRect(lx, ly, lw, lh);
      // Shackle (closed)
      ctx.beginPath();
      ctx.arc(lockX, ly - 1, lw * 0.35, Math.PI, Math.PI * 2);
      ctx.lineTo(lockX + lw * 0.35, ly);
      ctx.moveTo(lockX - lw * 0.35, ly - 1);
      ctx.lineTo(lockX - lw * 0.35, ly);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ── Extra clip body ───────────────────────────────────────

// Remotion graphics clip status that needs a visible chip treatment.
// Exported for unit tests.
export function getRemotionClipStatus(
  clip: Pick<TimelineClip, "trackType" | "remotionStatus">,
): "generating" | "error" | null {
  if (clip.trackType !== "remotion") return null;
  if (clip.remotionStatus === "generating") return "generating";
  if (clip.remotionStatus === "error") return "error";
  return null;
}

// Everything inside the clip's rounded rect that does NOT depend on
// selection/hover — the cacheable part. Drawn either straight onto the main
// canvas (fallback) or into an OffscreenCanvas at origin for the render cache.
/** Small media-type badge (top-left box + glyph) — the same visual language
 *  as V1 scene strips, so every video-lane clip carries a type icon. */
function drawClipMediaTypeBadge(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number,
  kind: "video" | "image",
  accent: string,
) {
  if (w <= 28) return;
  const bx = x + 5;
  const by = y + 3;
  const bw = 16;
  const bh = 12;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, bx, by, bw, bh, 2);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 0.8;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  if (kind === "image") {
    // Mountain-in-frame
    ctx.strokeRect(cx - 4, cy - 3, 8, 6);
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy + 2);
    ctx.lineTo(cx - 1, cy);
    ctx.lineTo(cx + 1, cy + 1);
    ctx.lineTo(cx + 3, cy - 1);
    ctx.stroke();
  } else {
    // Play triangle in rect
    ctx.strokeRect(cx - 4, cy - 3, 8, 6);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy - 2);
    ctx.lineTo(cx + 2, cy);
    ctx.lineTo(cx - 1, cy + 2);
    ctx.closePath();
    ctx.fill();
  }
}

function drawClipBodyContent(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  x: number, y: number, w: number, h: number,
  waveformCache?: { get(url: string): WaveformData | undefined },
  thumbnailCache?: { get(url: string, time: number): ImageBitmap | undefined },
) {
  const colors = getClipColors(clip.trackType);
  const remotionStatus = getRemotionClipStatus(clip);

  ctx.save();

  // Clip region
  roundRect(ctx, x, y, w, h, 2);
  ctx.clip();

  // Fill
  ctx.fillStyle = colors.fill;
  ctx.fillRect(x, y, w, h);

  // Remotion error — red tint so a broken graphic reads at a glance.
  if (remotionStatus === "error") {
    ctx.fillStyle = "rgba(239, 68, 68, 0.16)";   // red-500/16
    ctx.fillRect(x, y, w, h);
  }

  // Audio waveform
  if (clip.trackType === "audio" && clip.mediaUrl && waveformCache) {
    const waveData = waveformCache.get(clip.mediaUrl);
    if (waveData) {
      drawRealWaveform(ctx, waveData, x, y, w, h, colors.text, clip);
    } else {
      drawFakeWaveform(ctx, x, y, w, h, colors.text, clip.volume);
    }
  } else if (clip.trackType === "audio") {
    drawFakeWaveform(ctx, x, y, w, h, colors.text, clip.volume);
  }

  // Frame filmstrip for video/sticker clips — CapCut-style strip of frames
  // sampled across the clip. Falls back to a small placeholder box while the
  // frames are still being decoded by the thumbnail cache.
  if ((clip.trackType === "video" || clip.trackType === "sticker") && thumbnailCache) {
    const plan = planClipFilmstrip(clip, w);
    if (plan) {
      const count = plan.times.length;
      let drewAny = false;
      for (let i = 0; i < count; i++) {
        const sliceX = x + (w / count) * i;
        const sliceW = i === count - 1 ? x + w - sliceX : w / count;
        const bitmap = thumbnailCache.get(plan.url, plan.isVideo ? plan.times[i] : 0);
        if (!bitmap) continue;
        const imgAspect = bitmap.width / bitmap.height;
        const sliceAspect = sliceW / h;
        let sw = bitmap.width, sh = bitmap.height, sx = 0, sy = 0;
        if (imgAspect > sliceAspect) {
          sw = bitmap.height * sliceAspect;
          sx = (bitmap.width - sw) / 2;
        } else {
          sh = bitmap.width / sliceAspect;
          sy = (bitmap.height - sh) / 2;
        }
        ctx.drawImage(bitmap, sx, sy, sw, sh, sliceX, y, sliceW, h);
        drewAny = true;
      }
      if (drewAny) {
        // Subtle darken so the clip label stays legible over the frames.
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fillRect(x, y, w, h);
      } else if (clip.thumbnailUrl) {
        const thumbSize = Math.min(h - 4, 32);
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fillRect(x + 2, y + (h - thumbSize) / 2, thumbSize, thumbSize);
      }
      // Media-type badge — every video-lane clip carries the same top-left
      // icon language as the V1 scene strips (play = video, mountain = image).
      if (clip.trackType === "video") {
        drawClipMediaTypeBadge(
          ctx, x, y, w,
          plan.isVideo ? "video" : "image",
          plan.isVideo ? "rgba(56, 189, 248, 0.95)" : "rgba(52, 211, 153, 0.95)",
        );
      }
    } else if (clip.thumbnailUrl) {
      const thumbSize = Math.min(h - 4, 32);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(x + 2, y + (h - thumbSize) / 2, thumbSize, thumbSize);
    }
  }

  // Label
  if (w > 40) {
    ctx.font = "8px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = colors.label;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let labelX = x + 6;
    const textKind = clip.trackType === "text" ? getTimelineTextClipKind(clip.textStyle, clip.label) : "text";
    if (clip.trackType === "text" && textKind !== "text" && w > 54) {
      ctx.fillStyle = textKind === "caption" ? "rgba(0,132,154,0.85)" : "rgba(30,91,168,0.85)";
      ctx.beginPath();
      ctx.roundRect(x + 5, y + h / 2 - 6, 17, 12, 3);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 6px -apple-system, system-ui, sans-serif";
      ctx.fillText(textKind === "caption" ? "CC" : "SUB", x + 7, y + h / 2 + 0.5);
      ctx.font = "8px -apple-system, system-ui, sans-serif";
      ctx.fillStyle = colors.label;
      labelX = x + 27;
    }
    // Text clips show their actual on-screen words (scannable subtitle track);
    // other clips show their name.
    const label = clip.trackType === "text"
      ? (clip.textContent || clip.label || getDefaultLabel(clip.trackType))
      : (clip.label || clip.textContent || getDefaultLabel(clip.trackType));
    const maxChars = Math.floor(Math.max(0, w - (labelX - x) - 8) / 5);
    const truncated = label.length > maxChars ? label.slice(0, maxChars) + "..." : label;
    ctx.fillText(truncated, labelX, y + h / 2);
  }

  // Text clip color accent
  if (clip.trackType === "text") {
    const textKind = getTimelineTextClipKind(clip.textStyle, clip.label);
    let accentColor = textKind === "caption" ? "#00849a" : textKind === "subtitle" ? "#1e5ba8" : "#F59E0B";
    if (clip.textStyle) {
      const style = parseCachedTextStyle(clip.textStyle);
      if (typeof style.color === "string" && style.color) accentColor = style.color;
    }
    ctx.fillStyle = accentColor + "40";
    ctx.fillRect(x, y + h - 2, w, 2);
  }

  // Volume badge for audio clips
  if (clip.trackType === "audio" && w > 50 && clip.volume !== 1) {
    ctx.font = "7px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = colors.text;
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(clip.volume * 100)}%`, x + w - 4, y + 3);
  }

  // Opacity badge for non-audio clips
  if (clip.trackType !== "audio" && w > 40 && clip.opacity < 1) {
    ctx.font = "7px -apple-system, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(clip.opacity * 100)}%`, x + w - 4, y + 3);
  }

  // Remotion status glyph (right side) — spinner arc while the AI generates,
  // mini warning triangle on error. Static glyphs: the canvas only repaints on
  // state changes, so an animated pulse would never advance between renders.
  if (remotionStatus && w > 24) {
    const gx = x + w - 9;
    const gy = y + h / 2;
    if (remotionStatus === "generating") {
      ctx.strokeStyle = COLORS.statusGenerating;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(gx, gy, 4, -Math.PI / 2, Math.PI);
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(248, 113, 113, 0.95)";  // red-400
      ctx.beginPath();
      ctx.moveTo(gx, gy - 4);
      ctx.lineTo(gx + 4, gy + 3.5);
      ctx.lineTo(gx - 4, gy + 3.5);
      ctx.closePath();
      ctx.fill();
      // Exclamation mark inside the triangle.
      ctx.fillStyle = "rgba(10, 10, 11, 0.9)";
      ctx.fillRect(gx - 0.5, gy - 1.5, 1, 3);
      ctx.fillRect(gx - 0.5, gy + 2, 1, 1);
    }
  }

  drawClipKeyframeMarkers(ctx, clip, x, y, w, h);

  ctx.restore();
}

// Cheap probe: how many of the clip's async media pieces are ready. Part of
// the render-cache key so thumbnail/waveform arrivals invalidate the bitmap.
function getClipMediaVersion(
  clip: TimelineClip,
  w: number,
  waveformCache?: { get(url: string): WaveformData | undefined },
  thumbnailCache?: { get(url: string, time: number): ImageBitmap | undefined },
): number {
  if (clip.trackType === "audio") {
    // Key on peak-array identity (length), not mere presence — a refined
    // waveform can replace the cache entry for the same URL and must repaint.
    const waveData = clip.mediaUrl ? waveformCache?.get(clip.mediaUrl) : undefined;
    return waveData ? waveData.peaks.length : 0;
  }
  if ((clip.trackType === "video" || clip.trackType === "sticker") && thumbnailCache) {
    const plan = planClipFilmstrip(clip, w);
    if (!plan) return 0;
    let loaded = 0;
    for (const time of plan.times) {
      if (thumbnailCache.get(plan.url, plan.isVideo ? time : 0)) loaded++;
    }
    return loaded;
  }
  return 0;
}

function getClipContentKey(clip: TimelineClip): string {
  return [
    clip.trackType, clip.mediaType, clip.mediaUrl, clip.thumbnailUrl,
    clip.label, clip.textContent, clip.textStyle,
    clip.volume, clip.opacity, clip.playbackSpeed,
    clip.trimStart, clip.trimEnd,
    Math.round((clip.endTime - clip.startTime) * 1000),
    clip.keyframesJson, getRemotionClipStatus(clip) ?? "",
  ].join("|");
}

function drawClipBody(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  x: number, y: number, w: number, h: number,
  isSelected: boolean,
  isHovered: boolean,
  waveformCache?: { get(url: string): WaveformData | undefined },
  thumbnailCache?: { get(url: string, time: number): ImageBitmap | undefined },
) {
  const colors = getClipColors(clip.trackType);
  const remotionStatus = getRemotionClipStatus(clip);

  // Body via the offscreen render cache: one drawImage per frame instead of
  // re-rasterizing filmstrip slices, waveform peaks, and text every redraw.
  const dpr = (typeof ctx.getTransform === "function" ? ctx.getTransform()?.a : 1) || 1;
  const key = clipCacheKey({
    clipId: clip.id,
    widthPx: w,
    heightPx: h,
    dpr,
    contentKey: getClipContentKey(clip),
    mediaVersion: getClipMediaVersion(clip, w, waveformCache, thumbnailCache),
  });
  let bitmap = getCachedClipBitmap(key);
  if (!bitmap) {
    bitmap = renderClipToCache(key, w, h, dpr, (offCtx) => {
      drawClipBodyContent(
        offCtx as unknown as CanvasRenderingContext2D,
        clip, 0, 0, w, h, waveformCache, thumbnailCache,
      );
    });
  }
  if (bitmap) {
    ctx.drawImage(bitmap, x, y, w, h);
  } else {
    // OffscreenCanvas unavailable — draw straight onto the main canvas.
    drawClipBodyContent(ctx, clip, x, y, w, h, waveformCache, thumbnailCache);
  }

  // Border
  ctx.strokeStyle = remotionStatus === "error" ? "rgba(248, 113, 113, 0.55)" : colors.border;
  ctx.lineWidth = 0.5;
  roundRect(ctx, x, y, w, h, 2);
  ctx.stroke();

  // Selection ring
  if (isSelected) {
    ctx.strokeStyle = COLORS.selectionRing;
    ctx.lineWidth = 2;
    roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 3);
    ctx.stroke();
  }

  drawClipTrimHandles(ctx, x, y, w, h, isSelected, isHovered);
}

/** CapCut/RVE-style trim brackets: solid rounded pills on each end of the
 *  selected clip (with a dark grip notch), translucent on hover. Sized to
 *  RESIZE_ZONE so the visible handle IS the grab zone. */
export function drawClipTrimHandles(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  isSelected: boolean,
  isHovered: boolean,
) {
  if (!isSelected && !isHovered) return;
  const handleW = RESIZE_ZONE - 3;
  // A clip narrower than three handle widths would be all-handle: when
  // SELECTED, draw the handles just OUTSIDE the strip instead (matching the
  // hit-detector's outer grab zones) so tiny clips stay resizable without
  // zooming in first.
  const narrow = w < RESIZE_ZONE * 3;
  if (narrow && !isSelected) return;
  const leftX = narrow ? x - handleW - 1 : x;
  const rightX = narrow ? x + w + 1 : x + w - handleW;
  ctx.fillStyle = isSelected ? COLORS.selectionRing : "rgba(255, 255, 255, 0.35)";
  roundRect(ctx, leftX, y - 1, handleW, h + 2, 3);
  ctx.fill();
  roundRect(ctx, rightX, y - 1, handleW, h + 2, 3);
  ctx.fill();
  if (narrow) return;

  // Grip notch — the vertical dark line that reads as "grab me".
  if (isSelected && h >= 14) {
    const notchH = Math.min(h * 0.45, 14);
    const notchY = y + (h - notchH) / 2;
    ctx.fillStyle = "rgba(10, 10, 11, 0.75)";
    roundRect(ctx, x + handleW / 2 - 0.75, notchY, 1.5, notchH, 1);
    ctx.fill();
    roundRect(ctx, x + w - handleW / 2 - 0.75, notchY, 1.5, notchH, 1);
    ctx.fill();
  }
}

function drawClipKeyframeMarkers(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  drawKeyframeMarkers(ctx, getClipKeyframeMarkerTimes(clip), Math.max(0.001, clip.endTime - clip.startTime), x, y, w, h, null);
}

/** A keyframe within one frame (30 fps) of the playhead is "under" it (the inspector's rule). */
export const KEYFRAME_PLAYHEAD_TOLERANCE = 1 / 30;
export const KEYFRAME_MARKER_ACTIVE = "rgba(255, 255, 255, 1)";

export interface KeyframeMarker {
  cx: number;
  /** The keyframe under the playhead (at most one: the closest). */
  active: boolean;
}

/**
 * Marker centres for item-local keyframe `times` of an item drawn at x..x+w, skipping those under the
 * item's edges; `localPlayhead` (item-local seconds, null when unknown) marks the closest one within a frame.
 */
export function planKeyframeMarkers(times: number[], duration: number, x: number, w: number, localPlayhead: number | null): KeyframeMarker[] {
  const d = Math.max(0.001, duration);
  let activeIndex = -1;
  if (localPlayhead !== null) {
    let best = KEYFRAME_PLAYHEAD_TOLERANCE + 1e-9;
    times.forEach((time, i) => {
      const distance = Math.abs(time - localPlayhead);
      if (distance <= best) {
        best = distance;
        activeIndex = i;
      }
    });
  }
  const out: KeyframeMarker[] = [];
  times.forEach((time, i) => {
    const cx = x + (time / d) * w;
    if (cx < x + 3 || cx > x + w - 3) return;
    out.push({ cx, active: i === activeIndex });
  });
  return out;
}

/** Diamond centres sit this far above the bottom of the item's strip. */
export const KEYFRAME_MARKER_INSET = 7;

/** Diamonds are drawn (and hit) only on strips at least this wide and tall. */
const KEYFRAME_MIN_W = 10;
const KEYFRAME_MIN_H = 12;

export function keyframeMarkerSize(h: number): number {
  return Math.max(2.5, Math.min(4, h * 0.12));
}

/** The selected clip or scene whose diamonds are interactive: its strip (world px), start, length, and keyframe times. */
export interface KeyframeItemGeometry {
  clipId?: string;
  sceneId?: string;
  /** Timeline seconds. */
  start: number;
  duration: number;
  times: number[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The single selected clip (or, with no clip selected, the selected scene) as drawn, when its diamonds are
 * shown and editable: null for locked or hidden tracks, locked clips, strips too small for diamonds, or no keyframes.
 */
export function getKeyframeItemGeometry(state: CanvasState): KeyframeItemGeometry | null {
  const { zoom, tracks } = state;
  if (state.selectedClipIds.size === 1) {
    const id = state.selectedClipIds.values().next().value;
    const clip = state.clips.find((c) => c.id === id);
    if (!clip || clip.locked || !clip.keyframesJson) return null;
    const layout = tracks.find((t) => t.key === `${clip.trackType}-${clip.trackIndex}`);
    if (!layout || layout.visible === false || layout.locked) return null;
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const times = getCachedClipKeyframeTimes(clip.keyframesJson, duration);
    const geometry = {
      clipId: clip.id, start: clip.startTime, duration, times,
      x: clip.startTime * zoom, y: RULER_HEIGHT + layout.y + 2, w: Math.max(duration * zoom, 4), h: layout.height - 4,
    };
    return times.length > 0 && geometry.w >= KEYFRAME_MIN_W && geometry.h >= KEYFRAME_MIN_H ? geometry : null;
  }
  if (state.selectedClipIds.size > 0 || !state.selectedSceneId) return null;
  const index = state.scenes.findIndex((s) => s.id === state.selectedSceneId);
  const scene = index >= 0 ? state.scenes[index] : null;
  if (!scene?.keyframesJson) return null;
  const layout = tracks.find((t) => t.type === "video" && t.index === (scene.trackIndex || 1));
  if (!layout || layout.visible === false || layout.locked) return null;
  const duration = getSceneDuration(scene);
  const start = getSceneStart(scene, state.scenes, index);
  const times = getCachedClipKeyframeTimes(scene.keyframesJson, duration);
  const geometry = {
    sceneId: scene.id, start, duration, times,
    x: start * zoom, y: RULER_HEIGHT + layout.y + 2, w: Math.max(duration * zoom, 2), h: layout.height - 4,
  };
  return times.length > 0 && geometry.w >= KEYFRAME_MIN_W && geometry.h >= KEYFRAME_MIN_H ? geometry : null;
}

const sameItem = (a: { clipId?: string; sceneId?: string }, b: { clipId?: string; sceneId?: string }) =>
  (a.clipId ?? null) === (b.clipId ?? null) && (a.sceneId ?? null) === (b.sceneId ?? null);

/** A white diamond with a dark gap and a selection ring (the selected keyframe, or the retime ghost). */
function drawSelectedKeyframeDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const s = size + 1;
  const diamond = (r: number) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
  };
  ctx.lineWidth = 2;
  diamond(s + 3.5);
  ctx.strokeStyle = COLORS.selectionRing;
  ctx.stroke();
  diamond(s + 1.5);
  ctx.strokeStyle = COLORS.selectionRingOffset;
  ctx.stroke();
  diamond(s);
  ctx.fillStyle = KEYFRAME_MARKER_ACTIVE;
  ctx.fill();
}

/** The selected keyframe (white with a ring) or, while one is dragged, its ghost at the new time with a guide and a time badge. */
function drawKeyframeOverlay(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const selected = state.selectedKeyframe ?? null;
  const dragging = state.keyframeDrag ?? null;
  const focused = state.focusedKeyframe ?? null;
  if (!selected && !dragging && !focused) return;
  const geometry = getKeyframeItemGeometry(state);
  if (!geometry) return;
  const { x, y, w, h, duration } = geometry;
  const d = Math.max(0.001, duration);
  const cy = y + h - KEYFRAME_MARKER_INSET;
  const size = keyframeMarkerSize(h);
  ctx.save();
  if (dragging && sameItem(dragging, geometry)) {
    const cx = x + (Math.min(d, Math.max(0, dragging.to)) / d) * w;
    ctx.strokeStyle = COLORS.snapLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx, y + h);
    ctx.stroke();
    drawSelectedKeyframeDiamond(ctx, cx, cy, size);
    // Above the strip (badgeTopY's rule: inside it on the top row, where "above" is the ruler).
    const above = y - 2 - 17;
    drawBadge(ctx, state, `${dragging.to.toFixed(2)}s`, cx, above >= RULER_HEIGHT + 2 ? above : y + 2);
  } else {
    const focusTime = focused && sameItem(focused, geometry) ? findKeyframeTime(geometry.times, focused.time) : undefined;
    if (selected && sameItem(selected, geometry)) {
      const time = findKeyframeTime(geometry.times, selected.time);
      if (time !== undefined) {
        const cx = x + (time / d) * w;
        if (cx >= x + 3 && cx <= x + w - 3) drawSelectedKeyframeDiamond(ctx, cx, cy, size);
        // A keyboard-focused diamond under the item's edge is not drawn otherwise: show it just inside.
        else if (focusTime === time) drawSelectedKeyframeDiamond(ctx, Math.min(x + w - 3, Math.max(x + 3, cx)), cy, size);
      }
    }
    if (focusTime !== undefined) drawKeyframeFocusRing(ctx, Math.min(x + w - 3, Math.max(x + 3, x + (focusTime / d) * w)), cy, size);
  }
  ctx.restore();
}

const findKeyframeTime = (times: number[], time: number) => times.find((t) => Math.abs(t - time) <= 0.001 + 1e-9);

/** Keyboard focus: a ring in the theme's focus color outside the selection ring (phase 10d). */
function drawKeyframeFocusRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const r = size + 1 + 6.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.focusRing;
  ctx.stroke();
}

function drawKeyframeDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, active: boolean) {
  const s = active ? size + 1 : size;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s, cy);
  ctx.lineTo(cx, cy + s);
  ctx.lineTo(cx - s, cy);
  ctx.closePath();
  ctx.fillStyle = active ? KEYFRAME_MARKER_ACTIVE : COLORS.marker;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.stroke();
}

/**
 * Diamonds along the bottom of an item. `localPlayhead` set: every marker, the one under the playhead
 * filled white; `onlyActive`: just that one (drawn over a cached clip body that already has the others).
 */
function drawKeyframeMarkers(
  ctx: CanvasRenderingContext2D,
  times: number[],
  duration: number,
  x: number,
  y: number,
  w: number,
  h: number,
  localPlayhead: number | null,
  onlyActive = false,
) {
  if (times.length === 0 || w < KEYFRAME_MIN_W || h < KEYFRAME_MIN_H) return;
  const markers = planKeyframeMarkers(times, duration, x, w, localPlayhead);
  const cy = y + h - KEYFRAME_MARKER_INSET;
  const size = keyframeMarkerSize(h);
  ctx.save();
  ctx.lineWidth = 1;
  for (const marker of markers) {
    if (onlyActive && !marker.active) continue;
    drawKeyframeDiamond(ctx, marker.cx, cy, size, marker.active);
  }
  ctx.restore();
}

function getDefaultLabel(trackType: string): string {
  switch (trackType) {
    case "video": return "Clip";
    case "audio": return "Audio";
    case "text": return "Text";
    case "sticker": return "Image";
    case "effect": return "Effect";
    case "remotion": return "Graphics";
    default: return "Clip";
  }
}

// ── Waveform drawing ──────────────────────────────────────

function drawRealWaveform(
  ctx: CanvasRenderingContext2D,
  data: WaveformData,
  x: number, y: number, w: number, h: number,
  color: string,
  clip?: Pick<TimelineClip, "trimStart" | "trimEnd">,
) {
  // Only the TRIMMED source window is audible — map the strip onto the
  // clip's [trimStart, trimEnd) peaks (source seconds, same basis the preview
  // uses when seeking clip audio), not the whole source file.
  const trimStart = Math.max(0, Number(clip?.trimStart) || 0);
  const rawTrimEnd = Number(clip?.trimEnd);
  const trimEnd = Number.isFinite(rawTrimEnd) && rawTrimEnd > trimStart ? rawTrimEnd : data.duration;
  const startPeak = Math.min(data.peaks.length - 1, Math.max(0, Math.floor(trimStart * data.sampleRate)));
  const endPeak = Math.min(data.peaks.length, Math.max(startPeak + 1, Math.ceil(trimEnd * data.sampleRate)));
  const windowLength = endPeak - startPeak;

  const barCount = Math.max(1, Math.floor(w / 3));
  const samplesPerBar = windowLength / barCount;

  ctx.fillStyle = color;
  for (let i = 0; i < barCount; i++) {
    const sampleIdx = Math.min(startPeak + Math.floor(i * samplesPerBar), endPeak - 1);
    const peak = data.peaks[sampleIdx];
    const barH = Math.max(2, peak * h * 0.8);
    const barX = x + (i / barCount) * w;
    ctx.fillRect(barX, y + h - barH, 2, barH);
  }
}

function drawFakeWaveform(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  color: string,
  volume: number,
) {
  const barCount = Math.max(1, Math.floor(w / 3));
  ctx.fillStyle = color;

  for (let i = 0; i < barCount; i++) {
    const val = 6 + Math.abs(Math.sin(i * 1.3) * 18 + Math.sin(i * 0.7) * 12 + Math.cos(i * 2.1) * 8);
    const barH = Math.min(val * volume, h);
    const barX = x + (i / barCount) * w;
    ctx.fillRect(barX, y + h - barH, 2, barH);
  }
}

// ── Scene move tooltip (yellow, shown while dragging a scene strip) ────

function formatTimeDetailed(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  // Show 1 decimal so the user can place to tenths of a second.
  return `${m}:${rem.toFixed(1).padStart(4, "0")}`;
}

function drawSceneMoveTooltip(
  ctx: CanvasRenderingContext2D,
  ghostX: number,
  ghostY: number,
  ghostH: number,
  startTime: number,
  duration: number,
) {
  const line1 = `Start ${formatTimeDetailed(startTime)}`;
  const line2 = `End ${formatTimeDetailed(startTime + duration)}`;

  ctx.save();
  ctx.font = "bold 10px -apple-system, system-ui, sans-serif";
  const boxW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 12;
  const boxH = 28;
  const dpr = currentDevicePixelRatio;
  const canvasW = ctx.canvas.width / dpr;
  const boxX = Math.max(2, Math.min(ghostX + 4, canvasW - boxW - 2));
  let boxY = ghostY - boxH - 4;
  if (boxY < 2) boxY = ghostY + ghostH + 4;

  ctx.fillStyle = "rgba(15, 15, 20, 0.92)";
  roundRect(ctx, boxX, boxY, boxW, boxH, 4);
  ctx.fill();
  ctx.strokeStyle = "rgba(251, 191, 36, 0.7)";
  ctx.lineWidth = 1;
  roundRect(ctx, boxX, boxY, boxW, boxH, 4);
  ctx.stroke();

  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(251, 191, 36, 1)";
  ctx.fillText(line1, boxX + 6, boxY + 4);
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.fillText(line2, boxX + 6, boxY + 16);
  ctx.restore();
}

// ── 9. Snap guide line ────────────────────────────────────

function drawVerticalTimelineGuide(
  ctx: CanvasRenderingContext2D,
  state: CanvasState,
  time: number,
  color: string,
  shadow: string,
  dashed: boolean,
) {
  const x = time * state.zoom;
  const totalH = state.tracks.reduce((h, t) => Math.max(h, t.y + t.height), 0); // i18n-ignore

  ctx.save();
  ctx.strokeStyle = shadow;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x, RULER_HEIGHT);
  ctx.lineTo(x, RULER_HEIGHT + totalH);
  ctx.stroke();

  if (dashed) ctx.setLineDash([5, 5]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, RULER_HEIGHT);
  ctx.lineTo(x, RULER_HEIGHT + totalH);
  ctx.stroke();
  ctx.restore();
}

function drawDragAlignmentGuides(ctx: CanvasRenderingContext2D, state: CanvasState, drag: DragState) {
  if (drag.mode !== "move" || !drag.committed || !drag.clipId) return;
  const primary = drag.originals.get(drag.clipId);
  if (!primary) return;

  const rawDt = (drag.currentX - drag.startX) / state.zoom;
  const dt = constrainMoveDelta(
    drag.moveDeltaTime ?? drag.snapDeltaTime ?? rawDt,
    [...drag.originals.values()].map((item) => item.startTime),
  );
  const start = Math.max(0, primary.startTime + dt);
  const end = start + (primary.endTime - primary.startTime);

  drawVerticalTimelineGuide(ctx, state, start, COLORS.alignmentGuide, COLORS.alignmentGuideShadow, true);
  drawVerticalTimelineGuide(ctx, state, end, COLORS.alignmentGuide, COLORS.alignmentGuideShadow, true);
}

function getPrimaryDragPreview(
  drag: DragState,
  state: CanvasState,
): { start: number; end: number; trackKey: string } | null {
  if (drag.mode !== "move" || !drag.committed || !drag.clipId) return null;
  const primary = drag.originals.get(drag.clipId);
  if (!primary) return null;

  const rawDt = (drag.currentX - drag.startX) / state.zoom;
  const dt = constrainMoveDelta(
    drag.moveDeltaTime ?? drag.snapDeltaTime ?? rawDt,
    [...drag.originals.values()].map((item) => item.startTime),
  );
  const start = Math.max(0, primary.startTime + dt);
  const end = start + (primary.endTime - primary.startTime);
  const trackKey = drag.targetTrackKey ?? `${primary.trackType}-${primary.trackIndex}`;
  return { start, end, trackKey };
}

function drawSameTrackDropStatus(ctx: CanvasRenderingContext2D, state: CanvasState, drag: DragState) {
  const preview = getPrimaryDragPreview(drag, state);
  if (!preview) return;

  const track = state.tracks.find((t) => t.key === preview.trackKey);
  if (!track) return;
  const primary = drag.originals.get(drag.clipId!);
  if (!primary) return;

  const thresholdSec = 8 / state.zoom;
  const y = RULER_HEIGHT + track.y + 2;
  const h = track.height - 4;
  let hasContinuity = false;

  ctx.save();
  for (const clip of state.clips) {
    if (drag.originals.has(clip.id)) continue;
    if (`${clip.trackType}-${clip.trackIndex}` !== preview.trackKey) continue;

    const overlapStart = Math.max(preview.start, clip.startTime);
    const overlapEnd = Math.min(preview.end, clip.endTime);
    if (overlapEnd > overlapStart + 0.001) {
      const x = overlapStart * state.zoom;
      const w = Math.max((overlapEnd - overlapStart) * state.zoom, 2);
      ctx.fillStyle = COLORS.overlapGuideFill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = COLORS.overlapGuide;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(w - 1, 1), h - 1);
      continue;
    }

    const touchesPrevious = Math.abs(preview.start - clip.endTime) <= thresholdSec;
    const touchesNext = Math.abs(preview.end - clip.startTime) <= thresholdSec;
    if (!touchesPrevious && !touchesNext) continue;
    hasContinuity = true;

    const seamTime = touchesPrevious ? preview.start : preview.end;
    const x = seamTime * state.zoom;
    ctx.fillStyle = COLORS.continuityGuideFill;
    ctx.fillRect(x - 10, y, 20, h);
    ctx.strokeStyle = COLORS.continuityGuide;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 12, y + h / 2);
    ctx.lineTo(x + 12, y + h / 2);
    ctx.stroke();
  }

  if (hasContinuity) {
    const startX = preview.start * state.zoom;
    const endX = preview.end * state.zoom;
    ctx.strokeStyle = COLORS.continuityGuide;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(startX + 0.5, y + 0.5, Math.max((endX - startX) - 1, 1), h - 1);
  }
  ctx.restore();
}

function formatSnapGuideLabel(
  source: DragState["snapSource"],
  edge: DragState["snapEdge"],
): string | null {
  if (!source) return null;

  const sourceLabels: Record<NonNullable<DragState["snapSource"]>, string> = {
    "clip-start": "Clip start",
    "clip-end": "Clip end",
    "clip-keyframe": "Keyframe",
    "scene-boundary": "Scene edge",
    "playhead": "Playhead",
    "marker": "Marker",
    "beat": "Beat",
  };
  const edgeLabels: Record<NonNullable<DragState["snapEdge"]>, string> = {
    start: "start",
    end: "end",
    resize: "edge",
  };

  return edge ? `${sourceLabels[source]} -> ${edgeLabels[edge]}` : sourceLabels[source];
}

function drawSnapLine(
  ctx: CanvasRenderingContext2D,
  state: CanvasState,
  snapTime: number,
  source: DragState["snapSource"],
  edge: DragState["snapEdge"],
) {
  drawVerticalTimelineGuide(ctx, state, snapTime, COLORS.snapLine, COLORS.snapLineShadow, false);
  const label = formatSnapGuideLabel(source, edge);
  if (!label) return;

  const worldX = snapTime * state.zoom;
  ctx.save();
  ctx.font = "bold 10px -apple-system, system-ui, sans-serif";
  const tw = ctx.measureText(label).width;
  const labelX = worldX + 6;
  const labelY = RULER_HEIGHT + 6;
  ctx.fillStyle = "rgba(0,0,0,0.82)";
  roundRect(ctx, labelX, labelY, tw + 10, 16, 4);
  ctx.fill();
  ctx.fillStyle = COLORS.snapLine;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(label, labelX + 5, labelY + 8);
  ctx.restore();
}

// ── 10. Blade preview line ─────────────────────────────────

function drawBladeLine(ctx: CanvasRenderingContext2D, state: CanvasState, worldX: number) {
  const totalH = state.tracks.reduce((h, t) => Math.max(h, t.y + t.height), 0); // i18n-ignore

  // Vertical line
  ctx.strokeStyle = "rgba(255,100,100,0.8)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(worldX, RULER_HEIGHT);
  ctx.lineTo(worldX, RULER_HEIGHT + totalH);
  ctx.stroke();

  // Time label at top
  const time = worldX / state.zoom;
  const label = formatTime(time);
  ctx.font = "bold 9px -apple-system, system-ui, sans-serif";
  const tw = ctx.measureText(label).width;
  const labelX = worldX - tw / 2 - 3;
  const labelY = RULER_HEIGHT + 4;

  ctx.fillStyle = "rgba(0,0,0,0.8)";
  roundRect(ctx, labelX, labelY, tw + 6, 14, 3);
  ctx.fill();

  ctx.fillStyle = "rgba(255,100,100,0.9)";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(label, worldX, labelY + 7);
}

// ── 11. Ruler ─────────────────────────────────────────────

function drawRuler(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const { zoom, scrollLeft, containerWidth, totalDuration } = state;

  // Background
  ctx.fillStyle = COLORS.rulerBg;
  ctx.fillRect(scrollLeft, 0, containerWidth, RULER_HEIGHT);

  // Bottom border
  ctx.fillStyle = COLORS.trackBorder;
  ctx.fillRect(scrollLeft, RULER_HEIGHT - 0.5, containerWidth, 0.5);

  const tickInterval = getTickInterval(zoom);
  const startTick = Math.floor((scrollLeft / zoom) / tickInterval) * tickInterval;
  const endTick = Math.ceil(((scrollLeft + containerWidth) / zoom) / tickInterval) * tickInterval;

  ctx.font = "7px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";

  for (let t = startTick; t <= Math.min(endTick, totalDuration + tickInterval); t += tickInterval) {
    if (t < 0) continue;
    const x = t * zoom;
    const isMajor = t % (tickInterval * 2) === 0 || tickInterval <= 2;

    ctx.fillStyle = isMajor ? COLORS.rulerTick : COLORS.rulerTickMinor;
    ctx.fillRect(x - 0.5, 0, 1, isMajor ? 10 : 5);

    if (isMajor) {
      ctx.fillStyle = COLORS.rulerText;
      ctx.fillText(formatTime(t), x, 11);
    }
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const markers = state.markers || [];
  if (markers.length === 0) return;

  const { zoom, scrollLeft, containerWidth } = state;
  const totalH = state.tracks.reduce((h, t) => Math.max(h, t.y + t.height), 0) + RULER_HEIGHT; // i18n-ignore
  const viewLeft = scrollLeft - 24;
  const viewRight = scrollLeft + containerWidth + 24;

  ctx.save();
  ctx.font = "7px -apple-system, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const marker of markers) {
    const x = marker.time * zoom;
    if (x < viewLeft || x > viewRight) continue;

    const isActive = state.selectedMarkerId === marker.id;
    ctx.strokeStyle = isActive ? COLORS.selectionRing : COLORS.markerLine;
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, RULER_HEIGHT);
    ctx.lineTo(x, totalH);
    ctx.stroke();

    ctx.fillStyle = COLORS.marker;
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x + 5, 7);
    ctx.lineTo(x + 2, 14);
    ctx.lineTo(x - 2, 14);
    ctx.lineTo(x - 5, 7);
    ctx.closePath();
    ctx.fill();

    if (marker.label && zoom >= 30) {
      ctx.fillStyle = COLORS.markerText;
      ctx.fillText(marker.label, x, 13);
    }
  }

  ctx.restore();
}

// ── 11. Playhead ──────────────────────────────────────────

function drawPlayhead(ctx: CanvasRenderingContext2D, state: CanvasState) {
  const x = state.currentTime * state.zoom;
  const totalH = state.tracks.reduce((h, t) => Math.max(h, t.y + t.height), 0) + RULER_HEIGHT; // i18n-ignore

  // Triangle at top
  ctx.fillStyle = COLORS.playhead;
  ctx.beginPath();
  ctx.moveTo(x - 5, 0);
  ctx.lineTo(x + 5, 0);
  ctx.lineTo(x, 8);
  ctx.closePath();
  ctx.fill();

  // Vertical line
  ctx.strokeStyle = COLORS.playheadAlpha;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, totalH);
  ctx.stroke();
}

// ── Export constants for hit detection ─────────────────────
export { RULER_HEIGHT, TRACK_HEIGHT, TRACK_HEIGHT_SMALL, RESIZE_ZONE, getSceneDuration, getSceneStart, getSceneBoundaries, timeToSeconds };
