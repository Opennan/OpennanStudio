// Pure optimistic-edit helpers for timeline clips. Copied from opennan frontend
// hooks/use-timeline.ts:225-606 and :740-757. Edits: functions are exported; the
// env flag SUPPORTS_TRANSITION_PARAMS (use-timeline.ts:26) is a constant here;
// the cloud adapter keeps its own field list (phase 8).
import type { TimelineClip, TimelineData } from "../model/timeline";
import { clipMediaStart, clipSpeedProfile, sourceSpan, sourceTimeAt } from "../motion/speed";

const SUPPORTS_TRANSITION_PARAMS = true;
const TIMELINE_MIN_CLIP_DURATION_SECONDS = 0.1;

export function isTimelineClip(clip: TimelineClip | null | undefined): clip is TimelineClip {
  return Boolean(clip);
}

/** Positional optimistic→server id pairs for split-created clips; empty when
 * counts differ (no safe correspondence — history keeps optimistic ids). */
export function buildSplitHistoryIdMap(
  optimisticCreated: TimelineClip[],
  serverCreated: TimelineClip[],
): Map<string, string> {
  if (optimisticCreated.length === 0 || optimisticCreated.length !== serverCreated.length) {
    return new Map();
  }
  return new Map(optimisticCreated.map((clip, index) => [clip.id, serverCreated[index].id]));
}

export function replacePendingClipsWithCreated(
  timeline: TimelineData,
  tempIds: string[],
  createdClips: (TimelineClip | null | undefined)[]
): TimelineData {
  const replacementByTempId = new Map(
    tempIds.map((tempId, index) => [tempId, createdClips[index] ?? null])
  );
  const createdIds = new Set(createdClips.filter(isTimelineClip).map((clip) => clip.id));
  const replacedCreatedIds = new Set<string>();
  const clips = timeline.clips
    .filter((clip) => !createdIds.has(clip.id))
    .map((clip) => {
      const replacement = replacementByTempId.get(clip.id);
      if (!replacement) return clip;
      replacedCreatedIds.add(replacement.id);
      return replacement;
    });
  const missingCreatedClips = createdClips
    .filter(isTimelineClip)
    .filter((clip) => !replacedCreatedIds.has(clip.id));
  return {
    ...timeline,
    clips: [...clips, ...missingCreatedClips],
  };
}

export function getCreatedServerSplitClips(
  splitClipIds: string[],
  serverSplitClips: TimelineClip[],
): TimelineClip[] {
  const splitIdSet = new Set(splitClipIds);
  return serverSplitClips.filter((clip) => !splitIdSet.has(clip.id));
}

export function replaceOptimisticSplitWithServer(
  timeline: TimelineData,
  splitClipIds: string[],
  optimisticCreatedClips: TimelineClip[],
  serverSplitClips: TimelineClip[],
): TimelineData {
  const splitIdSet = new Set(splitClipIds);
  const optimisticCreatedIds = new Set(optimisticCreatedClips.map((clip) => clip.id));
  const replacementsByOriginalId = new Map<string, TimelineClip[]>();

  for (let index = 0; index < serverSplitClips.length; index += 1) {
    const serverClip = serverSplitClips[index];
    if (!splitIdSet.has(serverClip.id)) continue;
    const replacementGroup = [serverClip];
    let nextIndex = index + 1;
    while (nextIndex < serverSplitClips.length && !splitIdSet.has(serverSplitClips[nextIndex].id)) {
      replacementGroup.push(serverSplitClips[nextIndex]);
      nextIndex += 1;
    }
    replacementsByOriginalId.set(serverClip.id, replacementGroup);
  }

  const clips = timeline.clips.flatMap((clip) => {
    if (optimisticCreatedIds.has(clip.id)) return [];
    return replacementsByOriginalId.get(clip.id) ?? [clip];
  });
  const existingIds = new Set(clips.map((clip) => clip.id));
  const missingServerClips = serverSplitClips.filter((clip) => !existingIds.has(clip.id));

  return {
    ...timeline,
    clips: [...clips, ...missingServerClips],
  };
}

export function removeTimelineClipIds(timeline: TimelineData, clipIds: Iterable<string>): TimelineData {
  const removeIds = new Set(clipIds);
  return {
    ...timeline,
    clips: timeline.clips.filter((clip) => !removeIds.has(clip.id)),
  };
}

