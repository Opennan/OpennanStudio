// Live keyframe interpolation for the web preview. Keyframes are authored on
// clips as clip-local {time, channel...} points (see parseTimelineKeyframes);
// the curves (with per-point easing) are motion/keyframes.ts, the same ones the
// export evaluates, so the preview matches the exported render.

import { channelValueAt, hasChannel } from "../motion/keyframes";
import { parseTimelineKeyframes } from "./timeline-editing-properties";

export interface ClipKeyframeValues {
  scale?: number;
  opacity?: number;
  positionX?: number;
  positionY?: number;
  rotationDegrees?: number;
  volume?: number;
}

const CHANNEL_MAP: Record<string, keyof ClipKeyframeValues> = {
  scale: "scale",
  opacity: "opacity",
  position_x: "positionX",
  position_y: "positionY",
  rotation_degrees: "rotationDegrees",
  volume: "volume",
};

/**
 * Interpolate a clip's keyframed channels at a clip-local time (seconds since
 * clip start). Returns null when the clip has no keyframes so callers can fall
 * back to the clip's static values cheaply.
 */
export function getClipKeyframeValuesAtTime(
  keyframesJson: string | null | undefined,
  localTime: number,
): ClipKeyframeValues | null {
  if (!keyframesJson) return null;
  const points = parseTimelineKeyframes(keyframesJson);
  if (points.length === 0) return null;
  const time = Math.max(0, localTime);
  const out: ClipKeyframeValues = {};
  let any = false;
  for (const [channel, key] of Object.entries(CHANNEL_MAP)) {
    if (!hasChannel(points, channel)) continue;
    out[key] = channelValueAt(points, channel, time, 0);
    any = true;
  }
  return any ? out : null;
}
