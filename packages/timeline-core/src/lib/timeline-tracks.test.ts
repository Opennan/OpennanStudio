// Unit tests for building the next timeline track of a given type.
import { describe, expect, it } from "vitest";
import { nextTrackForType, normalizeTimelineTracks, resolveNonOverlappingTrackIndex, setTimelineTrackVolume, swapTimelineTrackOrder } from "./timeline-tracks";
import type { TimelineTrackLike } from "./timeline-tracks";

const track = (type: TimelineTrackLike["type"], index: number): TimelineTrackLike => ({
  type,
  index,
  label: `${type}${index}`,
  muted: false,
  locked: false,
  visible: true,
  volume: 1,
});

describe("nextTrackForType", () => {
  it("creates the first audio track at index 2 (index 1 is the primary lane)", () => {
    const t = nextTrackForType([], "audio");
    expect(t.index).toBe(2);
    expect(t.label).toBe("A2");
    expect(t).toMatchObject({ type: "audio", locked: false, visible: true, muted: false, volume: 1 });
  });

  it("creates the first video track at index 2 as well", () => {
    expect(nextTrackForType([], "video").index).toBe(2);
  });

  it("creates the first text/sticker/effect track at index 1", () => {
    expect(nextTrackForType([], "text").index).toBe(1);
    expect(nextTrackForType([], "text").label).toBe("T1");
  });

  it("increments past the highest existing index of that type", () => {
    const tracks = [track("audio", 2), track("audio", 4), track("video", 9)];
    expect(nextTrackForType(tracks, "audio").index).toBe(5);
    expect(nextTrackForType(tracks, "audio").label).toBe("A5");
  });
});

describe("remotion track type", () => {
  it("keeps remotion tracks through normalization", () => {
    const tracks = normalizeTimelineTracks([
      { type: "remotion", index: 1, label: "", muted: false, locked: false, visible: true, volume: 1 },
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].label).toBe("R1");
  });

  it("creates the next remotion track at index 1", () => {
    const t = nextTrackForType([], "remotion");
    expect(t.index).toBe(1);
    expect(t.label).toBe("R1");
  });
});

describe("setTimelineTrackVolume", () => {
  it("updates only the targeted track and leaves siblings untouched", () => {
    const tracks = [track("video", 1), track("audio", 1), track("audio", 2)];
    const updated = setTimelineTrackVolume(tracks, "audio-2", 0.4);
    expect(updated[2].volume).toBe(0.4);
    expect(updated[0].volume).toBe(1);
    expect(updated[1].volume).toBe(1);
    expect(updated[0]).toBe(tracks[0]);
  });

  it("clamps to the 0–1 fader range preview and export both apply", () => {
    const tracks = [track("audio", 1)];
    expect(setTimelineTrackVolume(tracks, "audio-1", 1.8)[0].volume).toBe(1);
    expect(setTimelineTrackVolume(tracks, "audio-1", -0.5)[0].volume).toBe(0);
    expect(setTimelineTrackVolume(tracks, "audio-1", Number.NaN)[0].volume).toBe(1);
  });

  it("returns the same array when the key is missing or the volume is unchanged", () => {
    const tracks = [track("audio", 1)];
    expect(setTimelineTrackVolume(tracks, "audio-9", 0.5)).toBe(tracks);
    expect(setTimelineTrackVolume(tracks, "audio-1", 1)).toBe(tracks);
  });
});

