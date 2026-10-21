// Nudge, align, trim, gap, slip, slide, roll, and track-move helpers for timeline editing.
import {
  TimelineNudgeClip,
  TimelineNudgeCommit,
  TimelineDuplicateClip,
  TimelineDuplicateInput,
  TimelineInsertGapPlan,
  TimelineNavigationScene,
  TimelineMarkerLike,
  TimelineEditableClip,
  TimelineEditableTrack,
  MIN_CLIP_DURATION_SECONDS,
  roundTimelineTime,
  getTimelineMarkerBracket,
  getTimelineTrimForSegment,
} from "./timeline-editing-shared";
import {
  createClipInput,
  timelineTrackKeyFromParts,
  getEditableTimelineClipIds,
  getEditableTimelineSelectionClipIds,
} from "./timeline-editing-properties";
import {
  timelineSceneBoundaryTimes,
} from "./timeline-editing-navigation";

export function nudgeTimelineClips(
  clips: TimelineNudgeClip[],
  selectedClipIds: Set<string>,
  deltaSeconds: number,
): TimelineNudgeCommit[] {
  if (selectedClipIds.size === 0 || !Number.isFinite(deltaSeconds) || deltaSeconds === 0) return [];

  const selected = clips.filter((clip) => selectedClipIds.has(clip.id));
  if (selected.length === 0) return [];

  const minStart = Math.min(...selected.map((clip) => clip.startTime));
  const effectiveDelta = deltaSeconds < 0 ? Math.max(deltaSeconds, -minStart) : deltaSeconds;

  return selected.map((clip) => {
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const startTime = roundTimelineTime(Math.max(0, clip.startTime + effectiveDelta));
    return {
      clipId: clip.id,
      startTime,
      endTime: roundTimelineTime(startTime + duration),
    };
  });
}

export function getTimelineConstrainedNudgeDelta(
  clips: TimelineEditableClip[],
  selectedClipIds: Set<string>,
  deltaSeconds: number,
): number {
  if (selectedClipIds.size === 0 || !Number.isFinite(deltaSeconds) || deltaSeconds === 0) return 0;

  const selected = clips.filter((clip) => selectedClipIds.has(clip.id));
  if (selected.length === 0) return 0;

  const minStart = Math.min(...selected.map((clip) => clip.startTime));
  let constrainedDelta = deltaSeconds < 0 ? Math.max(deltaSeconds, -minStart) : deltaSeconds;

  for (const clip of selected) {
    if (!clip.trackType || clip.trackIndex == null) continue;

    for (const candidate of clips) {
      if (selectedClipIds.has(candidate.id)) continue;
      if (candidate.trackType !== clip.trackType || candidate.trackIndex !== clip.trackIndex) continue;

      if (constrainedDelta > 0 && candidate.startTime >= clip.endTime - 0.001) {
        constrainedDelta = Math.min(constrainedDelta, Math.max(0, candidate.startTime - clip.endTime));
      } else if (constrainedDelta < 0 && candidate.endTime <= clip.startTime + 0.001) {
        constrainedDelta = Math.max(constrainedDelta, Math.min(0, candidate.endTime - clip.startTime));
      }
    }
  }

  return roundTimelineTime(constrainedDelta);
}

export function getTimelineNudgeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  deltaSeconds: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  const constrainedDelta = getTimelineConstrainedNudgeDelta(clips, editableIds, deltaSeconds);
  return nudgeTimelineClips(clips, editableIds, constrainedDelta);
}

export function getTimelineAlignSelectionTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  edge: "start" | "end",
): TimelineNudgeCommit[] {
  if (!Number.isFinite(playheadTime)) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return [];

  const groupStart = Math.min(...selected.map((clip) => clip.startTime));
  const groupEnd = Math.max(...selected.map((clip) => clip.endTime));
  const requestedDelta = edge === "start"
    ? playheadTime - groupStart
    : playheadTime - groupEnd;
  const effectiveDelta = getTimelineConstrainedNudgeDelta(clips, editableIds, requestedDelta);
  if (Math.abs(effectiveDelta) <= 0.001) return [];

  return selected.map((clip) => {
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const startTime = roundTimelineTime(Math.max(0, clip.startTime + effectiveDelta));
    return {
      clipId: clip.id,
      startTime,
      endTime: roundTimelineTime(startTime + duration),
      ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
      ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
    };
  });
}

export function getTimelineAlignSelectionToNearestMarkerTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  edge: "start" | "end",
): TimelineNudgeCommit[] {
  if (markers.length === 0) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return [];

  const selectedEdgeTime = edge === "start"
    ? Math.min(...selected.map((clip) => clip.startTime))
    : Math.max(...selected.map((clip) => clip.endTime));
  const markerTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite);
  if (markerTimes.length === 0) return [];

  const targetTime = markerTimes.reduce((nearest, time) => {
    const nearestDistance = Math.abs(nearest - selectedEdgeTime);
    const distance = Math.abs(time - selectedEdgeTime);
    return distance < nearestDistance ? time : nearest;
  }, markerTimes[0]);

  return getTimelineAlignSelectionTargetCommits(
    clips,
    tracks,
    selectedClipIds,
    selectedClipId,
    targetTime,
    edge,
  );
}

export function getTimelineTrimSelectionToNearestMarkerTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  edge: "start" | "end",
): TimelineNudgeCommit[] {
  if (markers.length === 0) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return [];

  const selectedEdgeTime = edge === "start"
    ? Math.min(...selected.map((clip) => clip.startTime))
    : Math.max(...selected.map((clip) => clip.endTime));
  const markerTimes = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite);
  if (markerTimes.length === 0) return [];

  const targetTime = markerTimes.reduce((nearest, time) => {
    const nearestDistance = Math.abs(nearest - selectedEdgeTime);
    const distance = Math.abs(time - selectedEdgeTime);
    return distance < nearestDistance ? time : nearest;
  }, markerTimes[0]);

  return getTimelineTrimTargetCommitsToPlayhead(clips, tracks, editableIds, null, targetTime, edge);
}

