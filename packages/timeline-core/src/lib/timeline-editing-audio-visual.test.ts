// Unit tests for audio, visual transform, playback speed, fade, and transition timeline editing tests.
import { meanCurveSpeed, serializeSpeedCurve, speedCurvePreset } from "../motion/speed";
import { describe, expect, it } from "vitest";
import {
  getTimelineBladeSplitClipIdsAtTime,
  getTimelineBladeSplitClipId,
  getTimelineDeleteTrackUpdates,
  getTimelineSoloTrackUpdates,
  getTimelineToggleClipMuteTargetCommits,
  getTimelineSetClipVolumeTargetCommits,
  getTimelineSetClipAudioPanTargetCommits,
  getTimelineSetClipAudioPitchTargetCommits,
  getTimelineSetClipAudioEqTargetCommits,
  getTimelineToggleClipAudioNormalizeTargetCommits,
  getTimelineToggleClipAudioDenoiseTargetCommits,
  getTimelineResetClipVolumeTargetCommits,
  getTimelineResetClipTrimTargetCommits,
  getTimelineResetVisualTransformTargetCommits,
  getTimelineSetVisualScaleTargetCommits,
  getTimelineSetVisualPositionTargetCommits,
  getTimelineSetVisualOpacityTargetCommits,
  getTimelineSetVisualCropTargetCommits,
  getTimelineSetVisualColorTargetCommits,
  getTimelineSetVisualFilterTargetCommits,
  getTimelineSetVisualMotionPresetTargetCommits,
  getTimelineSetVisualBlurTargetCommits,
  getTimelineSetVisualChromaKeyTargetCommits,
  getTimelineSetVisualBlendModeTargetCommits,
  getTimelineSetVisualMosaicTargetCommits,
  getTimelineSetVisualRotationTargetCommits,
  getTimelineRotateVisualTargetCommits,
  getTimelineToggleHorizontalFlipTargetCommits,
  getTimelineToggleVerticalFlipTargetCommits,
  getTimelineToggleClipVisibilityTargetCommits,
  getTimelineSetDurationTargetCommits,
  getTimelineFitSelectionToMarkerRangeTargetCommits,
  getTimelineSetFadeEdgeTargetCommits,
  getTimelineSetFadeTargetCommits,
  getTimelineSetTransitionPresetTargetCommits,
  getTimelineTransitionPresetUpdate,
  normalizeTimelineTransitionType,
  getTimelineSetPlaybackSpeedTargetCommits,
  getTimelineSetSpeedRampTargetCommits,
  getTimelineSetTextStylePresetTargetCommits,
  getTimelineToggleFreezeFrameTargetCommits,
  getTimelineToggleReversePlaybackTargetCommits,
  getTimelineTextStylePreset,
} from "./timeline-editing";

describe("getTimelineSoloTrackUpdates", () => {
  it("mutes other audio tracks and unmutes the soloed audio track", () => {
    expect(
      getTimelineSoloTrackUpdates(
        [
          { type: "audio", index: 1, locked: false, muted: false, visible: true },
          { type: "audio", index: 2, locked: false, muted: false, visible: true },
          { type: "video", index: 1, locked: false, muted: false, visible: true },
        ],
        "audio-2",
      ),
    ).toEqual([
      { type: "audio", index: 1, locked: false, muted: true, visible: true },
      { type: "audio", index: 2, locked: false, muted: false, visible: true },
      { type: "video", index: 1, locked: false, muted: false, visible: true },
    ]);
  });

  it("restores same-type tracks when the target is already soloed", () => {
    expect(
      getTimelineSoloTrackUpdates(
        [
          { type: "video", index: 1, locked: false, muted: false, visible: false },
          { type: "video", index: 2, locked: false, muted: false, visible: true },
          { type: "text", index: 1, locked: false, muted: false, visible: true },
        ],
        "video-2",
      ),
    ).toEqual([
      { type: "video", index: 1, locked: false, muted: false, visible: true },
      { type: "video", index: 2, locked: false, muted: false, visible: true },
      { type: "text", index: 1, locked: false, muted: false, visible: true },
    ]);
  });

  it("returns the original track list when the target key is unknown", () => {
    const tracks = [{ type: "text", index: 1, locked: false, muted: false, visible: true }];

    expect(getTimelineSoloTrackUpdates(tracks, "audio-1")).toBe(tracks);
  });
});

describe("getTimelineDeleteTrackUpdates", () => {
  it("removes a non-base track while preserving the remaining tracks", () => {
    const tracks = [
      { type: "video", index: 1, label: "V1" },
      { type: "video", index: 2, label: "V2" },
      { type: "audio", index: 1, label: "A1" },
    ];

    expect(getTimelineDeleteTrackUpdates(tracks, "video-2")).toEqual([
      { type: "video", index: 1, label: "V1" },
      { type: "audio", index: 1, label: "A1" },
    ]);
  });

  it("keeps base video and audio tracks intact", () => {
    const tracks = [
      { type: "video", index: 1, label: "V1" },
      { type: "video", index: 2, label: "V2" },
      { type: "audio", index: 1, label: "A1" },
      { type: "audio", index: 2, label: "A2" },
    ];

    expect(getTimelineDeleteTrackUpdates(tracks, "video-1")).toBe(tracks);
    expect(getTimelineDeleteTrackUpdates(tracks, "audio-1")).toBe(tracks);
  });

  it("keeps locked tracks intact", () => {
    const tracks = [
      { type: "video", index: 1, label: "V1", locked: false },
      { type: "video", index: 2, label: "V2", locked: true },
      { type: "video", index: 3, label: "V3", locked: false },
    ];

    expect(getTimelineDeleteTrackUpdates(tracks, "video-2")).toBe(tracks);
  });

  it("allows deleting optional overlay tracks even when they are the only one of that type", () => {
    const tracks = [
      { type: "video", index: 1, label: "V1" },
      { type: "text", index: 1, label: "T1" },
    ];

    expect(getTimelineDeleteTrackUpdates(tracks, "text-1")).toEqual([
      { type: "video", index: 1, label: "V1" },
    ]);
  });

  it("keeps the last remaining video or audio track intact", () => {
    const tracks = [
      { type: "video", index: 1, label: "V1" },
      { type: "audio", index: 1, label: "A1" },
    ];

    expect(getTimelineDeleteTrackUpdates(tracks, "video-1")).toBe(tracks);
    expect(getTimelineDeleteTrackUpdates(tracks, "audio-1")).toBe(tracks);
  });
});