export const TIMELINE_CLIP_CREATE_FIELD_KEYS = [
  ...(SUPPORTS_TRANSITION_PARAMS ? (["transitionParamsJson"] as const) : []),
  "trackType",
  "trackIndex",
  "startTime",
  "endTime",
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
  "remotionTemplateId",
  "remotionPropsJson",
  "remotionCode",
  "customGraphicId",
  // Phase 10b motion, speed, stickers, caption words (optional; absent on older clips).
  "animationJson",
  "speedCurveJson",
  "preservePitch",
  "stickerId",
  "captionWordsJson",
  // Phase 10c mask (optional; absent on older clips).
  "maskJson",
  // Phase 11 beat times (optional; absent on older clips).
  "beatsJson",
] as const;

/** Phase 10b clip fields copied only when present, so older clips keep their exact shape. */
const OPTIONAL_MOTION_FIELDS = ["animationJson", "speedCurveJson", "preservePitch", "stickerId", "captionWordsJson", "maskJson", "beatsJson"] as const;

function optionalMotionFields(input: Record<string, any>): Partial<TimelineClip> {
  const out: Record<string, unknown> = {};
  for (const key of OPTIONAL_MOTION_FIELDS) {
    if (input[key] !== undefined && input[key] !== null) out[key] = input[key];
  }
  return out as Partial<TimelineClip>;
}

export function sanitizeTimelineClipCreateInput(input: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const key of TIMELINE_CLIP_CREATE_FIELD_KEYS) {
    if (input[key] !== undefined) clean[key] = input[key];
  }
  return clean;
}

export function optimisticTimelineClipFromInput(
  input: Record<string, any>,
  projectId: string,
  id: string,
): TimelineClip {
  return {
    id,
    projectId,
    trackType: input.trackType || "text",
    trackIndex: input.trackIndex ?? 1,
    startTime: input.startTime ?? 0,
    endTime: input.endTime ?? 5,
    mediaUrl: input.mediaUrl || null,
    mediaType: input.mediaType || "uploaded",
    sceneId: input.sceneId || null,
    label: input.label || null,
    thumbnailUrl: input.thumbnailUrl || null,
    locked: input.locked ?? false,
    volume: input.volume ?? 1,
    audioPan: input.audioPan ?? 0,
    audioPitch: input.audioPitch ?? 0,
    audioEq: input.audioEq ?? "none",
    audioDenoise: input.audioDenoise ?? false,
    audioNormalize: input.audioNormalize ?? false,
    playbackSpeed: input.playbackSpeed ?? 1,
    speedRamp: input.speedRamp ?? "none",
    reversePlayback: input.reversePlayback ?? false,
    freezeFrame: input.freezeFrame ?? false,
    fadeInDuration: input.fadeInDuration ?? 0,
    fadeOutDuration: input.fadeOutDuration ?? 0,
    transitionType: input.transitionType ?? "none",
    transitionDuration: input.transitionDuration ?? 0,
    transitionParamsJson: input.transitionParamsJson ?? null,
    opacity: input.opacity ?? 1,
    scale: input.scale ?? 1,
    positionX: input.positionX ?? 0.5,
    positionY: input.positionY ?? 0.5,
    horizontalFlip: input.horizontalFlip ?? false,
    verticalFlip: input.verticalFlip ?? false,
    cropLeft: input.cropLeft ?? 0,
    cropRight: input.cropRight ?? 0,
    cropTop: input.cropTop ?? 0,
    cropBottom: input.cropBottom ?? 0,
    brightness: input.brightness ?? 0,
    contrast: input.contrast ?? 1,
    saturation: input.saturation ?? 1,
    visualFilter: input.visualFilter ?? "none",
    filterIntensity: input.filterIntensity ?? null,
    adjustmentsJson: input.adjustmentsJson ?? null,
    motionPreset: input.motionPreset ?? "none",
    blurStrength: input.blurStrength ?? 0,
    chromaKeyEnabled: input.chromaKeyEnabled ?? false,
    chromaKeyColor: input.chromaKeyColor ?? "0x00FF00",
    chromaKeySimilarity: input.chromaKeySimilarity ?? 0.1,
    chromaKeyBlend: input.chromaKeyBlend ?? 0,
    blendMode: input.blendMode ?? "normal",
    mosaicStrength: input.mosaicStrength ?? 0,
    rotationDegrees: input.rotationDegrees ?? 0,
    keyframesJson: input.keyframesJson || null,
    textContent: input.textContent || null,
    textStyle: input.textStyle || null,
    trimStart: input.trimStart ?? null,
    trimEnd: input.trimEnd ?? null,
    remotionTemplateId: input.remotionTemplateId ?? null,
    remotionPropsJson: input.remotionPropsJson ?? null,
    remotionCode: input.remotionCode ?? null,
    customGraphicId: input.customGraphicId ?? null,
    ...optionalMotionFields(input),
  };
}