export function getTimelineTrimSelectionToMarkerRangeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  currentTime: number,
): TimelineNudgeCommit[] {
  const bracket = getTimelineMarkerBracket(markers, currentTime);
  if (!bracket) return [];

  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const rangeStart = roundTimelineTime(bracket.rangeStart);
  const rangeEnd = roundTimelineTime(bracket.rangeEnd);
  if (rangeEnd - rangeStart <= MIN_CLIP_DURATION_SECONDS) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .map((clip) => {
      const segment = {
        startTime: roundTimelineTime(Math.max(clip.startTime, rangeStart)),
        endTime: roundTimelineTime(Math.min(clip.endTime, rangeEnd)),
      };
      if (segment.endTime - segment.startTime < MIN_CLIP_DURATION_SECONDS) return null;
      return {
        clipId: clip.id,
        startTime: segment.startTime,
        endTime: segment.endTime,
        ...getTimelineTrimForSegment(clip, segment),
      };
    })
    .filter((commit): commit is TimelineNudgeCommit => commit !== null)
    .sort((a, b) => (
      a.startTime - b.startTime ||
      (b.endTime - b.startTime) - (a.endTime - a.startTime) ||
      a.clipId.localeCompare(b.clipId)
    ));
}

export function getTimelineTrimSelectionToNearestEditPointTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  scenes: TimelineNavigationScene[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  edge: "start" | "end",
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return [];

  const selectedEdgeTime = edge === "start"
    ? Math.min(...selected.map((clip) => clip.startTime))
    : Math.max(...selected.map((clip) => clip.endTime));

  const boundaries = new Set<number>();
  for (const clip of clips) {
    boundaries.add(roundTimelineTime(Math.max(0, clip.startTime)));
    boundaries.add(roundTimelineTime(Math.max(0, clip.endTime)));
  }
  for (const time of timelineSceneBoundaryTimes(scenes)) {
    boundaries.add(roundTimelineTime(Math.max(0, time)));
  }

  const boundaryTimes = [...boundaries]
    .filter(Number.isFinite)
    .filter((time) => Math.abs(time - selectedEdgeTime) > 0.001);
  if (boundaryTimes.length === 0) return [];

  const targetTime = boundaryTimes.reduce((nearest, time) => {
    const nearestDistance = Math.abs(nearest - selectedEdgeTime);
    const distance = Math.abs(time - selectedEdgeTime);
    return distance < nearestDistance ? time : nearest;
  }, boundaryTimes[0]);

  return getTimelineTrimTargetCommitsToPlayhead(clips, tracks, editableIds, null, targetTime, edge);
}

export function getTimelinePackSelectionTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selectedByTrack = new Map<string, TimelineEditableClip[]>();
  for (const clip of clips) {
    if (!editableIds.has(clip.id) || !clip.trackType || clip.trackIndex == null) continue;
    const key = `${clip.trackType}-${clip.trackIndex}`;
    selectedByTrack.set(key, [...(selectedByTrack.get(key) || []), clip]);
  }

  const commits: TimelineNudgeCommit[] = [];
  for (const trackClips of selectedByTrack.values()) {
    const sorted = trackClips
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
    if (sorted.length < 2) continue;

    let cursor = roundTimelineTime(sorted[0].endTime);
    for (const clip of sorted.slice(1)) {
      const duration = Math.max(0, clip.endTime - clip.startTime);
      let startTime = roundTimelineTime(cursor);
      const blockers = clips
        .filter((candidate) => !editableIds.has(candidate.id))
        .filter((candidate) => candidate.trackType === clip.trackType && candidate.trackIndex === clip.trackIndex)
        .filter((candidate) => candidate.endTime <= clip.startTime + 0.001)
        .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
      for (const candidate of blockers) {
        const targetEnd = roundTimelineTime(startTime + duration);
        if (startTime < candidate.endTime - 0.001 && targetEnd > candidate.startTime + 0.001) {
          startTime = roundTimelineTime(candidate.endTime);
        }
      }
      if (Math.abs(startTime - clip.startTime) > 0.001) {
        commits.push({
          clipId: clip.id,
          startTime,
          endTime: roundTimelineTime(startTime + duration),
          ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
          ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
        });
      }
      cursor = roundTimelineTime(startTime + duration);
    }
  }

  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineCloseActiveTrackGapsTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const anchorIds = new Set<string>();
  for (const id of selectedClipIds) anchorIds.add(id);
  if (anchorIds.size === 0 && selectedClipId) anchorIds.add(selectedClipId);
  if (anchorIds.size === 0) return [];

  const editableAnchorIds = getEditableTimelineClipIds(clips, tracks, anchorIds);
  const anchor = clips
    .filter((clip) => editableAnchorIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];
  if (!anchor?.trackType || anchor.trackIndex == null) return [];

  const allTrackClips = clips
    .filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (allTrackClips.length < 2) return [];
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));

  const commits: TimelineNudgeCommit[] = [];
  let cursor = roundTimelineTime(allTrackClips[0].endTime);
  for (const clip of allTrackClips.slice(1)) {
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const startTime = roundTimelineTime(cursor);
    if (editableIds.has(clip.id) && Math.abs(startTime - clip.startTime) > 0.001) {
      commits.push({
        clipId: clip.id,
        startTime,
        endTime: roundTimelineTime(startTime + duration),
        ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
        ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
      });
    }
    cursor = roundTimelineTime((editableIds.has(clip.id) ? startTime : clip.startTime) + duration);
  }

  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineCloseAllTrackGapsTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const clipsByTrack = new Map<string, TimelineEditableClip[]>();

  for (const clip of clips) {
    if (!clip.trackType || clip.trackIndex == null) continue;
    const key = `${clip.trackType}-${clip.trackIndex}`;
    clipsByTrack.set(key, [...(clipsByTrack.get(key) || []), clip]);
  }

  const commits: TimelineNudgeCommit[] = [];
  for (const trackClips of clipsByTrack.values()) {
    const sorted = trackClips
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
    if (sorted.length < 2) continue;

    let cursor = roundTimelineTime(sorted[0].endTime);
    for (const clip of sorted.slice(1)) {
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const startTime = roundTimelineTime(cursor);
      if (editableIds.has(clip.id) && Math.abs(startTime - clip.startTime) > 0.001) {
        commits.push({
          clipId: clip.id,
          startTime,
          endTime: roundTimelineTime(startTime + duration),
          ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
          ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
        });
      }
      cursor = roundTimelineTime((editableIds.has(clip.id) ? startTime : clip.startTime) + duration);
    }
  }

  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineDeleteGapTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
): TimelineNudgeCommit[] {
  if (!Number.isFinite(playheadTime)) return [];

  const anchorIds = new Set<string>();
  for (const id of selectedClipIds) anchorIds.add(id);
  if (anchorIds.size === 0 && selectedClipId) anchorIds.add(selectedClipId);
  if (anchorIds.size === 0) return [];

  const editableAnchorIds = getEditableTimelineClipIds(clips, tracks, anchorIds);
  const anchor = clips
    .filter((clip) => editableAnchorIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];
  if (!anchor?.trackType || anchor.trackIndex == null) return [];

  const trackClips = clips
    .filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  const anchorPosition = trackClips.findIndex((clip) => clip.id === anchor.id);
  if (anchorPosition <= 0) return [];
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));

  const previous = trackClips[anchorPosition - 1];
  const gapStart = roundTimelineTime(previous.endTime);
  const gapEnd = roundTimelineTime(anchor.startTime);
  const time = roundTimelineTime(playheadTime);
  const gapSize = roundTimelineTime(gapEnd - gapStart);
  if (gapSize <= 0.001 || time < gapStart - 0.001 || time > gapEnd + 0.001) return [];

  const commits: TimelineNudgeCommit[] = [];
  let cursor = gapStart;
  for (const clip of trackClips.slice(anchorPosition)) {
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const shiftedStartTime = roundTimelineTime(Math.max(0, clip.startTime - gapSize));
    const startTime = roundTimelineTime(editableIds.has(clip.id) ? Math.max(shiftedStartTime, cursor) : clip.startTime);
    if (editableIds.has(clip.id) && Math.abs(startTime - clip.startTime) > 0.001) {
      commits.push({
        clipId: clip.id,
        startTime,
        endTime: roundTimelineTime(startTime + duration),
        ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
        ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
      });
    }
    cursor = roundTimelineTime(startTime + duration);
  }

  return commits;
}

export function getTimelineDeleteGlobalGapTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  playheadTime: number,
): TimelineNudgeCommit[] {
  if (!Number.isFinite(playheadTime)) return [];
  const time = roundTimelineTime(playheadTime);
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const tracksByKey = new Map(tracks.map((track) => [`${track.type}-${track.index}`, track]));
  const occupiedClips = clips
    .filter((clip) => clip.trackType && clip.trackIndex != null)
    .filter((clip) => {
      const track = tracksByKey.get(`${clip.trackType}-${clip.trackIndex}`);
      return !track?.locked && track?.visible !== false;
    });

  if (occupiedClips.some((clip) => time >= clip.startTime - 0.001 && time <= clip.endTime + 0.001)) {
    return [];
  }

  const previousEnd = occupiedClips
    .filter((clip) => clip.endTime <= time + 0.001)
    .reduce((latest, clip) => Math.max(latest, clip.endTime), 0);
  const nextStart = occupiedClips
    .filter((clip) => clip.startTime >= time - 0.001)
    .reduce((earliest, clip) => Math.min(earliest, clip.startTime), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(nextStart)) return [];

  const gapSize = roundTimelineTime(nextStart - previousEnd);
  if (gapSize <= 0.001 || time < previousEnd - 0.001 || time > nextStart + 0.001) return [];

  const clipsByTrack = new Map<string, TimelineEditableClip[]>();
  for (const clip of clips) {
    if (!clip.trackType || clip.trackIndex == null || clip.startTime < nextStart - 0.001) continue;
    const key = `${clip.trackType}-${clip.trackIndex}`;
    clipsByTrack.set(key, [...(clipsByTrack.get(key) || []), clip]);
  }

  const commits: TimelineNudgeCommit[] = [];
  for (const trackClips of clipsByTrack.values()) {
    const sorted = trackClips
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
    let cursor = 0;
    for (const clip of sorted) {
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const shiftedStartTime = roundTimelineTime(Math.max(0, clip.startTime - gapSize));
      const startTime = roundTimelineTime(editableIds.has(clip.id) ? Math.max(shiftedStartTime, cursor) : clip.startTime);
      if (editableIds.has(clip.id) && Math.abs(startTime - clip.startTime) > 0.001) {
        commits.push({
          clipId: clip.id,
          startTime,
          endTime: roundTimelineTime(startTime + duration),
          ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
          ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
        });
      }
      cursor = roundTimelineTime(startTime + duration);
    }
  }

  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineDeleteAllTrackGapsAtPlayheadTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  playheadTime: number,
): TimelineNudgeCommit[] {
  if (!Number.isFinite(playheadTime)) return [];
  const time = roundTimelineTime(playheadTime);
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const clipsByTrack = new Map<string, TimelineEditableClip[]>();

  for (const clip of clips) {
    if (!clip.trackType || clip.trackIndex == null) continue;
    const key = `${clip.trackType}-${clip.trackIndex}`;
    clipsByTrack.set(key, [...(clipsByTrack.get(key) || []), clip]);
  }

  const commits: Array<TimelineNudgeCommit & { originalStartTime: number }> = [];
  for (const trackClips of clipsByTrack.values()) {
    const sorted = trackClips
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
    if (sorted.length === 0) continue;
    if (sorted.some((clip) => time >= clip.startTime - 0.001 && time <= clip.endTime + 0.001)) continue;

    const nextIndex = sorted.findIndex((clip) => clip.startTime >= time - 0.001);
    if (nextIndex < 0) continue;
    const previousEnd = nextIndex > 0 ? sorted[nextIndex - 1].endTime : 0;
    const nextStart = sorted[nextIndex].startTime;
    const gapSize = roundTimelineTime(nextStart - previousEnd);
    if (gapSize <= 0.001 || time < previousEnd - 0.001 || time > nextStart + 0.001) continue;
    if (!editableIds.has(sorted[nextIndex].id)) continue;

    for (const clip of sorted.slice(nextIndex)) {
      if (!editableIds.has(clip.id)) break;
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const startTime = roundTimelineTime(Math.max(0, clip.startTime - gapSize));
      commits.push({
        clipId: clip.id,
        startTime,
        endTime: roundTimelineTime(startTime + duration),
        originalStartTime: clip.startTime,
        ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
        ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
      });
    }
  }

  return commits
    .sort((a, b) => a.originalStartTime - b.originalStartTime || a.clipId.localeCompare(b.clipId))
    .map((commit) => ({
      clipId: commit.clipId,
      startTime: commit.startTime,
      endTime: commit.endTime,
      ...(typeof commit.trimStart === "number" ? { trimStart: commit.trimStart } : {}),
      ...(typeof commit.trimEnd === "number" ? { trimEnd: commit.trimEnd } : {}),
    }));
}

export function getTimelineDeleteMarkerRangeGapTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineNudgeCommit[] {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return [];

  const rangeStart = roundTimelineTime(bracket.rangeStart);
  const rangeEnd = roundTimelineTime(bracket.rangeEnd);
  const gapSize = roundTimelineTime(rangeEnd - rangeStart);
  if (gapSize <= 0.001) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const tracksByKey = new Map(tracks.map((track) => [`${track.type}-${track.index}`, track]));
  const occupiedClips = clips
    .filter((clip) => clip.trackType && clip.trackIndex != null)
    .filter((clip) => {
      const track = tracksByKey.get(`${clip.trackType}-${clip.trackIndex}`);
      return !track?.locked && track?.visible !== false;
    });

  const hasContentInRange = occupiedClips.some((clip) => (
    clip.startTime < rangeEnd - 0.001 && clip.endTime > rangeStart + 0.001
  ));
  if (hasContentInRange) return [];

  const clipsByTrack = new Map<string, TimelineEditableClip[]>();
  for (const clip of clips) {
    if (!clip.trackType || clip.trackIndex == null || clip.startTime < rangeEnd - 0.001) continue;
    const key = `${clip.trackType}-${clip.trackIndex}`;
    clipsByTrack.set(key, [...(clipsByTrack.get(key) || []), clip]);
  }

  const commits: TimelineNudgeCommit[] = [];
  for (const trackClips of clipsByTrack.values()) {
    const sorted = trackClips
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
    let cursor = 0;
    for (const clip of sorted) {
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const shiftedStartTime = roundTimelineTime(Math.max(0, clip.startTime - gapSize));
      const startTime = roundTimelineTime(editableIds.has(clip.id) ? Math.max(shiftedStartTime, cursor) : clip.startTime);
      if (editableIds.has(clip.id) && Math.abs(startTime - clip.startTime) > 0.001) {
        commits.push({
          clipId: clip.id,
          startTime,
          endTime: roundTimelineTime(startTime + duration),
          ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
          ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
        });
      }
      cursor = roundTimelineTime(startTime + duration);
    }
  }

  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineDeleteMarkerOutGapTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineNudgeCommit[] {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return [];

  const gapStart = roundTimelineTime(bracket.rangeEnd);
  const gapSize = roundTimelineTime(bracket.rangeEnd - bracket.rangeStart);
  const gapEnd = roundTimelineTime(gapStart + gapSize);
  if (gapSize <= 0.001) return [];

  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const tracksByKey = new Map(tracks.map((track) => [`${track.type}-${track.index}`, track]));
  const occupiedClips = clips
    .filter((clip) => clip.trackType && clip.trackIndex != null)
    .filter((clip) => {
      const track = tracksByKey.get(`${clip.trackType}-${clip.trackIndex}`);
      return !track?.locked && track?.visible !== false;
    });

  const hasContentInGap = occupiedClips.some((clip) => (
    clip.startTime < gapEnd - 0.001 && clip.endTime > gapStart + 0.001
  ));
  if (hasContentInGap) return [];

  const clipsByTrack = new Map<string, TimelineEditableClip[]>();
  for (const clip of clips) {
    if (!clip.trackType || clip.trackIndex == null || clip.startTime < gapEnd - 0.001) continue;
    const key = `${clip.trackType}-${clip.trackIndex}`;
    clipsByTrack.set(key, [...(clipsByTrack.get(key) || []), clip]);
  }

  const commits: TimelineNudgeCommit[] = [];
  for (const trackClips of clipsByTrack.values()) {
    const sorted = trackClips
      .slice()
      .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
    let cursor = 0;
    for (const clip of sorted) {
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const shiftedStartTime = roundTimelineTime(Math.max(0, clip.startTime - gapSize));
      const startTime = roundTimelineTime(editableIds.has(clip.id) ? Math.max(shiftedStartTime, cursor) : clip.startTime);
      if (editableIds.has(clip.id) && Math.abs(startTime - clip.startTime) > 0.001) {
        commits.push({
          clipId: clip.id,
          startTime,
          endTime: roundTimelineTime(startTime + duration),
          ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
          ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
        });
      }
      cursor = roundTimelineTime(startTime + duration);
    }
  }

  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineInsertGapTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  gapDuration: number,
): TimelineNudgeCommit[] {
  return getTimelineInsertGapPlan(
    clips as unknown as TimelineDuplicateClip[],
    tracks,
    selectedClipIds,
    selectedClipId,
    playheadTime,
    gapDuration,
  ).commits;
}

export function getTimelineInsertGapPlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  gapDuration: number,
): TimelineInsertGapPlan {
  if (!Number.isFinite(playheadTime) || !Number.isFinite(gapDuration) || gapDuration <= 0) {
    return { commits: [], creates: [] };
  }

  const anchorIds = new Set<string>();
  for (const id of selectedClipIds) anchorIds.add(id);
  if (anchorIds.size === 0 && selectedClipId) anchorIds.add(selectedClipId);
  if (anchorIds.size === 0) return { commits: [], creates: [] };

  const editableAnchorIds = getEditableTimelineClipIds(clips, tracks, anchorIds);
  const anchor = clips
    .filter((clip) => editableAnchorIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];
  if (!anchor?.trackType || anchor.trackIndex == null) return { commits: [], creates: [] };

  const time = roundTimelineTime(Math.max(0, playheadTime));
  const duration = roundTimelineTime(gapDuration);
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const protectedTrackClips = clips
    .filter((clip) => !editableIds.has(clip.id))
    .filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex);
  const commits: TimelineNudgeCommit[] = [];
  const creates: TimelineDuplicateInput[] = [];
  const crossesProtectedClip = (fromStart: number, fromEnd: number, toStart: number, toEnd: number) => {
    const sweepStart = Math.min(fromStart, toStart);
    const sweepEnd = Math.max(fromEnd, toEnd);
    return protectedTrackClips.some((clip) => (
      sweepStart < clip.endTime - 0.001 && sweepEnd > clip.startTime + 0.001
    ));
  };

  for (const clip of clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))) {
    if (clip.startTime >= time - 0.001) {
      const clipDuration = Math.max(0, clip.endTime - clip.startTime);
      const startTime = roundTimelineTime(clip.startTime + duration);
      const endTime = roundTimelineTime(startTime + clipDuration);
      if (crossesProtectedClip(clip.startTime, clip.endTime, startTime, endTime)) {
        return { commits: [], creates: [] };
      }
      commits.push({
        clipId: clip.id,
        startTime,
        endTime,
        ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
        ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
      });
      continue;
    }

    if (time <= clip.startTime + MIN_CLIP_DURATION_SECONDS || time >= clip.endTime - MIN_CLIP_DURATION_SECONDS) {
      continue;
    }

    const leftSegment = { startTime: roundTimelineTime(clip.startTime), endTime: time };
    const rightSegment = { startTime: time, endTime: roundTimelineTime(clip.endTime) };
    commits.push({
      clipId: clip.id,
      startTime: leftSegment.startTime,
      endTime: leftSegment.endTime,
      ...getTimelineTrimForSegment(clip, leftSegment),
    });
    const createdStartTime = roundTimelineTime(rightSegment.startTime + duration);
    const createdEndTime = roundTimelineTime(rightSegment.endTime + duration);
    if (crossesProtectedClip(rightSegment.startTime, rightSegment.endTime, createdStartTime, createdEndTime)) {
      return { commits: [], creates: [] };
    }
    creates.push({
      ...createClipInput(clip),
      startTime: createdStartTime,
      endTime: createdEndTime,
      ...getTimelineTrimForSegment(clip, rightSegment),
    });
  }

  return {
    commits: commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId)),
    creates: creates.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime),
  };
}

export function getTimelineInsertGlobalGapTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  playheadTime: number,
  gapDuration: number,
): TimelineNudgeCommit[] {
  return getTimelineInsertGlobalGapPlan(
    clips as unknown as TimelineDuplicateClip[],
    tracks,
    playheadTime,
    gapDuration,
  ).commits;
}

export function getTimelineInsertGlobalGapPlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  playheadTime: number,
  gapDuration: number,
): TimelineInsertGapPlan {
  if (!Number.isFinite(playheadTime) || !Number.isFinite(gapDuration) || gapDuration <= 0) {
    return { commits: [], creates: [] };
  }

  const time = roundTimelineTime(Math.max(0, playheadTime));
  const duration = roundTimelineTime(gapDuration);
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const protectedClipsByTrack = new Map<string, TimelineDuplicateClip[]>();
  for (const clip of clips) {
    if (editableIds.has(clip.id) || !clip.trackType || clip.trackIndex == null) continue;
    const key = `${clip.trackType}-${clip.trackIndex}`;
    protectedClipsByTrack.set(key, [...(protectedClipsByTrack.get(key) || []), clip]);
  }
  const commits: TimelineNudgeCommit[] = [];
  const creates: TimelineDuplicateInput[] = [];
  const crossesProtectedClip = (clip: TimelineDuplicateClip, toStart: number, toEnd: number) => {
    if (!clip.trackType || clip.trackIndex == null) return false;
    const protectedClips = protectedClipsByTrack.get(`${clip.trackType}-${clip.trackIndex}`) || [];
    const sweepStart = Math.min(clip.startTime, toStart);
    const sweepEnd = Math.max(clip.endTime, toEnd);
    return protectedClips.some((protectedClip) => (
      sweepStart < protectedClip.endTime - 0.001 && sweepEnd > protectedClip.startTime + 0.001
    ));
  };

  for (const clip of clips) {
    if (!editableIds.has(clip.id)) continue;

    if (clip.startTime >= time - 0.001) {
      const clipDuration = Math.max(0, clip.endTime - clip.startTime);
      const startTime = roundTimelineTime(clip.startTime + duration);
      const endTime = roundTimelineTime(startTime + clipDuration);
      if (crossesProtectedClip(clip, startTime, endTime)) {
        return { commits: [], creates: [] };
      }
      commits.push({
        clipId: clip.id,
        startTime,
        endTime,
        ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
        ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
      });
      continue;
    }

    if (time <= clip.startTime + MIN_CLIP_DURATION_SECONDS || time >= clip.endTime - MIN_CLIP_DURATION_SECONDS) {
      continue;
    }

    const leftSegment = { startTime: roundTimelineTime(clip.startTime), endTime: time };
    const rightSegment = { startTime: time, endTime: roundTimelineTime(clip.endTime) };
    commits.push({
      clipId: clip.id,
      startTime: leftSegment.startTime,
      endTime: leftSegment.endTime,
      ...getTimelineTrimForSegment(clip, leftSegment),
    });
    const createdStartTime = roundTimelineTime(rightSegment.startTime + duration);
    const createdEndTime = roundTimelineTime(rightSegment.endTime + duration);
    if (crossesProtectedClip(clip, createdStartTime, createdEndTime)) {
      return { commits: [], creates: [] };
    }
    creates.push({
      ...createClipInput(clip),
      startTime: createdStartTime,
      endTime: createdEndTime,
      ...getTimelineTrimForSegment(clip, rightSegment),
    });
  }

  return {
    commits: commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId)),
    creates: creates.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime),
  };
}

export function getTimelineInsertMarkerRangeGapPlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineInsertGapPlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { commits: [], creates: [] };

  return getTimelineInsertGlobalGapPlan(
    clips,
    tracks,
    bracket.rangeStart,
    roundTimelineTime(bracket.rangeEnd - bracket.rangeStart),
  );
}

export function getTimelineInsertMarkerOutGapPlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineInsertGapPlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { commits: [], creates: [] };

  return getTimelineInsertGlobalGapPlan(
    clips,
    tracks,
    bracket.rangeEnd,
    roundTimelineTime(bracket.rangeEnd - bracket.rangeStart),
  );
}

export function withTimelineTrimShift(
  clip: TimelineEditableClip,
  nextStartTime: number,
  nextEndTime: number,
): TimelineNudgeCommit {
  const startDelta = roundTimelineTime(nextStartTime - clip.startTime);
  const endDelta = roundTimelineTime(nextEndTime - clip.endTime);
  const trimStart = typeof clip.trimStart === "number" ? clip.trimStart : null;
  const trimEnd = typeof clip.trimEnd === "number" ? clip.trimEnd : null;
  return {
    clipId: clip.id,
    startTime: roundTimelineTime(nextStartTime),
    endTime: roundTimelineTime(nextEndTime),
    ...(trimStart == null ? {} : { trimStart: roundTimelineTime(Math.max(0, trimStart + startDelta)) }),
    ...(trimEnd == null ? {} : { trimEnd: roundTimelineTime(Math.max(0, trimEnd + endDelta)) }),
  };
}

