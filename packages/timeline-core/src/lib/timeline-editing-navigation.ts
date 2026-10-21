// Navigation, split-target, and range-selection helpers for timeline editing.
import { sceneTimelineSeconds } from "../timeline/scene-duration";
import { speedCurvePreset } from "../motion/speed";
import { planClipSpeed, type SpeedClip, type SpeedRequest } from "../controller/speed-plan";
import {
  TimelineNudgeClip,
  TimelineNudgeCommit,
  TimelineNavigationScene,
  TimelineCloseGapPlan,
  TimelineMarkerLike,
  TimelineMarkerTarget,
  TimelineMarkerSplitTarget,
  TimelineEditableClip,
  TimelineEditableTrack,
  MIN_CLIP_DURATION_SECONDS,
  roundTimelineTime,
  isTimelineClipUnderPlayhead,
  getTimelineMarkerBracket,
} from "./timeline-editing-shared";
import {
  getEditableTimelineClipIds,
  getEditableTimelineSelectionClipIds,
} from "./timeline-editing-properties";

export function getCloseGapSceneStart(scene: TimelineNavigationScene, scenes: TimelineNavigationScene[], migrated: boolean): number {
  if (migrated) return Number(scene.timelinePositionSeconds || 0);
  let start = 0;
  const sorted = [...scenes].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  for (const item of sorted) {
    if (item.id === scene.id) break;
    if (Number(item.trackIndex || 1) === 1) start += sceneDurationSeconds(item);
  }
  return start;
}

export function getTimelineCloseGapPlan({
  scenes,
  clips,
}: {
  scenes: TimelineNavigationScene[];
  clips: TimelineNudgeClip[];
}): TimelineCloseGapPlan {
  const migrated = scenes.some((scene) => Number(scene.timelinePositionSeconds || 0) > 0);
  const v1Scenes = scenes
    .filter((scene) => Number(scene.trackIndex || 1) === 1)
    .slice()
    .sort((a, b) => getCloseGapSceneStart(a, scenes, migrated) - getCloseGapSceneStart(b, scenes, migrated));

  const gaps: { from: number; size: number }[] = [];
  let cursor = 0;
  for (const scene of v1Scenes) {
    const start = getCloseGapSceneStart(scene, scenes, migrated);
    const duration = sceneDurationSeconds(scene);
    if (start > cursor + 0.01) {
      gaps.push({ from: roundTimelineTime(cursor), size: roundTimelineTime(start - cursor) });
    }
    cursor = Math.max(cursor, start) + duration;
  }

  const mapTime = (time: number): number => {
    let shift = 0;
    for (const gap of gaps) {
      if (time >= gap.from + gap.size) shift += gap.size;
    }
    return roundTimelineTime(Math.max(0, time - shift));
  };

  const sceneUpdates = scenes
    .filter((scene): scene is TimelineNavigationScene & { id: string } => Boolean(scene.id))
    .map((scene) => {
      const current = getCloseGapSceneStart(scene, scenes, migrated);
      return { id: scene.id, current, pos: mapTime(current) };
    })
    .filter((update) => Math.abs(update.pos - update.current) > 0.01)
    .map(({ id, pos }) => ({ id, pos }));

  const clipUpdates = clips
    .map((clip) => {
      const startTime = mapTime(clip.startTime);
      const endTime = mapTime(clip.endTime);
      return { id: clip.id, currentStart: clip.startTime, currentEnd: clip.endTime, startTime, endTime };
    })
    .filter((update) => (
      Math.abs(update.startTime - update.currentStart) > 0.01 ||
      Math.abs(update.endTime - update.currentEnd) > 0.01
    ))
    .map(({ id, startTime, endTime }) => ({ id, startTime, endTime }));

  return { gaps, sceneUpdates, clipUpdates };
}

export function parseClockTimeSeconds(value: string | null | undefined): number {
  if (!value) return 0;
  const parts = value.replace(",", ".").split(":").map((part) => Number(part));
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2 && parts.every(Number.isFinite)) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

