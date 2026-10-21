// Unit tests for duplicate, clipboard, keyframe, detach audio, ripple delete, and split timeline editing tests.
import { describe, expect, it } from "vitest";
import {
  copyTimelineClips,
  cutTimelineClips,
  canPasteTimelineClipboard,
  getTimelinePasteTargetTime,
  getAdjacentTimelineEditPoint,
  getTimelineDetachAudioPlan,
  getSeparateVoiceoverAudioInput,
  getTimelineInsertDuplicatePlan,
  getTimelineNavigationEndTime,
  duplicateTimelineClips,
  getTimelineSplitClipIdsAtPlayhead,
  getTimelineSplitMarkerRangeBoundaryTargets,
  getTimelineSplitTargetAtNearestMarker,
  getTimelineSplitAllTrackTargetAtNearestMarker,
  getTimelineSplitAllTrackClipIdsAtPlayhead,
  getTimelineSplitTargetClipIdsAtPlayhead,
  getTimelineTrackSplitTargetClipIdsAtPlayhead,
  getTimelineAddKeyframeTargetCommits,
  getTimelineClearKeyframesTargetCommits,
  getAdjacentTimelineClipKeyframeTime,
  getTimelineDeleteNearestKeyframeTargetCommits,
  pasteTimelineClips,
  rippleDeleteTimelineClipsGlobally,
  rippleDeleteTimelineClips,
  shouldCanvasHandleTimelineDelete,
} from "./timeline-editing";

describe("duplicateTimelineClips", () => {
  it("places duplicated clips after the selected group while preserving offsets and clip data", () => {
    const result = duplicateTimelineClips(
      [
        {
          id: "clip-1",
          projectId: "project-1",
          trackType: "text",
          trackIndex: 1,
          startTime: 3,
          endTime: 5,
          textContent: "Hello",
          label: "Caption",
        },
        {
          id: "clip-2",
          projectId: "project-1",
          trackType: "audio",
          trackIndex: 2,
          startTime: 6,
          endTime: 9,
          mediaUrl: "https://example.com/audio.mp3",
          volume: 0.7,
        },
        {
          id: "clip-3",
          projectId: "project-1",
          trackType: "sticker",
          trackIndex: 1,
          startTime: 11,
          endTime: 12,
        },
      ],
      new Set(["clip-1", "clip-2"]),
    );

    expect(result).toEqual([
      {
        trackType: "text",
        trackIndex: 1,
        startTime: 9,
        endTime: 11,
        textContent: "Hello",
        label: "Caption",
      },
      {
        trackType: "audio",
        trackIndex: 2,
        startTime: 12,
        endTime: 15,
        mediaUrl: "https://example.com/audio.mp3",
        volume: 0.7,
      },
    ]);
  });

  it("strips server-only fields from duplicate create inputs", () => {
    const [input] = duplicateTimelineClips(
      [
        {
          id: "clip-1",
          projectId: "project-1",
          trackType: "video",
          trackIndex: 1,
          startTime: 3,
          endTime: 6,
          mediaUrl: "https://example.com/clip.mp4",
          mediaType: "ai_generate",
          aiPrompt: "wide shot",
          aiReferenceUrls: "[\"https://example.com/ref.png\"]",
          aiModelId: "model-1",
          aiGenerationStatus: "ready",
          aiGenerationError: null,
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
        },
      ],
      new Set(["clip-1"]),
    );

    expect(input).toEqual({
      trackType: "video",
      trackIndex: 1,
      startTime: 6,
      endTime: 9,
      mediaUrl: "https://example.com/clip.mp4",
      mediaType: "ai_generate",
      aiPrompt: "wide shot",
      aiReferenceUrls: "[\"https://example.com/ref.png\"]",
      aiModelId: "model-1",
    });
  });

  it("duplicates only editable clips when locked clips are selected", () => {
    expect(duplicateTimelineClips(
      [
        { id: "editable", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Title" },
        { id: "locked-clip", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
        { id: "locked-track", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      new Set(["editable", "locked-clip", "locked-track"]),
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: true },
      ],
    )).toEqual([
      {
        trackType: "text",
        trackIndex: 1,
        startTime: 4,
        endTime: 6,
        textContent: "Title",
      },
    ]);
  });

  it("preserves edit properties added by advanced timeline tools", () => {
    const [input] = duplicateTimelineClips(
      [
        {
          id: "clip-1",
          projectId: "project-1",
          trackType: "video",
          trackIndex: 1,
          startTime: 3,
          endTime: 6,
          mediaUrl: "https://example.com/clip.mp4",
          playbackSpeed: 0.5,
          reversePlayback: true,
          fadeInDuration: 0.5,
          fadeOutDuration: 1,
          opacity: 0.6,
          scale: 1.25,
          positionX: 0.25,
          positionY: 0.75,
          horizontalFlip: true,
          rotationDegrees: 270,
          keyframesJson: '{"keyframes":[{"time":0,"scale":1}]}',
        },
      ],
      new Set(["clip-1"]),
    );

    expect(input).toMatchObject({
      playbackSpeed: 0.5,
      reversePlayback: true,
      fadeInDuration: 0.5,
      fadeOutDuration: 1,
      opacity: 0.6,
      scale: 1.25,
      positionX: 0.25,
      positionY: 0.75,
      horizontalFlip: true,
      rotationDegrees: 270,
      keyframesJson: '{"keyframes":[{"time":0,"scale":1}]}',
    });
  });
});

describe("getTimelineAddKeyframeTargetCommits", () => {
  it("adds a sorted clip-local keyframe with the current animatable values", () => {
    expect(getTimelineAddKeyframeTargetCommits(
      [
        {
          id: "visual",
          trackType: "video",
          trackIndex: 1,
          startTime: 10,
          endTime: 20,
          scale: 1.25,
          opacity: 0.6,
          positionX: 0.2,
          positionY: 0.8,
          rotationDegrees: 90,
          volume: 0.7,
          keyframesJson: '{"keyframes":[{"time":4,"scale":1},{"time":1,"opacity":1}]}',
        },
      ],
      [{ type: "video", index: 1, locked: false }],
      new Set(["visual"]),
      null,
      12.5,
    )).toEqual([
      {
        clipId: "visual",
        startTime: 10,
        endTime: 20,
        keyframesJson: '{"keyframes":[{"time":1,"opacity":1},{"time":2.5,"scale":1.25,"opacity":0.6,"position_x":0.2,"position_y":0.8,"rotation_degrees":90,"volume":0.7},{"time":4,"scale":1}]}',
      },
    ]);
  });

  it("replaces an existing keyframe at the same playhead time and skips locked tracks", () => {
    expect(getTimelineAddKeyframeTargetCommits(
      [
        {
          id: "audio",
          trackType: "audio",
          trackIndex: 1,
          startTime: 5,
          endTime: 9,
          volume: 0.25,
          keyframesJson: '[{"time":1,"volume":1},{"time":2,"volume":0.5}]',
        },
        {
          id: "locked",
          trackType: "audio",
          trackIndex: 2,
          startTime: 5,
          endTime: 9,
          volume: 0.25,
        },
      ],
      [
        { type: "audio", index: 1, locked: false },
        { type: "audio", index: 2, locked: true },
      ],
      new Set(["audio", "locked"]),
      null,
      7,
    )).toEqual([
      {
        clipId: "audio",
        startTime: 5,
        endTime: 9,
        keyframesJson: '{"keyframes":[{"time":1,"volume":1},{"time":2,"volume":0.25}]}',
      },
    ]);
  });
});

describe("getTimelineClearKeyframesTargetCommits", () => {
  it("clears keyframes for editable selected clips only", () => {
    expect(getTimelineClearKeyframesTargetCommits(
      [
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, keyframesJson: '{"keyframes":[{"time":0,"opacity":1}]}' },
        { id: "empty", trackType: "text", trackIndex: 1, startTime: 4, endTime: 8, keyframesJson: null },
        { id: "locked", trackType: "text", trackIndex: 2, startTime: 0, endTime: 4, keyframesJson: '{"keyframes":[{"time":0,"opacity":1}]}' },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: true },
      ],
      new Set(["selected", "empty", "locked"]),
      null,
    )).toEqual([
      { clipId: "selected", startTime: 0, endTime: 4, keyframesJson: null },
    ]);
  });
});