export function getTimelineSlideTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  deltaSeconds: number,
): TimelineNudgeCommit[] {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length !== 1) return [];
  const clip = selected[0];
  if (!clip.trackType || clip.trackIndex == null) return [];

  const editableAllIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((item) => item.id)));
  const sameTrackClips = clips
    .filter((item) => item.trackType === clip.trackType && item.trackIndex === clip.trackIndex)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  const position = sameTrackClips.findIndex((item) => item.id === clip.id);
  if (position < 0) return [];

  const previous = sameTrackClips[position - 1] ?? null;
  const next = sameTrackClips[position + 1] ?? null;
  if (!previous && !next) return [];
  if ((previous && !editableAllIds.has(previous.id)) || (next && !editableAllIds.has(next.id))) return [];

  // Clamp against each NEIGHBOR's own opposite edge (not the selected clip's):
  // with a gap between the clips, clamping via the selected clip's edge is too
  // loose and reshapes the neighbor into a negative-duration window.
  const minDelta = previous
    ? previous.startTime + MIN_CLIP_DURATION_SECONDS - previous.endTime
    : Number.NEGATIVE_INFINITY;
  const maxDelta = next
    ? next.endTime - MIN_CLIP_DURATION_SECONDS - next.startTime
    : Number.POSITIVE_INFINITY;
  const effectiveDelta = roundTimelineTime(Math.max(minDelta, Math.min(maxDelta, deltaSeconds)));
  if (Math.abs(effectiveDelta) <= 0.001) return [];

  const commits: TimelineNudgeCommit[] = [];
  if (previous) {
    commits.push(withTimelineTrimShift(previous, previous.startTime, previous.endTime + effectiveDelta));
  }
  commits.push({
    clipId: clip.id,
    startTime: roundTimelineTime(clip.startTime + effectiveDelta),
    endTime: roundTimelineTime(clip.endTime + effectiveDelta),
    ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
    ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
  });
  if (next) {
    commits.push(withTimelineTrimShift(next, next.startTime + effectiveDelta, next.endTime));
  }
  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineRollTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  edge: "start" | "end",
  deltaSeconds: number,
): TimelineNudgeCommit[] {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length !== 1) return [];
  const clip = selected[0];
  if (!clip.trackType || clip.trackIndex == null) return [];

  const editableAllIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((item) => item.id)));
  const sameTrackClips = clips
    .filter((item) => item.trackType === clip.trackType && item.trackIndex === clip.trackIndex)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  const position = sameTrackClips.findIndex((item) => item.id === clip.id);
  if (position < 0) return [];

  if (edge === "start") {
    const previous = sameTrackClips[position - 1] ?? null;
    if (!previous || !editableAllIds.has(previous.id)) return [];
    // The previous clip's END moves by delta, so its minimum length must be
    // clamped against its own edges — using the selected clip's start is only
    // equivalent when the clips are flush, and inverts the neighbor otherwise.
    const minDelta = previous.startTime + MIN_CLIP_DURATION_SECONDS - previous.endTime;
    const maxDelta = clip.endTime - MIN_CLIP_DURATION_SECONDS - clip.startTime;
    const effectiveDelta = roundTimelineTime(Math.max(minDelta, Math.min(maxDelta, deltaSeconds)));
    if (Math.abs(effectiveDelta) <= 0.001) return [];
    return [
      withTimelineTrimShift(previous, previous.startTime, previous.endTime + effectiveDelta),
      withTimelineTrimShift(clip, clip.startTime + effectiveDelta, clip.endTime),
    ].sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
  }

  const next = sameTrackClips[position + 1] ?? null;
  if (!next || !editableAllIds.has(next.id)) return [];
  // The next clip's START moves by delta — clamp its minimum length against
  // its own edges (see the start-edge comment above).
  const minDelta = clip.startTime + MIN_CLIP_DURATION_SECONDS - clip.endTime;
  const maxDelta = next.endTime - MIN_CLIP_DURATION_SECONDS - next.startTime;
  const effectiveDelta = roundTimelineTime(Math.max(minDelta, Math.min(maxDelta, deltaSeconds)));
  if (Math.abs(effectiveDelta) <= 0.001) return [];
  return [
    withTimelineTrimShift(clip, clip.startTime, clip.endTime + effectiveDelta),
    withTimelineTrimShift(next, next.startTime + effectiveDelta, next.endTime),
  ].sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineRollShortcut(event: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): { edge: "start" | "end"; deltaSeconds: number } | null {
  if (!event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  if (event.key === "ArrowLeft") return { edge: "start", deltaSeconds: -1 / 30 };
  if (event.key === "ArrowRight") return { edge: "end", deltaSeconds: 1 / 30 };
  return null;
}

export function moveTimelineClipWindow(clip: TimelineEditableClip, startTime: number): TimelineNudgeCommit {
  const duration = Math.max(0, clip.endTime - clip.startTime);
  return {
    clipId: clip.id,
    startTime: roundTimelineTime(startTime),
    endTime: roundTimelineTime(startTime + duration),
    ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
    ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
  };
}

export function getTimelineSwapAdjacentTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  direction: -1 | 1,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length !== 1) return [];
  const clip = selected[0];
  if (!clip.trackType || clip.trackIndex == null) return [];

  const editableAllIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((item) => item.id)));
  const sameTrackClips = clips
    .filter((item) => item.trackType === clip.trackType && item.trackIndex === clip.trackIndex)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  const position = sameTrackClips.findIndex((item) => item.id === clip.id);
  if (position < 0) return [];

  const neighbor = direction > 0 ? sameTrackClips[position + 1] : sameTrackClips[position - 1];
  if (!neighbor || !editableAllIds.has(neighbor.id)) return [];

  const clipDuration = Math.max(0, clip.endTime - clip.startTime);
  const neighborDuration = Math.max(0, neighbor.endTime - neighbor.startTime);
  if (direction > 0) {
    const gap = roundTimelineTime(Math.max(0, neighbor.startTime - clip.endTime));
    return [
      moveTimelineClipWindow(neighbor, clip.startTime),
      moveTimelineClipWindow(clip, clip.startTime + neighborDuration + gap),
    ].sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
  }

  const gap = roundTimelineTime(Math.max(0, clip.startTime - neighbor.endTime));
  return [
    moveTimelineClipWindow(clip, neighbor.startTime),
    moveTimelineClipWindow(neighbor, neighbor.startTime + clipDuration + gap),
  ].sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function slipTimelineClips(
  clips: TimelineNudgeClip[],
  selectedClipIds: Set<string>,
  deltaSeconds: number,
): TimelineNudgeCommit[] {
  if (selectedClipIds.size === 0 || !Number.isFinite(deltaSeconds) || deltaSeconds === 0) return [];

  const selected = clips
    .filter((clip) => selectedClipIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return [];

  const trimStartFor = (clip: TimelineNudgeClip) => (
    typeof clip.trimStart === "number" && Number.isFinite(clip.trimStart) ? clip.trimStart : 0
  );
  const effectiveDelta = deltaSeconds < 0
    ? Math.max(deltaSeconds, -Math.min(...selected.map(trimStartFor)))
    : deltaSeconds;
  if (effectiveDelta === 0) return [];

  return selected.map((clip) => {
    const baseTrimStart = trimStartFor(clip);
    const baseTrimEnd = typeof clip.trimEnd === "number" && Number.isFinite(clip.trimEnd)
      ? clip.trimEnd
      : baseTrimStart + Math.max(0, clip.endTime - clip.startTime);
    return {
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      trimStart: roundTimelineTime(Math.max(0, baseTrimStart + effectiveDelta)),
      trimEnd: roundTimelineTime(Math.max(0, baseTrimEnd + effectiveDelta)),
    };
  });
}

export function getTimelineSlipTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  deltaSeconds: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  return slipTimelineClips(clips, editableIds, deltaSeconds);
}

