// Shared helpers for canvas timeline editing, drag previews, and clip classification.
import type { TimelineClip, TimelineTrack } from "../../model/timeline";
import { getTimelineTextClipKind as getStoredTimelineTextClipKind } from "../../lib/timeline-text-style";
import type { SceneData, TrackLayoutEntry } from "./types";
import { getSceneDuration, getSceneStart } from "./timeline-renderer";

export const EDGE_SCROLL_ZONE = 56;
export const EDGE_SCROLL_STEP = 18;
export const TIMELINE_MEDIA_OVERSCAN_PX = 800;
export const PLAYBACK_SCROLL_EDGE_MARGIN_PX = 80;
export const PLAYBACK_SCROLL_AHEAD_RATIO = 0.32;
/** Width of the sticky track-label column that sits left of the canvas.
 *  The canvas sticks just past it, so world x = canvasX + scrollLeft. */
export const TIMELINE_LABEL_COL_WIDTH = 112;

export function constrainBackwardDelta(deltaSeconds: number, starts: number[], floor: number): number {
  if (deltaSeconds >= 0) return deltaSeconds;
  const minStart = starts.length > 0 ? Math.min(...starts) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(minStart)) return deltaSeconds;
  return Math.max(deltaSeconds, floor - minStart);
}

export function collectCopyVideoPanelCropUrls(shots: unknown[]): string[] {
  const head = shots[0] as {
    copy_video_master_panel_crops?: Record<string, string> | null;
    copy_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
    ai_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
  } | undefined;
  const urls = new Set<string>();
  const addCrops = (panelCrops?: Record<string, string> | null) => {
    if (!panelCrops) return;
    for (const rawUrl of Object.values(panelCrops)) {
      const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (url) urls.add(url);
    }
  };

  addCrops(head?.copy_video_master_panel_crops);
  for (const sheet of head?.copy_video_storyboards || []) {
    addCrops(sheet.panel_crops);
  }
  for (const sheet of head?.ai_video_storyboards || []) {
    addCrops(sheet.panel_crops);
  }
  return [...urls];
}

export function getSceneResizePreview(
  resize: {
    edge: "left" | "right";
    origStart: number;
    origDuration: number;
    startX: number;
    currentX: number;
    /** Longest duration the content behind the scene can fill (source/shot
     *  length minus the current trim-in). Omit/Infinity = no clamp. */
    maxDuration?: number;
    /** Leftmost timeline start the left edge may reach (origStart minus the
     *  current trim-in — the edge can only reveal content that exists). */
    minStart?: number;
    /** Other clip/scene boundary times — the dragged edge magnetizes to the
     *  nearest one within SCENE_RESIZE_SNAP_PX so tracks line up exactly. */
    snapTimes?: number[];
  },
  zoom: number,
) {
  const SNAP_PX = 8;
  const dxSec = (resize.currentX - resize.startX) / zoom;
  const minDuration = 0.5;
  const maxDuration = Number.isFinite(resize.maxDuration as number) && (resize.maxDuration as number) > 0
    ? Math.max(minDuration, resize.maxDuration as number)
    : Number.POSITIVE_INFINITY;
  const snap = (v: number) => Math.round(v * 10) / 10; // i18n-ignore
  const magnetize = (edgeTime: number): number | null => {
    if (!resize.snapTimes || resize.snapTimes.length === 0) return null;
    let best: number | null = null;
    let bestDist = SNAP_PX / zoom;
    for (const t of resize.snapTimes) {
      const d = Math.abs(t - edgeTime);
      if (d < bestDist) { bestDist = d; best = t; }
    }
    return best;
  };
  if (resize.edge === "right") {
    const newStart = resize.origStart;
    let candidateEnd = newStart + snap(resize.origDuration + dxSec);
    const snapTime = magnetize(candidateEnd);
    if (snapTime !== null) candidateEnd = snapTime;
    const newDuration = Math.min(maxDuration, Math.max(minDuration, candidateEnd - newStart));
    const landed = snapTime !== null && Math.abs(newStart + newDuration - snapTime) < 0.001 ? snapTime : null;
    return { newStart, newDuration, deltaEnd: newStart + newDuration - (resize.origStart + resize.origDuration), snapTime: landed };
  }

  const minStart = Math.max(0, resize.minStart ?? 0);
  let candidateStart = snap(resize.origStart + dxSec);
  const snapTime = magnetize(candidateStart);
  if (snapTime !== null) candidateStart = snapTime;
  const newStart = Math.max(minStart, candidateStart);
  const actualDelta = newStart - resize.origStart;
  const newDuration = Math.min(maxDuration, Math.max(minDuration, snap(resize.origDuration - actualDelta)));
  const landed = snapTime !== null && Math.abs(newStart - snapTime) < 0.001 ? snapTime : null;
  return { newStart, newDuration, deltaEnd: newStart + newDuration - (resize.origStart + resize.origDuration), snapTime: landed };
}

