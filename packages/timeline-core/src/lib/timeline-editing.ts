// Reusable calculations for timeline editing interactions.
export * from "./timeline-editing-shared";
export * from "./timeline-editing-properties";
export * from "./timeline-editing-navigation";
export * from "./timeline-editing-operations";
export * from "./timeline-text-style";
import {
  TimelineNudgeClip,
  TimelineNudgeCommit,
  TimelineDuplicateClip,
  TimelineDuplicateInput,
  TimelineClipboardClip,
  TimelineClipboard,
  TimelineCutResult,
  TimelineRippleDeleteResult,
  TimelineExtractToClipboardResult,
  TimelineInsertPastePlan,
  TimelineOverwritePastePlan,
  TimelineDetachAudioPlan,
  TimelineMarkerLike,
  TimelineEditableClip,
  TimelineEditableTrack,
  MIN_CLIP_DURATION_SECONDS,
  roundTimelineTime,
  getTimelineMarkerBracket,
  getTimelineTrimForSegment,
  getTimelineRemainingSegments,
} from "./timeline-editing-shared";
import {
  createClipInput,
  timelineTrackKeyFromParts,
  getEditableTimelineClipIds,
  getEditableTimelineSelectionClipIds,
} from "./timeline-editing-properties";
import {
  getTimelineRangeSelectionClipIds,
} from "./timeline-editing-navigation";

export function getTimelineLiftMarkerRangePlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineRippleDeleteResult | null {
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

  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const deleteIds: string[] = [];
  const commits: TimelineNudgeCommit[] = [];
  const creates: TimelineDuplicateInput[] = [];
  const interval = { startTime: rangeStart, endTime: rangeEnd };

  for (const clip of clips) {
    if (!editableIds.has(clip.id)) continue;
    if (clip.endTime <= rangeStart + 0.001 || clip.startTime >= rangeEnd - 0.001) continue;

    const remainingSegments = getTimelineRemainingSegments(clip, [interval]);
    if (remainingSegments.length === 0) {
      deleteIds.push(clip.id);
      continue;
    }

    const [firstSegment, ...extraSegments] = remainingSegments;
    const changed = (
      Math.abs(firstSegment.startTime - clip.startTime) > 0.001 ||
      Math.abs(firstSegment.endTime - clip.endTime) > 0.001
    );
    if (changed) {
      commits.push({
        clipId: clip.id,
        startTime: firstSegment.startTime,
        endTime: firstSegment.endTime,
        ...getTimelineTrimForSegment(clip, firstSegment),
      });
    }

    for (const segment of extraSegments) {
      creates.push({
        ...createClipInput(clip),
        startTime: segment.startTime,
        endTime: segment.endTime,
        ...getTimelineTrimForSegment(clip, segment),
      });
    }
  }

  if (deleteIds.length === 0 && commits.length === 0 && creates.length === 0) return null;
  const result: TimelineRippleDeleteResult = {
    deleteIds,
    commits: commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId)),
  };
  if (creates.length > 0) {
    result.creates = creates.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  }
  return result;
}

export function getTimelineExtractMarkerRangePlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineRippleDeleteResult | null {
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

  const lift = getTimelineLiftMarkerRangePlan(clips, tracks, markers, playheadTime);
  if (!lift) return null;

  const shift = roundTimelineTime(rangeEnd - rangeStart);
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const protectedClipsByTrack = new Map<string, TimelineDuplicateClip[]>();
  for (const clip of clips) {
    if (editableIds.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
    if (!trackKey) continue;
    protectedClipsByTrack.set(trackKey, [...(protectedClipsByTrack.get(trackKey) || []), clip]);
  }
  const crossesProtectedClip = (clipId: string, fromStart: number, fromEnd: number, toStart: number, toEnd: number) => {
    const clip = clipsById.get(clipId);
    const trackKey = timelineTrackKeyFromParts(clip?.trackType, clip?.trackIndex);
    if (!trackKey) return false;
    const sweepStart = Math.min(fromStart, toStart);
    const sweepEnd = Math.max(fromEnd, toEnd);
    return (protectedClipsByTrack.get(trackKey) || []).some((protectedClip) => (
      sweepStart < protectedClip.endTime - 0.001 && sweepEnd > protectedClip.startTime + 0.001
    ));
  };
  const deletedIds = new Set(lift.deleteIds);
  const createKeys = new Set(
    (lift.creates ?? []).map((input) => `${input.startTime}:${input.endTime}:${String(input.trackType || "")}:${Number(input.trackIndex || 0)}`),
  );
  const commitsById = new Map<string, TimelineNudgeCommit>();

  for (const commit of lift.commits) {
    const startsAfterRange = commit.startTime >= rangeEnd - 0.001;
    const startTime = startsAfterRange ? roundTimelineTime(Math.max(0, commit.startTime - shift)) : commit.startTime;
    const endTime = startsAfterRange ? roundTimelineTime(Math.max(0, commit.endTime - shift)) : commit.endTime;
    if (startsAfterRange && crossesProtectedClip(commit.clipId, commit.startTime, commit.endTime, startTime, endTime)) {
      continue;
    }
    commitsById.set(commit.clipId, {
      ...commit,
      startTime,
      endTime,
    });
  }

  const creates = (lift.creates ?? []).map((input) => (
    input.startTime >= rangeEnd - 0.001
      ? {
        ...input,
        startTime: roundTimelineTime(Math.max(0, input.startTime - shift)),
        endTime: roundTimelineTime(Math.max(0, input.endTime - shift)),
      }
      : input
  ));

  for (const clip of clips) {
    if (!editableIds.has(clip.id) || deletedIds.has(clip.id) || commitsById.has(clip.id)) continue;
    if (clip.startTime < rangeEnd - 0.001) continue;
    const key = `${clip.startTime}:${clip.endTime}:${String(clip.trackType || "")}:${Number(clip.trackIndex || 0)}`;
    if (createKeys.has(key)) continue;
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const startTime = roundTimelineTime(Math.max(0, clip.startTime - shift));
    const endTime = roundTimelineTime(startTime + duration);
    if (crossesProtectedClip(clip.id, clip.startTime, clip.endTime, startTime, endTime)) continue;
    commitsById.set(clip.id, {
      clipId: clip.id,
      startTime,
      endTime,
    });
  }

  return {
    deleteIds: lift.deleteIds,
    commits: [...commitsById.values()].sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId)),
    ...(creates.length > 0
      ? { creates: creates.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime) }
      : {}),
  };
}

