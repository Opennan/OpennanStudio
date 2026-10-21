// Unit tests for selection, marker, zoom, and marker-range timeline editing tests.
import { describe, expect, it } from "vitest";
import {
  copyTimelineClips,
  getTimelineReplaceMarkerRangePastePlan,
  getTimelineOverwriteMarkerRangePastePlan,
  getTimelineInsertMarkerRangePastePlan,
  getTimelineInsertMarkerOutPastePlan,
  getTimelineOverwriteMarkerOutPastePlan,
  getAdjacentTimelineMarkerTime,
  getNearestTimelineMarkerId,
  getNextTimelineZoom,
  getTimelineFitZoom,
  getTimelinePlayheadCenterScrollLeft,
  getTimelineSelectionBoundaryTime,
  getTimelineSelectionFitScrollLeft,
  getTimelineSelectionFitZoom,
  getTimelineCloseGapPlan,
  getTimelineToggleClipLockTargetCommits,
  getTimelineLinkedSelectionClipIds,
  getTimelineMarkerRangeSelectionClipIds,
  getTimelineLiftMarkerRangePlan,
  getTimelineLiftMarkerRangeToClipboardPlan,
  getTimelineExtractMarkerRangePlan,
  getTimelineExtractMarkerRangeToClipboardPlan,
  copyTimelineMarkerRange,
  duplicateTimelineMarkerRange,
  getTimelineInsertDuplicateMarkerRangePlan,
  getTimelineOverwriteDuplicateMarkerRangePlan,
  getTimelineSelectedClipBoundaryMarkerTimes,
  getTimelineSelectedRangeMarkerTargets,
  getTimelineTypeSelectionClipIds,
  getToggledTimelineSnap,
} from "./timeline-editing";

describe("getTimelineToggleClipLockTargetCommits", () => {
  it("locks selected editable clips while preserving timing", () => {
    expect(
      getTimelineToggleClipLockTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, locked: false },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, locked: false },
          { id: "track-locked-audio", trackType: "audio", trackIndex: 2, startTime: 4, endTime: 8, locked: false },
          { id: "hidden-sticker", trackType: "sticker", trackIndex: 1, startTime: 1, endTime: 3, locked: false },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "sticker", index: 1, locked: false, visible: false },
        ],
        new Set(["video-1", "text-1", "track-locked-audio", "hidden-sticker"]),
        null,
      ),
    ).toEqual([
      { clipId: "video-1", startTime: 0, endTime: 5, locked: true },
      { clipId: "text-1", startTime: 2, endTime: 6, locked: true },
    ]);
  });

  it("unlocks selected locked clips even though regular edit helpers skip them", () => {
    expect(
      getTimelineToggleClipLockTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5, locked: true },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 6, locked: true },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(),
        "audio-1",
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 2, endTime: 6, locked: false },
    ]);
  });
});