export function normalizeServerTimelineClip(input: Record<string, any>): TimelineClip {
  const clip = optimisticTimelineClipFromInput(
    input,
    typeof input.projectId === "string" ? input.projectId : "",
    typeof input.id === "string" ? input.id : "",
  );
  return {
    ...clip,
    aiPrompt: input.aiPrompt ?? null,
    aiReferenceUrls: input.aiReferenceUrls ?? null,
    aiGenerationStatus: input.aiGenerationStatus ?? null,
    aiGenerationError: input.aiGenerationError ?? null,
    aiModelId: input.aiModelId ?? null,
    remotionTemplateId: input.remotionTemplateId ?? null,
    remotionPropsJson: input.remotionPropsJson ?? null,
    remotionCode: input.remotionCode ?? null,
    remotionStatus: input.remotionStatus ?? null,
    remotionError: input.remotionError ?? null,
    customGraphicId: input.customGraphicId ?? null,
    effects: Array.isArray(input.effects) ? input.effects : undefined,
  };
}

export function splitClipKeyframesJson(
  keyframesJson: string | null,
  splitLocalTime: number,
): [string | null, string | null] {
  if (!keyframesJson) return [null, null];

  try {
    const parsed = JSON.parse(keyframesJson);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.keyframes)) {
      return [keyframesJson, keyframesJson];
    }

    const leftKeyframes: Array<Record<string, unknown>> = [];
    const rightKeyframes: Array<Record<string, unknown>> = [];
    let boundaryKeyframe: Record<string, unknown> | null = null;

    for (const rawKeyframe of parsed.keyframes) {
      if (!rawKeyframe || typeof rawKeyframe !== "object" || Array.isArray(rawKeyframe)) continue;
      const rawTime = Number((rawKeyframe as { time?: unknown }).time);
      if (!Number.isFinite(rawTime)) continue;
      const keyframe = { ...(rawKeyframe as Record<string, unknown>) };
      if (rawTime <= splitLocalTime) {
        keyframe.time = rawTime;
        leftKeyframes.push(keyframe);
        boundaryKeyframe = keyframe;
      } else {
        keyframe.time = Math.max(0, rawTime - splitLocalTime);
        rightKeyframes.push(keyframe);
      }
    }

    if (boundaryKeyframe) {
      rightKeyframes.unshift({ ...boundaryKeyframe, time: 0 });
    }

    return [
      leftKeyframes.length > 0 ? JSON.stringify({ keyframes: leftKeyframes }) : null,
      rightKeyframes.length > 0 ? JSON.stringify({ keyframes: rightKeyframes }) : null,
    ];
  } catch {
    return [keyframesJson, keyframesJson];
  }
}

/**
 * A clip's captionWordsJson (clip-local word timings) split at `splitLocalTime`: the right half is re-based
 * to its own start; a word crossing the cut goes to the side holding most of it (ties left) and is clamped
 * there. An empty side is null; unreadable JSON is kept on both halves, as splitClipKeyframesJson does.
 */
export function splitClipCaptionWordsJson(
  captionWordsJson: string | null | undefined,
  splitLocalTime: number,
): [string | null, string | null] {
  if (!captionWordsJson) return [null, null];
  let parsed: unknown;
  try {
    parsed = JSON.parse(captionWordsJson);
  } catch {
    return [captionWordsJson, captionWordsJson];
  }
  if (!Array.isArray(parsed)) return [captionWordsJson, captionWordsJson];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const left: Array<{ start: number; end: number; text: string }> = [];
  const right: Array<{ start: number; end: number; text: string }> = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const { start, end, text } = raw as { start?: unknown; end?: unknown; text?: unknown };
    if (typeof start !== "number" || typeof end !== "number" || typeof text !== "string" || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const wordEnd = Math.max(start, end);
    if (splitLocalTime - start >= wordEnd - splitLocalTime) {
      left.push({ start: round(Math.min(start, splitLocalTime)), end: round(Math.min(wordEnd, splitLocalTime)), text });
    } else {
      right.push({ start: round(Math.max(0, start - splitLocalTime)), end: round(Math.max(0, wordEnd - splitLocalTime)), text });
    }
  }
  return [left.length > 0 ? JSON.stringify(left) : null, right.length > 0 ? JSON.stringify(right) : null];
}

