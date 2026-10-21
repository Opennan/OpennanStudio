// Clip property, keyframe, zoom, and base selection helpers for timeline editing.
import { normalizeFilterId } from "../looks/filters";
import {
  TimelineNudgeClip,
  TimelineNudgeCommit,
  TimelineDuplicateClip,
  TimelineDuplicateInput,
  TimelineDeleteBatchPlan,
  TimelineMarkerLike,
  TimelineEditableClip,
  TimelineEditableTrack,
  MIN_TIMELINE_ZOOM,
  MAX_TIMELINE_ZOOM,
  TIMELINE_ZOOM_LEVELS,
  TIMELINE_FIT_GUTTER,
  TIMELINE_LABEL_COLUMN_WIDTH,
  TIMELINE_COMPACT_FIT_RATIO,
  TIMELINE_FRAME_STEP_SECONDS,
  TIMELINE_LARGE_NUDGE_STEP_SECONDS,
  roundTimelineTime,
  resolveTimelineDropStart,
} from "./timeline-editing-shared";
import { getTimelineTextStylePreset } from "./timeline-text-style";

export function getTimelineNudgeStepSeconds(largeStep: boolean): number {
  return largeStep ? TIMELINE_LARGE_NUDGE_STEP_SECONDS : TIMELINE_FRAME_STEP_SECONDS;
}

export function createClipInput(clip: TimelineDuplicateClip): TimelineDuplicateInput {
  const input: TimelineDuplicateInput = {
    startTime: clip.startTime,
    endTime: clip.endTime,
  };
  const allowedKeys = [
    "trackType",
    "trackIndex",
    "mediaUrl",
    "mediaType",
    "sceneId",
    "label",
    "thumbnailUrl",
    "locked",
    "volume",
    "audioPan",
    "audioPitch",
    "audioEq",
    "audioDenoise",
    "audioNormalize",
    "playbackSpeed",
    "speedRamp",
    "reversePlayback",
    "freezeFrame",
    "fadeInDuration",
    "fadeOutDuration",
    "transitionType",
    "transitionDuration",
    "opacity",
    "scale",
    "positionX",
    "positionY",
    "horizontalFlip",
    "verticalFlip",
    "cropLeft",
    "cropRight",
    "cropTop",
    "cropBottom",
    "brightness",
    "contrast",
    "saturation",
    "visualFilter",
    "filterIntensity",
    "adjustmentsJson",
    "motionPreset",
    "blurStrength",
    "chromaKeyEnabled",
    "chromaKeyColor",
    "chromaKeySimilarity",
    "chromaKeyBlend",
    "blendMode",
    "mosaicStrength",
    "rotationDegrees",
    "keyframesJson",
    "textContent",
    "textStyle",
    "trimStart",
    "trimEnd",
    "aiPrompt",
    "aiReferenceUrls",
    "aiModelId",
    "maskJson",
    "beatsJson",
  ];
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(clip, key)) {
      input[key] = clip[key];
    }
  }
  return input;
}

export function timelineTrackKeyFromParts(trackType: unknown, trackIndex: unknown): string | null {
  return typeof trackType === "string" && typeof trackIndex === "number"
    ? `${trackType}-${trackIndex}`
    : null;
}

export function getTimelineSoloTrackUpdates<TTrack extends TimelineEditableTrack>(
  tracks: TTrack[],
  trackKey: string,
): TTrack[] {
  const target = tracks.find((track) => `${track.type}-${track.index}` === trackKey);
  if (!target) return tracks;

  const sameTypeTracks = tracks.filter((track) => track.type === target.type);
  const isAudio = target.type === "audio";
  const targetAlreadySoloed = isAudio
    ? target.muted === false && sameTypeTracks.every((track) => track.index === target.index || track.muted === true)
    : target.visible !== false && sameTypeTracks.every((track) => track.index === target.index || track.visible === false);

  return tracks.map((track) => {
    if (track.type !== target.type) return track;
    if (isAudio) {
      return {
        ...track,
        muted: targetAlreadySoloed ? false : track.index !== target.index,
      };
    }
    return {
      ...track,
      visible: targetAlreadySoloed ? true : track.index === target.index,
    };
  });
}