export function sceneDurationSeconds(scene: TimelineNavigationScene): number {
  const duration = Number(scene.duration || 0);
  if (Number.isFinite(duration) && duration > 0) return sceneTimelineSeconds(scene, duration);
  const inferred = parseClockTimeSeconds(scene.endTime) - parseClockTimeSeconds(scene.startTime);
  return Number.isFinite(inferred) && inferred > 0 ? sceneTimelineSeconds(scene, inferred) : 0;
}

export function getTimelineNavigationEndTime({
  clips,
  scenes,
}: {
  clips: TimelineNudgeClip[];
  scenes: TimelineNavigationScene[];
}): number {
  const clipEnd = clips.reduce((maxEnd, clip) => Math.max(maxEnd, Number(clip.endTime || 0)), 0);
  const sceneEnd = scenes.reduce((maxEnd, scene, index) => {
    const positioned = Number(scene.timelinePositionSeconds);
    const start = Number.isFinite(positioned) && positioned > 0
      ? positioned
      : scenes.slice(0, index).reduce((total, item) => total + sceneDurationSeconds(item), 0);
    return Math.max(maxEnd, start + sceneDurationSeconds(scene));
  }, 0);
  return roundTimelineTime(Math.max(clipEnd, sceneEnd, 0));
}

export function timelineSceneBoundaryTimes(scenes: TimelineNavigationScene[]): number[] {
  let sequentialStart = 0;
  const times: number[] = [];
  for (const scene of scenes) {
    const positioned = Number(scene.timelinePositionSeconds);
    const start = Number.isFinite(positioned) && positioned > 0 ? positioned : sequentialStart;
    const duration = sceneDurationSeconds(scene);
    times.push(roundTimelineTime(start), roundTimelineTime(start + duration));
    sequentialStart += duration;
  }
  return times;
}

export function getAdjacentTimelineEditPoint({
  clips,
  scenes,
  currentTime,
  direction,
}: {
  clips: TimelineNudgeClip[];
  scenes: TimelineNavigationScene[];
  currentTime: number;
  direction: -1 | 1;
}): number | null {
  if (!Number.isFinite(currentTime)) return null;
  const boundaries = new Set<number>();
  for (const clip of clips) {
    boundaries.add(roundTimelineTime(Math.max(0, clip.startTime)));
    boundaries.add(roundTimelineTime(Math.max(0, clip.endTime)));
  }
  for (const time of timelineSceneBoundaryTimes(scenes)) {
    boundaries.add(roundTimelineTime(Math.max(0, time)));
  }

  const sorted = [...boundaries].filter((time) => Number.isFinite(time)).sort((a, b) => a - b);
  const epsilon = 0.001;
  if (direction < 0) {
    return [...sorted].reverse().find((time) => time < currentTime - epsilon) ?? null;
  }
  return sorted.find((time) => time > currentTime + epsilon) ?? null;
}

export function getTimelineSplitClipIdsAtPlayhead(
  clips: TimelineNudgeClip[],
  selectedClipIds: Set<string>,
  playheadTime: number,
): string[] {
  if (!Number.isFinite(playheadTime)) return [];
  const time = roundTimelineTime(playheadTime);
  return clips
    .filter((clip) => selectedClipIds.size === 0 || selectedClipIds.has(clip.id))
    .filter((clip) => (
      time >= clip.startTime + MIN_CLIP_DURATION_SECONDS &&
      time <= clip.endTime - MIN_CLIP_DURATION_SECONDS
    ))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => clip.id);
}

export function getTimelineSplitTargetClipIdsAtPlayhead(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
): string[] {
  const activeSelection = new Set<string>();
  for (const id of selectedClipIds) activeSelection.add(id);
  if (activeSelection.size === 0 && selectedClipId) activeSelection.add(selectedClipId);
  if (activeSelection.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeSelection);
  if (editableIds.size === 0) return [];

  return getTimelineSplitClipIdsAtPlayhead(clips, editableIds, playheadTime);
}