/**
 * A caption clip's captionWordsJson after its left edge moves by `startDelta` seconds while its words stay where
 * they are on the timeline (a left trim or extension): clip-local times shift by -startDelta. Every word is kept,
 * so the words still spell the clip text (karaoke keeps exact timings); a word cut off by the trim collapses to
 * zero length at the new start. Unreadable JSON and a zero delta are returned unchanged.
 */
export function trimClipCaptionWordsJson(captionWordsJson: string | null | undefined, startDelta: number): string | null | undefined {
  if (!captionWordsJson || !Number.isFinite(startDelta) || Math.abs(startDelta) < 1e-9) return captionWordsJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(captionWordsJson);
  } catch {
    return captionWordsJson;
  }
  if (!Array.isArray(parsed)) return captionWordsJson;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const words = parsed.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const { start, end } = raw as { start?: unknown; end?: unknown };
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return raw;
    const nextStart = round(Math.max(0, start - startDelta));
    return { ...(raw as object), start: nextStart, end: round(Math.max(nextStart, Math.max(start, end) - startDelta)) };
  });
  return JSON.stringify(words);
}

function wordTexts(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((w) => (w && typeof w.text === "string" ? w.text : "")) : null;
  } catch {
    return null;
  }
}

/** The text of each half when the whole caption's words spell its text exactly (whitespace-insensitive); else null. */
function captionTextHalves(text: string | null, wordsJson: string | null | undefined, halves: [string | null, string | null]): [string, string] | null {
  const all = wordTexts(wordsJson);
  const norm = (value: string) => value.trim().split(/\s+/).filter(Boolean).join(" ");
  if (!text || !all || norm(all.join(" ")) !== norm(text)) return null;
  const left = wordTexts(halves[0]) ?? [];
  const right = wordTexts(halves[1]) ?? [];
  if (left.length === 0 || right.length === 0) return null;
  return [norm(left.join(" ")), norm(right.join(" "))];
}

