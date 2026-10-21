// Unit tests for nudge, paste, gap, trim, slide, roll, and track movement timeline editing tests.
import { describe, expect, it } from "vitest";
import {
  copyTimelineClips,
  getTimelineInsertPastePlan,
  getTimelineOverwritePastePlan,
  getTimelineReplaceSelectionPastePlan,
  getTimelinePackSelectionTargetCommits,
  getEditableTimelineClipIds,
  getTimelineAlignSelectionTargetCommits,
  getTimelineAlignSelectionToNearestMarkerTargetCommits,
  getTimelineTrimSelectionToNearestMarkerTargetCommits,
  getTimelineTrimSelectionToMarkerRangeTargetCommits,
  getTimelineTrimSelectionToNearestEditPointTargetCommits,
  getTimelineCopyTargetClipIds,
  getTimelineDeleteBatchPlan,
  getTimelineCloseActiveTrackGapsTargetCommits,
  getTimelineCloseAllTrackGapsTargetCommits,
  getTimelineDeleteGlobalGapTargetCommits,
  getTimelineDeleteAllTrackGapsAtPlayheadTargetCommits,
  getTimelineDeleteGapTargetCommits,
  getTimelineDeleteMarkerRangeGapTargetCommits,
  getTimelineDeleteMarkerOutGapTargetCommits,
  getTimelineInsertGlobalGapTargetCommits,
  getTimelineInsertGlobalGapPlan,
  getTimelineInsertMarkerRangeGapPlan,
  getTimelineInsertMarkerOutGapPlan,
  getTimelineInsertGapPlan,
  getTimelineInsertGapTargetCommits,
  getEditableTimelineSelectionClipIds,
  getTimelineSelectionAfterDelete,
  getEditableTimelinePasteInputs,
  getTimelineRollTargetCommits,
  getTimelineRollShortcut,
  getTimelineSlideTargetCommits,
  getTimelineSwapAdjacentTargetCommits,
  getTimelineTrackMoveExtremeTargetCommits,
  getTimelineTrackMoveTargetCommits,
  getTimelineAddTextClipInput,
  getTimelineSlipTargetCommits,
  getTimelineNudgeStepSeconds,
  getTimelineNudgeTargetCommits,
  nudgeTimelineClips,
  slipTimelineClips,
} from "./timeline-editing";