export function getTimelineSplitAllTrackClipIdsAtPlayhead(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  playheadTime: number,
): string[] {
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  return getTimelineSplitClipIdsAtPlayhead(clips, editableIds, playheadTime);
}

export function getTimelineSplitAllTrackTargetAtNearestMarker(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  currentTime: number,
): TimelineMarkerSplitTarget | null {
  if (!Number.isFinite(currentTime) || markers.length === 0) return null;

  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const markerTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite)
    .sort((a, b) => Math.abs(a - currentTime) - Math.abs(b - currentTime) || a - b);

  for (const markerTime of markerTimes) {
    const clipIds = getTimelineSplitClipIdsAtPlayhead(clips, editableIds, markerTime);
    if (clipIds.length > 0) return { splitTime: markerTime, clipIds };
  }

  return null;
}

export function getTimelineSplitTargetAtNearestMarker(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  markers: TimelineMarkerLike[],
  currentTime: number,
): TimelineMarkerSplitTarget | null {
  if (!Number.isFinite(currentTime) || markers.length === 0) return null;

  const activeSelection = new Set<string>();
  for (const id of selectedClipIds) activeSelection.add(id);
  if (activeSelection.size === 0 && selectedClipId) activeSelection.add(selectedClipId);
  if (activeSelection.size === 0) return null;

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeSelection);
  if (editableIds.size === 0) return null;

  const markerTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite)
    .sort((a, b) => Math.abs(a - currentTime) - Math.abs(b - currentTime) || a - b);

  for (const markerTime of markerTimes) {
    const clipIds = getTimelineSplitClipIdsAtPlayhead(clips, editableIds, markerTime);
    if (clipIds.length > 0) {
      return { splitTime: markerTime, clipIds };
    }
  }

  return null;
}

export function getTimelineSplitMarkerRangeBoundaryTargets(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  currentTime: number,
): TimelineMarkerSplitTarget[] {
  const bracket = getTimelineMarkerBracket(markers, currentTime);
  if (!bracket) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const rangeStart = roundTimelineTime(bracket.rangeStart);
  const rangeEnd = roundTimelineTime(bracket.rangeEnd);
  if (rangeEnd - rangeStart <= MIN_CLIP_DURATION_SECONDS) return [];

  return [rangeEnd, rangeStart]
    .map((splitTime) => ({
      splitTime,
      clipIds: getTimelineSplitClipIdsAtPlayhead(clips, editableIds, splitTime),
    }))
    .filter((target) => target.clipIds.length > 0);
}

export function getTimelineTrackSplitTargetClipIdsAtPlayhead(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
): string[] {
  const activeIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if ((selectedClipIds.size > 0 || selectedClipId) && activeIds.size === 0) return [];

  const anchor = clips
    .filter((clip) => activeIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];

  if (!anchor?.trackType || anchor.trackIndex == null) {
    return [];
  }

  const trackClips = clips.filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex);
  const editableIds = getEditableTimelineClipIds(trackClips, tracks, new Set(trackClips.map((clip) => clip.id)));
  return getTimelineSplitClipIdsAtPlayhead(trackClips, editableIds, playheadTime);
}

export function getTimelineBladeSplitClipId(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  clipId: string,
  splitTime: number,
): string | null {
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set([clipId]));
  if (!editableIds.has(clipId)) return null;
  const splitIds = getTimelineSplitClipIdsAtPlayhead(clips, editableIds, splitTime);
  return splitIds.includes(clipId) ? clipId : null;
}

export function getTimelineBladeSplitClipIdsAtTime(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  splitTime: number,
): string[] {
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  return getTimelineSplitClipIdsAtPlayhead(clips, editableIds, splitTime);
}

export function getTimelineSetDurationTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  durationSeconds: number,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);
  const duration = Math.max(MIN_CLIP_DURATION_SECONDS, Number.isFinite(durationSeconds) ? durationSeconds : MIN_CLIP_DURATION_SECONDS);

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.startTime + duration),
    }));
}

export function getTimelineFitSelectionToMarkerRangeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  markers: TimelineMarkerLike[],
  currentTime: number,
): TimelineNudgeCommit[] {
  const bracket = getTimelineMarkerBracket(markers, currentTime);
  if (!bracket) return [];

  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);
  const editableClips = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (editableClips.length === 0) return [];

  const sourceStart = Math.min(...editableClips.map((clip) => clip.startTime));
  const sourceEnd = Math.max(...editableClips.map((clip) => clip.endTime));
  const sourceDuration = roundTimelineTime(sourceEnd - sourceStart);
  const targetStart = roundTimelineTime(bracket.rangeStart);
  const targetEnd = roundTimelineTime(bracket.rangeEnd);
  const targetDuration = roundTimelineTime(targetEnd - targetStart);
  if (sourceDuration <= MIN_CLIP_DURATION_SECONDS || targetDuration <= MIN_CLIP_DURATION_SECONDS) return [];

  const scale = targetDuration / sourceDuration;
  return editableClips
    .map((clip) => {
      const startTime = roundTimelineTime(targetStart + ((clip.startTime - sourceStart) * scale));
      const endTime = roundTimelineTime(targetStart + ((clip.endTime - sourceStart) * scale));
      return { clipId: clip.id, startTime, endTime };
    })
    .filter((commit) => commit.endTime - commit.startTime >= MIN_CLIP_DURATION_SECONDS);
}

/** A speed helper's commit: speed.set's clip update (length, speed fields, rescaled keyframes, pushed clips). */
export type TimelineSpeedCommit = TimelineNudgeCommit & { speedCurveJson?: string | null; preservePitch?: boolean };

/** The selected editable video/audio clips a speed preset applies to. */
function speedPresetTargets(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineEditableClip[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];
  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "audio")
    .sort((a, b) => (a.trackType || "").localeCompare(b.trackType || "") || a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
}

/** The ids a speed preset applies to (for hosts that run speed.set through the controller). */
export function getTimelineSpeedPresetTargetIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): string[] {
  return speedPresetTargets(clips, tracks, selectedClipIds, selectedClipId).map((clip) => clip.id);
}

function speedPresetCommits(clips: TimelineEditableClip[], targets: TimelineEditableClip[], request: SpeedRequest): TimelineSpeedCommit[] {
  if (targets.length === 0) return [];
  const plan = planClipSpeed(clips as SpeedClip[], targets.map((clip) => clip.id), request);
  return plan.ok ? plan.value as TimelineSpeedCommit[] : [];
}

/**
 * The 0.5x / 1x / 2x presets (context menu, Alt+1..3) as speed.set plans them: the length follows the speed
 * (the source span is kept), keyframes follow their source moments, a curve or legacy ramp is cleared (a normal
 * speed, as in the Speed tab), and later clips on the track the longer clip would overlap are pushed.
 */
export function getTimelineSetPlaybackSpeedTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playbackSpeed: number,
): TimelineSpeedCommit[] {
  const speed = Math.max(0.1, Math.min(8, Number.isFinite(playbackSpeed) ? playbackSpeed : 1));
  return speedPresetCommits(clips, speedPresetTargets(clips, tracks, selectedClipIds, selectedClipId), { speed, curve: null });
}

export function normalizeTimelineSpeedRamp(speedRamp: string): string {
  return ["none", "montage", "hero", "bullet"].includes(speedRamp) ? speedRamp : "none";
}

/** speed.set's request for a ramp preset: the matching curve preset at 1x (the Speed tab's cards), or no curve. */
export function speedRampRequest(speedRamp: string): SpeedRequest {
  const ramp = normalizeTimelineSpeedRamp(speedRamp);
  return ramp === "none" ? { curve: null } : { speed: 1, curve: speedCurvePreset(ramp) };
}