export function getTimelineLiftMarkerRangeToClipboardPlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineExtractToClipboardResult | null {
  const clipboard = copyTimelineMarkerRange(clips, tracks, markers, playheadTime);
  const lift = getTimelineLiftMarkerRangePlan(clips, tracks, markers, playheadTime);
  if (!clipboard || !lift) return null;

  return {
    clipboard,
    deleteIds: lift.deleteIds,
    commits: lift.commits,
    ...(lift.creates ? { creates: lift.creates } : {}),
  };
}

export function getTimelineExtractMarkerRangeToClipboardPlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineExtractToClipboardResult | null {
  const clipboard = copyTimelineMarkerRange(clips, tracks, markers, playheadTime);
  const extract = getTimelineExtractMarkerRangePlan(clips, tracks, markers, playheadTime);
  if (!clipboard || !extract) return null;

  return {
    clipboard,
    deleteIds: extract.deleteIds,
    commits: extract.commits,
    ...(extract.creates ? { creates: extract.creates } : {}),
  };
}

export function copyTimelineMarkerRange(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineClipboard | null {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return null;
  const { rangeStart, rangeEnd } = bracket;

  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const copied = clips
    .map((clip, index): (TimelineClipboardClip & { sourceIndex: number }) | null => {
      if (!editableIds.has(clip.id)) return null;
      const segmentStart = roundTimelineTime(Math.max(clip.startTime, rangeStart));
      const segmentEnd = roundTimelineTime(Math.min(clip.endTime, rangeEnd));
      if (segmentEnd <= segmentStart + MIN_CLIP_DURATION_SECONDS) return null;

      const segment = { startTime: segmentStart, endTime: segmentEnd };
      return {
        sourceIndex: index,
        offsetStart: roundTimelineTime(segmentStart - rangeStart),
        duration: roundTimelineTime(segmentEnd - segmentStart),
        input: {
          ...createClipInput(clip),
          startTime: segmentStart,
          endTime: segmentEnd,
          ...getTimelineTrimForSegment(clip, segment),
        },
      };
    })
    .filter((clip): clip is TimelineClipboardClip & { sourceIndex: number } => Boolean(clip))
    .sort((a, b) => (
      a.offsetStart - b.offsetStart ||
      a.sourceIndex - b.sourceIndex
    ))
    .map((clip) => ({
      offsetStart: clip.offsetStart,
      duration: clip.duration,
      input: clip.input,
    }));

  if (copied.length === 0) return null;
  return {
    groupDuration: roundTimelineTime(rangeEnd - rangeStart),
    clips: copied,
  };
}

export function duplicateTimelineMarkerRange(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  markers: TimelineMarkerLike[],
  playheadTime: number,
): TimelineDuplicateInput[] {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return [];

  const inputs = pasteTimelineClips(
    copyTimelineMarkerRange(clips, tracks, markers, playheadTime),
    bracket.rangeEnd,
  );
  return getEditableTimelinePasteInputs(inputs, tracks, clips);
}

export function getTimelineInsertDuplicateMarkerRangePlan({
  clips,
  tracks,
  markers,
  playheadTime,
}: {
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  markers: TimelineMarkerLike[];
  playheadTime: number;
}): TimelineInsertPastePlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { inputs: [], commits: [] };

  return getTimelineInsertPastePlan({
    clipboard: copyTimelineMarkerRange(clips, tracks, markers, playheadTime),
    clips,
    tracks,
    startTime: bracket.rangeEnd,
  });
}

export function getTimelineOverwriteDuplicateMarkerRangePlan({
  clips,
  tracks,
  markers,
  playheadTime,
}: {
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  markers: TimelineMarkerLike[];
  playheadTime: number;
}): TimelineOverwritePastePlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { inputs: [], deleteIds: [], commits: [] };

  return getTimelineOverwritePastePlan({
    clipboard: copyTimelineMarkerRange(clips, tracks, markers, playheadTime),
    clips,
    tracks,
    startTime: bracket.rangeEnd,
  });
}

export function getTimelineReplaceMarkerRangePastePlan({
  clipboard,
  clips,
  tracks,
  markers,
  playheadTime,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  markers: TimelineMarkerLike[];
  playheadTime: number;
}): TimelineOverwritePastePlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket || !clipboard || clipboard.clips.length === 0) {
    return { inputs: [], deleteIds: [], commits: [] };
  }

  const replaceClipboard: TimelineClipboard = {
    groupDuration: roundTimelineTime(bracket.rangeEnd - bracket.rangeStart),
    clips: clipboard.clips.map((clip) => ({
      ...clip,
      duration: clip.duration,
    })),
  };
  const trackKeys = new Set(
    getEditableTimelinePasteInputs(pasteTimelineClips(clipboard, bracket.rangeStart), tracks)
      .map((input) => timelineTrackKeyFromParts(input.trackType, input.trackIndex))
      .filter((key): key is string => Boolean(key)),
  );
  if (trackKeys.size === 0) return { inputs: [], deleteIds: [], commits: [] };

  const rangeFillers: TimelineClipboardClip[] = [...trackKeys].map((trackKey, index) => {
    const [trackType, trackIndexText] = trackKey.split("-");
    return {
      offsetStart: 0,
      duration: replaceClipboard.groupDuration,
      input: {
        trackType,
        trackIndex: Number(trackIndexText),
        startTime: bracket.rangeStart,
        endTime: bracket.rangeEnd,
        __timelineReplaceMarkerRangeFiller: index,
      },
    };
  });
  const plan = getTimelineOverwritePastePlan({
    clipboard: {
      groupDuration: replaceClipboard.groupDuration,
      clips: [...replaceClipboard.clips, ...rangeFillers],
    },
    clips,
    tracks,
    startTime: bracket.rangeStart,
  });

  return {
    ...plan,
    inputs: plan.inputs.filter((input) => !Object.prototype.hasOwnProperty.call(input, "__timelineReplaceMarkerRangeFiller")),
  };
}

