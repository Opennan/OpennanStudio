// Unit coverage for local-first timeline undo/redo snapshots.
import { describe, expect, it } from "vitest";
import { createLocalTimelineHistory } from "./local-timeline-history";

type TestTimeline = {
  tracks: { type: string; index: number }[];
  clips: { id: string; startTime: number; endTime: number }[];
  canUndo: boolean;
  canRedo: boolean;
};

const timeline = (startTime: number): TestTimeline => ({
  tracks: [{ type: "video", index: 1 }],
  clips: [{ id: "clip-1", startTime, endTime: startTime + 5 }],
  canUndo: false,
  canRedo: false,
});

describe("createLocalTimelineHistory", () => {
  it("applies undo and redo from local snapshots without needing a server response", () => {
    const history = createLocalTimelineHistory<TestTimeline>(3);
    const before = timeline(0);
    const after = timeline(10);

    history.record(before, after);

    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toEqual(before);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    expect(history.redo()).toEqual(after);
  });

  it("caps undo history and clears redo when a new local edit branches", () => {
    const history = createLocalTimelineHistory<TestTimeline>(2);

    history.record(timeline(0), timeline(1));
    history.record(timeline(1), timeline(2));
    history.record(timeline(2), timeline(3));

    expect(history.undo()).toEqual(timeline(2));
    expect(history.undo()).toEqual(timeline(1));
    expect(history.undo()).toBeNull();

    history.redo();
    history.record(timeline(2), timeline(4));

    expect(history.canRedo()).toBe(false);
    expect(history.undo()).toEqual(timeline(2));
  });

  it("ignores no-op snapshots so undo state does not light up for unchanged edits", () => {
    const history = createLocalTimelineHistory<TestTimeline>();

    expect(history.record(timeline(0), timeline(0))).toBeNull();

    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBeNull();
  });

  it("drops a specific entry by token so server-rejected edits leave no phantom undo", () => {
    const history = createLocalTimelineHistory<TestTimeline>();

    const first = history.record(timeline(0), timeline(1));
    const rejected = history.record(timeline(1), timeline(2));
    expect(first).not.toBeNull();
    expect(rejected).not.toBeNull();

    expect(history.dropEntry(rejected!)).toBe(true);
    // Undo now goes straight to the surviving first entry.
    expect(history.undo()).toEqual(timeline(0));
    expect(history.canUndo()).toBe(false);
    // Dropping an unknown token is a no-op.
    expect(history.dropEntry(999)).toBe(false);
  });

  it("remaps clip ids in recorded snapshots so redo restores real server ids", () => {
    const history = createLocalTimelineHistory<TestTimeline>();
    const before = timeline(0);
    const after: TestTimeline = {
      ...timeline(0),
      clips: [...timeline(0).clips, { id: "temp-1", startTime: 10, endTime: 12 }],
    };
    history.record(before, after);

    history.mapSnapshots((snapshot) => ({
      ...snapshot,
      clips: snapshot.clips.map((clip) => (clip.id === "temp-1" ? { ...clip, id: "real-1" } : clip)),
    }));

    history.undo();
    const redone = history.redo();
    expect(redone?.clips.map((clip) => clip.id)).toEqual(["clip-1", "real-1"]);
  });
});