export function getTimelineDeleteTrackUpdates<TTrack extends TimelineEditableTrack>(
  tracks: TTrack[],
  trackKey: string,
): TTrack[] {
  const target = tracks.find((track) => `${track.type}-${track.index}` === trackKey);
  if (!target) return tracks;
  if (target.locked) return tracks;
  if ((target.type === "video" || target.type === "audio") && target.index === 1) return tracks;

  const sameTypeTracks = tracks.filter((track) => track.type === target.type);
  // Video/audio lanes must keep at least one row; optional overlay tracks can be removed entirely.
  if ((target.type === "video" || target.type === "audio") && sameTypeTracks.length <= 1) return tracks;

  return tracks.filter((track) => `${track.type}-${track.index}` !== trackKey);
}

export function getTimelineToggleClipMuteTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selectedMedia = clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selectedMedia.length === 0) return [];

  const allMuted = selectedMedia.every((clip) => Number(clip.volume ?? 1) <= 0.001); // i18n-ignore
  const nextVolume = allMuted ? 1 : 0;
  return selectedMedia.map((clip) => ({
    clipId: clip.id,
    startTime: roundTimelineTime(clip.startTime),
    endTime: roundTimelineTime(clip.endTime),
    volume: nextVolume,
  }));
}

export function getTimelineSetClipVolumeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  volume: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextVolume = roundTimelineTime(Math.max(0, Math.min(2, Number.isFinite(volume) ? volume : 1)));
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      volume: nextVolume,
    }));
}

export function getTimelineSetClipAudioPanTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  audioPan: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextPan = roundTimelineTime(Math.max(-1, Math.min(1, Number.isFinite(audioPan) ? audioPan : 0)));
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      audioPan: nextPan,
    }));
}

export function getTimelineSetClipAudioPitchTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  audioPitch: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextPitch = roundTimelineTime(Math.max(-12, Math.min(12, Number.isFinite(audioPitch) ? audioPitch : 0)));
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      audioPitch: nextPitch,
    }));
}

export function normalizeTimelineAudioEq(audioEq: string): string {
  const value = audioEq.trim().toLowerCase();
  return ["none", "bass", "vocal", "treble"].includes(value) ? value : "none";
}

export function getTimelineSetClipAudioEqTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  audioEq: string,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextAudioEq = normalizeTimelineAudioEq(audioEq);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      audioEq: nextAudioEq,
    }));
}

export function getTimelineToggleClipAudioDenoiseTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      audioDenoise: !Boolean(clip.audioDenoise),
    }));
}

export function getTimelineToggleClipAudioNormalizeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      audioNormalize: !Boolean(clip.audioNormalize),
    }));
}

export function getTimelineResetClipVolumeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "audio" || clip.trackType === "video")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      volume: 1,
    }));
}

export function getTimelineResetClipTrimTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trimStart != null || clip.trimEnd != null)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      trimStart: null,
      trimEnd: null,
    }));
}

export function getTimelineToggleClipVisibilityTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const selectedVisual = clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selectedVisual.length === 0) return [];

  const allHidden = selectedVisual.every((clip) => Number(clip.opacity ?? 1) <= 0.001); // i18n-ignore
  const nextOpacity = allHidden ? 1 : 0;
  return selectedVisual.map((clip) => ({
    clipId: clip.id,
    startTime: roundTimelineTime(clip.startTime),
    endTime: roundTimelineTime(clip.endTime),
    opacity: nextOpacity,
  }));
}

export function getTimelineSetVisualOpacityTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  opacity: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextOpacity = roundTimelineTime(Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1)));
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      opacity: nextOpacity,
    }));
}

export function getTimelineSetVisualScaleTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  scale: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextScale = roundTimelineTime(Math.max(0.1, Math.min(8, Number.isFinite(scale) ? scale : 1)));
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      scale: nextScale,
    }));
}

export function getTimelineSetVisualPositionTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  positionX: number,
  positionY: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextPositionX = roundTimelineTime(Math.max(0, Math.min(1, Number.isFinite(positionX) ? positionX : 0.5)));
  const nextPositionY = roundTimelineTime(Math.max(0, Math.min(1, Number.isFinite(positionY) ? positionY : 0.5)));
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      positionX: nextPositionX,
      positionY: nextPositionY,
    }));
}

export function getTimelineResetVisualTransformTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      opacity: 1,
      scale: 1,
      positionX: 0,
      positionY: 0,
      rotationDegrees: 0,
      horizontalFlip: false,
      verticalFlip: false,
      cropLeft: 0,
      cropRight: 0,
      cropTop: 0,
      cropBottom: 0,
      brightness: 0,
      contrast: 1,
      saturation: 1,
      visualFilter: "none",
      filterIntensity: null,
      adjustmentsJson: null,
      motionPreset: "none",
      blurStrength: 0,
      chromaKeyEnabled: false,
      blendMode: "normal",
      mosaicStrength: 0,
    }));
}

export function normalizeCropPair(first: number, second: number): [number, number] {
  const clamp = (value: number) => Math.max(0, Math.min(0.95, Number.isFinite(value) ? value : 0));
  const a = clamp(first);
  const b = clamp(second);
  const total = a + b;
  if (total <= 0.95) return [roundTimelineTime(a), roundTimelineTime(b)];
  const scale = 0.95 / total;
  return [roundTimelineTime(a * scale), roundTimelineTime(b * scale)];
}

export function getTimelineSetVisualCropTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  crop: { cropLeft?: number; cropRight?: number; cropTop?: number; cropBottom?: number },
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const [cropLeft, cropRight] = normalizeCropPair(Number(crop.cropLeft ?? 0), Number(crop.cropRight ?? 0));
  const [cropTop, cropBottom] = normalizeCropPair(Number(crop.cropTop ?? 0), Number(crop.cropBottom ?? 0));
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      cropLeft,
      cropRight,
      cropTop,
      cropBottom,
    }));
}

export function clampTimelineNumber(value: number, min: number, max: number, fallback: number): number {
  const next = Number.isFinite(value) ? value : fallback;
  return roundTimelineTime(Math.max(min, Math.min(max, next)));
}

export function getTimelineSetVisualColorTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  color: { brightness?: number; contrast?: number; saturation?: number },
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const brightness = clampTimelineNumber(Number(color.brightness ?? 0), -1, 1, 0);
  const contrast = clampTimelineNumber(Number(color.contrast ?? 1), 0, 3, 1);
  const saturation = clampTimelineNumber(Number(color.saturation ?? 1), 0, 3, 1);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      brightness,
      contrast,
      saturation,
    }));
}

/** A filter preset id from the looks catalog (pre-10a warm/cool/cinematic included), else "none". */
export function normalizeTimelineVisualFilter(visualFilter: string): string {
  return normalizeFilterId(visualFilter);
}

export function getTimelineSetVisualFilterTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  visualFilter: string,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextVisualFilter = normalizeTimelineVisualFilter(visualFilter);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      visualFilter: nextVisualFilter,
    }));
}

export function normalizeTimelineMotionPreset(motionPreset: string): string {
  const value = motionPreset.trim().toLowerCase();
  return ["none", "zoom_in", "zoom_out", "pulse"].includes(value) ? value : "none";
}

export function getTimelineSetVisualMotionPresetTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  motionPreset: string,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextMotionPreset = normalizeTimelineMotionPreset(motionPreset);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      motionPreset: nextMotionPreset,
    }));
}

export type TimelineAddTextClipPreset = "text" | "caption" | "subtitle";

