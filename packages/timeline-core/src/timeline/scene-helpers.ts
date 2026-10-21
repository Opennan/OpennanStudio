// Pure scene and track helpers. Copied from opennan frontend components/editor/timeline/
// nle-timeline-utils.ts:252-322 and :328-398. Uses the canvas SceneData (a superset of
// the duplicate type at nle-timeline-utils.ts:14-47).
import type { TimelineClip, TimelineTrack } from "../model/timeline";
import type { SceneData } from "./canvas/types";
import { parseShotBreakdown, totalShotDuration } from "../lib/shot-utils";
import { getSceneDuration, getSceneStart, parseSceneCardConfig } from "./scene-timing";

export function getSceneTimelineTrimStart(scene: Pick<SceneData, "cardConfig">): number {
  const config = parseSceneCardConfig(scene);
  const value = Number(config.timelineTrimStart ?? config.trimStart ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function getSceneAudioUrl(scene: Pick<SceneData, "audioUrl" | "cardConfig">): string | null {
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

export function buildSceneTimelineTrimCardConfig(scene: Pick<SceneData, "cardConfig">, trimStart: number, trimEnd: number): string {
  return JSON.stringify({
    ...parseSceneCardConfig(scene),
    timelineTrimStart: Math.max(0, trimStart),
    timelineTrimEnd: Math.max(0, trimEnd),
  });
}

/** True when the scene strip plays fixed media (copied/uploaded source video)
 *  rather than generative shots that can legitimately be retimed. Edge-resize
 *  on these scenes must TRIM (cardConfig timelineTrim*), never rescale shots
 *  or grow past the media. Mirrors the canvas renderer's definition. */
export function isContentBackedScene(scene: Pick<SceneData, "cardType" | "sourceVideoUrl">): boolean {
  return scene.cardType === "copy_video" || scene.cardType === "source_clip" || Boolean(scene.sourceVideoUrl);
}

/** Total CONTENT length behind a scene, ignoring any timeline trim.
 *  Returns Infinity when unknown (never clamp on a guess). */
export function getSceneContentDuration(scene: SceneData): number {
  const config = parseSceneCardConfig(scene);
  const stored = Number(config.timelineSourceDuration);
  let shotSum = 0;
  if (scene.shotBreakdown && scene.shotBreakdown !== "[]") {
    const shots = parseShotBreakdown(scene.shotBreakdown);
    if (shots.length > 0) shotSum = totalShotDuration(shots);
  }
  const known = Math.max(Number.isFinite(stored) && stored > 0 ? stored : 0, shotSum);
  if (known > 0) return known;
  const trimStart = Number(config.timelineTrimStart ?? config.trimStart);
  const trimEnd = Number(config.timelineTrimEnd ?? config.trimEnd);
  const hasTrim = Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart;
  if (!hasTrim && scene.videoUrl && scene.duration && scene.duration > 0) return scene.duration;
  return Number.POSITIVE_INFINITY;
}

export function stripVoiceoverLayersFromCardConfig(cardConfig: string | null | undefined): string | undefined {
  if (!cardConfig) return undefined;
  try {
    const config = JSON.parse(cardConfig) as Record<string, unknown>;
    const layers = Array.isArray(config.audio_layers) ? config.audio_layers : [];
    const filtered = layers.filter((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
      const layer = raw as { type?: unknown };
      return layer.type !== "voiceover" && layer.type !== "extracted";
    });
    if (filtered.length === layers.length) return undefined;
    return JSON.stringify({ ...config, audio_layers: filtered });
  } catch {
    return undefined;
  }
}

export const defaultTracks: TimelineTrack[] = [
  { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
  { type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 },
];

export function getEditableSceneTransitionTarget(
  scenes: SceneData[],
  tracks: TimelineTrack[],
  sceneId: string,
): { scene: SceneData; index: number } | null {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  const scene = sceneIndex >= 0 ? scenes[sceneIndex] : null;
  if (!scene) return null;
  const trackIndex = Number(scene.trackIndex || 1);
  const track = tracks.find((item) => item.type === "video" && item.index === trackIndex);
  if (!track || track.locked || track.visible === false) return null;
  const sceneEnd = getSceneStart(scene, scenes, sceneIndex) + getSceneDuration(scene);
  const hasAdjacentNextScene = scenes.some((nextScene, nextIndex) => (
    nextScene.id !== scene.id &&
    Number(nextScene.trackIndex || 1) === trackIndex &&
    Math.abs(getSceneStart(nextScene, scenes, nextIndex) - sceneEnd) <= 0.001
  ));
  return hasAdjacentNextScene ? { scene, index: sceneIndex } : null;
}

export function withRequiredBaseTimelineTracks(tracks: TimelineTrack[]): { tracks: TimelineTrack[]; repaired: boolean } {
  let repaired = false;
  const next = [...tracks];
  for (const baseTrack of defaultTracks) {
    if (!next.some((track) => track.type === baseTrack.type && track.index === baseTrack.index)) {
      next.push(baseTrack);
      repaired = true;
    }
  }
  return { tracks: next, repaired };
}

export function withSceneVideoTracks(
  tracks: TimelineTrack[],
  scenes: SceneData[],
  clips?: TimelineClip[],
): TimelineTrack[] {
  let maxVideoIndex = 1;
  for (const scene of scenes) {
    maxVideoIndex = Math.max(maxVideoIndex, Number(scene.trackIndex || 1));
  }
  for (const clip of clips ?? []) {
    if (clip.trackType === "video") {
      maxVideoIndex = Math.max(maxVideoIndex, Number(clip.trackIndex || 1));
    }
  }
  if (maxVideoIndex <= 1) return tracks;
  const existingVideoIndices = new Set(
    tracks.filter((track) => track.type === "video").map((track) => track.index),
  );
  const next = [...tracks];
  for (let index = 1; index <= maxVideoIndex; index++) {
    if (!existingVideoIndices.has(index)) {
      next.push({
        type: "video",
        index,
        label: `V${index}`,
        muted: false,
        locked: false,
        visible: true,
        volume: 1,
      });
    }
  }
  return next;
}