describe("getTimelineToggleClipMuteTargetCommits", () => {
  it("mutes selected editable video and audio clips while preserving timing", () => {
    expect(
      getTimelineToggleClipMuteTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, volume: 0.8 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, volume: 1 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, volume: 1 },
          { id: "clip-locked-audio", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 7, volume: 1, locked: true },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, volume: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "clip-locked-audio", "locked-audio"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, volume: 0 },
      { clipId: "audio-1", startTime: 2, endTime: 6, volume: 0 },
    ]);
  });

  it("unmutes selected media clips when every selected media clip is muted", () => {
    expect(
      getTimelineToggleClipMuteTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, volume: 0 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, volume: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "audio-1",
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 2, endTime: 6, volume: 1 },
    ]);
  });
});

describe("getTimelineSetClipVolumeTargetCommits", () => {
  it("sets selected editable video and audio clip volume while preserving timing", () => {
    expect(
      getTimelineSetClipVolumeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, volume: 0.8 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, volume: 1 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, volume: 1 },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, volume: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "locked-audio"]),
        null,
        0.5,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, volume: 0.5 },
      { clipId: "audio-1", startTime: 2, endTime: 6, volume: 0.5 },
    ]);
  });

  it("falls back to the active media clip and clamps volume", () => {
    expect(
      getTimelineSetClipVolumeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, volume: 0.25 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, volume: 0.6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        3,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, volume: 2 },
    ]);
  });
});

describe("getTimelineSetClipAudioPanTargetCommits", () => {
  it("sets selected editable video and audio clip pan while preserving timing", () => {
    expect(
      getTimelineSetClipAudioPanTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioPan: 0 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioPan: -0.5 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, audioPan: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "locked-audio"]),
        null,
        0.75,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, audioPan: 0.75 },
      { clipId: "audio-1", startTime: 2, endTime: 6, audioPan: 0.75 },
    ]);
  });

  it("falls back to the active media clip and clamps pan", () => {
    expect(
      getTimelineSetClipAudioPanTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioPan: 0 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioPan: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "audio-1",
        -3,
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 2, endTime: 6, audioPan: -1 },
    ]);
  });
});

describe("getTimelineSetClipAudioPitchTargetCommits", () => {
  it("sets selected editable video and audio clip pitch while preserving timing", () => {
    expect(
      getTimelineSetClipAudioPitchTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioPitch: 0 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioPitch: -2 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, audioPitch: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "locked-audio"]),
        null,
        7,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, audioPitch: 7 },
      { clipId: "audio-1", startTime: 2, endTime: 6, audioPitch: 7 },
    ]);
  });

  it("falls back to the active media clip and clamps pitch semitones", () => {
    expect(
      getTimelineSetClipAudioPitchTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioPitch: 0 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioPitch: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "audio-1",
        -20,
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 2, endTime: 6, audioPitch: -12 },
    ]);
  });
});

describe("getTimelineSetClipAudioEqTargetCommits", () => {
  it("sets selected editable video and audio clip EQ presets while preserving timing", () => {
    expect(
      getTimelineSetClipAudioEqTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioEq: "none" },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioEq: "vocal" },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, audioEq: "none" },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "locked-audio"]),
        null,
        "bass",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, audioEq: "bass" },
      { clipId: "audio-1", startTime: 2, endTime: 6, audioEq: "bass" },
    ]);
  });

  it("falls back to the active media clip and normalizes unsupported presets", () => {
    expect(
      getTimelineSetClipAudioEqTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioEq: "none" },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioEq: "bass" },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "audio-1",
        "robot",
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 2, endTime: 6, audioEq: "none" },
    ]);
  });
});

describe("getTimelineToggleClipAudioDenoiseTargetCommits", () => {
  it("toggles selected editable video and audio clip denoise while preserving timing", () => {
    expect(
      getTimelineToggleClipAudioDenoiseTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioDenoise: false },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioDenoise: true },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, audioDenoise: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "locked-audio"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, audioDenoise: true },
      { clipId: "audio-1", startTime: 2, endTime: 6, audioDenoise: false },
    ]);
  });

  it("falls back to the active media clip when there is no multi-selection", () => {
    expect(
      getTimelineToggleClipAudioDenoiseTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioDenoise: false },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioDenoise: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "audio-1",
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 2, endTime: 6, audioDenoise: true },
    ]);
  });
});

describe("getTimelineToggleClipAudioNormalizeTargetCommits", () => {
  it("toggles selected editable video and audio clip loudness normalization while preserving timing", () => {
    expect(
      getTimelineToggleClipAudioNormalizeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioNormalize: false },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioNormalize: true },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, audioNormalize: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "locked-audio"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, audioNormalize: true },
      { clipId: "audio-1", startTime: 2, endTime: 6, audioNormalize: false },
    ]);
  });

  it("falls back to the active media clip when there is no multi-selection", () => {
    expect(
      getTimelineToggleClipAudioNormalizeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, audioNormalize: false },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, audioNormalize: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "audio-1",
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 2, endTime: 6, audioNormalize: true },
    ]);
  });
});

describe("getTimelineResetClipVolumeTargetCommits", () => {
  it("resets selected editable video and audio clip volume while preserving timing", () => {
    expect(
      getTimelineResetClipVolumeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, volume: 0.25 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, volume: 0 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, volume: 0.2 },
          { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 5, volume: 0.2 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "audio-1", "text-1", "locked-audio"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, volume: 1 },
      { clipId: "audio-1", startTime: 2, endTime: 6, volume: 1 },
    ]);
  });

  it("falls back to the active media clip when multi-selection is empty", () => {
    expect(
      getTimelineResetClipVolumeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, volume: 0.25 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, volume: 0.6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, volume: 1 },
    ]);
  });
});