describe("getAdjacentTimelineClipKeyframeTime", () => {
  it("finds previous and next selected clip keyframes as absolute timeline times", () => {
    const clips = [
      { id: "video", trackType: "video", trackIndex: 1, startTime: 10, endTime: 20, keyframesJson: '{"keyframes":[{"time":1,"scale":1},{"time":4,"opacity":0.5}]}' },
      { id: "audio", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 14, keyframesJson: '[{"time":3,"volume":0.4}]' },
      { id: "locked", trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, keyframesJson: '{"keyframes":[{"time":1,"scale":1}]}' },
    ];
    const tracks = [
      { type: "video", index: 1, locked: false },
      { type: "audio", index: 1, locked: false },
      { type: "video", index: 2, locked: true },
    ];

    expect(getAdjacentTimelineClipKeyframeTime(clips, tracks, new Set(["video", "audio", "locked"]), null, 12, -1)).toBe(11);
    expect(getAdjacentTimelineClipKeyframeTime(clips, tracks, new Set(["video", "audio", "locked"]), null, 12, 1)).toBe(14);
    expect(getAdjacentTimelineClipKeyframeTime(clips, tracks, new Set(["video"]), null, 14, 1)).toBeNull();
  });
});

describe("getTimelineDeleteNearestKeyframeTargetCommits", () => {
  it("deletes the nearest selected keyframe within threshold and preserves the rest", () => {
    expect(getTimelineDeleteNearestKeyframeTargetCommits(
      [
        { id: "video", trackType: "video", trackIndex: 1, startTime: 10, endTime: 20, keyframesJson: '{"keyframes":[{"time":1,"scale":1},{"time":2.03,"opacity":0.5},{"time":4,"scale":2}]}' },
        { id: "locked", trackType: "video", trackIndex: 2, startTime: 10, endTime: 20, keyframesJson: '{"keyframes":[{"time":2,"scale":1}]}' },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "video", index: 2, locked: true },
      ],
      new Set(["video", "locked"]),
      null,
      12,
      0.05,
    )).toEqual([
      {
        clipId: "video",
        startTime: 10,
        endTime: 20,
        keyframesJson: '{"keyframes":[{"time":1,"scale":1},{"time":4,"scale":2}]}',
      },
    ]);
  });

  it("clears keyframesJson when deleting the last keyframe and ignores distant keyframes", () => {
    expect(getTimelineDeleteNearestKeyframeTargetCommits(
      [{ id: "solo", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 9, keyframesJson: '[{"time":1,"volume":0.5}]' }],
      [{ type: "audio", index: 1, locked: false }],
      new Set(["solo"]),
      null,
      6.02,
      0.05,
    )).toEqual([
      { clipId: "solo", startTime: 5, endTime: 9, keyframesJson: null },
    ]);

    expect(getTimelineDeleteNearestKeyframeTargetCommits(
      [{ id: "solo", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 9, keyframesJson: '[{"time":1,"volume":0.5}]' }],
      [{ type: "audio", index: 1, locked: false }],
      new Set(["solo"]),
      null,
      6.25,
      0.05,
    )).toEqual([]);
  });
});