describe("nudgeTimelineClips", () => {
  it("creates caption and subtitle text clips on the first editable text track", () => {
    expect(getTimelineAddTextClipInput(
      [
        { type: "text", index: 1, locked: true },
        { type: "text", index: 2, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      12.25,
      "caption",
    )).toMatchObject({
      trackType: "text",
      trackIndex: 2,
      startTime: 12.25,
      endTime: 17.25,
      textContent: "Enter caption...",
      textStyle: expect.stringContaining("\"fontSize\":56"),
      positionX: 0.5,
      positionY: 0.82,
      scale: 1,
      opacity: 1,
    });
    const captionInput = getTimelineAddTextClipInput([], 0, "caption");
    expect(captionInput?.textStyle).toEqual(expect.stringContaining("\"captionKind\":\"caption\""));
    expect(captionInput?.textStyle).toEqual(expect.stringContaining("\"captionPosition\":\"bottom\""));
    expect(captionInput?.textStyle).toEqual(expect.stringContaining("\"maxWidthRatio\":0.78"));

    expect(getTimelineAddTextClipInput([], 3, "subtitle")).toMatchObject({
      trackType: "text",
      trackIndex: 1,
      startTime: 3,
      endTime: 8,
      textContent: "Enter subtitle...",
      textStyle: expect.stringContaining("\"fontSize\":48"),
      positionY: 0.88,
    });
    const subtitleInput = getTimelineAddTextClipInput([], 3, "subtitle");
    expect(subtitleInput?.textStyle).toEqual(expect.stringContaining("\"captionKind\":\"subtitle\""));
    expect(subtitleInput?.textStyle).toEqual(expect.stringContaining("\"maxWidthRatio\":0.86"));
  });

  it("does not create text clips when every text track is locked or hidden", () => {
    expect(getTimelineAddTextClipInput(
      [
        { type: "text", index: 1, locked: true },
        { type: "text", index: 2, visible: false },
      ],
      5,
      "caption",
    )).toBeNull();
  });

  it("skips text tracks with protected clips when creating text", () => {
    expect(getTimelineAddTextClipInput(
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: false },
      ],
      5,
      "text",
      [
        { id: "locked-text", trackType: "text", trackIndex: 1, startTime: 6, endTime: 8, locked: true },
        { id: "editable-text", trackType: "text", trackIndex: 2, startTime: 6, endTime: 8 },
      ],
    )).toMatchObject({
      trackType: "text",
      trackIndex: 2,
      // Requested 5–10 overlaps the editable clip at 6–8; the new clip lands
      // in the nearest free spot after it instead of stacking on top.
      startTime: 8,
      endTime: 13,
    });
  });

  it("never overlaps existing editable text clips when creating text", () => {
    // Playhead sits inside an existing clip — the new clip snaps to its end.
    expect(getTimelineAddTextClipInput(
      [{ type: "text", index: 1, locked: false }],
      4,
      "subtitle",
      [{ id: "existing", trackType: "text", trackIndex: 1, startTime: 2, endTime: 7 }],
    )).toMatchObject({ startTime: 7, endTime: 12 });
  });

  it("moves selected clips while preserving each clip duration", () => {
    const result = nudgeTimelineClips(
      [
        { id: "clip-1", startTime: 2, endTime: 5 },
        { id: "clip-2", startTime: 6, endTime: 7.5 },
        { id: "clip-3", startTime: 8, endTime: 9 },
      ],
      new Set(["clip-1", "clip-2"]),
      1.25,
    );

    expect(result).toEqual([
      { clipId: "clip-1", startTime: 3.25, endTime: 6.25 },
      { clipId: "clip-2", startTime: 7.25, endTime: 8.75 },
    ]);
  });

  it("clamps the whole selected group at the start of the timeline", () => {
    const result = nudgeTimelineClips(
      [
        { id: "clip-1", startTime: 0.4, endTime: 1.4 },
        { id: "clip-2", startTime: 2, endTime: 3 },
      ],
      new Set(["clip-1", "clip-2"]),
      -1,
    );

    expect(result).toEqual([
      { clipId: "clip-1", startTime: 0, endTime: 1 },
      { clipId: "clip-2", startTime: 1.6, endTime: 2.6 },
    ]);
  });

  it("filters pasted clip inputs that target locked or hidden tracks", () => {
    const inputs = [
      { trackType: "text", trackIndex: 1, startTime: 20, endTime: 22, textContent: "Title" },
      { trackType: "audio", trackIndex: 1, startTime: 20, endTime: 24, mediaUrl: "https://example.com/audio.wav" },
      { trackType: "sticker", trackIndex: 2, startTime: 21, endTime: 23, mediaUrl: "https://example.com/sticker.png" },
      { trackType: "video", trackIndex: 2, startTime: 22, endTime: 25, mediaUrl: "https://example.com/hidden.mp4" },
    ];

    expect(getEditableTimelinePasteInputs(inputs, [
      { type: "text", index: 1, locked: true },
      { type: "audio", index: 1, locked: false },
      { type: "video", index: 2, locked: false, visible: false },
    ])).toEqual([
      { trackType: "audio", trackIndex: 1, startTime: 20, endTime: 24, mediaUrl: "https://example.com/audio.wav" },
      { trackType: "sticker", trackIndex: 2, startTime: 21, endTime: 23, mediaUrl: "https://example.com/sticker.png" },
    ]);
  });

  it("filters pasted clip inputs that would overlap protected clips", () => {
    expect(getEditableTimelinePasteInputs(
      [
        { trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, textContent: "Blocked" },
        { trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7, mediaUrl: "https://example.com/audio.wav" },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      [
        { id: "locked-text", trackType: "text", trackIndex: 1, startTime: 6, endTime: 8, locked: true },
        { id: "editable-audio", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 8 },
      ],
    )).toEqual([
      { trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7, mediaUrl: "https://example.com/audio.wav" },
    ]);
  });

  it("plans insert paste by shifting later editable clips on the pasted tracks", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 7 },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineInsertPastePlan({
      clipboard,
      clips: [
        { id: "before-text", trackType: "text", trackIndex: 1, startTime: 1, endTime: 2 },
        { id: "after-text", trackType: "text", trackIndex: 1, startTime: 9, endTime: 10 },
        { id: "after-audio", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 12 },
        { id: "after-video", trackType: "video", trackIndex: 1, startTime: 8, endTime: 12 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "video", index: 1, locked: false },
      ],
      startTime: 6,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 6, endTime: 8 },
        { trackType: "audio", trackIndex: 1, startTime: 7, endTime: 10 },
      ],
      commits: [
        { clipId: "after-audio", startTime: 12, endTime: 16 },
        { clipId: "after-text", startTime: 13, endTime: 14 },
      ],
    });
  });

  it("shifts the whole clip instead of leaving a sub-minimum left sliver when pasting near a clip's head", () => {
    const clipboard = copyTimelineClips(
      [{ id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 3 }],
      new Set(["copied-text"]),
    );

    const plan = getTimelineInsertPastePlan({
      clipboard,
      clips: [{ id: "under", trackType: "text", trackIndex: 1, startTime: 0, endTime: 10 }],
      tracks: [{ type: "text", index: 1, locked: false }],
      startTime: 0.05, // within MIN_CLIP_DURATION of the clip's start
    });

    // No commit may be shorter than the minimum clip duration.
    for (const commit of plan.commits) {
      expect(commit.endTime - commit.startTime).toBeGreaterThanOrEqual(0.1 - 0.001);
    }
    // The clip under the paste point shifts right as one piece.
    expect(plan.commits).toEqual([{ clipId: "under", startTime: 3, endTime: 13 }]);
  });

  it("plans insert paste with usable tracks when another pasted track would hit protected material", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineInsertPastePlan({
      clipboard,
      clips: [
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
        { id: "later-audio", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      startTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
      ],
      commits: [
        { clipId: "later-text", startTime: 10, endTime: 11 },
      ],
    });
  });

  it("plans insert paste with usable tracks when shifting another track would hit protected material", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineInsertPastePlan({
      clipboard,
      clips: [
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
        { id: "later-audio", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9 },
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 10.5, endTime: 11.5, locked: true },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      startTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
      ],
      commits: [
        { clipId: "later-text", startTime: 10, endTime: 11 },
      ],
    });
  });

  it("plans insert paste by splitting same-track clips that span the paste time", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "insert" },
      ],
      new Set(["copied-text"]),
    );

    expect(getTimelineInsertPastePlan({
      clipboard,
      clips: [
        { id: "spanning", trackType: "text", trackIndex: 1, startTime: 2, endTime: 8, trimStart: 10, trimEnd: 16, textContent: "caption" },
        { id: "later", trackType: "text", trackIndex: 1, startTime: 9, endTime: 10 },
        { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 8 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      startTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, textContent: "insert" },
        { trackType: "text", trackIndex: 1, startTime: 7, endTime: 10, trimStart: 13, trimEnd: 16, textContent: "caption" },
      ],
      commits: [
        { clipId: "spanning", startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { clipId: "later", startTime: 11, endTime: 12 },
      ],
    });
  });

  it("plans overwrite paste by clearing overlapping editable clips on pasted tracks", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
      ],
      new Set(["copied-text"]),
    );

    expect(getTimelineOverwritePastePlan({
      clipboard,
      clips: [
        { id: "left-overlap", trackType: "text", trackIndex: 1, startTime: 4, endTime: 7, trimStart: 10, trimEnd: 13 },
        { id: "covered", trackType: "text", trackIndex: 1, startTime: 6.2, endTime: 7.4 },
        { id: "right-overlap", trackType: "text", trackIndex: 1, startTime: 7.5, endTime: 10, trimStart: 20, trimEnd: 22.5 },
        { id: "spanning", trackType: "text", trackIndex: 1, startTime: 3, endTime: 11, trimStart: 30, trimEnd: 38 },
        { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 10 },
        { id: "locked-track", trackType: "text", trackIndex: 2, startTime: 6, endTime: 10 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: true },
        { type: "audio", index: 1, locked: false },
      ],
      startTime: 6,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 6, endTime: 8 },
        { trackType: "text", trackIndex: 1, startTime: 8, endTime: 11, trimStart: 35, trimEnd: 38 },
      ],
      deleteIds: ["covered"],
      commits: [
        { clipId: "spanning", startTime: 3, endTime: 6, trimStart: 30, trimEnd: 33 },
        { clipId: "left-overlap", startTime: 4, endTime: 6, trimStart: 10, trimEnd: 12 },
        { clipId: "right-overlap", startTime: 8, endTime: 10, trimStart: 20.5, trimEnd: 22.5 },
      ],
    });
  });

  it("plans overwrite paste with usable tracks when another pasted track would hit protected material", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineOverwritePastePlan({
      clipboard,
      clips: [
        { id: "text-overlap", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      startTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
      ],
      deleteIds: ["text-overlap"],
      commits: [],
    });
  });

  it("does not overwrite paste over locked clips on editable tracks", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      ],
      new Set(["copied-text"]),
    );

    expect(getTimelineOverwritePastePlan({
      clipboard,
      clips: [
        { id: "locked-target", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
        { id: "editable-overlap", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
      ],
      tracks: [{ type: "text", index: 1, locked: false }],
      startTime: 5,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });
  });

  it("does not preserve overwrite split segments over locked clips", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
      ],
      new Set(["copied-text"]),
    );

    expect(getTimelineOverwritePastePlan({
      clipboard,
      clips: [
        { id: "spanning", trackType: "text", trackIndex: 1, startTime: 4, endTime: 9, trimStart: 10, trimEnd: 15 },
        { id: "locked-right", trackType: "text", trackIndex: 1, startTime: 7.5, endTime: 9.5, locked: true },
      ],
      tracks: [{ type: "text", index: 1, locked: false }],
      startTime: 5,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });
  });

  it("plans overwrite paste with usable tracks when preserving another track would hit protected material", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineOverwritePastePlan({
      clipboard,
      clips: [
        { id: "text-overlap", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
        { id: "spanning-audio", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 9, trimStart: 10, trimEnd: 15 },
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 7.5, endTime: 8.5, locked: true },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      startTime: 5,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
      ],
      deleteIds: ["text-overlap"],
      commits: [],
    });
  });

  it("plans replace selection paste at the selected group start while deleting selected editable clips", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5, textContent: "new" },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 6 },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineReplaceSelectionPastePlan({
      clipboard,
      clips: [
        { id: "old-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
        { id: "old-audio", trackType: "audio", trackIndex: 1, startTime: 11, endTime: 13 },
        { id: "locked-selected", trackType: "video", trackIndex: 1, startTime: 10, endTime: 12 },
        { id: "unselected", trackType: "text", trackIndex: 1, startTime: 15, endTime: 16 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "video", index: 1, locked: true },
      ],
      selectedClipIds: new Set(["old-text", "old-audio", "locked-selected"]),
      selectedClipId: null,
      playheadTime: 30,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, textContent: "new" },
        { trackType: "audio", trackIndex: 1, startTime: 11, endTime: 13 },
      ],
      deleteIds: ["old-audio", "old-text"],
      commits: [],
    });
  });

  it("does not replace selection paste over unselected locked clips", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "new" },
      ],
      new Set(["copied-text"]),
    );

    expect(getTimelineReplaceSelectionPastePlan({
      clipboard,
      clips: [
        { id: "old-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
        { id: "locked-target", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, locked: true },
      ],
      tracks: [{ type: "text", index: 1, locked: false }],
      selectedClipIds: new Set(["old-text"]),
      selectedClipId: null,
      playheadTime: 30,
    })).toEqual({ inputs: [], deleteIds: [], commits: [] });
  });

  it("replaces usable selected tracks when another pasted track is blocked by protected material", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "copied-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "new" },
        { id: "copied-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
      ],
      new Set(["copied-text", "copied-audio"]),
    );

    expect(getTimelineReplaceSelectionPastePlan({
      clipboard,
      clips: [
        { id: "old-text", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
        { id: "old-audio", trackType: "audio", trackIndex: 1, startTime: 10, endTime: 12 },
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 10, endTime: 12, locked: true },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      selectedClipIds: new Set(["old-text", "old-audio"]),
      selectedClipId: null,
      playheadTime: 30,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 10, endTime: 12, textContent: "new" },
      ],
      deleteIds: ["old-text"],
      commits: [],
    });
  });
});

describe("slipTimelineClips", () => {
  it("moves selected source windows while keeping timeline placement unchanged", () => {
    expect(
      slipTimelineClips(
        [
          { id: "clip-1", startTime: 2, endTime: 7, trimStart: 10, trimEnd: 15 },
          { id: "clip-2", startTime: 8, endTime: 10, trimStart: 1, trimEnd: 3 },
          { id: "clip-3", startTime: 12, endTime: 15 },
        ],
        new Set(["clip-1", "clip-2", "clip-3"]),
        0.5,
      ),
    ).toEqual([
      { clipId: "clip-1", startTime: 2, endTime: 7, trimStart: 10.5, trimEnd: 15.5 },
      { clipId: "clip-2", startTime: 8, endTime: 10, trimStart: 1.5, trimEnd: 3.5 },
      { clipId: "clip-3", startTime: 12, endTime: 15, trimStart: 0.5, trimEnd: 3.5 },
    ]);
  });

  it("clamps slip-left at the earliest selected source start", () => {
    expect(
      slipTimelineClips(
        [
          { id: "clip-1", startTime: 2, endTime: 7, trimStart: 10, trimEnd: 15 },
          { id: "clip-2", startTime: 8, endTime: 10, trimStart: 0.25, trimEnd: 2.25 },
        ],
        new Set(["clip-1", "clip-2"]),
        -1,
      ),
    ).toEqual([
      { clipId: "clip-1", startTime: 2, endTime: 7, trimStart: 9.75, trimEnd: 14.75 },
      { clipId: "clip-2", startTime: 8, endTime: 10, trimStart: 0, trimEnd: 2 },
    ]);
  });
});