describe("getTimelineResetClipTrimTargetCommits", () => {
  it("resets selected editable clip source trims while preserving timeline timing", () => {
    expect(
      getTimelineResetClipTrimTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, trimStart: 4, trimEnd: 9 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, trimStart: 1, trimEnd: 5 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 1, endTime: 7, trimStart: null, trimEnd: 8 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, trimStart: 2, trimEnd: 7 },
          { id: "plain", trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 3 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1", "audio-1", "locked-video", "plain"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, trimStart: null, trimEnd: null },
      { clipId: "audio-1", startTime: 1, endTime: 7, trimStart: null, trimEnd: null },
      { clipId: "text-1", startTime: 2, endTime: 6, trimStart: null, trimEnd: null },
    ]);
  });

  it("falls back to the active clip and skips no-op clips with no trims", () => {
    expect(
      getTimelineResetClipTrimTargetCommits(
        [
          { id: "plain", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "trimmed", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 7, trimStart: 3, trimEnd: null },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "trimmed",
      ),
    ).toEqual([
      { clipId: "trimmed", startTime: 2, endTime: 7, trimStart: null, trimEnd: null },
    ]);
  });
});

describe("getTimelineToggleClipVisibilityTargetCommits", () => {
  it("hides selected editable visual clips while preserving timing", () => {
    expect(
      getTimelineToggleClipVisibilityTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, opacity: 0.8 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, opacity: 1 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 7, opacity: 1 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, opacity: 1 },
          { id: "clip-locked-video", trackType: "video", trackIndex: 1, startTime: 1, endTime: 4, opacity: 1, locked: true },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, opacity: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1", "sticker-1", "audio-1", "clip-locked-video", "locked-video"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, opacity: 0 },
      { clipId: "text-1", startTime: 2, endTime: 6, opacity: 0 },
      { clipId: "sticker-1", startTime: 4, endTime: 7, opacity: 0 },
    ]);
  });

  it("shows the active visual clip when it is already hidden", () => {
    expect(
      getTimelineToggleClipVisibilityTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, opacity: 0 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, opacity: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, opacity: 1 },
    ]);
  });
});

describe("getTimelineSetVisualOpacityTargetCommits", () => {
  it("sets selected editable visual clip opacity while preserving timing", () => {
    expect(
      getTimelineSetVisualOpacityTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, opacity: 0.8 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, opacity: 1 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 7, opacity: 1 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, opacity: 1 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, opacity: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1", "sticker-1", "audio-1", "locked-video"]),
        null,
        0.5,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, opacity: 0.5 },
      { clipId: "text-1", startTime: 2, endTime: 6, opacity: 0.5 },
      { clipId: "sticker-1", startTime: 4, endTime: 7, opacity: 0.5 },
    ]);
  });

  it("falls back to the active visual clip and clamps opacity", () => {
    expect(
      getTimelineSetVisualOpacityTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, opacity: 0.8 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, opacity: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        2,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, opacity: 1 },
    ]);
  });
});

describe("getTimelineSetVisualBlendModeTargetCommits", () => {
  it("sets selected editable visual clip blend modes while preserving timing", () => {
    expect(
      getTimelineSetVisualBlendModeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, blendMode: "normal" },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 7 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1", "sticker-1", "audio-1", "locked-video"]),
        null,
        "multiply",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, blendMode: "multiply" },
      { clipId: "text-1", startTime: 2, endTime: 6, blendMode: "multiply" },
      { clipId: "sticker-1", startTime: 4, endTime: 7, blendMode: "multiply" },
    ]);
  });

  it("falls back to the active visual clip and normalizes unsupported modes", () => {
    expect(
      getTimelineSetVisualBlendModeTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, blendMode: "screen" },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        "difference",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, blendMode: "normal" },
    ]);
  });
});

describe("getTimelineSetVisualScaleTargetCommits", () => {
  it("sets selected editable visual clip scale while preserving timing", () => {
    expect(
      getTimelineSetVisualScaleTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, scale: 0.8 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, scale: 1 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 7, scale: 1 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, scale: 1 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, scale: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1", "sticker-1", "audio-1", "locked-video"]),
        null,
        1.5,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, scale: 1.5 },
      { clipId: "text-1", startTime: 2, endTime: 6, scale: 1.5 },
      { clipId: "sticker-1", startTime: 4, endTime: 7, scale: 1.5 },
    ]);
  });

  it("falls back to the active visual clip and clamps scale", () => {
    expect(
      getTimelineSetVisualScaleTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, scale: 0.8 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, scale: 1 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        -2,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, scale: 0.1 },
    ]);
  });
});

describe("getTimelineSetVisualPositionTargetCommits", () => {
  it("sets selected editable visual clip position while preserving timing", () => {
    expect(
      getTimelineSetVisualPositionTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, positionX: 0.2, positionY: 0.3 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, positionX: 0.2, positionY: 0.3 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 7, positionX: 0.2, positionY: 0.3 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, positionX: 0.2, positionY: 0.3 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, positionX: 0.2, positionY: 0.3 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1", "sticker-1", "audio-1", "locked-video"]),
        null,
        0.5,
        0.5,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, positionX: 0.5, positionY: 0.5 },
      { clipId: "text-1", startTime: 2, endTime: 6, positionX: 0.5, positionY: 0.5 },
      { clipId: "sticker-1", startTime: 4, endTime: 7, positionX: 0.5, positionY: 0.5 },
    ]);
  });

  it("falls back to the active visual clip and clamps normalized position", () => {
    expect(
      getTimelineSetVisualPositionTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, positionX: 0.2, positionY: 0.3 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, positionX: 0.2, positionY: 0.3 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        -1,
        2,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, positionX: 0, positionY: 1 },
    ]);
  });
});

