// Shared types and primitive helpers for timeline editing calculations.
export interface TimelineNudgeClip {
  id: string;
  startTime: number;
  endTime: number;
  trimStart?: number | null;
  trimEnd?: number | null;
}

export interface TimelineNudgeCommit {
  clipId: string;
  startTime: number;
  endTime: number;
  trackType?: string;
  trackIndex?: number;
  trimStart?: number | null;
  trimEnd?: number | null;
  locked?: boolean;
  volume?: number;
  audioPan?: number;
  audioPitch?: number;
  audioEq?: string;
  audioDenoise?: boolean;
  audioNormalize?: boolean;
  playbackSpeed?: number;
  speedRamp?: string;
  reversePlayback?: boolean;
  freezeFrame?: boolean;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  transitionType?: string;
  transitionDuration?: number;
  transitionParamsJson?: string | null;
  opacity?: number;
  scale?: number;
  positionX?: number;
  positionY?: number;
  horizontalFlip?: boolean;
  verticalFlip?: boolean;
  cropLeft?: number;
  cropRight?: number;
  cropTop?: number;
  cropBottom?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  visualFilter?: string;
  filterIntensity?: number | null;
  adjustmentsJson?: string | null;
  motionPreset?: string;
  blurStrength?: number;
  chromaKeyEnabled?: boolean;
  chromaKeyColor?: string;
  chromaKeySimilarity?: number;
  chromaKeyBlend?: number;
  blendMode?: string;
  mosaicStrength?: number;
  rotationDegrees?: number;
  keyframesJson?: string | null;
  textStyle?: string | null;
}

export type TimelineDuplicateClip = TimelineNudgeClip & Record<string, unknown>;
export type TimelineDuplicateInput = Record<string, unknown> & {
  startTime: number;
  endTime: number;
};

export interface TimelineClipboardClip {
  offsetStart: number;
  duration: number;
  input: TimelineDuplicateInput;
}

/** A copied scene (phase 10c): pasted as a copy of the scene while it still exists. */
export interface TimelineClipboardScene {
  sceneId: string;
  offsetStart: number;
  duration: number;
  trackIndex: number;
}

export interface TimelineClipboard {
  groupDuration: number;
  clips: TimelineClipboardClip[];
  /** Scenes copied with the clips (multi-selection copy); offsets share the clips' group start. */
  scenes?: TimelineClipboardScene[];
}

export interface TimelineCutResult {
  clipboard: TimelineClipboard;
  deleteIds: string[];
}

export interface TimelineRippleDeleteResult {
  deleteIds: string[];
  commits: TimelineNudgeCommit[];
  creates?: TimelineDuplicateInput[];
}

export interface TimelineExtractToClipboardResult extends TimelineRippleDeleteResult {
  clipboard: TimelineClipboard;
}

export interface TimelineDeleteBatchPlan {
  deleteIds: string[];
  blockedSyntheticCount: number;
}

export interface TimelineInsertPastePlan {
  inputs: TimelineDuplicateInput[];
  commits: TimelineNudgeCommit[];
}

export interface TimelineInsertGapPlan {
  commits: TimelineNudgeCommit[];
  creates: TimelineDuplicateInput[];
}

export interface TimelineOverwritePastePlan {
  inputs: TimelineDuplicateInput[];
  deleteIds: string[];
  commits: TimelineNudgeCommit[];
}

export interface TimelineDetachAudioPlan {
  creates: TimelineDuplicateInput[];
  updates: TimelineNudgeCommit[];
}

export interface TimelineNavigationScene {
  id?: string;
  order?: number | null;
  trackIndex?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  duration?: number | null;
  timelinePositionSeconds?: number | null;
  /** Scene speed (phase 10b): the timeline length is the duration over the speed. */
  playbackSpeed?: number | null;
  speedCurveJson?: string | null;
}

export interface TimelineCloseGapPlan {
  gaps: { from: number; size: number }[];
  sceneUpdates: { id: string; pos: number }[];
  clipUpdates: { id: string; startTime: number; endTime: number }[];
}

export interface TimelineMarkerLike {
  id?: string;
  time: number;
}

export interface TimelineMarkerTarget {
  time: number;
  label: string;
}

export interface TimelineMarkerSplitTarget {
  splitTime: number;
  clipIds: string[];
}

export type TimelineEditableClip = TimelineNudgeClip & {
  trackType?: string | null;
  trackIndex?: number | null;
  sceneId?: string | null;
  mediaUrl?: string | null;
  trimStart?: number | null;
  trimEnd?: number | null;
  locked?: boolean | null;
  volume?: number | null;
  audioPan?: number | null;
  audioPitch?: number | null;
  audioEq?: string | null;
  audioDenoise?: boolean | null;
  audioNormalize?: boolean | null;
  playbackSpeed?: number | null;
  speedRamp?: string | null;
  reversePlayback?: boolean | null;
  freezeFrame?: boolean | null;
  fadeInDuration?: number | null;
  fadeOutDuration?: number | null;
  transitionType?: string | null;
  transitionDuration?: number | null;
  transitionParamsJson?: string | null;
  opacity?: number | null;
  scale?: number | null;
  positionX?: number | null;
  positionY?: number | null;
  horizontalFlip?: boolean | null;
  verticalFlip?: boolean | null;
  cropLeft?: number | null;
  cropRight?: number | null;
  cropTop?: number | null;
  cropBottom?: number | null;
  brightness?: number | null;
  contrast?: number | null;
  saturation?: number | null;
  visualFilter?: string | null;
  filterIntensity?: number | null;
  adjustmentsJson?: string | null;
  motionPreset?: string | null;
  blurStrength?: number | null;
  chromaKeyEnabled?: boolean | null;
  chromaKeyColor?: string | null;
  chromaKeySimilarity?: number | null;
  chromaKeyBlend?: number | null;
  blendMode?: string | null;
  mosaicStrength?: number | null;
  rotationDegrees?: number | null;
  keyframesJson?: string | null;
  textStyle?: string | null;
};