describe("getTimelineSlipTargetCommits", () => {
  it("slips editable selected clips while skipping locked tracks", () => {
    expect(
      getTimelineSlipTargetCommits(
        [
          { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4, trimStart: 4, trimEnd: 8 },
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 5, endTime: 8, trimStart: 1, trimEnd: 4 },
        ],
        [
          { type: "video", index: 1, locked: true },
          { type: "text", index: 1, locked: false },
        ],
        new Set(["video-1", "text-1"]),
        null,
        0.25,
      ),
    ).toEqual([
      { clipId: "text-1", startTime: 5, endTime: 8, trimStart: 1.25, trimEnd: 4.25 },
    ]);
  });
});

describe("getTimelineNudgeTargetCommits", () => {
  it("nudges editable selected clips while skipping locked tracks", () => {
    const result = getTimelineNudgeTargetCommits(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0.5, endTime: 2.5 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "text", index: 1, locked: false },
      ],
      new Set(["video-1", "text-1"]),
      null,
      -1,
    );

    expect(result).toEqual([{ clipId: "text-1", startTime: 2, endTime: 4 }]);
  });

  it("clamps nudges at unselected clips on the same track", () => {
    expect(getTimelineNudgeTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "target", trackType: "text", trackIndex: 1, startTime: 4.5, endTime: 6 },
        { id: "other-track", trackType: "text", trackIndex: 2, startTime: 2.25, endTime: 5 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: false },
      ],
      new Set(["text-1"]),
      null,
      1,
    )).toEqual([{ clipId: "text-1", startTime: 2.5, endTime: 4.5 }]);
  });
});

describe("getTimelineNudgeStepSeconds", () => {
  it("uses frame nudges by default and one-second nudges with Shift", () => {
    expect(getTimelineNudgeStepSeconds(false)).toBeCloseTo(1 / 30);
    expect(getTimelineNudgeStepSeconds(true)).toBe(1);
  });
});

describe("getTimelineAlignSelectionTargetCommits", () => {
  it("aligns the selected group start to the playhead while preserving relative offsets", () => {
    expect(
      getTimelineAlignSelectionTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
          { id: "text-2", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7, trimStart: 10, trimEnd: 11 },
          { id: "locked", trackType: "text", trackIndex: 2, startTime: 4, endTime: 6 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
        ],
        new Set(["text-1", "text-2", "locked"]),
        null,
        10,
        "start",
      ),
    ).toEqual([
      { clipId: "text-1", startTime: 10, endTime: 12 },
      { clipId: "text-2", startTime: 13, endTime: 14, trimStart: 10, trimEnd: 11 },
    ]);
  });

  it("aligns the selected group end to the playhead and clamps at timeline start", () => {
    expect(
      getTimelineAlignSelectionTargetCommits(
        [
          { id: "clip-1", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 5 },
          { id: "clip-2", trackType: "audio", trackIndex: 1, startTime: 7, endTime: 9 },
        ],
        [{ type: "audio", index: 1, locked: false }],
        new Set(["clip-1", "clip-2"]),
        null,
        4,
        "end",
      ),
    ).toEqual([
      { clipId: "clip-1", startTime: 0, endTime: 2 },
      { clipId: "clip-2", startTime: 4, endTime: 6 },
    ]);
  });

  it("clamps align movement at unselected clips on the same track", () => {
    expect(
      getTimelineAlignSelectionTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
          { id: "target", trackType: "text", trackIndex: 1, startTime: 4.5, endTime: 6 },
          { id: "other-track", trackType: "text", trackIndex: 2, startTime: 2.25, endTime: 5 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: false },
        ],
        new Set(["text-1"]),
        null,
        10,
        "start",
      ),
    ).toEqual([{ clipId: "text-1", startTime: 2.5, endTime: 4.5, trimStart: 10, trimEnd: 12 }]);
  });
});

describe("getTimelineAlignSelectionToNearestMarkerTargetCommits", () => {
  it("moves the selected group start to the nearest marker while preserving offsets", () => {
    expect(
      getTimelineAlignSelectionToNearestMarkerTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "text-2", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9, trimStart: 10, trimEnd: 11 },
          { id: "locked", trackType: "text", trackIndex: 2, startTime: 4, endTime: 6 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
        ],
        [
          { id: "marker-1", time: 2 },
          { id: "marker-2", time: 6.8 },
          { id: "marker-3", time: 14 },
        ],
        new Set(["text-1", "text-2", "locked"]),
        null,
        "start",
      ),
    ).toEqual([
      { clipId: "text-1", startTime: 6.8, endTime: 8.8 },
      { clipId: "text-2", startTime: 9.8, endTime: 10.8, trimStart: 10, trimEnd: 11 },
    ]);
  });

  it("moves the selected group end to the nearest marker and clamps at timeline start", () => {
    expect(
      getTimelineAlignSelectionToNearestMarkerTargetCommits(
        [
          { id: "clip-1", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 5 },
          { id: "clip-2", trackType: "audio", trackIndex: 1, startTime: 7, endTime: 9 },
        ],
        [{ type: "audio", index: 1, locked: false }],
        [
          { id: "marker-1", time: 1 },
          { id: "marker-2", time: 20 },
        ],
        new Set(["clip-1", "clip-2"]),
        null,
        "end",
      ),
    ).toEqual([
      { clipId: "clip-1", startTime: 0, endTime: 2 },
      { clipId: "clip-2", startTime: 4, endTime: 6 },
    ]);
  });

  it("falls back to the active clip and returns no commits without markers", () => {
    expect(
      getTimelineAlignSelectionToNearestMarkerTargetCommits(
        [{ id: "clip-1", trackType: "video", trackIndex: 1, startTime: 3, endTime: 5 }],
        [{ type: "video", index: 1, locked: false }],
        [],
        new Set(),
        "clip-1",
        "start",
      ),
    ).toEqual([]);
  });
});

describe("getTimelineTrimSelectionToNearestMarkerTargetCommits", () => {
  it("extends selected clip starts to the nearest marker while preserving source trims", () => {
    expect(
      getTimelineTrimSelectionToNearestMarkerTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 5, endTime: 9, trimStart: 10, trimEnd: 14 },
          { id: "text-2", trackType: "text", trackIndex: 1, startTime: 6, endTime: 10, trimStart: 2, trimEnd: 6 },
          { id: "locked", trackType: "text", trackIndex: 2, startTime: 5, endTime: 9 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
        ],
        [
          { id: "marker-1", time: 3 },
          { id: "marker-2", time: 12 },
        ],
        new Set(["text-1", "text-2", "locked"]),
        null,
        "start",
      ),
    ).toEqual([
      { clipId: "text-1", startTime: 3, endTime: 9, trimStart: 8, trimEnd: 14 },
      { clipId: "text-2", startTime: 3, endTime: 10, trimStart: 0, trimEnd: 6 },
    ]);
  });

  it("extends selected clip ends to the nearest marker while preserving source trims", () => {
    expect(
      getTimelineTrimSelectionToNearestMarkerTargetCommits(
        [
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 8, trimStart: 10, trimEnd: 14 },
          { id: "audio-2", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 9 },
        ],
        [{ type: "audio", index: 1, locked: false }],
        [
          { id: "marker-1", time: 2 },
          { id: "marker-2", time: 11 },
        ],
        new Set(["audio-1", "audio-2"]),
        null,
        "end",
      ),
    ).toEqual([
      { clipId: "audio-1", startTime: 4, endTime: 11, trimStart: 10, trimEnd: 17 },
      { clipId: "audio-2", startTime: 5, endTime: 11 },
    ]);
  });

  it("clamps trim-to-marker extensions at unselected same-track clips", () => {
    expect(
      getTimelineTrimSelectionToNearestMarkerTargetCommits(
        [
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
          { id: "blocker", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 6 },
          { id: "other-track", trackType: "audio", trackIndex: 2, startTime: 4.25, endTime: 7 },
        ],
        [
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: false },
        ],
        [{ id: "marker", time: 7 }],
        new Set(["audio-1"]),
        null,
        "end",
      ),
    ).toEqual([{ clipId: "audio-1", startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 }]);
  });
});

