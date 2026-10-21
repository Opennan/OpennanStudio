// Marquee selection of scene strips (phase 10c): scenes sit on the video tracks.
import { describe, expect, it } from "vitest";
import { computeMarqueeHitSceneIds } from "./multi-select";

const tracks = [
  { type: "video", index: 2, y: 0, height: 40 },
  { type: "video", index: 1, y: 40, height: 60 },
  { type: "audio", index: 1, y: 100, height: 40, locked: true },
];
const scenes = [
  { id: "a", trackIndex: 1, start: 0, end: 4 },
  { id: "b", trackIndex: 1, start: 4, end: 8 },
  { id: "up", trackIndex: 2, start: 1, end: 3 },
];

describe("computeMarqueeHitSceneIds", () => {
  it("selects scenes whose strip the box touches", () => {
    // 10 px per second, ruler 20 px: the box covers 3..5 s on V1 (y 60..120).
    const hit = computeMarqueeHitSceneIds({ scenes, tracks, rect: { x0: 30, x1: 50, y0: 70, y1: 90 }, scrollLeft: 0, zoom: 10, rulerHeight: 20 });
    expect([...hit]).toEqual(["a", "b"]);
  });

  it("follows the horizontal scroll and skips other tracks", () => {
    const hit = computeMarqueeHitSceneIds({ scenes, tracks, rect: { x0: 0, x1: 5, y0: 25, y1: 30 }, scrollLeft: 20, zoom: 10, rulerHeight: 20 });
    expect([...hit]).toEqual(["up"]);
  });

  it("skips locked and hidden video tracks", () => {
    const hidden = tracks.map((t) => (t.index === 1 && t.type === "video" ? { ...t, visible: false } : t));
    const hit = computeMarqueeHitSceneIds({ scenes, tracks: hidden, rect: { x0: 0, x1: 100, y0: 0, y1: 200 }, scrollLeft: 0, zoom: 10, rulerHeight: 20 });
    expect([...hit]).toEqual(["up"]);
  });
});