export function getTimelineInsertMarkerRangePastePlan({
  clipboard,
  clips,
  tracks,
  markers,
  playheadTime,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  markers: TimelineMarkerLike[];
  playheadTime: number;
}): TimelineInsertPastePlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { inputs: [], commits: [] };

  return getTimelineInsertPastePlan({
    clipboard,
    clips,
    tracks,
    startTime: bracket.rangeStart,
  });
}

export function getTimelineInsertMarkerOutPastePlan({
  clipboard,
  clips,
  tracks,
  markers,
  playheadTime,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  markers: TimelineMarkerLike[];
  playheadTime: number;
}): TimelineInsertPastePlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { inputs: [], commits: [] };

  return getTimelineInsertPastePlan({
    clipboard,
    clips,
    tracks,
    startTime: bracket.rangeEnd,
  });
}

export function getTimelineOverwriteMarkerRangePastePlan({
  clipboard,
  clips,
  tracks,
  markers,
  playheadTime,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  markers: TimelineMarkerLike[];
  playheadTime: number;
}): TimelineOverwritePastePlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { inputs: [], deleteIds: [], commits: [] };

  return getTimelineOverwritePastePlan({
    clipboard,
    clips,
    tracks,
    startTime: bracket.rangeStart,
  });
}

export function getTimelineOverwriteMarkerOutPastePlan({
  clipboard,
  clips,
  tracks,
  markers,
  playheadTime,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  markers: TimelineMarkerLike[];
  playheadTime: number;
}): TimelineOverwritePastePlan {
  const bracket = getTimelineMarkerBracket(markers, playheadTime);
  if (!bracket) return { inputs: [], deleteIds: [], commits: [] };

  return getTimelineOverwritePastePlan({
    clipboard,
    clips,
    tracks,
    startTime: bracket.rangeEnd,
  });
}

export function getTimelineTrackSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): Set<string> {
  const anchorIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (anchorIds.size === 0) return new Set();
  const anchor = clips
    .filter((clip) => anchorIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];
  if (!anchor?.trackType || anchor.trackIndex == null) return new Set();

  const candidates = clips
    .filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getTimelineTrackSelectionShortcut(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return (
    (event.key === "a" || event.key === "A") &&
    event.shiftKey &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

export function getTimelineTrackRangeSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  direction: -1 | 1,
): Set<string> {
  if (!Number.isFinite(playheadTime)) return new Set();
  const time = roundTimelineTime(playheadTime);
  const anchorIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  const anchor = clips
    .filter((clip) => anchorIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];

  if (!anchor?.trackType || anchor.trackIndex == null) {
    return getTimelineRangeSelectionClipIds(clips, tracks, playheadTime, direction);
  }

  const candidates = clips
    .filter((clip) => clip.trackType === anchor.trackType && clip.trackIndex === anchor.trackIndex)
    .filter((clip) => direction < 0 ? clip.startTime < time : clip.endTime > time)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getTimelineSelectionToPlayheadClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
): Set<string> {
  if (!Number.isFinite(playheadTime)) return new Set();
  const editableSelection = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableSelection.size === 0) return new Set();

  const selected = clips.filter((clip) => editableSelection.has(clip.id));
  if (selected.length === 0) return new Set();

  const time = roundTimelineTime(playheadTime);
  const selectedStart = Math.min(...selected.map((clip) => clip.startTime));
  const selectedEnd = Math.max(...selected.map((clip) => clip.endTime));
  const start = Math.min(time, selectedStart);
  const end = Math.max(time, selectedEnd);
  const candidates = clips
    .filter((clip) => clip.startTime <= end && clip.endTime >= start)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getTimelineLinkedSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): Set<string> {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return editableIds;

  const selectedSceneIds = new Set(
    clips
      .filter((clip) => editableIds.has(clip.id) && typeof clip.sceneId === "string" && clip.sceneId.length > 0)
      .map((clip) => clip.sceneId as string),
  );
  if (selectedSceneIds.size === 0) return editableIds;

  const allEditableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  return new Set(
    clips
      .filter((clip) => (
        allEditableIds.has(clip.id) &&
        typeof clip.sceneId === "string" &&
        selectedSceneIds.has(clip.sceneId)
      ))
      .map((clip) => clip.id),
  );
}

export function getTimelineTypeSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): Set<string> {
  const anchorIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (anchorIds.size === 0) return new Set();

  const selectedTypes = new Set(
    clips
      .filter((clip) => anchorIds.has(clip.id) && typeof clip.trackType === "string" && clip.trackType.length > 0)
      .map((clip) => clip.trackType as string),
  );
  if (selectedTypes.size === 0) return new Set();

  const candidates = clips
    .filter((clip) => typeof clip.trackType === "string" && selectedTypes.has(clip.trackType))
    .sort((a, b) => a.trackType?.localeCompare(b.trackType || "") || a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  return getEditableTimelineClipIds(
    candidates,
    tracks,
    new Set(candidates.map((clip) => clip.id)),
  );
}

export function getAdjacentTimelineClipSelectionId(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  direction: -1 | 1,
): string | null {
  const editableIds = getEditableTimelineClipIds(
    clips,
    tracks,
    new Set(clips.map((clip) => clip.id)),
  );
  const editableClips = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (editableClips.length === 0) return null;

  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  const selected = editableClips.filter((clip) => activeIds.has(clip.id));
  const anchor = selected.length > 0
    ? (direction > 0
      ? Math.max(...selected.map((clip) => clip.endTime))
      : Math.min(...selected.map((clip) => clip.startTime)))
    : roundTimelineTime(Number.isFinite(playheadTime) ? playheadTime : 0);

  if (direction > 0) {
    return editableClips.find((clip) => clip.startTime > anchor + 0.001)?.id ?? editableClips[editableClips.length - 1].id;
  }

  return [...editableClips].reverse().find((clip) => clip.endTime < anchor - 0.001)?.id ?? editableClips[0].id;
}

export function getAdjacentTimelineTrackClipSelectionId(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  direction: -1 | 1,
): string | null {
  const activeIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);

  const anchorClip = clips
    .filter((clip) => activeIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))[0];

  if (!anchorClip?.trackType || anchorClip.trackIndex == null) {
    return getAdjacentTimelineClipSelectionId(clips, tracks, selectedClipIds, selectedClipId, playheadTime, direction);
  }

  const trackClips = clips.filter((clip) => clip.trackType === anchorClip.trackType && clip.trackIndex === anchorClip.trackIndex);
  return getAdjacentTimelineClipSelectionId(trackClips, tracks, selectedClipIds, selectedClipId, playheadTime, direction);
}