describe("getTimelineResetVisualTransformTargetCommits", () => {
  it("resets selected editable visual clip transform fields while preserving timing", () => {
    expect(
      getTimelineResetVisualTransformTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, opacity: 0.4, scale: 1.6, positionX: 20, positionY: -10, rotationDegrees: 90, horizontalFlip: true, verticalFlip: true, cropLeft: 0.1, cropRight: 0.2, cropTop: 0.05, cropBottom: 0.15 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, opacity: 0.8, scale: 1.2, positionX: -5, positionY: 12, rotationDegrees: 180, horizontalFlip: true, verticalFlip: true, cropLeft: 0.1, cropRight: 0.2, cropTop: 0.05, cropBottom: 0.15 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, opacity: 0.5, scale: 0.5, positionX: 4, positionY: 8, rotationDegrees: 270, horizontalFlip: true, verticalFlip: true, cropLeft: 0.1, cropRight: 0.2, cropTop: 0.05, cropBottom: 0.15 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, opacity: 0.5, scale: 2, positionX: 10, positionY: 10 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, opacity: 0.1, scale: 2, positionX: 10, positionY: 10 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1", "sticker-1", "audio-1", "locked-video"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, opacity: 1, scale: 1, positionX: 0, positionY: 0, rotationDegrees: 0, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", filterIntensity: null, adjustmentsJson: null, motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false, blendMode: "normal", mosaicStrength: 0 },
      { clipId: "text-1", startTime: 2, endTime: 6, opacity: 1, scale: 1, positionX: 0, positionY: 0, rotationDegrees: 0, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", filterIntensity: null, adjustmentsJson: null, motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false, blendMode: "normal", mosaicStrength: 0 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, opacity: 1, scale: 1, positionX: 0, positionY: 0, rotationDegrees: 0, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", filterIntensity: null, adjustmentsJson: null, motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false, blendMode: "normal", mosaicStrength: 0 },
    ]);
  });

  it("falls back to the active visual clip when multi-selection is empty", () => {
    expect(
      getTimelineResetVisualTransformTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, opacity: 0.4, scale: 1.6, positionX: 20, positionY: -10 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, opacity: 0.8, scale: 1.2, positionX: -5, positionY: 12 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "text-1",
      ),
    ).toEqual([
      { clipId: "text-1", startTime: 2, endTime: 6, opacity: 1, scale: 1, positionX: 0, positionY: 0, rotationDegrees: 0, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", filterIntensity: null, adjustmentsJson: null, motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false, blendMode: "normal", mosaicStrength: 0 },
    ]);
  });
});

describe("getTimelineSetVisualCropTargetCommits", () => {
  it("sets selected editable visual media crop margins while preserving timing", () => {
    expect(
      getTimelineSetVisualCropTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        { cropLeft: 0.1, cropRight: 0.2, cropTop: 0.05, cropBottom: 0.15 },
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, cropLeft: 0.1, cropRight: 0.2, cropTop: 0.05, cropBottom: 0.15 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, cropLeft: 0.1, cropRight: 0.2, cropTop: 0.05, cropBottom: 0.15 },
    ]);
  });

  it("falls back to the active visual media clip and clamps impossible crop pairs", () => {
    expect(
      getTimelineSetVisualCropTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        { cropLeft: 0.8, cropRight: 0.8, cropTop: -1, cropBottom: 2 },
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, cropLeft: 0.475, cropRight: 0.475, cropTop: 0, cropBottom: 0.95 },
    ]);
  });
});

describe("getTimelineSetVisualColorTargetCommits", () => {
  it("sets selected editable visual media color adjustments while preserving timing", () => {
    expect(
      getTimelineSetVisualColorTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        { brightness: 0.08, contrast: 1.25, saturation: 0.75 },
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, brightness: 0.08, contrast: 1.25, saturation: 0.75 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, brightness: 0.08, contrast: 1.25, saturation: 0.75 },
    ]);
  });

  it("falls back to the active visual media clip and clamps adjustment ranges", () => {
    expect(
      getTimelineSetVisualColorTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        { brightness: 2, contrast: -5, saturation: 9 },
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, brightness: 1, contrast: 0, saturation: 3 },
    ]);
  });
});

describe("getTimelineSetVisualFilterTargetCommits", () => {
  it("sets selected editable visual media filter presets while preserving timing", () => {
    expect(
      getTimelineSetVisualFilterTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, visualFilter: "none" },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, visualFilter: "cool" },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        "cinematic",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, visualFilter: "cinematic" },
      { clipId: "sticker-1", startTime: 3, endTime: 7, visualFilter: "cinematic" },
    ]);
  });

  it("falls back to the active visual media clip and normalizes unsupported filters", () => {
    expect(
      getTimelineSetVisualFilterTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, visualFilter: "warm" },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        "not_a_filter",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, visualFilter: "none" },
    ]);
  });
});

describe("getTimelineSetVisualMotionPresetTargetCommits", () => {
  it("sets selected editable visual media motion presets while preserving timing", () => {
    expect(
      getTimelineSetVisualMotionPresetTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, motionPreset: "none" },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, motionPreset: "zoom_out" },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        "zoom_in",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, motionPreset: "zoom_in" },
      { clipId: "sticker-1", startTime: 3, endTime: 7, motionPreset: "zoom_in" },
    ]);
  });

  it("falls back to the active visual media clip and normalizes unsupported presets", () => {
    expect(
      getTimelineSetVisualMotionPresetTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, motionPreset: "zoom_in" },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        "bounce",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, motionPreset: "none" },
    ]);
  });
});

