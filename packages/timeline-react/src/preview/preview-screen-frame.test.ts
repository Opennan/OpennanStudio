// Tests preview frame sizing so vertical source clips remain inspectable.
import { describe, expect, it } from "vitest";
import { getPreviewScreenFrame } from "./preview-screen-frame";

describe("getPreviewScreenFrame", () => {
  it("keeps 9:16 source video large in a short wide preview host", () => {
    const frame = getPreviewScreenFrame({ w: 637, h: 285 }, 9 / 16);

    expect(frame.h).toBeGreaterThanOrEqual(250);
    expect(frame.w).toBeGreaterThanOrEqual(140);
    expect(frame.w / frame.h).toBeCloseTo(9 / 16, 2);
  });
});