export function getTimelineTrackMoveTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  direction: -1 | 1,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const tracksByType = new Map<string, TimelineEditableTrack[]>();
  for (const track of tracks.filter((track) => !track.locked && track.visible !== false)) {
    tracksByType.set(track.type, [...(tracksByType.get(track.type) || []), track]);
  }
  for (const [type, typeTracks] of tracksByType) {
    tracksByType.set(type, typeTracks.sort((a, b) => a.index - b.index));
  }
  const hasDestinationOverlap = (clip: TimelineEditableClip, target: TimelineEditableTrack) => (
    clips.some((candidate) => {
      if (editableIds.has(candidate.id)) return false;
      if (candidate.trackType !== target.type || candidate.trackIndex !== target.index) return false;
      return clip.startTime < candidate.endTime - 0.001 && clip.endTime > candidate.startTime + 0.001;
    })
  );

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .map((clip): TimelineNudgeCommit | null => {
      if (!clip.trackType || clip.trackIndex == null) return null;
      const currentIndex = clip.trackIndex;
      const typeTracks = tracksByType.get(clip.trackType) || [];
      const currentPosition = typeTracks.findIndex((track) => track.index === currentIndex);
      if (currentPosition < 0) return null;
      const target = direction > 0
        ? typeTracks.find((track) => track.index > currentIndex)
        : [...typeTracks].reverse().find((track) => track.index < currentIndex);
      if (!target) return null;
      if (hasDestinationOverlap(clip, target)) return null;
      return {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: roundTimelineTime(clip.endTime),
        trackType: target.type,
        trackIndex: target.index,
      };
    })
    .filter((commit): commit is TimelineNudgeCommit => Boolean(commit))
    .sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineTrackMoveExtremeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  direction: -1 | 1,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const tracksByType = new Map<string, TimelineEditableTrack[]>();
  for (const track of tracks.filter((track) => !track.locked && track.visible !== false)) {
    tracksByType.set(track.type, [...(tracksByType.get(track.type) || []), track]);
  }
  for (const [type, typeTracks] of tracksByType) {
    tracksByType.set(type, typeTracks.sort((a, b) => a.index - b.index));
  }
  const hasDestinationOverlap = (clip: TimelineEditableClip, target: TimelineEditableTrack) => (
    clips.some((candidate) => {
      if (editableIds.has(candidate.id)) return false;
      if (candidate.trackType !== target.type || candidate.trackIndex !== target.index) return false;
      return clip.startTime < candidate.endTime - 0.001 && clip.endTime > candidate.startTime + 0.001;
    })
  );

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .map((clip): TimelineNudgeCommit | null => {
      if (!clip.trackType || clip.trackIndex == null) return null;
      const typeTracks = tracksByType.get(clip.trackType) || [];
      const currentPosition = typeTracks.findIndex((track) => track.index === clip.trackIndex);
      if (currentPosition < 0) return null;
      const target = direction > 0 ? typeTracks[typeTracks.length - 1] : typeTracks[0];
      if (!target || target.index === clip.trackIndex) return null;
      if (hasDestinationOverlap(clip, target)) return null;
      return {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: roundTimelineTime(clip.endTime),
        trackType: target.type,
        trackIndex: target.index,
      };
    })
    .filter((commit): commit is TimelineNudgeCommit => Boolean(commit))
    .sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function shouldCanvasHandleTimelineDelete(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  if (event.key !== "Delete" && event.key !== "Backspace") return false;
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function trimTimelineClipToPlayhead(
  clips: TimelineNudgeClip[],
  clipId: string | null,
  playheadTime: number,
  edge: "start" | "end",
): TimelineNudgeCommit | null {
  if (!clipId || !Number.isFinite(playheadTime)) return null;

  const clip = clips.find((item) => item.id === clipId);
  if (!clip) return null;

  const time = roundTimelineTime(playheadTime);
  const trimStart = typeof clip.trimStart === "number" ? clip.trimStart : null;
  const trimEnd = typeof clip.trimEnd === "number" ? clip.trimEnd : null;
  if (edge === "start") {
    if (Math.abs(time - clip.startTime) <= 0.001) return null;
    if (time >= clip.endTime - MIN_CLIP_DURATION_SECONDS) return null;
    const extension = Math.max(0, clip.startTime - time);
    return {
      clipId: clip.id,
      startTime: time,
      endTime: roundTimelineTime(clip.endTime),
      ...(trimStart == null ? {} : { trimStart: roundTimelineTime(Math.max(0, trimStart - extension)) }),
      ...(trimEnd == null ? {} : { trimEnd }),
    };
  }

  if (Math.abs(time - clip.endTime) <= 0.001) return null;
  if (time <= clip.startTime + MIN_CLIP_DURATION_SECONDS) return null;
  const extension = Math.max(0, time - clip.endTime);
  return {
    clipId: clip.id,
    startTime: roundTimelineTime(clip.startTime),
    endTime: time,
    ...(trimStart == null ? {} : { trimStart }),
    ...(trimEnd == null ? {} : { trimEnd: roundTimelineTime(trimEnd + extension) }),
  };
}

export function getTimelineTrimCommitsToPlayhead(
  clips: TimelineNudgeClip[],
  selectedClipIds: Set<string>,
  playheadTime: number,
  edge: "start" | "end",
): TimelineNudgeCommit[] {
  if (selectedClipIds.size === 0) return [];
  return clips
    .filter((clip) => selectedClipIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => trimTimelineClipToPlayhead(clips, clip.id, playheadTime, edge))
    .filter((commit): commit is TimelineNudgeCommit => Boolean(commit));
}

export function getTimelineTrimTargetCommitsToPlayhead(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  edge: "start" | "end",
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0 || !Number.isFinite(playheadTime)) return [];

  const protectedClipsByTrack = new Map<string, TimelineEditableClip[]>();
  for (const clip of clips) {
    if (editableIds.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex) ?? `${clip.trackType || ""}-${clip.trackIndex || 0}`;
    protectedClipsByTrack.set(trackKey, [...(protectedClipsByTrack.get(trackKey) || []), clip]);
  }

  const targetTimeForClip = (clip: TimelineEditableClip): number => {
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex) ?? `${clip.trackType || ""}-${clip.trackIndex || 0}`;
    const protectedClips = protectedClipsByTrack.get(trackKey) || [];
    let targetTime = roundTimelineTime(playheadTime);
    if (edge === "start" && targetTime < clip.startTime) {
      for (const protectedClip of protectedClips) {
        if (targetTime < protectedClip.endTime - 0.001 && clip.startTime > protectedClip.startTime + 0.001) {
          targetTime = Math.max(targetTime, protectedClip.endTime);
        }
      }
    } else if (edge === "end" && targetTime > clip.endTime) {
      for (const protectedClip of protectedClips) {
        if (targetTime > protectedClip.startTime + 0.001 && clip.endTime < protectedClip.endTime - 0.001) {
          targetTime = Math.min(targetTime, protectedClip.startTime);
        }
      }
    }
    return roundTimelineTime(targetTime);
  };

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => trimTimelineClipToPlayhead(clips, clip.id, targetTimeForClip(clip), edge))
    .filter((commit): commit is TimelineNudgeCommit => Boolean(commit));
}

