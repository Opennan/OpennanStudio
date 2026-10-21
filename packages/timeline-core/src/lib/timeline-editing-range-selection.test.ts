// Unit tests for range, track, select-all, invert-selection, and playhead trim timeline editing tests.
import { describe, expect, it } from "vitest";
import {
  getTimelineInvertSelectionClipIds,
  getTimelineRangeSelectionClipIds,
  getTimelineRangeSelectionShortcut,
  getTimelineClipSelectionAtPlayhead,
  getTimelineTrackClipSelectionAtPlayhead,
  getAdjacentTimelineClipSelectionId,
  getAdjacentTimelineTrackClipSelectionId,
  getTimelineTrimCommitsToPlayhead,
  getTimelineTrimTargetCommitsToPlayhead,
  getTimelineRippleTrimTargetCommitsToPlayhead,
  getTimelineTrackSelectionShortcut,
  getTimelineTrackSelectionClipIds,
  getTimelineSelectionToPlayheadClipIds,
  getTimelineSetAdjacentCrossfadeTargetCommits,
  getTimelineTrackRangeSelectionClipIds,
  getTimelineSelectAllClipIds,
  trimTimelineClipToPlayhead,
} from "./timeline-editing";

describe("getTimelineSetAdjacentCrossfadeTargetCommits", () => {
  it("sets fade out on the selected clip and fade in on the next adjacent media clip", () => {
    const result = getTimelineSetAdjacentCrossfadeTargetCommits(
      [
        { id: "left", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "right", trackType: "video", trackIndex: 1, startTime: 5.02, endTime: 10 },
        { id: "audio", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["left"]),
      null,
      0.75,
    );

    expect(result).toEqual([
      { clipId: "left", startTime: 0, endTime: 5, fadeInDuration: 0, fadeOutDuration: 0.75 },
      { clipId: "right", startTime: 5.02, endTime: 10, fadeInDuration: 0.75, fadeOutDuration: 0 },
    ]);
  });

  it("uses the previous adjacent clip when the selected clip has no next neighbor", () => {
    const result = getTimelineSetAdjacentCrossfadeTargetCommits(
      [
        { id: "left", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "right", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 3 },
      ],
      [{ type: "audio", index: 1, locked: false }],
      new Set(),
      "right",
      10,
    );

    expect(result).toEqual([
      { clipId: "left", startTime: 0, endTime: 2, fadeInDuration: 0, fadeOutDuration: 0.5 },
      { clipId: "right", startTime: 2, endTime: 3, fadeInDuration: 0.5, fadeOutDuration: 0 },
    ]);
  });

  it("sets adjacent crossfades between same-track text clips", () => {
    const result = getTimelineSetAdjacentCrossfadeTargetCommits(
      [
        { id: "title-left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 3 },
        { id: "title-right", trackType: "text", trackIndex: 1, startTime: 3.04, endTime: 8 },
        { id: "sticker", trackType: "sticker", trackIndex: 1, startTime: 3.04, endTime: 8 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
      ],
      new Set(["title-left"]),
      null,
      0.6,
    );

    expect(result).toEqual([
      { clipId: "title-left", startTime: 0, endTime: 3, fadeInDuration: 0, fadeOutDuration: 0.6 },
      { clipId: "title-right", startTime: 3.04, endTime: 8, fadeInDuration: 0.6, fadeOutDuration: 0 },
    ]);
  });

  it("sets adjacent crossfades between same-track sticker clips", () => {
    const result = getTimelineSetAdjacentCrossfadeTargetCommits(
      [
        { id: "sticker-left", trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "sticker-right", trackType: "sticker", trackIndex: 1, startTime: 2, endTime: 6 },
        { id: "text", trackType: "text", trackIndex: 1, startTime: 2, endTime: 6 },
      ],
      [
        { type: "sticker", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
      ],
      new Set(),
      "sticker-right",
      5,
    );

    expect(result).toEqual([
      { clipId: "sticker-left", startTime: 0, endTime: 2, fadeInDuration: 0, fadeOutDuration: 1 },
      { clipId: "sticker-right", startTime: 2, endTime: 6, fadeInDuration: 1, fadeOutDuration: 0 },
    ]);
  });

  it("returns no commits when the adjacent crossfade neighbor clip is locked", () => {
    const result = getTimelineSetAdjacentCrossfadeTargetCommits(
      [
        { id: "left", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "locked-right", trackType: "video", trackIndex: 1, startTime: 5.02, endTime: 10, locked: true },
      ],
      [{ type: "video", index: 1, locked: false }],
      new Set(["left"]),
      null,
      0.75,
    );

    expect(result).toEqual([]);
  });

  it("does not crossfade past a locked immediate neighbor clip", () => {
    const result = getTimelineSetAdjacentCrossfadeTargetCommits(
      [
        { id: "left", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "locked-right", trackType: "video", trackIndex: 1, startTime: 5.02, endTime: 7, locked: true },
        { id: "later", trackType: "video", trackIndex: 1, startTime: 7.02, endTime: 10 },
      ],
      [{ type: "video", index: 1, locked: false }],
      new Set(["left"]),
      null,
      0.75,
    );

    expect(result).toEqual([]);
  });

  it("returns no commits when the selected track is locked or has no adjacent media clip", () => {
    expect(getTimelineSetAdjacentCrossfadeTargetCommits(
      [
        { id: "locked", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "right", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 },
      ],
      [{ type: "video", index: 1, locked: true }],
      new Set(["locked"]),
      null,
      0.5,
    )).toEqual([]);

    expect(getTimelineSetAdjacentCrossfadeTargetCommits(
      [{ id: "solo", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      [{ type: "video", index: 1, locked: false }],
      new Set(["solo"]),
      null,
      0.5,
    )).toEqual([]);
  });
});

describe("getTimelineRangeSelectionClipIds", () => {
  it("selects editable clips before or after the playhead while skipping locked tracks", () => {
    const clips = [
      { id: "left-text", trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
      { id: "overlap", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 7 },
      { id: "right-sticker", trackType: "sticker", trackIndex: 1, startTime: 8, endTime: 10 },
      { id: "locked-video", trackType: "video", trackIndex: 1, startTime: 9, endTime: 11 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
      { type: "sticker", index: 1, locked: false },
      { type: "video", index: 1, locked: true },
    ];

    expect([...getTimelineRangeSelectionClipIds(clips, tracks, 6, -1)]).toEqual(["left-text", "overlap"]);
    expect([...getTimelineRangeSelectionClipIds(clips, tracks, 6, 1)]).toEqual(["overlap", "right-sticker"]);
  });
});

describe("getTimelineRangeSelectionShortcut", () => {
  it("maps Shift+[ and Shift+] to global before/after playhead selection", () => {
    expect(getTimelineRangeSelectionShortcut({
      key: "[",
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    })).toBe(-1);
    expect(getTimelineRangeSelectionShortcut({
      key: "]",
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    })).toBe(1);
  });

  it("ignores range selection shortcut candidates with conflicting modifiers", () => {
    expect(getTimelineRangeSelectionShortcut({ key: "[", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })).toBeNull();
    expect(getTimelineRangeSelectionShortcut({ key: "[", shiftKey: true, altKey: true, ctrlKey: false, metaKey: false })).toBeNull();
    expect(getTimelineRangeSelectionShortcut({ key: "]", shiftKey: true, altKey: false, ctrlKey: true, metaKey: false })).toBeNull();
    expect(getTimelineRangeSelectionShortcut({ key: "]", shiftKey: true, altKey: false, ctrlKey: false, metaKey: true })).toBeNull();
  });
});

describe("getTimelineClipSelectionAtPlayhead", () => {
  it("selects editable clips under the playhead while skipping locked tracks", () => {
    const result = getTimelineClipSelectionAtPlayhead(
      [
        { id: "left", trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
        { id: "locked-video", trackType: "video", trackIndex: 1, startTime: 4, endTime: 8 },
        { id: "audio", trackType: "audio", trackIndex: 1, startTime: 4.5, endTime: 8 },
        { id: "sticker", trackType: "sticker", trackIndex: 1, startTime: 5, endTime: 7 },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
      ],
      5,
    );

    expect([...result]).toEqual(["audio", "sticker"]);
  });

  it("treats clip ends as exclusive so cut boundaries select the incoming clip only", () => {
    const result = getTimelineClipSelectionAtPlayhead(
      [
        { id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "incoming", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 },
        { id: "overlay", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
      ],
      5,
    );

    expect([...result]).toEqual(["overlay", "incoming"]);
  });
});

describe("getTimelineTrackClipSelectionAtPlayhead", () => {
  it("selects only active-track clips under the playhead", () => {
    const result = getTimelineTrackClipSelectionAtPlayhead(
      [
        { id: "active-left", trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
        { id: "active-under", trackType: "text", trackIndex: 1, startTime: 4, endTime: 8 },
        { id: "other-track-under", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 8 },
        { id: "active-right", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["active-left"]),
      null,
      5,
    );

    expect([...result]).toEqual(["active-under"]);
  });

  it("treats active-track clip ends as exclusive at cut boundaries", () => {
    const result = getTimelineTrackClipSelectionAtPlayhead(
      [
        { id: "anchor", trackType: "video", trackIndex: 1, startTime: 12, endTime: 14 },
        { id: "outgoing", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "incoming", trackType: "video", trackIndex: 1, startTime: 5, endTime: 10 },
        { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 10 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["anchor"]),
      null,
      5,
    );

    expect([...result]).toEqual(["incoming"]);
  });

  it("falls back to all editable clips under the playhead when no active track exists", () => {
    const result = getTimelineTrackClipSelectionAtPlayhead(
      [
        { id: "locked-video", trackType: "video", trackIndex: 1, startTime: 4, endTime: 8 },
        { id: "audio", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 8 },
        { id: "sticker", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 8 },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "audio", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false },
      ],
      new Set(),
      null,
      5,
    );

    expect([...result]).toEqual(["audio", "sticker"]);
  });
});

describe("getAdjacentTimelineClipSelectionId", () => {
  it("selects the next or previous editable clip from the active selection or playhead", () => {
    const clips = [
      { id: "locked-left", trackType: "video", trackIndex: 1, startTime: 1, endTime: 3 },
      { id: "text-left", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
      { id: "audio-current", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 8 },
      { id: "sticker-right", trackType: "sticker", trackIndex: 1, startTime: 10, endTime: 11 },
    ];
    const tracks = [
      { type: "video", index: 1, locked: true },
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
      { type: "sticker", index: 1, locked: false },
    ];

    expect(getAdjacentTimelineClipSelectionId(clips, tracks, new Set(["audio-current"]), null, 0, 1))
      .toBe("sticker-right");
    expect(getAdjacentTimelineClipSelectionId(clips, tracks, new Set(["audio-current"]), null, 0, -1))
      .toBe("text-left");
    expect(getAdjacentTimelineClipSelectionId(clips, tracks, new Set(), null, 5, -1))
      .toBe("text-left");
  });
});

describe("getAdjacentTimelineTrackClipSelectionId", () => {
  it("selects the next or previous editable clip on the active track", () => {
    const clips = [
      { id: "text-left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      { id: "active", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6 },
      { id: "audio-between", trackType: "audio", trackIndex: 1, startTime: 7, endTime: 8 },
      { id: "text-right", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
      { id: "text-other-track", trackType: "text", trackIndex: 2, startTime: 13, endTime: 14 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "text", index: 2, locked: false },
      { type: "audio", index: 1, locked: false },
    ];

    expect(getAdjacentTimelineTrackClipSelectionId(clips, tracks, new Set(["active"]), null, 0, 1))
      .toBe("text-right");
    expect(getAdjacentTimelineTrackClipSelectionId(clips, tracks, new Set(["active"]), null, 0, -1))
      .toBe("text-left");
  });

  it("falls back to global adjacent selection without an active track", () => {
    const clips = [
      { id: "left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      { id: "right", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 6 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
    ];

    expect(getAdjacentTimelineTrackClipSelectionId(clips, tracks, new Set(), null, 3, 1))
      .toBe("right");
  });

  it("does not use a locked clip as the active track adjacent-selection anchor", () => {
    const clips = [
      { id: "locked-anchor", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, locked: true },
      { id: "same-track-right", trackType: "text", trackIndex: 1, startTime: 8, endTime: 10 },
      { id: "global-right", trackType: "audio", trackIndex: 1, startTime: 7, endTime: 8 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
    ];

    expect(getAdjacentTimelineTrackClipSelectionId(clips, tracks, new Set(["locked-anchor"]), null, 6, 1))
      .toBe("global-right");
  });
});

describe("getTimelineTrackSelectionClipIds", () => {
  it("selects editable clips on the active clip track while skipping locked tracks", () => {
    expect([...getTimelineTrackSelectionClipIds(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 2 },
        { id: "text-2", trackType: "text", trackIndex: 1, startTime: 3, endTime: 4 },
        { id: "text-locked", trackType: "text", trackIndex: 2, startTime: 1, endTime: 2 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 1, endTime: 2 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: true },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["text-2"]),
      null,
    )]).toEqual(["text-1", "text-2"]);
  });

  it("does not use a locked clip as the active track selection anchor", () => {
    expect([...getTimelineTrackSelectionClipIds(
      [
        { id: "locked-anchor", trackType: "text", trackIndex: 1, startTime: 1, endTime: 2, locked: true },
        { id: "editable-peer", trackType: "text", trackIndex: 1, startTime: 3, endTime: 4 },
      ],
      [{ type: "text", index: 1, locked: false }],
      new Set(["locked-anchor"]),
      null,
    )]).toEqual([]);
  });
});

describe("getTimelineTrackSelectionShortcut", () => {
  it("maps Alt/Option+Shift+A to active-track selection", () => {
    expect(getTimelineTrackSelectionShortcut({
      key: "a",
      shiftKey: true,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
    })).toBe(true);
    expect(getTimelineTrackSelectionShortcut({
      key: "A",
      shiftKey: true,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
    })).toBe(true);
  });

  it("ignores select-track shortcut candidates with conflicting modifiers", () => {
    expect(getTimelineTrackSelectionShortcut({ key: "a", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false })).toBe(false);
    expect(getTimelineTrackSelectionShortcut({ key: "a", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
    expect(getTimelineTrackSelectionShortcut({ key: "a", shiftKey: true, altKey: true, ctrlKey: true, metaKey: false })).toBe(false);
    expect(getTimelineTrackSelectionShortcut({ key: "a", shiftKey: true, altKey: true, ctrlKey: false, metaKey: true })).toBe(false);
  });
});

describe("getTimelineTrackRangeSelectionClipIds", () => {
  it("selects clips left or right of the active clip on the same editable track", () => {
    const clips = [
      { id: "left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      { id: "active", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6 },
      { id: "right", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
      { id: "other-track", trackType: "text", trackIndex: 2, startTime: 8, endTime: 9 },
      { id: "locked-track", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "text", index: 2, locked: false },
      { type: "audio", index: 1, locked: true },
    ];

    expect([...getTimelineTrackRangeSelectionClipIds(clips, tracks, new Set(["active"]), null, 5, -1)])
      .toEqual(["left", "active"]);
    expect([...getTimelineTrackRangeSelectionClipIds(clips, tracks, new Set(["active"]), null, 5, 1)])
      .toEqual(["active", "right"]);
  });

  it("falls back to editable clips around the playhead when no active track exists", () => {
    const clips = [
      { id: "left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      { id: "right", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
      { id: "locked", trackType: "video", trackIndex: 1, startTime: 6, endTime: 8 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
      { type: "video", index: 1, locked: true },
    ];

    expect([...getTimelineTrackRangeSelectionClipIds(clips, tracks, new Set(), null, 3, 1)])
      .toEqual(["right"]);
  });

  it("uses the playhead as the range boundary on the active track", () => {
    const clips = [
      { id: "early", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      { id: "anchor", trackType: "text", trackIndex: 1, startTime: 4, endTime: 5 },
      { id: "crossing-playhead", trackType: "text", trackIndex: 1, startTime: 8, endTime: 12 },
      { id: "late", trackType: "text", trackIndex: 1, startTime: 14, endTime: 16 },
      { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 12 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
    ];

    expect([...getTimelineTrackRangeSelectionClipIds(clips, tracks, new Set(["anchor"]), null, 10, -1)])
      .toEqual(["early", "anchor", "crossing-playhead"]);
    expect([...getTimelineTrackRangeSelectionClipIds(clips, tracks, new Set(["anchor"]), null, 10, 1)])
      .toEqual(["crossing-playhead", "late"]);
  });

  it("does not use a locked clip as the active track range anchor", () => {
    const clips = [
      { id: "locked-anchor", trackType: "text", trackIndex: 1, startTime: 4, endTime: 5, locked: true },
      { id: "left", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      { id: "right", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
      { id: "fallback", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
    ];

    expect([...getTimelineTrackRangeSelectionClipIds(clips, tracks, new Set(["locked-anchor"]), null, 5, 1)])
      .toEqual(["fallback", "right"]);
  });
});

describe("getTimelineSelectionToPlayheadClipIds", () => {
  it("selects editable clips between the selected group and a later playhead", () => {
    const clips = [
      { id: "selected", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
      { id: "between-audio", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 6 },
      { id: "crossing-playhead", trackType: "sticker", trackIndex: 1, startTime: 7, endTime: 11 },
      { id: "after", trackType: "text", trackIndex: 1, startTime: 12, endTime: 13 },
      { id: "locked", trackType: "video", trackIndex: 1, startTime: 5, endTime: 6 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
      { type: "sticker", index: 1, locked: false },
      { type: "video", index: 1, locked: true },
    ];

    expect([...getTimelineSelectionToPlayheadClipIds(clips, tracks, new Set(["selected"]), null, 10)])
      .toEqual(["selected", "between-audio", "crossing-playhead"]);
  });

  it("selects editable clips between an earlier playhead and the selected group", () => {
    const clips = [
      { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 1 },
      { id: "crossing-playhead", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5 },
      { id: "between", trackType: "sticker", trackIndex: 1, startTime: 6, endTime: 7 },
      { id: "selected", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
    ];
    const tracks = [
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
      { type: "sticker", index: 1, locked: false },
    ];

    expect([...getTimelineSelectionToPlayheadClipIds(clips, tracks, new Set(["selected"]), null, 3)])
      .toEqual(["crossing-playhead", "between", "selected"]);
  });
});

describe("getTimelineSelectAllClipIds", () => {
  it("selects all editable clips while skipping locked tracks", () => {
    expect([...getTimelineSelectAllClipIds(
      [
        { id: "video-locked", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 6 },
        { id: "loose", startTime: 7, endTime: 8 },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
    )]).toEqual(["text-1", "audio-1", "loose"]);
  });
});

describe("getTimelineInvertSelectionClipIds", () => {
  it("selects editable clips that are not in the current selection", () => {
    expect([...getTimelineInvertSelectionClipIds(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5 },
        { id: "locked-audio", trackType: "audio", trackIndex: 2, startTime: 3, endTime: 6 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "audio", index: 2, locked: true },
      ],
      new Set(["video-1"]),
      null,
    )]).toEqual(["text-1", "audio-1"]);
  });

  it("uses the active clip fallback and returns an empty set when every editable clip is selected", () => {
    expect([...getTimelineInvertSelectionClipIds(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
      ],
      new Set(["video-1"]),
      "text-1",
    )]).toEqual([]);
  });
});

describe("trimTimelineClipToPlayhead", () => {
  it("ripple trims clip starts to the playhead and closes the gap on matching tracks", () => {
    expect(
      getTimelineRippleTrimTargetCommitsToPlayhead(
        [
          { id: "selected", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 8, trimStart: 10, trimEnd: 16 },
          { id: "later", trackType: "audio", trackIndex: 1, startTime: 9, endTime: 12, trimStart: 20, trimEnd: 23 },
          { id: "other-track", trackType: "text", trackIndex: 1, startTime: 9, endTime: 12 },
          { id: "locked", trackType: "audio", trackIndex: 2, startTime: 9, endTime: 12 },
        ],
        [
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["selected", "locked"]),
        null,
        5,
        "start",
      ),
    ).toEqual([
      { clipId: "selected", startTime: 2, endTime: 5, trimStart: 13, trimEnd: 16 },
      { clipId: "later", startTime: 6, endTime: 9, trimStart: 20, trimEnd: 23 },
    ]);
  });

  it("ripple trims clip ends to the playhead and pulls later clips left", () => {
    expect(
      getTimelineRippleTrimTargetCommitsToPlayhead(
        [
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 2, endTime: 8 },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        5,
        "end",
      ),
    ).toEqual([
      { clipId: "selected", startTime: 2, endTime: 5 },
      { clipId: "later", startTime: 7, endTime: 9 },
    ]);
  });

  it("does not ripple trim later clips into locked same-track clips", () => {
    expect(
      getTimelineRippleTrimTargetCommitsToPlayhead(
        [
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 2, endTime: 8 },
          { id: "locked-boundary", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
          { id: "later-overlap", trackType: "text", trackIndex: 1, startTime: 8, endTime: 10 },
          { id: "later-clear", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        5,
        "end",
      ),
    ).toEqual([
      { clipId: "selected", startTime: 2, endTime: 5 },
      { clipId: "later-clear", startTime: 7, endTime: 9 },
    ]);
  });

  it("moves selected clip start edges to the playhead while ignoring invalid durations", () => {
    expect(
      getTimelineTrimCommitsToPlayhead(
        [
          { id: "clip-1", startTime: 1, endTime: 8 },
          { id: "clip-2", startTime: 3, endTime: 9 },
          { id: "clip-3", startTime: 6, endTime: 10 },
          { id: "clip-4", startTime: 4, endTime: 5.05 },
        ],
        new Set(["clip-1", "clip-2", "clip-3", "clip-4"]),
        5,
        "start",
      ),
    ).toEqual([
      { clipId: "clip-1", startTime: 5, endTime: 8 },
      { clipId: "clip-2", startTime: 5, endTime: 9 },
      { clipId: "clip-3", startTime: 5, endTime: 10 },
    ]);
  });

  it("extends selected clip starts earlier to the playhead and preserves trim offsets", () => {
    expect(
      getTimelineTrimCommitsToPlayhead(
        [
          { id: "clip-1", startTime: 4, endTime: 9, trimStart: 10, trimEnd: 15 },
          { id: "clip-2", startTime: 6, endTime: 10, trimStart: 1, trimEnd: 5 },
        ],
        new Set(["clip-1", "clip-2"]),
        2,
        "start",
      ),
    ).toEqual([
      { clipId: "clip-1", startTime: 2, endTime: 9, trimStart: 8, trimEnd: 15 },
      { clipId: "clip-2", startTime: 2, endTime: 10, trimStart: 0, trimEnd: 5 },
    ]);
  });

  it("extends selected clip ends later to the playhead and preserves trim offsets", () => {
    expect(
      getTimelineTrimCommitsToPlayhead(
        [
          { id: "clip-1", startTime: 4, endTime: 9, trimStart: 10, trimEnd: 15 },
          { id: "clip-2", startTime: 5, endTime: 8 },
        ],
        new Set(["clip-1", "clip-2"]),
        11,
        "end",
      ),
    ).toEqual([
      { clipId: "clip-1", startTime: 4, endTime: 11, trimStart: 10, trimEnd: 17 },
      { clipId: "clip-2", startTime: 5, endTime: 11 },
    ]);
  });

  it("trims editable selected clips while skipping locked tracks", () => {
    expect(
      getTimelineTrimTargetCommitsToPlayhead(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 1, endTime: 8 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 8 },
        ],
        [
          { type: "video", index: 1, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1"]),
        null,
        5,
        "start",
      ),
    ).toEqual([{ clipId: "text-1", startTime: 5, endTime: 8 }]);
  });

  it("clamps plain trim extensions at locked same-track clip boundaries", () => {
    expect(
      getTimelineTrimTargetCommitsToPlayhead(
        [
          { id: "selected-start", trackType: "text", trackIndex: 1, startTime: 8, endTime: 12, trimStart: 10, trimEnd: 14 },
          { id: "locked-before", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
          { id: "selected-end", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 20, trimEnd: 23 },
          { id: "locked-after", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["selected-start", "selected-end"]),
        null,
        5,
        "start",
      ),
    ).toEqual([
      { clipId: "selected-start", startTime: 7, endTime: 12, trimStart: 9, trimEnd: 14 },
    ]);

    expect(
      getTimelineTrimTargetCommitsToPlayhead(
        [
          { id: "selected-start", trackType: "text", trackIndex: 1, startTime: 8, endTime: 12, trimStart: 10, trimEnd: 14 },
          { id: "locked-before", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
          { id: "selected-end", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 20, trimEnd: 23 },
          { id: "locked-after", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["selected-start", "selected-end"]),
        null,
        8,
        "end",
      ),
    ).toEqual([
      { clipId: "selected-end", startTime: 2, endTime: 6, trimStart: 20, trimEnd: 24 },
    ]);
  });

  it("clamps plain trim extensions at unselected same-track clip boundaries", () => {
    expect(
      getTimelineTrimTargetCommitsToPlayhead(
        [
          { id: "previous", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7 },
          { id: "selected-start", trackType: "text", trackIndex: 1, startTime: 8, endTime: 12, trimStart: 10, trimEnd: 14 },
          { id: "selected-end", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 20, trimEnd: 23 },
          { id: "next", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["selected-start", "selected-end"]),
        null,
        5,
        "start",
      ),
    ).toEqual([
      { clipId: "selected-start", startTime: 7, endTime: 12, trimStart: 9, trimEnd: 14 },
    ]);

    expect(
      getTimelineTrimTargetCommitsToPlayhead(
        [
          { id: "previous", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7 },
          { id: "selected-start", trackType: "text", trackIndex: 1, startTime: 8, endTime: 12, trimStart: 10, trimEnd: 14 },
          { id: "selected-end", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 20, trimEnd: 23 },
          { id: "next", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["selected-start", "selected-end"]),
        null,
        8,
        "end",
      ),
    ).toEqual([
      { clipId: "selected-end", startTime: 2, endTime: 6, trimStart: 20, trimEnd: 24 },
    ]);
  });

  it("trims the selected clip start to the playhead when the playhead is inside the clip", () => {
    expect(
      trimTimelineClipToPlayhead(
        [
          { id: "clip-1", startTime: 4, endTime: 9 },
          { id: "clip-2", startTime: 10, endTime: 12 },
        ],
        "clip-1",
        6.25,
        "start",
      ),
    ).toEqual({ clipId: "clip-1", startTime: 6.25, endTime: 9 });
  });

  it("trims the selected clip end to the playhead when the playhead is inside the clip", () => {
    expect(
      trimTimelineClipToPlayhead(
        [{ id: "clip-1", startTime: 4, endTime: 9 }],
        "clip-1",
        7,
        "end",
      ),
    ).toEqual({ clipId: "clip-1", startTime: 4, endTime: 7 });
  });

  it("returns null when the playhead would create an invalid duration", () => {
    expect(
      trimTimelineClipToPlayhead(
        [{ id: "clip-1", startTime: 4, endTime: 9 }],
        "clip-1",
        9,
        "start",
      ),
    ).toBeNull();
  });
});