describe("getTimelineSetTextStylePresetTargetCommits", () => {
  it("sets selected editable text clip style presets while preserving timing", () => {
    const captionStyle = getTimelineTextStylePreset("caption");

    expect(
      getTimelineSetTextStylePresetTargetCommits(
        [
          { id: "caption-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, textStyle: null },
          { id: "caption-2", trackType: "text", trackIndex: 1, startTime: 3, endTime: 7, textStyle: "{}" },
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-caption", trackType: "text", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
          { type: "video", index: 1, locked: false },
        ],
        new Set(["caption-1", "caption-2", "video-1", "locked-caption"]),
        null,
        "caption",
      ),
    ).toEqual([
      { clipId: "caption-1", startTime: 0, endTime: 5, textStyle: captionStyle },
      { clipId: "caption-2", startTime: 3, endTime: 7, textStyle: captionStyle },
    ]);
  });

  it("falls back to the active text clip and normalizes unsupported presets", () => {
    const defaultStyle = getTimelineTextStylePreset("title");

    expect(
      getTimelineSetTextStylePresetTargetCommits(
        [
          { id: "caption-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, textStyle: null },
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "video", index: 1, locked: false },
        ],
        new Set(),
        "caption-1",
        "meme",
      ),
    ).toEqual([
      { clipId: "caption-1", startTime: 0, endTime: 5, textStyle: defaultStyle },
    ]);
  });
});

describe("getTimelineSetVisualBlurTargetCommits", () => {
  it("sets selected editable visual media blur strength while preserving timing", () => {
    expect(
      getTimelineSetVisualBlurTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        8,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, blurStrength: 8 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, blurStrength: 8 },
    ]);
  });

  it("falls back to the active visual media clip and clamps blur strength", () => {
    expect(
      getTimelineSetVisualBlurTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        80,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, blurStrength: 20 },
    ]);
  });
});

describe("getTimelineSetVisualChromaKeyTargetCommits", () => {
  it("sets selected editable visual media chroma key while preserving timing", () => {
    expect(
      getTimelineSetVisualChromaKeyTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        { enabled: true, color: "#00FF00", similarity: 0.22, blend: 0.08 },
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, chromaKeyEnabled: true, chromaKeyColor: "0x00FF00", chromaKeySimilarity: 0.22, chromaKeyBlend: 0.08 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, chromaKeyEnabled: true, chromaKeyColor: "0x00FF00", chromaKeySimilarity: 0.22, chromaKeyBlend: 0.08 },
    ]);
  });

  it("falls back to the active visual media clip and clamps chroma settings", () => {
    expect(
      getTimelineSetVisualChromaKeyTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        { enabled: false, color: "bad", similarity: 4, blend: -1 },
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, chromaKeyEnabled: false, chromaKeyColor: "0x00FF00", chromaKeySimilarity: 1, chromaKeyBlend: 0 },
    ]);
  });
});

describe("getTimelineSetVisualMosaicTargetCommits", () => {
  it("sets selected editable visual media mosaic strength while preserving timing", () => {
    expect(
      getTimelineSetVisualMosaicTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        12,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, mosaicStrength: 12 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, mosaicStrength: 12 },
    ]);
  });

  it("falls back to the active visual media clip and clamps mosaic strength", () => {
    expect(
      getTimelineSetVisualMosaicTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        80,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, mosaicStrength: 64 },
    ]);
  });
});

describe("getTimelineRotateVisualTargetCommits", () => {
  it("rotates selected editable visual media clips by 90 degree steps", () => {
    expect(
      getTimelineRotateVisualTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, rotationDegrees: 0 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, rotationDegrees: 270 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, rotationDegrees: 180 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, rotationDegrees: 0 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, rotationDegrees: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        90,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, rotationDegrees: 90 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, rotationDegrees: 0 },
    ]);
  });

  it("falls back to the active visual media clip and normalizes negative rotation", () => {
    expect(
      getTimelineRotateVisualTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, rotationDegrees: 0 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, rotationDegrees: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        -90,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, rotationDegrees: 270 },
    ]);
  });
});

describe("getTimelineSetVisualRotationTargetCommits", () => {
  it("sets selected editable visual media clip rotation to an absolute quarter turn", () => {
    expect(
      getTimelineSetVisualRotationTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, rotationDegrees: 0 },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, rotationDegrees: 270 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, rotationDegrees: 180 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, rotationDegrees: 0 },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, rotationDegrees: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
        180,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, rotationDegrees: 180 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, rotationDegrees: 180 },
    ]);
  });

  it("falls back to the active visual media clip and normalizes arbitrary angles", () => {
    expect(
      getTimelineSetVisualRotationTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, rotationDegrees: 0 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, rotationDegrees: 0 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
        -95,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, rotationDegrees: 270 },
    ]);
  });
});

describe("getTimelineToggleHorizontalFlipTargetCommits", () => {
  it("toggles horizontal flip on selected editable visual media clips while preserving timing", () => {
    expect(
      getTimelineToggleHorizontalFlipTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, horizontalFlip: false },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, horizontalFlip: true },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, horizontalFlip: false },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, horizontalFlip: false },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, horizontalFlip: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, horizontalFlip: true },
      { clipId: "sticker-1", startTime: 3, endTime: 7, horizontalFlip: false },
    ]);
  });

  it("falls back to the active visual media clip when multi-selection is empty", () => {
    expect(
      getTimelineToggleHorizontalFlipTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, horizontalFlip: true },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, horizontalFlip: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, horizontalFlip: false },
    ]);
  });
});

describe("getTimelineToggleVerticalFlipTargetCommits", () => {
  it("toggles vertical flip on selected editable visual media clips while preserving timing", () => {
    expect(
      getTimelineToggleVerticalFlipTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, verticalFlip: false },
          { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, verticalFlip: true },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, verticalFlip: false },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 5, verticalFlip: false },
          { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 5, verticalFlip: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["video-1", "sticker-1", "text-1", "audio-1", "locked-video"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, verticalFlip: true },
      { clipId: "sticker-1", startTime: 3, endTime: 7, verticalFlip: false },
    ]);
  });

  it("falls back to the active visual media clip when multi-selection is empty", () => {
    expect(
      getTimelineToggleVerticalFlipTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, verticalFlip: true },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, verticalFlip: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
        ],
        new Set(),
        "video-1",
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, verticalFlip: false },
    ]);
  });
});

describe("getTimelineBladeSplitClipId", () => {
  it("allows the blade tool to split only editable clips at a valid interior time", () => {
    const clips = [
      { id: "video-locked", trackType: "video", trackIndex: 1, startTime: 0, endTime: 8 },
      { id: "text-open", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8 },
      { id: "audio-edge", trackType: "audio", trackIndex: 1, startTime: 4.95, endTime: 8 },
    ];
    const tracks = [
      { type: "video", index: 1, locked: true },
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
    ];

    expect(getTimelineBladeSplitClipId(clips, tracks, "video-locked", 4)).toBeNull();
    expect(getTimelineBladeSplitClipId(clips, tracks, "audio-edge", 5)).toBeNull();
    expect(getTimelineBladeSplitClipId(clips, tracks, "text-open", 4)).toBe("text-open");
  });
});