export function getTimelineRippleTrimTargetCommitsToPlayhead(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  edge: "start" | "end",
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0 || !Number.isFinite(playheadTime)) return [];

  const time = roundTimelineTime(playheadTime);
  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => time > clip.startTime + MIN_CLIP_DURATION_SECONDS && time < clip.endTime - MIN_CLIP_DURATION_SECONDS)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return [];

  const commitsById = new Map<string, TimelineNudgeCommit>();
  const shiftsByTrack = new Map<string, { from: number; shift: number }[]>();

  for (const clip of selected) {
    const removed = edge === "start"
      ? roundTimelineTime(time - clip.startTime)
      : roundTimelineTime(clip.endTime - time);
    if (removed <= 0) continue;

    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex) ?? `${clip.trackType || ""}-${clip.trackIndex || 0}`;
    shiftsByTrack.set(trackKey, [
      ...(shiftsByTrack.get(trackKey) || []),
      { from: clip.endTime, shift: removed },
    ]);

    const trimStart = typeof clip.trimStart === "number" ? clip.trimStart : null;
    const trimEnd = typeof clip.trimEnd === "number" ? clip.trimEnd : null;
    if (edge === "start") {
      commitsById.set(clip.id, {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: roundTimelineTime(clip.endTime - removed),
        trimStart: trimStart == null ? roundTimelineTime(removed) : roundTimelineTime(trimStart + removed),
        trimEnd,
      });
    } else {
      commitsById.set(clip.id, {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: time,
        ...(trimStart == null ? {} : { trimStart }),
        ...(trimEnd == null ? {} : { trimEnd: roundTimelineTime(trimEnd - removed) }),
      });
    }
  }

  const editableAllIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const protectedClipsByTrack = new Map<string, TimelineEditableClip[]>();
  for (const clip of clips) {
    if (editableAllIds.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex) ?? `${clip.trackType || ""}-${clip.trackIndex || 0}`;
    protectedClipsByTrack.set(trackKey, [...(protectedClipsByTrack.get(trackKey) || []), clip]);
  }
  const crossesProtectedClip = (
    clip: TimelineEditableClip,
    toStart: number,
    toEnd: number,
  ): boolean => {
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex) ?? `${clip.trackType || ""}-${clip.trackIndex || 0}`;
    const sweepStart = Math.min(clip.startTime, toStart);
    const sweepEnd = Math.max(clip.endTime, toEnd);
    return (protectedClipsByTrack.get(trackKey) || []).some((protectedClip) => (
      sweepStart < protectedClip.endTime - 0.001 && sweepEnd > protectedClip.startTime + 0.001
    ));
  };
  for (const clip of clips) {
    if (!editableAllIds.has(clip.id) || commitsById.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex) ?? `${clip.trackType || ""}-${clip.trackIndex || 0}`;
    const shifts = shiftsByTrack.get(trackKey);
    if (!shifts?.length) continue;
    const shift = shifts.reduce((total, item) => clip.startTime >= item.from - 0.001 ? total + item.shift : total, 0);
    if (shift <= 0) continue;
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const startTime = roundTimelineTime(Math.max(0, clip.startTime - shift));
    const endTime = roundTimelineTime(startTime + duration);
    if (crossesProtectedClip(clip, startTime, endTime)) continue;
    commitsById.set(clip.id, {
      clipId: clip.id,
      startTime,
      endTime,
      ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
      ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
    });
  }

  return [...commitsById.values()]
    .map((commit) => Object.fromEntries(
      Object.entries(commit).filter(([, value]) => value !== null),
    ) as TimelineNudgeCommit)
    .sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}