export type TimelineMediaDragKind = "video" | "audio" | "image";
export type TimelineLibraryDragKind =
  | "effect"
  | "remotion"
  | "transition"
  | `media-${TimelineMediaDragKind}`
  | null;
export type TimelineDropGhost =
  | { kind: "effect"; x: number; y: number; w: number; h: number; trackMissing: boolean }
  | { kind: "remotion"; x: number; y: number; w: number; h: number; trackMissing: boolean }
  | { kind: "media"; mediaKind: TimelineMediaDragKind; x: number; y: number; w: number; h: number; trackMissing: boolean }
  | { kind: "transition"; x: number; y: number; rowY: number; rowH: number; labelW: number; labelH: number; valid: boolean };

export function areTimelineDropGhostsEqual(left: TimelineDropGhost | null, right: TimelineDropGhost | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;

  if (left.kind === "effect" && right.kind === "effect") {
    return (
      left.x === right.x &&
      left.y === right.y &&
      left.w === right.w &&
      left.h === right.h &&
      left.trackMissing === right.trackMissing
    );
  }

  if (left.kind === "remotion" && right.kind === "remotion") {
    return (
      left.x === right.x &&
      left.y === right.y &&
      left.w === right.w &&
      left.h === right.h &&
      left.trackMissing === right.trackMissing
    );
  }

  if (left.kind === "media" && right.kind === "media") {
    return (
      left.mediaKind === right.mediaKind &&
      left.x === right.x &&
      left.y === right.y &&
      left.w === right.w &&
      left.h === right.h &&
      left.trackMissing === right.trackMissing
    );
  }

  if (left.kind === "transition" && right.kind === "transition") {
    return (
      left.x === right.x &&
      left.y === right.y &&
      left.rowY === right.rowY &&
      left.rowH === right.rowH &&
      left.labelW === right.labelW &&
      left.labelH === right.labelH &&
      left.valid === right.valid
    );
  }

  return false;
}

export function getTimelineLibraryDragKind(dataTransfer: DataTransfer): TimelineLibraryDragKind {
  const dragTypes = Array.from(dataTransfer.types || []);
  if (dragTypes.includes("application/x-effect-layer")) return "effect";
  if (dragTypes.includes("application/x-remotion-graphic")) return "remotion";
  if (dragTypes.includes("application/x-transition-id")) return "transition";
  // Media drags advertise their kind (and optional duration, ";d=<seconds>")
  // in the MIME marker itself because getData() is not readable during
  // dragover — only the type list is.
  const mediaMarker = dragTypes.find((t) => t.startsWith("application/x-timeline-media-"));
  if (mediaMarker) {
    const kind = mediaMarker.slice("application/x-timeline-media-".length).split(";")[0];
    if (kind === "video" || kind === "audio" || kind === "image") return `media-${kind}`;
  }

  const payload = dataTransfer.getData("application/json") || dataTransfer.getData("text/plain");
  if (!payload) return null;

  try {
    const data = JSON.parse(payload);
    return data?.kind === "effect" || data?.kind === "remotion" || data?.kind === "transition" ? data.kind : null;
  } catch {
    return null;
  }
}

/** Duration (seconds) a media drag advertises via its ";d=<seconds>" MIME
 * marker suffix, or null when the source didn't know it. */
export function getTimelineMediaDragDuration(dataTransfer: DataTransfer): number | null {
  const marker = Array.from(dataTransfer.types || []).find((t) => t.startsWith("application/x-timeline-media-"));
  const match = marker?.match(/;d=([\d.]+)/);
  const duration = match ? Number(match[1]) : NaN;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function isTimelineTextEditingTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(element && (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable
  ));
}