describe("getTimelineBladeSplitClipIdsAtTime", () => {
  it("returns every editable clip under the blade cursor while skipping locked tracks and edge hits", () => {
    const result = getTimelineBladeSplitClipIdsAtTime(
      [
        { id: "video-open", trackType: "video", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "text-open", trackType: "text", trackIndex: 1, startTime: 1, endTime: 9 },
        { id: "audio-locked", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "sticker-edge", trackType: "sticker", trackIndex: 1, startTime: 4.96, endTime: 8 },
        { id: "video-outside", trackType: "video", trackIndex: 2, startTime: 6, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "video", index: 2, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: true },
        { type: "sticker", index: 1, locked: false },
      ],
      5,
    );

    expect(result).toEqual(["video-open", "text-open"]);
  });
});

describe("getTimelineSetDurationTargetCommits", () => {
  it("sets selected editable clip durations from their current starts while skipping locked tracks", () => {
    const result = getTimelineSetDurationTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 8 },
        { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 4.25, endTime: 9 },
        { id: "locked-video", trackType: "video", trackIndex: 1, startTime: 1, endTime: 9 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
        { type: "video", index: 1, locked: true },
      ],
      new Set(["text-1", "sticker-1", "locked-video"]),
      null,
      3,
    );

    expect(result).toEqual([
      { clipId: "text-1", startTime: 2, endTime: 5 },
      { clipId: "sticker-1", startTime: 4.25, endTime: 7.25 },
    ]);
  });

  it("falls back to the active clip and clamps tiny durations", () => {
    const result = getTimelineSetDurationTargetCommits(
      [{ id: "active", trackType: "text", trackIndex: 1, startTime: 1, endTime: 7 }],
      [{ type: "text", index: 1, locked: false }],
      new Set(),
      "active",
      0.01,
    );

    expect(result).toEqual([{ clipId: "active", startTime: 1, endTime: 1.1 }]);
  });
});

describe("getTimelineSetPlaybackSpeedTargetCommits", () => {
  it("sets selected editable media clip playback speed while skipping locked tracks", () => {
    const result = getTimelineSetPlaybackSpeedTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5 },
        { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 6 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video-1", "audio-1", "text-1", "locked-video"]),
      null,
      2,
    );

    // speed.set semantics: the length follows the speed (source span kept), a normal speed clears any curve.
    expect(result).toEqual([
      { clipId: "audio-1", startTime: 4, endTime: 6.5, playbackSpeed: 2, speedCurveJson: null, preservePitch: true, speedRamp: "none" },
      { clipId: "video-1", startTime: 2, endTime: 5, playbackSpeed: 2, speedCurveJson: null, preservePitch: true, speedRamp: "none" },
    ]);
  });

  it("rescales keyframes, clears curves, and pushes the next clip on the track like speed.set", () => {
    const result = getTimelineSetPlaybackSpeedTargetCommits(
      [
        { id: "a", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4, speedRamp: "hero", keyframesJson: '{"keyframes":[{"time":2,"scale":2}]}' },
        { id: "b", trackType: "video", trackIndex: 1, startTime: 4, endTime: 6 },
      ],
      [{ type: "video", index: 1, locked: false }],
      new Set(["a"]),
      null,
      0.5,
    );
    // The legacy hero ramp (mean 0.79: 4 s of timeline = 3.16 s of source) becomes 0.5x without a curve: 6.32 s.
    expect(result[0]).toMatchObject({ clipId: "a", startTime: 0, endTime: 6.32, playbackSpeed: 0.5, speedRamp: "none", speedCurveJson: null });
    expect(JSON.parse(result[0].keyframesJson!).keyframes).toHaveLength(1);
    expect(result[1]).toEqual({ clipId: "b", startTime: 6.32, endTime: 8.32 });
  });

  it("falls back to the active clip and clamps speed into an editable range", () => {
    const result = getTimelineSetPlaybackSpeedTargetCommits(
      [{ id: "active", trackType: "video", trackIndex: 1, startTime: 1, endTime: 7 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      "active",
      100,
    );

    expect(result).toEqual([{ clipId: "active", startTime: 1, endTime: 1.75, playbackSpeed: 8, speedCurveJson: null, preservePitch: true, speedRamp: "none" }]);
  });
});

describe("getTimelineSetSpeedRampTargetCommits", () => {
  it("sets selected editable media clip speed ramp presets while skipping locked tracks", () => {
    const result = getTimelineSetSpeedRampTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8, playbackSpeed: 2 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5 },
        { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 6 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video-1", "audio-1", "text-1", "locked-video"]),
      null,
      "montage",
    );

    // speed.set semantics: the ramp becomes the matching curve preset at 1x, the length follows its mean speed.
    const montage = speedCurvePreset("montage")!;
    const mean = meanCurveSpeed(montage);
    expect(result.map((c) => c.clipId)).toEqual(["audio-1", "video-1"]);
    expect(result[0]).toMatchObject({ startTime: 4, playbackSpeed: 1, speedRamp: "none", speedCurveJson: serializeSpeedCurve(montage) });
    expect(result[0].endTime).toBeCloseTo(4 + 5 / mean, 6);
    // video-1 played at 2x: 12 s of source.
    expect(result[1].endTime).toBeCloseTo(2 + 12 / mean, 6);
  });

  it("falls back to the active clip and normalizes unknown ramp presets to none", () => {
    const result = getTimelineSetSpeedRampTargetCommits(
      [{ id: "active", trackType: "video", trackIndex: 1, startTime: 1, endTime: 7 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      "active",
      "wild",
    );

    expect(result).toEqual([{ clipId: "active", startTime: 1, endTime: 7, playbackSpeed: 1, speedCurveJson: null, preservePitch: true, speedRamp: "none" }]);
  });
});

describe("getTimelineToggleReversePlaybackTargetCommits", () => {
  it("toggles reverse playback on selected editable media clips while skipping locked tracks", () => {
    const result = getTimelineToggleReversePlaybackTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8, reversePlayback: false },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9, reversePlayback: true },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5 },
        { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 6, reversePlayback: false },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video-1", "audio-1", "text-1", "locked-video"]),
      null,
    );

    expect(result).toEqual([
      { clipId: "audio-1", startTime: 4, endTime: 9, reversePlayback: false },
      { clipId: "video-1", startTime: 2, endTime: 8, reversePlayback: true },
    ]);
  });

  it("falls back to the active clip when there is no multi-selection", () => {
    const result = getTimelineToggleReversePlaybackTargetCommits(
      [{ id: "active", trackType: "video", trackIndex: 1, startTime: 1, endTime: 7, reversePlayback: true }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      "active",
    );

    expect(result).toEqual([{ clipId: "active", startTime: 1, endTime: 7, reversePlayback: false }]);
  });
});