export function getTimelineAddTextClipInput(
  tracks: TimelineEditableTrack[],
  playheadTime: number,
  preset: TimelineAddTextClipPreset = "text",
  clips: TimelineDuplicateClip[] = [],
): TimelineDuplicateInput | null {
  const textTracks = tracks
    .filter((track) => track.type === "text")
    .sort((a, b) => a.index - b.index);

  const normalizedPreset = preset === "caption" || preset === "subtitle" ? preset : "text";
  const startTime = roundTimelineTime(Math.max(0, playheadTime));
  const endTime = roundTimelineTime(startTime + 5);
  const editableIds = clips.length > 0
    ? getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)))
    : null;
  const hasProtectedOverlap = (trackIndex: number) => (
    clips.some((clip) => {
      if (clip.trackType !== "text" || clip.trackIndex !== trackIndex) return false;
      if (editableIds?.has(clip.id)) return false;
      return startTime < clip.endTime - 0.001 && endTime > clip.startTime + 0.001;
    })
  );
  const editableTextTrack = textTracks.find((track) => (
    !track.locked && track.visible !== false && !hasProtectedOverlap(track.index)
  ));
  if (textTracks.length > 0 && !editableTextTrack) return null;
  if (textTracks.length === 0 && hasProtectedOverlap(1)) return null;
  const trackIndex = editableTextTrack?.index ?? 1;
  // Land in the nearest free spot on the track — creating a clip must never
  // overlap an existing one (same invariant drag/drop enforces on release).
  const blockers = clips.filter((clip) => clip.trackType === "text" && clip.trackIndex === trackIndex);
  const resolvedStart = resolveTimelineDropStart(startTime, endTime - startTime, blockers);
  if (resolvedStart === null) return null;
  const input: TimelineDuplicateInput = {
    trackType: "text",
    trackIndex,
    startTime: roundTimelineTime(resolvedStart),
    endTime: roundTimelineTime(resolvedStart + (endTime - startTime)),
    textContent: normalizedPreset === "caption"
      ? "Enter caption..."
      : normalizedPreset === "subtitle"
        ? "Enter subtitle..."
        : "Enter text...",
    positionX: 0.5,
    positionY: normalizedPreset === "text" ? 0.5 : normalizedPreset === "caption" ? 0.82 : 0.88,
    scale: 1,
    opacity: 1,
  };

  if (normalizedPreset !== "text") {
    input.textStyle = getTimelineTextStylePreset(normalizedPreset);
  }

  return input;
}

export function getTimelineSetTextStylePresetTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  textStylePreset: string,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const textStyle = getTimelineTextStylePreset(textStylePreset);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "text")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      textStyle,
    }));
}

export function getTimelineSetVisualBlurTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  blurStrength: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextBlurStrength = clampTimelineNumber(Number(blurStrength), 0, 20, 0);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      blurStrength: nextBlurStrength,
    }));
}

export function normalizeChromaKeyColor(color: string | null | undefined): string {
  const raw = String(color ?? "").trim();
  const match = raw.match(/^(?:#|0x)?([0-9a-fA-F]{6})$/);
  if (!match) return "0x00FF00";
  return `0x${match[1].toUpperCase()}`;
}

export function getTimelineSetVisualChromaKeyTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  chromaKey: { enabled?: boolean; color?: string; similarity?: number; blend?: number },
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const chromaKeyEnabled = Boolean(chromaKey.enabled);
  const chromaKeyColor = normalizeChromaKeyColor(chromaKey.color);
  const chromaKeySimilarity = clampTimelineNumber(Number(chromaKey.similarity ?? 0.1), 0, 1, 0.1);
  const chromaKeyBlend = clampTimelineNumber(Number(chromaKey.blend ?? 0), 0, 1, 0);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      chromaKeyEnabled,
      chromaKeyColor,
      chromaKeySimilarity,
      chromaKeyBlend,
    }));
}

export function normalizeTimelineBlendMode(blendMode: string): string {
  const value = blendMode.trim().toLowerCase();
  return ["normal", "multiply", "screen", "overlay"].includes(value) ? value : "normal";
}

export function getTimelineSetVisualBlendModeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  blendMode: string,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextBlendMode = normalizeTimelineBlendMode(blendMode);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "text" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      blendMode: nextBlendMode,
    }));
}

export function getTimelineSetVisualMosaicTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  mosaicStrength: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const nextMosaicStrength = clampTimelineNumber(Number(mosaicStrength), 0, 64, 0);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      mosaicStrength: nextMosaicStrength,
    }));
}

export function getTimelineRotateVisualTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  deltaDegrees: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const delta = Number.isFinite(deltaDegrees) ? deltaDegrees : 90;
  const normalize = (degrees: number | null | undefined) => {
    const current = Number.isFinite(degrees ?? Number.NaN) ? Number(degrees) : 0;
    return ((Math.round((current + delta) / 90) * 90) % 360 + 360) % 360;
  };

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      rotationDegrees: normalize(clip.rotationDegrees),
    }));
}

export function getTimelineSetVisualRotationTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  rotationDegrees: number,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  const normalized = ((Math.round((Number.isFinite(rotationDegrees) ? rotationDegrees : 0) / 90) * 90) % 360 + 360) % 360;
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      rotationDegrees: normalized,
    }));
}

export function getTimelineToggleHorizontalFlipTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      horizontalFlip: !Boolean(clip.horizontalFlip),
    }));
}

export function getTimelineToggleVerticalFlipTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return [];

  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => clip.trackType === "video" || clip.trackType === "sticker")
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id))
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      verticalFlip: !Boolean(clip.verticalFlip),
    }));
}

export function getNextTimelineZoom(currentZoom: number, direction: -1 | 1): number {
  const zoom = Number.isFinite(currentZoom) && currentZoom > 0 ? currentZoom : MIN_TIMELINE_ZOOM;
  const levels = [...TIMELINE_ZOOM_LEVELS];
  const next = direction > 0
    ? levels.find((level) => level > zoom + 0.001) ?? MAX_TIMELINE_ZOOM
    : [...levels].reverse().find((level) => level < zoom - 0.001) ?? MIN_TIMELINE_ZOOM;
  return roundTimelineTime(next);
}

export function getTimelineFitZoom(containerWidth: number, totalDuration: number): number | null {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(totalDuration) || totalDuration <= 0) return null;
  const availableWidth = Math.max(0, containerWidth - TIMELINE_LABEL_COLUMN_WIDTH - TIMELINE_FIT_GUTTER) * TIMELINE_COMPACT_FIT_RATIO;
  return roundTimelineTime(Math.max(1, Math.min(MAX_TIMELINE_ZOOM, availableWidth / totalDuration)));
}

export function getTimelineSelectionFitZoom(
  containerWidth: number,
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): number | null {
  if (!Number.isFinite(containerWidth)) return null;
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return null;

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return null;

  const start = Math.min(...selected.map((clip) => clip.startTime));
  const end = Math.max(...selected.map((clip) => clip.endTime));
  const duration = roundTimelineTime(end - start);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const availableWidth = Math.max(0, containerWidth - TIMELINE_LABEL_COLUMN_WIDTH - TIMELINE_FIT_GUTTER) * TIMELINE_COMPACT_FIT_RATIO;
  return roundTimelineTime(Math.max(1, Math.min(MAX_TIMELINE_ZOOM, availableWidth / duration)));
}

export function getTimelineSelectionFitScrollLeft(
  containerWidth: number,
  zoom: number,
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): number | null {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(zoom) || zoom <= 0) return null;
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return null;

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return null;

  const start = Math.min(...selected.map((clip) => clip.startTime));
  const end = Math.max(...selected.map((clip) => clip.endTime));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const centerPx = ((start + end) / 2) * zoom;
  return roundTimelineTime(Math.max(0, centerPx - containerWidth / 2));
}

export function getTimelinePlayheadCenterScrollLeft(
  containerWidth: number,
  zoom: number,
  playheadTime: number,
): number | null {
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(zoom) ||
    !Number.isFinite(playheadTime) ||
    containerWidth <= 0 ||
    zoom <= 0
  ) {
    return null;
  }

  return roundTimelineTime(Math.max(0, playheadTime * zoom - containerWidth / 2));
}

export function getTimelineSelectionBoundaryTime(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  edge: "start" | "end",
): number | null {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  if (editableIds.size === 0) return null;

  const selected = clips.filter((clip) => editableIds.has(clip.id));
  if (selected.length === 0) return null;

  const time = edge === "start"
    ? Math.min(...selected.map((clip) => clip.startTime))
    : Math.max(...selected.map((clip) => clip.endTime));
  return Number.isFinite(time) ? roundTimelineTime(Math.max(0, time)) : null;
}

export function getToggledTimelineSnap(enabled: boolean): boolean {
  return !enabled;
}

