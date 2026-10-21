"use client";

// Scene preview player for timeline playback, source transforms, and canvas compositing handoff.
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, forwardRef, useImperativeHandle, lazy, Suspense } from "react";
import { useTimelineMessages } from "../hooks/use-timeline-messages";
import { Film, Loader2 } from "lucide-react";
import { useVideoCache } from "../hooks/use-video-cache";
import { useTimelineMedia } from "../hooks/use-timeline-media";
import { useDocumentVisible } from "../hooks/use-document-visible";
import { useEditorStore, useEditorStoreApi } from "../hooks/use-editor-store";
import { sceneSpeedFactor, sceneTimelineSeconds } from "@opennan/timeline-core/timeline/scene-duration";
import { clipMediaStart, isIdentitySpeed, sceneSpeedProfile, sourceTimeAt, speedAt, type SpeedProfile } from "@opennan/timeline-core/motion/speed";
import { applyPitch, cachedClipSpeedProfile, clampRate, mediaTimeAt, resetMediaSync, syncMediaElement, targetRate, type RateTarget } from "./speed-sync";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";
import { getRemotionLayerStyle } from "../remotion/remotion-transform";
import {
  filterPreviewTimelineClips,
  shouldMuteDetachedSourceVideoAtTime,
  timelineOwnsSceneAudioAtTime,
  shouldMuteEmbeddedVideoForTimelineVoiceover,
  timelineAudioHandlesUrlAtTime,
  timelineHasMatchingVoiceoverClip,
  timelineOwnsSceneVoiceoverPlayback,
} from "@opennan/timeline-core/lib/preview-timeline-clips";
import { normalizeTimelineTransitionType } from "@opennan/timeline-core/lib/timeline-editing";
import { getClipKeyframeValuesAtTime } from "@opennan/timeline-core/lib/keyframe-interpolation";
import { getSceneTimelineStart } from "@opennan/timeline-core/timeline/canvas/scene-position";
import { sceneEffectPseudoClips, type SceneEffectEntry } from "@opennan/timeline-media/effects/effect-layer-prep";
import { isBuiltinEffect } from "@opennan/timeline-core/looks/effects";
import { isBuiltinGraphics } from "@opennan/timeline-core/graphics/render";
import { LaneLookOverlay } from "./lane-look-overlay";
import { applySceneMask, sceneMaskLayer } from "./scene-mask-css";
import { cssTransitionRanges } from "./lane-look-plan";
import { lookRendererSupported } from "./use-look-renderer";
import { parseShotBreakdown, totalShotDuration, shotVisualDuration, shotDurationSeconds } from "@opennan/timeline-core/lib/shot-utils";
import { getPreviewScreenFrame } from "./preview-screen-frame";
import { sceneHasMotion, sceneMediaTransform, sceneMotionAt } from "./scene-motion";

// WebGL effect layers render INSIDE the preview compositing stack — above the
// footage, below the Remotion graphics overlay — so an active effect never
// occludes a graphic playing at the same time. Lazy so the GL renderer only
// loads when a project actually has enabled effect clips.
const LazyEffectLayerOverlay = lazy(() =>
  import("./effect-layer-overlay").then((module) => ({ default: module.EffectLayerOverlay })),
);

// Remotion (@remotion/player + all graphics templates + sucrase) is heavy and
// only needed when a project actually has graphics clips on the timeline. Lazy
// so it stays out of the initial editor bundle and loads on first use.
const RemotionTimelineOverlay = lazy(() =>
  import("../remotion/remotion-layer").then((module) => ({ default: module.RemotionTimelineOverlay })),
);
import type { RemotionTransformOverride } from "../remotion/remotion-layer";

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
  cardType?: string | null;
  duration?: number | null;
  audioUrl?: string | null;
  visualTransition?: string | null;
  visualTransitionDuration?: number | null;
  status: string;
  startImageThumbUrl?: string | null;
  shotBreakdown?: string | null;
  cardConfig?: string | null;
  timelinePositionSeconds?: number | null;
  trackIndex?: number | null;
  fitMode?: "contain" | "cover" | "fill" | null;
  transformScale?: number | null;
  transformOffsetX?: number | null;
  transformOffsetY?: number | null;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  /** Scene-attached GL effect stack (clip_effects.scene_id rows). */
  effects?: SceneEffectEntry[] | null;
  // Speed (phase 10b): media spans stay in source seconds; see getSceneVideoOffset.
  playbackSpeed?: number | null;
  speedCurveJson?: string | null;
  preservePitch?: boolean | null;
  // Motion (phase 10b): keyframed transform, animations, rotation, opacity (scene-motion.ts).
  keyframesJson?: string | null;
  animationJson?: string | null;
  rotationDegrees?: number | null;
  opacity?: number | null;
}

interface ScenePreviewProps {
  scene: SceneData | null;
  scenes?: SceneData[];
  musicUrl?: string | null;
  onSceneChange?: (id: string) => void;
  timelineClips?: TimelineClip[];
  timelineTracks?: TimelineTrack[];
  /** True while the parent compositor applies effect layers to the FULL
   *  composite (footage + overlays). Skip the footage-only effect pass here
   *  so effects aren't applied twice; the main-track look overlay still
   *  presents the lane frame under an effect (the composite's footage). */
  suppressEffectLayer?: boolean;
  /** True while the parent compositor draws the built-in graphics on its
   *  canvas (phase 11): the DOM graphics layer leaves them out and keeps only
   *  custom-code (add-on) graphics, which a canvas cannot draw. */
  canvasGraphics?: boolean;
  /** Project aspect ratio as "W:H" (e.g. "16:9", "9:16"). Used to detect
   * source/target mismatch and show the fit-mode toolbar warning. */
  projectAspectRatio?: string | null;
  /** Persist fit-mode / scale / offset / source dimensions to the backend. */
  onUpdateSceneTransform?: (
    sceneId: string,
    updates: {
      fitMode?: "contain" | "cover" | "fill";
      transformScale?: number;
      transformOffsetX?: number;
      transformOffsetY?: number;
      sourceWidth?: number;
      sourceHeight?: number;
    },
  ) => void;
  /** Live position/scale of a graphics clip being dragged on the overlay canvas. */
  remotionTransformOverride?: RemotionTransformOverride | null;
}

const PLAYBACK_TIME_PUBLISH_MS = 1000 / 60;
const PLAYBACK_READY_LOOKUP_MAX_FRAMES = 4;

function getVideoUrl(s: SceneData): string | null {
  if (s.cardType === "source_clip" && s.sourceVideoUrl) return s.sourceVideoUrl;
  if (s.videoUrl) return s.videoUrl;
  // Podcast scene before Step-4 generation: preview the reusable avatar clip.
  // The timeline strip already thumbnails sourceVideoUrl — keep the two in sync.
  if (s.cardType === "podcast" && s.sourceVideoUrl) return s.sourceVideoUrl;
  return null;
}

function getScenePosterUrl(s: SceneData): string | null {
  // Alpha-cutout scenes (background removed) must never show an opaque poster:
  // the paused first frame would cover the transparent video with the original
  // full-background portrait until playback starts.
  if (s.videoUrl && /_human_cutout\.webm(\?|$)/.test(s.videoUrl)) return null;
  return s.startImageThumbUrl || s.startImageUrl || null;
}