export interface TimelineEditableTrack {
  type: string;
  index: number;
  locked?: boolean | null;
  muted?: boolean | null;
  visible?: boolean | null;
}

export const MIN_CLIP_DURATION_SECONDS = 0.1;
export const TIMELINE_REFERENCE_PIXELS_PER_SECOND = 100;
export const TIMELINE_ZOOM_LEVELS = [25, 50, 100, 150, 200, 300, 400] as const;
export const DEFAULT_TIMELINE_ZOOM = 50;
export const MIN_TIMELINE_ZOOM = TIMELINE_ZOOM_LEVELS[0];
export const MAX_TIMELINE_ZOOM = TIMELINE_ZOOM_LEVELS[TIMELINE_ZOOM_LEVELS.length - 1];
export const TIMELINE_FIT_GUTTER = 56;
export const TIMELINE_LABEL_COLUMN_WIDTH = 112;
export const TIMELINE_COMPACT_FIT_RATIO = 0.5;
export const TIMELINE_FRAME_STEP_SECONDS = 1 / 30;
export const TIMELINE_LARGE_NUDGE_STEP_SECONDS = 1;

export function roundTimelineTime(value: number): number {
  return Math.round(value * 1000) / 1000; // i18n-ignore
}

export function isTimelineClipUnderPlayhead(clip: TimelineNudgeClip, playheadTime: number): boolean {
  return playheadTime >= clip.startTime && playheadTime < clip.endTime;
}

export function getTimelineMarkerBracket(
  markers: TimelineMarkerLike[],
  playheadTime: number,
): { rangeStart: number; rangeEnd: number } | null {
  if (!Number.isFinite(playheadTime) || markers.length < 2) return null;

  const time = roundTimelineTime(playheadTime);
  const markerTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const rangeStart = [...markerTimes].reverse().find((markerTime) => markerTime <= time + 0.05);
  const rangeEnd = markerTimes.find((markerTime) => markerTime > time + 0.05);
  if (rangeStart == null || rangeEnd == null || rangeEnd <= rangeStart + MIN_CLIP_DURATION_SECONDS) {
    return null;
  }

  return { rangeStart, rangeEnd };
}

export function getClipTrimValue(clip: TimelineNudgeClip, key: "trimStart" | "trimEnd"): number | null {
  const value = clip[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getTimelineTrimForSegment(
  clip: TimelineNudgeClip,
  segment: { startTime: number; endTime: number },
): { trimStart?: number | null; trimEnd?: number | null } {
  const trimStart = getClipTrimValue(clip, "trimStart");
  const trimEnd = getClipTrimValue(clip, "trimEnd");
  if (trimStart == null && trimEnd == null) return {};

  const nextTrimStart = trimStart == null
    ? null
    : roundTimelineTime(trimStart + Math.max(0, segment.startTime - clip.startTime));
  const nextTrimEnd = trimEnd == null
    ? null
    : roundTimelineTime(trimEnd - Math.max(0, clip.endTime - segment.endTime));

  return { trimStart: nextTrimStart, trimEnd: nextTrimEnd };
}

/** Resolve where a newly-placed clip lands: if the requested spot overlaps a
 *  same-track neighbor, snap to the nearer side of the blocking clip (still
 *  checking the rest of the track). Returns null when nothing fits — the
 *  caller should abort the placement. */
export function resolveTimelineDropStart(
  requestedStart: number,
  duration: number,
  blockers: Array<{ startTime: number; endTime: number }>,
): number | null {
  const start = Math.max(0, requestedStart);
  const overlaps = (s: number) =>
    blockers.some((b) => s < b.endTime - 0.001 && s + duration > b.startTime + 0.001);
  if (!overlaps(start)) return start;

  const blocking = blockers.find((b) => start < b.endTime - 0.001 && start + duration > b.startTime + 0.001)!;
  const before = blocking.startTime - duration;
  const after = blocking.endTime;
  const candidates = Math.abs(start - before) <= Math.abs(after - start) ? [before, after] : [after, before];
  for (const candidate of candidates) {
    if (candidate < 0) continue;
    if (!overlaps(candidate)) return candidate;
  }
  return null;
}

export function getTimelineRemainingSegments(
  clip: TimelineDuplicateClip,
  intervals: { startTime: number; endTime: number }[],
): { startTime: number; endTime: number }[] {
  let segments = [{ startTime: clip.startTime, endTime: clip.endTime }];

  for (const interval of intervals) {
    const nextSegments: { startTime: number; endTime: number }[] = [];
    for (const segment of segments) {
      const overlapStart = Math.max(segment.startTime, interval.startTime);
      const overlapEnd = Math.min(segment.endTime, interval.endTime);
      if (overlapEnd <= overlapStart + 0.001) {
        nextSegments.push(segment);
        continue;
      }

      if (overlapStart > segment.startTime + MIN_CLIP_DURATION_SECONDS) {
        nextSegments.push({
          startTime: roundTimelineTime(segment.startTime),
          endTime: roundTimelineTime(overlapStart),
        });
      }
      if (overlapEnd < segment.endTime - MIN_CLIP_DURATION_SECONDS) {
        nextSegments.push({
          startTime: roundTimelineTime(overlapEnd),
          endTime: roundTimelineTime(segment.endTime),
        });
      }
    }
    segments = nextSegments;
  }

  return segments;
}