export function getEditableTimelineClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
): Set<string> {
  if (selectedClipIds.size === 0) return new Set();
  const tracksByKey = new Map(tracks.map((track) => [`${track.type}-${track.index}`, track]));
  const editableIds = new Set<string>();

  for (const clip of clips) {
    if (!selectedClipIds.has(clip.id)) continue;
    if (!clip.trackType || clip.trackIndex == null) {
      if (!clip.locked) editableIds.add(clip.id);
      continue;
    }

    const track = tracksByKey.get(`${clip.trackType}-${clip.trackIndex}`);
    if (!track?.locked && track?.visible !== false && !clip.locked) editableIds.add(clip.id);
  }

  return editableIds;
}

export function getTimelineToggleClipLockTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  if (activeIds.size === 0) return [];

  const tracksByKey = new Map(tracks.map((track) => [`${track.type}-${track.index}`, track]));
  const selected = clips
    .filter((clip) => activeIds.has(clip.id))
    .filter((clip) => {
      if (!clip.trackType || clip.trackIndex == null) return true;
      const track = tracksByKey.get(`${clip.trackType}-${clip.trackIndex}`);
      return !track?.locked && track?.visible !== false;
    })
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  if (selected.length === 0) return [];

  const allLocked = selected.every((clip) => Boolean(clip.locked));
  return selected.map((clip) => ({
    clipId: clip.id,
    startTime: roundTimelineTime(clip.startTime),
    endTime: roundTimelineTime(clip.endTime),
    locked: !allLocked,
  }));
}

export function getEditableTimelineSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): Set<string> {
  const activeIds = new Set<string>();
  for (const id of selectedClipIds) activeIds.add(id);
  if (activeIds.size === 0 && selectedClipId) activeIds.add(selectedClipId);
  return getEditableTimelineClipIds(clips, tracks, activeIds);
}

export function getTimelineSelectAllClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
): Set<string> {
  return getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)));
}

export type TimelineKeyframePoint = Record<string, number> & { time: number };

export function parseTimelineKeyframes(raw: unknown): TimelineKeyframePoint[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  const points = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { keyframes?: unknown }).keyframes)
      ? (parsed as { keyframes: unknown[] }).keyframes
      : [];
  return points
    .filter((point): point is Record<string, unknown> => Boolean(point && typeof point === "object"))
    .map((point) => {
      const time = Number(point.time);
      if (!Number.isFinite(time)) return null;
      const clean: TimelineKeyframePoint = { time: roundTimelineTime(Math.max(0, time)) };
      for (const [key, value] of Object.entries(point)) {
        if (key === "time") continue;
        const number = Number(value);
        if (Number.isFinite(number)) clean[key] = roundTimelineTime(number);
      }
      return Object.keys(clean).length > 1 ? clean : null;
    })
    .filter((point): point is TimelineKeyframePoint => Boolean(point))
    .sort((a, b) => a.time - b.time);
}

export function clipKeyframeAtTime(clip: TimelineEditableClip, time: number): TimelineKeyframePoint {
  const point: TimelineKeyframePoint = { time: roundTimelineTime(time) };
  const addNumber = (key: string, value: unknown, fallback?: number) => {
    const number = Number(value ?? fallback);
    if (Number.isFinite(number)) point[key] = roundTimelineTime(number);
  };

  if (clip.trackType !== "audio") {
    addNumber("scale", clip.scale, 1);
    addNumber("opacity", clip.opacity, 1);
    addNumber("position_x", clip.positionX, 0.5);
    addNumber("position_y", clip.positionY, 0.5);
    addNumber("rotation_degrees", clip.rotationDegrees, 0);
  }
  if (clip.trackType === "audio" || clip.trackType === "video") {
    addNumber("volume", clip.volume, 1);
  }
  return point;
}