function parseSceneCardConfig(s: SceneData): Record<string, unknown> {
  if (!s.cardConfig) return {};
  try {
    const parsed = JSON.parse(s.cardConfig);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getSceneTimelineTrimStart(s: SceneData): number {
  const config = parseSceneCardConfig(s);
  const value = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// ── Scene speed (phase 10b) ──────────────────────────────
// A scene's media spans (trims, shots) are in SOURCE seconds and its timeline length is that span over the
// speed factor (scene-duration.ts). Scene-local timeline time maps to media time through the exact time
// map (sourceTimeAt), and the element plays at the instantaneous rate (speed-sync.ts).

const sceneProfiles = new WeakMap<SceneData, SpeedProfile>();

function getSceneSpeedProfile(s: SceneData): SpeedProfile {
  let profile = sceneProfiles.get(s);
  if (!profile) {
    profile = sceneSpeedProfile(s);
    sceneProfiles.set(s, profile);
  }
  return profile;
}

const sceneCurveLengths = new WeakMap<SceneData, number>();

/**
 * The scene's timeline length when the time map needs it (curves only: constant speeds are linear).
 * Cached per scene object (scenes are replaced, not mutated, on edits) so the per-frame tick does not
 * re-parse cardConfig / shotBreakdown.
 */
function sceneCurveLength(s: SceneData, profile: SpeedProfile): number {
  if (!profile.curve) return 0;
  let length = sceneCurveLengths.get(s);
  if (length === undefined) {
    length = getSceneDuration(s);
    sceneCurveLengths.set(s, length);
  }
  return length;
}

/** Media seconds of the scene's video at scene-local timeline time `offsetInScene`. */
function getSceneVideoOffset(s: SceneData, offsetInScene: number): number {
  const profile = getSceneSpeedProfile(s);
  return mediaTimeAt(profile, offsetInScene, sceneCurveLength(s, profile), getSceneTimelineTrimStart(s));
}

/** The scene element's playbackRate at scene-local `offsetInScene` (× the J/K/L shuttle speed). */
function getSceneRateTarget(s: SceneData, offsetInScene: number, shuttle = 1): RateTarget {
  const profile = getSceneSpeedProfile(s);
  return targetRate(profile, offsetInScene, sceneCurveLength(s, profile), shuttle);
}

/**
 * Scene-local time warped by the speed curve, in constant-speed scene seconds: S(local) / factor. Equal
 * to `local` without a curve, so shot sequencing (which already scales by its own timeScale, which
 * includes the speed factor through getSceneDuration) only changes for curves.
 */
function getSceneWarpedLocal(s: SceneData, local: number): number {
  const profile = getSceneSpeedProfile(s);
  if (!profile.curve) return Math.max(0, local);
  const factor = sceneSpeedFactor(s);
  return sourceTimeAt(profile, Math.max(0, local), sceneCurveLength(s, profile)) / factor;
}

/** The curve's rate relative to its mean at scene-local `local` (1 without a curve): shot playback multiplies its timeScale by it. */
function getSceneRelativeRate(s: SceneData, local: number): number {
  const profile = getSceneSpeedProfile(s);
  if (!profile.curve) return 1;
  return speedAt(profile, Math.max(0, local), sceneCurveLength(s, profile)) / sceneSpeedFactor(s);
}

/**
 * Rate + pitch for a scene element about to play at scene-local `local` (replaces the old hard-coded
 * `playbackRate = 1`, and restores preservesPitch that drift nudging used to leave off). Returns false
 * in step mode (rate outside the browser's range): the caller must not play() the element then.
 */
function primeSceneVideoRate(vid: HTMLMediaElement, s: SceneData, local: number, shuttle = 1): boolean {
  const target = getSceneRateTarget(s, local, shuttle);
  resetMediaSync(vid);
  if (Math.abs(vid.playbackRate - target.rate) > 1e-9) vid.playbackRate = target.rate;
  applyPitch(vid, getSceneSpeedProfile(s).preservePitch);
  return !target.seek;
}

function getSceneAudioUrl(s: SceneData): string | null {
  if (s.audioUrl) return s.audioUrl;
  const config = parseSceneCardConfig(s);
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

function getSceneAudioVolume(s: SceneData): number {
  const sceneAudioUrl = getSceneAudioUrl(s);
  if (!sceneAudioUrl) return 0;
  const config = parseSceneCardConfig(s);
  const layers = Array.isArray(config.audio_layers) ? config.audio_layers : [];
  for (const rawLayer of layers) {
    if (!rawLayer || typeof rawLayer !== "object" || Array.isArray(rawLayer)) continue;
    const layer = rawLayer as { type?: unknown; url?: unknown; volume?: unknown };
    if (layer.url !== sceneAudioUrl && (s.audioUrl || (layer.type !== "extracted" && layer.type !== "voiceover"))) continue;
    const volume = Number(layer.volume ?? 1);
    return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
  }
  return 1;
}

/** Overlay clip videos keep their old 0.35 s snap (speed-sync nudges below it). */
const OVERLAY_HARD_SEEK_DRIFT = 0.35;
/** A keyframed mask on a DOM-drawn scene re-renders its mask image at most this often while playing (phase 10c). */
const MASK_PLAYING_INTERVAL_MS = 66;
/** Timeline audio elements keep their old 0.3 s snap (an audio seek is cheap); nudging covers smaller drift. */
const AUDIO_HARD_SEEK_DRIFT = 0.3;

/**
 * Speed (phase 10b): whether the scene audio element plays the scene's own SOURCE sound (an extracted
 * layer, or a source clip's audioUrl, which is trimmed with the video) and so follows the scene speed.
 * Voiceovers (a voiceover layer, or audioUrl on a generated scene) keep speed 1 (plan decision).
 */
function sceneAudioFollowsSpeed(s: SceneData): boolean {
  const url = getSceneAudioUrl(s);
  if (!url) return false;
  const layers = parseSceneCardConfig(s).audio_layers;
  if (Array.isArray(layers)) {
    for (const rawLayer of layers) {
      if (!rawLayer || typeof rawLayer !== "object" || Array.isArray(rawLayer)) continue;
      const layer = rawLayer as { type?: unknown; url?: unknown };
      if (layer.url === url) return layer.type === "extracted";
    }
  }
  return s.cardType === "source_clip" && url === s.audioUrl;
}

function getSceneAudioOffset(s: SceneData, offsetInScene: number): number {
  // Source sound runs on the scene's time map (S(t) source seconds into the scene); voiceovers at 1×.
  const localOffset = sceneAudioFollowsSpeed(s) ? getSceneVideoOffset(s, offsetInScene) - getSceneTimelineTrimStart(s) : Math.max(0, offsetInScene);
  const config = parseSceneCardConfig(s);
  const layers = Array.isArray(config.audio_layers) ? config.audio_layers : [];
  const sceneAudioUrl = getSceneAudioUrl(s);
  const usesTrimmedSourceAudio = s.cardType === "source_clip" && Boolean(sceneAudioUrl) && layers.some((rawLayer) => {
    if (!rawLayer || typeof rawLayer !== "object" || Array.isArray(rawLayer)) return false;
    const layer = rawLayer as { type?: unknown; url?: unknown };
    return layer.url === sceneAudioUrl || layer.type === "extracted";
  });
  const audioIsDirectSceneUrl = Boolean(sceneAudioUrl) && sceneAudioUrl === s.audioUrl;
  if (usesTrimmedSourceAudio || audioIsDirectSceneUrl) {
    return Math.max(0, getSceneTimelineTrimStart(s) + localOffset);
  }
  return localOffset;
}

function isBaseSceneAudioTrackAudible(timelineTracks?: TimelineTrack[]): boolean {
  if (!timelineTracks) return true;
  const audioTrack = timelineTracks.find((track) => track.type === "audio" && track.index === 1);
  if (!audioTrack) return true;
  const volume = Number(audioTrack.volume ?? 1);
  return audioTrack.visible !== false && !audioTrack.muted && (!Number.isFinite(volume) || volume > 0.001);
}

/** Track fader (0–1) for an audio lane. Playback loudness must follow the
 *  fader, not just the binary mute gate — otherwise a half-down fader still
 *  plays at full volume and the mix never matches what the timeline shows. */
function getAudioTrackVolume(timelineTracks: TimelineTrack[] | undefined, trackIndex: number): number {
  const audioTrack = timelineTracks?.find((track) => track.type === "audio" && track.index === trackIndex);
  const volume = Number(audioTrack?.volume ?? 1);
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
}

/** Video-track fader (0–1) applied to a scene's embedded video audio, on top
 *  of the base audio-track fader. Missing track (or V1 default) → 1.
 *  A muted video track silences its embedded audio entirely. */
function getVideoTrackVolume(timelineTracks: TimelineTrack[] | undefined, trackIndex: number): number {
  const videoTrack = timelineTracks?.find((track) => track.type === "video" && track.index === trackIndex);
  if (videoTrack?.muted) return 0;
  const volume = Number(videoTrack?.volume ?? 1);
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
}

function sceneVideoHasEmbeddedAudio(scene: SceneData | null | undefined): boolean {
  if (!scene) return false;
  // Rendered podcast videos carry the voiceover inside the video itself; the
  // standalone audioUrl is suppressed for them (see syncVoiceover), so the
  // embedded track MUST be audible or the scene plays silent.
  if (scene.cardType === "podcast" && scene.videoUrl) return true;
  if (getSceneAudioUrl(scene)) return false;
  return scene.cardType === "source_clip" || (scene as SceneData & { autoGenerateAudio?: boolean | null }).autoGenerateAudio === true;
}

function shouldPlaySceneVideoAudio(
  scene: SceneData | null | undefined,
  baseAudioTrackAudible: boolean,
  timelineClips?: TimelineClip[],
  currentTime = 0,
): boolean {
  if (!scene) return false;
  if (!baseAudioTrackAudible || !sceneVideoHasEmbeddedAudio(scene)) return false;
  // The scene's audio was detached onto the timeline: that lane owns it now,
  // and a muted lane means silence. Without this the embedded track kept
  // playing under re-voiced clips and doubled the dialogue.
  if (timelineOwnsSceneAudioAtTime(scene.id, timelineClips, currentTime)) return false;
  if (scene?.cardType === "source_clip" && scene.sourceVideoUrl) {
    if (shouldMuteDetachedSourceVideoAtTime(scene.sourceVideoUrl, timelineClips, currentTime)) {
      return false;
    }
  }
  const sceneVideoUrl = scene?.videoUrl || null;
  if (sceneVideoUrl && shouldMuteDetachedSourceVideoAtTime(sceneVideoUrl, timelineClips, currentTime)) {
    return false;
  }
  if (shouldMuteEmbeddedVideoForTimelineVoiceover(Boolean(getSceneAudioUrl(scene)), timelineClips, currentTime)) {
    return false;
  }
  return true;
}

function createTimelineClipAudio(clip: TimelineClip, resolveMediaUrl: (url: string) => string): HTMLAudioElement | null {
  if (!clip.mediaUrl) return null;
  const previewMediaUrl = resolveMediaUrl(clip.mediaUrl);
  const audio = new Audio(previewMediaUrl);
  audio.preload = "metadata";
  audio.setAttribute("data-opennan-audio-url", clip.mediaUrl);
  return audio;
}

function disposeTimelineClipAudio(audio: HTMLAudioElement) {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

function normalizeSceneTransitionType(transitionType: string | null | undefined): string {
  return normalizeTimelineTransitionType(String(transitionType || "none"));
}

type PlayheadRenderState = {
  currentTime: number;
  activeSceneId: string | null;
  activeOverlayKey: string;
  activeShotKey: string | null;
  transitionOverlay: { color: string; opacity: number } | null;
  /** Motion transitions (dissolve/slide/wipe/zoom/blur): the OUTGOING scene
   * stays mounted on top and animates out over the post-cut half of the
   * transition window while the next scene plays underneath. */
  dissolveOutgoing: SceneOutgoingTransitionState | null;
};

type SceneOutgoingTransitionState = {
  sceneId: string;
  opacity: number;
  transform?: string;
  clipPath?: string;
  filter?: string;
};

type ScenePlayheadRange = {
  scene: SceneData;
  sceneId: string;
  start: number;
  end: number;
  trackIndex: number;
  transitionType: string;
  transitionDuration: number;
};

type ShotPlayheadRange = {
  start: number;
  end: number;
  index: number;
};

type ScenePlayheadRanges = {
  sceneRanges: ScenePlayheadRange[];
  shotRangesBySceneId: Map<string, ShotPlayheadRange[]>;
};

function buildScenePlayheadRanges(
  sourceScenes: SceneData[],
  resolveStart: (scene: SceneData) => number,
): ScenePlayheadRanges {
  const sceneRanges = sourceScenes.map((scene) => {
    const start = resolveStart(scene);
    const end = start + getSceneDuration(scene);
    const duration = Number(scene.visualTransitionDuration ?? 0);
    return {
      scene,
      sceneId: scene.id,
      start,
      end,
      trackIndex: scene.trackIndex || 1,
      transitionType: normalizeSceneTransitionType(scene.visualTransition),
      transitionDuration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    };
  });
  const shotRangesBySceneId = new Map<string, ShotPlayheadRange[]>();
  for (const range of sceneRanges) {
    const shots = parseShotBreakdown<{ duration?: string | number; duration_seconds?: string | number }>(range.scene.shotBreakdown);
    if (shots.length <= 1) continue;
    let cursor = range.start;
    const shotRanges: ShotPlayheadRange[] = [];
    for (let index = 0; index < shots.length; index++) {
      const duration = shotDurationSeconds(shots[index]);
      const end = cursor + Math.max(0, duration);
      shotRanges.push({ start: cursor, end, index });
      cursor = end;
    }
    shotRangesBySceneId.set(range.sceneId, shotRanges);
  }
  return { sceneRanges, shotRangesBySceneId };
}

// Boundary epsilon: scene ends carry float noise (e.g. 7.360000000000001)
// while seeks land on rounded starts (7.36). Without the tolerance, seeking
// to a scene's start re-activates its PREDECESSOR and force-reselects it —
// clicking scene 2 visibly snapped the selection back to scene 1.
//
// It also covers near-zero starts: a scene dragged to the very beginning can
// persist at 0.001s, and a strict `time >= start` test leaves the playhead at
// 0 with NO active scene — the preview showed black until the playhead passed
// 0.001s, which reads as "preview is broken".
export const SCENE_RANGE_BOUNDARY_EPS = 0.005;

const EMPTY_CLIPS: TimelineClip[] = [];

/** True when `time` falls inside a scene/overlay range, boundary noise aside. */
export function isTimeInSceneRange(time: number, start: number, end: number): boolean {
  return time >= start - SCENE_RANGE_BOUNDARY_EPS && time < end - SCENE_RANGE_BOUNDARY_EPS;
}

function getActiveSceneFromRanges(ranges: ScenePlayheadRange[], time: number): SceneData | null {
  if (!ranges.length) return null;
  const BOUNDARY_EPS = SCENE_RANGE_BOUNDARY_EPS;
  let bestOverlay: ScenePlayheadRange | null = null;
  let bestTrack = -1;
  for (const range of ranges) {
    if (time < range.start - BOUNDARY_EPS || time >= range.end - BOUNDARY_EPS) continue;
    if (range.trackIndex === 1) return range.scene;
    if (range.trackIndex > bestTrack) {
      bestOverlay = range;
      bestTrack = range.trackIndex;
    }
  }
  return bestOverlay?.scene ?? null;
}

function getActiveOverlaysFromRanges(ranges: ScenePlayheadRange[], time: number): SceneData[] {
  if (!ranges.length) return [];
  const out: SceneData[] = [];
  for (const range of ranges) {
    if (range.trackIndex < 2) continue;
    if (isTimeInSceneRange(time, range.start, range.end)) out.push(range.scene);
  }
  return out.sort((a, b) => (a.trackIndex || 1) - (b.trackIndex || 1));
}

function getActiveShotKeyFromRanges(
  shotRangesBySceneId: Map<string, ShotPlayheadRange[]>,
  targetScene: SceneData | null,
  time: number,
): string | null {
  if (!targetScene) return null;
  const shotRanges = shotRangesBySceneId.get(targetScene.id);
  if (!shotRanges?.length) return null;
  for (const range of shotRanges) {
    if (time >= range.start && time < range.end) return `${targetScene.id}:${range.index}`;
  }
  const last = shotRanges[shotRanges.length - 1];
  return last ? `${targetScene.id}:${last.index}` : null;
}

function getSceneTransitionOverlayFromRanges(
  time: number,
  ranges: ScenePlayheadRange[],
): { color: string; opacity: number } | null {
  if (!ranges.length) return null;
  for (const range of ranges) {
    if (range.transitionType !== "dip_black" && range.transitionType !== "dip_white") continue;
    if (range.transitionDuration <= 0) continue;
    const transitionAt = range.end;
    const hasNextScene = ranges.some(
      (candidate) =>
        candidate.sceneId !== range.sceneId &&
        candidate.trackIndex === range.trackIndex &&
        Math.abs(candidate.start - transitionAt) <= 0.06,
    );
    if (!hasNextScene) continue;

    const start = transitionAt - range.transitionDuration / 2;
    const end = transitionAt + range.transitionDuration / 2;
    if (time < start || time > end) continue;

    const progress = Math.max(0, Math.min(1, (time - start) / range.transitionDuration));
    const opacity = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
    return {
      color: range.transitionType === "dip_black" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
      opacity: Math.max(0, Math.min(1, opacity)),
    };
  }
  return null;
}

// Motion-transition preview: after the cut, keep the outgoing scene's last
// frame on top and animate it out over half the transition duration while the
// incoming scene plays underneath. (Pre-cut half needs the NEXT scene decoded
// early — not worth the extra decoder; the post-cut animation reads well.)
const SCENE_OUTGOING_TRANSITION_TYPES = new Set([
  "cross_dissolve",
  "blur_dissolve",
  "slide_left",
  "slide_right",
  "slide_up",
  "slide_down",
  "wipe_left",
  "zoom_in",
]);

function getSceneOutgoingTransitionStyle(
  transitionType: string,
  sceneId: string,
  progress: number,
): SceneOutgoingTransitionState {
  const p = Math.max(0, Math.min(1, progress));
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  switch (transitionType) {
    case "slide_left":
      return { sceneId, opacity: 1, transform: `translateX(-${pct(p)})` };
    case "slide_right":
      return { sceneId, opacity: 1, transform: `translateX(${pct(p)})` };
    case "slide_up":
      return { sceneId, opacity: 1, transform: `translateY(-${pct(p)})` };
    case "slide_down":
      return { sceneId, opacity: 1, transform: `translateY(${pct(p)})` };
    case "wipe_left":
      // Incoming scene is revealed from the right edge sweeping left.
      return { sceneId, opacity: 1, clipPath: `inset(0 ${pct(p)} 0 0)` };
    case "zoom_in":
      return { sceneId, opacity: 1 - p, transform: `scale(${(1 + p * 0.5).toFixed(3)})` };
    case "blur_dissolve":
      return { sceneId, opacity: 1 - p, filter: `blur(${(p * 12).toFixed(1)}px)` };
    default:
      return { sceneId, opacity: 1 - p };
  }
}

function getSceneDissolveOutgoingFromRanges(
  time: number,
  ranges: ScenePlayheadRange[],
): SceneOutgoingTransitionState | null {
  if (!ranges.length) return null;
  for (const range of ranges) {
    if (!SCENE_OUTGOING_TRANSITION_TYPES.has(range.transitionType)) continue;
    if (range.transitionDuration <= 0) continue;
    const cut = range.end;
    const hasNextScene = ranges.some(
      (candidate) =>
        candidate.sceneId !== range.sceneId &&
        candidate.trackIndex === range.trackIndex &&
        Math.abs(candidate.start - cut) <= 0.06,
    );
    if (!hasNextScene) continue;
    const fadeSpan = range.transitionDuration / 2;
    if (time < cut || time > cut + fadeSpan) continue;
    const progress = (time - cut) / fadeSpan;
    return getSceneOutgoingTransitionStyle(range.transitionType, range.sceneId, progress);
  }
  return null;
}

/** Returns true when the scene has no stitched video but shots each have
 * their own video_url — ShotSequencerV2 can play them in sequence. */
function sceneNeedsShotSequencer(s: SceneData): boolean {
  if (s.videoUrl) return false;
  if (s.cardType === "source_clip" && s.sourceVideoUrl) return false;
  if (!s.shotBreakdown) return false;
  const shots = parseShotBreakdown<{ video_url?: string }>(s.shotBreakdown);
  if (shots.length === 0) return false;
  return shots.every((sh) => !!sh.video_url);
}

type CopyVideoShotImage = {
  shot_index?: number | null;
  keyframe_url?: string | null;
  panel_url?: string | null;
  source_frame_url?: string | null;
  copy_video_master_panel_crops?: Record<string, string> | null;
  copy_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
  ai_video_storyboards?: Array<{ panel_crops?: Record<string, string> | null }> | null;
};

function buildCopyVideoPanelCropMap(shots: CopyVideoShotImage[]): Map<number, string> {
  const crops = new Map<number, string>();
  const head = shots[0];
  const addCrops = (panelCrops?: Record<string, string> | null) => {
    if (!panelCrops) return;
    for (const [rawIndex, rawUrl] of Object.entries(panelCrops)) {
      const index = Number(rawIndex);
      const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (Number.isFinite(index) && url) crops.set(index, url);
    }
  };

  addCrops(head?.copy_video_master_panel_crops);
  for (const sheet of head?.copy_video_storyboards || []) {
    addCrops(sheet.panel_crops);
  }
  return crops;
}

function getCopyVideoShotPanelUrl(
  shots: CopyVideoShotImage[],
  shot: CopyVideoShotImage | null | undefined,
  shotArrayIndex: number,
): string | null {
  if (!shot) return null;
  const shotIndex = typeof shot.shot_index === "number" ? shot.shot_index : shotArrayIndex;
  return buildCopyVideoPanelCropMap(shots).get(shotIndex) || null;
}

function buildAiVideoPanelCropMap(shots: CopyVideoShotImage[]): Map<number, string> {
  const crops = new Map<number, string>();
  const head = shots[0];
  const addCrops = (panelCrops?: Record<string, string> | null) => {
    if (!panelCrops) return;
    for (const [rawIndex, rawUrl] of Object.entries(panelCrops)) {
      const index = Number(rawIndex);
      const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
      if (Number.isFinite(index) && url) crops.set(index, url);
    }
  };

  for (const sheet of head?.ai_video_storyboards || []) {
    addCrops(sheet.panel_crops);
  }
  return crops;
}

function getAiVideoShotPanelUrl(
  shots: CopyVideoShotImage[],
  shot: CopyVideoShotImage | null | undefined,
  shotArrayIndex: number,
): string | null {
  if (!shot) return null;
  const shotIndex = typeof shot.shot_index === "number" ? shot.shot_index : shotArrayIndex;
  return buildAiVideoPanelCropMap(shots).get(shotIndex) || null;
}

function getShotPreviewImageUrl(
  shots: CopyVideoShotImage[],
  shot: CopyVideoShotImage | null | undefined,
  shotArrayIndex: number,
): string | null {
  if (!shot) return null;
  // Generated panels take priority; before any storyboard exists, fall back to
  // the per-shot original-video keyframe (source_frame_url) so the preview shows
  // the original breakdown frame for the shot under the playhead — matching the
  // timeline slice (timeline-renderer.ts uses the same fallback).
  return shot.keyframe_url || shot.panel_url || getCopyVideoShotPanelUrl(shots, shot, shotArrayIndex) || getAiVideoShotPanelUrl(shots, shot, shotArrayIndex) || shot.source_frame_url || null;
}

function timeToSeconds(t: string): number {
  const clean = t.replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

function getSceneDuration(s: SceneData): number {
  return sceneTimelineSeconds(s, getSceneSourceDuration(s));
}

/** Media span in source seconds (the timeline length is this over the scene speed). */
function getSceneSourceDuration(s: SceneData): number {
  const config = parseSceneCardConfig(s);
  const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
  const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
  if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
    return trimEnd - trimStart;
  }

  let shotSum = 0;
  if (s.shotBreakdown && s.shotBreakdown !== "[]") {
    const shots = parseShotBreakdown(s.shotBreakdown);
    if (shots.length > 0) shotSum = totalShotDuration(shots);
  }
  if (s.cardType === "copy_video" && shotSum > 0) return shotSum;
  // When the scene has a stitched video, prefer the LONGER of (DB metadata,
  // sum of shot durations). A previous bug in `_auto_restitch_scene` wrote
  // `scene.duration = sum(shot.duration WHERE video_url)`. For single-chunk
  // smart-batch scenes only shot[0] has a video_url (followers were merged
  // into the leader), so the sum collapsed to one shot's duration even
  // though the actual mp4 covers all shots. Sum-of-shots is the recovery
  // floor so the timeline clip still shows the full scene length.
  if (s.videoUrl && s.duration && s.duration > 0) {
    return shotSum > s.duration ? shotSum : s.duration;
  }
  if (shotSum > 0) return shotSum;
  return s.duration || (timeToSeconds(s.endTime) - timeToSeconds(s.startTime)) || 5;
}

function getTimelineSortedPreviewScenes(
  sourceScenes: SceneData[],
  resolveStart: (scene: SceneData) => number,
): SceneData[] {
  return [...sourceScenes].sort((a, b) => {
    const startDiff = resolveStart(a) - resolveStart(b);
    if (Math.abs(startDiff) > 0.001) return startDiff;
    return a.order - b.order;
  });
}

function getNearbyPreviewScenes(
  sourceScenes: SceneData[],
  anchorSceneId: string | null | undefined,
  resolveStart: (scene: SceneData) => number,
  behind: number,
  ahead: number,
): SceneData[] {
  if (!sourceScenes.length) return [];
  const timelineSortedScenes = getTimelineSortedPreviewScenes(sourceScenes, resolveStart);
  const anchorIndex = Math.max(0, timelineSortedScenes.findIndex((s) => s.id === anchorSceneId));
  return timelineSortedScenes.slice(
    Math.max(0, anchorIndex - behind),
    Math.min(timelineSortedScenes.length, anchorIndex + ahead + 1),
  );
}

/** Build an inline style that applies the scene's fit mode + user transform.
 * `contain` → letterbox (default); `cover` → crop-to-fill; `fill` → stretch.
 * Scale and translate are applied on top of the object-fit so the user can
 * nudge + zoom like CapCut.
 *
 * `screenFrame` (when provided) converts the persisted %-of-frame offsets
 * into absolute pixels so offsets stay pixel-aligned with the transform
 * chrome even when CSS `translate(%)` would otherwise interpret them
 * relative to a differently-sized element. */
function sceneFitStyle(
  s: SceneData | null,
  screenFrame?: { w: number; h: number } | null,
): React.CSSProperties {
  if (!s) return {};
  const mode = s.fitMode || "contain";
  const scale = Number(s.transformScale ?? 1) || 1;
  const dx = Number(s.transformOffsetX ?? 0) || 0;
  const dy = Number(s.transformOffsetY ?? 0) || 0;
  const txPx = screenFrame ? (dx / 100) * screenFrame.w : 0;
  const tyPx = screenFrame ? (dy / 100) * screenFrame.h : 0;
  return {
    objectFit: mode,
    transform: `translate(${txPx}px, ${tyPx}px) scale(${scale})`,
    transformOrigin: "center center",
  };
}

// Timeline length per scene object (motion is evaluated per frame; the length parses the card config).
const sceneMotionLengths = new WeakMap<SceneData, number>();
function sceneMotionLength(s: SceneData): number {
  let length = sceneMotionLengths.get(s);
  if (length === undefined) {
    length = getSceneDuration(s);
    sceneMotionLengths.set(s, length);
  }
  return length;
}

/** Scene media props (phase 10b motion). A scene that moves, rotates, or is translucent is tagged
 * `data-scene-motion` and gets no React transform/opacity: ScenePreview writes them per frame from the
 * scene's motion at scene-local time (writeSceneMotion). Every other scene keeps sceneFitStyle unchanged. */
function sceneMediaProps(
  s: SceneData,
  screenFrame?: { w: number; h: number } | null,
): { style: React.CSSProperties; "data-scene-motion"?: string } {
  if (!sceneHasMotion(s, sceneMotionLength(s))) return { style: sceneFitStyle(s, screenFrame) };
  return { style: { objectFit: s.fitMode || "contain", transformOrigin: "center center" }, "data-scene-motion": s.id };
}

/** Scenes by id per scenes array (writeSceneMotion looks one up per tagged element per tick). */
const scenesById = new WeakMap<SceneData[], Map<string, SceneData>>();
function sceneById(scenes: SceneData[], id: string | undefined): SceneData | undefined {
  let byId = scenesById.get(scenes);
  if (!byId) {
    byId = new Map(scenes.map((sc) => [sc.id, sc]));
    scenesById.set(scenes, byId);
  }
  return id === undefined ? undefined : byId.get(id);
}

/** Writes the motion transform/opacity of every tagged scene element (`elements`, the tagged media under the
 * frame) at timeline `time`. Elements that lost their tag get their opacity back (React re-adds the transform). */
function writeSceneMotion(
  elements: readonly HTMLElement[],
  written: Set<HTMLElement>,
  time: number,
  state: {
    scenes: SceneData[] | undefined;
    resolveStart: (s: SceneData) => number;
    screenFrame: { w: number; h: number } | null;
    panLive: { sceneId: string; offsetX: number; offsetY: number } | null;
    scaleLive: { sceneId: string; scale: number; offsetX: number; offsetY: number } | null;
  },
): void {
  const seen = new Set<HTMLElement>();
  if (state.screenFrame && state.scenes?.length) {
    for (const el of elements) {
      if (!el.isConnected) continue;
      const base = sceneById(state.scenes, el.dataset.sceneMotion);
      if (!base) continue;
      const s = mergeLiveTransforms(base, state.panLive, state.scaleLive);
      const css = sceneMediaTransform(sceneMotionAt(s, sceneMotionLength(s), time - state.resolveStart(base)), state.screenFrame);
      el.style.transform = css.transform;
      el.style.opacity = css.opacity;
      seen.add(el);
      written.add(el);
    }
  }
  for (const el of written) {
    if (seen.has(el)) continue;
    if (el.isConnected && el.hasAttribute("data-scene-motion")) continue; // no frame yet: keep the last write
    el.style.opacity = "";
    written.delete(el);
  }
}

/** Merge live pan/scale drag state onto a scene so the preview reflects the
 * in-flight transform without waiting on the debounced server commit. */
function mergeLiveTransforms(
  s: SceneData,
  pan: { sceneId: string; offsetX: number; offsetY: number } | null,
  scl: { sceneId: string; scale: number; offsetX: number; offsetY: number } | null,
): SceneData {
  let next = s;
  if (pan && pan.sceneId === s.id) {
    next = { ...next, transformOffsetX: pan.offsetX, transformOffsetY: pan.offsetY };
  }
  if (scl && scl.sceneId === s.id) {
    next = {
      ...next,
      transformScale: scl.scale,
      transformOffsetX: scl.offsetX,
      transformOffsetY: scl.offsetY,
    };
  }
  return next;
}

/** Transform editing only makes sense for scenes that actually render a
 * stable piece of media whose position/scale persists in the final export:
 *   - Still-image scenes (cardType === "image")
 *   - Source clips with an uploaded/URL video
 *   - Any scene with a real video_url (AI video that finished generating)
 * Video scenes still waiting on generation render just a start-image
 * placeholder — transforming that placeholder is pointless because it will
 * be replaced by a differently-sized video. Gate the chrome on this check. */
function sceneSupportsTransform(s: SceneData | null | undefined): boolean {
  if (!s) return false;
  if (s.cardType === "image") return true;
  if (s.videoUrl) return true;
  if (s.cardType === "source_clip" && s.sourceVideoUrl) return true;
  if (s.cardType === "podcast" && s.sourceVideoUrl) return true;
  // AI-video scene whose final stitch hasn't landed yet but each shot has a
  // playable video_url — ShotSequencerV2 is rendering them. Treat as
  // transformable because the transform applies at scene level.
  if (s.shotBreakdown) {
    const shots = parseShotBreakdown<{ video_url?: string }>(s.shotBreakdown);
    if (shots.length > 0 && shots.every((sh) => !!sh.video_url)) return true;
  }
  return false;
}

/** Detect whether a scene's source aspect ratio differs meaningfully from the
 * project's (container's) ratio. Returns the source ratio and a mismatch flag. */
function sceneAspectMismatch(
  s: SceneData | null,
  containerRatio: number | null,
): { mismatch: boolean; sourceRatio: number | null } {
  if (!s || !containerRatio) return { mismatch: false, sourceRatio: null };
  const w = Number(s.sourceWidth || 0);
  const h = Number(s.sourceHeight || 0);
  if (w <= 0 || h <= 0) return { mismatch: false, sourceRatio: null };
  const sr = w / h;
  return { mismatch: Math.abs(sr - containerRatio) > 0.02, sourceRatio: sr };
}

export interface ScenePreviewHandle {
  getActiveVideo: () => HTMLVideoElement | null;
  /** The main-track look overlay while it shows a frame (looks, transitions), else null. */
  getLaneCanvas?: () => HTMLCanvasElement | null;
  /**
   * The drawable <video> of every scene at the playhead, lowest track first (phase 11: the compositor's effect
   * pass composites V2+ scene lanes over the main track, as the exports do).
   */
  getSceneVideos?: () => Array<{ sceneId: string; trackIndex: number; video: HTMLVideoElement }>;
  getActiveImage: () => string | null;
  getActiveScene: () => SceneData | null;
}

type PreviewSyncPhase = "idle" | "seeking";

export const ScenePreview = forwardRef<ScenePreviewHandle, ScenePreviewProps>(function ScenePreview({ scene, scenes, musicUrl, onSceneChange, timelineClips, timelineTracks, suppressEffectLayer, canvasGraphics, projectAspectRatio, onUpdateSceneTransform, remotionTransformOverride }, ref) {
  const storeApi = useEditorStoreApi();
  const media = useTimelineMedia();
  const tr = useTimelineMessages("scenePreview");
  const docVisible = useDocumentVisible();
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [previewSyncPhase, setPreviewSyncPhase] = useState<PreviewSyncPhase>("idle");
  const audioRef = useRef<HTMLAudioElement>(null);
  const voiceoverRef = useRef<HTMLAudioElement>(null);
  // Forward J/K/L shuttle speed (1 = normal play). Multiplies every scene element's rate and the wall clock.
  const shuttleMultiplierRef = useRef(1);
  const clipAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const releaseTimelineClipAudios = useCallback(() => {
    clipAudiosRef.current.forEach(disposeTimelineClipAudio);
    clipAudiosRef.current.clear();
  }, []);
  const rafRef = useRef<number | null>(null);
  const playbackWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickAtRef = useRef(0);
  const seekFrameRef = useRef<number | null>(null);
  const deferredPlaybackFrameRef = useRef<number | null>(null);
  const playbackReadyFrameRef = useRef<number | null>(null);
  const playbackCanplayCleanupRef = useRef<(() => void) | null>(null);
  const activeSceneRef = useRef<string | null>(null);
  const currentTimeRef = useRef(0);
  const playingRef = useRef(false);
  const docVisibleRef = useRef(docVisible);

  // Virtual timer for musicless playback
  const playStartRef = useRef<number>(0);  // performance.now() at play start
  const playOffsetRef = useRef<number>(0); // resume offset in seconds
  // Dedicated pause-position ref. Only pause() writes it; only resume() reads
  // it. This is immune to background seeks/ticks/selection changes that might
  // otherwise overwrite currentTimeRef while the user is paused.
  const pausedAtRef = useRef<number | null>(null);
  const firstTickAfterResumeRef = useRef(false);
  const lastPublishedTimeAtRef = useRef(0);

  // Seek version — increments on every USER seek, stale callbacks bail out
  const seekVersionRef = useRef(0);
  const bufferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canplayCleanupRef = useRef<(() => void) | null>(null);

  // Stable refs to video elements by scene id
  const videoRefsMap = useRef<Map<string, HTMLVideoElement>>(new Map());

  // DOM-level caching: keep visited scene elements alive
  const [visitedIds, setVisitedIds] = useState<Set<string>>(new Set());

  const markSceneMediaReady = useCallback((_sceneId: string) => {}, []);

  // Which scene is "ready" to be displayed (video seeked to correct pos)
  const [readySceneId, setReadySceneId] = useState<string | null>(null);

  // Shot-by-shot playback for scenes without video
  const [activeShotIndex, setActiveShotIndex] = useState(0);
  const shotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shotPlaying, setShotPlaying] = useState(false);
  const clearShotSequenceTimer = useCallback(() => {
    if (!shotTimerRef.current) return;
    clearTimeout(shotTimerRef.current);
    shotTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!docVisible) {
      clearShotSequenceTimer();
      setShotPlaying(false);
    }
    return () => clearShotSequenceTimer();
  }, [clearShotSequenceTimer, docVisible]);

  // Reset shot index when scene changes
  const prevSceneIdRef = useRef(scene?.id);
  if (scene?.id !== prevSceneIdRef.current) {
    prevSceneIdRef.current = scene?.id;
    setActiveShotIndex(0);
    setShotPlaying(false);
    clearShotSequenceTimer();
  }

  // Blob cache: fetch videos once, use blob: URLs (no re-download ever)
  const { cachedUrl, preload, abortPreloads } = useVideoCache();

  // Keep playingRef in sync
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { docVisibleRef.current = docVisible; }, [docVisible]);

  const publishCurrentTime = useCallback((time: number, force = false) => {
    const now = performance.now();
    if (!force && now - lastPublishedTimeAtRef.current < PLAYBACK_TIME_PUBLISH_MS) return;
    lastPublishedTimeAtRef.current = now;
    storeApi.getState().setCurrentTime(time);
  }, []);

  // Sync music volume from store → audio element (use selector to avoid re-render on currentTime).
  // The soundtrack can arrive after the preview mounts; include its URL so a
  // newly-created audio element receives the saved volume instead of the
  // browser default of 100%.
  const musicVolume = useEditorStore((s) => s.musicVolume);
  useEffect(() => {
    if (!audioRef.current) return;
    const trackVolume = getAudioTrackVolume(timelineTracks, 1);
    audioRef.current.volume = isBaseSceneAudioTrackAudible(timelineTracks)
      ? Math.max(0, Math.min(1, musicVolume * trackVolume))
      : 0;
  }, [docVisible, musicUrl, musicVolume, timelineTracks]);

  // Helper: get current playback time. Preferred source is the music audio
  // element (authoritative when playing). But if the audio element stalled or
  // paused while playingRef is still true, time would freeze — fall back to
  // the virtual timer so the playhead keeps advancing.
  const hasMusic = !!musicUrl;
  const canPlayMusicAt = useCallback((time: number): boolean => {
    const audio = audioRef.current;
    if (!audio) return false;
    const duration = audio.duration;
    return !Number.isFinite(duration) || duration <= 0 || time < duration - 0.05;
  }, []);

  const seekMusicTo = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const duration = audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      audio.currentTime = Math.max(0, Math.min(time, duration));
      return;
    }
    audio.currentTime = Math.max(0, time);
  }, []);

  const playMusicIfAvailable = useCallback((time: number) => {
    if (canPlayMusicAt(time)) {
      audioRef.current?.play().catch(() => {});
    }
  }, [canPlayMusicAt]);

  const getCurrentTime = useCallback((): number => {
    const audio = audioRef.current;
    if (hasMusic && audio && !audio.paused) {
      // The backing track drives the master clock ONLY while it actually
      // covers the current playhead. When the music is SHORTER than the edit
      // (e.g. it was fitted to the timeline before a later scene existed, so it
      // only spans the first scene), following its currentTime snaps the
      // playhead back to the track's start when it ends/loops — freezing
      // playback on the early scenes so the rest of the timeline (and its
      // scenes) is never reached. Past the track's end fall through to the
      // wall-clock so the playhead keeps advancing to totalDuration.
      const md = audio.duration;
      if (!Number.isFinite(md) || md <= 0 || audio.currentTime < md - 0.05) {
        return audio.currentTime;
      }
    }
    if (playingRef.current) {
      // Forward shuttle advances the wall clock at the shuttle speed (re-anchored when it changes), so the
      // scene elements' rate × shuttle and the playhead agree instead of drift-snapping every second.
      return ((performance.now() - playStartRef.current) / 1000) * shuttleMultiplierRef.current + playOffsetRef.current;
    }
    return currentTimeRef.current;
  }, [hasMusic]);

  // Absolute timeline start for a scene. A project is "timeline-migrated" when any scene
  // has timelinePositionSeconds > 0: use tp for all (including legitimate zeros). Otherwise
  // fall back to end-to-end cumulative. This keeps scenes from collapsing on top of each
  // other when only SOME of them have been dragged.
  const resolveStart = useCallback(
    (scene: SceneData): number => {
      if (!scenes?.length) return 0;
      const index = scenes.findIndex((s) => s.id === scene.id);
      if (index < 0) return 0;
      return getSceneTimelineStart(scene, scenes, index, getSceneDuration);
    },
    [scenes],
  );

  // Total duration = max(scene_end) across all scenes, extended by timeline
  // clips that outlast the scenes (e.g. a sticker/text clip appended after the
  // last scene). Without the clip extension the playhead clamps at the scene
  // end, so clips past it can never be reached — while the preview clock
  // (preview-panel's getPreviewDuration) already counts them.
  const scenesEndTime = useMemo(() => {
    let max = 0;
    for (const s of scenes || []) {
      const end = resolveStart(s) + getSceneDuration(s);
      if (end > max) max = end;
    }
    return max;
  }, [scenes, resolveStart]);
  const totalDuration = useMemo(() => {
    // Mirror nle-timeline's contentDuration: visual clips extend the playable
    // range, audio is fallback-only — a long music/audio tail must not create
    // a reachable black region past the last visual content.
    let visualMax = scenesEndTime;
    let audioMax = 0;
    for (const clip of timelineClips || []) {
      const end = Number(clip.endTime) || 0;
      if (clip.trackType === "audio") audioMax = Math.max(audioMax, end);
      else visualMax = Math.max(visualMax, end);
    }
    return visualMax > 0 ? visualMax : audioMax;
  }, [scenesEndTime, timelineClips]);

  const isSceneTrackVisible = useCallback((targetScene: SceneData | null | undefined): boolean => {
    if (!targetScene || !timelineTracks) return true;
    const track = timelineTracks.find(
      (t) => t.type === "video" && t.index === (targetScene.trackIndex || 1),
    );
    if (track?.visible === false) return false;
    return true;
  }, [timelineTracks]);

  const visibleScenes = useMemo(() => {
    const sourceScenes = scenes || [];
    return sourceScenes.filter(isSceneTrackVisible);
  }, [isSceneTrackVisible, scenes]);
  const playheadRanges = useMemo(() => buildScenePlayheadRanges(visibleScenes, resolveStart), [resolveStart, visibleScenes]);
  const playableTimelineClips = useMemo(
    () => filterPreviewTimelineClips(timelineClips, timelineTracks),
    [timelineClips, timelineTracks],
  );
  const timelineAudioClips = useMemo(() => playableTimelineClips.filter((clip) => clip.trackType === "audio"), [playableTimelineClips]);
  const allTimelineAudioClips = useMemo(
    () => (timelineClips || []).filter((clip) => clip.trackType === "audio"),
    [timelineClips],
  );
  const timelineRemotionClips = useMemo(() => playableTimelineClips.filter((clip) => clip.trackType === "remotion"), [playableTimelineClips]);
  // The DOM layer's graphics: all of them, or only custom-code ones while the compositor draws the built-ins.
  const domRemotionClips = useMemo(
    () => (canvasGraphics ? timelineRemotionClips.filter((clip) => !isBuiltinGraphics(clip)) : timelineRemotionClips),
    [canvasGraphics, timelineRemotionClips],
  );
  // Graphics layers follow the shared motion model (phase 10c): keyframes, animations, rotation, opacity, the live drag.
  const remotionLayerStyle = useCallback(
    (clip: TimelineClip, timelineSeconds: number) => getRemotionLayerStyle(clip, timelineSeconds - clip.startTime, remotionTransformOverride),
    [remotionTransformOverride],
  );
  // Scene effect stacks are part of each scene's look (LaneLookOverlay). Built-in effects on
  // effect-track clips run in the looks renderer too; the legacy overlay keeps catalog (GLSL) effects.
  const builtinEffectSpans = useMemo(
    () => playableTimelineClips.filter((clip) =>
      clip.trackType === "effect" &&
      timelineTracks?.find((track) => track.type === "effect" && track.index === clip.trackIndex)?.visible !== false &&
      clip.effects?.some((effect) => effect.enabled && isBuiltinEffect(effect.effectId))),
    [playableTimelineClips, timelineTracks],
  );
  // Legacy catalog (GLSL) effects on scenes: pseudo effect clips over each scene's range (export: GL layers).
  const legacySceneEffectClips = useMemo(
    () => sceneEffectPseudoClips(visibleScenes, (scene) => {
      const range = playheadRanges.sceneRanges.find((r) => r.sceneId === scene.id);
      return range ? { start: range.start, end: range.end } : { start: 0, end: 0 };
    }, (effectId) => !isBuiltinEffect(effectId)),
    [visibleScenes, playheadRanges],
  );
  const effectOverlayClips = useMemo(
    () => [
      ...playableTimelineClips.map((clip) => (clip.trackType === "effect" && clip.effects?.some((effect) => isBuiltinEffect(effect.effectId))
        ? { ...clip, effects: clip.effects.filter((effect) => !isBuiltinEffect(effect.effectId)) }
        : clip)),
      ...legacySceneEffectClips,
    ],
    [playableTimelineClips, legacySceneEffectClips],
  );
  const hasEnabledEffectClips = useMemo(
    () => effectOverlayClips.some(
      (clip) =>
        clip.trackType === "effect" &&
        timelineTracks?.find((track) => track.type === "effect" && track.index === clip.trackIndex)?.visible !== false &&
        clip.effects?.some((effect) => effect.enabled),
    ),
    [effectOverlayClips, timelineTracks],
  );
  // Every enabled effect layer (built-in or catalog, on a visible track): while one is at the playhead and the
  // compositor runs the effects, the main-track look overlay presents the plain lane frame as the composite's
  // footage (image scenes have no <video> to sample).
  const effectFootageClips = useMemo(
    () => [...builtinEffectSpans, ...effectOverlayClips.filter((clip) =>
      clip.trackType === "effect" &&
      timelineTracks?.find((track) => track.type === "effect" && track.index === clip.trackIndex)?.visible !== false &&
      clip.effects?.some((effect) => effect.enabled))],
    [builtinEffectSpans, effectOverlayClips, timelineTracks],
  );
  const baseSceneAudioTrackAudible = useMemo(
    () => isBaseSceneAudioTrackAudible(timelineTracks),
    [timelineTracks],
  );
  const baseSceneAudioTrackVolume = useMemo(
    () => getAudioTrackVolume(timelineTracks, 1),
    [timelineTracks],
  );
  // Per-video-track faders, applied to scene embedded audio by track index.
  const videoTrackVolumes = useMemo(() => {
    const out: Record<number, number> = {};
    for (const track of timelineTracks ?? []) {
      if (track.type === "video") out[track.index] = getVideoTrackVolume(timelineTracks, track.index);
    }
    return out;
  }, [timelineTracks]);

  // Active scene at `time` — prefers V1 (base track). If no V1 scene covers
  // time (e.g., a project with only V2+ scenes), falls back to the topmost
  // overlay scene. Returns null only when no scene at all covers `time`.
  const getActiveScene = useCallback(
    (time: number): SceneData | null => {
      return getActiveSceneFromRanges(playheadRanges.sceneRanges, time);
    },
    [playheadRanges],
  );

  // Overlay scenes (V2+) active at `time`, sorted by trackIndex ascending so
  // V2 draws above V1, V3 above V2, etc.
  const getActiveOverlays = useCallback(
    (time: number): SceneData[] => {
      return getActiveOverlaysFromRanges(playheadRanges.sceneRanges, time);
    },
    [playheadRanges],
  );

  // Lowest video lane occupied by a scene at `time`. Timeline media clips on
  // lanes BELOW this render behind the scene video (see TimelineUnderClipLayer)
  // so an alpha scene video (background-removed webm) reveals them.
  const resolveSceneLane = useCallback(
    (time: number): number => {
      let lane = Number.POSITIVE_INFINITY;
      for (const range of playheadRanges.sceneRanges) {
        if (time >= range.start && time < range.end) lane = Math.min(lane, range.trackIndex);
      }
      return Number.isFinite(lane) ? lane : 1;
    },
    [playheadRanges],
  );

  // Timeline video/image clips that could ever sit below a scene lane —
  // candidates for the behind-the-scene under-layer. Clips at/above every
  // scene lane stay on the preview-panel compositor's overlay path.
  const underCandidateClips = useMemo(() => {
    let maxSceneLane = 1;
    for (const range of playheadRanges.sceneRanges) {
      maxSceneLane = Math.max(maxSceneLane, range.trackIndex);
    }
    return playableTimelineClips.filter(
      (c) => c.trackType === "video" && !!c.mediaUrl && (c.trackIndex ?? 2) < maxSceneLane,
    );
  }, [playableTimelineClips, playheadRanges]);

  const buildPlayheadRenderState = useCallback(
    (time: number): PlayheadRenderState => {
      const activeScene = getActiveSceneFromRanges(playheadRanges.sceneRanges, time);
      const activeOverlays = getActiveOverlaysFromRanges(playheadRanges.sceneRanges, time);
      return {
        currentTime: time,
        activeSceneId: activeScene?.id ?? null,
        activeOverlayKey: activeOverlays.map((s) => `${s.id}@${s.trackIndex || 1}`).join(","),
        activeShotKey: getActiveShotKeyFromRanges(playheadRanges.shotRangesBySceneId, activeScene, time),
        // With WebGL2 the main-track look overlay draws V1 transitions (export parity); CSS draws V2+ and is the fallback.
        transitionOverlay: getSceneTransitionOverlayFromRanges(time, cssTransitionRanges(playheadRanges.sceneRanges, lookRendererSupported())),
        dissolveOutgoing: getSceneDissolveOutgoingFromRanges(time, cssTransitionRanges(playheadRanges.sceneRanges, lookRendererSupported())),
      };
    },
    [playheadRanges],
  );

  const [playheadRenderState, setPlayheadRenderState] = useState<PlayheadRenderState>(() =>
    buildPlayheadRenderState(storeApi.getState().currentTime),
  );

  // Sync active shot with timeline playhead position. This subscription keeps
  // fast playhead ticks out of the full preview render path; React only updates
  // when the derived visible scene/overlay/shot/transition state changes.
  const syncPlayheadState = useCallback(
    (time: number) => {
      const next = buildPlayheadRenderState(time);
      setPlayheadRenderState((prev) => {
        const prevOverlay = prev.transitionOverlay;
        const nextOverlay = next.transitionOverlay;
        const transitionChanged =
          prevOverlay?.color !== nextOverlay?.color ||
          Math.abs((prevOverlay?.opacity ?? -1) - (nextOverlay?.opacity ?? -1)) > 0.01;
        const dissolveChanged =
          prev.dissolveOutgoing?.sceneId !== next.dissolveOutgoing?.sceneId ||
          Math.abs((prev.dissolveOutgoing?.opacity ?? -1) - (next.dissolveOutgoing?.opacity ?? -1)) > 0.01 ||
          prev.dissolveOutgoing?.transform !== next.dissolveOutgoing?.transform ||
          prev.dissolveOutgoing?.clipPath !== next.dissolveOutgoing?.clipPath ||
          prev.dissolveOutgoing?.filter !== next.dissolveOutgoing?.filter;
        if (
          prev.activeSceneId === next.activeSceneId &&
          prev.activeOverlayKey === next.activeOverlayKey &&
          prev.activeShotKey === next.activeShotKey &&
          !transitionChanged &&
          !dissolveChanged
        ) {
          return prev;
        }
        return next;
      });

      if (scene && scenes?.length && !shotPlaying) {
        const shotKey = getActiveShotKeyFromRanges(playheadRanges.shotRangesBySceneId, scene, time);
        if (shotKey) {
          const nextIndex = Number(shotKey.slice(shotKey.lastIndexOf(":") + 1));
          if (Number.isFinite(nextIndex)) {
            setActiveShotIndex((prev) => (prev === nextIndex ? prev : nextIndex));
          }
        }
      }
    },
    [buildPlayheadRenderState, playheadRanges, scene, scenes?.length, shotPlaying],
  );

  useEffect(() => {
    syncPlayheadState(storeApi.getState().currentTime);
    const unsub = storeApi.subscribe((s) => s.currentTime, syncPlayheadState);
    return unsub;
  }, [syncPlayheadState]);

  const getSceneStartTime = useCallback(
    (sceneId: string): number => {
      if (!scenes?.length) return 0;
      const sc = scenes.find((s) => s.id === sceneId);
      if (!sc) return 0;
      return resolveStart(sc);
    },
    [scenes, resolveStart]
  );

  const cancelPendingSeek = useCallback(() => {
    // Bump the version so ANY in-flight seekToScene.resume() or timeout
    // fallback bails out when it eventually runs — prevents stale seek
    // completions from writing playStart/playOffset AFTER pause.
    seekVersionRef.current++;
    if (seekFrameRef.current) {
      cancelAnimationFrame(seekFrameRef.current);
      seekFrameRef.current = null;
    }
    if (bufferTimeoutRef.current) {
      clearTimeout(bufferTimeoutRef.current);
      bufferTimeoutRef.current = null;
    }
    if (canplayCleanupRef.current) {
      canplayCleanupRef.current();
      canplayCleanupRef.current = null;
    }
  }, []);

  const cancelDeferredPlaybackFrame = useCallback(() => {
    if (!deferredPlaybackFrameRef.current) return;
    cancelAnimationFrame(deferredPlaybackFrameRef.current);
    deferredPlaybackFrameRef.current = null;
  }, []);

  const cancelPlaybackReadyWait = useCallback(() => {
    if (playbackReadyFrameRef.current) {
      cancelAnimationFrame(playbackReadyFrameRef.current);
      playbackReadyFrameRef.current = null;
    }
    if (playbackCanplayCleanupRef.current) {
      playbackCanplayCleanupRef.current();
      playbackCanplayCleanupRef.current = null;
    }
  }, []);

  // Voiceover audio: play scene's audioUrl during playback unless the timeline
  // already owns the same audio at the current playhead (e.g. after Separate audio).
  const syncVoiceover = useCallback((activeScene: SceneData | null, offsetInScene: number = 0) => {
    const vo = voiceoverRef.current;
    if (!vo) return;
    const url = activeScene ? getSceneAudioUrl(activeScene) : null;
    const sceneAudioVolume = activeScene ? getSceneAudioVolume(activeScene) : 0;
    // Rendered podcast scenes carry the voiceover inside the video itself —
    // never layer the standalone audioUrl on top (double-voice echo).
    if (activeScene?.cardType === "podcast" && activeScene.videoUrl) {
      vo.pause();
      vo.removeAttribute("src");
      return;
    }
    if (!url || !baseSceneAudioTrackAudible || sceneAudioVolume <= 0.001) {
      vo.pause();
      vo.removeAttribute("src");
      return;
    }
    const playheadTime = currentTimeRef.current;
    if (
      timelineHasMatchingVoiceoverClip(url, allTimelineAudioClips) ||
      timelineOwnsSceneVoiceoverPlayback(url, allTimelineAudioClips, playheadTime, media.resolveMediaUrl)
    ) {
      vo.pause();
      vo.removeAttribute("src");
      return;
    }
    const shouldPlay = playingRef.current;
    const previewUrl = media.resolveMediaUrl(url);
    if (vo.getAttribute("src") !== previewUrl) {
      vo.src = previewUrl;
    }
    vo.volume = baseSceneAudioTrackVolume * sceneAudioVolume;
    const audioOffset = activeScene ? getSceneAudioOffset(activeScene, offsetInScene) : 0;
    const shouldSeekVoiceover = Math.abs(vo.currentTime - audioOffset) > 0.08;
    if (shouldSeekVoiceover) {
      vo.currentTime = audioOffset;
    }
    // Speed (phase 10b): the scene's own source sound follows the scene speed; voiceovers stay at 1×.
    let mayPlay = true;
    if (activeScene && sceneAudioFollowsSpeed(activeScene)) {
      mayPlay = primeSceneVideoRate(vo, activeScene, offsetInScene, shuttleMultiplierRef.current);
    } else {
      resetMediaSync(vo);
      if (vo.playbackRate !== 1) vo.playbackRate = 1;
      applyPitch(vo, true);
    }
    if (shouldPlay && mayPlay) {
      vo.play().catch(() => {});
    } else if (!vo.paused) {
      vo.pause();
    }
  }, [allTimelineAudioClips, baseSceneAudioTrackAudible, baseSceneAudioTrackVolume, media]);

  // Speed (phase 10b): per-tick rate + drift for a sped-up scene's source sound on the voiceover element
  // (syncVoiceover only runs on scene changes and seeks; a curve changes the rate continuously).
  const syncSceneAudioSpeed = useCallback((activeScene: SceneData, offsetInScene: number) => {
    const vo = voiceoverRef.current;
    if (!vo || !vo.getAttribute("src") || !sceneAudioFollowsSpeed(activeScene)) return;
    const profile = getSceneSpeedProfile(activeScene);
    if (isIdentitySpeed(profile) && shuttleMultiplierRef.current === 1) return;
    const target = getSceneRateTarget(activeScene, offsetInScene, shuttleMultiplierRef.current);
    if (!target.seek && vo.paused) {
      vo.currentTime = getSceneAudioOffset(activeScene, offsetInScene);
      vo.play().catch(() => {});
    }
    syncMediaElement(vo, { desired: getSceneAudioOffset(activeScene, offsetInScene), playing: true, target, preservePitch: profile.preservePitch, hardSeekDrift: AUDIO_HARD_SEEK_DRIFT });
  }, []);

  // Manage HTMLAudioElement instances for timeline audio clips
  useEffect(() => {
    const currentMap = clipAudiosRef.current;
    const newIds = new Set(timelineAudioClips.map((c) => c.id));
    const clipsById = new Map(timelineAudioClips.map((c) => [c.id, c]));

    // Remove stale entries and clips whose media URL changed. Audio elements
    // are created lazily during playback sync, so mounting a project with many
    // audio clips does not start metadata requests for all of them.
    currentMap.forEach((audio, id) => {
      const clip = clipsById.get(id);
      if (!newIds.has(id) || !clip?.mediaUrl || audio.getAttribute("data-opennan-audio-url") !== clip.mediaUrl) {
        disposeTimelineClipAudio(audio);
        currentMap.delete(id);
      }
    });
  }, [timelineAudioClips]);

  // Cleanup clip audios on unmount
  useEffect(() => {
    return releaseTimelineClipAudios;
  }, [releaseTimelineClipAudios]);

  // Sync timeline audio clips — stored in a ref so the RAF loop always gets latest version
  const syncClipAudiosRef = useRef<(currentTime: number, isPlaying: boolean) => void>(() => {});
  // Keep ref up-to-date without being in tick/seekToScene/handlePlayAll deps
  useEffect(() => {
    syncClipAudiosRef.current = (currentTime: number, isPlaying: boolean) => {
      for (const clip of timelineAudioClips) {
        const inRange = currentTime >= clip.startTime && currentTime < clip.endTime;
        if (inRange) {
          let audio: HTMLAudioElement | null | undefined = clipAudiosRef.current.get(clip.id);
          if (!audio && isPlaying) {
            audio = createTimelineClipAudio(clip, media.resolveMediaUrl);
            if (audio) clipAudiosRef.current.set(clip.id, audio);
          }
          if (!audio) continue;
          // Always sync volume: clip volume (keyframed when authored) scaled
          // by its track's fader.
          const clipTrackVolume = getAudioTrackVolume(timelineTracks, clip.trackIndex);
          const keyframedVolume = getClipKeyframeValuesAtTime(clip.keyframesJson, currentTime - clip.startTime)?.volume;
          audio.volume = Math.max(0, Math.min(1, (keyframedVolume ?? clip.volume ?? 1) * clipTrackVolume));

          // Speed (phase 10b): (t − start) through the clip's time map (constant speed, curve, or legacy
          // ramp) + trimStart, at the clip's instantaneous rate with its keep-pitch setting.
          const profile = cachedClipSpeedProfile(clip);
          const clipLength = Math.max(0, clip.endTime - clip.startTime);
          const localInClip = currentTime - clip.startTime;
          const offsetInClip = mediaTimeAt(profile, localInClip, clipLength, Number(clip.trimStart) || 0);
          const target = targetRate(profile, localInClip, clipLength);
          if (isPlaying && audio.paused && !target.seek) {
            audio.play().catch(() => {});
          } else if (!isPlaying && !audio.paused) {
            audio.pause();
          }
          syncMediaElement(audio, { desired: offsetInClip, playing: isPlaying, target, preservePitch: profile.preservePitch, hardSeekDrift: AUDIO_HARD_SEEK_DRIFT });
        } else {
          const audio = clipAudiosRef.current.get(clip.id);
          if (audio) {
            if (!audio.paused) audio.pause();
            audio.currentTime = 0;
          }
        }
      }
    };
  }, [timelineAudioClips, timelineTracks, media]);

  // Per-scene audio: unmute the active scene if either:
  //  - it's a source_clip (original video)
  //  - it's an ai_video / podcast / etc with provider-generated audio (autoGenerateAudio)
  // Everything inactive stays muted so we don't get N tracks playing at once.
  const syncVideoMuted = useCallback((activeId: string | null, currentTime?: number) => {
    if (!scenes?.length) return;
    const time = currentTime ?? currentTimeRef.current;
    videoRefsMap.current.forEach((vid, id) => {
      // Change-only writes: this runs on every RAF tick, and re-writing
      // muted/volume each frame periodically glitches Chrome's audio output
      // (impulse-train crackle audible on speakers, invisible to captureStream).
      if (id !== activeId) {
        if (!vid.muted) vid.muted = true;
        return;
      }
      const scene = scenes.find((s) => s.id === id);
      const wantMuted = !shouldPlaySceneVideoAudio(scene, baseSceneAudioTrackAudible, timelineClips, time);
      if (vid.muted !== wantMuted) vid.muted = wantMuted;
      const wantVol = baseSceneAudioTrackVolume * (videoTrackVolumes[scene?.trackIndex || 1] ?? 1);
      if (Math.abs(vid.volume - wantVol) > 0.001) vid.volume = wantVol;
    });
  }, [baseSceneAudioTrackAudible, baseSceneAudioTrackVolume, videoTrackVolumes, scenes, timelineClips]);

  const clampToPreviewDuration = useCallback((time: number): number => {
    if (!Number.isFinite(time)) return 0;
    const nonNegativeTime = Math.max(0, time);
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) return nonNegativeTime;
    return Math.min(nonNegativeTime, totalDuration);
  }, [totalDuration]);

  useEffect(() => {
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) return;
    const store = storeApi.getState();
    const clampedTime = clampToPreviewDuration(store.currentTime);
    if (Object.is(clampedTime, store.currentTime)) return;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    currentTimeRef.current = clampedTime;
    playOffsetRef.current = clampedTime;
    if (pausedAtRef.current !== null) {
      pausedAtRef.current = clampToPreviewDuration(pausedAtRef.current);
    }
    playStartRef.current = performance.now();
    setPlaying(false);
    store.setIsPlaying(false);
    store.setCurrentTime(clampedTime);
    setBuffering(false);
    setPreviewSyncPhase("idle");
    syncVideoMuted(null);
    syncVoiceover(null);
    syncClipAudiosRef.current(clampedTime, false);
    if (audioRef.current && !audioRef.current.paused) audioRef.current.pause();
    videoRefsMap.current.forEach((vid) => vid.pause());
  }, [clampToPreviewDuration, syncVideoMuted, syncVoiceover, totalDuration]);

  // Track which scene we already pre-seeked the next video for
  const preSeekedForRef = useRef<string | null>(null);

  const stopPlaybackWatchdog = useCallback(() => {
    if (playbackWatchdogRef.current === null) return;
    clearInterval(playbackWatchdogRef.current);
    playbackWatchdogRef.current = null;
  }, []);

  const waitForActiveVideoReady = useCallback((active: SceneData, sceneStart: number, attempt = 0) => {
    playbackReadyFrameRef.current = requestAnimationFrame(() => {
      playbackReadyFrameRef.current = null;
      if (!playingRef.current || !docVisibleRef.current || activeSceneRef.current !== active.id) return;
      const vid = videoRefsMap.current.get(active.id);
      if (!vid && getVideoUrl(active) && attempt < PLAYBACK_READY_LOOKUP_MAX_FRAMES) {
        waitForActiveVideoReady(active, sceneStart, attempt + 1);
        return;
      }
      if (vid && getVideoUrl(active)) {
        const elapsed = Math.max(0, getCurrentTime() - sceneStart);
        vid.currentTime = getSceneVideoOffset(active, elapsed);
        // false in step mode (speed beyond the browser's range): the tick seeks it each frame instead.
        const mayPlay = primeSceneVideoRate(vid, active, elapsed, shuttleMultiplierRef.current);
        if (!mayPlay) {
          // Stepped by the tick loop.
        } else if (vid.readyState >= 2) {
          vid.play().catch(() => {});
        } else {
          const onReady = () => {
            playbackCanplayCleanupRef.current = null;
            if (playingRef.current && docVisibleRef.current && activeSceneRef.current === active.id) {
              vid.play().catch(() => {});
            }
          };
          vid.addEventListener("canplay", onReady, { once: true });
          playbackCanplayCleanupRef.current = () => vid.removeEventListener("canplay", onReady);
        }
      }
    });
  }, [getCurrentTime]);

  // ── Tick loop — NO React state updates per frame, uses refs + Zustand store ──
  // Only triggers React re-render when active scene actually changes
  const tick = useCallback(() => {
    if (!playingRef.current || !docVisible) return;
    lastTickAtRef.current = performance.now();

    const t = getCurrentTime();
    if (firstTickAfterResumeRef.current) {
      firstTickAfterResumeRef.current = false;
    }

    // End-of-timeline check (virtual timer or audio)
    if (t >= totalDuration) {
      currentTimeRef.current = totalDuration;
      storeApi.getState().setCurrentTime(totalDuration);
      setPlaying(false);
      storeApi.getState().setIsPlaying(false);
      setBuffering(false);
      cancelPendingSeek();
      cancelPlaybackReadyWait();
      syncVideoMuted(null);
      videoRefsMap.current.forEach((vid) => vid.pause());
      if (audioRef.current && !audioRef.current.paused) audioRef.current.pause();
      syncVoiceover(null);
      syncClipAudiosRef.current(totalDuration, false);
      return;
    }

    currentTimeRef.current = t;
    syncClipAudiosRef.current(t, true);
    // Publish playhead UI updates at a capped rate. Playback/audio use refs
    // above for exact timing; the shared store only drives visual subscribers.
    publishCurrentTime(t);

    const active = getActiveScene(t);

    // Gap between V1 scenes (or a V2-only region) — no base V1 scene now. Pause
    // V1 videos so the black backdrop (or V2 overlay above) shows through, but
    // KEEP the tick loop alive so the playhead keeps advancing into the next
    // V1 scene. Previously this branch returned early, killing the RAF — the
    // playhead would freeze the moment it entered a gap.
    if (!active) {
      if (activeSceneRef.current !== null) {
        activeSceneRef.current = null;
        storeApi.getState().syncActiveScene(null);
        cancelPlaybackReadyWait();
        videoRefsMap.current.forEach((v) => { if (!v.paused) v.pause(); });
        syncVideoMuted(null);
        syncVoiceover(null);
        setReadySceneId(null);
      }
      rafRef.current = requestAnimationFrame(() => tickRef.current());
      return;
    }

    {
      const sceneStart = getSceneStartTime(active.id);
      if (active.id !== activeSceneRef.current) {
        // Scene changed — swap videos
        cancelPlaybackReadyWait();
        activeSceneRef.current = active.id;
        onSceneChange?.(active.id);

        // Ensure video element is rendered in DOM
        setVisitedIds((prev) => {
          if (prev.has(active.id)) return prev;
          const next = new Set(prev);
          next.add(active.id);
          return next;
        });

        // Sync source clip audio (unmute active source_clip, mute others)
        syncVideoMuted(active.id);

        // Sync voiceover audio for new scene
        syncVoiceover(active, 0);

        // Pause all other videos FIRST (before starting new one)
        videoRefsMap.current.forEach((v, id) => {
          if (id !== active.id && !v.paused) v.pause();
        });

        // Play new scene's video once React mounts the media element.
        waitForActiveVideoReady(active, sceneStart);

        // Update visibility — triggers React re-render only on scene change
        setReadySceneId(active.id);
        preSeekedForRef.current = null;
      } else {
        // Same scene — keep video loosely in sync (gentle drift correction).
        // Hard-snap thresholds cause visible "jumps" every few seconds, so we
        // only snap on a big drift (>1s) and let playback-rate nudging handle
        // smaller drifts.
        const vid = videoRefsMap.current.get(active.id);
        const localVideoTime = Math.max(0, t - sceneStart);
        if (vid) {
          const videoTime = getSceneVideoOffset(active, localVideoTime);
          const nearEnd = vid.duration && (vid.duration - vid.currentTime) < 0.5;
          // Speed (phase 10b): the element plays at the scene's instantaneous rate (× shuttle) and drifts
          // toward the exact time map. Drift rules (speed-sync.ts, unchanged at 1×): hard snap past 1 s,
          // ±2% nudge entered past 0.15 s and left under 0.05 s, rate writes at most every 600 ms. A 1×
          // nudge is varispeed and the pitch flag returns to the scene's setting afterwards.
          const target = getSceneRateTarget(active, localVideoTime, shuttleMultiplierRef.current);
          const preservePitch = getSceneSpeedProfile(active).preservePitch;
          if (target.seek) {
            // Beyond the browser's rate range: held and stepped by seeking each frame.
            syncMediaElement(vid, { desired: videoTime, playing: true, target, preservePitch });
          } else if (vid.paused && playingRef.current && !nearEnd) {
            vid.currentTime = Math.max(0, videoTime);
            primeSceneVideoRate(vid, active, localVideoTime, shuttleMultiplierRef.current);
            if (vid.readyState >= 2) vid.play().catch(() => {});
          } else if (!vid.paused && !nearEnd) {
            syncMediaElement(vid, { desired: videoTime, playing: true, target, preservePitch });
          }
        }
        syncSceneAudioSpeed(active, localVideoTime);

        // Pre-seek next 2 scenes' videos to time 0 so they're ready for instant transition
        if (scenes?.length && preSeekedForRef.current !== active.id) {
          const idx = scenes.findIndex((s) => s.id === active.id);
          if (idx >= 0) {
            for (let offset = 1; offset <= 2; offset++) {
              if (idx + offset < scenes.length) {
                const next = scenes[idx + offset];
                const nextVid = videoRefsMap.current.get(next.id);
                if (nextVid && getVideoUrl(next)) {
                  nextVid.currentTime = getSceneVideoOffset(next, 0);
                }
              }
            }
            preSeekedForRef.current = active.id;
          }
        }

        syncVideoMuted(active.id, t);
      }
    }

    rafRef.current = requestAnimationFrame(() => tickRef.current());
  }, [docVisible, getCurrentTime, totalDuration, getActiveScene, getSceneStartTime, onSceneChange, scenes, cancelPendingSeek, cancelPlaybackReadyWait, publishCurrentTime, syncVideoMuted, syncVoiceover, syncSceneAudioSpeed, waitForActiveVideoReady]);

  // The RAF chain schedules whatever `tick` it captured when playback started
  // and keeps re-scheduling that SAME closure for the whole run — so edits
  // made mid-playback (duration changes, added/reordered scenes) were invisible
  // to the loop until a stall or pause. Route scheduling through a ref so every
  // frame runs the latest closure.
  const tickRef = useRef(tick);
  useEffect(() => { tickRef.current = tick; }, [tick]);

  const startPlaybackWatchdog = useCallback(() => {
    if (playbackWatchdogRef.current !== null) return;
    lastTickAtRef.current = performance.now();
    playbackWatchdogRef.current = setInterval(() => {
      if (!playingRef.current || !docVisibleRef.current) return;
      const now = performance.now();
      if (now - lastTickAtRef.current < 150) return;
      const recoveredTime = clampToPreviewDuration(getCurrentTime());
      currentTimeRef.current = recoveredTime;
      playOffsetRef.current = recoveredTime;
      playStartRef.current = now;
      publishCurrentTime(recoveredTime, true);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => tickRef.current());
      lastTickAtRef.current = now;
    }, 250);
  }, [clampToPreviewDuration, getCurrentTime, publishCurrentTime, tick]);

  useEffect(() => {
    if (playing && docVisible) {
      startPlaybackWatchdog();
      return stopPlaybackWatchdog;
    }
    stopPlaybackWatchdog();
    return undefined;
  }, [docVisible, playing, startPlaybackWatchdog, stopPlaybackWatchdog]);

  const seekPlayingToScene = useCallback(
    (targetScene: SceneData, seekTime: number) => {
      cancelPendingSeek();
      const version = ++seekVersionRef.current;
      setPreviewSyncPhase("seeking");
      setBuffering(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      const sceneStart = getSceneStartTime(targetScene.id);
      const localOffset = Math.max(0, seekTime - sceneStart);
      const videoOffset = getSceneVideoOffset(targetScene, localOffset);

      seekMusicTo(seekTime);
      playOffsetRef.current = seekTime;
      currentTimeRef.current = seekTime;
      playStartRef.current = performance.now();
      storeApi.getState().setCurrentTime(seekTime);
      activeSceneRef.current = targetScene.id;
      onSceneChange?.(targetScene.id);

      setVisitedIds((prev) => {
        if (prev.has(targetScene.id)) return prev;
        const next = new Set(prev);
        next.add(targetScene.id);
        return next;
      });
      setReadySceneId(targetScene.id);
      syncVideoMuted(targetScene.id);

      const applyVideoSeek = () => {
        if (seekVersionRef.current !== version || !docVisibleRef.current || !playingRef.current) return;
        const vid = videoRefsMap.current.get(targetScene.id);
        if (vid && getVideoUrl(targetScene)) {
          if (Math.abs(vid.currentTime - videoOffset) > 0.04) {
            vid.currentTime = videoOffset;
          }
          if (primeSceneVideoRate(vid, targetScene, localOffset, shuttleMultiplierRef.current)) vid.play().catch(() => {});
          if (vid.readyState >= 2) markSceneMediaReady(targetScene.id);
        }
        videoRefsMap.current.forEach((v, id) => {
          if (id !== targetScene.id && !v.paused) v.pause();
        });
        setPreviewSyncPhase("idle");
      };

      applyVideoSeek();
      seekFrameRef.current = requestAnimationFrame(() => {
        seekFrameRef.current = null;
        applyVideoSeek();
      });
      playMusicIfAvailable(seekTime);
      syncVoiceover(targetScene, localOffset);
      syncClipAudiosRef.current(seekTime, true);
      rafRef.current = requestAnimationFrame(() => tickRef.current());
    },
    [cancelPendingSeek, getSceneStartTime, markSceneMediaReady, onSceneChange, playMusicIfAvailable, seekMusicTo, syncVideoMuted, syncVoiceover, tick],
  );

  // ── User-initiated seek: pause audio, wait for video, then resume ──
  // seekTime is the ABSOLUTE timeline time to seek to. When omitted, we snap to the
  // target scene's start (used by the tick loop for scene-to-scene transitions). When
  // provided (e.g., user scrubs the ruler), we seek to that exact time — no more
  // teleporting to scene start mid-scrub.
  const seekToScene = useCallback(
    (targetScene: SceneData, seekTime?: number) => {
      cancelPendingSeek();
      const version = ++seekVersionRef.current;
      setPreviewSyncPhase("seeking");

      if (audioRef.current) audioRef.current.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clipAudiosRef.current.forEach(a => { a.pause(); });

      const sceneStart = getSceneStartTime(targetScene.id);
      const seekTo = typeof seekTime === "number" ? seekTime : sceneStart;
      const localOffset = Math.max(0, seekTo - sceneStart);
      const videoOffset = getSceneVideoOffset(targetScene, localOffset);
      seekMusicTo(seekTo);
      syncClipAudiosRef.current(seekTo, false);
      playOffsetRef.current = seekTo;
      currentTimeRef.current = seekTo;
      storeApi.getState().setCurrentTime(seekTo);
      activeSceneRef.current = targetScene.id;
      onSceneChange?.(targetScene.id);

      // Add to visited so element is rendered
      setVisitedIds((prev) => {
        if (prev.has(targetScene.id)) return prev;
        const next = new Set(prev);
        next.add(targetScene.id);
        return next;
      });

      videoRefsMap.current.forEach((vid) => { if (!vid.paused) vid.pause(); });

      const resume = () => {
        if (seekVersionRef.current !== version) return;
        cancelPendingSeek();
        setBuffering(false);
        setPreviewSyncPhase("idle");
        setReadySceneId(targetScene.id);

        // Unmute source_clip audio for target scene
        syncVideoMuted(targetScene.id);

        const vid = videoRefsMap.current.get(targetScene.id);
        if (vid) {
          // Seek the video to the offset within the scene (0 when jumping to scene start).
          vid.currentTime = videoOffset;
          if (vid.readyState >= 2) markSceneMediaReady(targetScene.id);
          if (primeSceneVideoRate(vid, targetScene, localOffset, shuttleMultiplierRef.current)) vid.play().catch(() => {});
        }
        playMusicIfAvailable(seekTo);
        // Sync voiceover for target scene, matching the in-scene offset
        syncVoiceover(targetScene, localOffset);
        // Sync timeline audio clips
        syncClipAudiosRef.current(seekTo, true);
        // Start virtual timer
        playStartRef.current = performance.now();
        rafRef.current = requestAnimationFrame(() => tickRef.current());
      };

      // Wait a frame for React to render the new element if needed
      seekFrameRef.current = requestAnimationFrame(() => {
        seekFrameRef.current = null;
        if (seekVersionRef.current !== version || !docVisibleRef.current) return;
        const vid = videoRefsMap.current.get(targetScene.id);

        if (!vid || !getVideoUrl(targetScene)) {
          resume();
          return;
        }

        if (vid.readyState >= 3) {
          // Video already has enough data — resume immediately
          resume();
          return;
        }

        setBuffering(true);
        vid.addEventListener("canplay", resume, { once: true });
        canplayCleanupRef.current = () => vid.removeEventListener("canplay", resume);

        // Don't stall more than 800ms — resume even if video isn't ready
        bufferTimeoutRef.current = setTimeout(() => {
          vid.removeEventListener("canplay", resume);
          canplayCleanupRef.current = null;
          if (seekVersionRef.current === version) {
            setBuffering(false);
            setPreviewSyncPhase("idle");
            setReadySceneId(targetScene.id);
            syncVideoMuted(targetScene.id);
            playMusicIfAvailable(seekTo);
            syncVoiceover(targetScene, localOffset);
            syncClipAudiosRef.current(seekTo, true);
            playStartRef.current = performance.now();
            rafRef.current = requestAnimationFrame(() => tickRef.current());
          }
        }, 800);
      });
    },
    [cancelPendingSeek, markSceneMediaReady, onSceneChange, tick, getSceneStartTime, syncVideoMuted, syncVoiceover, seekMusicTo, playMusicIfAvailable]
  );

  // Keep refs to latest callbacks for use in effects (avoids stale closures)
  const seekToSceneRef = useRef(seekToScene);
  useEffect(() => { seekToSceneRef.current = seekToScene; }, [seekToScene]);

  // ── Controls ──

  const handlePlayAll = useCallback(() => {
    if (!scenes?.length) return;

    if (playing) {
      setPreviewSyncPhase("idle");
      cancelDeferredPlaybackFrame();
      const freshTime = getCurrentTime();
      // Close the tick race — any queued RAF that fires after this sees
      // playingRef=false and exits before advancing currentTimeRef.
      playingRef.current = false;
      if (audioRef.current) audioRef.current.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      cancelPendingSeek();
      // Save the fresh sample. pausedAtRef is the authoritative resume target —
      // other refs may get overwritten by background effects while we're paused.
      currentTimeRef.current = freshTime;
      playOffsetRef.current = freshTime;
      pausedAtRef.current = freshTime;
      setPlaying(false);
      storeApi.getState().setIsPlaying(false);
      storeApi.getState().setCurrentTime(freshTime);
      // Cancel any queued seek (from a late onSceneChange, arrow-key nav,
      // scene selection, etc.) so it can't overwrite the captured pause
      // position while we're stopped. Without this, the paused `seekRequest`
      // effect would re-seek currentTimeRef to the next-scene start, so
      // resume would land on the wrong shot.
      storeApi.getState().setSeekRequest(null);
      setBuffering(false);
      setReadySceneId(null);
      // Mute + pause all videos
      syncVideoMuted(null);
      syncVoiceover(null);
      releaseTimelineClipAudios();
      videoRefsMap.current.forEach((vid) => vid.pause());
    } else {
      setPreviewSyncPhase("idle");
      // Flip the ref synchronously BEFORE any RAF schedules. Without this, the
      // useEffect that syncs playingRef only fires after React's next render,
      // and a RAF that runs in between sees playingRef=false and bails out —
      // killing the tick loop.
      playingRef.current = true;
      setPlaying(true);
      storeApi.getState().setIsPlaying(true);
      firstTickAfterResumeRef.current = true;
      let resumeTime = pausedAtRef.current ?? currentTimeRef.current;
      pausedAtRef.current = null;
      // Pressing play while the playhead sits at the end of the timeline should
      // replay from the start, not no-op on the final frame. (Also covers a
      // session left parked at totalDuration.)
      if (Number.isFinite(totalDuration) && totalDuration > 0 && resumeTime >= totalDuration - 0.05) {
        resumeTime = 0;
      }
      // Anchor the virtual timer SYNCHRONOUSLY so any tick that fires before
      // the outer RAF callback completes still reads the correct position.
      // Without this, a previously-scheduled tick (or a race with React state
      // flush) can run first with stale playStart/playOffset from an earlier
      // session, causing playback to jump to a wrong time.
      currentTimeRef.current = resumeTime;
      playOffsetRef.current = resumeTime;
      playStartRef.current = performance.now();
      storeApi.getState().setCurrentTime(resumeTime);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const activeScene = getActiveScene(resumeTime);

      if (activeScene) {
        activeSceneRef.current = activeScene.id;
        onSceneChange?.(activeScene.id);
        setVisitedIds((prev) => {
          if (prev.has(activeScene.id)) return prev;
          const next = new Set(prev);
          next.add(activeScene.id);
          return next;
        });
        setReadySceneId(activeScene.id);

        // Seek video + audio SYNCHRONOUSLY first — if the video ref already
        // exists (scene was visited before), this makes the preview snap to
        // the right frame before any tick runs. RAF below only handles the
        // case where React still needs a frame to mount a newly-visited scene.
        const sceneStart = getSceneStartTime(activeScene.id);
        const offsetInScene = Math.max(0, resumeTime - sceneStart);
        const videoOffset = getSceneVideoOffset(activeScene, offsetInScene);
        syncVideoMuted(activeScene.id);
        const vidSync = videoRefsMap.current.get(activeScene.id);
        if (vidSync && getVideoUrl(activeScene)) {
          // Reset any drift-correction playbackRate BEFORE seek+play — a
          // stale nudged rate on replay keeps Chrome's audio time-stretcher
          // engaged and crackles from the first frame. The base is the
          // scene's speed (phase 10b), 1 for normal scenes.
          const mayPlay = primeSceneVideoRate(vidSync, activeScene, offsetInScene, shuttleMultiplierRef.current);
          vidSync.currentTime = videoOffset;
          if (mayPlay) vidSync.play().catch(() => {});
        }
        videoRefsMap.current.forEach((v, id) => {
          if (id !== activeScene.id && !v.paused) v.pause();
        });
        syncVoiceover(activeScene, offsetInScene);
        syncClipAudiosRef.current(resumeTime, true);
        if (audioRef.current) {
          seekMusicTo(resumeTime);
          playMusicIfAvailable(resumeTime);
        }
        // Start the tick loop NOW (before RAF) so the virtual timer advances
        // immediately from the correct anchor instead of waiting for a RAF
        // that might be delayed by React reconciliation.
        rafRef.current = requestAnimationFrame(() => tickRef.current());

        // Still fire one RAF to re-apply the video seek in case the video
        // element was just mounted this render and wasn't in the ref yet.
        cancelDeferredPlaybackFrame();
        deferredPlaybackFrameRef.current = requestAnimationFrame(() => {
          deferredPlaybackFrameRef.current = null;
          if (!playingRef.current || !docVisibleRef.current || activeSceneRef.current !== activeScene.id) return;
          const vid = videoRefsMap.current.get(activeScene.id);
          if (vid && getVideoUrl(activeScene) && vid.currentTime === 0 && offsetInScene > 0) {
            vid.currentTime = videoOffset;
            if (primeSceneVideoRate(vid, activeScene, offsetInScene, shuttleMultiplierRef.current)) vid.play().catch(() => {});
          }
        });
      } else {
        // No active scene — just play from current position
        if (audioRef.current) {
          seekMusicTo(resumeTime);
          playMusicIfAvailable(resumeTime);
        }
        playOffsetRef.current = resumeTime;
        playStartRef.current = performance.now();
        rafRef.current = requestAnimationFrame(() => tickRef.current());
      }
    }
  }, [playing, scenes, scene, totalDuration, cancelPendingSeek, cancelDeferredPlaybackFrame, getCurrentTime, getActiveScene, getSceneStartTime, onSceneChange, releaseTimelineClipAudios, tick, syncVideoMuted, syncVoiceover, seekMusicTo, playMusicIfAvailable]);

  const handlePlayAllRef = useRef(handlePlayAll);
  useEffect(() => { handlePlayAllRef.current = handlePlayAll; }, [handlePlayAll]);

  // Handle audio ended
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onEnded = () => {
      const endedAt = Number.isFinite(audio.currentTime) && audio.currentTime > 0
        ? audio.currentTime
        : currentTimeRef.current;

      // Music may be shorter than the edited timeline. In that case, do not
      // stop playback; let the virtual clock keep advancing the playhead,
      // videos, voiceover, and timeline audio clips until totalDuration.
      if (playingRef.current && endedAt < totalDuration - 0.25) {
        currentTimeRef.current = endedAt;
        playOffsetRef.current = endedAt;
        playStartRef.current = performance.now();
        storeApi.getState().setCurrentTime(endedAt);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => tickRef.current());
        return;
      }

      setPlaying(false);
      storeApi.getState().setIsPlaying(false);
      setBuffering(false);
      cancelPendingSeek();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      videoRefsMap.current.forEach((vid) => vid.pause());
      if (voiceoverRef.current) voiceoverRef.current.pause();
      releaseTimelineClipAudios();
    };
    audio.addEventListener("ended", onEnded);
    return () => audio.removeEventListener("ended", onEnded);
  }, [cancelPendingSeek, releaseTimelineClipAudios, tick, totalDuration]);

  // ── Timeline → Preview sync (seekRequest) ──
  const seekRequest = useEditorStore((s) => s.seekRequest);
  useEffect(() => {
    if (seekRequest === null || !scenes?.length) return;
    const seekTime = clampToPreviewDuration(seekRequest);
    // CLEAR seekRequest FIRST so any nested calls don't re-trigger this effect.
    storeApi.getState().setSeekRequest(null);
    // A seek — from any source — supersedes the paused-at position. Don't
    // gate on distance; doing so silently dropped user-initiated skips that
    // landed close to the pause position (e.g. skip-prev to current scene
    // start from inside the same scene).
    pausedAtRef.current = seekTime;
    const targetScene = getActiveScene(seekTime);
    if (!targetScene) {
      setPreviewSyncPhase("idle");
      // Seek landed in a GAP between scenes (or a V2-only region). Update the
      // playhead, pause V1 videos, and — critically — re-anchor the virtual
      // timer so the tick loop keeps advancing currentTime from this new point.
      seekMusicTo(seekTime);
      playOffsetRef.current = seekTime;
      currentTimeRef.current = seekTime;
      storeApi.getState().setCurrentTime(seekTime);
      playStartRef.current = performance.now();
      if (activeSceneRef.current !== null) {
        activeSceneRef.current = null;
        storeApi.getState().syncActiveScene(null);
        videoRefsMap.current.forEach((v) => { if (!v.paused) v.pause(); });
        syncVideoMuted(null);
        syncVoiceover(null);
        setReadySceneId(null);
      }
      syncClipAudiosRef.current(seekTime, playingRef.current);
      // If we were playing, make sure the RAF loop is still alive from here.
      if (playingRef.current) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        if (audioRef.current && audioRef.current.paused) {
          playMusicIfAvailable(seekTime);
        }
        rafRef.current = requestAnimationFrame(() => tickRef.current());
      }
      return;
    }
    if (playingRef.current) {
      // During playback scrubbing, keep the media clocks hot. The full
      // seekToScene path pauses audio and waits for canplay, which is too slow
      // for continuous pointer drag.
      seekPlayingToScene(targetScene, seekTime);
    } else {
      // When paused: update position and show the target scene.
      setPreviewSyncPhase("seeking");
      seekMusicTo(seekTime);
      playOffsetRef.current = seekTime;
      currentTimeRef.current = seekTime;
      storeApi.getState().setCurrentTime(seekTime);
      activeSceneRef.current = targetScene.id;
      // Update selectedSceneId DIRECTLY via the store instead of onSceneChange.
      // onSceneChange routes through editor-layout's handleSceneChange which
      // fires another setSeekRequest when paused — that creates a loop that
      // clobbers the paused position with each iteration. syncActiveScene
      // (not selectScene) so a scrub never steals the user's clip selection
      // or flips the properties panel.
      storeApi.getState().syncActiveScene(targetScene.id);

      // Ensure the scene is rendered and visible
      setVisitedIds((prev) => {
        if (prev.has(targetScene.id)) return prev;
        const next = new Set(prev);
        next.add(targetScene.id);
        return next;
      });
      setReadySceneId(targetScene.id);
      const localOffset = Math.max(0, seekTime - getSceneStartTime(targetScene.id));
      syncVoiceover(targetScene, localOffset);

      // Seek the video element to the correct offset
      const pausedSeekVersion = seekVersionRef.current;
      seekFrameRef.current = requestAnimationFrame(() => {
        seekFrameRef.current = null;
        if (!docVisibleRef.current || seekVersionRef.current !== pausedSeekVersion || activeSceneRef.current !== targetScene.id) return;
        const vid = videoRefsMap.current.get(targetScene.id);
        if (vid && getVideoUrl(targetScene)) {
          vid.currentTime = getSceneVideoOffset(targetScene, localOffset);
          if (vid.readyState >= 2) markSceneMediaReady(targetScene.id);
        }
        // Pause all other videos
        videoRefsMap.current.forEach((v, id) => {
          if (id !== targetScene.id && !v.paused) v.pause();
        });
        // Pause timeline audio clips (not playing when paused)
        syncClipAudiosRef.current(seekTime, false);
        setPreviewSyncPhase("idle");
      });
    }

    // Safety net: if we were playing when the seek fired, verify the tick loop
    // is actually advancing after two frames. If currentTime hasn't budged,
    // assume the seek path (seekToScene waiting for canplay, etc.) failed to
    // restart the RAF and kick it back on. The delayed callback reads refs so
    // it can bail if the tab is hidden or playback stopped before it fires.
    if (playingRef.current) {
      const preCheckTime = storeApi.getState().currentTime;
      setTimeout(() => {
        if (!playingRef.current || !docVisibleRef.current) return;
        const storeNow = storeApi.getState().currentTime;
        if (Math.abs(storeNow - preCheckTime) < 0.01) {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          playStartRef.current = performance.now();
          playOffsetRef.current = storeNow;
          rafRef.current = requestAnimationFrame(() => tickRef.current());
          if (audioRef.current && audioRef.current.paused) {
            playMusicIfAvailable(storeNow);
          }
        }
      }, 120);
    }
  }, [seekRequest, scenes, clampToPreviewDuration, getActiveScene, getSceneStartTime, markSceneMediaReady, onSceneChange, tick, syncVideoMuted, syncVoiceover, seekMusicTo, playMusicIfAvailable, seekPlayingToScene]);

  // ── Timeline → Preview sync (playRequest) ──
  const playRequest = useEditorStore((s) => s.playRequest);
  useEffect(() => {
    if (playRequest === null) return;
    if (playRequest === "play" && !playingRef.current) handlePlayAllRef.current();
    if (playRequest === "pause" && playingRef.current) handlePlayAllRef.current();
    storeApi.getState().setPlayRequest(null);
  }, [playRequest]);

  // ── Frame step handler ──
  const frameStepRequest = useEditorStore((s) => s.frameStepRequest);
  useEffect(() => {
    if (frameStepRequest === null || !scenes?.length) return;
    const store = storeApi.getState();

    // Pause if playing
    if (playingRef.current) {
      if (audioRef.current) audioRef.current.pause();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setPlaying(false);
      store.setIsPlaying(false);
      store.setShuttleSpeed(0);
      videoRefsMap.current.forEach((vid) => vid.pause());
      if (voiceoverRef.current) voiceoverRef.current.pause();
      releaseTimelineClipAudios();
    }

    const frameDur = 1 / 30;
    const requestedTime = frameStepRequest.targetTime ??
      currentTimeRef.current + frameStepRequest.direction * frameDur;
    const newTime = Math.max(0, Math.min(totalDuration, requestedTime));
    seekMusicTo(newTime);
    playOffsetRef.current = newTime;
    currentTimeRef.current = newTime;
    store.setCurrentTime(newTime);

    // Seek the active video to the correct offset
    const active = getActiveScene(newTime);
    if (active) {
      activeSceneRef.current = active.id;
      store.syncActiveScene(active.id);
      const vid = videoRefsMap.current.get(active.id);
      if (vid) {
        const sceneStart = getSceneStartTime(active.id);
        vid.currentTime = getSceneVideoOffset(active, newTime - sceneStart);
      }
      setReadySceneId(active.id);
    }

    store.setFrameStepRequest(null);
  }, [frameStepRequest, scenes, getActiveScene, getSceneStartTime, onSceneChange, cancelPendingSeek, releaseTimelineClipAudios, seekMusicTo, totalDuration]);

  // ── Shuttle speed handler ──
  const shuttleSpeed = useEditorStore((s) => s.shuttleSpeed);
  const activeShuttleSpeedRef = useRef(0);
  const reverseRafRef = useRef<number | null>(null);
  const lastReverseTimeRef = useRef<number>(0);

  // Speed (phase 10b): the forward shuttle multiplies the wall clock and every scene element's rate. The
  // clock is re-anchored at the current playhead before the multiplier changes so the playhead never jumps.
  const setShuttleMultiplier = useCallback((multiplier: number) => {
    if (shuttleMultiplierRef.current === multiplier) return;
    if (playingRef.current) {
      const now = performance.now();
      playOffsetRef.current = ((now - playStartRef.current) / 1000) * shuttleMultiplierRef.current + playOffsetRef.current;
      playStartRef.current = now;
    }
    shuttleMultiplierRef.current = multiplier;
  }, []);

  useEffect(() => {
    if (!scenes?.length) return;
    const previousShuttleSpeed = activeShuttleSpeedRef.current;
    setShuttleMultiplier(shuttleSpeed > 0 && docVisible ? shuttleSpeed : 1);

    // Cancel any existing reverse RAF
    if (reverseRafRef.current) {
      cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = null;
    }

    if (!docVisible) {
      if (shuttleSpeed !== 0 || previousShuttleSpeed !== 0) {
        if (audioRef.current) audioRef.current.playbackRate = 1;
        if (audioRef.current) audioRef.current.pause();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        playOffsetRef.current = currentTimeRef.current;
        setPlaying(false);
        storeApi.getState().setIsPlaying(false);
        storeApi.getState().setShuttleSpeed(0);
        videoRefsMap.current.forEach((vid) => vid.pause());
        if (voiceoverRef.current) voiceoverRef.current.pause();
        releaseTimelineClipAudios();
      }
      activeShuttleSpeedRef.current = 0;
      return;
    }

    if (shuttleSpeed === 0) {
      // Leaving shuttle mode pauses shuttle playback. Do not let ordinary
      // re-renders with the default shuttleSpeed=0 stop normal Play.
      if (audioRef.current) audioRef.current.playbackRate = 1;
      if (previousShuttleSpeed !== 0 && playingRef.current) {
        if (audioRef.current) audioRef.current.pause();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        playOffsetRef.current = currentTimeRef.current;
        setPlaying(false);
        storeApi.getState().setIsPlaying(false);
        videoRefsMap.current.forEach((vid) => vid.pause());
        if (voiceoverRef.current) voiceoverRef.current.pause();
        releaseTimelineClipAudios();
      }
      activeShuttleSpeedRef.current = 0;
      return;
    }

    activeShuttleSpeedRef.current = shuttleSpeed;

    if (shuttleSpeed > 0) {
      // Forward shuttle
      if (audioRef.current) audioRef.current.playbackRate = shuttleSpeed;
      if (!playingRef.current) {
        handlePlayAllRef.current();
      }
      // Also update video playback rate: the scene's own rate × the shuttle speed.
      const time = currentTimeRef.current;
      videoRefsMap.current.forEach((vid, id) => {
        const s = scenes.find((candidate) => candidate.id === id);
        if (!s || vid.paused) return;
        const local = Math.max(0, time - getSceneStartTime(id));
        if (!primeSceneVideoRate(vid, s, local, shuttleSpeed)) vid.pause();
      });
      return;
    }

    // Reverse shuttle (shuttleSpeed < 0)
    if (audioRef.current) audioRef.current.pause();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    videoRefsMap.current.forEach((vid) => vid.pause());
    if (voiceoverRef.current) voiceoverRef.current.pause();
    releaseTimelineClipAudios();
    if (!playingRef.current) {
      setPlaying(true);
      storeApi.getState().setIsPlaying(true);
    }

    lastReverseTimeRef.current = performance.now();
    const speed = Math.abs(shuttleSpeed);

    const reverseTick = () => {
      const now = performance.now();
      const delta = (now - lastReverseTimeRef.current) / 1000;
      lastReverseTimeRef.current = now;

      const newTime = Math.max(0, currentTimeRef.current - delta * speed);
      currentTimeRef.current = newTime;
      playOffsetRef.current = newTime;
      seekMusicTo(newTime);
      storeApi.getState().setCurrentTime(newTime);

      const active = getActiveScene(newTime);
      if (active) {
        if (active.id !== activeSceneRef.current) {
          activeSceneRef.current = active.id;
          onSceneChange?.(active.id);
          setReadySceneId(active.id);
        }
        const vid = videoRefsMap.current.get(active.id);
        if (vid) {
          const sceneStart = getSceneStartTime(active.id);
          vid.currentTime = getSceneVideoOffset(active, newTime - sceneStart);
        }
      }

      if (newTime <= 0) {
        playOffsetRef.current = 0;
        setPlaying(false);
        storeApi.getState().setIsPlaying(false);
        storeApi.getState().setShuttleSpeed(0);
        return;
      }

      reverseRafRef.current = requestAnimationFrame(reverseTick);
    };

    reverseRafRef.current = requestAnimationFrame(reverseTick);

    return () => {
      if (reverseRafRef.current) {
        cancelAnimationFrame(reverseRafRef.current);
        reverseRafRef.current = null;
      }
    };
  }, [shuttleSpeed, scenes, getActiveScene, getSceneStartTime, onSceneChange, releaseTimelineClipAudios, seekMusicTo, docVisible, setShuttleMultiplier]);

  // Reset playback rate when shuttle changes back to normal: each scene element back to its own speed
  // (phase 10b; 1 for normal scenes).
  useEffect(() => {
    if (shuttleSpeed === 0 || shuttleSpeed === 1) {
      if (audioRef.current) audioRef.current.playbackRate = 1;
      const time = currentTimeRef.current;
      videoRefsMap.current.forEach((vid, id) => {
        const s = scenes?.find((candidate) => candidate.id === id);
        if (s) primeSceneVideoRate(vid, s, Math.max(0, time - getSceneStartTime(id)));
        else vid.playbackRate = 1;
      });
    }
  }, [shuttleSpeed]);

  // Pause playback when the browser tab is hidden so preview media and RAF
  // work do not continue burning CPU/network in the background.
  useEffect(() => {
    if (docVisible || !playingRef.current) return;

    const pausedTime = clampToPreviewDuration(getCurrentTime());
    const store = storeApi.getState();

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (reverseRafRef.current) {
      cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = null;
    }

    playingRef.current = false;
    currentTimeRef.current = pausedTime;
    pausedAtRef.current = pausedTime;
    playOffsetRef.current = pausedTime;
    playStartRef.current = performance.now();

    setPlaying(false);
    setBuffering(false);
    setPreviewSyncPhase("idle");
    store.setCurrentTime(pausedTime);
    store.setIsPlaying(false);
    store.setShuttleSpeed(0);
    cancelPendingSeek();
    cancelDeferredPlaybackFrame();
    cancelPlaybackReadyWait();

    if (audioRef.current) audioRef.current.pause();
    if (voiceoverRef.current) voiceoverRef.current.pause();
    videoRefsMap.current.forEach((vid) => {
      vid.pause();
      vid.playbackRate = 1;
    });
    syncVideoMuted(null);
    syncVoiceover(null);
    releaseTimelineClipAudios();
  }, [docVisible, cancelPendingSeek, cancelDeferredPlaybackFrame, cancelPlaybackReadyWait, clampToPreviewDuration, getCurrentTime, releaseTimelineClipAudios, syncVideoMuted, syncVoiceover]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (reverseRafRef.current) cancelAnimationFrame(reverseRafRef.current);
      cancelPendingSeek();
      cancelDeferredPlaybackFrame();
      cancelPlaybackReadyWait();
      stopPlaybackWatchdog();
    };
  }, [cancelPendingSeek, cancelDeferredPlaybackFrame, cancelPlaybackReadyWait, stopPlaybackWatchdog]);

  // When user clicks a scene in the timeline during playback, jump to its start.
  // Gated on scene?.id (not playing) — firing on the playing transition would
  // clobber resume position with the selected scene's start. We only want to
  // react to DELIBERATE scene changes while already playing.
  const prevPlayingForSceneEffectRef = useRef(playing);
  useEffect(() => {
    const wasPlaying = prevPlayingForSceneEffectRef.current;
    prevPlayingForSceneEffectRef.current = playing;
    // Only seek if playback was already running AND scene id genuinely changed —
    // not on the initial play transition.
    if (!playing || !wasPlaying) return;
    if (scene && isSceneTrackVisible(scene) && scene.id !== activeSceneRef.current) {
      seekToSceneRef.current(scene);
    }
  }, [isSceneTrackVisible, playing, scene]);

  // Preload videos: 1 behind + 3 ahead in actual timeline order, not DB order.
  const previewAnchorSceneId = useMemo(() => {
    if (playing && readySceneId) {
      const s = visibleScenes.find(s => s.id === readySceneId);
      return s?.id ?? scene?.id ?? visibleScenes[0]?.id ?? null;
    }
    return isSceneTrackVisible(scene) ? scene?.id ?? null : visibleScenes[0]?.id ?? null;
  }, [isSceneTrackVisible, playing, readySceneId, scene, visibleScenes]);

  useEffect(() => {
    if (!visibleScenes.length) return;
    // Include image-only scenes too — a still-image scene has no video URL but
    // must still be mounted in the render pool, otherwise the preview shows
    // nothing on first load when the starting scene is an image.
    const sourceScenes = visibleScenes;
    const nearby = getNearbyPreviewScenes(sourceScenes, previewAnchorSceneId, resolveStart, 1, 3)
      .filter((s) => getVideoUrl(s) || getScenePosterUrl(s));
    const nearbyIds = nearby.map((s) => s.id);
    setVisitedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of nearbyIds) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      // Cap DOM video elements — keep nearby + evict oldest when over 10
      if (next.size > 10) {
        const nearbySet = new Set(nearbyIds);
        for (const id of next) {
          if (next.size <= 10) break;
          if (!nearbySet.has(id)) { next.delete(id); changed = true; }
        }
      }
      return changed ? next : prev;
    });
    // Blob preload (if CORS allows — videos become blob: URLs, no re-download)
    if (!docVisible) {
      abortPreloads();
      return;
    }
    const nearbyVideoUrls = nearby.map((s) => getVideoUrl(s)).filter((url): url is string => typeof url === "string" && url.length > 0);
    const nearbyVideoUrlSet = new Set(nearbyVideoUrls);
    const staleVideoUrls = visibleScenes.map((s) => getVideoUrl(s)).filter((url): url is string => typeof url === "string" && url.length > 0 && !nearbyVideoUrlSet.has(url));
    abortPreloads(staleVideoUrls);
    preload(nearbyVideoUrls);
  }, [abortPreloads, docVisible, playing, preload, previewAnchorSceneId, resolveStart, visibleScenes]);

  // Determine what to show
  const activeSceneForPlayhead = playheadRenderState.activeSceneId
    ? visibleScenes.find((s) => s.id === playheadRenderState.activeSceneId) ?? null
    : null;
  const selectedVisibleScene = isSceneTrackVisible(scene) ? scene : null;
  const readyScene = playing && readySceneId
    ? visibleScenes.find(s => s.id === readySceneId) ?? null
    : null;
  // Past the end of all scenes (clip-extended tail — e.g. a sticker appended
  // after the last scene) there is no scene to show: fall through to the black
  // backdrop instead of freezing the selected scene's frame behind overlays.
  const playheadBeyondScenes = scenesEndTime > 0 && playheadRenderState.currentTime > scenesEndTime + 1e-3;
  const displayScene = readyScene || activeSceneForPlayhead || (playheadBeyondScenes ? null : selectedVisibleScene);
  const sceneTransitionOverlay = playheadRenderState.transitionOverlay;

  // Expose active video/image to parent (for canvas-based preview rendering).
  // Iterate active scenes in descending trackIndex, returning the FIRST one
  // that has a drawable video. A stale map entry (shot video unregistered
  // momentarily) on the topmost track must NOT block lower tracks from
  // supplying their own video.
  // Resolve the on-screen <video> for the topmost active scene at the playhead.
  // Shared by the imperative handle (canvas compositor) and the in-preview
  // effect overlay. (Closes over refs declared further below — only read at call
  // time, never during render, so the deferred binding is safe.)
  const resolveActiveVideo = useCallback((): HTMLVideoElement | null => {
    const t = storeApi.getState().currentTime;
    const sourceScenes = visibleScenes;
    if (!sourceScenes.length) return null;
    // Collect active scenes, sorted by trackIndex DESC.
    const active = sourceScenes
      .filter((s) => {
        const st = resolveStart(s);
        return t >= st && t < st + getSceneDuration(s);
      })
      .sort((a, b) => (b.trackIndex || 1) - (a.trackIndex || 1));
    // Resolve by scene identity and the same layer priority as the DOM
    // compositor. Comparing currentTime across the global video pool is unsafe:
    // an idle/preloaded video from another scene can have the same timestamp,
    // and shot videos use shot-local rather than scene-local time.
    const isDrawable = (vid: HTMLVideoElement | undefined): vid is HTMLVideoElement =>
      !!vid && vid.isConnected && vid.readyState >= 2 && vid.videoWidth > 0;
    for (const s of active) {
      const shotVid = shotSeqActiveVideoRef.current.get(s.id);
      if (isDrawable(shotVid)) return shotVid;
      const overlayVid = overlayVideoRef.current.get(s.id);
      if (getVideoUrl(s) && isDrawable(overlayVid)) return overlayVid;
      const stitchedVid = videoRefsMap.current.get(s.id);
      if (getVideoUrl(s) && isDrawable(stitchedVid)) return stitchedVid;
    }
    return null;
  }, [visibleScenes, resolveStart]);
  // Every active scene's drawable video, lowest track first (same element priority as resolveActiveVideo).
  const resolveSceneVideos = useCallback((): Array<{ sceneId: string; trackIndex: number; video: HTMLVideoElement }> => {
    const t = storeApi.getState().currentTime;
    const isDrawable = (vid: HTMLVideoElement | undefined): vid is HTMLVideoElement =>
      !!vid && vid.isConnected && vid.readyState >= 2 && vid.videoWidth > 0;
    const out: Array<{ sceneId: string; trackIndex: number; video: HTMLVideoElement }> = [];
    for (const s of visibleScenes) {
      const st = resolveStart(s);
      if (t < st || t >= st + getSceneDuration(s)) continue;
      const shotVid = shotSeqActiveVideoRef.current.get(s.id);
      const overlayVid = getVideoUrl(s) ? overlayVideoRef.current.get(s.id) : undefined;
      const stitchedVid = getVideoUrl(s) ? videoRefsMap.current.get(s.id) : undefined;
      const video = [shotVid, overlayVid, stitchedVid].find(isDrawable);
      if (video) out.push({ sceneId: s.id, trackIndex: s.trackIndex || 1, video });
    }
    return out.sort((a, b) => a.trackIndex - b.trackIndex);
  }, [visibleScenes, resolveStart]);
  const resolveSceneVideosRef = useRef(resolveSceneVideos);
  resolveSceneVideosRef.current = resolveSceneVideos;
  // Stable getter so the effect overlay's WebGL loop never re-inits on edits.
  const resolveActiveVideoRef = useRef(resolveActiveVideo);
  resolveActiveVideoRef.current = resolveActiveVideo;
  const getActiveVideoForEffects = useCallback(() => resolveActiveVideoRef.current(), []);
  const laneCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleLaneCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    laneCanvasRef.current = canvas;
  }, []);
  const getSceneVideoForLooks = useCallback((sceneId: string): HTMLVideoElement | null => (
    shotSeqActiveVideoRef.current.get(sceneId) ?? videoRefsMap.current.get(sceneId) ?? null
  ), []);

  useImperativeHandle(ref, () => ({
    getLaneCanvas: () => laneCanvasRef.current,
    getSceneVideos: () => resolveSceneVideosRef.current(),
    getActiveScene: () => {
      const t = storeApi.getState().currentTime;
      const sourceScenes = visibleScenes;
      if (!sourceScenes.length) return displayScene || null;
      let best: SceneData | null = null;
      let bestTrack = -1;
      for (const s of sourceScenes) {
        const st = resolveStart(s);
        const en = st + getSceneDuration(s);
        if (t < st || t >= en) continue;
        const tr = s.trackIndex || 1;
        if (tr > bestTrack) {
          best = s;
          bestTrack = tr;
        }
      }
      return best || displayScene || null;
    },
    getActiveVideo: () => resolveActiveVideoRef.current(),
    getActiveImage: () => {
      const t = storeApi.getState().currentTime;
      const sourceScenes = visibleScenes;
      if (!sourceScenes.length) return null;
      // Same topmost-track-at-time resolution as getActiveVideo.
      let best: SceneData | null = null;
      let bestTrack = -1;
      for (const s of sourceScenes) {
        const st = resolveStart(s);
        const en = st + getSceneDuration(s);
        if (t < st || t >= en) continue;
        const tr = s.trackIndex || 1;
        if (tr > bestTrack) { best = s; bestTrack = tr; }
      }
      if (!best) return null;
      // If the scene has a video (stitched or shot-sequencer), canvas
      // should draw that instead of an image.
      if (getVideoUrl(best)) return null;
      if (shotSeqActiveVideoRef.current.get(best.id)) return null;

      // Figure out which SHOT is active at the current playhead time and show
      // THAT shot's keyframe. Previously we always returned scene.startImageUrl
      // (or shots[0].keyframe_url) regardless of timeline position — so after
      // regenerating shot 2/3/N the preview still showed shot 1's image, which
      // didn't match what the Properties panel displayed for that shot.
      const shots = parseShotBreakdown<CopyVideoShotImage & { duration?: string | number }>(best.shotBreakdown);

      if (shots.length > 0) {
        const localTime = t - resolveStart(best);
        let cursor = 0;
        for (let i = 0; i < shots.length; i++) {
          const sh = shots[i];
          const dur = shotDurationSeconds(sh);
          if (dur <= 0) continue;
          if (localTime >= cursor && localTime < cursor + dur) {
            return getShotPreviewImageUrl(shots, sh, i);
          }
          cursor += dur;
        }
        // Playhead past the last shot (e.g. scene padding) — show the last shot's image.
        for (let i = shots.length - 1; i >= 0; i--) {
          const sh = shots[i];
          const imageUrl = getShotPreviewImageUrl(shots, sh, i);
          if (imageUrl) return imageUrl;
        }
      }

      // No shots resolved (or no shot has an image yet) — fall back to scene poster media.
      return getScenePosterUrl(best);
    },
  }), [displayScene, resolveStart, visibleScenes]);

  // Single set of V1 video elements — once mounted, stay alive forever.
  // Overlay scenes (V2+) render separately in SceneOverlayLayer below.
  const nearbyRenderSceneIds = useMemo(() => new Set(getNearbyPreviewScenes(visibleScenes, displayScene?.id, resolveStart, 1, 2).map((s) => s.id)), [displayScene?.id, resolveStart, visibleScenes]);
  const renderScenes = useMemo(() => {
    if (!visibleScenes.length) return [];
    return visibleScenes.filter(
      (s) => (visitedIds.has(s.id) || s.id === displayScene?.id) && (s.trackIndex || 1) === 1,
    );
  }, [displayScene?.id, visibleScenes, visitedIds]);

  // Overlay scenes (V2+) that use the stitched-video path. Scenes handled by
  // ShotSequencerV2 are EXCLUDED — otherwise SceneOverlayLayer also mounts an
  // empty wrapper div at the same z-index and masks the shot videos below it.
  const overlayScenes = useMemo(() => {
    if (!visibleScenes.length) return [];
    return visibleScenes.filter(
      (s) => (s.trackIndex || 1) >= 2 && !sceneNeedsShotSequencer(s),
    );
  }, [visibleScenes]);

  // V1-lane scenes that must composite BENEATH an active higher-lane scene
  // (e.g. a V1 background image behind a V2 alpha-webm human cutout). The V1
  // render pool hides itself whenever a V2+ overlay is active — this gated
  // SceneOverlayLayer instance takes over V1 rendering during that window,
  // stacked at zIndexBase 0 so it sits under the z10+ overlay scenes.
  const underlayScenes = useMemo(() => {
    if (!visibleScenes.length) return [];
    return visibleScenes.filter(
      (s) => (s.trackIndex || 1) === 1 && !sceneNeedsShotSequencer(s),
    );
  }, [visibleScenes]);
  const hasHigherLaneSceneAt = useCallback(
    (time: number): boolean => getActiveOverlaysFromRanges(playheadRanges.sceneRanges, time).length > 0,
    [playheadRanges],
  );

  // Shared map of shot-sequencer active videos — keyed by scene id. Canvas
  // compositor (in preview-panel) reads this via getActiveVideo to draw the
  // correct shot's video when the scene has no stitched video.
  const shotSeqActiveVideoRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const handleShotSequencerActive = useCallback(
    (sceneId: string, vid: HTMLVideoElement | null) => {
      if (vid) shotSeqActiveVideoRef.current.set(sceneId, vid);
      else shotSeqActiveVideoRef.current.delete(sceneId);
    },
    [],
  );

  // Parent-owned map of V2+ stitched-overlay <video> elements, populated by
  // SceneOverlayLayer. Without this, `getActiveVideo()` (the canvas compositor's
  // source) has no way to find an overlay's video element — when any text/sticker
  // clip flips needsCanvas=true, the ScenePreview DOM is hidden and the overlay
  // vanishes from the preview until the clip ends.
  const overlayVideoRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const handleOverlayVideoRef = useCallback(
    (sceneId: string, vid: HTMLVideoElement | null) => {
      if (vid) overlayVideoRef.current.set(sceneId, vid);
      else overlayVideoRef.current.delete(sceneId);
    },
    [],
  );

  // ── Aspect-ratio + transform controls ─────────────────────
  const projectRatio = useMemo(() => {
    if (!projectAspectRatio) return 16 / 9;
    const m = projectAspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!m) return 16 / 9;
    return Number(m[1]) / Number(m[2]);
  }, [projectAspectRatio]);

  // Debounced transform commits — the preview updates its own state on drag
  // and we only push to the server ~200ms after the user settles.
  const transformCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTransformCommitTimer = useCallback(() => {
    if (!transformCommitTimerRef.current) return;
    clearTimeout(transformCommitTimerRef.current);
    transformCommitTimerRef.current = null;
  }, []);
  const commitTransform = useCallback(
    (sceneId: string, updates: Parameters<NonNullable<typeof onUpdateSceneTransform>>[1]) => {
      if (!onUpdateSceneTransform) return;
      clearTransformCommitTimer();
      transformCommitTimerRef.current = setTimeout(() => {
        transformCommitTimerRef.current = null;
        if (!docVisibleRef.current) return;
        onUpdateSceneTransform(sceneId, updates);
      }, 200);
    },
    [clearTransformCommitTimer, onUpdateSceneTransform],
  );
  useEffect(() => {
    if (!docVisible) clearTransformCommitTimer();
    return () => clearTransformCommitTimer();
  }, [clearTransformCommitTimer, docVisible]);

  // Local cache of measured source dimensions — keyed by scene id. This
  // avoids waiting on the server round-trip to fill scene.sourceWidth/Height,
  // so the transform bounding box can fit the real image the instant it loads.
  const [sourceDims, setSourceDims] = useState<Map<string, { w: number; h: number }>>(
    new Map(),
  );
  // Idempotency guard — once we have dims for a scene, NEVER re-measure.
  // ShotSequencerV2 renders many <video> elements (one per shot) with
  // different natural dimensions. If we accept each one's measurement, they
  // fight each other each render and trigger React's max-update-depth error.
  // First-write-wins: the first non-zero dims we see is what we use.
  const measuredRef = useRef<Set<string>>(new Set());
  const backfilledRef = useRef<Set<string>>(new Set());
  const handleSourceLoaded = useCallback(
    (s: SceneData, w: number, h: number, durationSeconds?: number) => {
      markSceneMediaReady(s.id);
      if (durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        storeApi.getState().setSourceDuration(s.id, durationSeconds);
      }
      if (!w || !h) return;
      if (measuredRef.current.has(s.id)) return; // first-write-wins
      measuredRef.current.add(s.id);
      setSourceDims((prev) => {
        const next = new Map(prev);
        next.set(s.id, { w, h });
        return next;
      });
      if (!s.sourceWidth || !s.sourceHeight) {
        if (!backfilledRef.current.has(s.id)) {
          backfilledRef.current.add(s.id);
          onUpdateSceneTransform?.(s.id, { sourceWidth: w, sourceHeight: h });
        }
      }
    },
    [markSceneMediaReady, onUpdateSceneTransform],
  );

  // Drag-to-pan in the preview. Only active when fit_mode === "cover" OR the
  // user has already zoomed beyond 1.0 (otherwise panning an object-contain
  // image just moves it into the letterbox, which is useless).
  const panDragRef = useRef<{
    sceneId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    containerW: number;
    containerH: number;
  } | null>(null);
  const [panLive, setPanLive] = useState<{ sceneId: string; offsetX: number; offsetY: number } | null>(null);
  // Which center guides are actively snapped during a pan drag.
  const [panSnapGuides, setPanSnapGuides] = useState<{ x: boolean; y: boolean } | null>(null);
  const [scaleLive, setScaleLive] = useState<{
    sceneId: string;
    scale: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  // Clear the live overrides once the scene prop (fed by polling) catches up
  // with the committed values. Without this, the image snaps back to its old
  // position/scale on mouse-up because the server round-trip hasn't landed.
  useEffect(() => {
    if (scaleLive && scenes) {
      const s = scenes.find((sc) => sc.id === scaleLive.sceneId);
      if (s) {
        const matchScale = Math.abs(Number(s.transformScale ?? 1) - scaleLive.scale) < 0.02;
        const matchX = Math.abs(Number(s.transformOffsetX ?? 0) - scaleLive.offsetX) < 0.5;
        const matchY = Math.abs(Number(s.transformOffsetY ?? 0) - scaleLive.offsetY) < 0.5;
        if (matchScale && matchX && matchY) setScaleLive(null);
      }
    }
    if (panLive && scenes) {
      const s = scenes.find((sc) => sc.id === panLive.sceneId);
      if (s) {
        const matchX = Math.abs(Number(s.transformOffsetX ?? 0) - panLive.offsetX) < 0.5;
        const matchY = Math.abs(Number(s.transformOffsetY ?? 0) - panLive.offsetY) < 0.5;
        if (matchX && matchY) setPanLive(null);
      }
    }
  }, [scenes, scaleLive, panLive]);
  // CapCut-style: transform chrome is hidden until the user clicks the media.
  // Click outside the content box deselects and hides the box again.
  const [transformSelected, setTransformSelected] = useState(false);

  // ── Screen-frame measurement ─────────────────────────────
  // All media renders INSIDE a div sized to the project's 16:9 (or whatever)
  // aspect-ratio box. If we let media render at the full preview-host size,
  // `object-fit: contain` letterboxes against the HOST (not the screen),
  // which means media extends into the padding area and gets visually
  // cropped by the screen-rectangle vignette — subjects' heads get cut off.
  const previewHostRef = useRef<HTMLDivElement>(null);
  const [hostSize, setHostSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const host = previewHostRef.current;
    if (!host) return;
    const compute = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setHostSize((prev) => {
        if (prev && Math.abs(prev.w - rect.width) < 0.5 && Math.abs(prev.h - rect.height) < 0.5) return prev;
        return { w: rect.width, h: rect.height };
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  const screenFrame = useMemo(() => {
    if (!hostSize) return null;
    return getPreviewScreenFrame(hostSize, projectRatio);
  }, [hostSize, projectRatio]);

  // ── Scene motion (phase 10b) ─────────────────────────────
  // Tagged scene media (sceneMediaProps) get their transform/opacity imperatively, once per playhead tick
  // and after every render, so animated scenes never re-render React per frame. The tagged elements are
  // queried once and cached until the DOM under the frame changes: a MutationObserver drops the cache and
  // writes again, which also catches elements child layers mount in response to a tick (before paint).
  const mediaFrameRef = useRef<HTMLDivElement>(null);
  const motionWrittenRef = useRef(new Set<HTMLElement>());
  const motionElementsRef = useRef<HTMLElement[] | null>(null);
  const motionStateRef = useRef({ scenes, resolveStart, screenFrame, panLive, scaleLive });
  motionStateRef.current = { scenes, resolveStart, screenFrame, panLive, scaleLive };
  const applySceneMotion = useCallback((time: number) => {
    const root = mediaFrameRef.current;
    const elements = motionElementsRef.current ??= root ? Array.from(root.querySelectorAll<HTMLElement>("[data-scene-motion]")) : [];
    writeSceneMotion(elements, motionWrittenRef.current, time, motionStateRef.current);
  }, []);
  useLayoutEffect(() => {
    // A render may have re-tagged or replaced elements.
    motionElementsRef.current = null;
    applySceneMotion(storeApi.getState().currentTime);
  });
  useEffect(() => {
    const unsubscribe = storeApi.subscribe((s) => s.currentTime, (time) => applySceneMotion(time));
    const root = mediaFrameRef.current;
    let observer: MutationObserver | null = null;
    if (root && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        motionElementsRef.current = null;
        applySceneMotion(storeApi.getState().currentTime);
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-scene-motion"] });
    }
    return () => {
      unsubscribe();
      observer?.disconnect();
    };
  }, [storeApi, applySceneMotion]);
  const beginPan = useCallback(
    (e: React.MouseEvent, s: SceneData) => {
      if (!onUpdateSceneTransform) return;
      const scale = Number(s.transformScale ?? 1) || 1;
      const mode = s.fitMode || "contain";
      if (mode !== "cover" && scale <= 1.0) return; // nothing to pan
      const container = (e.currentTarget as HTMLElement).getBoundingClientRect();
      panDragRef.current = {
        sceneId: s.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: Number(s.transformOffsetX ?? 0),
        origY: Number(s.transformOffsetY ?? 0),
        containerW: container.width,
        containerH: container.height,
      };
      e.preventDefault();
    },
    [onUpdateSceneTransform],
  );
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const pd = panDragRef.current;
      if (!pd) return;
      const dxPct = ((e.clientX - pd.startX) / pd.containerW) * 100;
      const dyPct = ((e.clientY - pd.startY) / pd.containerH) * 100;
      let offsetX = pd.origX + dxPct;
      let offsetY = pd.origY + dyPct;
      // Center snap: within 1.5% of the frame center the media locks to it
      // and the alignment guides light up (CapCut-style).
      const snapX = Math.abs(offsetX) < 1.5;
      const snapY = Math.abs(offsetY) < 1.5;
      if (snapX) offsetX = 0;
      if (snapY) offsetY = 0;
      setPanSnapGuides({ x: snapX, y: snapY });
      setPanLive({ sceneId: pd.sceneId, offsetX, offsetY });
      commitTransform(pd.sceneId, { transformOffsetX: offsetX, transformOffsetY: offsetY });
    }
    function onUp() {
      panDragRef.current = null;
      setPanLive(null);
      setPanSnapGuides(null);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [commitTransform]);

  // Apply live drag override so the preview tracks the cursor without waiting
  // for the debounced server commit. Covers both pan (translate) and resize
  // (scale + offset shift for anchor-opposite-corner behavior) so corner-drag
  // feels instant and the opposite corner stays pinned.
  const displayScene2 = useMemo(() => {
    if (!displayScene) return displayScene;
    let next = displayScene;
    if (panLive && panLive.sceneId === displayScene.id) {
      next = { ...next, transformOffsetX: panLive.offsetX, transformOffsetY: panLive.offsetY };
    }
    if (scaleLive && scaleLive.sceneId === displayScene.id) {
      next = {
        ...next,
        transformScale: scaleLive.scale,
        transformOffsetX: scaleLive.offsetX,
        transformOffsetY: scaleLive.offsetY,
      };
    }
    return next;
  }, [displayScene, panLive, scaleLive]);

  const { mismatch: dispMismatch, sourceRatio: dispSourceRatio } = sceneAspectMismatch(
    displayScene2 || null,
    projectRatio,
  );
  const musicAudioSrc = docVisible && musicUrl ? media.resolveMediaUrl(musicUrl) : null;

  return (
    <div className="relative h-full flex flex-col">
      {musicAudioSrc && <audio ref={audioRef} src={musicAudioSrc} preload="metadata" />}
      <audio ref={voiceoverRef} preload="metadata" />

      <div
        ref={previewHostRef}
        className="flex-1 min-h-0 rounded-lg overflow-hidden relative bg-black"
        onClick={(e) => {
          // Click on empty area deselects the transform chrome.
          if (e.target === e.currentTarget) setTransformSelected(false);
        }}
      >
        {/* Frame-sized media wrapper. All media renders INSIDE this box so
            `object-fit: contain` fits against the screen rect (not the full
            preview host). Without this wrapper, the image letterboxes against
            the preview host and the screen rect visually crops it — cutting
            off subjects' heads. */}
        <div
          ref={mediaFrameRef}
          className="absolute overflow-hidden"
          style={{
            width: screenFrame?.w ?? 0,
            height: screenFrame?.h ?? 0,
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 1,
          }}
          onClick={(e) => {
            // Clicking the frame (not a child media element) should still fall
            // through to the transform-chrome click handlers below.
            if (e.target === e.currentTarget) setTransformSelected(false);
          }}
        >
        {/* Below-track media clips — timeline video/image clips on video lanes
            LOWER than the active scene's lane, stacked at zIndex 0 BEHIND the
            scene video so alpha scene footage (background-removed webm) shows
            them through its transparent areas. */}
        {underCandidateClips.length > 0 && (
          <TimelineUnderClipLayer
            clips={underCandidateClips}
            timelineTracks={timelineTracks}
            playing={playing}
            resolveSceneLane={resolveSceneLane}
            screenFrame={screenFrame}
            projectRatio={projectRatio}
          />
        )}

        {/* Under-scene layer — V1-lane scenes render BEHIND an active V2+
            scene (zIndexBase 0, so z1 vs overlay z12+). Gated: inert whenever
            no higher-lane scene is active, because then the V1 pool below
            owns V1 playback. Symmetric counterpart of SceneOverlayLayer. */}
        {underlayScenes.length > 0 && (
          <SceneOverlayLayer
            scenes={underlayScenes}
            resolveStart={resolveStart}
            playing={playing}
            baseAudioTrackAudible={baseSceneAudioTrackAudible}
            baseAudioTrackVolume={baseSceneAudioTrackVolume}
            videoTrackVolumes={videoTrackVolumes}
            timelineClips={timelineClips}
            onSourceLoaded={handleSourceLoaded}
            panLive={panLive}
            scaleLive={scaleLive}
            screenFrame={screenFrame}
            zIndexBase={0}
            activeGate={hasHigherLaneSceneAt}
          />
        )}

        {/* Single pool of video elements — always mounted, used for both preload and playback */}
        {(() => {
          // If a V2+ overlay is active at the current playhead, hide the V1
          // layer entirely. Stops the duplicate-image layering where V1's
          // placeholder start-frame renders underneath a V2 image overlay.
          const t = storeApi.getState().currentTime;
          return getActiveOverlays(t).length > 0;
        })() ? null : renderScenes.map((s) => {
          const isVisible = playing
            ? readySceneId === s.id
            : displayScene && s.id === displayScene.id;
          // Cross-dissolve: the outgoing scene sits ON TOP of the incoming one
          // and fades out, driven per-tick by the playhead subscription.
          const dissolve = playheadRenderState.dissolveOutgoing;
          const isDissolvingOut = !isVisible && dissolve?.sceneId === s.id;
          // Only keep timeline-nearby media loaded — rest have src removed to free GPU memory.
          const shouldLoad = s.id === displayScene?.id || nearbyRenderSceneIds.has(s.id);
          const sceneVideoUrl = getVideoUrl(s);
          const previewVideoSrc = shouldLoad && sceneVideoUrl ? cachedUrl(sceneVideoUrl) : null;
          const rawScenePosterSrc = getScenePosterUrl(s);
          const scenePosterSrc = rawScenePosterSrc ? media.resolveMediaUrl(rawScenePosterSrc) : undefined;
          return (
          <div
            key={s.id}
            className="absolute inset-0"
            data-testid={isDissolvingOut ? "scene-dissolve-outgoing" : undefined}
            style={{
              zIndex: isDissolvingOut ? 3 : isVisible ? 2 : 1,
              opacity: isDissolvingOut ? dissolve.opacity : isVisible ? 1 : 0,
              transform: isDissolvingOut ? dissolve.transform : undefined,
              clipPath: isDissolvingOut ? dissolve.clipPath : undefined,
              filter: isDissolvingOut ? dissolve.filter : undefined,
              transition: isDissolvingOut ? "none" : "opacity 150ms ease-in-out",
              pointerEvents: isVisible ? "auto" : "none",
            }}
          >
            {(() => {
              // Pick the active shot's keyframe at the current playhead time,
              // falling back to scene.startImageUrl. Without this the preview
              // always shows the scene-level image (usually the same URL as
              // shot 1's original), so regenerating shot 2/3/N leaves the
              // preview out of sync with the Properties shot thumbnail.
              let activeUrl: string | null = null;
              const shots = parseShotBreakdown<CopyVideoShotImage & { duration?: string | number }>(s.shotBreakdown);
              if (shots.length > 0) {
                const localTime = playheadRenderState.currentTime - resolveStart(s);
                let cursor = 0;
                for (let i = 0; i < shots.length; i++) {
                  const sh = shots[i];
                  const dur = shotDurationSeconds(sh);
                  if (dur <= 0) continue;
                  if (localTime >= cursor && localTime < cursor + dur) {
                    activeUrl = getShotPreviewImageUrl(shots, sh, i);
                    break;
                  }
                  cursor += dur;
                }
                if (!activeUrl) {
                  for (let i = shots.length - 1; i >= 0; i--) {
                    const sh = shots[i];
                    const imageUrl = getShotPreviewImageUrl(shots, sh, i);
                    if (imageUrl) {
                      activeUrl = imageUrl;
                      break;
                    }
                  }
                }
              }
              const imgUrl = activeUrl || getScenePosterUrl(s);
              const rawPreviewImageSrc = shouldLoad ? imgUrl : null;
              const previewImageSrc = rawPreviewImageSrc ? media.resolveMediaUrl(rawPreviewImageSrc) : null;
              if (!previewImageSrc || sceneVideoUrl) return null;
              return (
                <img
                  src={previewImageSrc}
                  alt=""
                  className="absolute inset-0 w-full h-full"
                  {...sceneMediaProps(mergeLiveTransforms(s, panLive, scaleLive), screenFrame)}
                  loading={isVisible ? "eager" : "lazy"}
                  decoding="async"
                  ref={(el) => {
                    if (el && el.naturalWidth > 0) {
                      handleSourceLoaded(s, el.naturalWidth, el.naturalHeight);
                    }
                  }}
                  onLoad={(e) => handleSourceLoaded(s, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                />
              );
            })()}
            {previewVideoSrc && (
               <video
                 className="absolute inset-0 w-full h-full"
                 {...sceneMediaProps(mergeLiveTransforms(s, panLive, scaleLive), screenFrame)}
                 src={previewVideoSrc}
                poster={scenePosterSrc}
                playsInline
                muted={!shouldPlaySceneVideoAudio(s, baseSceneAudioTrackAudible, timelineClips, playheadRenderState.currentTime)}
                preload="auto"
                onLoadedMetadata={(e) => handleSourceLoaded(s, e.currentTarget.videoWidth, e.currentTarget.videoHeight, e.currentTarget.duration)}
                ref={(el) => {
                  if (el) {
                    videoRefsMap.current.set(s.id, el);
                    // If metadata is already available (cached), measure now.
                    if (el.videoWidth > 0 && el.videoHeight > 0) {
                      handleSourceLoaded(s, el.videoWidth, el.videoHeight);
                    }
                  } else {
                    videoRefsMap.current.delete(s.id);
                   }
                 }}
               />
            )}
          </div>
          );
        })}

        {/* V2+ overlay scenes — composited on top of V1 during playback/scrub */}
        <SceneOverlayLayer
          scenes={overlayScenes}
          resolveStart={resolveStart}
          playing={playing}
          baseAudioTrackAudible={baseSceneAudioTrackAudible}
          baseAudioTrackVolume={baseSceneAudioTrackVolume}
          videoTrackVolumes={videoTrackVolumes}
          timelineClips={timelineClips}
          onSourceLoaded={handleSourceLoaded}
          onVideoRef={handleOverlayVideoRef}
          panLive={panLive}
          scaleLive={scaleLive}
          screenFrame={screenFrame}
        />

        {/* Shot sequencers for scenes with no stitched video but shots have
            video_urls. Skip V1 sequencers when a V2+ overlay is active at
            the current time — otherwise V1's shot videos render UNDERNEATH
            the V2 overlay producing the "two image layers" / "background
            moves with image" effect the user complained about. */}
        {(() => {
          const t = storeApi.getState().currentTime;
          const hasOverlay = getActiveOverlays(t).length > 0;
          const filtered = visibleScenes.filter(sceneNeedsShotSequencer).filter((s) => {
            if (!hasOverlay) return true;
            return (s.trackIndex || 1) >= 2; // only keep V2+ sequencers when overlay active
          });
          return filtered.map((s) => (
            <ShotSequencerV2
              key={`seq-${s.id}`}
              scene={s}
              sceneStart={resolveStart(s)}
              playing={playing}
              baseAudioTrackAudible={baseSceneAudioTrackAudible}
              baseAudioTrackVolume={baseSceneAudioTrackVolume * (videoTrackVolumes[s.trackIndex || 1] ?? 1)}
              timelineClips={timelineClips}
              onActiveShotChange={handleShotSequencerActive}
              onSourceLoaded={handleSourceLoaded}
              panLive={panLive}
              scaleLive={scaleLive}
              screenFrame={screenFrame}
            />
          ));
        })()}


        {/* Fallback for scenes without video — shot-by-shot storyboard player.
            Skip when ShotSequencerV2 is handling this scene (prevents the
            fallback's "Shot N/M prompt" text from desyncing with the actual
            shot video playing above it). */}
        {displayScene && !getVideoUrl(displayScene) && !sceneNeedsShotSequencer(displayScene) && (() => {
          const shots = parseShotBreakdown<{ prompt: string; duration?: string | number; duration_seconds?: string | number }>(displayScene.shotBreakdown);
          const totalDur = totalShotDuration(shots);
          const safeIdx = Math.min(activeShotIndex, shots.length - 1);
          const currentShot = shots[safeIdx] || null;

          // Cumulative time up to current shot (for progress bar)
          const cumTime = shots.slice(0, safeIdx).reduce((t, s) => t + shotDurationSeconds(s), 0);

          const playShotSequence = () => {
            if (!docVisibleRef.current) return;
            clearShotSequenceTimer();
            setShotPlaying(true);
            setActiveShotIndex(0);
            const advanceShot = (idx: number) => {
              if (!docVisibleRef.current) return;
              if (idx >= shots.length) { setShotPlaying(false); return; }
              setActiveShotIndex(idx);
              const dur = (shotDurationSeconds(shots[idx]) || 3) * 1000;
              shotTimerRef.current = setTimeout(() => advanceShot(idx + 1), dur);
            };
            advanceShot(0);
          };

          const stopShotSequence = () => {
            clearShotSequenceTimer();
            setShotPlaying(false);
          };

          return (shots.length > 0 || getScenePosterUrl(displayScene)) ? (
            <div className="absolute inset-0 z-2 pointer-events-none">
              {/* The render pool above already draws startImageUrl with live
                  transform overrides. Don't duplicate the <img> here — that
                  second copy stays put while the pool image pans, producing
                  the "background moves separately from image" ghosting and
                  the "2 image layers" visual bug. */}


            </div>
          ) : (
            <div className="absolute inset-0 z-2 flex flex-col items-center justify-center gap-2">
              <Film className="h-10 w-10 text-[#3A3A3F]" />
              <p className="text-xs text-[#6B6B73]">{tr("sceneN", { n: displayScene.order + 1 })}</p>
              <p className="text-[10px] text-[#6B6B73] max-w-xs text-center">{displayScene.caption}</p>
            </div>
          );
        })()}

        {!displayScene && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-[#6B6B73]">{tr("selectScene")}</p>
          </div>
        )}
        {docVisible && (
          <LaneLookOverlay
            ranges={playheadRanges.sceneRanges}
            getSceneVideo={getSceneVideoForLooks}
            screenFrame={screenFrame}
            effectSpans={suppressEffectLayer ? EMPTY_CLIPS : builtinEffectSpans}
            footageSpans={suppressEffectLayer ? effectFootageClips : EMPTY_CLIPS}
            onLaneCanvas={handleLaneCanvas}
          />
        )}
        </div>{/* /frame-sized media wrapper */}

        {/* Effect layers fallback: WebGL canvas (z-index 3) over the footage.
            Effects apply over everything below them, graphics and text
            included (phase 11), which the parent compositor does; this
            footage-only pass runs only while it cannot (GL failed).
            Self-positions to the on-screen video rect. */}
        {hasEnabledEffectClips && docVisible && !suppressEffectLayer && (
          <Suspense fallback={null}>
            <LazyEffectLayerOverlay
              getActiveVideo={getActiveVideoForEffects}
              clips={effectOverlayClips}
              tracks={timelineTracks}
            />
          </Suspense>
        )}

        {/* Remotion graphics clips — topmost media overlay, frame-locked to
            the playhead. Sized/positioned to the same screen frame as the
            media wrapper so graphics align with the export area. Sits below
            the transition dip overlay (z12) and the screen-indicator chrome. */}
        {domRemotionClips.length > 0 && (
          <div
            data-testid="remotion-overlay-layer"
            className="absolute overflow-hidden pointer-events-none"
            style={{
              width: screenFrame?.w ?? 0,
              height: screenFrame?.h ?? 0,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 11,
            }}
          >
            <Suspense fallback={null}>
              <RemotionTimelineOverlay
                clips={domRemotionClips}
                playing={playing}
                projectRatio={projectRatio}
                transformOverride={remotionTransformOverride}
                layerStyle={remotionLayerStyle}
              />
            </Suspense>
          </div>
        )}

        {sceneTransitionOverlay && (
          <div
            data-testid="scene-transition-overlay"
            className="absolute pointer-events-none"
            style={{
              width: screenFrame?.w ?? 0,
              height: screenFrame?.h ?? 0,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 12,
              backgroundColor: sceneTransitionOverlay.color,
              opacity: sceneTransitionOverlay.opacity,
            }}
          />
        )}

        {/* Center alignment guides — light up while a pan drag is snapped. */}
        {panSnapGuides && (panSnapGuides.x || panSnapGuides.y) && (
          <div className="pointer-events-none absolute inset-0 z-40">
            {panSnapGuides.x && (
              <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-amber-400/90" />
            )}
            {panSnapGuides.y && (
              <div className="absolute top-1/2 left-0 w-full h-px -translate-y-1/2 bg-amber-400/90" />
            )}
          </div>
        )}
        {/* ── Always-visible project screen indicator ───────────────
            CapCut-style: dark tint on everything OUTSIDE the project's
            export area so the user always knows what frame size will ship. */}
        <ProjectScreenIndicator
          projectRatio={projectRatio}
          selected={transformSelected}
          hidden={playing}
          onClickScreen={() => {
            if (playing || !onUpdateSceneTransform) return;
            const t = storeApi.getState().currentTime;
            const overlays = getActiveOverlays(t);
            const topmost = overlays.length > 0 ? overlays[overlays.length - 1] : null;
            // Timeline selection wins — with stacked lanes the topmost layer
            // otherwise hogs the handles and lower scenes can't be resized.
            const selId = storeApi.getState().selectedSceneId;
            const selScene = selId ? visibleScenes.find((s) => s.id === selId) ?? null : null;
            const effective = (selScene && sceneSupportsTransform(selScene)) ? selScene : (topmost || displayScene);
            if (!sceneSupportsTransform(effective)) return;
            // Phase 10b: the preview canvas owns scene handles (move, scale, rotate, snapping); selecting the scene
            // shows them there instead of this legacy resize chrome.
            if (effective) storeApi.getState().selectScene(effective.id);
          }}
        />

        {/* ── Transform chrome (resize box + toolbar) ──────────── */}
        {!playing && transformSelected && displayScene && onUpdateSceneTransform && (() => {
          const t = storeApi.getState().currentTime;
          const overlays = getActiveOverlays(t);
          const topmost = overlays.length > 0 ? overlays[overlays.length - 1] : null;
          // Same rule as onClickScreen: the timeline-selected scene owns the
          // transform handles when it's transformable.
          const selId = storeApi.getState().selectedSceneId;
          const selScene = selId ? visibleScenes.find((s) => s.id === selId) ?? null : null;
          const effective = (selScene && sceneSupportsTransform(selScene))
            ? selScene
            : (topmost || displayScene2 || displayScene);
          if (!sceneSupportsTransform(effective)) return null;
          const withLivePan =
            panLive && panLive.sceneId === effective.id
              ? { ...effective, transformOffsetX: panLive.offsetX, transformOffsetY: panLive.offsetY }
              : effective;
          const withLiveScale =
            scaleLive && scaleLive.sceneId === effective.id
              ? {
                  ...withLivePan,
                  transformScale: scaleLive.scale,
                  transformOffsetX: scaleLive.offsetX,
                  transformOffsetY: scaleLive.offsetY,
                }
              : withLivePan;
          const base = withLiveScale;
          const localDim = sourceDims.get(base.id);
          const mergedScene: SceneData = {
            ...base,
            sourceWidth: localDim?.w ?? base.sourceWidth ?? null,
            sourceHeight: localDim?.h ?? base.sourceHeight ?? null,
          };
          return (
            <FitControlsOverlay
              scene={mergedScene}
              projectRatio={projectRatio}
              sourceRatio={dispSourceRatio}
              mismatch={dispMismatch}
              screenFrame={screenFrame}
              onUpdate={(updates) => {
                commitTransform(effective.id, updates);
              }}
              onLiveScale={(live) => {
                setScaleLive(live);
              }}
              onDeselect={() => setTransformSelected(false)}
            />
          );
        })()}

        {buffering && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/50 backdrop-blur-[2px] gap-2">
            <div className="h-10 w-10 rounded-lg bg-white/10 flex items-center justify-center">
              <Loader2 className="h-5 w-5 text-white animate-spin" />
            </div>
            <span className="text-[10px] font-medium text-white/70">{tr("buffering")}</span>
          </div>
        )}
      </div>
    </div>
  );
});

// ── Fit-mode + zoom + mismatch banner ───────────────────────
function FitControlsOverlay({
  scene,
  projectRatio,
  sourceRatio,
  mismatch,
  screenFrame,
  onUpdate,
  onLiveScale,
  onDeselect,
}: {
  scene: SceneData;
  projectRatio: number;
  sourceRatio: number | null;
  mismatch: boolean;
  /** The actual screen-rect the media is rendered into. Transform math has to
   * use THIS (not the preview host) for offsets and sizes so the chrome and
   * the media stay pixel-aligned during pan/resize. */
  screenFrame: { w: number; h: number } | null;
  onUpdate: (u: {
    fitMode?: "contain" | "cover" | "fill";
    transformScale?: number;
    transformOffsetX?: number;
    transformOffsetY?: number;
  }) => void;
  /** Live drag feedback — fires on every mousemove with the in-flight
   * scale + offset. Pass null to clear (drag end). */
  onLiveScale?: (
    live:
      | { sceneId: string; scale: number; offsetX: number; offsetY: number }
      | null,
  ) => void;
  /** Called when the user clicks empty space to deselect the transform. */
  onDeselect?: () => void;
}) {
  const tr = useTimelineMessages("scenePreview");
  const scale = Number(scene.transformScale ?? 1) || 1;
  // ── Content bounding box ─────────────────────────────────
  // Transform math is done in SCREEN-FRAME space (the inscribed 16:9 rect
  // the media actually renders into), not preview-host space. This keeps the
  // chrome pixel-aligned with the media during pan/resize.
  const frameHostRef = useRef<HTMLDivElement>(null);
  const containerSize = screenFrame;

  // Natural rect occupied by the scene's image/video at scale=1, based on
  // source aspect ratio and fit mode. Falls back to project ratio when source
  // dimensions haven't been measured yet.
  const contentRect = useMemo(() => {
    if (!containerSize) return null;
    const sW = Number(scene.sourceWidth || 0);
    const sH = Number(scene.sourceHeight || 0);
    const srcR = sW > 0 && sH > 0 ? sW / sH : projectRatio;
    const cR = containerSize.w / containerSize.h;
    const mode = (scene.fitMode || "contain") as "contain" | "cover" | "fill";
    let w = containerSize.w;
    let h = containerSize.h;
    if (mode === "contain") {
      if (srcR > cR) { w = containerSize.w; h = w / srcR; }
      else           { h = containerSize.h; w = h * srcR; }
    } else if (mode === "cover") {
      if (srcR < cR) { w = containerSize.w; h = w / srcR; }
      else           { h = containerSize.h; w = h * srcR; }
    } // fill = full container, already set
    return { w, h };
  }, [containerSize, scene.sourceWidth, scene.sourceHeight, scene.fitMode, projectRatio]);
  // Drag offsets are stored as % of CONTAINER (not frame), to stay consistent
  // with the CSS `transform: translate(X%,Y%)` which is % of the element (and
  // the element is container-sized since it has absolute inset-0).
  const frameSize = contentRect; // existing code below reads `frameSize` — alias

  type Corner = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
  const resizeRef = useRef<{
    corner: Corner;
    startX: number;
    startY: number;
    origScale: number;
    origOffsetX: number;
    origOffsetY: number;
    contentW: number;
    contentH: number;
    containerW: number;
    containerH: number;
  } | null>(null);
  const beginResize = useCallback(
    (corner: Corner) => (e: React.MouseEvent) => {
      if (!contentRect || !containerSize) return;
      e.stopPropagation();
      e.preventDefault();
      resizeRef.current = {
        corner,
        startX: e.clientX,
        startY: e.clientY,
        origScale: scale,
        origOffsetX: Number(scene.transformOffsetX ?? 0),
        origOffsetY: Number(scene.transformOffsetY ?? 0),
        contentW: contentRect.w,
        contentH: contentRect.h,
        containerW: containerSize.w,
        containerH: containerSize.h,
      };
    },
    [contentRect, containerSize, scale, scene.transformOffsetX, scene.transformOffsetY],
  );
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const rs = resizeRef.current;
      if (!rs) return;
      const dx = e.clientX - rs.startX;
      const dy = e.clientY - rs.startY;
      let scaleSignal = 0;
      const avgContent = (rs.contentW + rs.contentH) / 2;
      switch (rs.corner) {
        case "e": scaleSignal = dx / rs.contentW; break;
        case "w": scaleSignal = -dx / rs.contentW; break;
        case "s": scaleSignal = dy / rs.contentH; break;
        case "n": scaleSignal = -dy / rs.contentH; break;
        case "se": scaleSignal = (dx + dy) / avgContent / 2; break;
        case "nw": scaleSignal = (-dx - dy) / avgContent / 2; break;
        case "ne": scaleSignal = (dx - dy) / avgContent / 2; break;
        case "sw": scaleSignal = (-dx + dy) / avgContent / 2; break;
      }
      const nextScale = Math.max(
        0.1,
        Math.min(10, rs.origScale + scaleSignal * 2),
      );
      const s = Math.round(nextScale * 100) / 100;

      // Anchor-opposite-corner math in pixels, then converted to % of the
      // CONTAINER (offsets are stored as `translate(X%, Y%)` of the container).
      const dScale = s - rs.origScale;
      const dirX = rs.corner.includes("e") ? 1 : rs.corner.includes("w") ? -1 : 0;
      const dirY = rs.corner.includes("s") ? 1 : rs.corner.includes("n") ? -1 : 0;
      const pxShiftX = dirX * dScale * (rs.contentW / 2);
      const pxShiftY = dirY * dScale * (rs.contentH / 2);
      const nextOffsetX = rs.origOffsetX + (pxShiftX / rs.containerW) * 100;
      const nextOffsetY = rs.origOffsetY + (pxShiftY / rs.containerH) * 100;

      onLiveScale?.({
        sceneId: scene.id,
        scale: s,
        offsetX: nextOffsetX,
        offsetY: nextOffsetY,
      });
      onUpdate({
        transformScale: s,
        transformOffsetX: Math.round(nextOffsetX * 10) / 10,
        transformOffsetY: Math.round(nextOffsetY * 10) / 10,
      });
    }
    function onUp() {
      // Do NOT clear the live state on drop. The scale/offset we set need to
      // survive until the server commit+refetch lands and the scene prop
      // reflects the new values — otherwise the image snaps back visually.
      // The parent owns clearing `scaleLive` once the scene update matches.
      resizeRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onUpdate, onLiveScale, scene.id]);

  // ── Pan drag (dragging the content box body) ──────────────
  // Unconditionally available while the content is selected — CapCut lets you
  // move a clip anywhere within/outside the screen, even at 100% scale, so the
  // user can off-center a letterboxed image or reveal a specific crop.
  const panRef = useRef<{
    startX: number;
    startY: number;
    origOffsetX: number;
    origOffsetY: number;
    containerW: number;
    containerH: number;
  } | null>(null);
  const beginPanBox = useCallback(
    (e: React.MouseEvent) => {
      if (!containerSize) return;
      e.stopPropagation();
      e.preventDefault();
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origOffsetX: Number(scene.transformOffsetX ?? 0),
        origOffsetY: Number(scene.transformOffsetY ?? 0),
        containerW: containerSize.w,
        containerH: containerSize.h,
      };
    },
    [containerSize, scene.transformOffsetX, scene.transformOffsetY],
  );
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const p = panRef.current;
      if (!p) return;
      const dxPct = ((e.clientX - p.startX) / p.containerW) * 100;
      const dyPct = ((e.clientY - p.startY) / p.containerH) * 100;
      const nx = p.origOffsetX + dxPct;
      const ny = p.origOffsetY + dyPct;
      onLiveScale?.({
        sceneId: scene.id,
        scale: Number(scene.transformScale ?? 1) || 1,
        offsetX: nx,
        offsetY: ny,
      });
      onUpdate({
        transformOffsetX: Math.round(nx * 10) / 10,
        transformOffsetY: Math.round(ny * 10) / 10,
      });
    }
    function onUp() {
      // Keep the live override alive until server-side scene update lands.
      panRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onUpdate, onLiveScale, scene.id, scene.transformScale]);
  const fmtRatio = (r: number) => {
    if (!r || !isFinite(r)) return "—";
    if (Math.abs(r - 16 / 9) < 0.02) return "16:9";
    if (Math.abs(r - 9 / 16) < 0.02) return "9:16";
    if (Math.abs(r - 4 / 3) < 0.02) return "4:3";
    if (Math.abs(r - 1) < 0.02) return "1:1";
    return r > 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
  };
  const handleSize = 10;
  const offsetX = Number(scene.transformOffsetX ?? 0);
  const offsetY = Number(scene.transformOffsetY ?? 0);
  return (
    <>
      {/* Content-only layer. The dark project-screen mask + border is drawn by
          ProjectScreenIndicator; this layer hosts only the blue transform box
          + resize handles. */}
      <div ref={frameHostRef} className="absolute inset-0 pointer-events-none z-30">
        {frameSize && (
          <>
            {/* Content transform box — tracks the actual displayed media
                (project-frame × scale + user offset). Captures its OWN clicks
                (pointer-events: auto) so clicking inside it does NOT fall
                through to the deselect catcher behind. Clicking inside the
                box starts a pan drag; handles on the border start resize. */}
            <div
              className="absolute"
              style={{
                width: frameSize.w * scale,
                height: frameSize.h * scale,
                left: `calc(50% + ${containerSize ? (offsetX / 100) * containerSize.w : 0}px)`,
                top: `calc(50% + ${containerSize ? (offsetY / 100) * containerSize.h : 0}px)`,
                transform: "translate(-50%, -50%)",
                outline: "1.5px solid rgba(255, 255, 255, 0.95)",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.6) inset",
                borderRadius: 2,
                pointerEvents: "auto",
                cursor: "move",
              }}
              onMouseDown={(e) => {
                // Clicking INSIDE the content box starts a pan drag, not a
                // deselect. The handles on the border handle resize separately
                // (they stopPropagation before this fires).
                beginPanBox(e);
              }}
            >
              {/* Scale label */}
              <div className="absolute -top-5 right-0 px-1.5 py-0.5 rounded-sm bg-white/95 text-black text-[9px] font-semibold tabular-nums shadow">
                {Math.round(scale * 100)}%
              </div>
              {/* Corner + edge resize handles */}
              {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((c) => {
                const positions: Record<typeof c, React.CSSProperties> = {
                  nw: { top: -handleSize / 2, left: -handleSize / 2, cursor: "nwse-resize" },
                  n: { top: -handleSize / 2, left: `calc(50% - ${handleSize / 2}px)`, cursor: "ns-resize" },
                  ne: { top: -handleSize / 2, right: -handleSize / 2, cursor: "nesw-resize" },
                  e: { top: `calc(50% - ${handleSize / 2}px)`, right: -handleSize / 2, cursor: "ew-resize" },
                  se: { bottom: -handleSize / 2, right: -handleSize / 2, cursor: "nwse-resize" },
                  s: { bottom: -handleSize / 2, left: `calc(50% - ${handleSize / 2}px)`, cursor: "ns-resize" },
                  sw: { bottom: -handleSize / 2, left: -handleSize / 2, cursor: "nesw-resize" },
                  w: { top: `calc(50% - ${handleSize / 2}px)`, left: -handleSize / 2, cursor: "ew-resize" },
                };
                return (
                  <div
                    key={c}
                    onMouseDown={beginResize(c)}
                    className="absolute pointer-events-auto rounded-full bg-white border border-black/40 shadow hover:scale-125 transition-transform"
                    style={{
                      width: handleSize,
                      height: handleSize,
                      zIndex: 35,
                      ...positions[c],
                    }}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Aspect-mismatch warning + one-click Fill: scales the media so it
          covers the export frame (centered), instead of forcing hand-drags. */}
      {mismatch && (
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-2 py-1 rounded-md bg-amber-500/95 text-black text-[10px] font-semibold shadow-lg flex items-center gap-1.5"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1L11 10H1L6 1z" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M6 5v2.5M6 8.5v.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
          {tr("aspectMismatch", { source: fmtRatio(sourceRatio || 0), screen: fmtRatio(projectRatio) })}
          <button
            type="button"
            onClick={() => {
              if (!contentRect || !containerSize) return;
              const fillScale = Math.max(containerSize.w / contentRect.w, containerSize.h / contentRect.h);
              onUpdate({
                transformScale: Math.round(fillScale * 100) / 100,
                transformOffsetX: 0,
                transformOffsetY: 0,
              });
            }}
            className="pointer-events-auto rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-black"
          >
            {tr("fillScreen")}
          </button>
        </div>
      )}
    </>
  );
}

// ── Always-visible project screen indicator ────────────────
// Draws a clear "screen" rectangle at projectRatio inside the container with
// the outside area dimmed so the user always sees what will be exported.
function ProjectScreenIndicator({
  projectRatio,
  selected,
  hidden,
  onClickScreen,
}: {
  projectRatio: number;
  selected: boolean;
  hidden: boolean;
  onClickScreen: () => void;
}) {
  const tr = useTimelineMessages("scenePreview");
  const hostRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const compute = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const { w, h } = getPreviewScreenFrame({ w: rect.width, h: rect.height }, projectRatio);
      setFrameSize((prev) => {
        if (prev && Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5) return prev;
        return { w, h };
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(host);
    return () => ro.disconnect();
  }, [projectRatio]);

  return (
    <div ref={hostRef} className="absolute inset-0 z-[15] pointer-events-none">
      {frameSize && (
        <div
          className="absolute"
          style={{
            width: frameSize.w,
            height: frameSize.h,
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            // When chrome is already selected, let clicks fall through so the
            // transform handles below (at this same screen rect) stay hittable.
            // When not selected, capture clicks to offer "click to edit".
            pointerEvents: hidden || selected ? "none" : "auto",
            cursor: selected ? "default" : "pointer",
            // Opaque black vignette outside the screen — hides media that
            // would otherwise bleed into the padding area. This is also why
            // the screen looks smaller than the preview host.
            boxShadow: "0 0 0 9999px rgba(10, 10, 18, 1)",
            outline: hidden
              ? "none"
              : selected
              ? "1.5px solid rgba(147, 197, 253, 0.85)"
              : "1.5px solid rgba(147, 197, 253, 0.6)",
            borderRadius: 2,
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (!selected) onClickScreen();
          }}
          title={selected ? "" : tr("clickToEdit")}
        >
        </div>
      )}
    </div>
  );
}

// Subscribe-based shot sequencer. Used when a scene's stitched video is
// missing but each shot has its own video_url. Does NOT subscribe via
// useEditorStore selector (that caused a render loop). Instead uses
// storeApi.subscribe to update DOM imperatively, plus a rare setState
// when the active shot INDEX flips (so React hides/shows the right video).
function ShotSequencerV2({
  scene,
  sceneStart,
  playing,
  baseAudioTrackAudible,
  baseAudioTrackVolume = 1,
  timelineClips,
  onActiveShotChange,
  onSourceLoaded,
  panLive,
  scaleLive,
  screenFrame,
}: {
  scene: SceneData;
  sceneStart: number;
  playing: boolean;
  baseAudioTrackAudible: boolean;
  baseAudioTrackVolume?: number;
  timelineClips?: TimelineClip[];
  onActiveShotChange?: (sceneId: string, vid: HTMLVideoElement | null) => void;
  onSourceLoaded?: (s: SceneData, w: number, h: number, durationSeconds?: number) => void;
  panLive?: { sceneId: string; offsetX: number; offsetY: number } | null;
  scaleLive?: { sceneId: string; scale: number; offsetX: number; offsetY: number } | null;
  screenFrame?: { w: number; h: number } | null;
}) {
  const storeApi = useEditorStoreApi();
  const media = useTimelineMedia();
  // NOTE: do NOT subscribe to currentTime via a selector here. It updates
  // ~60Hz during playback and would re-render this whole shot subtree every
  // frame. The active shot's `muted` is set imperatively in the subscribe
  // effect below; the JSX attribute only needs a reasonable initial value.
  const shots = useMemo<Array<CopyVideoShotImage & { video_url?: string; duration?: string | number }>>(() => {
    return parseShotBreakdown<CopyVideoShotImage & { video_url?: string; duration?: string | number }>(scene.shotBreakdown);
  }, [scene.shotBreakdown]);
  const shotDurs = useMemo(() => shots.map((s) => shotVisualDuration(s)), [shots]);
  const totalShotDur = useMemo(() => shotDurs.reduce((a, b) => a + b, 0), [shotDurs]);
  const sceneDur = useMemo(() => getSceneDuration(scene), [scene]);
  const timeScale = totalShotDur > 0 && sceneDur > 0 ? totalShotDur / sceneDur : 1;
  const sceneEnd = sceneStart + sceneDur;
  // Start at -1 so shots stay hidden until the playhead enters the scene.
  const [activeIdx, setActiveIdx] = useState(-1);
  const videoRefs = useRef<Map<number, HTMLVideoElement>>(new Map());
  const lastActiveRef = useRef(-1);

  // Subscribe-based sync — imperatively seek/play/pause the active shot
  // video. Only calls setState when the shot INDEX changes.
  useEffect(() => {
    const apply = (time: number) => {
      const inScene = time >= sceneStart && time < sceneEnd;
      if (!inScene) {
        videoRefs.current.forEach((v) => { if (!v.paused) v.pause(); });
        if (onActiveShotChange) onActiveShotChange(scene.id, null);
        // CRITICAL: reset activeIdx to -1 so the render hides all shot
        // videos. Without this, the last visible shot stays at opacity:1
        // after the playhead leaves the scene, masking lower tracks (V1)
        // when you try to skip back.
        if (lastActiveRef.current !== -1) {
          lastActiveRef.current = -1;
          setActiveIdx(-1);
        }
        return;
      }
      const visualOffset = Math.max(0, time - sceneStart);
      // Speed (phase 10b): timeScale already includes the scene's mean speed (sceneDur is the source span
      // over it); a curve additionally warps the scene-local time through its exact time map.
      const shotOffset = Math.min(totalShotDur - 0.0001, getSceneWarpedLocal(scene, visualOffset) * timeScale);
      let acc = 0;
      let idx = shots.length - 1;
      let offsetInShot = 0;
      for (let i = 0; i < shots.length; i++) {
        if (shotOffset < acc + shotDurs[i]) {
          idx = i;
          offsetInShot = Math.max(0, shotOffset - acc);
          break;
        }
        acc += shotDurs[i];
      }
      if (idx !== lastActiveRef.current) {
        lastActiveRef.current = idx;
        setActiveIdx(idx);
      }
      // Sync active shot's video
      const activeVid = videoRefs.current.get(idx);
      // Register the active video so the preview canvas (when needsCanvas=true
      // due to text/sticker overlays) can draw it. Without this, V2 shot
      // videos are invisible when the parent ScenePreview DOM is hidden.
      if (onActiveShotChange) onActiveShotChange(scene.id, activeVid || null);
      if (activeVid) {
        const wantMutedV2 = !shouldPlaySceneVideoAudio(scene, baseAudioTrackAudible, timelineClips, time);
        if (activeVid.muted !== wantMutedV2) activeVid.muted = wantMutedV2;
        if (Math.abs(activeVid.volume - baseAudioTrackVolume) > 0.001) activeVid.volume = baseAudioTrackVolume;
        // Shots play at timeScale (the scene's source span over its timeline length, which includes its
        // speed) × the curve's relative rate: no more hard snap every second on a 2× or re-timed scene.
        // Same drift discipline as the ScenePreview loop (speed-sync.ts).
        const target = clampRate(timeScale * getSceneRelativeRate(scene, visualOffset));
        const preservePitch = getSceneSpeedProfile(scene).preservePitch;
        if (playing && activeVid.paused && !target.seek) {
          applyPitch(activeVid, preservePitch);
          activeVid.play().catch(() => {});
        } else if (!playing && !activeVid.paused) activeVid.pause();
        syncMediaElement(activeVid, { desired: offsetInShot, playing, target, preservePitch });
      }
      // Pause any non-active shot videos
      videoRefs.current.forEach((v, i) => { if (i !== idx && !v.paused) v.pause(); });
    };
    apply(storeApi.getState().currentTime);
    const unsub = storeApi.subscribe((s) => s.currentTime, apply);
    return unsub;
  }, [playing, shots, shotDurs, totalShotDur, timeScale, sceneStart, sceneEnd, baseAudioTrackAudible, baseAudioTrackVolume, timelineClips, scene, onActiveShotChange]);

  return (
    <>
      {shots.map((shot, i) => {
        const url = shot.video_url || null;
        const visible = i === activeIdx;
        // Keep the next shot mounted and preloaded so crossing a shot boundary
        // does not freeze on its poster until the user pauses and resumes.
        const shouldLoad = visible || i === Math.max(0, activeIdx + 1);
        const rawShotVideoSrc = shouldLoad ? url : null;
        const shotVideoSrc = rawShotVideoSrc ? media.resolveMediaUrl(rawShotVideoSrc) : null;
        const rawShotPosterSrc = getShotPreviewImageUrl(shots, shot, i);
        const shotPosterSrc = rawShotPosterSrc ? media.resolveMediaUrl(rawShotPosterSrc) : undefined;
        const trackIdx = scene.trackIndex || 1;
        const z = trackIdx >= 2 ? 10 + trackIdx : 3;
        return (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              zIndex: z,
              opacity: visible ? 1 : 0,
              transition: "opacity 120ms ease-in-out",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            {shotVideoSrc && (
              <video
                className="absolute inset-0 w-full h-full"
                {...sceneMediaProps(mergeLiveTransforms(scene, panLive ?? null, scaleLive ?? null), screenFrame)}
                src={shotVideoSrc}
                poster={shotPosterSrc}
                playsInline
                muted={!shouldPlaySceneVideoAudio(scene, baseAudioTrackAudible, timelineClips, storeApi.getState().currentTime)}
                preload={shouldLoad ? "auto" : "none"}
                onLoadedMetadata={(e) => onSourceLoaded?.(scene, e.currentTarget.videoWidth, e.currentTarget.videoHeight, e.currentTarget.duration)}
                ref={(el) => {
                  if (el) {
                    videoRefs.current.set(i, el);
                    if (el.videoWidth > 0 && el.videoHeight > 0) {
                      onSourceLoaded?.(scene, el.videoWidth, el.videoHeight);
                    }
                  } else {
                    videoRefs.current.delete(i);
                  }
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

// ────────────────────────────────────────────────────────────
// V2+ overlay layer — renders scenes on higher video tracks on top of the
// base V1 preview. Subscribes to currentTime via a selector that returns
// a stable set of active overlay IDs, so the component only re-renders
// when the playhead crosses an overlay boundary.
//
// Also reused as the UNDER-scene layer: a second instance with zIndexBase={0}
// and an activeGate renders V1-lane scenes BENEATH an active higher-lane scene
// (e.g. a V1 background image behind a V2 alpha-webm cutout). The gate keeps
// it inert while the V1 pool owns solo-V1 playback, so nothing double-renders
// or double-plays audio.
function SceneOverlayLayer({
  scenes,
  resolveStart,
  playing,
  baseAudioTrackAudible,
  baseAudioTrackVolume = 1,
  videoTrackVolumes,
  timelineClips,
  onSourceLoaded,
  onVideoRef,
  panLive,
  scaleLive,
  screenFrame,
  zIndexBase = 10,
  activeGate,
}: {
  scenes: SceneData[];
  resolveStart: (s: SceneData) => number;
  playing: boolean;
  baseAudioTrackAudible: boolean;
  baseAudioTrackVolume?: number;
  videoTrackVolumes?: Record<number, number>;
  timelineClips?: TimelineClip[];
  onSourceLoaded?: (s: SceneData, w: number, h: number, durationSeconds?: number) => void;
  onVideoRef?: (sceneId: string, vid: HTMLVideoElement | null) => void;
  panLive?: { sceneId: string; offsetX: number; offsetY: number } | null;
  scaleLive?: { sceneId: string; scale: number; offsetX: number; offsetY: number } | null;
  screenFrame?: { w: number; h: number } | null;
  zIndexBase?: number;
  activeGate?: (time: number) => boolean;
}) {
  const storeApi = useEditorStoreApi();
  const media = useTimelineMedia();
  // NOTE: do NOT subscribe to the raw currentTime here — it defeats the
  // boundary-only `activeIds` optimization below and re-renders the overlay
  // layer ~60Hz during playback. Overlay `muted` is set imperatively in the
  // sync effect; the JSX attribute only needs a reasonable initial value.
  const overlayRanges = useMemo(() => buildScenePlayheadRanges(scenes, resolveStart).sceneRanges, [resolveStart, scenes]);
  const activeIds = useEditorStore((state) => {
    const t = state.currentTime;
    if (activeGate && !activeGate(t)) return ""; // layer inert (e.g. no higher-lane scene active)
    const out: string[] = [];
    for (const range of overlayRanges) {
      if (isTimeInSceneRange(t, range.start, range.end)) out.push(`${range.sceneId}@${range.trackIndex}`);
    }
    return out.sort().join(","); // stable string comparison
  });
  const activeSet = useMemo(
    () => new Set(activeIds.split(",").map((x) => x.split("@")[0]).filter(Boolean)),
    [activeIds],
  );
  const warmIds = useEditorStore((state) => {
    const t = state.currentTime;
    return overlayRanges
      .filter((range) => range.end > t)
      .sort((a, b) => a.start - b.start || a.trackIndex - b.trackIndex)
      .slice(0, 3)
      .map((range) => range.sceneId)
      .join(",");
  });
  const warmSet = useMemo(() => new Set(warmIds.split(",").filter(Boolean)), [warmIds]);
  const videoRefsMap = useRef<Map<string, HTMLVideoElement>>(new Map());
  // Masks (phase 10c): a CSS mask image per masked scene element (scene-mask-css.ts); keyframed masks re-render
  // at most every MASK_PLAYING_INTERVAL_MS while playing, exactly when paused.
  const imageRefsMap = useRef<Map<string, HTMLImageElement>>(new Map());
  const maskRenderedAt = useRef<WeakMap<HTMLElement, number>>(new WeakMap());

  // Sync each overlay's play/pause + currentTime to the playhead. Driven by a
  // store SUBSCRIPTION (not a render dep) so a paused scrub inside one scene
  // still re-seeks the video: keying this on `activeSet` alone only re-ran on
  // scene-boundary crossings, so scrubbing within a scene moved the playhead
  // while the preview kept showing the frame it was parked on. Imperative
  // writes only — the overlay layer still never re-renders per tick.
  useEffect(() => {
    const updateSceneMask = (scene: SceneData, el: HTMLElement, local: number) => {
      const natural = el instanceof HTMLVideoElement ? { w: el.videoWidth, h: el.videoHeight } : { w: (el as HTMLImageElement).naturalWidth, h: (el as HTMLImageElement).naturalHeight };
      const size = natural.w > 0 && natural.h > 0 ? natural : { w: Number(scene.sourceWidth) || 0, h: Number(scene.sourceHeight) || 0 };
      const layer = screenFrame ? sceneMaskLayer(scene, size, screenFrame, local) : null;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const last = maskRenderedAt.current.get(el) ?? -Infinity;
      if (layer && playing && now - last < MASK_PLAYING_INTERVAL_MS && el.style.getPropertyValue("mask-image")) return;
      maskRenderedAt.current.set(el, now);
      applySceneMask(el, layer);
    };
    const apply = (storeTime: number) => {
    // Gated instance (under-scene layer): while the gate is closed the V1 pool
    // owns playback of these scenes' media — pause ours and bail so audio never
    // doubles and a hidden layer never seeks/plays.
    const gateOpen = !activeGate || activeGate(storeTime);
    for (const range of overlayRanges) {
      const vid = videoRefsMap.current.get(range.sceneId);
      if (!vid) {
        const img = imageRefsMap.current.get(range.sceneId);
        const imageScene = img ? scenes.find((s) => s.id === range.sceneId) : undefined;
        if (img && imageScene && screenFrame && gateOpen && isTimeInSceneRange(storeTime, range.start, range.end)) {
          updateSceneMask(imageScene, img, Math.max(0, storeTime - range.start));
        }
        continue;
      }
      const scene = scenes.find((s) => s.id === range.sceneId);
      if (scene) {
        const wantMutedS = !shouldPlaySceneVideoAudio(scene, baseAudioTrackAudible, timelineClips, storeTime);
        if (vid.muted !== wantMutedS) vid.muted = wantMutedS;
        const wantVolS = baseAudioTrackVolume * (videoTrackVolumes?.[scene.trackIndex || 1] ?? 1);
        if (Math.abs(vid.volume - wantVolS) > 0.001) vid.volume = wantVolS;
      }
      const inRange = gateOpen && isTimeInSceneRange(storeTime, range.start, range.end);
      if (inRange && scene && screenFrame) updateSceneMask(scene, vid, Math.max(0, storeTime - range.start));
      if (inRange) {
        // Speed + trim (phase 10b): the same media-time mapping and drift rules as the V1 loop
        // (getSceneVideoOffset, speed-sync.ts) instead of `t − start` at 1×.
        const local = Math.max(0, storeTime - range.start);
        const targetOffset = scene ? getSceneVideoOffset(scene, local) : local;
        const target = scene ? getSceneRateTarget(scene, local) : clampRate(1);
        const preservePitch = scene ? getSceneSpeedProfile(scene).preservePitch : true;
        if (playing) {
          if (vid.paused && !target.seek) vid.play().catch(() => {});
          syncMediaElement(vid, { desired: targetOffset, playing: true, target, preservePitch });
        } else {
          // Paused: no varispeed nudging — snap to the exact frame the playhead
          // sits on (same tolerance as the timeline clip layer's paused path).
          if (!vid.paused) vid.pause();
          if (vid.readyState >= 1) syncMediaElement(vid, { desired: targetOffset, playing: false, target, preservePitch });
        }
      } else if (!vid.paused) {
        vid.pause();
      }
    }
    };
    apply(storeApi.getState().currentTime);
    const unsub = storeApi.subscribe((s) => s.currentTime, apply);
    return unsub;
  }, [activeSet, overlayRanges, playing, scenes, baseAudioTrackAudible, baseAudioTrackVolume, videoTrackVolumes, timelineClips, activeGate, screenFrame]);

  return (
    <>
      {scenes.map((s) => {
        const visible = activeSet.has(s.id);
        const shouldLoad = visible || warmSet.has(s.id);
        const trackIdx = s.trackIndex || 1;
        const src = getVideoUrl(s);
        const rawOverlayVideoSrc = shouldLoad ? src : null;
        const overlayVideoSrc = rawOverlayVideoSrc ? media.resolveMediaUrl(rawOverlayVideoSrc) : null;
        const rawOverlayImageSrc = visible ? (s.startImageUrl || null) : null;
        const overlayImageSrc = rawOverlayImageSrc ? media.resolveMediaUrl(rawOverlayImageSrc) : null;
        const rawOverlayPosterSrc = getScenePosterUrl(s);
        const overlayPosterSrc = rawOverlayPosterSrc ? media.resolveMediaUrl(rawOverlayPosterSrc) : undefined;
        return (
          <div
            key={s.id}
            className="absolute inset-0"
            style={{
              zIndex: zIndexBase + trackIdx, // higher track → on top; zIndexBase 0 = under-scene layer
              opacity: visible ? 1 : 0,
              transition: "opacity 120ms ease-in-out",
              pointerEvents: visible ? "auto" : "none",
            }}
          >
            {overlayVideoSrc && (
              <video
                className="absolute inset-0 w-full h-full"
                {...sceneMediaProps(mergeLiveTransforms(s, panLive ?? null, scaleLive ?? null), screenFrame)}
                src={overlayVideoSrc}
                poster={overlayPosterSrc}
                playsInline
                muted={!shouldPlaySceneVideoAudio(s, baseAudioTrackAudible, timelineClips, storeApi.getState().currentTime)}
                preload={shouldLoad ? "auto" : "none"}
                onLoadedMetadata={(e) => onSourceLoaded?.(s, e.currentTarget.videoWidth, e.currentTarget.videoHeight, e.currentTarget.duration)}
                ref={(el) => {
                  if (el) {
                    videoRefsMap.current.set(s.id, el);
                    onVideoRef?.(s.id, el);
                    if (el.videoWidth > 0 && el.videoHeight > 0) {
                      onSourceLoaded?.(s, el.videoWidth, el.videoHeight);
                    }
                  } else {
                    videoRefsMap.current.delete(s.id);
                    onVideoRef?.(s.id, null);
                  }
                }}
              />
            )}
            {!src && overlayImageSrc && (
              <img
                src={overlayImageSrc}
                alt=""
                className="absolute inset-0 w-full h-full"
                {...sceneMediaProps(mergeLiveTransforms(s, panLive ?? null, scaleLive ?? null), screenFrame)}
                loading={visible ? "eager" : "lazy"}
                decoding="async"
                onLoad={(e) => onSourceLoaded?.(s, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                ref={(el) => {
                  if (el) imageRefsMap.current.set(s.id, el);
                  else imageRefsMap.current.delete(s.id);
                  if (el && el.naturalWidth > 0) {
                    onSourceLoaded?.(s, el.naturalWidth, el.naturalHeight);
                  }
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

// ────────────────────────────────────────────────────────────
// Below-track media layer — timeline video/image clips on video lanes LOWER
// than the active scene's lane render BEHIND the scene video (zIndex 0), so a
// background-removed scene video (alpha VP9 webm) reveals them through its
// transparent pixels. Mirrors the preview-panel compositor's V2+ overlay-clip
// machinery: same activation window, transform math (posX/posY anchored across
// remaining frame space, natural size × clip scale × frameScale), keyframe
// channels, playback-sync drift thresholds and track-mute/volume audio rules —
// just stacked under the scene instead of over it.
function TimelineUnderClipLayer({
  clips,
  timelineTracks,
  playing,
  resolveSceneLane,
  screenFrame,
  projectRatio,
}: {
  clips: TimelineClip[];
  timelineTracks?: TimelineTrack[];
  playing: boolean;
  resolveSceneLane: (time: number) => number;
  screenFrame?: { w: number; h: number } | null;
  projectRatio: number;
}) {
  const storeApi = useEditorStoreApi();
  const media = useTimelineMedia();
  // Boundary-only subscription — re-renders only when the set of clips below
  // the active scene lane changes, never per playhead frame.
  const activeKey = useEditorStore((state) => {
    const t = state.currentTime;
    const lane = resolveSceneLane(t);
    const out: string[] = [];
    for (const c of clips) {
      if (t >= c.startTime && t < c.endTime && (c.trackIndex ?? 2) < lane) out.push(c.id);
    }
    return out.sort().join(",");
  });
  const activeSet = useMemo(() => new Set(activeKey.split(",").filter(Boolean)), [activeKey]);
  const wrapperRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const naturalDims = useRef<Map<string, { w: number; h: number }>>(new Map());
  const applyRef = useRef<((time: number) => void) | null>(null);

  const frameW = screenFrame?.w ?? 0;
  const frameH = screenFrame?.h ?? 0;
  // Same export-reference scaling the preview-panel compositor uses, so a
  // below-clip is sized identically to its overlay-path (and export) render.
  const exportRefW = projectRatio > 1 ? 1920 : 1080;
  const exportRefH = exportRefW / projectRatio;
  const frameScale = frameH > 0 && exportRefH > 0 ? frameH / exportRefH : 1;

  // Imperative per-tick sync — position/scale/opacity/rotation styles plus
  // video seek/play/pause/audio, mirroring the overlay compositor's rules.
  useEffect(() => {
    const apply = (time: number) => {
      for (const clip of clips) {
        const wrapper = wrapperRefs.current.get(clip.id);
        if (!wrapper) continue;
        const vid = videoRefs.current.get(clip.id);
        const isActive = activeSet.has(clip.id);
        if (!isActive) {
          wrapper.style.visibility = "hidden";
          if (vid && !vid.paused) vid.pause();
          continue;
        }
        wrapper.style.visibility = "visible";
        const kf = getClipKeyframeValuesAtTime(clip.keyframesJson, time - clip.startTime);
        const posX = kf?.positionX ?? clip.positionX;
        const posY = kf?.positionY ?? clip.positionY;
        const clipScale = kf?.scale ?? clip.scale;
        const clipOpacity = kf?.opacity ?? clip.opacity;
        const rotationDegrees = Number(kf?.rotationDegrees ?? clip.rotationDegrees) || 0;
        const dims = naturalDims.current.get(clip.id);
        if (dims) {
          const drawW = dims.w * clipScale * frameScale;
          const drawH = dims.h * clipScale * frameScale;
          // Export anchors media across the REMAINING space: x=(w-drawW)*posX.
          wrapper.style.left = `${posX * Math.max(0, frameW - drawW)}px`;
          wrapper.style.top = `${posY * Math.max(0, frameH - drawH)}px`;
          wrapper.style.width = `${drawW}px`;
          wrapper.style.height = `${drawH}px`;
        }
        wrapper.style.opacity = String(clipOpacity);
        wrapper.style.transform = rotationDegrees ? `rotate(${rotationDegrees}deg)` : "";
        if (vid) {
          // Speed (phase 10b): constant speed, curves and legacy ramps through the clip's time map from
          // its trimStart (like the export's overlay input), at the instantaneous rate.
          const profile = cachedClipSpeedProfile(clip);
          const clipLength = Math.max(0, clip.endTime - clip.startTime);
          const desired = mediaTimeAt(profile, time - clip.startTime, clipLength, clipMediaStart(clip));
          const target = targetRate(profile, time - clip.startTime, clipLength);
          // Embedded audio follows clip volume × the video track's fader,
          // silenced by the track mute — identical to the overlay clip path.
          const track = timelineTracks?.find(
            (tr) => tr.type === "video" && tr.index === (clip.trackIndex ?? 2),
          );
          const trackVol = Number(track?.volume ?? 1);
          const clipVol = Number(clip.volume ?? 1);
          const effVol = Math.max(0, Math.min(1,
            (Number.isFinite(clipVol) ? clipVol : 1) * (Number.isFinite(trackVol) ? trackVol : 1),
          ));
          vid.muted = Boolean(track?.muted) || effVol <= 0.001;
          vid.volume = effVol;
          if (playing) {
            if (vid.paused && !target.seek) vid.play().catch(() => {});
            // Only hard-correct on real drift — constant reseeks stutter decode (nudges cover the rest).
            if (vid.readyState >= 1) syncMediaElement(vid, { desired, playing: true, target, preservePitch: profile.preservePitch, hardSeekDrift: OVERLAY_HARD_SEEK_DRIFT });
          } else {
            if (!vid.paused) vid.pause();
            if (vid.readyState >= 1) syncMediaElement(vid, { desired, playing: false, target, preservePitch: profile.preservePitch });
          }
        }
      }
    };
    applyRef.current = apply;
    apply(storeApi.getState().currentTime);
    const unsub = storeApi.subscribe((s) => s.currentTime, apply);
    return () => {
      unsub();
      if (applyRef.current === apply) applyRef.current = null;
    };
  }, [activeSet, clips, timelineTracks, playing, frameW, frameH, frameScale]);

  return (
    <>
      {clips.map((clip) => {
        const isActive = activeSet.has(clip.id);
        const mediaSrc = clip.mediaUrl ? media.resolveMediaUrl(clip.mediaUrl) : null;
        // Image clips share the video lane family — same test the compositor uses.
        const isImageClip = clip.mediaType === "image" || /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(clip.mediaUrl || "");
        return (
          <div
            key={clip.id}
            data-testid="under-clip"
            className="absolute"
            style={{ zIndex: 0, visibility: isActive ? "visible" : "hidden", pointerEvents: "none" }}
            ref={(el) => {
              if (el) wrapperRefs.current.set(clip.id, el);
              else wrapperRefs.current.delete(clip.id);
            }}
          >
            {mediaSrc && isImageClip && (
              <img
                src={mediaSrc}
                alt=""
                className="w-full h-full"
                draggable={false}
                decoding="async"
                onLoad={(e) => {
                  naturalDims.current.set(clip.id, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                  applyRef.current?.(storeApi.getState().currentTime);
                }}
              />
            )}
            {mediaSrc && !isImageClip && (
              <video
                src={mediaSrc}
                className="w-full h-full"
                playsInline
                muted
                preload={isActive ? "auto" : "metadata"}
                onLoadedMetadata={(e) => {
                  naturalDims.current.set(clip.id, { w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
                  applyRef.current?.(storeApi.getState().currentTime);
                }}
                ref={(el) => {
                  if (el) videoRefs.current.set(clip.id, el);
                  else videoRefs.current.delete(clip.id);
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