export function duplicateTimelineClips(
  clips: TimelineDuplicateClip[],
  selectedClipIds: Set<string>,
  tracks?: TimelineEditableTrack[],
): TimelineDuplicateInput[] {
  if (selectedClipIds.size === 0) return [];
  const targetIds = tracks
    ? getEditableTimelineClipIds(clips, tracks, selectedClipIds)
    : new Set(
      clips
        .filter((clip) => selectedClipIds.has(clip.id) && !clip.locked)
        .map((clip) => clip.id),
    );

  const selected = clips
    .filter((clip) => targetIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return [];

  const groupStart = Math.min(...selected.map((clip) => clip.startTime));
  const groupEnd = Math.max(...selected.map((clip) => clip.endTime));
  const offset = groupEnd - groupStart;

  const inputs: TimelineDuplicateInput[] = selected.map((clip) => {
    const rest = createClipInput(clip);
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const startTime = roundTimelineTime(clip.startTime + offset);
    return {
      ...rest,
      startTime,
      endTime: roundTimelineTime(startTime + duration),
    };
  });

  const protectedContextClips = clips.filter((clip) => !selectedClipIds.has(clip.id));
  return tracks ? getEditableTimelinePasteInputs(inputs, tracks, protectedContextClips) : inputs.filter((input) => {
    const trackKey = timelineTrackKeyFromParts(input.trackType, input.trackIndex);
    return !trackKey || !clips.some((clip) => (
      !targetIds.has(clip.id) &&
      clip.locked &&
      timelineTrackKeyFromParts(clip.trackType, clip.trackIndex) === trackKey &&
      input.startTime < clip.endTime - 0.001 &&
      input.endTime > clip.startTime + 0.001
    ));
  });
}

export function getTimelineInsertDuplicatePlan({
  clips,
  tracks,
  selectedClipIds,
  selectedClipId,
}: {
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  selectedClipIds: Set<string>;
  selectedClipId: string | null | undefined;
}): TimelineInsertPastePlan {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return { inputs: [], commits: [] };

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return { inputs: [], commits: [] };

  const clipboard = copyTimelineClips(clips, editableIds);
  if (!clipboard) return { inputs: [], commits: [] };
  const insertTime = Math.max(...selected.map((clip) => clip.endTime));
  return getTimelineInsertPastePlan({
    clipboard,
    clips,
    tracks,
    startTime: insertTime,
  });
}

export function getTimelineDetachAudioPlan(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineDetachAudioPlan {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return { creates: [], updates: [] };

  const selectedVideos = clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" && typeof clip.mediaUrl === "string" && clip.mediaUrl.length > 0)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selectedVideos.length === 0) return { creates: [], updates: [] };

  const allEditableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const hasProtectedAudioOverlap = (trackIndex: number, video: TimelineDuplicateClip) => (
    clips.some((clip) => {
      if (clip.trackType !== "audio" || clip.trackIndex !== trackIndex) return false;
      if (allEditableIds.has(clip.id)) return false;
      return video.startTime < clip.endTime - 0.001 && video.endTime > clip.startTime + 0.001;
    })
  );

  const audioTrackCandidates = tracks
    .filter((track) => track.type === "audio" && !track.locked && track.visible !== false)
    .sort((a, b) => {
      const aPrimaryPenalty = a.index <= 1 ? 1 : 0;
      const bPrimaryPenalty = b.index <= 1 ? 1 : 0;
      return aPrimaryPenalty - bPrimaryPenalty || a.index - b.index;
    });
  const audioTrack = audioTrackCandidates.find((track) => (
    selectedVideos.some((video) => !hasProtectedAudioOverlap(track.index, video))
  ));
  if (!audioTrack) return { creates: [], updates: [] };
  const detachableVideos = selectedVideos.filter((video) => !hasProtectedAudioOverlap(audioTrack.index, video));

  return {
    creates: detachableVideos.map((clip) => ({
      trackType: "audio",
      trackIndex: audioTrack.index,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      mediaUrl: clip.mediaUrl,
      mediaType: "audio",
      label: `${typeof clip.label === "string" && clip.label.length > 0 ? clip.label : "Detached"} audio`,
      volume: typeof clip.volume === "number" ? clip.volume : 1,
      ...(typeof clip.trimStart === "number" ? { trimStart: clip.trimStart } : {}),
      ...(typeof clip.trimEnd === "number" ? { trimEnd: clip.trimEnd } : {}),
    })),
    updates: detachableVideos.map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      volume: 0,
    })),
  };
}

/**
 * Build the create input for separating a generated scene's locked voiceover
 * into an independent audio clip. The clip references the scene's audio URL and
 * spans the voiceover's on-timeline range (scene start + drag offset, for the
 * scene's duration). Callers pair this with removing the scene's voiceover
 * binding so the audio isn't doubled.
 */
export function getSeparateVoiceoverAudioInput(params: {
  audioUrl: string;
  startTime: number;
  duration: number;
  label?: string | null;
  audioTrackIndex?: number;
}): TimelineDuplicateInput {
  const start = roundTimelineTime(Math.max(0, params.startTime));
  const end = roundTimelineTime(Math.max(0, params.startTime) + Math.max(0.1, params.duration));
  const trimmedLabel = typeof params.label === "string" ? params.label.trim() : "";
  return {
    trackType: "audio",
    trackIndex: params.audioTrackIndex ?? 1,
    startTime: start,
    endTime: end,
    mediaUrl: params.audioUrl,
    mediaType: "audio",
    label: trimmedLabel.length > 0 ? trimmedLabel : "Voiceover",
    volume: 1,
  };
}