describe("getTimelineToggleFreezeFrameTargetCommits", () => {
  it("toggles freeze frame on selected editable video clips while skipping non-video and locked clips", () => {
    const result = getTimelineToggleFreezeFrameTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8, freezeFrame: false },
        { id: "video-2", trackType: "video", trackIndex: 1, startTime: 9, endTime: 12, freezeFrame: true },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9 },
        { id: "locked-clip", trackType: "video", trackIndex: 1, startTime: 6, endTime: 10, locked: true },
        { id: "locked-track-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 6, freezeFrame: false },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video-1", "video-2", "audio-1", "locked-clip", "locked-track-video"]),
      null,
    );

    expect(result).toEqual([
      { clipId: "video-1", startTime: 2, endTime: 8, freezeFrame: true },
      { clipId: "video-2", startTime: 9, endTime: 12, freezeFrame: false },
    ]);
  });

  it("falls back to the active video clip when there is no multi-selection", () => {
    const result = getTimelineToggleFreezeFrameTargetCommits(
      [{ id: "active", trackType: "video", trackIndex: 1, startTime: 1, endTime: 7, freezeFrame: true }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      "active",
    );

    expect(result).toEqual([{ clipId: "active", startTime: 1, endTime: 7, freezeFrame: false }]);
  });
});