describe("getTimelineTrimSelectionToMarkerRangeTargetCommits", () => {
  it("trims editable selected clips to the current marker range while preserving source trims", () => {
    expect(
      getTimelineTrimSelectionToMarkerRangeTargetCommits(
        [
          { id: "left-overlap", trackType: "video", trackIndex: 1, startTime: 2, endTime: 6, trimStart: 10, trimEnd: 14 },
          { id: "right-overlap", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 10, trimStart: 20, trimEnd: 24 },
          { id: "inside", trackType: "text", trackIndex: 1, startTime: 4.5, endTime: 7 },
          { id: "spans-both", trackType: "video", trackIndex: 2, startTime: 1, endTime: 11, trimStart: 30, trimEnd: 40 },
          { id: "outside", trackType: "video", trackIndex: 1, startTime: 9, endTime: 10 },
          { id: "locked", trackType: "sticker", trackIndex: 1, startTime: 2, endTime: 10 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
          { type: "sticker", index: 1, locked: true },
        ],
        [
          { id: "in", time: 4 },
          { id: "out", time: 8 },
        ],
        new Set(["left-overlap", "right-overlap", "inside", "spans-both", "outside", "locked"]),
        null,
        5,
      ),
    ).toEqual([
      { clipId: "spans-both", startTime: 4, endTime: 8, trimStart: 33, trimEnd: 37 },
      { clipId: "left-overlap", startTime: 4, endTime: 6, trimStart: 12, trimEnd: 14 },
      { clipId: "inside", startTime: 4.5, endTime: 7 },
      { clipId: "right-overlap", startTime: 6, endTime: 8, trimStart: 20, trimEnd: 22 },
    ]);
  });

  it("returns no commits without an editable selection or complete marker bracket", () => {
    expect(getTimelineTrimSelectionToMarkerRangeTargetCommits(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 2, endTime: 10 }],
      [{ type: "video", index: 1, locked: false }],
      [{ id: "in", time: 4 }],
      new Set(["clip"]),
      null,
      5,
    )).toEqual([]);
  });
});

describe("getTimelineTrimSelectionToNearestEditPointTargetCommits", () => {
  it("trims selected starts to the nearest timeline edit point", () => {
    expect(
      getTimelineTrimSelectionToNearestEditPointTargetCommits(
        [
          { id: "previous", trackType: "text", trackIndex: 1, startTime: 1, endTime: 3 },
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 9, trimStart: 10, trimEnd: 14 },
          { id: "locked", trackType: "text", trackIndex: 2, startTime: 5, endTime: 9 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
        ],
        [],
        new Set(["selected", "locked"]),
        null,
        "start",
      ),
    ).toEqual([
      { clipId: "selected", startTime: 3, endTime: 9, trimStart: 8, trimEnd: 14 },
    ]);
  });

  it("trims selected ends to the nearest scene or clip edit point", () => {
    expect(
      getTimelineTrimSelectionToNearestEditPointTargetCommits(
        [
          { id: "selected", trackType: "audio", trackIndex: 1, startTime: 4, endTime: 8, trimStart: 10, trimEnd: 14 },
          { id: "next", trackType: "audio", trackIndex: 1, startTime: 11, endTime: 12 },
        ],
        [{ type: "audio", index: 1, locked: false }],
        [{ id: "scene-1", timelinePositionSeconds: 0, duration: 9.5 }],
        new Set(["selected"]),
        null,
        "end",
      ),
    ).toEqual([
      { clipId: "selected", startTime: 4, endTime: 9.5, trimStart: 10, trimEnd: 15.5 },
    ]);
  });
});

describe("getTimelinePackSelectionTargetCommits", () => {
  it("closes gaps between selected clips on each editable track", () => {
    expect(
      getTimelinePackSelectionTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
          { id: "text-2", trackType: "text", trackIndex: 1, startTime: 7, endTime: 8, trimStart: 20, trimEnd: 21 },
          { id: "text-3", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 5 },
          { id: "audio-2", trackType: "audio", trackIndex: 1, startTime: 9, endTime: 10 },
          { id: "locked", trackType: "text", trackIndex: 2, startTime: 6, endTime: 8 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["text-1", "text-2", "text-3", "audio-1", "audio-2", "locked"]),
        null,
      ),
    ).toEqual([
      { clipId: "text-2", startTime: 4, endTime: 5, trimStart: 20, trimEnd: 21 },
      { clipId: "audio-2", startTime: 5, endTime: 6 },
      { clipId: "text-3", startTime: 5, endTime: 7 },
    ]);
  });

  it("returns no commits when selected clips are already packed", () => {
    expect(
      getTimelinePackSelectionTargetCommits(
        [
          { id: "clip-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "clip-2", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5 },
        ],
        [{ type: "video", index: 1, locked: false }],
        new Set(["clip-1", "clip-2"]),
        null,
      ),
    ).toEqual([]);
  });

  it("packs selected clips around unselected same-track blockers", () => {
    expect(
      getTimelinePackSelectionTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "blocker", trackType: "text", trackIndex: 1, startTime: 2.5, endTime: 4 },
          { id: "text-2", trackType: "text", trackIndex: 1, startTime: 7, endTime: 8, trimStart: 20, trimEnd: 21 },
          { id: "other-track", trackType: "text", trackIndex: 2, startTime: 2, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: false },
        ],
        new Set(["text-1", "text-2"]),
        null,
      ),
    ).toEqual([{ clipId: "text-2", startTime: 4, endTime: 5, trimStart: 20, trimEnd: 21 }]);
  });
});

describe("getTimelineCloseActiveTrackGapsTargetCommits", () => {
  it("closes every gap on the active editable track without moving other tracks", () => {
    expect(
      getTimelineCloseActiveTrackGapsTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "active", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, trimStart: 10, trimEnd: 12 },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 10, endTime: 11 },
          { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "locked-track", trackType: "text", trackIndex: 2, startTime: 5, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["active"]),
        null,
      ),
    ).toEqual([
      { clipId: "active", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
      { clipId: "later", startTime: 4, endTime: 5 },
    ]);
  });

  it("returns no commits when the active track is locked", () => {
    expect(
      getTimelineCloseActiveTrackGapsTargetCommits(
        [
          { id: "active", trackType: "video", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "later", trackType: "video", trackIndex: 1, startTime: 9, endTime: 10 },
        ],
        [{ type: "video", index: 1, locked: true }],
        new Set(["active"]),
        null,
      ),
    ).toEqual([]);
  });

  it("closes gaps without moving editable clips through locked clips on the active track", () => {
    expect(
      getTimelineCloseActiveTrackGapsTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "locked-middle", trackType: "text", trackIndex: 1, startTime: 3, endTime: 6, locked: true },
          { id: "active", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["active"]),
        null,
      ),
    ).toEqual([
      { clipId: "active", startTime: 6, endTime: 8 },
    ]);
  });
});

describe("getTimelineCloseAllTrackGapsTargetCommits", () => {
  it("closes every gap on each editable track independently", () => {
    expect(
      getTimelineCloseAllTrackGapsTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-2", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, trimStart: 10, trimEnd: 12 },
          { id: "text-3", trackType: "text", trackIndex: 1, startTime: 9, endTime: 10 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 1, endTime: 3 },
          { id: "audio-2", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 8 },
          { id: "locked-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "locked-2", trackType: "video", trackIndex: 1, startTime: 6, endTime: 8 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: true },
        ],
      ),
    ).toEqual([
      { clipId: "text-2", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
      { clipId: "audio-2", startTime: 3, endTime: 5 },
      { clipId: "text-3", startTime: 4, endTime: 5 },
    ]);
  });

  it("returns no commits when editable tracks are already gapless", () => {
    expect(
      getTimelineCloseAllTrackGapsTargetCommits(
        [
          { id: "clip-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "clip-2", trackType: "video", trackIndex: 1, startTime: 2, endTime: 5 },
        ],
        [{ type: "video", index: 1, locked: false }],
      ),
    ).toEqual([]);
  });

  it("closes all track gaps without moving editable clips through locked clips", () => {
    expect(
      getTimelineCloseAllTrackGapsTargetCommits(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-locked", trackType: "text", trackIndex: 1, startTime: 3, endTime: 6, locked: true },
          { id: "text-2", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
          { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "audio-2", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
      ),
    ).toEqual([
      { clipId: "audio-2", startTime: 2, endTime: 4 },
      { clipId: "text-2", startTime: 6, endTime: 8 },
    ]);
  });
});

describe("getTimelineDeleteGapTargetCommits", () => {
  it("closes the empty gap before the active clip on the same editable track", () => {
    expect(
      getTimelineDeleteGapTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "active", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
          { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "locked-track", trackType: "text", trackIndex: 2, startTime: 5, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["active"]),
        null,
        3.5,
      ),
    ).toEqual([
      { clipId: "active", startTime: 2, endTime: 4 },
      { clipId: "later", startTime: 5, endTime: 6 },
    ]);
  });

  it("does not move clips when the playhead is not in the active track gap", () => {
    expect(
      getTimelineDeleteGapTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "active", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["active"]),
        null,
        5.1,
      ),
    ).toEqual([]);
  });

  it("deletes only the gap after a locked clip on the active track", () => {
    expect(
      getTimelineDeleteGapTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "locked-middle", trackType: "text", trackIndex: 1, startTime: 3, endTime: 6, locked: true },
          { id: "active", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 12, endTime: 13 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["active"]),
        null,
        7,
      ),
    ).toEqual([
      { clipId: "active", startTime: 6, endTime: 8 },
      { clipId: "later", startTime: 9, endTime: 10 },
    ]);
  });

  it("does not delete the active track gap by shifting later clips through locked clips", () => {
    expect(
      getTimelineDeleteGapTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "active", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "locked-middle", trackType: "text", trackIndex: 1, startTime: 7.5, endTime: 8.5, locked: true },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 10, endTime: 11, trimStart: 20, trimEnd: 21 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["active"]),
        null,
        3,
      ),
    ).toEqual([
      { clipId: "active", startTime: 2, endTime: 4 },
      { clipId: "later", startTime: 8.5, endTime: 9.5, trimStart: 20, trimEnd: 21 },
    ]);
  });
});