export function copyTimelineClips(
  clips: TimelineDuplicateClip[],
  selectedClipIds: Set<string>,
  tracks?: TimelineEditableTrack[],
): TimelineClipboard | null {
  if (selectedClipIds.size === 0) return null;
  const targetIds = tracks
    ? getEditableTimelineClipIds(clips, tracks, selectedClipIds)
    : new Set(
      clips
        .filter((clip) => selectedClipIds.has(clip.id) && !clip.locked)
        .map((clip) => clip.id),
    );

  const selected = clips
    .filter((clip) => targetIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return null;

  const groupStart = Math.min(...selected.map((clip) => clip.startTime));
  const groupEnd = Math.max(...selected.map((clip) => clip.endTime));
  return {
    groupDuration: roundTimelineTime(groupEnd - groupStart),
    clips: selected.map((clip) => ({
      offsetStart: roundTimelineTime(clip.startTime - groupStart),
      duration: roundTimelineTime(Math.max(0, clip.endTime - clip.startTime)),
      input: createClipInput(clip),
    })),
  };
}

export function pasteTimelineClips(
  clipboard: TimelineClipboard | null,
  startTime: number,
): TimelineDuplicateInput[] {
  if (!clipboard || clipboard.clips.length === 0 || !Number.isFinite(startTime)) return [];

  const pasteStart = Math.max(0, startTime);
  return clipboard.clips.map((clip) => {
    const clipStart = roundTimelineTime(pasteStart + clip.offsetStart);
    return {
      ...clip.input,
      startTime: clipStart,
      endTime: roundTimelineTime(clipStart + clip.duration),
    };
  });
}

export function getEditableTimelinePasteInputs(
  inputs: TimelineDuplicateInput[],
  tracks: TimelineEditableTrack[],
  clips?: TimelineDuplicateClip[],
): TimelineDuplicateInput[] {
  const tracksByKey = new Map(tracks.map((track) => [`${track.type}-${track.index}`, track]));
  const editableIds = clips
    ? getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)))
    : null;
  const protectedClipsByTrack = new Map<string, TimelineDuplicateClip[]>();
  if (clips && editableIds) {
    for (const clip of clips) {
      if (editableIds.has(clip.id)) continue;
      const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
      if (!trackKey) continue;
      protectedClipsByTrack.set(trackKey, [...(protectedClipsByTrack.get(trackKey) || []), clip]);
    }
  }

  return inputs.filter((input) => {
    const trackType = typeof input.trackType === "string" ? input.trackType : null;
    const trackIndex = typeof input.trackIndex === "number" ? input.trackIndex : null;
    if (!trackType || trackIndex == null) return true;
    const track = tracksByKey.get(`${trackType}-${trackIndex}`);
    if (track?.locked || track?.visible === false) return false;
    const trackKey = timelineTrackKeyFromParts(trackType, trackIndex);
    if (!trackKey) return true;
    return !(protectedClipsByTrack.get(trackKey) || []).some((clip) => (
      input.startTime < clip.endTime - 0.001 && input.endTime > clip.startTime + 0.001
    ));
  });
}

export function getTimelineInsertPastePlan({
  clipboard,
  clips,
  tracks,
  startTime,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  startTime: number;
}): TimelineInsertPastePlan {
  const inputs = getEditableTimelinePasteInputs(pasteTimelineClips(clipboard, startTime), tracks, clips);
  if (!clipboard || inputs.length === 0) return { inputs, commits: [] };

  const insertedTrackKeys = new Set(
    inputs
      .map((input) => {
        const trackType = typeof input.trackType === "string" ? input.trackType : null;
        const trackIndex = typeof input.trackIndex === "number" ? input.trackIndex : null;
        return trackType && trackIndex != null ? `${trackType}-${trackIndex}` : null;
      })
      .filter((key): key is string => Boolean(key)),
  );
  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const shift = Math.max(0, clipboard.groupDuration);
  const preservedInputs: TimelineDuplicateInput[] = [];
  const protectedClipsByTrack = new Map<string, TimelineDuplicateClip[]>();
  for (const clip of clips) {
    if (editableIds.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
    if (!trackKey || !insertedTrackKeys.has(trackKey)) continue;
    protectedClipsByTrack.set(trackKey, [...(protectedClipsByTrack.get(trackKey) || []), clip]);
  }
  const crossesProtectedClip = (trackKey: string | null, fromStart: number, fromEnd: number, toStart: number, toEnd: number) => (
    Boolean(trackKey && (protectedClipsByTrack.get(trackKey) || []).some((clip) => {
      const sweepStart = Math.min(fromStart, toStart);
      const sweepEnd = Math.max(fromEnd, toEnd);
      return sweepStart < clip.endTime - 0.001 && sweepEnd > clip.startTime + 0.001;
    }))
  );
  const blockedTrackKeys = new Set<string>();
  const commits = clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => {
      if (!clip.trackType || clip.trackIndex == null) return insertedTrackKeys.size === 0;
      return insertedTrackKeys.has(`${clip.trackType}-${clip.trackIndex}`);
    })
    .map((clip): TimelineNudgeCommit | null => {
      const overlapsPastePoint = clip.startTime < startTime - 0.001 && clip.endTime > startTime + MIN_CLIP_DURATION_SECONDS;
      // Split only when BOTH resulting segments meet the minimum duration —
      // a paste point within MIN of the clip's head shifts the whole clip
      // instead of leaving a sub-minimum left sliver behind.
      if (overlapsPastePoint && startTime - clip.startTime >= MIN_CLIP_DURATION_SECONDS) {
        const leftSegment = { startTime: roundTimelineTime(clip.startTime), endTime: roundTimelineTime(startTime) };
        const rightSegment = { startTime: roundTimelineTime(startTime), endTime: roundTimelineTime(clip.endTime) };
        const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
        const nextRightStart = roundTimelineTime(rightSegment.startTime + shift);
        const nextRightEnd = roundTimelineTime(rightSegment.endTime + shift);
        if (crossesProtectedClip(trackKey, rightSegment.startTime, rightSegment.endTime, nextRightStart, nextRightEnd)) {
          if (trackKey) blockedTrackKeys.add(trackKey);
          return null;
        }
        preservedInputs.push({
          ...createClipInput(clip),
          startTime: nextRightStart,
          endTime: nextRightEnd,
          ...getTimelineTrimForSegment(clip, rightSegment),
        });
        return {
          clipId: clip.id,
          startTime: leftSegment.startTime,
          endTime: leftSegment.endTime,
          ...getTimelineTrimForSegment(clip, leftSegment),
        };
      }
      if (clip.startTime < startTime - 0.001 && !overlapsPastePoint) return null;
      const duration = Math.max(0, clip.endTime - clip.startTime);
      const nextStart = roundTimelineTime(clip.startTime + shift);
      const nextEnd = roundTimelineTime(nextStart + duration);
      const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
      if (crossesProtectedClip(trackKey, clip.startTime, clip.endTime, nextStart, nextEnd)) {
        if (trackKey) blockedTrackKeys.add(trackKey);
        return null;
      }
      return {
        clipId: clip.id,
        startTime: nextStart,
        endTime: nextEnd,
      };
    })
    .filter((commit): commit is TimelineNudgeCommit => Boolean(commit))
    .filter((commit) => {
      const clip = clips.find((candidate) => candidate.id === commit.clipId);
      const trackKey = timelineTrackKeyFromParts(clip?.trackType, clip?.trackIndex);
      return !trackKey || !blockedTrackKeys.has(trackKey);
    })
    .sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
  const allowedInputs = inputs.filter((input) => {
    const trackKey = timelineTrackKeyFromParts(input.trackType, input.trackIndex);
    return !trackKey || !blockedTrackKeys.has(trackKey);
  });
  const allowedPreservedInputs = preservedInputs.filter((input) => {
    const trackKey = timelineTrackKeyFromParts(input.trackType, input.trackIndex);
    return !trackKey || !blockedTrackKeys.has(trackKey);
  });
  if (allowedInputs.length === 0) return { inputs: [], commits: [] };

  return {
    inputs: [...allowedInputs, ...allowedPreservedInputs.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)],
    commits,
  };
}