export function getTimelineAddKeyframeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
): TimelineNudgeCommit[] {
  if (!Number.isFinite(playheadTime)) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => playheadTime >= clip.startTime && playheadTime <= clip.endTime)
    .map((clip) => {
      const localTime = roundTimelineTime(Math.max(0, playheadTime - clip.startTime));
      const nextPoint = clipKeyframeAtTime(clip, localTime);
      const existing = parseTimelineKeyframes(clip.keyframesJson);
      const merged = [
        ...existing.filter((point) => Math.abs(point.time - localTime) > 0.001),
        nextPoint,
      ].sort((a, b) => a.time - b.time);
      return {
        clipId: clip.id,
        startTime: roundTimelineTime(clip.startTime),
        endTime: roundTimelineTime(clip.endTime),
        keyframesJson: JSON.stringify({ keyframes: merged }),
      };
    })
    .sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineClearKeyframesTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): TimelineNudgeCommit[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .filter((clip) => parseTimelineKeyframes(clip.keyframesJson).length > 0)
    .map((clip) => ({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      keyframesJson: null,
    }))
    .sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getSelectedTimelineKeyframeTimes(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): number[] {
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  return clips
    .filter((clip) => editableIds.has(clip.id))
    .flatMap((clip) => (
      parseTimelineKeyframes(clip.keyframesJson)
        .filter((point) => point.time <= clip.endTime - clip.startTime + 0.001)
        .map((point) => roundTimelineTime(clip.startTime + point.time))
    ))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b);
}

export function getAdjacentTimelineClipKeyframeTime(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  currentTime: number,
  direction: -1 | 1,
): number | null {
  if (!Number.isFinite(currentTime)) return null;
  const times = getSelectedTimelineKeyframeTimes(clips, tracks, selectedClipIds, selectedClipId);
  if (times.length === 0) return null;
  const epsilon = 0.05;
  return direction < 0
    ? [...times].reverse().find((time) => time < currentTime - epsilon) ?? null
    : times.find((time) => time > currentTime + epsilon) ?? null;
}

export function getTimelineDeleteNearestKeyframeTargetCommits(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  playheadTime: number,
  thresholdSeconds = 0.05,
): TimelineNudgeCommit[] {
  if (!Number.isFinite(playheadTime)) return [];
  const editableIds = getEditableTimelineSelectionClipIds(clips, tracks, selectedClipIds, selectedClipId);
  const threshold = Number.isFinite(thresholdSeconds) ? Math.max(0, thresholdSeconds) : 0.05;

  const commits: TimelineNudgeCommit[] = [];
  for (const clip of clips) {
    if (!editableIds.has(clip.id)) continue;
    const keyframes = parseTimelineKeyframes(clip.keyframesJson);
    if (keyframes.length === 0) continue;
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    keyframes.forEach((point, index) => {
      const absoluteTime = clip.startTime + point.time;
      const distance = Math.abs(absoluteTime - playheadTime);
      if (distance <= threshold && distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestIndex < 0) continue;
    const remaining = keyframes.filter((_, index) => index !== nearestIndex);
    commits.push({
      clipId: clip.id,
      startTime: roundTimelineTime(clip.startTime),
      endTime: roundTimelineTime(clip.endTime),
      keyframesJson: remaining.length > 0 ? JSON.stringify({ keyframes: remaining }) : null,
    });
  }

  return commits.sort((a, b) => a.startTime - b.startTime || a.clipId.localeCompare(b.clipId));
}

export function getTimelineInvertSelectionClipIds(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
): Set<string> {
  const selectedIds = new Set<string>();
  for (const id of selectedClipIds) selectedIds.add(id);
  if (selectedClipId) selectedIds.add(selectedClipId);

  const allEditableIds = getTimelineSelectAllClipIds(clips, tracks);
  const inverted = clips
    .filter((clip) => allEditableIds.has(clip.id) && !selectedIds.has(clip.id))
    .map((clip) => clip.id);
  return new Set(inverted);
}

export function getTimelineCopyTargetClipIds(
  selectedClipIds: Set<string>,
  selectedClipId: string | null | undefined,
  clips?: TimelineEditableClip[],
  tracks?: TimelineEditableTrack[],
): Set<string> {
  const targetIds = new Set<string>();
  for (const id of selectedClipIds) targetIds.add(id);
  if (selectedClipId) targetIds.add(selectedClipId);
  return clips && tracks ? getEditableTimelineClipIds(clips, tracks, targetIds) : targetIds;
}

export function getTimelineSelectionAfterDelete(
  selectedClipIds: Set<string>,
  deletedClipIds: Set<string>,
  clips: TimelineNudgeClip[] = [],
  tracks?: TimelineEditableTrack[],
): Set<string> {
  const remainingSelection = new Set([...selectedClipIds].filter((id) => !deletedClipIds.has(id)));
  if (remainingSelection.size > 0 || clips.length === 0 || deletedClipIds.size === 0) {
    return remainingSelection;
  }

  const deletedClips = clips.filter((clip) => deletedClipIds.has(clip.id));
  if (deletedClips.length === 0) return remainingSelection;

  const deletedStart = Math.min(...deletedClips.map((clip) => clip.startTime));
  const deletedEnd = Math.max(...deletedClips.map((clip) => clip.endTime));
  const candidateIds = tracks
    ? getEditableTimelineClipIds(clips, tracks, new Set(clips.map((clip) => clip.id)))
    : new Set(clips.map((clip) => clip.id));
  const candidates = clips
    .filter((clip) => !deletedClipIds.has(clip.id) && candidateIds.has(clip.id))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));

  const next = candidates.find((clip) => clip.startTime >= deletedEnd - 0.001);
  if (next) return new Set([next.id]);

  const previous = [...candidates].reverse().find((clip) => clip.endTime <= deletedStart + 0.001);
  return previous ? new Set([previous.id]) : remainingSelection;
}