/** The montage / hero / bullet ramp presets as speed.set plans them (see getTimelineSetPlaybackSpeedTargetCommits). */
export function getTimelineSetSpeedRampTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  speedRamp: string,
): TimelineSpeedCommit[] {
  return speedPresetCommits(clips, speedPresetTargets(clips, tracks, selectedClipIds, selectedClipId), speedRampRequest(speedRamp));
}

export function getTimelineToggleReversePlaybackTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "audio")
    .sort((a, b) => (a.trackType || "").localeCompare(b.trackType || "") || a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      reversePlayback: !Boolean(clip.reversePlayback),
    }));
}

export function getTimelineToggleFreezeFrameTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      freezeFrame: !Boolean(clip.freezeFrame),
    }));
}

export function getTimelineSetFadeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  fadeInDuration: number,
  fadeOutDuration: number,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);
  const coerceFade = (value: number, maxFade: number) => {
    const fade = Number.isFinite(value) ? value : 0;
    return roundTimelineTime(Math.max(0, Math.min(maxFade, fade)));
  };

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "audio" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => (a.trackType || "").localeCompare(b.trackType || "") || a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => {
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const maxFade = duration / 2;
      return {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: roundTimelineTime(clip.endTime),
        fadeInDuration: coerceFade(fadeInDuration, maxFade),
        fadeOutDuration: coerceFade(fadeOutDuration, maxFade),
      };
    });
}

export function getTimelineSetFadeEdgeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  edge: "in" | "out",
  fadeDuration: number,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);
  const coerceFade = (value: number, maxFade: number) => {
    const fade = Number.isFinite(value) ? value : 0;
    return roundTimelineTime(Math.max(0, Math.min(maxFade, fade)));
  };

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "audio" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => (a.trackType || "").localeCompare(b.trackType || "") || a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => {
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const maxFade = duration / 2;
      const currentFadeIn = coerceFade(Number(clip.fadeInDuration ?? 0), maxFade);
      const currentFadeOut = coerceFade(Number(clip.fadeOutDuration ?? 0), maxFade);
      const nextFade = coerceFade(fadeDuration, maxFade);
      return {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: roundTimelineTime(clip.endTime),
        fadeInDuration: edge === "in" ? nextFade : currentFadeIn,
        fadeOutDuration: edge === "out" ? nextFade : currentFadeOut,
      };
    });
}

export const TIMELINE_TRANSITION_TYPE_ALIASES: Record<string, string> = {
  "cross-fade": "cross_dissolve",
  crossfade: "cross_dissolve",
  dissolve: "cross_dissolve",
  fade: "cross_dissolve",
  fade_black: "dip_black",
  fade_white: "dip_white",
  zoomin: "zoom_in",
  zoomout: "zoom_out",
  wipeleft: "wipe_left",
  wiperight: "wipe_right",
  wipeup: "wipe_up",
  wipedown: "wipe_down",
  slideleft: "slide_left",
  slideright: "slide_right",
  slideup: "slide_up",
  slidedown: "slide_down",
  iris: "circle_open",
  circleopen: "circle_open",
  radial: "clock_wipe",
  pixelize: "pixelate",
  blur: "blur_dissolve",
};

// Canonical transition presets: "none" plus the 25 library transitions (looks/transitions.ts). The
// pre-10a ids (cross_dissolve, dip_black/white, slide_*, wipe_left, zoom_in, blur_dissolve) keep their meaning.
export const TIMELINE_TRANSITION_TYPES = [
  "none",
  "cross_dissolve",
  "dip_black",
  "dip_white",
  "flash",
  "luma_fade",
  "slide_left",
  "slide_right",
  "slide_up",
  "slide_down",
  "push_left",
  "push_right",
  "wipe_left",
  "wipe_right",
  "wipe_up",
  "wipe_down",
  "circle_open",
  "clock_wipe",
  "zoom_in",
  "zoom_out",
  "spin",
  "blur_dissolve",
  "glitch",
  "swirl",
  "pixelate",
  "ripple",
] as const;