function mergeTimelineIntervals(
  intervals: { startTime: number; endTime: number }[],
): { startTime: number; endTime: number }[] {
  const sorted = intervals
    .filter((interval) => interval.endTime > interval.startTime + 0.001)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  const merged: { startTime: number; endTime: number }[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startTime <= last.endTime + 0.001) {
      last.endTime = roundTimelineTime(Math.max(last.endTime, interval.endTime));
      continue;
    }
    merged.push({ startTime: roundTimelineTime(interval.startTime), endTime: roundTimelineTime(interval.endTime) });
  }

  return merged;
}

export function getTimelineOverwritePastePlan({
  clipboard,
  clips,
  tracks,
  startTime,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  startTime: number;
}): TimelineOverwritePastePlan {
  const pastedInputs = getEditableTimelinePasteInputs(pasteTimelineClips(clipboard, startTime), tracks, clips);
  if (!clipboard || pastedInputs.length === 0) return { inputs: pastedInputs, deleteIds: [], commits: [] };

  const intervalsByTrack = new Map<string, { startTime: number; endTime: number }[]>();
  for (const input of pastedInputs) {
    const trackKey = timelineTrackKeyFromParts(input.trackType, input.trackIndex);
    if (!trackKey) continue;
    intervalsByTrack.set(trackKey, [
      ...(intervalsByTrack.get(trackKey) || []),
      { startTime: input.startTime, endTime: input.endTime },
    ]);
  }
  for (const [trackKey, intervals] of intervalsByTrack) {
    intervalsByTrack.set(trackKey, mergeTimelineIntervals(intervals));
  }

  const editableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const protectedClipsByTrack = new Map<string, TimelineDuplicateClip[]>();
  for (const clip of clips) {
    if (editableIds.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
    if (!trackKey || !intervalsByTrack.has(trackKey)) continue;
    protectedClipsByTrack.set(trackKey, [...(protectedClipsByTrack.get(trackKey) || []), clip]);
  }
  const deleteIds: string[] = [];
  const commits: TimelineNudgeCommit[] = [];
  const preservedInputs: TimelineDuplicateInput[] = [];
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const blockedTrackKeys = new Set<string>();

  for (const clip of clips) {
    if (!editableIds.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
    const intervals = trackKey ? intervalsByTrack.get(trackKey) : null;
    if (!intervals?.length) continue;

    const remainingSegments = getTimelineRemainingSegments(clip, intervals);
    if (remainingSegments.length === 1) {
      const [segment] = remainingSegments;
      if (
        Math.abs(segment.startTime - clip.startTime) <= 0.001 &&
        Math.abs(segment.endTime - clip.endTime) <= 0.001
      ) {
        continue;
      }
    }

    if (remainingSegments.length === 0) {
      deleteIds.push(clip.id);
      continue;
    }

    const [firstSegment, ...extraSegments] = remainingSegments;
    commits.push({
      clipId: clip.id,
      startTime: firstSegment.startTime,
      endTime: firstSegment.endTime,
      ...getTimelineTrimForSegment(clip, firstSegment),
    });

    for (const segment of extraSegments) {
      if (trackKey && (protectedClipsByTrack.get(trackKey) || []).some((protectedClip) => (
        segment.startTime < protectedClip.endTime - 0.001 && segment.endTime > protectedClip.startTime + 0.001
      ))) {
        blockedTrackKeys.add(trackKey);
        break;
      }
      preservedInputs.push({
        ...createClipInput(clip),
        startTime: segment.startTime,
        endTime: segment.endTime,
        ...getTimelineTrimForSegment(clip, segment),
      });
    }
  }

  const isAllowedTrackKey = (trackKey: string | null) => !trackKey || !blockedTrackKeys.has(trackKey);
  const allowedInputs = pastedInputs.filter((input) => (
    isAllowedTrackKey(timelineTrackKeyFromParts(input.trackType, input.trackIndex))
  ));
  const allowedPreservedInputs = preservedInputs.filter((input) => (
    isAllowedTrackKey(timelineTrackKeyFromParts(input.trackType, input.trackIndex))
  ));
  if (allowedInputs.length === 0) return { inputs: [], deleteIds: [], commits: [] };

  return {
    inputs: [...allowedInputs, ...allowedPreservedInputs],
    deleteIds: deleteIds
      .filter((clipId) => {
        const clip = clipsById.get(clipId);
        return isAllowedTrackKey(timelineTrackKeyFromParts(clip?.trackType, clip?.trackIndex));
      })
      .sort((a, b) => a.localeCompare(b)),
    commits: commits
      .filter((commit) => {
        const clip = clipsById.get(commit.clipId);
        return isAllowedTrackKey(timelineTrackKeyFromParts(clip?.trackType, clip?.trackIndex));
      })
      .sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId)),
  };
}

