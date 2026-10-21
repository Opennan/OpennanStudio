// Unit tests for timeline clip commit execution helpers.
import { describe, expect, it } from "vitest";
import {
  commitTimelineClipCommand,
  commitTimelineClipCreates,
  commitTimelineClipSplits,
  commitTimelineClipUpdates,
} from "./timeline-commits";

describe("commitTimelineClipCommand", () => {
  it("uses the batch deleter even when no single deleter is provided", async () => {
    const calls: string[] = [];

    await commitTimelineClipCommand(
      {
        creates: [],
        updates: [],
        deleteIds: ["clip-b"],
        description: "Delete selected",
      },
      {
        createClip: async () => null,
        updateClip: async () => null,
        deleteClips: async (clipIds) => {
          calls.push(`batch-delete:${clipIds.join(",")}`);
        },
      },
    );

    expect(calls).toEqual(["batch-delete:clip-b"]);
  });

  it("uses a composite command runner when available", async () => {
    const calls: string[] = [];

    const created = await commitTimelineClipCommand(
      {
        creates: [{ startTime: 1, endTime: 3, trackType: "text" }],
        updates: [{ clipId: "clip-a", startTime: 4, endTime: 6 }],
        deleteIds: ["clip-b"],
        description: "Overwrite paste",
      },
      {
        createClip: async () => {
          calls.push("single-create");
          return null;
        },
        updateClip: async () => {
          calls.push("single-update");
          return null;
        },
        deleteClip: async () => {
          calls.push("single-delete");
          return false;
        },
        clipCommand: async (command) => {
          calls.push(`command:${command.creates.length}:${command.updates.length}:${command.deleteIds.length}`);
          return [{ id: "created" }];
        },
      },
    );

    expect(calls).toEqual(["command:1:1:1"]);
    expect(created).toEqual([{ id: "created" }]);
  });
});

describe("commitTimelineClipUpdates", () => {
  it("uses the batch updater for a single clip commit when no single updater is available", async () => {
    const calls: string[] = [];

    await commitTimelineClipUpdates(
      [{ clipId: "clip-1", startTime: 1, endTime: 4 }],
      {
        updateClips: async (commits) => {
          calls.push(`batch:${commits.map((commit) => commit.clipId).join(",")}`);
        },
      },
    );

    expect(calls).toEqual(["batch:clip-1"]);
  });

  it("uses the batch updater for multiple clip commits", async () => {
    const calls: string[] = [];

    await commitTimelineClipUpdates(
      [
        { clipId: "clip-1", startTime: 1, endTime: 4 },
        { clipId: "clip-2", startTime: 5, endTime: 8 },
      ],
      {
        updateClip: async () => {
          calls.push("single");
          return null;
        },
        updateClips: async (commits) => {
          calls.push(`batch:${commits.length}`);
        },
      },
    );

    expect(calls).toEqual(["batch:2"]);
  });

  it("falls back to single updates when no batch updater is available", async () => {
    const calls: string[] = [];

    await commitTimelineClipUpdates(
      [
        { clipId: "clip-1", startTime: 1, endTime: 4 },
        { clipId: "clip-2", startTime: 5, endTime: 8 },
      ],
      {
        updateClip: async (clipId, input) => {
          calls.push(`${clipId}:${input.startTime}-${input.endTime}`);
          return null;
        },
      },
    );

    expect(calls).toEqual(["clip-1:1-4", "clip-2:5-8"]);
  });

  it("preserves trim fields in single update fallback calls", async () => {
    const updates: unknown[] = [];

    await commitTimelineClipUpdates(
      [{ clipId: "clip-a", startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 }],
      {
        updateClip: async (clipId, input) => {
          updates.push({ clipId, input });
          return null;
        },
      },
    );

    expect(updates).toEqual([
      { clipId: "clip-a", input: { startTime: 2, endTime: 5, trimStart: 10, trimEnd: 13 } },
    ]);
  });
});

describe("commitTimelineClipCreates", () => {
  it("uses the batch creator for a single clip input when no single creator is available", async () => {
    const calls: string[] = [];

    const created = await commitTimelineClipCreates(
      [{ startTime: 1, endTime: 3, trackType: "video" }],
      {
        createClips: async (inputs) => {
          calls.push(`batch:${inputs.length}`);
          return [{ id: "clip-1" }];
        },
      },
    );

    expect(calls).toEqual(["batch:1"]);
    expect(created).toEqual([{ id: "clip-1" }]);
  });

  it("uses the batch creator for multiple clip inputs", async () => {
    const calls: string[] = [];

    const created = await commitTimelineClipCreates(
      [
        { startTime: 1, endTime: 3, trackType: "text" },
        { startTime: 4, endTime: 6, trackType: "audio" },
      ],
      {
        createClip: async () => {
          calls.push("single");
          return null;
        },
        createClips: async (inputs) => {
          calls.push(`batch:${inputs.length}`);
          return [{ id: "clip-1" }, { id: "clip-2" }];
        },
      },
    );

    expect(calls).toEqual(["batch:2"]);
    expect(created).toEqual([{ id: "clip-1" }, { id: "clip-2" }]);
  });

  it("falls back to single creates when no batch creator is available", async () => {
    const calls: string[] = [];

    await commitTimelineClipCreates(
      [
        { startTime: 1, endTime: 3, trackType: "text" },
        { startTime: 4, endTime: 6, trackType: "audio" },
      ],
      {
        createClip: async (input) => {
          calls.push(`${input.trackType}:${input.startTime}-${input.endTime}`);
          return { id: String(input.trackType) };
        },
      },
    );

    expect(calls).toEqual(["text:1-3", "audio:4-6"]);
  });
});

describe("commitTimelineClipSplits", () => {
  it("uses the batch splitter even when no single splitter is provided", async () => {
    const calls: string[] = [];

    const created = await commitTimelineClipSplits(
      ["clip-1"],
      4.5,
      {
        splitClips: async (clipIds, splitTime) => {
          calls.push(`batch:${clipIds.join(",")}:${splitTime}`);
          return [{ id: "right-1" }];
        },
      },
    );

    expect(calls).toEqual(["batch:clip-1:4.5"]);
    expect(created).toEqual([{ id: "right-1" }]);
  });

  it("uses the batch splitter for multiple clip ids and returns created split clips", async () => {
    const calls: string[] = [];

    const created = await commitTimelineClipSplits(
      ["clip-1", "clip-2"],
      4.5,
      {
        splitClip: async () => {
          calls.push("single");
          return null;
        },
        splitClips: async (clipIds, splitTime) => {
          calls.push(`batch:${clipIds.join(",")}:${splitTime}`);
          return [{ id: "right-1" }, { id: "right-2" }];
        },
      },
    );

    expect(calls).toEqual(["batch:clip-1,clip-2:4.5"]);
    expect(created).toEqual([{ id: "right-1" }, { id: "right-2" }]);
  });

  it("falls back to single splits and returns created split clips", async () => {
    const calls: string[] = [];

    const created = await commitTimelineClipSplits(
      ["clip-1", "clip-2"],
      4.5,
      {
        splitClip: async (clipId, splitTime) => {
          calls.push(`${clipId}:${splitTime}`);
          return { id: `${clipId}-right` };
        },
      },
    );

    expect(calls).toEqual(["clip-1:4.5", "clip-2:4.5"]);
    expect(created).toEqual([{ id: "clip-1-right" }, { id: "clip-2-right" }]);
  });
});