export function normalizeTimelineTransitionType(transitionType: string): string {
  const value = transitionType.trim().toLowerCase();
  const normalized = TIMELINE_TRANSITION_TYPE_ALIASES[value] ?? value;
  return (TIMELINE_TRANSITION_TYPES as readonly string[]).includes(normalized) ? normalized : "none";
}

export function isTimelineFadeLayer(clip: TimelineEditableClip): boolean {
  return clip.trackType === "video" || clip.trackType === "audio" || clip.trackType === "text" || clip.trackType === "sticker";
}

export function getTimelineTransitionPresetUpdate(
  transitionType: string,
  transitionDuration: number,
  clip?: Pick<TimelineEditableClip, "startTime" | "endTime"> | null,
): Pick<TimelineNudgeCommit, "transitionType" | "transitionDuration" | "fadeInDuration" | "fadeOutDuration" | "transitionParamsJson"> {
  const nextTransitionType = normalizeTimelineTransitionType(transitionType);
  const maxTransition = clip ? Math.max(0, clip.endTime - clip.startTime) / 2 : Number.POSITIVE_INFINITY;
  const value = Number.isFinite(transitionDuration) ? transitionDuration : 0;
  const duration = nextTransitionType === "none"
    ? 0
    : roundTimelineTime(Math.max(0, Math.min(maxTransition, value)));

  return {
    transitionType: nextTransitionType,
    transitionDuration: duration,
    fadeInDuration: duration,
    fadeOutDuration: duration,
    // Params belong to the transition that was applied; swapping or clearing the
    // preset drops them so the new one starts from its registry defaults.
    transitionParamsJson: null,
  };
}

export function getTimelineSetTransitionPresetTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  transitionType: string,
  transitionDuration: number,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);
  const allEditableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const nextTransitionType = normalizeTimelineTransitionType(transitionType);

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => nextTransitionType === "none" ? isTimelineFadeLayer(clip) : clip.trackType === "video")
    .filter((clip) => {
      if (nextTransitionType === "none") return true;
      return clips.some((next) =>
        next.id !== clip.id &&
        next.trackType === clip.trackType &&
        next.trackIndex === clip.trackIndex &&
        allEditableIds.has(next.id) &&
        Math.abs(next.startTime - clip.endTime) <= 0.001,
      );
    })
    .sort((a, b) => (a.trackType || "").localeCompare(b.trackType || "") || a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => {
      const transitionUpdate = getTimelineTransitionPresetUpdate(nextTransitionType, transitionDuration, clip);
      return {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: roundTimelineTime(clip.endTime),
        ...transitionUpdate,
      };
    });
}

export function getTimelineSetAdjacentCrossfadeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  fadeDuration: number,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, activeIds);
  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .filter(isTimelineFadeLayer)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];
  if (!selected) return [];

  const allEditableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const sameTrack = clips
    .filter((clip) => clip.id !== selected.id)
    .filter((clip) => clip.trackType === selected.trackType && clip.trackIndex === selected.trackIndex)
    .filter(isTimelineFadeLayer)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  const epsilon = 0.1;
  const next = sameTrack.find((clip) => clip.startTime >= selected.endTime - epsilon);
  const previous = [...sameTrack].reverse().find((clip) => clip.endTime <= selected.startTime + epsilon);
  const neighbor = next ?? previous;
  if (!neighbor || !allEditableIds.has(neighbor.id)) return [];

  const left = selected.startTime <= neighbor.startTime ? selected : neighbor;
  const right = left.id === selected.id ? neighbor : selected;
  const leftDuration = Math.max(0, left.endTime - left.startTime);
  const rightDuration = Math.max(0, right.endTime - right.startTime);
  const maxFade = Math.min(leftDuration, rightDuration) / 2;
  const fade = roundTimelineTime(Math.max(0, Math.min(maxFade, Number.isFinite(fadeDuration) ? fadeDuration : 0)));
  if (fade <= 0) return [];

  return [
    {
      clipId: left.id,
      startTime: roundTimelineTime(left.startTime),
      endTime: roundTimelineTime(left.endTime),
      fadeInDuration: 0,
      fadeOutDuration: fade,
    },
    {
      clipId: right.id,
      startTime: roundTimelineTime(right.startTime),
      endTime: roundTimelineTime(right.endTime),
      fadeInDuration: fade,
      fadeOutDuration: 0,
    },
  ];
}

