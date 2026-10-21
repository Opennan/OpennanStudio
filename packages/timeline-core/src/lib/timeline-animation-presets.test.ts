// Tests for in/out animation presets compiled to clip keyframes.
import { describe, expect, it } from "vitest";

import {
  getTimelineAnimationKeyframes,
  getTimelineApplyAnimationPresetTargetCommits,
  normalizeTimelineAnimationPreset,
} from "./timeline-animation-presets";

const clip = {
  id: "text-1",
  trackType: "text",
  trackIndex: 1,
  startTime: 10,
  endTime: 16,
  scale: 1,
  opacity: 1,
  positionX: 0.5,
  positionY: 0.5,
  rotationDegrees: 0,
  keyframesJson: null,
};

describe("normalizeTimelineAnimationPreset", () => {
  it("accepts known presets case-insensitively and rejects unknowns", () => {
    expect(normalizeTimelineAnimationPreset("Fade")).toBe("fade");
    expect(normalizeTimelineAnimationPreset("slide_left")).toBe("slide_left");
    expect(normalizeTimelineAnimationPreset("wiggle")).toBeNull();
  });
});

describe("getTimelineAnimationKeyframes", () => {
  it("builds an 'in' fade from invisible to the clip's resting opacity", () => {
    const points = getTimelineAnimationKeyframes(clip, "fade", "in", 1);
    expect(points).toEqual([
      { time: 0, opacity: 0 },
      { time: 1, opacity: 1 },
    ]);
  });

  it("builds an 'out' animation anchored at the clip end (clip-local times)", () => {
    const points = getTimelineAnimationKeyframes(clip, "zoom", "out", 1);
    expect(points[0]).toEqual({ time: 5, opacity: 1, scale: 1 });
    expect(points[points.length - 1]).toEqual({ time: 6, opacity: 0, scale: 0.5 });
  });

  it("clamps the animation window to half the clip duration", () => {
    const points = getTimelineAnimationKeyframes(clip, "fade", "in", 100);
    expect(points[points.length - 1].time).toBe(3); // 6s clip → max 3s window
  });

  it("preserves existing keyframes outside the animated window", () => {
    const withKeyframes = {
      ...clip,
      keyframesJson: JSON.stringify({ keyframes: [
        { time: 3, scale: 1.5 },
        { time: 0.5, opacity: 0.4 }, // inside the 1s in-window → replaced
      ] }),
    };
    const points = getTimelineAnimationKeyframes(withKeyframes, "fade", "in", 1);
    expect(points).toEqual([
      { time: 0, opacity: 0 },
      { time: 1, opacity: 1 },
      { time: 3, scale: 1.5 },
    ]);
  });

  it("pop adds an overshoot midpoint", () => {
    const points = getTimelineAnimationKeyframes(clip, "pop", "in", 1);
    expect(points).toHaveLength(3);
    expect(points[1].scale).toBeCloseTo(1.08);
  });

  it("animates relative to the clip's current transform", () => {
    const shifted = { ...clip, positionX: 0.3, scale: 2 };
    const points = getTimelineAnimationKeyframes(shifted, "slide_left", "in", 1);
    expect(points[0].position_x).toBeCloseTo(0.6);
    expect(points[1].position_x).toBeCloseTo(0.3);
  });
});

describe("getTimelineApplyAnimationPresetTargetCommits", () => {
  const tracks = [
    { type: "text", index: 1, locked: false },
    { type: "audio", index: 1, locked: false },
  ];

  it("applies to selected visual clips and skips audio/effect clips", () => {
    const commits = getTimelineApplyAnimationPresetTargetCommits(
      [
        clip,
        { ...clip, id: "audio-1", trackType: "audio" },
      ],
      tracks,
      new Set(["text-1", "audio-1"]),
      null,
      "fade",
      "in",
      1,
    );
    expect(commits).toHaveLength(1);
    expect(commits[0].clipId).toBe("text-1");
    expect(String(commits[0].keyframesJson)).toContain("\"opacity\":0");
  });

  it("returns nothing for unknown presets or empty selection", () => {
    expect(getTimelineApplyAnimationPresetTargetCommits([clip], tracks, new Set(["text-1"]), null, "bogus", "in", 1)).toEqual([]);
    expect(getTimelineApplyAnimationPresetTargetCommits([clip], tracks, new Set(), null, "fade", "in", 1)).toEqual([]);
  });
});
