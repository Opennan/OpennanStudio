// Unit coverage for canvas timeline selection set calculations.
import { describe, expect, it } from "vitest";
import { computeContextActionClipIds, computeMarqueeHitClipIds, computeMarqueeSelection, computeSelection } from "./multi-select";

const makeClip = (id: string, trackType: string, trackIndex: number, startTime: number, endTime: number, extra: Record<string, unknown> = {}) => ({
  id,
  trackType,
  trackIndex,
  startTime,
  endTime,
  ...extra,
});

describe("computeMarqueeSelection", () => {
  it("replaces the selection for a plain marquee drag", () => {
    expect([...computeMarqueeSelection({
      baseSelection: new Set(["old"]),
      hitClipIds: new Set(["a", "b"]),
      mode: "replace",
    })]).toEqual(["a", "b"]);
  });

  it("adds marquee hits to the existing selection for additive drags", () => {
    expect([...computeMarqueeSelection({
      baseSelection: new Set(["old"]),
      hitClipIds: new Set(["a", "b"]),
      mode: "add",
    })]).toEqual(["old", "a", "b"]);
  });

  it("removes marquee hits from the existing selection for subtractive drags", () => {
    expect([...computeMarqueeSelection({
      baseSelection: new Set(["keep", "remove", "also-remove"]),
      hitClipIds: new Set(["remove", "also-remove", "unselected-hit"]),
      mode: "subtract",
    })]).toEqual(["keep"]);
  });
});

describe("computeMarqueeHitClipIds", () => {
  it("ignores hidden and locked tracks during marquee selection", () => {
    const hits = computeMarqueeHitClipIds({
      clips: [
        makeClip("visible", "video", 1, 1, 3),
        makeClip("hidden", "video", 2, 1, 3),
        makeClip("locked", "audio", 1, 1, 3),
      ],
      tracks: [
        { type: "video", index: 1, y: 0, height: 64, visible: true, locked: false },
        { type: "video", index: 2, y: 64, height: 64, visible: false, locked: false },
        { type: "audio", index: 1, y: 128, height: 64, visible: true, locked: true },
      ],
      rect: { x0: 0, x1: 40, y0: 20, y1: 212 },
      scrollLeft: 0,
      zoom: 10,
      rulerHeight: 20,
    });

    expect([...hits]).toEqual(["visible"]);
  });
});

describe("computeContextActionClipIds", () => {
  it("targets the clicked clip only when it is not already selected", () => {
    expect([...computeContextActionClipIds("clicked", new Set(["selected-a", "selected-b"]))])
      .toEqual(["clicked"]);
  });

  it("targets the whole selected group when right-clicking a selected clip", () => {
    expect([...computeContextActionClipIds("selected-b", new Set(["selected-a", "selected-b"]))])
      .toEqual(["selected-a", "selected-b"]);
  });
});

describe("computeSelection", () => {
  it("skips locked clips in shift-click range selection", () => {
    const selection = computeSelection(
      "right",
      new Set(["left"]),
      [
        makeClip("left", "text", 1, 0, 1),
        makeClip("locked-clip", "text", 1, 2, 3, { locked: true }),
        makeClip("right", "text", 1, 6, 7),
      ],
      { ctrl: false, shift: true },
      [
        { type: "text", index: 1, visible: true, locked: false },
      ],
    );

    expect([...selection]).toEqual(["left", "right"]);
  });
});