export function getTimelineDeleteBatchPlan(
  clips: TimelineEditableClip[],
  tracks: TimelineEditableTrack[],
  selectedClipIds: Set<string>,
  isSyntheticEmbeddedAudio: (clipId: string) => boolean,
): TimelineDeleteBatchPlan {
  const editableIds = getEditableTimelineClipIds(clips, tracks, selectedClipIds);
  const deleteIds = new Set([...editableIds].filter((id) => !isSyntheticEmbeddedAudio(id)));
  const selectedVideos = clips.filter((clip) => (
    deleteIds.has(clip.id) &&
    clip.trackType === "video" &&
    typeof clip.mediaUrl === "string" &&
    clip.mediaUrl.length > 0
  ));

  for (const video of selectedVideos) {
    for (const clip of clips) {
      if (deleteIds.has(clip.id) || clip.trackType !== "audio") continue;
      if (!areTimelineMediaUrlsEqual(clip.mediaUrl, video.mediaUrl)) continue;
      if (Math.abs(clip.startTime - video.startTime) > 0.001 || Math.abs(clip.endTime - video.endTime) > 0.001) continue;
      if (!areOptionalTimelineTrimTimesEqual(clip.trimStart, video.trimStart)) continue;
      if (!areOptionalTimelineTrimTimesEqual(clip.trimEnd, video.trimEnd)) continue;
      deleteIds.add(clip.id);
    }
  }
  const blockedSyntheticCount = [...selectedClipIds].filter((id) => isSyntheticEmbeddedAudio(id)).length;

  return { deleteIds: [...deleteIds], blockedSyntheticCount };
}

function areTimelineMediaUrlsEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string" || left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  return getTimelineMediaUrlPath(left) === getTimelineMediaUrlPath(right);
}

function getTimelineMediaUrlPath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] || value;
  }
}

function areOptionalTimelineTrimTimesEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== "number" && typeof right !== "number") return true;
  return typeof left === "number" && typeof right === "number" && Math.abs(left - right) <= 0.001;
}

export function getAdjacentTimelineMarkerTime(
  markers: TimelineMarkerLike[],
  currentTime: number,
  direction: -1 | 1,
): number | null {
  if (!Number.isFinite(currentTime) || markers.length === 0) return null;
  const sorted = markers
    .map((marker) => roundTimelineTime(marker.time))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (direction < 0) {
    return [...sorted].reverse().find((time) => time < currentTime - 0.05) ?? null;
  }
  return sorted.find((time) => time > currentTime + 0.05) ?? null;
}

export function getNearestTimelineMarkerId(
  markers: TimelineMarkerLike[],
  currentTime: number,
  thresholdSeconds: number,
): string | null {
  let nearest: TimelineMarkerLike | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const distance = Math.abs(marker.time - currentTime);
    if (distance <= thresholdSeconds && distance < nearestDistance) {
      nearest = marker;
      nearestDistance = distance;
    }
  }
  return nearest?.id || null;
}