/** Stills by their link (an animated GIF plays a range like a video, as on the server). */
const SPLIT_STILL_URL = /\.(png|jpe?g|webp|svg|avif|bmp)(\?|#|$)/i;
const roundTrim = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

/** Audio and video clips that play a range of their media (not images, text, stickers, or graphics). */
function playsMediaRange(clip: TimelineClip): boolean {
  if (clip.trackType !== "audio" && clip.trackType !== "video") return false;
  if (!clip.mediaUrl || clip.mediaType === "image" || SPLIT_STILL_URL.test(clip.mediaUrl)) return false;
  return true;
}

export function createOptimisticSplitClip(
  clip: TimelineClip,
  splitTime: number,
  index: number,
): { left: TimelineClip; right: TimelineClip } | null {
  if (clip.locked) return null;
  if (splitTime <= clip.startTime || splitTime >= clip.endTime) return null;
  if (
    splitTime < clip.startTime + TIMELINE_MIN_CLIP_DURATION_SECONDS ||
    splitTime > clip.endTime - TIMELINE_MIN_CLIP_DURATION_SECONDS
  ) return null;

  const [leftKeyframesJson, rightKeyframesJson] = splitClipKeyframesJson(
    clip.keyframesJson,
    splitTime - clip.startTime,
  );
  const captionWords = clip.captionWordsJson
    ? splitClipCaptionWordsJson(clip.captionWordsJson, splitTime - clip.startTime)
    : null;
  // A caption whose stored words still spell its text splits its text with them, so each half keeps exact
  // word timings (karaoke) instead of repeating the whole caption.
  const splitText = captionWords ? captionTextHalves(clip.textContent, clip.captionWordsJson, captionWords) : null;
  const originalTransitionType = clip.transitionType || "none";
  const originalTransitionDuration = Number.isFinite(clip.transitionDuration) ? clip.transitionDuration : 0;
  const originalFadeOutDuration = Number.isFinite(clip.fadeOutDuration) ? clip.fadeOutDuration : 0;
  const rightFadeOutDuration = originalFadeOutDuration > 0
    ? originalFadeOutDuration
    : originalTransitionType !== "none"
      ? originalTransitionDuration
      : 0;
  const left: TimelineClip = {
    ...clip,
    endTime: splitTime,
    keyframesJson: leftKeyframesJson,
    fadeOutDuration: 0,
    transitionType: "none",
    transitionDuration: 0,
    transitionParamsJson: null,
    ...(captionWords ? { captionWordsJson: captionWords[0] } : {}),
    ...(splitText ? { textContent: splitText[0] } : {}),
  };
  const right: TimelineClip = {
    ...clip,
    id: `optimistic-split-${clip.id}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    startTime: splitTime,
    keyframesJson: rightKeyframesJson,
    fadeInDuration: 0,
    fadeOutDuration: rightFadeOutDuration,
    transitionType: originalTransitionType,
    transitionDuration: originalTransitionDuration,
    transitionParamsJson: clip.transitionParamsJson,
    ...(captionWords ? { captionWordsJson: captionWords[1] } : {}),
    ...(splitText ? { textContent: splitText[1] } : {}),
  };

  // Each half's source range, as opennan.com's split writes it: the range is the one the clip plays, from its
  // in-point (trimStart, or media zero) for its span at its speed. trimEnd is never read for it (an edge drag at speed
  // != 1 can leave it stale); the split writes a consistent out-point. A reversed clip plays the range backwards, so
  // its first half gets the end of the range. Frozen frames, stills, and text keep their trims. Trims round to the
  // microsecond. A speed curve (or legacy ramp) follows Studio's own source-time map, which its preview and both
  // exporters play, so the right half starts where playback was at the cut; the server counts a ramp as its base
  // speed there (a recorded difference; the curve itself is not split between the halves either).
  const totalDuration = clip.endTime - clip.startTime;
  if (totalDuration > 0 && playsMediaRange(clip) && !clip.freezeFrame) {
    const profile = clipSpeedProfile(clip);
    const sourceIn = clipMediaStart(clip);
    const sourceOut = sourceIn + sourceSpan(profile, totalDuration);
    const offset = sourceTimeAt(profile, splitTime - clip.startTime, totalDuration);
    if (clip.reversePlayback) {
      const cut = roundTrim(sourceOut - offset);
      left.trimStart = cut;
      left.trimEnd = roundTrim(sourceOut);
      right.trimStart = roundTrim(sourceIn);
      right.trimEnd = cut;
    } else {
      const cut = roundTrim(sourceIn + offset);
      left.trimStart = roundTrim(sourceIn);
      left.trimEnd = cut;
      right.trimStart = cut;
      right.trimEnd = roundTrim(sourceOut);
    }
  }

  return { left, right };
}

export function createOptimisticSplitTimelineData(
  timeline: TimelineData,
  clipIds: string[],
  splitTime: number,
): { timeline: TimelineData; createdClips: TimelineClip[] } | null {
  const splitIds = new Set(clipIds);
  if (splitIds.size === 0) return null;

  const createdClips: TimelineClip[] = [];
  const clips = timeline.clips.flatMap((clip, index) => {
    if (!splitIds.has(clip.id)) return [clip];
    const split = createOptimisticSplitClip(clip, splitTime, index);
    if (!split) return [clip];
    createdClips.push(split.right);
    return [split.left, split.right];
  });

  if (createdClips.length === 0) return null;
  return {
    timeline: { ...timeline, clips },
    createdClips,
  };
}

// True when the incoming timeline content is structurally identical to what's
// already on screen. Lets applyTimelineData bail out (return the SAME reference)
// so React/the timeline canvas don't redraw — this is what stops the "blink" on
// polls, server reconciles, and undo/redo round-trips that just re-send the state
// already shown locally. Timelines are tens–hundreds of clips (not per-frame work),
// so a stringify compare is cheap relative to a full canvas repaint.
export function sameTimelineContent(
  prev: TimelineData | null,
  tracks: TimelineData["tracks"],
  clips: TimelineClip[],
): boolean {
  if (!prev) return false;
  if (prev.tracks.length !== tracks.length || prev.clips.length !== clips.length) return false;
  return (
    JSON.stringify(prev.tracks) === JSON.stringify(tracks) &&
    JSON.stringify(prev.clips) === JSON.stringify(clips)
  );
}
