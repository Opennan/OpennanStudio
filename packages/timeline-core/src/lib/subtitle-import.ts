// Client-side SRT/VTT subtitle parsing and timeline clip-plan generation.
// Parses a subtitle file into cues, then maps cues onto text-track clip
// creation inputs styled with the caption/subtitle presets.

import { getTimelineTextStylePreset } from "./timeline-text-style";
import { roundTimelineTime } from "./timeline-editing-shared";
import type { TimelineDuplicateInput } from "./timeline-editing-shared";

export interface SubtitleCue {
  startTime: number;
  endTime: number;
  text: string;
  /** Word timings in absolute seconds (auto-captions); SRT/VTT cues have none. */
  words?: Array<{ start: number; end: number; text: string }>;
}

export type SubtitleImportKind = "subtitle" | "caption";

const MIN_CUE_DURATION = 0.1;

function parseTimestamp(raw: string): number | null {
  // Accepts HH:MM:SS,mmm (SRT), HH:MM:SS.mmm and MM:SS.mmm (VTT).
  const match = raw.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4].padEnd(3, "0"));
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function cleanCueText(lines: string[]): string {
  return lines
    .map((line) => line
      // VTT voice/karaoke/formatting tags: <v Name>, <c.class>, <b>, <i>, <00:00:01.000>
      .replace(/<[^>]*>/g, "")
      // SRT formatting tags occasionally written with {}: {\an8}, {i}
      .replace(/\{\\?[^}]*\}/g, "")
      .trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/** Parse SRT or WebVTT content into ordered, sanitized cues. */
export function parseSubtitleFile(content: string): SubtitleCue[] {
  const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const isVtt = /^WEBVTT\b/.test(text.trimStart());
  const blocks = text.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    if (isVtt && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1 || timingIndex > 1) continue;

    const [rawStart, rawEndWithSettings] = lines[timingIndex].split("-->");
    if (!rawEndWithSettings) continue;
    // VTT cue settings (position/line/align) trail the end timestamp.
    const rawEnd = rawEndWithSettings.trim().split(/\s+/)[0];
    const startTime = parseTimestamp(rawStart ?? "");
    const endTime = parseTimestamp(rawEnd ?? "");
    if (startTime === null || endTime === null || endTime <= startTime) continue;

    const cueText = cleanCueText(lines.slice(timingIndex + 1));
    if (!cueText) continue;

    cues.push({ startTime, endTime, text: cueText });
  }

  return cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

/**
 * Split cues into one cue per word for karaoke-style captions, distributing
 * each cue's duration across its words proportional to word length. The
 * reference editors need word-level speech timestamps for this; approximating
 * from cue timing lets any plain SRT/VTT drive word-by-word captions.
 */
export function splitSubtitleCuesIntoWords(cues: SubtitleCue[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter((word) => word.length > 0);
    const duration = cue.endTime - cue.startTime;
    if (words.length <= 1 || duration <= 0) {
      out.push(cue);
      continue;
    }
    const totalLength = words.reduce((sum, word) => sum + word.length, 0);
    let cursor = cue.startTime;
    words.forEach((word, index) => {
      const isLast = index === words.length - 1;
      const share = duration * (word.length / totalLength);
      const end = isLast ? cue.endTime : Math.min(cue.endTime, cursor + share);
      out.push({ startTime: cursor, endTime: end, text: word });
      cursor = end;
    });
  }
  return out;
}

/**
 * A caption clip's captionWordsJson: the cue's words re-based to the clip's start (clip-local seconds, rounded
 * to ms), clamped inside the clip and kept in order. Undefined when there are no usable words.
 */
export function captionWordsJsonForClip(
  words: SubtitleCue["words"],
  clipStart: number,
  clipEnd: number,
): string | undefined {
  if (!Array.isArray(words) || words.length === 0) return undefined;
  const duration = roundTimelineTime(clipEnd - clipStart);
  const local: Array<{ start: number; end: number; text: string }> = [];
  let previous = 0;
  for (const word of words) {
    if (!word || typeof word.text !== "string" || !Number.isFinite(word.start) || !Number.isFinite(word.end)) return undefined;
    const text = word.text.trim();
    if (!text) continue;
    const start = Math.max(previous, Math.min(duration, roundTimelineTime(word.start - clipStart)));
    const end = Math.max(start, Math.min(duration, roundTimelineTime(word.end - clipStart)));
    local.push({ start, end, text });
    previous = start;
  }
  return local.length > 0 ? JSON.stringify(local) : undefined;
}

export interface SubtitleImportTrack {
  type: string;
  index: number;
  locked?: boolean;
  visible?: boolean;
}

/**
 * Map parsed cues onto timeline clip creation inputs on the first editable
 * text track. Cues are clamped so consecutive clips never overlap (a hard
 * timeline invariant); zero-length results are dropped. Cues are also trimmed
 * against clips already on the target track — trimming (not shifting) keeps
 * the imported subtitles in sync with the audio.
 */
export function getTimelineSubtitleImportInputs(
  cues: SubtitleCue[],
  tracks: SubtitleImportTrack[],
  kind: SubtitleImportKind = "subtitle",
  styleOverrides: Record<string, string | number> | null = null,
  existingClips: Array<{ trackType?: unknown; trackIndex?: unknown; startTime: number; endTime: number }> = [],
): TimelineDuplicateInput[] {
  const textTrack = tracks
    .filter((track) => track.type === "text" && !track.locked && track.visible !== false)
    .sort((a, b) => a.index - b.index)[0];
  const trackIndex = textTrack?.index ?? 1;
  const occupied = existingClips
    .filter((clip) => clip.trackType === "text" && clip.trackIndex === trackIndex)
    .map((clip) => ({ startTime: clip.startTime, endTime: clip.endTime }))
    .sort((a, b) => a.startTime - b.startTime);
  const baseStyle = JSON.parse(getTimelineTextStylePreset(kind)) as Record<string, string | number>;
  const textStyle = JSON.stringify(styleOverrides ? { ...baseStyle, ...styleOverrides } : baseStyle);
  const positionY = kind === "caption" ? 0.82 : 0.88;

  const inputs: TimelineDuplicateInput[] = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const nextStart = i + 1 < cues.length ? cues[i + 1].startTime : Number.POSITIVE_INFINITY;
    const startTime = roundTimelineTime(Math.max(0, cue.startTime));
    const endTime = roundTimelineTime(Math.min(cue.endTime, nextStart));
    if (endTime - startTime < MIN_CUE_DURATION) continue;

    // Carve the cue around clips already on the track; each surviving span
    // stays at its original time so the subtitles remain audio-synced.
    let segments = [{ startTime, endTime }];
    for (const block of occupied) {
      const next: typeof segments = [];
      for (const seg of segments) {
        if (block.endTime <= seg.startTime + 0.001 || block.startTime >= seg.endTime - 0.001) {
          next.push(seg);
          continue;
        }
        if (block.startTime > seg.startTime + 0.001) next.push({ startTime: seg.startTime, endTime: roundTimelineTime(block.startTime) });
        if (block.endTime < seg.endTime - 0.001) next.push({ startTime: roundTimelineTime(block.endTime), endTime: seg.endTime });
      }
      segments = next;
    }

    // Word timings only when the clip still holds its whole cue: carved pieces repeat the full text.
    const whole = segments.length === 1 && segments[0].startTime === startTime && segments[0].endTime === endTime;
    for (const seg of segments) {
      if (seg.endTime - seg.startTime < MIN_CUE_DURATION) continue;
      const captionWordsJson = whole ? captionWordsJsonForClip(cue.words, seg.startTime, seg.endTime) : undefined;
      inputs.push({
        trackType: "text",
        trackIndex,
        startTime: seg.startTime,
        endTime: seg.endTime,
        textContent: cue.text,
        textStyle,
        positionX: 0.5,
        positionY,
        scale: 1,
        opacity: 1,
        ...(captionWordsJson ? { captionWordsJson } : {}),
      });
    }
  }
  return inputs;
}