export function getTimelineReplaceSelectionPastePlan({
  clipboard,
  clips,
  tracks,
  selectedClipIds,
  selectedClipId,
}: {
  clipboard: TimelineClipboard | null;
  clips: TimelineDuplicateClip[];
  tracks: TimelineEditableTrack[];
  selectedClipIds: Set<string>;
  selectedClipId: string | null | undefined;
  playheadTime: number;
}): TimelineOverwritePastePlan {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return { inputs: [], deleteIds: [], commits: [] };

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return { inputs: [], deleteIds: [], commits: [] };

  const startTime = Math.min(...selected.map((clip) => clip.startTime));
  const inputs = getEditableTimelinePasteInputs(pasteTimelineClips(clipboard, startTime), tracks, clips);
  if (!clipboard || inputs.length === 0) return { inputs, deleteIds: [], commits: [] };
  const targetTrackKeys = new Set(inputs.map((input) => (
    timelineTrackKeyFromParts(input.trackType, input.trackIndex)
  )).filter((trackKey): trackKey is string => Boolean(trackKey)));
  const deleteIds = selected
    .filter((clip) => {
      if (targetTrackKeys.size === 0) return true;
      const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
      return Boolean(trackKey && targetTrackKeys.has(trackKey));
    })
    .map((clip) => clip.id);

  return {
    inputs,
    deleteIds: deleteIds.sort((a, b) => a.localeCompare(b)),
    commits: [],
  };
}

export function canPasteTimelineClipboard(
  clipboard: TimelineClipboard | null,
  tracks?: TimelineEditableTrack[],
): boolean {
  if (!clipboard?.clips.length) return false;
  if (!tracks) return true;

  const tracksByKey = new Map(tracks.map((track) => [`${track.type}-${track.index}`, track]));
  return clipboard.clips.some((clip) => {
    const trackType = typeof clip.input.trackType === "string" ? clip.input.trackType : null;
    const trackIndex = typeof clip.input.trackIndex === "number" ? clip.input.trackIndex : null;
    if (!trackType || trackIndex == null) return true;
    const track = tracksByKey.get(`${trackType}-${trackIndex}`);
    return !track?.locked && track?.visible !== false;
  });
}

export function getTimelinePasteTargetTime(
  clips: TimelineNudgeClip[],
  selectedClipIds: Set<string>,
  playheadTime: number,
  tracks?: TimelineEditableTrack[],
): number {
  const targetIds = tracks
    ? getEditableTimelineClipIds(clips, tracks, selectedClipIds)
    : selectedClipIds;
  const selected = clips.filter((clip) => targetIds.has(clip.id));
  if (selected.length === 0) return Number.isFinite(playheadTime) ? Math.max(0, playheadTime) : 0;
  return roundTimelineTime(Math.max(...selected.map((clip) => clip.endTime)));
}

export function cutTimelineClips(
  clips: TimelineDuplicateClip[],
  selectedClipIds: Set<string>,
  tracks?: TimelineEditableTrack[],
): TimelineCutResult | null {
  const targetIds = tracks
    ? getEditableTimelineClipIds(clips, tracks, selectedClipIds)
    : new Set(
      clips
        .filter((clip) => selectedClipIds.has(clip.id) && !clip.locked)
        .map((clip) => clip.id),
    );
  const clipboard = copyTimelineClips(clips, targetIds);
  if (!clipboard) return null;

  const deleteIds = clips
    .filter((clip) => targetIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => clip.id);

  return { clipboard, deleteIds };
}

function timelineTrackKey(clip: Record<string, unknown>): string {
  return `${String(clip.trackType || "")}-${Number(clip.trackIndex || 0)}`;
}

export function rippleDeleteTimelineClips(
  clips: TimelineDuplicateClip[],
  selectedClipIds: Set<string>,
  tracks?: TimelineEditableTrack[],
): TimelineRippleDeleteResult | null {
  if (selectedClipIds.size === 0) return null;
  const editableIds = tracks
    ? getEditableTimelineClipIds(clips, tracks, selectedClipIds)
    : new Set(
      clips
        .filter((clip) => selectedClipIds.has(clip.id) && !clip.locked)
        .map((clip) => clip.id),
    );
  if (editableIds.size === 0) return null;
  const allEditableIds = tracks
    ? getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)))
    : new Set(
      clips
        .filter((clip) => !clip.locked)
        .map((clip) => clip.id),
    );

  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return null;

  const deleteIds = selected.map((clip) => clip.id);
  const selectedByTrack = new Map<string, TimelineDuplicateClip[]>();
  for (const clip of selected) {
    const key = timelineTrackKey(clip);
    selectedByTrack.set(key, [...(selectedByTrack.get(key) || []), clip]);
  }
  const protectedClipsByTrack = new Map<string, TimelineDuplicateClip[]>();
  for (const clip of clips) {
    if (allEditableIds.has(clip.id)) continue;
    const key = timelineTrackKey(clip);
    protectedClipsByTrack.set(key, [...(protectedClipsByTrack.get(key) || []), clip]);
  }
  const crossesProtectedClip = (
    clip: TimelineDuplicateClip,
    fromStart: number,
    fromEnd: number,
    toStart: number,
    toEnd: number,
  ): boolean => {
    const sweepStart = Math.min(fromStart, toStart);
    const sweepEnd = Math.max(fromEnd, toEnd);
    return (protectedClipsByTrack.get(timelineTrackKey(clip)) || []).some((protectedClip) => (
      sweepStart < protectedClip.endTime - 0.001 && sweepEnd > protectedClip.startTime + 0.001
    ));
  };

  const commits: TimelineNudgeCommit[] = [];
  const creates: TimelineDuplicateInput[] = [];
  const shiftSegment = (intervals: { startTime: number; endTime: number }[], segment: { startTime: number; endTime: number }) => {
    const shift = intervals.reduce((total, interval) => (
      segment.startTime >= interval.endTime - 0.001
        ? total + Math.max(0, interval.endTime - interval.startTime)
        : total
    ), 0);
    return {
      startTime: roundTimelineTime(Math.max(0, segment.startTime - shift)),
      endTime: roundTimelineTime(Math.max(0, segment.endTime - shift)),
    };
  };

  for (const clip of clips) {
    if (editableIds.has(clip.id)) continue;
    if (!allEditableIds.has(clip.id)) continue;
    const selectedOnTrack = selectedByTrack.get(timelineTrackKey(clip));
    if (!selectedOnTrack?.length) continue;

    const intervals = mergeTimelineIntervals(selectedOnTrack.map((deleted) => ({
      startTime: deleted.startTime,
      endTime: deleted.endTime,
    })));
    const remainingSegments = getTimelineRemainingSegments(clip, intervals).map((segment) => {
      const shifted = shiftSegment(intervals, segment);
      return { ...segment, shifted };
    });
    if (remainingSegments.length === 0) {
      deleteIds.push(clip.id);
      continue;
    }

    const [firstSegment, ...extraSegments] = remainingSegments;
    const movedOrTrimmed = (
      Math.abs(firstSegment.shifted.startTime - clip.startTime) > 0.001 ||
      Math.abs(firstSegment.shifted.endTime - clip.endTime) > 0.001
    );
    if (movedOrTrimmed) {
      const crossesProtected = crossesProtectedClip(
        clip,
        firstSegment.startTime,
        firstSegment.endTime,
        firstSegment.shifted.startTime,
        firstSegment.shifted.endTime,
      );
      if (!crossesProtected) {
        commits.push({
          clipId: clip.id,
          startTime: firstSegment.shifted.startTime,
          endTime: firstSegment.shifted.endTime,
          ...getTimelineTrimForSegment(clip, firstSegment),
        });
      }
    }

    for (const segment of extraSegments) {
      if (crossesProtectedClip(
        clip,
        segment.startTime,
        segment.endTime,
        segment.shifted.startTime,
        segment.shifted.endTime,
      )) {
        continue;
      }
      creates.push({
        ...createClipInput(clip),
        startTime: segment.shifted.startTime,
        endTime: segment.shifted.endTime,
        ...getTimelineTrimForSegment(clip, segment),
      });
    }
  }

  commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
  const result: TimelineRippleDeleteResult = { deleteIds, commits };
  if (creates.length > 0) {
    result.creates = creates.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  }
  return result;
}

