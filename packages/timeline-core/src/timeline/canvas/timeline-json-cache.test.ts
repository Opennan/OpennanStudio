// Unit coverage for cached timeline JSON parsing helpers.
import { describe, expect, it, vi } from "vitest";
import { getCachedClipKeyframeTimes, parseCachedSceneCardConfig } from "./timeline-json-cache";

describe("timeline JSON cache", () => {
  it("caches scene card config objects by raw JSON string", () => {
    const raw = JSON.stringify({ timelineTrimStart: 2, timelineTrimEnd: 8 });
    const parseSpy = vi.spyOn(JSON, "parse");

    const first = parseCachedSceneCardConfig(raw);
    const second = parseCachedSceneCardConfig(raw);

    expect(first).toBe(second);
    expect(first).toEqual({ timelineTrimStart: 2, timelineTrimEnd: 8 });
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
  });

  it("caches clip keyframe parsing by raw JSON and filters by duration", () => {
    const raw = JSON.stringify({ keyframes: [{ time: 0 }, { time: 2.5 }, { time: 7 }, { time: "bad" }] });
    const parseSpy = vi.spyOn(JSON, "parse");

    const first = getCachedClipKeyframeTimes(raw, 5);
    const second = getCachedClipKeyframeTimes(raw, 5);
    const longer = getCachedClipKeyframeTimes(raw, 8);

    expect(first).toBe(second);
    expect(first).toEqual([0, 2.5]);
    expect(longer).toEqual([0, 2.5, 7]);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
  });

  it("shares empty results for invalid keyframe JSON", () => {
    const parseSpy = vi.spyOn(JSON, "parse");

    const first = getCachedClipKeyframeTimes("{bad", 10);
    const second = getCachedClipKeyframeTimes("{bad", 10);

    expect(first).toBe(second);
    expect(first).toEqual([]);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
  });
});