describe("getTimelineDeleteGlobalGapTargetCommits", () => {
  it("deletes the shared empty gap under the playhead across editable tracks", () => {
    expect(
      getTimelineDeleteGlobalGapTargetCommits(
        [
          { id: "text-before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-after", trackType: "text", trackIndex: 1, startTime: 6, endTime: 8, trimStart: 10, trimEnd: 12 },
          { id: "audio-before", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 3 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "locked-after", trackType: "video", trackIndex: 1, startTime: 5, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: true },
        ],
        4,
      ),
    ).toEqual([
      { clipId: "audio-after", startTime: 3, endTime: 5 },
      { clipId: "text-after", startTime: 4, endTime: 6, trimStart: 10, trimEnd: 12 },
    ]);
  });

  it("returns no commits when the playhead is not inside an editable global gap", () => {
    expect(
      getTimelineDeleteGlobalGapTargetCommits(
        [
          { id: "overlap", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 6, endTime: 8 },
        ],
        [{ type: "text", index: 1, locked: false }],
        4,
      ),
    ).toEqual([]);
  });

  it("does not delete a global gap through a locked clip on an editable track", () => {
    expect(
      getTimelineDeleteGlobalGapTargetCommits(
        [
          { id: "text-before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-locked-middle", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5, locked: true },
          { id: "text-after", trackType: "text", trackIndex: 1, startTime: 7, endTime: 9 },
          { id: "audio-before", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 7, endTime: 9 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        4,
      ),
    ).toEqual([]);
  });

  it("does not delete a global gap by shifting later clips through locked clips", () => {
    expect(
      getTimelineDeleteGlobalGapTargetCommits(
        [
          { id: "text-before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-after", trackType: "text", trackIndex: 1, startTime: 5, endTime: 6, trimStart: 10, trimEnd: 11 },
          { id: "text-locked-later", trackType: "text", trackIndex: 1, startTime: 7.5, endTime: 8.5, locked: true },
          { id: "text-later", trackType: "text", trackIndex: 1, startTime: 10, endTime: 11 },
          { id: "audio-before", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 6 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        3,
      ),
    ).toEqual([
      { clipId: "audio-after", startTime: 2, endTime: 3 },
      { clipId: "text-after", startTime: 2, endTime: 3, trimStart: 10, trimEnd: 11 },
      { clipId: "text-later", startTime: 8.5, endTime: 9.5 },
    ]);
  });
});

describe("getTimelineDeleteAllTrackGapsAtPlayheadTargetCommits", () => {
  it("closes each editable track gap under the playhead independently", () => {
    expect(
      getTimelineDeleteAllTrackGapsAtPlayheadTargetCommits(
        [
          { id: "text-before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-after", trackType: "text", trackIndex: 1, startTime: 6, endTime: 8, trimStart: 10, trimEnd: 12 },
          { id: "audio-before", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 3 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "video-overlap", trackType: "video", trackIndex: 1, startTime: 3, endTime: 5 },
          { id: "video-after", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
          { id: "locked-after", trackType: "sticker", trackIndex: 1, startTime: 5, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: false },
          { type: "sticker", index: 1, locked: true },
        ],
        4,
      ),
    ).toEqual([
      { clipId: "audio-after", startTime: 3, endTime: 5 },
      { clipId: "text-after", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
    ]);
  });

  it("deletes only the gap after locked clips on each affected track", () => {
    expect(
      getTimelineDeleteAllTrackGapsAtPlayheadTargetCommits(
        [
          { id: "text-before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-locked-middle", trackType: "text", trackIndex: 1, startTime: 3, endTime: 6, locked: true },
          { id: "text-after", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
          { id: "audio-before", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 10 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        7,
      ),
    ).toEqual([
      { clipId: "audio-after", startTime: 4, endTime: 6 },
      { clipId: "text-after", startTime: 6, endTime: 8 },
    ]);
  });
});

describe("getTimelineDeleteMarkerRangeGapTargetCommits", () => {
  it("closes an empty marker bracket across editable tracks", () => {
    expect(
      getTimelineDeleteMarkerRangeGapTargetCommits(
        [
          { id: "video-before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4 },
          { id: "video-after", trackType: "video", trackIndex: 1, startTime: 7, endTime: 9, trimStart: 10, trimEnd: 12 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 10 },
          { id: "locked-after", trackType: "sticker", trackIndex: 1, startTime: 7, endTime: 9 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "sticker", index: 1, locked: true },
        ],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([
      { clipId: "video-after", startTime: 4, endTime: 6, trimStart: 10, trimEnd: 12 },
      { clipId: "audio-after", startTime: 5, endTime: 7 },
    ]);
  });

  it("does not close a marker range that contains editable content", () => {
    expect(
      getTimelineDeleteMarkerRangeGapTargetCommits(
        [
          { id: "inside", trackType: "video", trackIndex: 1, startTime: 5, endTime: 6 },
          { id: "after", trackType: "video", trackIndex: 1, startTime: 7, endTime: 9 },
        ],
        [{ type: "video", index: 1, locked: false }],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([]);
  });

  it("does not close a marker range that contains a locked clip on an editable track", () => {
    expect(
      getTimelineDeleteMarkerRangeGapTargetCommits(
        [
          { id: "locked-inside", trackType: "video", trackIndex: 1, startTime: 5, endTime: 6, locked: true },
          { id: "video-after", trackType: "video", trackIndex: 1, startTime: 7, endTime: 9 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 10 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([]);
  });

  it("does not close a marker range by shifting later clips through locked clips", () => {
    expect(
      getTimelineDeleteMarkerRangeGapTargetCommits(
        [
          { id: "video-before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4 },
          { id: "video-after", trackType: "video", trackIndex: 1, startTime: 7, endTime: 8, trimStart: 10, trimEnd: 11 },
          { id: "video-locked-later", trackType: "video", trackIndex: 1, startTime: 9, endTime: 10, locked: true },
          { id: "video-later", trackType: "video", trackIndex: 1, startTime: 12, endTime: 13 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([
      { clipId: "video-after", startTime: 4, endTime: 5, trimStart: 10, trimEnd: 11 },
      { clipId: "audio-after", startTime: 5, endTime: 6 },
      { clipId: "video-later", startTime: 10, endTime: 11 },
    ]);
  });

  it("returns no commits without a complete marker bracket", () => {
    expect(
      getTimelineDeleteMarkerRangeGapTargetCommits(
        [{ id: "after", trackType: "video", trackIndex: 1, startTime: 7, endTime: 9 }],
        [{ type: "video", index: 1, locked: false }],
        [{ id: "in", time: 4 }],
        5,
      ),
    ).toEqual([]);
  });
});

describe("getTimelineDeleteMarkerOutGapTargetCommits", () => {
  it("closes an empty marker-duration gap after the out marker across editable tracks", () => {
    expect(
      getTimelineDeleteMarkerOutGapTargetCommits(
        [
          { id: "inside", trackType: "video", trackIndex: 1, startTime: 4, endTime: 7 },
          { id: "video-after", trackType: "video", trackIndex: 1, startTime: 10, endTime: 12, trimStart: 10, trimEnd: 12 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 11, endTime: 13 },
          { id: "locked-after", trackType: "sticker", trackIndex: 1, startTime: 10, endTime: 12 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "sticker", index: 1, locked: true },
        ],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([
      { clipId: "video-after", startTime: 7, endTime: 9, trimStart: 10, trimEnd: 12 },
      { clipId: "audio-after", startTime: 8, endTime: 10 },
    ]);
  });

  it("does not close a marker out gap that contains editable content", () => {
    expect(
      getTimelineDeleteMarkerOutGapTargetCommits(
        [
          { id: "inside-out-gap", trackType: "video", trackIndex: 1, startTime: 8, endTime: 9 },
          { id: "after", trackType: "video", trackIndex: 1, startTime: 10, endTime: 12 },
        ],
        [{ type: "video", index: 1, locked: false }],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([]);
  });

  it("does not close a marker out gap that contains a locked clip on an editable track", () => {
    expect(
      getTimelineDeleteMarkerOutGapTargetCommits(
        [
          { id: "locked-out-gap", trackType: "video", trackIndex: 1, startTime: 8, endTime: 9, locked: true },
          { id: "video-after", trackType: "video", trackIndex: 1, startTime: 10, endTime: 12 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 11, endTime: 13 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([]);
  });

  it("does not close a marker out gap by shifting later clips through locked clips", () => {
    expect(
      getTimelineDeleteMarkerOutGapTargetCommits(
        [
          { id: "inside", trackType: "video", trackIndex: 1, startTime: 4, endTime: 7 },
          { id: "video-after", trackType: "video", trackIndex: 1, startTime: 10, endTime: 11, trimStart: 10, trimEnd: 11 },
          { id: "video-locked-later", trackType: "video", trackIndex: 1, startTime: 12, endTime: 13, locked: true },
          { id: "video-later", trackType: "video", trackIndex: 1, startTime: 15, endTime: 16 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 11, endTime: 12 },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        [
          { id: "in", time: 4 },
          { id: "out", time: 7 },
        ],
        5,
      ),
    ).toEqual([
      { clipId: "video-after", startTime: 7, endTime: 8, trimStart: 10, trimEnd: 11 },
      { clipId: "audio-after", startTime: 8, endTime: 9 },
      { clipId: "video-later", startTime: 13, endTime: 14 },
    ]);
  });
});

describe("getTimelineInsertGapTargetCommits", () => {
  it("inserts a gap on the active editable track at the playhead", () => {
    expect(
      getTimelineInsertGapTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "active", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, trimStart: 10, trimEnd: 12 },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
          { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "locked-track", trackType: "text", trackIndex: 2, startTime: 5, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "text", index: 2, locked: true },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["active"]),
        null,
        4,
        1.5,
      ),
    ).toEqual([
      { clipId: "active", startTime: 6.5, endTime: 8.5, trimStart: 10, trimEnd: 12 },
      { clipId: "later", startTime: 9.5, endTime: 10.5 },
    ]);
  });

  it("does not insert active track gaps on locked tracks", () => {
    expect(
      getTimelineInsertGapTargetCommits(
        [
          { id: "selected", trackType: "video", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "later", trackType: "video", trackIndex: 1, startTime: 8, endTime: 9 },
        ],
        [{ type: "video", index: 1, locked: true }],
        new Set(["selected"]),
        null,
        4,
        1,
      ),
    ).toEqual([]);
  });

  it("does not insert an active track gap that would push clips into a locked clip", () => {
    expect(
      getTimelineInsertGapTargetCommits(
        [
          { id: "active", trackType: "video", trackIndex: 1, startTime: 2, endTime: 3 },
          { id: "later", trackType: "video", trackIndex: 1, startTime: 5, endTime: 6 },
          { id: "locked-boundary", trackType: "video", trackIndex: 1, startTime: 6.5, endTime: 8, locked: true },
        ],
        [{ type: "video", index: 1, locked: false }],
        new Set(["active"]),
        null,
        4,
        2,
      ),
    ).toEqual([]);
  });
});

describe("getTimelineInsertGapPlan", () => {
  it("splits the active track clip spanning the playhead and shifts only that track", () => {
    expect(
      getTimelineInsertGapPlan(
        [
          { id: "active", trackType: "text", trackIndex: 1, startTime: 2, endTime: 8, trimStart: 10, trimEnd: 16, textContent: "caption" },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 9, endTime: 10 },
          { id: "other", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 8 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["active"]),
        null,
        5,
        2,
      ),
    ).toEqual({
      commits: [
        { clipId: "active", startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { clipId: "later", startTime: 11, endTime: 12 },
      ],
      creates: [
        {
          trackType: "text",
          trackIndex: 1,
          startTime: 7,
          endTime: 10,
          trimStart: 13,
          trimEnd: 16,
          textContent: "caption",
        },
      ],
    });
  });
});

describe("getTimelineInsertGlobalGapTargetCommits", () => {
  it("inserts a gap across every editable track at the playhead", () => {
    expect(
      getTimelineInsertGlobalGapTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
          { id: "text-at", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, trimStart: 10, trimEnd: 12 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
          { id: "locked-after", trackType: "video", trackIndex: 1, startTime: 5, endTime: 7 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "video", index: 1, locked: true },
        ],
        4,
        2,
      ),
    ).toEqual([
      { clipId: "text-at", startTime: 6, endTime: 8, trimStart: 10, trimEnd: 12 },
      { clipId: "audio-after", startTime: 7, endTime: 9 },
    ]);
  });

  it("returns no commits for invalid global gap requests", () => {
    expect(getTimelineInsertGlobalGapTargetCommits([], [], 4, 0)).toEqual([]);
    expect(getTimelineInsertGlobalGapTargetCommits([], [], Number.NaN, 1)).toEqual([]);
  });

  it("does not insert a global gap that would push clips into locked clips", () => {
    expect(
      getTimelineInsertGlobalGapTargetCommits(
        [
          { id: "text-after", trackType: "text", trackIndex: 1, startTime: 5, endTime: 6 },
          { id: "audio-after", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 6 },
          { id: "audio-locked-boundary", trackType: "audio", trackIndex: 1, startTime: 6.5, endTime: 8, locked: true },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        4,
        2,
      ),
    ).toEqual([]);
  });
});

describe("getTimelineInsertGlobalGapPlan", () => {
  it("splits clips spanning the playhead and shifts the right segment into the inserted gap", () => {
    expect(
      getTimelineInsertGlobalGapPlan(
        [
          { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 8, trimStart: 10, trimEnd: 16, mediaUrl: "https://example.com/audio.wav" },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 9, endTime: 10 },
          { id: "locked-spanning", trackType: "video", trackIndex: 1, startTime: 2, endTime: 8 },
        ],
        [
          { type: "audio", index: 1, locked: false },
          { type: "text", index: 1, locked: false },
          { type: "video", index: 1, locked: true },
        ],
        5,
        2,
      ),
    ).toEqual({
      commits: [
        { clipId: "spanning", startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
        { clipId: "later", startTime: 11, endTime: 12 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 7,
          endTime: 10,
          trimStart: 13,
          trimEnd: 16,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });
});

describe("getTimelineInsertMarkerRangeGapPlan", () => {
  it("inserts a global gap using the marker bracket duration at the in marker", () => {
    expect(getTimelineInsertMarkerRangeGapPlan(
      [
        { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 8, trimStart: 10, trimEnd: 16, mediaUrl: "https://example.com/audio.wav" },
        { id: "at-marker", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, trimStart: 20, trimEnd: 22 },
        { id: "later", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
        { id: "locked", trackType: "sticker", trackIndex: 1, startTime: 4, endTime: 6 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 7 },
      ],
      5,
    )).toEqual({
      commits: [
        { clipId: "spanning", startTime: 2, endTime: 4, trimStart: 10, trimEnd: 12 },
        { clipId: "at-marker", startTime: 7, endTime: 9, trimStart: 20, trimEnd: 22 },
        { clipId: "later", startTime: 11, endTime: 13 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 7,
          endTime: 11,
          trimStart: 12,
          trimEnd: 16,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });

  it("returns an empty plan without a complete marker bracket", () => {
    expect(getTimelineInsertMarkerRangeGapPlan(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 }],
      [{ type: "video", index: 1, locked: false }],
      [{ id: "in", time: 2 }],
      3,
    )).toEqual({ commits: [], creates: [] });
  });
});

describe("getTimelineInsertMarkerOutGapPlan", () => {
  it("inserts a marker-duration global gap at the out marker", () => {
    expect(getTimelineInsertMarkerOutGapPlan(
      [
        { id: "inside", trackType: "video", trackIndex: 1, startTime: 4.5, endTime: 6 },
        { id: "spanning-out", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 10, trimStart: 20, trimEnd: 24, mediaUrl: "https://example.com/audio.wav" },
        { id: "later", trackType: "text", trackIndex: 1, startTime: 9, endTime: 10 },
        { id: "locked", trackType: "sticker", trackIndex: 1, startTime: 7, endTime: 8 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: true },
      ],
      [
        { id: "in", time: 4 },
        { id: "out", time: 7 },
      ],
      5,
    )).toEqual({
      commits: [
        { clipId: "spanning-out", startTime: 6, endTime: 7, trimStart: 20, trimEnd: 21 },
        { clipId: "later", startTime: 12, endTime: 13 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 10,
          endTime: 13,
          trimStart: 21,
          trimEnd: 24,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });
});

describe("getTimelineSlideTargetCommits", () => {
  it("clamps slide against the neighbor's own edge so gapped neighbors never invert", () => {
    const commits = getTimelineSlideTargetCommits(
      [
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 8 },
        { id: "after", trackType: "text", trackIndex: 1, startTime: 10, endTime: 12 },
      ],
      [{ type: "text", index: 1, locked: false }],
      new Set(["selected"]),
      null,
      5,
    );
    const after = commits.find((commit) => commit.clipId === "after");
    expect(after).toBeDefined();
    // "after" keeps a valid window (start < end) at minimum duration.
    expect(after!.endTime - after!.startTime).toBeGreaterThanOrEqual(0.1 - 0.001);
    expect(after!.endTime).toBe(12);
  });

  it("clamps slide left against a gapped previous neighbor's own edge", () => {
    const commits = getTimelineSlideTargetCommits(
      [
        { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 8 },
      ],
      [{ type: "text", index: 1, locked: false }],
      new Set(["selected"]),
      null,
      -5,
    );
    const before = commits.find((commit) => commit.clipId === "before");
    expect(before).toBeDefined();
    expect(before!.startTime).toBe(0);
    expect(before!.endTime - before!.startTime).toBeGreaterThanOrEqual(0.1 - 0.001);
  });

  it("slides a selected clip right while trimming adjacent same-track clips", () => {
    expect(
      getTimelineSlideTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5 },
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 8, trimStart: 10, trimEnd: 13 },
          { id: "after", trackType: "text", trackIndex: 1, startTime: 8, endTime: 12, trimStart: 20, trimEnd: 24 },
          { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 8 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["selected"]),
        null,
        1,
      ),
    ).toEqual([
      { clipId: "before", startTime: 0, endTime: 6, trimStart: 0, trimEnd: 6 },
      { clipId: "selected", startTime: 6, endTime: 9, trimStart: 10, trimEnd: 13 },
      { clipId: "after", startTime: 9, endTime: 12, trimStart: 21, trimEnd: 24 },
    ]);
  });

  it("slides a selected clip left while trimming adjacent same-track clips", () => {
    expect(
      getTimelineSlideTargetCommits(
        [
          { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 8 },
          { id: "after", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        -2,
      ),
    ).toEqual([
      { clipId: "before", startTime: 0, endTime: 3 },
      { clipId: "selected", startTime: 3, endTime: 6 },
      { clipId: "after", startTime: 6, endTime: 9 },
    ]);
  });

  it("skips slide edits on locked tracks", () => {
    expect(
      getTimelineSlideTargetCommits(
        [
          { id: "before", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "selected", trackType: "video", trackIndex: 1, startTime: 5, endTime: 8 },
          { id: "after", trackType: "video", trackIndex: 1, startTime: 8, endTime: 12 },
        ],
        [{ type: "video", index: 1, locked: true }],
        new Set(["selected"]),
        null,
        1,
      ),
    ).toEqual([]);
  });

  it("does not slide past a locked immediate neighbor clip", () => {
    expect(
      getTimelineSlideTargetCommits(
        [
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 3 },
          { id: "locked-next", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5, locked: true },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 5, endTime: 8 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        1,
      ),
    ).toEqual([]);
  });
});

describe("getTimelineRollTargetCommits", () => {
  it("clamps an end-edge roll against a gapped next neighbor's own edges", () => {
    const commits = getTimelineRollTargetCommits(
      [
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
        { id: "after", trackType: "text", trackIndex: 1, startTime: 7, endTime: 9 },
      ],
      [{ type: "text", index: 1, locked: false }],
      new Set(["selected"]),
      null,
      "end",
      10,
    );
    const after = commits.find((commit) => commit.clipId === "after");
    expect(after).toBeDefined();
    expect(after!.endTime).toBe(9);
    expect(after!.endTime - after!.startTime).toBeGreaterThanOrEqual(0.1 - 0.001);
  });

  it("clamps a start-edge roll against a gapped previous neighbor's own edges", () => {
    const commits = getTimelineRollTargetCommits(
      [
        { id: "before", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2 },
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 9 },
      ],
      [{ type: "text", index: 1, locked: false }],
      new Set(["selected"]),
      null,
      "start",
      -10,
    );
    const before = commits.find((commit) => commit.clipId === "before");
    expect(before).toBeDefined();
    expect(before!.startTime).toBe(0);
    expect(before!.endTime - before!.startTime).toBeGreaterThanOrEqual(0.1 - 0.001);
  });

  it("rolls the selected end edge into the next clip while preserving total duration", () => {
    expect(
      getTimelineRollTargetCommits(
        [
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5 },
          { id: "next", trackType: "text", trackIndex: 1, startTime: 5, endTime: 9, trimStart: 10, trimEnd: 14 },
          { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 9 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["selected"]),
        null,
        "end",
        1,
      ),
    ).toEqual([
      { clipId: "selected", startTime: 0, endTime: 6, trimStart: 0, trimEnd: 6 },
      { clipId: "next", startTime: 6, endTime: 9, trimStart: 11, trimEnd: 14 },
    ]);
  });

  it("rolls the selected start edge into the previous clip while preserving total duration", () => {
    expect(
      getTimelineRollTargetCommits(
        [
          { id: "previous", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5 },
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 9, trimStart: 10, trimEnd: 14 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        "start",
        -1,
      ),
    ).toEqual([
      { clipId: "previous", startTime: 0, endTime: 4, trimStart: 0, trimEnd: 4 },
      { clipId: "selected", startTime: 4, endTime: 9, trimStart: 9, trimEnd: 14 },
    ]);
  });

  it("skips roll edits on locked tracks", () => {
    expect(
      getTimelineRollTargetCommits(
        [
          { id: "selected", trackType: "video", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "next", trackType: "video", trackIndex: 1, startTime: 5, endTime: 9 },
        ],
        [{ type: "video", index: 1, locked: true }],
        new Set(["selected"]),
        null,
        "end",
        1,
      ),
    ).toEqual([]);
  });

  it("does not roll past a locked immediate neighbor clip", () => {
    expect(
      getTimelineRollTargetCommits(
        [
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 5 },
          { id: "locked-next", trackType: "text", trackIndex: 1, startTime: 5, endTime: 9, locked: true },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 9, endTime: 12 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        "end",
        1,
      ),
    ).toEqual([]);
  });
});

describe("getTimelineRollShortcut", () => {
  it("maps ctrl/meta shift arrows to one-frame roll edits", () => {
    expect(getTimelineRollShortcut({
      key: "ArrowLeft",
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
    })).toEqual({ edge: "start", deltaSeconds: -1 / 30 });
    expect(getTimelineRollShortcut({
      key: "ArrowRight",
      shiftKey: true,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
    })).toEqual({ edge: "end", deltaSeconds: 1 / 30 });
  });

  it("ignores roll shortcut candidates without the exact modifiers", () => {
    expect(getTimelineRollShortcut({ key: "ArrowLeft", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
    expect(getTimelineRollShortcut({ key: "ArrowRight", shiftKey: true, ctrlKey: true, metaKey: false, altKey: true })).toBeNull();
  });
});

describe("getTimelineSwapAdjacentTargetCommits", () => {
  it("swaps a selected clip with the next clip on the same editable track", () => {
    expect(
      getTimelineSwapAdjacentTargetCommits(
        [
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 },
          { id: "next", trackType: "text", trackIndex: 1, startTime: 6, endTime: 8, trimStart: 20, trimEnd: 22 },
          { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 8 },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
        ],
        new Set(["selected"]),
        null,
        1,
      ),
    ).toEqual([
      { clipId: "next", startTime: 2, endTime: 4, trimStart: 20, trimEnd: 22 },
      { clipId: "selected", startTime: 5, endTime: 8, trimStart: 10, trimEnd: 13 },
    ]);
  });

  it("swaps a selected clip with the previous clip on the same editable track", () => {
    expect(
      getTimelineSwapAdjacentTargetCommits(
        [
          { id: "previous", trackType: "text", trackIndex: 1, startTime: 0, endTime: 3 },
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        -1,
      ),
    ).toEqual([
      { clipId: "selected", startTime: 0, endTime: 2 },
      { clipId: "previous", startTime: 4, endTime: 7 },
    ]);
  });

  it("skips adjacent swap on locked tracks", () => {
    expect(
      getTimelineSwapAdjacentTargetCommits(
        [
          { id: "selected", trackType: "video", trackIndex: 1, startTime: 0, endTime: 3 },
          { id: "next", trackType: "video", trackIndex: 1, startTime: 4, endTime: 6 },
        ],
        [{ type: "video", index: 1, locked: true }],
        new Set(["selected"]),
        null,
        1,
      ),
    ).toEqual([]);
  });

  it("does not swap past a locked immediate neighbor clip", () => {
    expect(
      getTimelineSwapAdjacentTargetCommits(
        [
          { id: "selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 3 },
          { id: "locked-next", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, locked: true },
          { id: "later", trackType: "text", trackIndex: 1, startTime: 7, endTime: 9 },
        ],
        [{ type: "text", index: 1, locked: false }],
        new Set(["selected"]),
        null,
        1,
      ),
    ).toEqual([]);
  });
});

describe("getTimelineTrackMoveTargetCommits", () => {
  it("moves selected editable clips to the next unlocked same-type track", () => {
    expect(getTimelineTrackMoveTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 8 },
        { id: "locked-source", trackType: "video", trackIndex: 1, startTime: 0, endTime: 3 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: true },
        { type: "text", index: 3, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "audio", index: 2, locked: true },
        { type: "audio", index: 3, locked: false },
        { type: "video", index: 1, locked: true },
        { type: "video", index: 2, locked: false },
      ],
      new Set(["text-1", "audio-1", "locked-source"]),
      null,
      1,
    )).toEqual([
      { clipId: "text-1", startTime: 2, endTime: 4, trackType: "text", trackIndex: 3 },
      { clipId: "audio-1", startTime: 5, endTime: 8, trackType: "audio", trackIndex: 3 },
    ]);
  });

  it("skips hidden destination tracks when moving clips between tracks", () => {
    expect(getTimelineTrackMoveTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
      ],
      [
        { type: "text", index: 1, locked: false, visible: true },
        { type: "text", index: 2, locked: false, visible: false },
        { type: "text", index: 3, locked: false, visible: true },
      ],
      new Set(["text-1"]),
      null,
      1,
    )).toEqual([
      { clipId: "text-1", startTime: 2, endTime: 4, trackType: "text", trackIndex: 3 },
    ]);
  });

  it("does not move clips onto protected material on the destination track", () => {
    expect(getTimelineTrackMoveTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "locked-target", trackType: "text", trackIndex: 2, startTime: 3, endTime: 5, locked: true },
      ],
      [
        { type: "text", index: 1, locked: false, visible: true },
        { type: "text", index: 2, locked: false, visible: true },
      ],
      new Set(["text-1"]),
      null,
      1,
    )).toEqual([]);
  });
});

describe("getTimelineTrackMoveExtremeTargetCommits", () => {
  it("moves selected editable clips to the highest unlocked same-type track", () => {
    expect(getTimelineTrackMoveExtremeTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "audio-1", trackType: "audio", trackIndex: 2, startTime: 5, endTime: 8 },
        { id: "locked-source", trackType: "video", trackIndex: 1, startTime: 0, endTime: 3 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: true },
        { type: "text", index: 4, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "audio", index: 2, locked: false },
        { type: "audio", index: 3, locked: false },
        { type: "video", index: 1, locked: true },
        { type: "video", index: 2, locked: false },
      ],
      new Set(["text-1", "audio-1", "locked-source"]),
      null,
      1,
    )).toEqual([
      { clipId: "text-1", startTime: 2, endTime: 4, trackType: "text", trackIndex: 4 },
      { clipId: "audio-1", startTime: 5, endTime: 8, trackType: "audio", trackIndex: 3 },
    ]);
  });

  it("falls back to the active clip and moves it to the lowest unlocked same-type track", () => {
    expect(getTimelineTrackMoveExtremeTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 4, startTime: 2, endTime: 4 },
        { id: "audio-1", trackType: "audio", trackIndex: 2, startTime: 5, endTime: 8 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: true },
        { type: "text", index: 4, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "audio", index: 2, locked: false },
      ],
      new Set(),
      "text-1",
      -1,
    )).toEqual([
      { clipId: "text-1", startTime: 2, endTime: 4, trackType: "text", trackIndex: 1 },
    ]);
  });

  it("skips hidden destination tracks when moving clips to track extremes", () => {
    expect(getTimelineTrackMoveExtremeTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
      ],
      [
        { type: "text", index: 1, locked: false, visible: true },
        { type: "text", index: 3, locked: false, visible: true },
        { type: "text", index: 5, locked: false, visible: false },
      ],
      new Set(["text-1"]),
      null,
      1,
    )).toEqual([
      { clipId: "text-1", startTime: 2, endTime: 4, trackType: "text", trackIndex: 3 },
    ]);
  });

  it("does not move clips to a track extreme over protected material", () => {
    expect(getTimelineTrackMoveExtremeTargetCommits(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "locked-target", trackType: "text", trackIndex: 4, startTime: 3, endTime: 5, locked: true },
      ],
      [
        { type: "text", index: 1, locked: false, visible: true },
        { type: "text", index: 4, locked: false, visible: true },
      ],
      new Set(["text-1"]),
      null,
      1,
    )).toEqual([]);
  });
});

describe("getEditableTimelineClipIds", () => {
  it("filters selected clips on locked or hidden tracks while allowing clips without track metadata", () => {
    const result = getEditableTimelineClipIds(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 4 },
        { id: "audio-2", trackType: "audio", trackIndex: 2, startTime: 0, endTime: 4 },
        { id: "hidden-sticker", trackType: "sticker", trackIndex: 1, startTime: 1, endTime: 3 },
        { id: "loose", startTime: 7, endTime: 8 },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "text", index: 1, locked: false },
        { type: "sticker", index: 1, locked: false, visible: false },
      ],
      new Set(["video-1", "text-1", "audio-2", "hidden-sticker", "loose"]),
    );

    expect([...result]).toEqual(["text-1", "audio-2", "loose"]);
  });
});

describe("getEditableTimelineSelectionClipIds", () => {
  it("uses multi-selection before single selection and filters locked tracks", () => {
    const clips = [
      { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 4 },
      { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 4 },
      { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4 },
    ];
    const tracks = [
      { type: "video", index: 1, locked: true },
      { type: "text", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
    ];

    expect([...getEditableTimelineSelectionClipIds(clips, tracks, new Set(["video-1", "text-1"]), "audio-1")])
      .toEqual(["text-1"]);
    expect([...getEditableTimelineSelectionClipIds(clips, tracks, new Set(), "audio-1")])
      .toEqual(["audio-1"]);
  });
});

describe("getTimelineCopyTargetClipIds", () => {
  it("unions multi-selection with the active single selection before downstream editability filtering", () => {
    const selected = getTimelineCopyTargetClipIds(new Set(["locked-clip", "free-clip"]), "active-clip");
    expect([...selected]).toEqual(["locked-clip", "free-clip", "active-clip"]);
    expect([...getTimelineCopyTargetClipIds(new Set(), "fallback-clip")]).toEqual(["fallback-clip"]);
    expect([...getTimelineCopyTargetClipIds(new Set(), null)]).toEqual([]);
  });

  it("filters copy targets on locked or hidden tracks when timeline state is available", () => {
    const selected = getTimelineCopyTargetClipIds(
      new Set(["locked-track", "hidden-track", "visible"]),
      "locked-clip",
      [
        { id: "locked-track", trackType: "video", trackIndex: 1, startTime: 0, endTime: 3 },
        { id: "hidden-track", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 3 },
        { id: "visible", trackType: "text", trackIndex: 1, startTime: 0, endTime: 3 },
        { id: "locked-clip", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, locked: true },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "audio", index: 1, visible: false },
        { type: "text", index: 1, locked: false, visible: true },
      ],
    );

    expect([...selected]).toEqual(["visible"]);
  });
});

describe("getTimelineSelectionAfterDelete", () => {
  it("removes only deleted clip ids from the selection", () => {
    const result = getTimelineSelectionAfterDelete(
      new Set(["locked-clip", "deleted-clip", "other-deleted-clip"]),
      new Set(["deleted-clip", "other-deleted-clip"]),
    );

    expect([...result]).toEqual(["locked-clip"]);
  });

  it("selects the next clip to the right when the deleted clips were the whole selection", () => {
    const result = getTimelineSelectionAfterDelete(
      new Set(["deleted"]),
      new Set(["deleted"]),
      [
        { id: "previous", startTime: 0, endTime: 2 },
        { id: "deleted", startTime: 3, endTime: 5 },
        { id: "next", startTime: 6, endTime: 8 },
      ],
    );

    expect([...result]).toEqual(["next"]);
  });

  it("selects the closest previous clip when deleting the last selected clip", () => {
    const result = getTimelineSelectionAfterDelete(
      new Set(["deleted"]),
      new Set(["deleted"]),
      [
        { id: "previous", startTime: 0, endTime: 2 },
        { id: "deleted", startTime: 3, endTime: 5 },
      ],
    );

    expect([...result]).toEqual(["previous"]);
  });

  it("skips locked and hidden clips when choosing the fallback selection after delete", () => {
    const clips = [
      { id: "deleted", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
      { id: "locked-next", trackType: "text", trackIndex: 2, startTime: 6, endTime: 7 },
      { id: "hidden-next", trackType: "text", trackIndex: 3, startTime: 8, endTime: 9 },
      { id: "editable-next", trackType: "text", trackIndex: 1, startTime: 10, endTime: 11 },
    ];

    const result = getTimelineSelectionAfterDelete(
      new Set(["deleted"]),
      new Set(["deleted"]),
      clips,
      [
        { type: "text", index: 1, locked: false, visible: true },
        { type: "text", index: 2, locked: true, visible: true },
        { type: "text", index: 3, locked: false, visible: false },
      ],
    );

    expect([...result]).toEqual(["editable-next"]);
  });
});

describe("getTimelineDeleteBatchPlan", () => {
  it("keeps locked track clips, locked clips, and synthetic clips out of batch deletes", () => {
    const result = getTimelineDeleteBatchPlan(
      [
        { id: "locked-video", trackType: "video", trackIndex: 1, startTime: 0, endTime: 3 },
        { id: "clip-locked-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 3, locked: true },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 3 },
        { id: "scene-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 3 },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "video", index: 2, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["locked-video", "clip-locked-video", "text-1", "scene-audio"]),
      (id) => id === "scene-audio",
    );

    expect(result).toEqual({
      deleteIds: ["text-1"],
      blockedSyntheticCount: 1,
    });
  });

  it("deletes detached audio linked to a deleted video clip even when the audio lane is locked", () => {
    const result = getTimelineDeleteBatchPlan(
      [
        {
          id: "video-1",
          trackType: "video",
          trackIndex: 1,
          startTime: 2,
          endTime: 6,
          mediaUrl: "https://cdn.example.com/media/shot.mp4?token=video",
          volume: 0,
          trimStart: 10,
          trimEnd: 14,
        },
        {
          id: "detached-audio",
          trackType: "audio",
          trackIndex: 2,
          startTime: 2,
          endTime: 6,
          mediaUrl: "https://cdn.example.com/media/shot.mp4?token=audio",
          mediaType: "audio",
          trimStart: 10,
          trimEnd: 14,
          locked: true,
        },
        {
          id: "music",
          trackType: "audio",
          trackIndex: 2,
          startTime: 2,
          endTime: 6,
          mediaUrl: "https://cdn.example.com/media/music.mp3",
        },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 2, locked: true },
      ],
      new Set(["video-1"]),
      () => false,
    );

    expect(result).toEqual({
      deleteIds: ["video-1", "detached-audio"],
      blockedSyntheticCount: 0,
    });
  });
});
