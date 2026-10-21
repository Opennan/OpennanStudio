// Helpers for filtering timeline clips before preview playback/compositing.
import { getRawPathnameFromMediaUrl } from "./media-url-path";
import { parseTimelineKeyframes } from "./timeline-editing-properties";
import type { TimelineClip, TimelineTrack } from "../model/timeline";

const AUDIBLE_VOLUME_EPSILON = 0.001;

export function hasAudibleVolume(volume: number | null | undefined): boolean {
  const normalizedVolume = Number(volume ?? 1);
  return !Number.isFinite(normalizedVolume) || normalizedVolume > AUDIBLE_VOLUME_EPSILON;
}

/** Clip-level audibility: a clip whose STATIC volume is 0 can still be audible
 * via a volume-keyframe envelope (which preview and export both interpolate). */
export function hasAudibleClipAudio(clip: Pick<TimelineClip, "volume" | "keyframesJson">): boolean {
  if (hasAudibleVolume(clip.volume)) return true;
  return parseTimelineKeyframes(clip.keyframesJson).some(
    (point) => typeof point.volume === "number" && point.volume > AUDIBLE_VOLUME_EPSILON,
  );
}

/** Compare canonical media paths so proxy/CDN/backend URLs still match. */
export function mediaUrlsReferToSameAsset(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftPath = getRawPathnameFromMediaUrl(left);
  const rightPath = getRawPathnameFromMediaUrl(right);
  return Boolean(leftPath && rightPath && leftPath === rightPath);
}

export function timelineAudioHandlesUrlAtTime(
  timelineClips: TimelineClip[] | undefined,
  mediaUrl: string | null | undefined,
  currentTime: number,
): boolean {
  if (!mediaUrl || !timelineClips?.length) return false;
  return timelineClips.some((clip) => (
    clip.trackType === "audio" &&
    hasAudibleClipAudio(clip) &&
    mediaUrlsReferToSameAsset(clip.mediaUrl, mediaUrl) &&
    currentTime >= clip.startTime &&
    currentTime < clip.endTime
  ));
}

/** Timeline audio clip that carries separated scene voiceover (not detached video audio). */
export function isSceneVoiceoverTimelineClip(clip: TimelineClip): boolean {
  if (clip.trackType !== "audio") return false;
  const path = getRawPathnameFromMediaUrl(clip.mediaUrl || "");
  if (path?.startsWith("/generated/audio/")) return true;
  const mediaType = String(clip.mediaType || "").toLowerCase();
  return mediaType === "voiceover" || mediaType === "audio_ai";
}

/** Mute embedded scene video when voiceover was moved to the timeline (A-track owns playback). */
export function shouldMuteEmbeddedVideoForTimelineVoiceover(
  sceneHasBoundVoiceover: boolean,
  timelineClips: TimelineClip[] | undefined,
  currentTime: number,
): boolean {
  if (sceneHasBoundVoiceover || !timelineClips?.length) return false;
  return timelineClips.some((clip) => (
    isSceneVoiceoverTimelineClip(clip) &&
    hasAudibleClipAudio(clip) &&
    currentTime >= clip.startTime &&
    currentTime < clip.endTime
  ));
}

/** True when a scene's own audio was detached onto the timeline.
 *
 * Detaching moves ownership: the lane decides what that scene sounds like, and
 * a muted lane means silence, not "fall back to the video". URL matching alone
 * misses this — the extracted file has its own URL — so a scene video that
 * carries embedded audio kept talking underneath a muted lane, doubling the
 * dialogue against re-voiced clips placed on top.
 */
export function timelineOwnsSceneAudioAtTime(
  sceneId: string | null | undefined,
  timelineClips: TimelineClip[] | undefined,
  currentTime: number,
): boolean {
  if (!sceneId || !timelineClips?.length) return false;
  return timelineClips.some((clip) => (
    clip.trackType === "audio" &&
    clip.sceneId === sceneId &&
    currentTime >= clip.startTime &&
    currentTime < clip.endTime
  ));
}

/** True when detached/silent timeline clips mean preview should not play embedded video audio. */
export function shouldMuteDetachedSourceVideoAtTime(
  sourceVideoUrl: string | null | undefined,
  timelineClips: TimelineClip[] | undefined,
  currentTime: number,
): boolean {
  if (!sourceVideoUrl || !timelineClips?.length) return false;

  const hasDetachedAudio = timelineClips.some((clip) => (
    clip.trackType === "audio" &&
    mediaUrlsReferToSameAsset(clip.mediaUrl, sourceVideoUrl) &&
    currentTime >= clip.startTime &&
    currentTime < clip.endTime
  ));
  if (hasDetachedAudio) return true;

  return timelineClips.some((clip) => (
    clip.trackType === "video" &&
    mediaUrlsReferToSameAsset(clip.mediaUrl, sourceVideoUrl) &&
    !hasAudibleVolume(clip.volume) &&
    currentTime >= clip.startTime &&
    currentTime < clip.endTime
  ));
}

/** True when a separated voiceover clip already exists on the timeline for this URL. */
export function timelineHasMatchingVoiceoverClip(
  voiceoverUrl: string | null | undefined,
  timelineClips: TimelineClip[] | undefined,
): boolean {
  if (!voiceoverUrl || !timelineClips?.length) return false;
  return timelineClips.some((clip) => (
    clip.trackType === "audio" &&
    isSceneVoiceoverTimelineClip(clip) &&
    mediaUrlsReferToSameAsset(clip.mediaUrl, voiceoverUrl)
  ));
}

/** True when preview should play voiceover from the timeline instead of the scene binding. */
export function timelineOwnsSceneVoiceoverPlayback(
  voiceoverUrl: string | null | undefined,
  timelineClips: TimelineClip[] | undefined,
  currentTime: number,
  resolveUrl: (url: string) => string = (url) => url,
): boolean {
  if (!timelineClips?.length) return false;
  if (voiceoverUrl) {
    if (timelineAudioHandlesUrlAtTime(timelineClips, voiceoverUrl, currentTime)) return true;
    const previewUrl = resolveUrl(voiceoverUrl);
    if (previewUrl !== voiceoverUrl && timelineAudioHandlesUrlAtTime(timelineClips, previewUrl, currentTime)) {
      return true;
    }
  }
  return timelineClips.some((clip) => (
    isSceneVoiceoverTimelineClip(clip) &&
    hasAudibleClipAudio(clip) &&
    currentTime >= clip.startTime &&
    currentTime < clip.endTime &&
    (!voiceoverUrl || mediaUrlsReferToSameAsset(clip.mediaUrl, voiceoverUrl))
  ));
}

export function filterPreviewTimelineClips(
  timelineClips?: TimelineClip[],
  timelineTracks?: TimelineTrack[],
): TimelineClip[] {
  const clips = timelineClips || [];
  const hasAudibleClipVolume = (clip: TimelineClip) => clip.trackType !== "audio" || hasAudibleClipAudio(clip);
  if (!timelineTracks) return clips.filter(hasAudibleClipVolume);

  const tracksByKey = new Map(
    timelineTracks.map((track) => [`${track.type}-${track.index}`, track]),
  );

  return clips.filter((clip) => {
    if (!hasAudibleClipVolume(clip)) return false;
    const track = tracksByKey.get(`${clip.trackType}-${clip.trackIndex}`);
    if (!track) return false;
    if (track.visible === false) return false;
    if (clip.trackType === "audio" && track.muted) return false;
    if (clip.trackType === "audio" && !hasAudibleVolume(track.volume)) return false;
    return true;
  });
}
