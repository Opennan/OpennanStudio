// Tests for live keyframe interpolation used by the preview compositor.
import { describe, expect, it } from "vitest";

import { getClipKeyframeValuesAtTime } from "./keyframe-interpolation";

const KEYFRAMES = JSON.stringify({
  keyframes: [
    { time: 0, opacity: 0, scale: 1, position_x: 0.2 },
    { time: 2, opacity: 1, scale: 1.5, position_x: 0.8 },
    { time: 4, volume: 0.5 },
  ],
});

describe("getClipKeyframeValuesAtTime", () => {
  it("returns null for missing, empty, or invalid keyframes", () => {
    expect(getClipKeyframeValuesAtTime(null, 1)).toBeNull();
    expect(getClipKeyframeValuesAtTime("", 1)).toBeNull();
    expect(getClipKeyframeValuesAtTime("not json", 1)).toBeNull();
    expect(getClipKeyframeValuesAtTime("{\"keyframes\":[]}", 1)).toBeNull();
  });

  it("linearly interpolates between surrounding points", () => {
    const values = getClipKeyframeValuesAtTime(KEYFRAMES, 1);
    expect(values?.opacity).toBeCloseTo(0.5);
    expect(values?.scale).toBeCloseTo(1.25);
    expect(values?.positionX).toBeCloseTo(0.5);
  });

  it("clamps before the first and after the last point per channel", () => {
    expect(getClipKeyframeValuesAtTime(KEYFRAMES, -1)?.opacity).toBe(0);
    expect(getClipKeyframeValuesAtTime(KEYFRAMES, 10)?.opacity).toBe(1);
    expect(getClipKeyframeValuesAtTime(KEYFRAMES, 10)?.scale).toBe(1.5);
  });

  it("interpolates each channel only across points that define it", () => {
    // volume exists only at t=4 — it is constant everywhere.
    expect(getClipKeyframeValuesAtTime(KEYFRAMES, 0)?.volume).toBe(0.5);
    expect(getClipKeyframeValuesAtTime(KEYFRAMES, 5)?.volume).toBe(0.5);
    // opacity is defined at 0 and 2; at t=3 it stays at the last value.
    expect(getClipKeyframeValuesAtTime(KEYFRAMES, 3)?.opacity).toBe(1);
  });

  it("omits channels that were never keyframed", () => {
    const values = getClipKeyframeValuesAtTime(KEYFRAMES, 1);
    expect(values?.rotationDegrees).toBeUndefined();
  });

  it("applies the easing stored on the left point (keyframes v2)", () => {
    const eased = JSON.stringify({ keyframes: [{ time: 0, scale: 1, easing: 1 }, { time: 2, scale: 3 }] });
    // ease in (cubic) at half way: 1 + 2 * 0.5^3
    expect(getClipKeyframeValuesAtTime(eased, 1)?.scale).toBeCloseTo(1.25, 12);
  });
});
