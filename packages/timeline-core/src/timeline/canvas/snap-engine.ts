// Collects and resolves timeline snap targets for canvas editing.
import type { SnapGuide, SnapPoint, CanvasState, SceneData } from "./types";
import { getSceneDuration } from "./timeline-renderer";
import { getSceneTimelineStart } from "./scene-position";
import { getCachedClipKeyframeTimes } from "./timeline-json-cache";
import { beatTimesOnTimeline } from "../../analysis/beat-plan";

/**
 * Beat snap targets while Snap to beats is on (phase 11): the host's precomputed beats, or the audio clips' beats
 * (from the clips not being dragged, so a dragged music clip does not snap to its own old beats).
 */
export function snapBeatTimes(state: Pick<CanvasState, "snapToBeats" | "beatTimes" | "clips">, excludeClipIds: ReadonlySet<string> = new Set()): number[] {
  if (!state.snapToBeats) return [];
  const draggingBeats = state.clips.some((clip) => excludeClipIds.has(clip.id) && clip.beatsJson);
  if (state.beatTimes && !draggingBeats) return state.beatTimes;
  return beatTimesOnTimeline(state.clips.filter((clip) => !excludeClipIds.has(clip.id)));
}

function getSceneStart(scene: SceneData, scenes: SceneData[], index: number): number {
  return getSceneTimelineStart(scene, scenes, index, getSceneDuration);
}

/**
 * Collect all snap points from the timeline state, excluding specific clip IDs.
 */
export function collectSnapPoints(
  state: CanvasState,
  excludeClipIds: Set<string>,
): SnapPoint[] {
  const points: SnapPoint[] = [];

  // Scene boundaries. Include both starts and ends so overlay scenes on
  // different video tracks can be matched continuously while dragging.
  for (let i = 0; i < state.scenes.length; i++) {
    const scene = state.scenes[i];
    const start = getSceneStart(scene, state.scenes, i);
    const dur = getSceneDuration(scene);
    points.push({ time: start, source: "scene-boundary" });
    points.push({ time: start + dur, source: "scene-boundary" });
  }
  // Time 0
  points.push({ time: 0, source: "scene-boundary" });

  // Clip edges
  for (const clip of state.clips) {
    if (excludeClipIds.has(clip.id)) continue;
    points.push({ time: clip.startTime, source: "clip-start" });
    points.push({ time: clip.endTime, source: "clip-end" });
    for (const localTime of getCachedClipKeyframeTimes(clip.keyframesJson, clip.endTime - clip.startTime)) {
      points.push({ time: clip.startTime + localTime, source: "clip-keyframe" });
    }
  }

  // Playhead
  points.push({ time: state.currentTime, source: "playhead" });

  // Timeline markers
  for (const marker of state.markers || []) {
    if (Number.isFinite(marker.time)) {
      points.push({ time: marker.time, source: "marker" });
    }
  }

  // Beats (phase 11, Snap to beats)
  for (const time of snapBeatTimes(state, excludeClipIds)) {
    if (Number.isFinite(time)) points.push({ time, source: "beat" });
  }

  return points;
}

/**
 * Find the nearest snap point within a pixel threshold.
 * Returns the snap time or null if nothing is close enough.
 */
export function findSnap(
  time: number,
  snapPoints: SnapPoint[],
  zoom: number,
  thresholdPx: number = 8,
): number | null {
  return findSnapGuide(time, snapPoints, zoom, thresholdPx)?.time ?? null;
}

/**
 * Find the nearest snap point with metadata for canvas feedback.
 */
export function findSnapGuide(
  time: number,
  snapPoints: SnapPoint[],
  zoom: number,
  thresholdPx: number = 8,
): SnapGuide | null {
  const thresholdSec = thresholdPx / zoom;
  let best: SnapPoint | null = null;
  let bestDist = Infinity;

  for (const point of snapPoints) {
    const dist = Math.abs(time - point.time);
    if (dist < thresholdSec && dist < bestDist) {
      bestDist = dist;
      best = point;
    }
  }

  return best ? { time: best.time, source: best.source, distanceSeconds: bestDist } : null;
}

/**
 * For a move drag: compute snap for the primary clip's start and end edges.
 * Returns the snap-adjusted delta time, or the raw delta if no snap.
 */
export function snapMove(
  primaryOrigStart: number,
  primaryOrigEnd: number,
  rawDeltaTime: number,
  snapPoints: SnapPoint[],
  zoom: number,
  thresholdPx: number = 8,
): { deltaTime: number; snapTime: number | null; snapSource: SnapPoint["source"] | null; snapEdge: "start" | "end" | null } {
  const candidateStart = primaryOrigStart + rawDeltaTime;
  const candidateEnd = primaryOrigEnd + rawDeltaTime;
  const snapStart = findSnapGuide(candidateStart, snapPoints, zoom, thresholdPx);
  const snapEnd = findSnapGuide(candidateEnd, snapPoints, zoom, thresholdPx);

  if (snapStart && (!snapEnd || snapStart.distanceSeconds <= snapEnd.distanceSeconds)) {
    return {
      deltaTime: snapStart.time - primaryOrigStart,
      snapTime: snapStart.time,
      snapSource: snapStart.source,
      snapEdge: "start",
    };
  }

  if (snapEnd) {
    return {
      deltaTime: snapEnd.time - primaryOrigEnd,
      snapTime: snapEnd.time,
      snapSource: snapEnd.source,
      snapEdge: "end",
    };
  }

  return { deltaTime: rawDeltaTime, snapTime: null, snapSource: null, snapEdge: null };
}

/**
 * For a resize drag: snap the edge being resized.
 */
export function snapResize(
  candidateTime: number,
  snapPoints: SnapPoint[],
  zoom: number,
  thresholdPx: number = 8,
): { time: number; snapTime: number | null; snapSource: SnapPoint["source"] | null } {
  const snap = findSnapGuide(candidateTime, snapPoints, zoom, thresholdPx);
  if (snap !== null) {
    return { time: snap.time, snapTime: snap.time, snapSource: snap.source };
  }
  return { time: candidateTime, snapTime: null, snapSource: null };
}
