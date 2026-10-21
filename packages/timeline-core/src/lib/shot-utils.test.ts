// Unit coverage for shared shot breakdown parsing helpers.
import { describe, expect, it, vi } from "vitest";
import { parseCachedShotBreakdown, parseShotBreakdown } from "./shot-utils";

describe("shot breakdown parsing", () => {
  it("keeps the normal parser returning fresh arrays for editing workflows", () => {
    const raw = JSON.stringify([{ prompt: "one", duration: 1 }]);

    expect(parseShotBreakdown(raw)).not.toBe(parseShotBreakdown(raw));
  });

  it("caches parsed shot breakdowns for read-only render paths", () => {
    const raw = JSON.stringify([{ prompt: "one", duration: 1 }]);
    const parseSpy = vi.spyOn(JSON, "parse");

    const first = parseCachedShotBreakdown(raw);
    const second = parseCachedShotBreakdown(raw);

    expect(first).toBe(second);
    expect(first).toEqual([{ prompt: "one", duration: 1 }]);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
  });

  it("returns a shared empty array for invalid cached shot breakdowns", () => {
    const parseSpy = vi.spyOn(JSON, "parse");

    expect(parseCachedShotBreakdown("{bad")).toEqual([]);
    expect(parseCachedShotBreakdown("{bad")).toEqual([]);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parseSpy.mockRestore();
  });
});