describe("copyTimelineClips and pasteTimelineClips", () => {
  it("enables paste only when the clipboard has clips", () => {
    expect(canPasteTimelineClipboard(null)).toBe(false);
    expect(canPasteTimelineClipboard({ groupDuration: 0, clips: [] })).toBe(false);
    expect(canPasteTimelineClipboard({
      groupDuration: 2,
      clips: [
        {
          offsetStart: 0,
          duration: 2,
          input: { startTime: 0, endTime: 2 },
        },
      ],
    })).toBe(true);
  });

  it("enables paste only when the clipboard has a clip for an editable visible track", () => {
    const clipboard = {
      groupDuration: 2,
      clips: [
        {
          offsetStart: 0,
          duration: 2,
          input: { trackType: "video", trackIndex: 1, startTime: 0, endTime: 2 },
        },
        {
          offsetStart: 0,
          duration: 2,
          input: { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2 },
        },
      ],
    };

    expect(canPasteTimelineClipboard(clipboard, [
      { type: "video", index: 1, locked: true },
      { type: "audio", index: 1, visible: false },
    ])).toBe(false);
    expect(canPasteTimelineClipboard(clipboard, [
      { type: "video", index: 1, locked: true },
      { type: "audio", index: 1, visible: true },
    ])).toBe(true);
  });

  it("pastes after the selected group when clips are selected", () => {
    expect(getTimelinePasteTargetTime(
      [
        { id: "clip-1", startTime: 1, endTime: 3 },
        { id: "clip-2", startTime: 4, endTime: 7.25 },
        { id: "clip-3", startTime: 9, endTime: 10 },
      ],
      new Set(["clip-1", "clip-2"]),
      20,
    )).toBe(7.25);

    expect(getTimelinePasteTargetTime(
      [{ id: "clip-1", startTime: 1, endTime: 3 }],
      new Set(),
      20,
    )).toBe(20);
  });

  it("ignores selected clips on hidden tracks when choosing the paste target time", () => {
    const clips = [
      { id: "visible", trackType: "text", trackIndex: 1, startTime: 1, endTime: 4 },
      { id: "hidden", trackType: "text", trackIndex: 2, startTime: 20, endTime: 25 },
    ];

    expect(getTimelinePasteTargetTime(
      clips,
      new Set(["visible", "hidden"]),
      12,
      [
        { type: "text", index: 1, locked: false, visible: true },
        { type: "text", index: 2, locked: false, visible: false },
      ],
    )).toBe(4);
  });

  it("copies selected clips as a relative group and pastes them at the playhead", () => {
    const clipboard = copyTimelineClips(
      [
        {
          id: "clip-1",
          projectId: "project-1",
          trackType: "text",
          trackIndex: 1,
          startTime: 3,
          endTime: 5,
          textContent: "Lower third",
        },
        {
          id: "clip-2",
          projectId: "project-1",
          trackType: "audio",
          trackIndex: 1,
          startTime: 4.5,
          endTime: 8,
          mediaUrl: "https://example.com/sfx.wav",
          volume: 0.4,
        },
        {
          id: "clip-3",
          projectId: "project-1",
          trackType: "sticker",
          trackIndex: 1,
          startTime: 12,
          endTime: 13,
        },
      ],
      new Set(["clip-1", "clip-2"]),
    );

    expect(clipboard).toEqual({
      groupDuration: 5,
      clips: [
        {
          offsetStart: 0,
          duration: 2,
          input: {
            trackType: "text",
            trackIndex: 1,
            startTime: 3,
            endTime: 5,
            textContent: "Lower third",
          },
        },
        {
          offsetStart: 1.5,
          duration: 3.5,
          input: {
            trackType: "audio",
            trackIndex: 1,
            startTime: 4.5,
            endTime: 8,
            mediaUrl: "https://example.com/sfx.wav",
            volume: 0.4,
          },
        },
      ],
    });

    expect(pasteTimelineClips(clipboard, 20)).toEqual([
      {
        trackType: "text",
        trackIndex: 1,
        startTime: 20,
        endTime: 22,
        textContent: "Lower third",
      },
      {
        trackType: "audio",
        trackIndex: 1,
        startTime: 21.5,
        endTime: 25,
        mediaUrl: "https://example.com/sfx.wav",
        volume: 0.4,
      },
    ]);
  });

  it("copies only editable clips when locked clips are selected", () => {
    const clipboard = copyTimelineClips(
      [
        { id: "editable", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Title" },
        { id: "locked-clip", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
        { id: "locked-track", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      new Set(["editable", "locked-clip", "locked-track"]),
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: true },
      ],
    );

    expect(clipboard).toEqual({
      groupDuration: 2,
      clips: [
        {
          offsetStart: 0,
          duration: 2,
          input: { trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Title" },
        },
      ],
    });
  });
});

describe("getTimelineInsertDuplicatePlan", () => {
  it("does not direct-duplicate selected clips over protected clips", () => {
    expect(duplicateTimelineClips(
      [
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Caption" },
        { id: "locked-target", trackType: "text", trackIndex: 1, startTime: 4, endTime: 6, locked: true },
      ],
      new Set(["selected"]),
      [{ type: "text", index: 1, locked: false }],
    )).toEqual([]);
  });

  it("direct-duplicates usable selected tracks when another selected track would hit protected material", () => {
    expect(duplicateTimelineClips(
      [
        { id: "selected-text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Caption" },
        { id: "selected-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 2, mediaUrl: "https://example.com/audio.wav" },
        { id: "locked-audio-target", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 4, locked: true },
      ],
      new Set(["selected-text", "selected-audio"]),
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
    )).toEqual([
      { trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Caption" },
    ]);
  });

  it("duplicates selected clips after the group and shifts later editable clips on matching tracks", () => {
    expect(getTimelineInsertDuplicatePlan({
      clips: [
        { id: "selected-text", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Caption" },
        { id: "selected-audio", trackType: "audio", trackIndex: 2, startTime: 3, endTime: 6, mediaUrl: "https://example.com/audio.mp3" },
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 7, endTime: 8 },
        { id: "later-audio", trackType: "audio", trackIndex: 2, startTime: 8, endTime: 10 },
        { id: "other-track", trackType: "video", trackIndex: 1, startTime: 7, endTime: 10 },
      ],
      tracks: [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 2, locked: false },
        { type: "video", index: 1, locked: false },
      ],
      selectedClipIds: new Set(["selected-text", "selected-audio"]),
      selectedClipId: null,
    })).toEqual({
      inputs: [
        { trackType: "text", trackIndex: 1, startTime: 6, endTime: 8, textContent: "Caption" },
        { trackType: "audio", trackIndex: 2, startTime: 7, endTime: 10, mediaUrl: "https://example.com/audio.mp3" },
      ],
      commits: [
        { clipId: "later-text", startTime: 11, endTime: 12 },
        { clipId: "later-audio", startTime: 12, endTime: 14 },
      ],
    });
  });

  it("does not duplicate onto locked tracks", () => {
    expect(getTimelineInsertDuplicatePlan({
      clips: [
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Locked" },
        { id: "later", trackType: "text", trackIndex: 1, startTime: 5, endTime: 6 },
      ],
      tracks: [{ type: "text", index: 1, locked: true }],
      selectedClipIds: new Set(["selected"]),
      selectedClipId: null,
    })).toEqual({ inputs: [], commits: [] });
  });

  it("does not insert duplicate clips over locked clips on editable tracks", () => {
    expect(getTimelineInsertDuplicatePlan({
      clips: [
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Caption" },
        { id: "locked-target", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
      ],
      tracks: [{ type: "text", index: 1, locked: false }],
      selectedClipIds: new Set(["selected"]),
      selectedClipId: null,
    })).toEqual({ inputs: [], commits: [] });
  });

  it("does not insert duplicate clips when shifting later clips would cross locked clips", () => {
    expect(getTimelineInsertDuplicatePlan({
      clips: [
        { id: "selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, textContent: "Caption" },
        { id: "later", trackType: "text", trackIndex: 1, startTime: 3, endTime: 4 },
        { id: "locked-boundary", trackType: "text", trackIndex: 1, startTime: 4.5, endTime: 5.5, locked: true },
      ],
      tracks: [{ type: "text", index: 1, locked: false }],
      selectedClipIds: new Set(["selected"]),
      selectedClipId: null,
    })).toEqual({ inputs: [], commits: [] });
  });
});

describe("getTimelineDetachAudioPlan", () => {
  it("creates audio clips from selected video clips and mutes the source videos", () => {
    expect(
      getTimelineDetachAudioPlan(
        [
          {
            id: "video-1",
            trackType: "video",
            trackIndex: 1,
            startTime: 2,
            endTime: 6,
            mediaUrl: "https://example.com/clip-a.mp4",
            label: "Shot A", // i18n-ignore
            volume: 0.8,
            trimStart: 10,
            trimEnd: 14,
          },
          {
            id: "video-2",
            trackType: "video",
            trackIndex: 1,
            startTime: 8,
            endTime: 11,
            mediaUrl: "https://example.com/clip-b.mp4",
            label: "Shot B", // i18n-ignore
          },
          {
            id: "locked-video",
            trackType: "video",
            trackIndex: 2,
            startTime: 12,
            endTime: 14,
            mediaUrl: "https://example.com/locked.mp4",
          },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "video", index: 2, locked: true },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: false },
        ],
        new Set(["video-1", "video-2", "locked-video"]),
        null,
      ),
    ).toEqual({
      creates: [
        {
          trackType: "audio",
          trackIndex: 2,
          startTime: 2,
          endTime: 6,
          mediaUrl: "https://example.com/clip-a.mp4",
          mediaType: "audio",
          label: "Shot A audio", // i18n-ignore
          volume: 0.8,
          trimStart: 10,
          trimEnd: 14,
        },
        {
          trackType: "audio",
          trackIndex: 2,
          startTime: 8,
          endTime: 11,
          mediaUrl: "https://example.com/clip-b.mp4",
          mediaType: "audio",
          label: "Shot B audio", // i18n-ignore
          volume: 1,
        },
      ],
      updates: [
        { clipId: "video-1", startTime: 2, endTime: 6, volume: 0 },
        { clipId: "video-2", startTime: 8, endTime: 11, volume: 0 },
      ],
    });
  });

  it("skips hidden audio tracks when choosing the detached audio destination", () => {
    expect(
      getTimelineDetachAudioPlan(
        [
          {
            id: "video-1",
            trackType: "video",
            trackIndex: 1,
            startTime: 2,
            endTime: 6,
            mediaUrl: "https://example.com/clip-a.mp4",
            label: "Shot A", // i18n-ignore
          },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: false, visible: false },
          { type: "audio", index: 3, locked: false, visible: true },
        ],
        new Set(["video-1"]),
        null,
      ),
    ).toEqual({
      creates: [
        {
          trackType: "audio",
          trackIndex: 3,
          startTime: 2,
          endTime: 6,
          mediaUrl: "https://example.com/clip-a.mp4",
          mediaType: "audio",
          label: "Shot A audio", // i18n-ignore
          volume: 1,
        },
      ],
      updates: [
        { clipId: "video-1", startTime: 2, endTime: 6, volume: 0 },
      ],
    });
  });

  it("skips audio tracks with protected clips when detaching audio", () => {
    expect(
      getTimelineDetachAudioPlan(
        [
          {
            id: "video-1",
            trackType: "video",
            trackIndex: 1,
            startTime: 2,
            endTime: 6,
            mediaUrl: "https://example.com/clip-a.mp4",
            label: "Shot A", // i18n-ignore
          },
          {
            id: "locked-audio",
            trackType: "audio",
            trackIndex: 2,
            startTime: 3,
            endTime: 5,
            locked: true,
          },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 1, locked: false },
          { type: "audio", index: 2, locked: false },
          { type: "audio", index: 3, locked: false },
        ],
        new Set(["video-1"]),
        null,
      ),
    ).toMatchObject({
      creates: [
        {
          trackType: "audio",
          trackIndex: 3,
          startTime: 2,
          endTime: 6,
        },
      ],
    });
  });

  it("detaches audio for selected videos that fit when another selected video overlaps protected audio", () => {
    expect(
      getTimelineDetachAudioPlan(
        [
          {
            id: "video-clear",
            trackType: "video",
            trackIndex: 1,
            startTime: 0,
            endTime: 2,
            mediaUrl: "https://example.com/clear.mp4",
            label: "Clear", // i18n-ignore
          },
          {
            id: "video-blocked",
            trackType: "video",
            trackIndex: 1,
            startTime: 4,
            endTime: 6,
            mediaUrl: "https://example.com/blocked.mp4",
            label: "Blocked", // i18n-ignore
          },
          {
            id: "locked-audio",
            trackType: "audio",
            trackIndex: 2,
            startTime: 4.5,
            endTime: 5.5,
            locked: true,
          },
        ],
        [
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 2, locked: false },
        ],
        new Set(["video-clear", "video-blocked"]),
        null,
      ),
    ).toEqual({
      creates: [
        {
          trackType: "audio",
          trackIndex: 2,
          startTime: 0,
          endTime: 2,
          mediaUrl: "https://example.com/clear.mp4",
          mediaType: "audio",
          label: "Clear audio", // i18n-ignore
          volume: 1,
        },
      ],
      updates: [
        { clipId: "video-clear", startTime: 0, endTime: 2, volume: 0 },
      ],
    });
  });

  it("returns an empty plan when no selected editable videos have media", () => {
    expect(
      getTimelineDetachAudioPlan(
        [
          { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Caption" },
          { id: "video-empty", trackType: "video", trackIndex: 1, startTime: 3, endTime: 5, mediaUrl: "" },
        ],
        [
          { type: "text", index: 1, locked: false },
          { type: "video", index: 1, locked: false },
          { type: "audio", index: 2, locked: false },
        ],
        new Set(["text-1", "video-empty"]),
        null,
      ),
    ).toEqual({ creates: [], updates: [] });
  });
});

describe("getSeparateVoiceoverAudioInput", () => {
  it("builds a standalone A1 audio clip spanning the voiceover range", () => {
    const input = getSeparateVoiceoverAudioInput({
      audioUrl: "https://cdn/audio/vo.mp3",
      startTime: 2,
      duration: 5,
      label: "Hello there",
      audioTrackIndex: 1,
    });
    expect(input).toMatchObject({
      trackType: "audio",
      trackIndex: 1,
      startTime: 2,
      endTime: 7,
      mediaUrl: "https://cdn/audio/vo.mp3",
      mediaType: "audio",
      label: "Hello there",
      volume: 1,
    });
  });

  it("includes the drag offset and falls back to a generic label", () => {
    const input = getSeparateVoiceoverAudioInput({
      audioUrl: "https://cdn/audio/vo.mp3",
      startTime: 3.5, // scene start (3) + offset (0.5)
      duration: 4,
    });
    expect(input.startTime).toBe(3.5);
    expect(input.endTime).toBe(7.5);
    expect(input.trackIndex).toBe(1);
    expect(input.label).toBe("Voiceover");
  });

  it("clamps a non-positive duration to a minimum so the clip is visible", () => {
    const input = getSeparateVoiceoverAudioInput({
      audioUrl: "https://cdn/audio/vo.mp3",
      startTime: 0,
      duration: 0,
    });
    expect(input.endTime).toBeGreaterThan(input.startTime);
  });
});

describe("cutTimelineClips", () => {
  it("returns a clipboard plus original IDs to delete", () => {
    const result = cutTimelineClips(
      [
        {
          id: "clip-1",
          projectId: "project-1",
          trackType: "video",
          trackIndex: 2,
          startTime: 5,
          endTime: 8,
          mediaUrl: "https://example.com/clip.mp4",
        },
        {
          id: "clip-2",
          projectId: "project-1",
          trackType: "text",
          trackIndex: 1,
          startTime: 9,
          endTime: 10,
          textContent: "Title",
        },
      ],
      new Set(["clip-1", "clip-2"]),
    );

    expect(result).toEqual({
      deleteIds: ["clip-1", "clip-2"],
      clipboard: {
        groupDuration: 5,
        clips: [
          {
            offsetStart: 0,
            duration: 3,
            input: {
              trackType: "video",
              trackIndex: 2,
              startTime: 5,
              endTime: 8,
              mediaUrl: "https://example.com/clip.mp4",
            },
          },
          {
            offsetStart: 4,
            duration: 1,
            input: {
              trackType: "text",
              trackIndex: 1,
              startTime: 9,
              endTime: 10,
              textContent: "Title",
            },
          },
        ],
      },
    });
  });

  it("cuts only editable clips when locked clips are selected", () => {
    const result = cutTimelineClips(
      [
        { id: "editable", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Title" },
        { id: "locked-clip", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7, locked: true },
        { id: "locked-track", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      new Set(["editable", "locked-clip", "locked-track"]),
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: true },
      ],
    );

    expect(result).toEqual({
      deleteIds: ["editable"],
      clipboard: {
        groupDuration: 2,
        clips: [
          {
            offsetStart: 0,
            duration: 2,
            input: { trackType: "text", trackIndex: 1, startTime: 2, endTime: 4, textContent: "Title" },
          },
        ],
      },
    });
  });
});

describe("rippleDeleteTimelineClips", () => {
  it("deletes selected clips and shifts later clips left on the same track", () => {
    const result = rippleDeleteTimelineClips(
      [
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "text-2", trackType: "text", trackIndex: 1, startTime: 5, endTime: 7 },
        { id: "text-3", trackType: "text", trackIndex: 1, startTime: 8, endTime: 10 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      new Set(["text-1", "text-2"]),
    );

    expect(result).toEqual({
      deleteIds: ["text-1", "text-2"],
      commits: [
        { clipId: "text-3", startTime: 4, endTime: 6 },
      ],
    });
  });

  it("trims and splits non-selected same-track clips that overlap the deleted range", () => {
    const result = rippleDeleteTimelineClips(
      [
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 1, endTime: 7, trimStart: 10, trimEnd: 16, mediaUrl: "https://example.com/audio.wav" },
        { id: "delete", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 5 },
        { id: "later", trackType: "audio", trackIndex: 1, startTime: 8, endTime: 9 },
        { id: "other-track", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
      ],
      new Set(["delete"]),
    );

    expect(result).toEqual({
      deleteIds: ["delete"],
      commits: [
        { clipId: "spanning", startTime: 1, endTime: 3, trimStart: 10, trimEnd: 12 },
        { clipId: "later", startTime: 6, endTime: 7 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 3,
          endTime: 5,
          trimStart: 14,
          trimEnd: 16,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });

  it("does not delete, trim, split, or shift locked clips during same-track ripple delete", () => {
    const result = rippleDeleteTimelineClips(
      [
        { id: "delete", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "locked-selected", trackType: "text", trackIndex: 1, startTime: 4, endTime: 5, locked: true },
        { id: "locked-spanning", trackType: "text", trackIndex: 1, startTime: 1, endTime: 7, locked: true, mediaUrl: "https://example.com/text.json" },
        { id: "later", trackType: "text", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      new Set(["delete", "locked-selected"]),
    );

    expect(result).toEqual({
      deleteIds: ["delete"],
      commits: [],
    });
  });

  it("does not ripple later clips into locked same-track clips", () => {
    expect(rippleDeleteTimelineClips(
      [
        { id: "delete", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "locked-boundary", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
        { id: "later-overlap", trackType: "text", trackIndex: 1, startTime: 7, endTime: 9 },
        { id: "later-clear", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
      ],
      new Set(["delete"]),
    )).toEqual({
      deleteIds: ["delete"],
      commits: [
        { clipId: "later-clear", startTime: 7, endTime: 9 },
      ],
    });
  });

  it("returns null when same-track ripple delete targets a hidden track", () => {
    expect(rippleDeleteTimelineClips(
      [
        { id: "delete", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "hidden-later", trackType: "text", trackIndex: 1, startTime: 6, endTime: 8 },
        { id: "visible-later", trackType: "audio", trackIndex: 1, startTime: 6, endTime: 8 },
      ],
      new Set(["delete"]),
      [
        { type: "text", index: 1, locked: false, visible: false },
        { type: "audio", index: 1, locked: false, visible: true },
      ],
    )).toBeNull();
  });
});

describe("rippleDeleteTimelineClipsGlobally", () => {
  it("deletes selected editable clips and ripples later editable clips on every track", () => {
    const result = rippleDeleteTimelineClipsGlobally(
      [
        { id: "delete-text", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "middle-audio", trackType: "audio", trackIndex: 1, startTime: 4.5, endTime: 5 },
        { id: "delete-audio", trackType: "audio", trackIndex: 1, startTime: 5, endTime: 7 },
        { id: "later-text", trackType: "text", trackIndex: 1, startTime: 8, endTime: 10, trimStart: 10, trimEnd: 12 },
        { id: "locked-later", trackType: "video", trackIndex: 1, startTime: 8, endTime: 10 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
        { type: "video", index: 1, locked: true },
      ],
      new Set(["delete-text", "delete-audio", "locked-later"]),
    );

    expect(result).toEqual({
      deleteIds: ["delete-text", "delete-audio"],
      commits: [
        { clipId: "middle-audio", startTime: 2.5, endTime: 3 },
        { clipId: "later-text", startTime: 4, endTime: 6, trimStart: 10, trimEnd: 12 },
      ],
    });
  });

  it("returns null when there are no editable clips to ripple delete globally", () => {
    expect(rippleDeleteTimelineClipsGlobally(
      [{ id: "locked", trackType: "video", trackIndex: 1, startTime: 2, endTime: 4 }],
      [{ type: "video", index: 1, locked: true }],
      new Set(["locked"]),
    )).toBeNull();
  });

  it("does not globally ripple later clips into locked same-track clips", () => {
    expect(rippleDeleteTimelineClipsGlobally(
      [
        { id: "delete", trackType: "text", trackIndex: 1, startTime: 2, endTime: 4 },
        { id: "locked-boundary", trackType: "text", trackIndex: 1, startTime: 6, endTime: 7, locked: true },
        { id: "later-overlap", trackType: "text", trackIndex: 1, startTime: 7, endTime: 9 },
        { id: "later-clear", trackType: "text", trackIndex: 1, startTime: 9, endTime: 11 },
        { id: "other-track", trackType: "audio", trackIndex: 1, startTime: 7, endTime: 9 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["delete"]),
    )).toEqual({
      deleteIds: ["delete"],
      commits: [
        { clipId: "other-track", startTime: 5, endTime: 7 },
        { clipId: "later-clear", startTime: 7, endTime: 9 },
      ],
    });
  });

  it("trims and splits non-selected clips that overlap the deleted global range", () => {
    const result = rippleDeleteTimelineClipsGlobally(
      [
        { id: "spanning", trackType: "audio", trackIndex: 1, startTime: 1, endTime: 7, trimStart: 10, trimEnd: 16, mediaUrl: "https://example.com/audio.wav" },
        { id: "delete", trackType: "text", trackIndex: 1, startTime: 3, endTime: 5 },
        { id: "later", trackType: "text", trackIndex: 1, startTime: 8, endTime: 9 },
      ],
      [
        { type: "audio", index: 1, locked: false },
        { type: "text", index: 1, locked: false },
      ],
      new Set(["delete"]),
    );

    expect(result).toEqual({
      deleteIds: ["delete"],
      commits: [
        { clipId: "spanning", startTime: 1, endTime: 3, trimStart: 10, trimEnd: 12 },
        { clipId: "later", startTime: 6, endTime: 7 },
      ],
      creates: [
        {
          trackType: "audio",
          trackIndex: 1,
          startTime: 3,
          endTime: 5,
          trimStart: 14,
          trimEnd: 16,
          mediaUrl: "https://example.com/audio.wav",
        },
      ],
    });
  });
});

describe("shouldCanvasHandleTimelineDelete", () => {
  it("handles plain delete keys but leaves shifted delete keys for ripple delete", () => {
    expect(shouldCanvasHandleTimelineDelete({ key: "Delete", shiftKey: false })).toBe(true);
    expect(shouldCanvasHandleTimelineDelete({ key: "Backspace", shiftKey: false })).toBe(true);
    expect(shouldCanvasHandleTimelineDelete({ key: "Delete", shiftKey: true })).toBe(false);
    expect(shouldCanvasHandleTimelineDelete({ key: "Backspace", shiftKey: true })).toBe(false);
  });

  it("leaves modified delete keys for editor-level gap and keyframe shortcuts", () => {
    expect(shouldCanvasHandleTimelineDelete({ key: "Delete", altKey: true })).toBe(false);
    expect(shouldCanvasHandleTimelineDelete({ key: "Backspace", altKey: true })).toBe(false);
    expect(shouldCanvasHandleTimelineDelete({ key: "Delete", ctrlKey: true })).toBe(false);
    expect(shouldCanvasHandleTimelineDelete({ key: "Backspace", metaKey: true })).toBe(false);
  });
});

describe("getTimelineNavigationEndTime", () => {
  it("returns the latest end across clips and positioned scenes", () => {
    const result = getTimelineNavigationEndTime({
      clips: [
        { id: "clip-1", startTime: 3, endTime: 8 },
        { id: "clip-2", startTime: 12, endTime: 15 },
      ],
      scenes: [
        { id: "scene-1", startTime: "00:00", endTime: "00:05", duration: 5 },
        { id: "scene-2", startTime: "00:05", endTime: "00:10", duration: 4, timelinePositionSeconds: 20 },
      ],
    });

    expect(result).toBe(24);
  });
});

describe("getAdjacentTimelineEditPoint", () => {
  it("finds previous and next clip or scene boundaries", () => {
    const input = {
      clips: [
        { id: "clip-1", startTime: 2, endTime: 5 },
        { id: "clip-2", startTime: 8, endTime: 11 },
      ],
      scenes: [
        { id: "scene-1", startTime: "00:00", endTime: "00:04", duration: 4 },
        { id: "scene-2", startTime: "00:04", endTime: "00:08", duration: 3, timelinePositionSeconds: 12 },
      ],
      currentTime: 6,
    };

    expect(getAdjacentTimelineEditPoint({ ...input, direction: -1 })).toBe(5);
    expect(getAdjacentTimelineEditPoint({ ...input, direction: 1 })).toBe(8);
    expect(getAdjacentTimelineEditPoint({ ...input, currentTime: 8, direction: 1 })).toBe(11);
  });
});

describe("getTimelineSplitClipIdsAtPlayhead", () => {
  it("returns selected clips that can be split at the playhead", () => {
    const result = getTimelineSplitClipIdsAtPlayhead(
      [
        { id: "clip-1", startTime: 0, endTime: 6 },
        { id: "clip-2", startTime: 4, endTime: 8 },
        { id: "clip-3", startTime: 7, endTime: 10 },
        { id: "clip-4", startTime: 4.95, endTime: 8 },
      ],
      new Set(["clip-1", "clip-2", "clip-3", "clip-4"]),
      5,
    );

    expect(result).toEqual(["clip-1", "clip-2"]);
  });

  it("falls back to clips under the playhead when nothing is selected", () => {
    const result = getTimelineSplitClipIdsAtPlayhead(
      [
        { id: "clip-1", startTime: 0, endTime: 6 },
        { id: "clip-2", startTime: 4, endTime: 8 },
        { id: "clip-3", startTime: 7, endTime: 10 },
      ],
      new Set(),
      5,
    );

    expect(result).toEqual(["clip-1", "clip-2"]);
  });
});

describe("getTimelineSplitTargetClipIdsAtPlayhead", () => {
  it("does not fall back to every editable clip under the playhead when nothing is selected", () => {
    const result = getTimelineSplitTargetClipIdsAtPlayhead(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
      ],
      [
        { type: "video", index: 1, locked: true },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(),
      null,
      4,
    );

    expect(result).toEqual([]);
  });

  it("does not split every clip when the selected clip is locked", () => {
    const result = getTimelineSplitTargetClipIdsAtPlayhead(
      [
        { id: "locked-selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8, locked: true },
        { id: "editable-under", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["locked-selected"]),
      null,
      4,
    );

    expect(result).toEqual([]);
  });
});

describe("getTimelineSplitAllTrackClipIdsAtPlayhead", () => {
  it("splits every editable unlocked track under the playhead even when a clip is selected", () => {
    const result = getTimelineSplitAllTrackClipIdsAtPlayhead(
      [
        { id: "selected-video", trackType: "video", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "other-video", trackType: "video", trackIndex: 2, startTime: 1, endTime: 9 },
        { id: "text", trackType: "text", trackIndex: 1, startTime: 2, endTime: 10 },
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "edge-only", trackType: "video", trackIndex: 3, startTime: 4, endTime: 8 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "video", index: 2, locked: false },
        { type: "video", index: 3, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: true },
      ],
      4,
    );

    expect(result).toEqual(["selected-video", "other-video", "text"]);
  });
});

describe("getTimelineSplitTargetAtNearestMarker", () => {
  it("returns the nearest valid marker split for editable selected clips", () => {
    const result = getTimelineSplitTargetAtNearestMarker(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "text-1", trackType: "text", trackIndex: 1, startTime: 1, endTime: 9 },
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "edge-only", trackType: "video", trackIndex: 2, startTime: 4, endTime: 9 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "video", index: 2, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: true },
      ],
      new Set(["video-1", "text-1", "locked-audio", "edge-only"]),
      null,
      [
        { id: "marker-edge", time: 4 },
        { id: "marker-valid", time: 5.2 },
        { id: "marker-far", time: 7 },
      ],
      5,
    );

    expect(result).toEqual({
      splitTime: 5.2,
      clipIds: ["video-1", "text-1", "edge-only"],
    });
  });

  it("does not fall back to editable clips at the nearest valid marker when nothing is selected", () => {
    const result = getTimelineSplitTargetAtNearestMarker(
      [
        { id: "video-1", trackType: "video", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "audio-1", trackType: "audio", trackIndex: 1, startTime: 3, endTime: 9 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(),
      null,
      [
        { id: "marker-1", time: 1 },
        { id: "marker-2", time: 4 },
      ],
      4.1,
    );

    expect(result).toBeNull();
  });

  it("does not split at a marker when the selected clip is locked", () => {
    const result = getTimelineSplitTargetAtNearestMarker(
      [
        { id: "locked-selected", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8, locked: true },
        { id: "editable-under", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["locked-selected"]),
      null,
      [{ id: "marker", time: 4 }],
      4,
    );

    expect(result).toBeNull();
  });
});

describe("getTimelineSplitAllTrackTargetAtNearestMarker", () => {
  it("splits every editable unlocked track at the nearest valid marker even when a clip is selected", () => {
    const result = getTimelineSplitAllTrackTargetAtNearestMarker(
      [
        { id: "selected-video", trackType: "video", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "other-video", trackType: "video", trackIndex: 2, startTime: 0, endTime: 8 },
        { id: "text", trackType: "text", trackIndex: 1, startTime: 1, endTime: 9 },
        { id: "locked-audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "edge-only", trackType: "video", trackIndex: 3, startTime: 4, endTime: 8 },
      ],
      [
        { type: "video", index: 1, locked: false },
        { type: "video", index: 2, locked: false },
        { type: "video", index: 3, locked: false },
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: true },
      ],
      [
        { id: "edge", time: 4 },
        { id: "valid", time: 5 },
        { id: "far", time: 7 },
      ],
      4.8,
    );

    expect(result).toEqual({
      splitTime: 5,
      clipIds: ["other-video", "selected-video", "text", "edge-only"],
    });
  });
});

describe("getTimelineSplitMarkerRangeBoundaryTargets", () => {
  it("returns out-then-in split targets for editable clips spanning marker range boundaries", () => {
    const result = getTimelineSplitMarkerRangeBoundaryTargets(
      [
        { id: "spans-both", trackType: "video", trackIndex: 1, startTime: 0, endTime: 10 },
        { id: "spans-in", trackType: "audio", trackIndex: 1, startTime: 2, endTime: 5 },
        { id: "spans-out", trackType: "text", trackIndex: 1, startTime: 6, endTime: 9 },
        { id: "inside", trackType: "video", trackIndex: 2, startTime: 4.5, endTime: 6.5 },
        { id: "locked-spans-both", trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 10 },
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
        { id: "out", time: 7 },
      ],
      5,
    );

    expect(result).toEqual([
      { splitTime: 7, clipIds: ["spans-both", "spans-out"] },
      { splitTime: 4, clipIds: ["spans-both", "spans-in"] },
    ]);
  });

  it("returns no split targets without a complete marker bracket", () => {
    expect(getTimelineSplitMarkerRangeBoundaryTargets(
      [{ id: "clip", trackType: "video", trackIndex: 1, startTime: 0, endTime: 10 }],
      [{ type: "video", index: 1, locked: false }],
      [{ id: "in", time: 4 }],
      5,
    )).toEqual([]);
  });
});

describe("getTimelineTrackSplitTargetClipIdsAtPlayhead", () => {
  it("splits only clips under the playhead on the active editable track", () => {
    const result = getTimelineTrackSplitTargetClipIdsAtPlayhead(
      [
        { id: "active-anchor", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "same-track-under", trackType: "text", trackIndex: 1, startTime: 1, endTime: 9 },
        { id: "other-track-under", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "same-type-other-track", trackType: "text", trackIndex: 2, startTime: 0, endTime: 8 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "text", index: 2, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["active-anchor"]),
      null,
      4,
    );

    expect(result).toEqual(["active-anchor", "same-track-under"]);
  });

  it("does not split anything when there is no active track", () => {
    const result = getTimelineTrackSplitTargetClipIdsAtPlayhead(
      [
        { id: "text", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "audio", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(),
      null,
      4,
    );

    expect(result).toEqual([]);
  });

  it("does not use a locked clip as the active track split anchor", () => {
    const result = getTimelineTrackSplitTargetClipIdsAtPlayhead(
      [
        { id: "locked-anchor", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8, locked: true },
        { id: "same-track-under", trackType: "text", trackIndex: 1, startTime: 0, endTime: 8 },
        { id: "other-track-under", trackType: "audio", trackIndex: 1, startTime: 0, endTime: 8 },
      ],
      [
        { type: "text", index: 1, locked: false },
        { type: "audio", index: 1, locked: false },
      ],
      new Set(["locked-anchor"]),
      null,
      4,
    );

    expect(result).toEqual([]);
  });
});