describe("resolveNonOverlappingTrackIndex", () => {
  const clip = (trackType: string, trackIndex: number, startTime: number, endTime: number) => ({
    trackType,
    trackIndex,
    startTime,
    endTime,
  });

  it("keeps the first candidate when its track is empty", () => {
    expect(resolveNonOverlappingTrackIndex([], "audio", [2, 3], 0, 5)).toBe(2);
  });

  it("keeps the first candidate when the drop range doesn't touch its clips", () => {
    const clips = [clip("audio", 2, 0, 4)];
    expect(resolveNonOverlappingTrackIndex(clips, "audio", [2, 3], 4, 9)).toBe(2);
  });

  it("bumps to the next candidate when the drop overlaps an existing clip", () => {
    const clips = [clip("audio", 2, 0, 10)];
    expect(resolveNonOverlappingTrackIndex(clips, "audio", [2, 3], 5, 8)).toBe(3);
  });

  it("returns null when every candidate track is occupied at the drop range", () => {
    const clips = [clip("video", 2, 0, 10), clip("video", 3, 5, 12)];
    expect(resolveNonOverlappingTrackIndex(clips, "video", [2, 3], 6, 9)).toBeNull();
  });

  it("ignores clips of other track types and other indices", () => {
    const clips = [clip("audio", 2, 0, 10), clip("sticker", 1, 0, 10)];
    expect(resolveNonOverlappingTrackIndex(clips, "sticker", [1, 2], 2, 6)).toBe(2);
    expect(resolveNonOverlappingTrackIndex(clips, "video", [2], 2, 6)).toBe(2);
  });

  it("treats touching edges as free (back-to-back clips are legal)", () => {
    const clips = [clip("video", 2, 5, 10)];
    expect(resolveNonOverlappingTrackIndex(clips, "video", [2], 10, 15)).toBe(2);
    expect(resolveNonOverlappingTrackIndex(clips, "video", [2], 0, 5)).toBe(2);
  });
});

describe("swapTimelineTrackOrder", () => {
  it("swaps indices and default labels of two same-type tracks", () => {
    const tracks = [track("video", 1), track("video", 2), track("video", 3)];
    tracks[1].label = "V2";
    tracks[2].label = "V3";
    const out = swapTimelineTrackOrder(tracks, "video-2", "video-3")!;
    expect(out.find((t) => t.label === "V2")!.index).toBe(2);
    expect(out.find((t) => t.label === "V3")!.index).toBe(3);
    // Original V2 track object moved to index 3 with regenerated label
    expect(out[1].index).toBe(3);
    expect(out[1].label).toBe("V3");
    expect(out[2].index).toBe(2);
    expect(out[2].label).toBe("V2");
  });

  it("keeps custom labels attached to their track", () => {
    const tracks = [track("audio", 2), track("audio", 3)];
    tracks[0].label = "SFX";
    tracks[1].label = "A3";
    const out = swapTimelineTrackOrder(tracks, "audio-2", "audio-3")!;
    expect(out[0]).toMatchObject({ index: 3, label: "SFX" });
    expect(out[1]).toMatchObject({ index: 2, label: "A2" });
  });

  it("refuses cross-type swaps and the pinned V1/A1 lanes", () => {
    const tracks = [track("video", 1), track("video", 2), track("audio", 1), track("audio", 2), track("text", 1), track("text", 2)];
    expect(swapTimelineTrackOrder(tracks, "video-2", "audio-2")).toBeNull();
    expect(swapTimelineTrackOrder(tracks, "video-1", "video-2")).toBeNull();
    expect(swapTimelineTrackOrder(tracks, "audio-1", "audio-2")).toBeNull();
    expect(swapTimelineTrackOrder(tracks, "text-1", "text-2")).not.toBeNull();
  });

  it("returns null when a track is missing or keys are equal", () => {
    const tracks = [track("video", 2), track("video", 3)];
    expect(swapTimelineTrackOrder(tracks, "video-2", "video-9")).toBeNull();
    expect(swapTimelineTrackOrder(tracks, "video-2", "video-2")).toBeNull();
  });
});

describe("normalizeTimelineTracks", () => {
  it("dedupes duplicate persisted rows before frontend state renders lanes", () => {
    const tracks = normalizeTimelineTracks([
      track("video", 1),
      track("audio", 1),
      { ...track("audio", 1), label: "A1 duplicate", muted: true },
      track("audio", 2),
      { ...track("audio", 2), label: "A2 duplicate", visible: false },
    ]);

    expect(tracks.map((item) => `${item.type}-${item.index}`)).toEqual(["video-1", "audio-1", "audio-2"]);
    expect(tracks[1]).toMatchObject({ label: "A1 duplicate", muted: true });
    expect(tracks[2]).toMatchObject({ label: "A2 duplicate", visible: false });
  });

  it("parses string booleans from persisted DB config instead of falling back", () => {
    const tracks = normalizeTimelineTracks([
      {
        ...track("audio", 1),
        locked: "true" as unknown as boolean,
        muted: "false" as unknown as boolean,
        visible: "false" as unknown as boolean,
      },
    ]);

    expect(tracks[0]).toMatchObject({
      locked: true,
      muted: false,
      visible: false,
    });
  });
});