export function rippleDeleteTimelineClipsGlobally(
  clips: TimelineDuplicateClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
): TimelineRippleDeleteResult | null {
  const editableIds = getEditableTimelineClipIds(clips, tracks, selectedClipIds);
  if (editableIds.size === 0) return null;

  const selected = clips
    .filter((clip) => editableIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return null;

  const intervals = mergeTimelineIntervals(selected.map((clip) => ({
    startTime: clip.startTime,
    endTime: clip.endTime,
  })));
  const deleteIds = selected.map((clip) => clip.id);
  const allEditableIds = getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
  const protectedClipsByTrack = new Map<string, TimelineDuplicateClip[]>();
  for (const clip of clips) {
    if (allEditableIds.has(clip.id)) continue;
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
    if (!trackKey) continue;
    protectedClipsByTrack.set(trackKey, [...(protectedClipsByTrack.get(trackKey) || []), clip]);
  }
  const crossesProtectedClip = (
    clip: TimelineDuplicateClip,
    fromStart: number,
    fromEnd: number,
    toStart: number,
    toEnd: number,
  ): boolean => {
    const trackKey = timelineTrackKeyFromParts(clip.trackType, clip.trackIndex);
    if (!trackKey) return false;
    const sweepStart = Math.min(fromStart, toStart);
    const sweepEnd = Math.max(fromEnd, toEnd);
    return (protectedClipsByTrack.get(trackKey) || []).some((protectedClip) => (
      sweepStart < protectedClip.endTime - 0.001 && sweepEnd > protectedClip.startTime + 0.001
    ));
  };
  const commits: TimelineNudgeCommit[] = [];
  const creates: TimelineDuplicateInput[] = [];
  const shiftSegment = (segment: { startTime: number; endTime: number }) => {
    const shift = intervals.reduce((total, interval) => (
      segment.startTime >= interval.endTime - 0.001
        ? total + Math.max(0, interval.endTime - interval.startTime)
        : total
    ), 0);
    return {
      startTime: roundTimelineTime(Math.max(0, segment.startTime - shift)),
      endTime: roundTimelineTime(Math.max(0, segment.endTime - shift)),
    };
  };

  for (const clip of clips) {
    if (!allEditableIds.has(clip.id) || editableIds.has(clip.id)) continue;

    const remainingSegments = getTimelineRemainingSegments(clip, intervals).map((segment) => {
      const shifted = shiftSegment(segment);
      return { ...segment, shifted };
    });
    if (remainingSegments.length === 0) {
      deleteIds.push(clip.id);
      continue;
    }

    const [firstSegment, ...extraSegments] = remainingSegments;
    const movedOrTrimmed = (
      Math.abs(firstSegment.shifted.startTime - clip.startTime) > 0.001 ||
      Math.abs(firstSegment.shifted.endTime - clip.endTime) > 0.001
    );
    if (movedOrTrimmed) {
      const crossesProtected = crossesProtectedClip(
        clip,
        firstSegment.startTime,
        firstSegment.endTime,
        firstSegment.shifted.startTime,
        firstSegment.shifted.endTime,
      );
      if (!crossesProtected) {
        commits.push({
          clipId: clip.id,
          startTime: firstSegment.shifted.startTime,
          endTime: firstSegment.shifted.endTime,
          ...getTimelineTrimForSegment(clip, firstSegment),
        });
      }
    }

    for (const segment of extraSegments) {
      if (crossesProtectedClip(
        clip,
        segment.startTime,
        segment.endTime,
        segment.shifted.startTime,
        segment.shifted.endTime,
      )) {
        continue;
      }
      creates.push({
        ...createClipInput(clip),
        startTime: segment.shifted.startTime,
        endTime: segment.shifted.endTime,
        ...getTimelineTrimForSegment(clip, segment),
      });
    }
  }

  const result: TimelineRippleDeleteResult = {
    deleteIds,
    commits: commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId)),
  };
  if (creates.length > 0) {
    result.creates = creates.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  }
  return result;
}