export function getTimelineRangeSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  playheadTime: number,
  direction: -1 | 1,
): Set<string> {
  if (!Number.isFinite(playheadTime)) return new Set();
  const time = roundTimelineTime(playheadTime);
  const candidates = clips
    .filter((clip) => direction < 0 ? clip.startTime < time : clip.endTime > time)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getTimelineClipSelectionAtPlayhead(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  playheadTime: number,
): Set<string> {
  if (!Number.isFinite(playheadTime)) return new Set();
  const time = roundTimelineTime(playheadTime);
  const candidates = clips
    .filter((clip) => isTimelineClipUnderPlayhead(clip, time))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getTimelineTrackClipSelectionAtPlayhead(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
): Set<string> {
  const anchorIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  const anchor = clips
    .filter((clip) => anchorIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];

  if (!anchor?.trackType || anchor.trackIndex == null) {
    return getTimelineClipSelectionAtPlayhead(clips, tracks, playheadTime);
  }

  if (!Number.isFinite(playheadTime)) return new Set();
  const time = roundTimelineTime(playheadTime);
  const candidates = clips
    .filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex)
    .filter((clip) => isTimelineClipUnderPlayhead(clip, time))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getTimelineRangeSelectionShortcut(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): -1 | 1 | null {
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "[") return -1;
  if (event.key === "]") return 1;
  return null;
}

export function getTimelineMarkerRangeSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): Set<string> {
  if (!Number.isFinite(playheadTime) || markers.length === 0) return new Set();
  const time = roundTimelineTime(playheadTime);
  const markerTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (markerTimes.length === 0) return new Set();

  const start = [...markerTimes].reverse().find((markerTime) => markerTime <= time + 0.05) ?? 0;
  const end = markerTimes.find((markerTime) => markerTime > time + 0.05) ?? Number.POSITIVE_INFINITY;
  const candidates = clips
    .filter((clip) => clip.startTime < end && clip.endTime > start)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getTimelineSelectedClipBoundaryMarkerTimes(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  markers: TimelineMarkerLike[],
): number[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const existingTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite);
  const boundaryTimes = new Set<number>();
  for (const clip of clips) {
    if (!editableIds.has(clip.id)) continue;
    for (const time of [clip.startTime, clip.endTime]) {
      const rounded = roundTimelineTime(time);
      if (!Number.isFinite(rounded)) continue;
      const alreadyMarked = existingTimes.some((markerTime) => Math.abs(markerTime - rounded) < 0.05); // i18n-ignore
      if (!alreadyMarked) boundaryTimes.add(Math.max(0, rounded));
    }
  }

  return [...boundaryTimes].sort((a, b) => a - b);
}

export function getTimelineSelectedRangeMarkerTargets(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  markers: TimelineMarkerLike[],
): TimelineMarkerTarget[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return [];

  const rangeStart = roundTimelineTime(Math.min(...selected.map((clip) => clip.startTime)));
  const rangeEnd = roundTimelineTime(Math.max(...selected.map((clip) => clip.endTime)));
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart + 0.001) return [];

  const existingTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite);
  return [
    { time: Math.max(0, rangeStart), label: "In" }, // i18n-ignore - marker rail label.
    { time: Math.max(0, rangeEnd), label: "Out" }, // i18n-ignore - marker rail label.
  ].filter((target) => !existingTimes.some((markerTime) => Math.abs(markerTime - target.time) < 0.05)); // i18n-ignore
}
