// In/out clip animation presets, compiled to clip keyframes. Because they are
// plain keyframes, they animate live in the preview (keyframe-interpolation)
// and export server-side with no extra render path.

import { parseTimelineKeyframes } from "./timeline-editing-properties";
import type { TimelineKeyframePoint } from "./timeline-editing-properties";
import { roundTimelineTime } from "./timeline-editing-shared";
import { getEditableTimelineSelectionClipIds } from "./timeline-editing-properties";
import type { TimelineEditableClip, TimelineEditableTrack, TimelineNudgeCommit } from "./timeline-editing-shared";

export type TimelineAnimationEdge = "in" | "out";

export const TIMELINE_ANIMATION_PRESETS = [
  "fade",
  "zoom",
  "pop",
  "slide_left",
  "slide_right",
  "slide_up",
  "slide_down",
  "spin",
  "drop",
  "drift",
] as const;

export type TimelineAnimationPreset = (typeof TIMELINE_ANIMATION_PRESETS)[number];

export function normalizeTimelineAnimationPreset(value: unknown): TimelineAnimationPreset | null {
  const preset = String(value ?? "").trim().toLowerCase();
  return (TIMELINE_ANIMATION_PRESETS as readonly string[]).includes(preset)
    ? (preset as TimelineAnimationPreset)
    : null;
}

type AnimationBase = {
  scale: number;
  opacity: number;
  positionX: number;
  positionY: number;
  rotationDegrees: number;
};

function clipAnimationBase(clip: TimelineEditableClip): AnimationBase {
  const num = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    scale: num(clip.scale, 1),
    opacity: num(clip.opacity, 1),
    positionX: num(clip.positionX, 0.5),
    positionY: num(clip.positionY, 0.5),
    rotationDegrees: num(clip.rotationDegrees, 0),
  };
}

/** The animated channel values at the clip's edge (fully "out" state). */
function presetEdgeState(preset: TimelineAnimationPreset, base: AnimationBase): Record<string, number> {
  switch (preset) {
    case "fade":
      return { opacity: 0 };
    case "zoom":
      return { opacity: 0, scale: base.scale * 0.5 };
    case "pop":
      return { opacity: 0, scale: base.scale * 0.3 };
    case "slide_left":
      return { opacity: 0, position_x: base.positionX + 0.3 };
    case "slide_right":
      return { opacity: 0, position_x: base.positionX - 0.3 };
    case "slide_up":
      return { opacity: 0, position_y: base.positionY + 0.25 };
    case "slide_down":
      return { opacity: 0, position_y: base.positionY - 0.25 };
    case "spin":
      return { opacity: 0, rotation_degrees: base.rotationDegrees - 180, scale: base.scale * 0.6 };
    case "drop":
      return { opacity: 0, position_y: base.positionY - 0.35, scale: base.scale * 1.2 };
    case "drift":
      return { opacity: 0, position_x: base.positionX - 0.06, position_y: base.positionY + 0.04 };
  }
}

/** The clip's resting channel values (only for channels the preset animates). */
function presetRestState(preset: TimelineAnimationPreset, base: AnimationBase): Record<string, number> {
  const edge = presetEdgeState(preset, base);
  const rest: Record<string, number> = {};
  const byChannel: Record<string, number> = {
    opacity: base.opacity,
    scale: base.scale,
    position_x: base.positionX,
    position_y: base.positionY,
    rotation_degrees: base.rotationDegrees,
  };
  for (const channel of Object.keys(edge)) rest[channel] = byChannel[channel];
  return rest;
}

/**
 * Build the keyframe points for an animation preset on one clip edge, merged
 * with the clip's existing keyframes (existing points inside the animated
 * window are replaced; everything else is preserved).
 */
export function getTimelineAnimationKeyframes(
  clip: TimelineEditableClip,
  preset: TimelineAnimationPreset,
  edge: TimelineAnimationEdge,
  durationSeconds: number,
): TimelineKeyframePoint[] {
  const clipDuration = Math.max(0, clip.endTime - clip.startTime);
  const duration = Math.max(0.1, Math.min(durationSeconds, clipDuration / 2));
  const base = clipAnimationBase(clip);
  const edgeState = presetEdgeState(preset, base);
  const restState = presetRestState(preset, base);

  const windowStart = edge === "in" ? 0 : roundTimelineTime(clipDuration - duration);
  const windowEnd = edge === "in" ? roundTimelineTime(duration) : roundTimelineTime(clipDuration);

  const points: TimelineKeyframePoint[] = [];
  const push = (time: number, values: Record<string, number>) => {
    points.push({ time: roundTimelineTime(time), ...values } as TimelineKeyframePoint);
  };

  if (edge === "in") {
    push(0, edgeState);
    if (preset === "pop") push(duration * 0.7, { ...restState, scale: base.scale * 1.08, opacity: base.opacity });
    push(duration, restState);
  } else {
    push(windowStart, restState);
    if (preset === "pop") push(windowStart + duration * 0.3, { ...restState, scale: base.scale * 1.08 });
    push(clipDuration, edgeState);
  }

  const existing = parseTimelineKeyframes(clip.keyframesJson).filter(
    (point) => point.time < windowStart - 0.001 || point.time > windowEnd + 0.001,
  );
  return [...existing, ...points].sort((a, b) => a.time - b.time);
}

/** Commit plans that apply an animation preset to the selected visual clips. */
export function getTimelineApplyAnimationPresetTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  preset: string,
  edge: TimelineAnimationEdge,
  durationSeconds: number,
): TimelineNudgeCommit[] {
  const normalized = normalizeTimelineAnimationPreset(preset);
  if (!normalized || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType !== "audio" && clip.trackType !== "effect")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      keyframesJson: JSON.stringify({
        keyframes: getTimelineAnimationKeyframes(clip, normalized, edge, durationSeconds),
      }),
    }));
}