export function isTextTimelineClip(clip?: TimelineClip | null): boolean {
  return clip?.trackType === "text";
}

export function isAudioTimelineClip(clip?: TimelineClip | null): boolean {
  return clip?.trackType === "audio";
}

export function isVisualTimelineClip(clip?: TimelineClip | null): boolean {
  return clip?.trackType === "video" || clip?.trackType === "sticker";
}

export type TextTimelineClipMenuAction = "duplicate" | "copy" | "split" | "delete";

export function getTextTimelineClipKind(clip: TimelineClip): "subtitle" | "caption" | "text" {
  return getStoredTimelineTextClipKind(clip.textStyle, clip.label);
}

export function getTextTimelineClipLabelKey(clip: TimelineClip, action: TextTimelineClipMenuAction): string {
  const kind = getTextTimelineClipKind(clip);

  if (kind === "subtitle") {
    if (action === "duplicate") return "duplicateSubtitle";
    if (action === "copy") return "copySubtitle";
    if (action === "split") return "splitSubtitle";
    return "deleteSubtitle";
  }

  if (kind === "caption") {
    if (action === "duplicate") return "duplicateCaption";
    if (action === "copy") return "copyCaption";
    if (action === "split") return "splitCaption";
    return "deleteCaption";
  }

  if (action === "duplicate") return "duplicateText";
  if (action === "copy") return "copyText";
  if (action === "split") return "splitText";
  return "deleteText";
}

export function getEditableCanvasSceneTransitionTarget(
  scenes: SceneData[],
  tracks: TimelineTrack[],
  sceneId: string,
): { scene: SceneData; index: number } | null {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  const scene = sceneIndex >= 0 ? scenes[sceneIndex] : null;
  if (!scene) return null;
  const trackIndex = Number(scene.trackIndex ?? 1);
  if (!Number.isFinite(trackIndex) || trackIndex < 1) return null;
  const track = tracks.find((item) => item.type === "video" && item.index === trackIndex);
  if (!track || track.locked || track.visible === false) return null;
  const sceneEnd = getSceneStart(scene, scenes, sceneIndex) + getSceneDuration(scene);
  const hasAdjacentNextScene = scenes.some((nextScene, nextIndex) => (
    nextScene.id !== scene.id &&
    Number(nextScene.trackIndex ?? 1) === trackIndex &&
    Math.abs(getSceneStart(nextScene, scenes, nextIndex) - sceneEnd) <= 0.001
  ));
  return hasAdjacentNextScene ? { scene, index: sceneIndex } : null;
}

export function isEditableTrackLayout(track: TrackLayoutEntry | undefined): track is TrackLayoutEntry {
  return Boolean(track && !track.locked && track.visible !== false);
}

export function isEditableCanvasSceneTrack(
  scenes: SceneData[],
  tracks: TimelineTrack[],
  sceneId: string,
): boolean {
  const scene = scenes.find((item) => item.id === sceneId);
  if (!scene) return false;
  const trackIndex = Number(scene.trackIndex ?? 1);
  if (!Number.isFinite(trackIndex) || trackIndex < 1) return false;
  const track = tracks.find((item) => item.type === "video" && item.index === trackIndex);
  return Boolean(track && !track.locked && track.visible !== false);
}

export function parseSceneCardConfig(scene: Pick<SceneData, "cardConfig">): Record<string, unknown> {
  if (!scene.cardConfig) return {};
  try {
    const parsed = JSON.parse(scene.cardConfig);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getSceneVoiceoverUrl(scene: Pick<SceneData, "audioUrl" | "cardConfig">): string | null {
  if (scene.audioUrl) return scene.audioUrl;
  const config = parseSceneCardConfig(scene);
  const layers = Array.isArray(config.audio_layers) ? config.audio_layers : [];
  for (const rawLayer of layers) {
    if (!rawLayer || typeof rawLayer !== "object" || Array.isArray(rawLayer)) continue;
    const layer = rawLayer as { type?: unknown; url?: unknown };
    if ((layer.type === "extracted" || layer.type === "voiceover") && typeof layer.url === "string" && layer.url) {
      return layer.url;
    }
  }
  return null;
}
