// Unit coverage for the WebCodecs (Mediabunny) timeline frame source.
// The actual decode path needs WebCodecs + a browser, so here we cover the pure
// capability gate, the frame-time planner, and the graceful fallback contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeFramesAtTimes,
  isWebCodecsFrameDecodeSupported,
  planFrameTimes,
} from "./webcodecs-frame-source";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWebCodecsFrameDecodeSupported", () => {
  it("is false in jsdom because VideoDecoder is undefined", () => {
    expect(typeof VideoDecoder).toBe("undefined");
    expect(isWebCodecsFrameDecodeSupported()).toBe(false);
  });

  it("requires a secure context even when VideoDecoder exists", () => {
    vi.stubGlobal("VideoDecoder", function VideoDecoder() {});
    vi.stubGlobal("window", { isSecureContext: false });
    expect(isWebCodecsFrameDecodeSupported()).toBe(false);

    vi.stubGlobal("window", { isSecureContext: true });
    expect(isWebCodecsFrameDecodeSupported()).toBe(true);
  });
});

describe("planFrameTimes", () => {
  it("dedupes, clamps negatives to 0, rounds to 2 decimals, and sorts ascending", () => {
    expect(planFrameTimes([3, 1, 2])).toEqual([1, 2, 3]);
    expect(planFrameTimes([1.005, 1.004, 1.006])).toEqual([1, 1.01]);
    expect(planFrameTimes([-5, 0, 2.5])).toEqual([0, 2.5]);
  });

  it("drops non-finite values", () => {
    expect(planFrameTimes([NaN, Infinity, -Infinity, 4])).toEqual([4]);
  });

  it("returns an empty array for empty input", () => {
    expect(planFrameTimes([])).toEqual([]);
  });

  it("matches the thumbnail cache key rounding (time.toFixed(2))", () => {
    for (const t of planFrameTimes([12.3456, 7.891, 0.001])) {
      expect(Number(t.toFixed(2))).toBe(t);
    }
  });
});

describe("decodeFramesAtTimes fallback contract", () => {
  it("returns false (signal fallback) when WebCodecs is unsupported", async () => {
    const onFrame = vi.fn();
    const handled = await decodeFramesAtTimes("https://cdn.test/clip.mp4", [1, 2], new AbortController().signal, onFrame);
    expect(handled).toBe(false);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("returns true without work when there are no valid times", async () => {
    vi.stubGlobal("VideoDecoder", function VideoDecoder() {});
    vi.stubGlobal("window", { isSecureContext: true });
    const onFrame = vi.fn();
    const handled = await decodeFramesAtTimes("https://cdn.test/clip.mp4", [], new AbortController().signal, onFrame);
    expect(handled).toBe(true);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("returns true immediately when already aborted", async () => {
    vi.stubGlobal("VideoDecoder", function VideoDecoder() {});
    vi.stubGlobal("window", { isSecureContext: true });
    const controller = new AbortController();
    controller.abort();
    const handled = await decodeFramesAtTimes("https://cdn.test/clip.mp4", [1], controller.signal, vi.fn());
    expect(handled).toBe(true);
  });
});

describe("thumbnail-generator integration contract", () => {
  const source = readFileSync(resolve(__dirname, "thumbnail-generator.ts"), "utf8");

  it("imports the WebCodecs helpers", () => {
    expect(source).toContain(
      'import { decodeFramesAtTimes, isWebCodecsFrameDecodeSupported, releaseUnusedInputs } from "./webcodecs-frame-source";',
    );
  });

  it("uses a single batched WebCodecs decode for video URLs, gated by capability", () => {
    expect(source).toContain("if (isImageThumbnailVideo && isWebCodecsFrameDecodeSupported()) {");
    expect(source).toContain("decodeFramesAtTimes(url, needTimes, controller.signal,");
  });

  it("falls back to the per-time <video> path when WebCodecs declines a URL", () => {
    expect(source).toContain("if (!handled && !controller.signal.aborted) enqueuePerTime(needTimes);");
    expect(source).toContain("const enqueuePerTime = (subTimes: number[]) => {");
  });

  it("releases pooled decoders for URLs that leave the visible window", () => {
    expect(source).toContain("releaseUnusedInputs(keepUrls);");
  });
});