describe("getTimelineSetFadeTargetCommits", () => {
  it("sets fade in and out durations on editable media clips while skipping locked tracks", () => {
    const result = getTimelineSetFadeTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5 },
        { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7 },
        { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 6 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video-1", "audio-1", "text-1", "sticker-1", "locked-video"]),
      null,
      0.5,
      1.25,
    );

    expect(result).toEqual([
      { clipId: "audio-1", startTime: 4, endTime: 9, fadeInDuration: 0.5, fadeOutDuration: 1.25 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, fadeInDuration: 0.5, fadeOutDuration: 1.25 },
      { clipId: "text-1", startTime: 1, endTime: 5, fadeInDuration: 0.5, fadeOutDuration: 1.25 },
      { clipId: "video-1", startTime: 2, endTime: 8, fadeInDuration: 0.5, fadeOutDuration: 1.25 },
    ]);
  });

  it("falls back to the active clip and clamps fades to half the clip duration", () => {
    const result = getTimelineSetFadeTargetCommits(
      [{ id: "active", trackType: "video", trackIndex: 1, startTime: 1, endTime: 3 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      "active",
      10,
      -1,
    );

    expect(result).toEqual([{ clipId: "active", startTime: 1, endTime: 3, fadeInDuration: 1, fadeOutDuration: 0 }]);
  });
});

describe("getTimelineFitSelectionToMarkerRangeTargetCommits", () => {
  it("fits the editable selected clip group proportionally into the marker range", () => {
    expect(
      getTimelineFitSelectionToMarkerRangeTargetCommits(
        [
          { id: "first", trackType: "video", trackIndex: 1, startTime: 10, endTime: 12 },
          { id: "second", trackType: "audio", trackIndex: 1, startTime: 14, endTime: 18 },
          { id: "locked", trackType: "text", trackIndex: 1, startTime: 10, endTime: 18 },
          { id: "unselected", trackType: "video", trackIndex: 2, startTime: 11, endTime: 12 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "text", index: 1, locked: true },
          { type: "video", index: 2, locked: false },
        ],
        new Set(["first", "second", "locked"]),
        null,
        [
          { id: "in", time: 20 },
          { id: "out", time: 26 },
        ],
        22,
      ),
    ).toEqual([
      { clipId: "first", startTime: 20, endTime: 21.5 },
      { clipId: "second", startTime: 23, endTime: 26 },
    ]);
  });

  it("fits the active clip exactly to the marker range when no multi-selection exists", () => {
    expect(
      getTimelineFitSelectionToMarkerRangeTargetCommits(
        [{ id: "active", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5 }],
        [{ type: "video", index: 1, locked: false }],
        new Set(),
        "active",
        [
          { id: "in", time: 8 },
          { id: "out", time: 11 },
        ],
        9,
      ),
    ).toEqual([
      { clipId: "active", startTime: 8, endTime: 11 },
    ]);
  });

  it("returns no commits without an editable selection or complete marker bracket", () => {
    expect(getTimelineFitSelectionToMarkerRangeTargetCommits(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      null,
      [{ id: "in", time: 8 }],
      9,
    )).toEqual([]);
  });
});

describe("getTimelineSetFadeEdgeTargetCommits", () => {
  it("sets only fade in while preserving existing fade out durations", () => {
    const result = getTimelineSetFadeEdgeTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8, fadeOutDuration: 1.25 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9, fadeOutDuration: 0.25 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5, fadeOutDuration: 0.25 },
        { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, fadeOutDuration: 0.75 },
        { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 6, fadeOutDuration: 0.25 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video-1", "audio-1", "text-1", "sticker-1", "locked-video"]),
      null,
      "in",
      0.5,
    );

    expect(result).toEqual([
      { clipId: "audio-1", startTime: 4, endTime: 9, fadeInDuration: 0.5, fadeOutDuration: 0.25 },
      { clipId: "sticker-1", startTime: 3, endTime: 7, fadeInDuration: 0.5, fadeOutDuration: 0.75 },
      { clipId: "text-1", startTime: 1, endTime: 5, fadeInDuration: 0.5, fadeOutDuration: 0.25 },
      { clipId: "video-1", startTime: 2, endTime: 8, fadeInDuration: 0.5, fadeOutDuration: 1.25 },
    ]);
  });

  it("sets only fade out while preserving existing fade in durations and clamping to half duration", () => {
    const result = getTimelineSetFadeEdgeTargetCommits(
      [{ id: "active", trackType: "video", trackIndex: 1, startTime: 1, endTime: 3, fadeInDuration: 0.25 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      "active",
      "out",
      10,
    );

    expect(result).toEqual([{ clipId: "active", startTime: 1, endTime: 3, fadeInDuration: 0.25, fadeOutDuration: 1 }]);
  });
});

describe("getTimelineSetTransitionPresetTargetCommits", () => {
  it("normalizes transition catalog ids to persisted timeline presets", () => {
    expect(normalizeTimelineTransitionType("crossfade")).toBe("cross_dissolve");
    expect(normalizeTimelineTransitionType("dissolve")).toBe("cross_dissolve");
    expect(normalizeTimelineTransitionType("fade_black")).toBe("dip_black");
    expect(normalizeTimelineTransitionType("fade_white")).toBe("dip_white");
    expect(normalizeTimelineTransitionType("slide_left")).toBe("slide_left");
    expect(normalizeTimelineTransitionType("slideleft")).toBe("slide_left");
    expect(normalizeTimelineTransitionType("wipe_left")).toBe("wipe_left");
    expect(normalizeTimelineTransitionType("zoomin")).toBe("zoom_in");
    expect(normalizeTimelineTransitionType("blur_dissolve")).toBe("blur_dissolve");
    expect(normalizeTimelineTransitionType("nonsense_wipe")).toBe("none");
    expect(getTimelineTransitionPresetUpdate("fade_black", 0.75, { startTime: 0, endTime: 1 })).toEqual({
      transitionType: "dip_black",
      transitionDuration: 0.5,
      fadeInDuration: 0.5,
      fadeOutDuration: 0.5,
      transitionParamsJson: null,
    });
  });

  it("sets transition presets only on selected video clips while skipping locked tracks", () => {
    const result = getTimelineSetTransitionPresetTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8 },
        { id: "video-next", trackType: "video", trackIndex: 1, startTime: 8, endTime: 12 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9 },
        { id: "audio-next", trackType: "audio", trackIndex: 1, startTime: 9, endTime: 12 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5 },
        { id: "text-next", trackType: "text", trackIndex: 1, startTime: 5, endTime: 8 },
        { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7 },
        { id: "sticker-next", trackType: "sticker", trackIndex: 1, startTime: 7, endTime: 10 },
        { id: "locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 6 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video-1", "audio-1", "text-1", "sticker-1", "locked-video"]),
      null,
      "dip_black",
      0.75,
    );

    expect(result).toEqual([
      { clipId: "video-1", startTime: 2, endTime: 8, transitionType: "dip_black", transitionDuration: 0.75, fadeInDuration: 0.75, fadeOutDuration: 0.75, transitionParamsJson: null },
    ]);
  });

  it("does not set transition presets when the incoming adjacent clip is locked", () => {
    const result = getTimelineSetTransitionPresetTargetCommits(
      [
        { id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "incoming", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10, locked: true },
      ],
      [{ type: "video", index: 1, locked: false }],
      new Set(["outgoing"]),
      null,
      "crossfade",
      0.5,
    );

    expect(result).toEqual([]);
  });

  it("clears stale transition fields from selected non-video clips", () => {
    const result = getTimelineSetTransitionPresetTargetCommits(
      [
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9, transitionType: "dip_black", transitionDuration: 0.75 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 5, transitionType: "dip_black", transitionDuration: 0.75 },
        { id: "sticker-1", trackType: "sticker", trackIndex: 1, startTime: 3, endTime: 7, transitionType: "dip_black", transitionDuration: 0.75 },
      ],
      [
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
      ],
      new Set(["audio-1", "text-1", "sticker-1"]),
      null,
      "none",
      0,
    );

    expect(result).toEqual([
      { clipId: "audio-1", startTime: 4, endTime: 9, transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, transitionParamsJson: null },
      { clipId: "sticker-1", startTime: 3, endTime: 7, transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, transitionParamsJson: null },
      { clipId: "text-1", startTime: 1, endTime: 5, transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, transitionParamsJson: null },
    ]);
  });

  it("falls back to the active media clip and normalizes unsupported presets", () => {
    const result = getTimelineSetTransitionPresetTargetCommits(
      [{ id: "active", trackType: "video", trackIndex: 1, startTime: 1, endTime: 3 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(),
      "active",
      "warp_speed",
      10,
    );

    expect(result).toEqual([
      { clipId: "active", startTime: 1, endTime: 3, transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, transitionParamsJson: null },
    ]);
  });

  it("does not create a real transition on a final clip without an adjacent next clip", () => {
    const result = getTimelineSetTransitionPresetTargetCommits(
      [{ id: "final", trackType: "video", trackIndex: 1, startTime: 3, endTime: 6 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(["final"]),
      null,
      "cross_dissolve",
      0.5,
    );

    expect(result).toEqual([]);
  });

  it("still clears a stale transition value on a final clip", () => {
    const result = getTimelineSetTransitionPresetTargetCommits(
      [{ id: "final", trackType: "video", trackIndex: 1, startTime: 3, endTime: 6, transitionType: "dip_black", transitionDuration: 0.5 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(["final"]),
      null,
      "none",
      0,
    );

    expect(result).toEqual([
      { clipId: "final", startTime: 3, endTime: 6, transitionType: "none", transitionDuration: 0, fadeInDuration: 0, fadeOutDuration: 0, transitionParamsJson: null },
    ]);
  });
});