describe("getTimelineLinkedSelectionClipIds", () => {
  it("selects editable clips that share a scene with the current selection", () => {
    expect(
      getTimelineLinkedSelectionClipIds(
        [
          { id: "video-scene-1", sceneId: "scene-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4 },
          { id: "caption-scene-1", sceneId: "scene-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 4 },
          { id: "audio-scene-1", sceneId: "scene-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4 },
          { id: "video-scene-2", sceneId: "scene-2", trackType: "video", trackIndex: 1, startTime: 5, endTime: 8 },
          { id: "loose-overlay", sceneId: null, trackType: "sticker", trackIndex: 1, startTime: 1, endTime: 3 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: true },
          { type: "sticker", index: 1, locked: false },
        ],
        new Set(["video-scene-1"]),
        null,
      ),
    ).toEqual(new Set(["video-scene-1", "caption-scene-1"]));
  });

  it("falls back to the editable current selection when no selected clip has scene linkage", () => {
    expect(
      getTimelineLinkedSelectionClipIds(
        [
          { id: "loose-overlay", sceneId: null, trackType: "sticker", trackIndex: 1, startTime: 1, endTime: 3 },
          { id: "locked-title", sceneId: null, trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
        ],
        [
          { type: "sticker", index: 1, locked: false },
          { type: "text", index: 1, locked: true },
        ],
        new Set(["loose-overlay", "locked-title"]),
        null,
      ),
    ).toEqual(new Set(["loose-overlay"]));
  });
});

describe("getTimelineTypeSelectionClipIds", () => {
  it("selects editable clips that share the selected clip track type", () => {
    expect(
      getTimelineTypeSelectionClipIds(
        [
          { id: "caption-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "caption-2", trackType: "text", trackIndex: 2, startTime: 2, endTime: 4 },
          { id: "locked-caption", trackType: "text", trackIndex: 3, startTime: 4, endTime: 6 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: false },
          { type: "text", index: 3, locked: true },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["caption-1"]),
        null,
      ),
    ).toEqual(new Set(["caption-1", "caption-2"]));
  });

  it("supports multi-type selections and falls back to the selected clip id", () => {
    expect(
      getTimelineTypeSelectionClipIds(
        [
          { id: "caption-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "caption-2", trackType: "text", trackIndex: 2, startTime: 2, endTime: 4 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: false },
        ],
        new Set(),
        "caption-1",
      ),
    ).toEqual(new Set(["caption-1", "caption-2"]));

    expect(
      getTimelineTypeSelectionClipIds(
        [
          { id: "caption-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "caption-2", trackType: "text", trackIndex: 2, startTime: 2, endTime: 4 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "audio-2", trackType: "audio", trackIndex: 2, startTime: 2, endTime: 4 },
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: false },
          { type: "video", index: 1, locked: false },
        ],
        new Set(["caption-1", "audio-1"]),
        null,
      ),
    ).toEqual(new Set(["caption-1", "caption-2", "audio-1", "audio-2"]));
  });

  it("does not use locked clips as type-selection anchors", () => {
    expect(
      getTimelineTypeSelectionClipIds(
        [
          { id: "locked-caption", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, locked: true },
          { id: "editable-caption", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["locked-caption"]),
        null,
      ),
    ).toEqual(new Set());
  });
});

describe("getNextTimelineZoom", () => {
  it("zooms in and out while clamping to timeline zoom limits", () => {
    expect(getNextTimelineZoom(30, 1)).toBe(50);
    expect(getNextTimelineZoom(30, -1)).toBe(25);
    expect(getNextTimelineZoom(390, 1)).toBe(400);
    expect(getNextTimelineZoom(26, -1)).toBe(25);
  });
});

describe("getTimelineFitZoom", () => {
  it("fits the timeline content to the available width with exact zoom", () => {
    expect(getTimelineFitZoom(1056, 100)).toBe(4.44);
    expect(getTimelineFitZoom(300, 100)).toBe(1);
    expect(getTimelineFitZoom(20000, 10)).toBe(400);
    expect(getTimelineFitZoom(300, 0)).toBeNull();
  });
});

describe("getTimelineSelectionFitZoom", () => {
  it("fits the selected editable clip range to the available width", () => {
    expect(
      getTimelineSelectionFitZoom(
        856,
        [
          { id: "left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "selected-a", trackType: "text", trackIndex: 1, startTime: 10, endTime: 14 },
          { id: "selected-b", trackType: "audio", trackIndex: 1, startTime: 12, endTime: 18 },
          { id: "locked-selected", trackType: "video", trackIndex: 1, startTime: 8, endTime: 20 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: true },
        ],
        new Set(["selected-a", "selected-b", "locked-selected"]),
        null,
      ),
    ).toBe(43);
  });

  it("returns null when there is no editable selected duration to fit", () => {
    expect(
      getTimelineSelectionFitZoom(
        856,
        [{ id: "locked-selected", trackType: "video", trackIndex: 1, startTime: 8, endTime: 20 }],
        [{ type: "video", index: 1, locked: true }],
        new Set(["locked-selected"]),
        null,
      ),
    ).toBeNull();
  });
});

describe("getTimelineSelectionFitScrollLeft", () => {
  it("centers the selected editable clip range at the target zoom", () => {
    expect(
      getTimelineSelectionFitScrollLeft(
        800,
        50,
        [
          { id: "left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "selected-a", trackType: "text", trackIndex: 1, startTime: 10, endTime: 14 },
          { id: "selected-b", trackType: "audio", trackIndex: 1, startTime: 12, endTime: 18 },
          { id: "locked-selected", trackType: "video", trackIndex: 1, startTime: 30, endTime: 40 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: true },
        ],
        new Set(["selected-a", "selected-b", "locked-selected"]),
        null,
      ),
    ).toBe(300);
  });

  it("clamps selected-range scroll to the start of the timeline", () => {
    expect(
      getTimelineSelectionFitScrollLeft(
        800,
        50,
        [{ id: "selected", trackType: "text", trackIndex: 1, startTime: 1, endTime: 2 }],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
      ),
    ).toBe(0);
  });
});

describe("getTimelinePlayheadCenterScrollLeft", () => {
  it("centers the playhead in the visible timeline at the current zoom", () => {
    expect(getTimelinePlayheadCenterScrollLeft(800, 50, 20)).toBe(600);
  });

  it("clamps playhead centering to the start of the timeline and rejects invalid inputs", () => {
    expect(getTimelinePlayheadCenterScrollLeft(800, 50, 2)).toBe(0);
    expect(getTimelinePlayheadCenterScrollLeft(800, 0, 20)).toBeNull();
    expect(getTimelinePlayheadCenterScrollLeft(0, 50, 20)).toBeNull();
    expect(getTimelinePlayheadCenterScrollLeft(800, 50, Number.NaN)).toBeNull();
  });
});

describe("getTimelineSelectionBoundaryTime", () => {
  it("returns the editable selected group start or end while skipping locked clips", () => {
    const clips = [
      { id: "left", trackType: "text", trackIndex: 1, startTime: 2, endTime: 5 },
      { id: "right", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 10 },
      { id: "locked-wide", trackType: "video", trackIndex: 1, startTime: 0, endTime: 20 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
      { type: "video", index: 1, locked: true },
    ];

    expect(getTimelineSelectionBoundaryTime(clips, tracks, new Set(["left", "right", "locked-wide"]), null, "start"))
      .toBe(2);
    expect(getTimelineSelectionBoundaryTime(clips, tracks, new Set(["left", "right", "locked-wide"]), null, "end"))
      .toBe(10);
  });

  it("falls back to the active editable clip and returns null without editable selection", () => {
    expect(
      getTimelineSelectionBoundaryTime(
        [{ id: "active", trackType: "text", trackIndex: 1, startTime: 4, endTime: 7 }],
        [{ type: "text", index: 1, locked: false }],
        new Set(),
        "active",
        "start",
      ),
    ).toBe(4);
    expect(
      getTimelineSelectionBoundaryTime(
        [{ id: "locked", trackType: "video", trackIndex: 1, startTime: 4, endTime: 7 }],
        [{ type: "video", index: 1, locked: true }],
        new Set(["locked"]),
        null,
        "end",
      ),
    ).toBeNull();
  });
});

describe("getToggledTimelineSnap", () => {
  it("toggles the snap enabled state", () => {
    expect(getToggledTimelineSnap(true)).toBe(false);
    expect(getToggledTimelineSnap(false)).toBe(true);
  });
});

describe("getAdjacentTimelineMarkerTime", () => {
  it("returns previous and next marker times while skipping the current marker", () => {
    const markers = [
      { id: "marker-1", time: 2 },
      { id: "marker-2", time: 5 },
      { id: "marker-3", time: 9 },
    ];

    expect(getAdjacentTimelineMarkerTime(markers, 5, -1)).toBe(2);
    expect(getAdjacentTimelineMarkerTime(markers, 5, 1)).toBe(9);
    expect(getAdjacentTimelineMarkerTime(markers, 20, 1)).toBeNull();
  });
});

describe("getNearestTimelineMarkerId", () => {
  it("returns the nearest marker within the threshold", () => {
    const markers = [
      { id: "marker-1", time: 4.8 },
      { id: "marker-2", time: 5.08 },
      { id: "marker-3", time: 5.2 },
    ];

    expect(getNearestTimelineMarkerId(markers, 5, 0.15)).toBe("marker-2");
    expect(getNearestTimelineMarkerId(markers, 10, 0.15)).toBeNull();
  });
});

describe("getTimelineMarkerRangeSelectionClipIds", () => {
  it("selects editable clips inside the marker bracket around the playhead", () => {
    expect(
      getTimelineMarkerRangeSelectionClipIds(
        [
          { id: "before", trackType: "video", trackIndex: 1, startTime: 1, endTime: 2 },
          { id: "inside-video", trackType: "video", trackIndex: 1, startTime: 3.2, endTime: 5 },
          { id: "inside-caption", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6 },
          { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 3.5, endTime: 6.5 },
          { id: "overlap-right", trackType: "video", trackIndex: 1, startTime: 6.8, endTime: 8 },
          { id: "after", trackType: "video", trackIndex: 1, startTime: 8.1, endTime: 9 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: true },
        ],
        [
          { id: "marker-1", time: 3 },
          { id: "marker-2", time: 7 },
        ],
        5,
      ),
    ).toEqual(new Set(["inside-video", "inside-caption", "overlap-right"]));
  });

  it("uses timeline edges when one side of the marker bracket is missing", () => {
    expect(
      getTimelineMarkerRangeSelectionClipIds(
        [
          { id: "early", trackType: "video", trackIndex: 1, startTime: 0.5, endTime: 2 },
          { id: "middle", trackType: "video", trackIndex: 1, startTime: 2, endTime: 3 },
          { id: "late", trackType: "video", trackIndex: 1, startTime: 6, endTime: 7 },
        ],
        [{ type: "video", index: 1, locked: false }],
        [{ id: "marker-1", time: 4 }],
        2,
      ),
    ).toEqual(new Set(["early", "middle"]));

    expect(
      getTimelineMarkerRangeSelectionClipIds(
        [
          { id: "early", trackType: "video", trackIndex: 1, startTime: 0.5, endTime: 2 },
          { id: "late", trackType: "video", trackIndex: 1, startTime: 6, endTime: 7 },
        ],
        [{ type: "video", index: 1, locked: false }],
        [{ id: "marker-1", time: 4 }],
        6,
      ),
    ).toEqual(new Set(["late"]));
  });
});

describe("getTimelineSelectedClipBoundaryMarkerTimes", () => {
  it("returns unique selected clip boundary times while skipping locked tracks and existing markers", () => {
    expect(
      getTimelineSelectedClipBoundaryMarkerTimes(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 1, endTime: 4 },
          { id: "caption-1", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6.5 },
          { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5 },
          { id: "unselected", trackType: "video", trackIndex: 1, startTime: 8, endTime: 9 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: true },
        ],
        new Set(["video-1", "caption-1", "locked-audio"]),
        null,
        [{ id: "existing", time: 1.02 }],
      ),
    ).toEqual([4, 6.5]);
  });

  it("falls back to the selected clip id and ignores invalid boundary times", () => {
    expect(
      getTimelineSelectedClipBoundaryMarkerTimes(
        [
          { id: "caption-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "invalid", trackType: "text", trackIndex: 1, startTime: Number.NaN, endTime: 8 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(),
        "caption-1",
        [],
      ),
    ).toEqual([0, 2]);
  });
});

describe("getTimelineSelectedRangeMarkerTargets", () => {
  it("returns in and out markers for the editable selected group range", () => {
    expect(
      getTimelineSelectedRangeMarkerTargets(
        [
          { id: "caption", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
          { id: "audio", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 10 },
          { id: "locked-wide", trackType: "video", trackIndex: 1, startTime: 0, endTime: 20 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: true },
        ],
        new Set(["caption", "audio", "locked-wide"]),
        null,
        [],
      ),
    ).toEqual([
      { time: 2, label: "In" }, // i18n-ignore
      { time: 10, label: "Out" }, // i18n-ignore
    ]);
  });

  it("only returns missing range markers and falls back to the active clip", () => {
    expect(
      getTimelineSelectedRangeMarkerTargets(
        [{ id: "active", trackType: "video", trackIndex: 1, startTime: 4, endTime: 8 }],
        [{ type: "video", index: 1, locked: false }],
        new Set(),
        "active",
        [{ id: "existing-in", time: 4.02 }],
      ),
    ).toEqual([{ time: 8, label: "Out" }]); // i18n-ignore
  });

  it("returns no targets without an editable selected range", () => {
    expect(
      getTimelineSelectedRangeMarkerTargets(
        [{ id: "locked", trackType: "video", trackIndex: 1, startTime: 4, endTime: 8 }],
        [{ type: "video", index: 1, locked: true }],
        new Set(["locked"]),
        null,
        [],
      ),
    ).toEqual([]);
  });
});

describe("getTimelineLiftMarkerRangePlan", () => {
  it("deletes the marker range while trimming and splitting editable overlapping clips", () => {
    const result = getTimelineLiftMarkerRangePlan(
      [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5 },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 5, endTime: 8, trimStart: 30, trimEnd: 33 },
        { id: "locked-inside", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 6 },
        { id: "after", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 6 },
      ],
      5,
    );

    expect(result).toEqual({
      deleteIds: ["inside"],
      commits: [
        { clipId: "left-overlap", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
        { clipId: "spanning", startTime: 3, endTime: 4, trimStart: 20, trimEnd: 21 },
        { clipId: "right-overlap", startTime: 6, endTime: 8, trimStart: 31, trimEnd: 33 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 6,
          endTime: 8,
          trimStart: 23,
          trimEnd: 25,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });

  it("returns null without a complete marker bracket around the playhead", () => {
    expect(getTimelineLiftMarkerRangePlan(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      [{ type: "video", index: 1, locked: false }],
      [{ id: "in", time: 2 }],
      3,
    )).toBeNull();
  });
});

describe("getTimelineLiftMarkerRangeToClipboardPlan", () => {
  it("copies the marker range before lifting it without closing the gap", () => {
    const result = getTimelineLiftMarkerRangeToClipboardPlan(
      [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 5, endTime: 8, trimStart: 30, trimEnd: 33 },
        { id: "locked-inside", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 6 },
        { id: "after", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 6 },
      ],
      5,
    );

    expect(result).toEqual({
      clipboard: {
        groupDuration: 2,
        clips: [
          {
            offsetStart: 0,
            duration: 1,
            input: { trackType: "video", trackIndex: 1, startTime: 4, endTime: 5, trimStart: 12, trimEnd: 13 },
          },
          {
            offsetStart: 0,
            duration: 2,
            input: { trackType: "audio", trackIndex: 1, startTime: 4, endTime: 6, trimStart: 21, trimEnd: 23, mediaUrl: "https://example.com/audio.wav" },
          },
          {
            offsetStart: 0.2,
            duration: 1.3,
            input: { trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
          },
          {
            offsetStart: 1,
            duration: 1,
            input: { trackType: "video", trackIndex: 1, startTime: 5, endTime: 6, trimStart: 30, trimEnd: 31 },
          },
        ],
      },
      deleteIds: ["inside"],
      commits: [
        { clipId: "left-overlap", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
        { clipId: "spanning", startTime: 3, endTime: 4, trimStart: 20, trimEnd: 21 },
        { clipId: "right-overlap", startTime: 6, endTime: 8, trimStart: 31, trimEnd: 33 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 6,
          endTime: 8,
          trimStart: 23,
          trimEnd: 25,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });

  it("returns null without both a copyable range and a lift plan", () => {
    expect(getTimelineLiftMarkerRangeToClipboardPlan(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      [{ type: "video", index: 1, locked: false }],
      [{ id: "in", time: 2 }],
      3,
    )).toBeNull();
  });
});

describe("getTimelineExtractMarkerRangePlan", () => {
  it("lifts the marker range and shifts later editable clips left", () => {
    const result = getTimelineExtractMarkerRangePlan(
      [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5 },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 5, endTime: 8, trimStart: 30, trimEnd: 33 },
        { id: "locked-inside", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 6 },
        { id: "after", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 6 },
      ],
      5,
    );

    expect(result).toEqual({
      deleteIds: ["inside"],
      commits: [
        { clipId: "left-overlap", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
        { clipId: "spanning", startTime: 3, endTime: 4, trimStart: 20, trimEnd: 21 },
        { clipId: "right-overlap", startTime: 4, endTime: 6, trimStart: 31, trimEnd: 33 },
        { clipId: "after", startTime: 6, endTime: 8 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 4,
          endTime: 6,
          trimStart: 23,
          trimEnd: 25,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });

  it("does not close an extracted marker range through a locked clip on the same track", () => {
    expect(getTimelineExtractMarkerRangePlan(
      [
        { id: "inside", trackType: "video", trackIndex: 1, startTime: 2.5, endTime: 3.5 },
        { id: "locked-boundary", trackType: "video", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
        { id: "later-overlap", trackType: "video", trackIndex: 1, startTime: 7, endTime: 9 },
        { id: "later-clear", trackType: "video", trackIndex: 1, startTime: 9, endTime: 11 },
      ],
      [{ type: "video", index: 1, locked: false }],
      [
        { id: "in", time: 2 },
        { id: "out", time: 4 },
      ],
      3,
    )).toEqual({
      deleteIds: ["inside"],
      commits: [
        { clipId: "later-clear", startTime: 7, endTime: 9 },
      ],
    });
  });

  it("returns null without a complete marker bracket around the playhead", () => {
    expect(getTimelineExtractMarkerRangePlan(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      [{ type: "video", index: 1, locked: false }],
      [{ id: "in", time: 2 }],
      3,
    )).toBeNull();
  });
});

describe("getTimelineExtractMarkerRangeToClipboardPlan", () => {
  it("copies the marker range before extracting it and closing the gap", () => {
    const result = getTimelineExtractMarkerRangeToClipboardPlan(
      [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 5, endTime: 8, trimStart: 30, trimEnd: 33 },
        { id: "locked-inside", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 6 },
        { id: "after", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 6 },
      ],
      5,
    );

    expect(result).toEqual({
      clipboard: {
        groupDuration: 2,
        clips: [
          {
            offsetStart: 0,
            duration: 1,
            input: { trackType: "video", trackIndex: 1, startTime: 4, endTime: 5, trimStart: 12, trimEnd: 13 },
          },
          {
            offsetStart: 0,
            duration: 2,
            input: { trackType: "audio", trackIndex: 1, startTime: 4, endTime: 6, trimStart: 21, trimEnd: 23, mediaUrl: "https://example.com/audio.wav" },
          },
          {
            offsetStart: 0.2,
            duration: 1.3,
            input: { trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
          },
          {
            offsetStart: 1,
            duration: 1,
            input: { trackType: "video", trackIndex: 1, startTime: 5, endTime: 6, trimStart: 30, trimEnd: 31 },
          },
        ],
      },
      deleteIds: ["inside"],
      commits: [
        { clipId: "left-overlap", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
        { clipId: "spanning", startTime: 3, endTime: 4, trimStart: 20, trimEnd: 21 },
        { clipId: "right-overlap", startTime: 4, endTime: 6, trimStart: 31, trimEnd: 33 },
        { clipId: "after", startTime: 6, endTime: 8 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 4,
          endTime: 6,
          trimStart: 23,
          trimEnd: 25,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });

  it("returns null without both a copyable range and an extract plan", () => {
    expect(getTimelineExtractMarkerRangeToClipboardPlan(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      [{ type: "video", index: 1, locked: false }],
      [{ id: "in", time: 2 }],
      3,
    )).toBeNull();
  });
});

describe("copyTimelineMarkerRange", () => {
  it("copies the bracketed marker range while trimming partial editable overlaps", () => {
    const result = copyTimelineMarkerRange(
      [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 6, endTime: 9, trimStart: 30, trimEnd: 33 },
        { id: "locked-inside", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 6, mediaUrl: "https://example.com/sticker.png" },
        { id: "after", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 7 },
      ],
      5,
    );

    expect(result).toEqual({
      groupDuration: 3,
      clips: [
        {
          offsetStart: 0,
          duration: 1,
          input: { trackType: "video", trackIndex: 1, startTime: 4, endTime: 5, trimStart: 12, trimEnd: 13 },
        },
        {
          offsetStart: 0,
          duration: 3,
          input: { trackType: "audio", trackIndex: 1, startTime: 4, endTime: 7, trimStart: 21, trimEnd: 24, mediaUrl: "https://example.com/audio.wav" },
        },
        {
          offsetStart: 0.2,
          duration: 1.3,
          input: { trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
        },
        {
          offsetStart: 2,
          duration: 1,
          input: { trackType: "video", trackIndex: 1, startTime: 6, endTime: 7, trimStart: 30, trimEnd: 31 },
        },
      ],
    });
  });

  it("returns null without a complete bracket or editable overlap", () => {
    const clips = [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }];
    const tracks = [{ type: "video", index: 1, locked: true }];

    expect(copyTimelineMarkerRange(clips, tracks, [{ id: "in", time: 2 }], 3)).toBeNull();
    expect(copyTimelineMarkerRange(clips, tracks, [{ id: "in", time: 2 }, { id: "out", time: 4 }], 3)).toBeNull();
  });
});

describe("duplicateTimelineMarkerRange", () => {
  it("creates a trimmed duplicate of the bracketed marker range after the out marker", () => {
    const result = duplicateTimelineMarkerRange(
      [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 6, endTime: 9, trimStart: 30, trimEnd: 33 },
        { id: "locked-inside", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 6, mediaUrl: "https://example.com/sticker.png" },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 7 },
      ],
      5,
    );

    expect(result).toEqual([
      { trackType: "video", trackIndex: 1, startTime: 7, endTime: 8, trimStart: 12, trimEnd: 13 },
      { trackType: "audio", trackIndex: 1, startTime: 7, endTime: 10, trimStart: 21, trimEnd: 24, mediaUrl: "https://example.com/audio.wav" },
      { trackType: "text", trackIndex: 1, startTime: 7.2, endTime: 8.5, textContent: "caption" },
      { trackType: "video", trackIndex: 1, startTime: 9, endTime: 10, trimStart: 30, trimEnd: 31 },
    ]);
  });

  it("returns an empty list without a complete bracket or editable copied clips", () => {
    const clips = [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }];
    const tracks = [{ type: "video", index: 1, locked: true }];

    expect(duplicateTimelineMarkerRange(clips, tracks, [{ id: "in", time: 2 }], 3)).toEqual([]);
    expect(duplicateTimelineMarkerRange(clips, tracks, [{ id: "in", time: 2 }, { id: "out", time: 4 }], 3)).toEqual([]);
  });

  it("does not duplicate the marker range over protected clips at the out marker", () => {
    expect(duplicateTimelineMarkerRange(
      [
        { id: "copied", trackType: "video", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "locked-target", trackType: "video", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
      ],
      [{ type: "video", index: 1, locked: false }],
      [
        { id: "in", time: 2 },
        { id: "out", time: 5 },
      ],
      3,
    )).toEqual([]);
  });

  it("duplicates usable marker-range tracks when another track would hit protected material", () => {
    expect(duplicateTimelineMarkerRange(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "locked-audio-target", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      [
        { id: "in", time: 2 },
        { id: "out", time: 5 },
      ],
      3,
    )).toEqual([
      { trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
    ]);
  });
});

describe("getTimelineInsertDuplicateMarkerRangePlan", () => {
  it("duplicates the marker range and opens room on affected editable tracks", () => {
    const result = getTimelineInsertDuplicateMarkerRangePlan({
      clips: [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 6, endTime: 9, trimStart: 30, trimEnd: 33 },
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9, textContent: "later" },
        { id: "later-audio", trackType: "audio", trackIndex: 1, startTime: 9, endTime: 10, mediaUrl: "https://example.com/later.wav" },
        { id: "other-track", trackType: "sticker", trackIndex: 1, startTime: 8, endTime: 9, mediaUrl: "https://example.com/sticker.png" },
      ],
      tracks: [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
      ],
      markers: [
        { id: "in", time: 4 },
        { id: "out", time: 7 },
      ],
      playheadTime: 5,
    });

    expect(result).toEqual({
      inputs: [
        { trackType: "video", trackIndex: 1, startTime: 7, endTime: 8, trimStart: 12, trimEnd: 13 },
        { trackType: "audio", trackIndex: 1, startTime: 7, endTime: 10, trimStart: 21, trimEnd: 24, mediaUrl: "https://example.com/audio.wav" },
        { trackType: "text", trackIndex: 1, startTime: 7.2, endTime: 8.5, textContent: "caption" },
        { trackType: "video", trackIndex: 1, startTime: 9, endTime: 10, trimStart: 30, trimEnd: 31 },
        { trackType: "audio", trackIndex: 1, startTime: 10, endTime: 11, trimStart: 24, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { trackType: "video", trackIndex: 1, startTime: 10, endTime: 12, trimStart: 31, trimEnd: 33 },
      ],
      commits: [
        { clipId: "spanning", startTime: 3, endTime: 7, trimStart: 20, trimEnd: 24 },
        { clipId: "right-overlap", startTime: 6, endTime: 7, trimStart: 30, trimEnd: 31 },
        { clipId: "later-text", startTime: 11, endTime: 12 },
        { clipId: "later-audio", startTime: 12, endTime: 13 },
      ],
    });
  });

  it("returns an empty plan when no marker range can be copied", () => {
    expect(getTimelineInsertDuplicateMarkerRangePlan({
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: true }],
      markers: [{ id: "in", time: 2 }, { id: "out", time: 4 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], commits: [] });
  });
});

describe("getTimelineOverwriteDuplicateMarkerRangePlan", () => {
  it("duplicates the marker range and clears overlapping target material on affected editable tracks", () => {
    const result = getTimelineOverwriteDuplicateMarkerRangePlan({
      clips: [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.2, endTime: 5.5, textContent: "caption" },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 8, trimStart: 20, trimEnd: 25, mediaUrl: "https://example.com/audio.wav" },
        { id: "right-overlap", trackType: "video", trackIndex: 1, startTime: 6, endTime: 9, trimStart: 30, trimEnd: 33 },
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9, textContent: "later" },
        { id: "later-audio", trackType: "audio", trackIndex: 1, startTime: 9, endTime: 10, mediaUrl: "https://example.com/later.wav" },
        { id: "other-track", trackType: "sticker", trackIndex: 1, startTime: 8, endTime: 9, mediaUrl: "https://example.com/sticker.png" },
      ],
      tracks: [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
      ],
      markers: [
        { id: "in", time: 4 },
        { id: "out", time: 7 },
      ],
      playheadTime: 5,
    });

    expect(result).toEqual({
      inputs: [
        { trackType: "video", trackIndex: 1, startTime: 7, endTime: 8, trimStart: 12, trimEnd: 13 },
        { trackType: "audio", trackIndex: 1, startTime: 7, endTime: 10, trimStart: 21, trimEnd: 24, mediaUrl: "https://example.com/audio.wav" },
        { trackType: "text", trackIndex: 1, startTime: 7.2, endTime: 8.5, textContent: "caption" },
        { trackType: "video", trackIndex: 1, startTime: 9, endTime: 10, trimStart: 30, trimEnd: 31 },
        { trackType: "video", trackIndex: 1, startTime: 8, endTime: 9, trimStart: 32, trimEnd: 33 },
      ],
      deleteIds: ["later-audio"],
      commits: [
        { clipId: "spanning", startTime: 3, endTime: 7, trimStart: 20, trimEnd: 24 },
        { clipId: "right-overlap", startTime: 6, endTime: 7, trimStart: 30, trimEnd: 31 },
        { clipId: "later-text", startTime: 8.5, endTime: 9 },
      ],
    });
  });

  it("returns an empty plan when no marker range can be copied", () => {
    expect(getTimelineOverwriteDuplicateMarkerRangePlan({
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: true }],
      markers: [{ id: "in", time: 2 }, { id: "out", time: 4 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });
  });
});

describe("getTimelineReplaceMarkerRangePastePlan", () => {
  it("replaces the marker range with clipboard clips from the in marker on editable pasted tracks", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 11.5, textContent: "new" },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 10.5, endTime: 13, mediaUrl: "https://example.com/new.wav" },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineReplaceMarkerRangePastePlan({
      clipboard,
      clips: [
        { id: "left-text", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5, trimStart: 10, trimEnd: 12 },
        { id: "inside-text", trackType: "text", trackIndex: 1, startTime: 5.2, endTime: 6.5 },
        { id: "right-text", trackType: "text", trackIndex: 1, startTime: 6.8, endTime: 9, trimStart: 20, trimEnd: 22.2 },
        { id: "spanning-audio", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 9, trimStart: 30, trimEnd: 37, mediaUrl: "https://example.com/old.wav" },
        { id: "other-track", trackType: "video", trackIndex: 1, startTime: 4.5, endTime: 8.5 },
        { id: "locked-text", trackType: "text", trackIndex: 2, startTime: 4.5, endTime: 8.5 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "video", index: 1, locked: false },
        { type: "text", index: 2, locked: true },
      ],
      markers: [
        { id: "in", time: 4 },
        { id: "out", time: 8 },
      ],
      playheadTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 4, endTime: 5.5, textContent: "new" },
        { trackType: "audio", trackIndex: 1, startTime: 4.5, endTime: 7, mediaUrl: "https://example.com/new.wav" },
        { trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9, trimStart: 36, trimEnd: 37, mediaUrl: "https://example.com/old.wav" },
      ],
      deleteIds: ["inside-text"],
      commits: [
        { clipId: "spanning-audio", startTime: 2, endTime: 4, trimStart: 30, trimEnd: 32 },
        { clipId: "left-text", startTime: 3, endTime: 4, trimStart: 10, trimEnd: 11 },
        { clipId: "right-text", startTime: 8, endTime: 9, trimStart: 21.2, trimEnd: 22.2 },
      ],
    });
  });

  it("returns an empty plan without a bracket or pasteable clipboard", () => {
    expect(getTimelineReplaceMarkerRangePastePlan({
      clipboard: null,
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }, { id: "out", time: 4 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });

    expect(getTimelineReplaceMarkerRangePastePlan({
      clipboard: { groupDuration: 1, clips: [] },
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });
  });
});

describe("getTimelineInsertMarkerRangePastePlan", () => {
  it("inserts clipboard clips at the in marker and shifts later editable clips on pasted tracks", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, textContent: "new" },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 10.5, endTime: 13, mediaUrl: "https://example.com/new.wav" },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineInsertMarkerRangePastePlan({
      clipboard,
      clips: [
        { id: "spanning-text", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6, trimStart: 20, trimEnd: 24, textContent: "old" },
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 7, endTime: 8 },
        { id: "later-audio", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9 },
        { id: "other-track", trackType: "video", trackIndex: 1, startTime: 7, endTime: 8 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "video", index: 1, locked: false },
      ],
      markers: [
        { id: "in", time: 4 },
        { id: "out", time: 8 },
      ],
      playheadTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, textContent: "new" },
        { trackType: "audio", trackIndex: 1, startTime: 4.5, endTime: 7, mediaUrl: "https://example.com/new.wav" },
        { trackType: "text", trackIndex: 1, startTime: 7, endTime: 9, trimStart: 22, trimEnd: 24, textContent: "old" },
      ],
      commits: [
        { clipId: "spanning-text", startTime: 2, endTime: 4, trimStart: 20, trimEnd: 22 },
        { clipId: "later-text", startTime: 10, endTime: 11 },
        { clipId: "later-audio", startTime: 11, endTime: 12 },
      ],
    });
  });

  it("returns an empty plan without a marker bracket or pasteable clipboard", () => {
    expect(getTimelineInsertMarkerRangePastePlan({
      clipboard: null,
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }, { id: "out", time: 4 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], commits: [] });

    expect(getTimelineInsertMarkerRangePastePlan({
      clipboard: { groupDuration: 1, clips: [] },
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], commits: [] });
  });
});

describe("getTimelineOverwriteMarkerRangePastePlan", () => {
  it("overwrites clipboard clips at the in marker without shifting later clips", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, textContent: "new" },
      ],
      new Set(["copied-text"]),
    );

    expect(getTimelineOverwriteMarkerRangePastePlan({
      clipboard,
      clips: [
        { id: "left-text", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5, trimStart: 10, trimEnd: 12, textContent: "left" },
        { id: "inside-text", trackType: "text", trackIndex: 1, startTime: 4.5, endTime: 5.5, textContent: "inside" },
        { id: "right-text", trackType: "text", trackIndex: 1, startTime: 5.5, endTime: 8, trimStart: 20, trimEnd: 22.5, textContent: "right" },
        { id: "other-track", trackType: "video", trackIndex: 1, startTime: 4.5, endTime: 5.5 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "video", index: 1, locked: false },
      ],
      markers: [
        { id: "in", time: 4 },
        { id: "out", time: 8 },
      ],
      playheadTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, textContent: "new" },
      ],
      deleteIds: ["inside-text"],
      commits: [
        { clipId: "left-text", startTime: 3, endTime: 4, trimStart: 10, trimEnd: 11 },
        { clipId: "right-text", startTime: 6, endTime: 8, trimStart: 20.5, trimEnd: 22.5 },
      ],
    });
  });

  it("returns an empty plan without a marker bracket or pasteable clipboard", () => {
    expect(getTimelineOverwriteMarkerRangePastePlan({
      clipboard: null,
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }, { id: "out", time: 4 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });

    expect(getTimelineOverwriteMarkerRangePastePlan({
      clipboard: { groupDuration: 1, clips: [] },
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });
  });
});

describe("getTimelineInsertMarkerOutPastePlan", () => {
  it("inserts clipboard clips at the out marker and shifts later editable clips on pasted tracks", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, textContent: "new" },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 10.5, endTime: 13, mediaUrl: "https://example.com/new.wav" },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineInsertMarkerOutPastePlan({
      clipboard,
      clips: [
        { id: "inside-range", trackType: "text", trackIndex: 1, startTime: 5, endTime: 6, textContent: "inside" },
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 9, endTime: 10 },
        { id: "later-audio", trackType: "audio", trackIndex: 1, startTime: 9, endTime: 10 },
        { id: "other-track", trackType: "video", trackIndex: 1, startTime: 9, endTime: 10 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "video", index: 1, locked: false },
      ],
      markers: [
        { id: "in", time: 4 },
        { id: "out", time: 8 },
      ],
      playheadTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 8, endTime: 10, textContent: "new" },
        { trackType: "audio", trackIndex: 1, startTime: 8.5, endTime: 11, mediaUrl: "https://example.com/new.wav" },
      ],
      commits: [
        { clipId: "later-audio", startTime: 12, endTime: 13 },
        { clipId: "later-text", startTime: 12, endTime: 13 },
      ],
    });
  });

  it("returns an empty plan without a marker bracket or pasteable clipboard", () => {
    expect(getTimelineInsertMarkerOutPastePlan({
      clipboard: null,
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }, { id: "out", time: 4 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], commits: [] });

    expect(getTimelineInsertMarkerOutPastePlan({
      clipboard: { groupDuration: 1, clips: [] },
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], commits: [] });
  });
});

describe("getTimelineOverwriteMarkerOutPastePlan", () => {
  it("overwrites clipboard clips at the out marker without shifting later clips", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, textContent: "new" },
      ],
      new Set(["copied-text"]),
    );

    expect(getTimelineOverwriteMarkerOutPastePlan({
      clipboard,
      clips: [
        { id: "inside-range", trackType: "text", trackIndex: 1, startTime: 5, endTime: 6, textContent: "inside" },
        { id: "left-text", trackType: "text", trackIndex: 1, startTime: 7, endTime: 9, trimStart: 10, trimEnd: 12, textContent: "left" },
        { id: "inside-text", trackType: "text", trackIndex: 1, startTime: 8.5, endTime: 9.5, textContent: "inside" },
        { id: "right-text", trackType: "text", trackIndex: 1, startTime: 9.5, endTime: 12, trimStart: 20, trimEnd: 22.5, textContent: "right" },
        { id: "other-track", trackType: "video", trackIndex: 1, startTime: 8.5, endTime: 9.5 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "video", index: 1, locked: false },
      ],
      markers: [
        { id: "in", time: 4 },
        { id: "out", time: 8 },
      ],
      playheadTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 8, endTime: 10, textContent: "new" },
      ],
      deleteIds: ["inside-text"],
      commits: [
        { clipId: "left-text", startTime: 7, endTime: 8, trimStart: 10, trimEnd: 11 },
        { clipId: "right-text", startTime: 10, endTime: 12, trimStart: 20.5, trimEnd: 22.5 },
      ],
    });
  });

  it("returns an empty plan without a marker bracket or pasteable clipboard", () => {
    expect(getTimelineOverwriteMarkerOutPastePlan({
      clipboard: null,
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }, { id: "out", time: 4 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });

    expect(getTimelineOverwriteMarkerOutPastePlan({
      clipboard: { groupDuration: 1, clips: [] },
      clips: [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      tracks: [{ type: "video", index: 1, locked: false }],
      markers: [{ id: "in", time: 2 }],
      playheadTime: 3,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });
  });
});

describe("getTimelineCloseGapPlan", () => {
  it("collapses V1 scene gaps and shifts clips after completed gaps", () => {
    const result = getTimelineCloseGapPlan({
      scenes: [
        { id: "scene-1", order: 1, trackIndex: 1, duration: 4, timelinePositionSeconds: 0 },
        { id: "scene-2", order: 2, trackIndex: 1, duration: 3, timelinePositionSeconds: 7 },
      ],
      clips: [
        { id: "clip-inside-gap", startTime: 5, endTime: 6 },
        { id: "clip-after-gap", startTime: 8, endTime: 10 },
      ],
    });

    expect(result).toEqual({
      gaps: [{ from: 4, size: 3 }],
      sceneUpdates: [{ id: "scene-2", pos: 4 }],
      clipUpdates: [{ id: "clip-after-gap", startTime: 5, endTime: 7 }],
    });
  });
});
