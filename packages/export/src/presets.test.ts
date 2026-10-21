import { parseAspectRatio, resolutionWithin, resolveOutputFormat } from "./presets";

describe("parseAspectRatio", () => {
    it("parses W:H and falls back to 16:9", () => {
        expect(parseAspectRatio("9:16")).toBeCloseTo(0.5625);
        expect(parseAspectRatio("4:5")).toBeCloseTo(0.8);
        expect(parseAspectRatio("wide")).toBeCloseTo(16 / 9);
        expect(parseAspectRatio("1:100")).toBeCloseTo(0.2);
        expect(parseAspectRatio("100000:1")).toBeCloseTo(5);
        expect(parseAspectRatio("0:5")).toBeCloseTo(16 / 9);
        expect(parseAspectRatio(null)).toBeCloseTo(16 / 9);
    });
});

describe("resolveOutputFormat", () => {
    it.each([
        ["16:9", "720p", 1280, 720],
        ["16:9", "1080p", 1920, 1080],
        ["16:9", "4k", 3840, 2160],
        ["9:16", "720p", 720, 1280],
        ["9:16", "1080p", 1080, 1920],
        ["9:16", "4k", 2160, 3840],
        ["1:1", "720p", 720, 720],
        ["1:1", "1080p", 1080, 1080],
        ["1:1", "4k", 2160, 2160],
        ["4:5", "720p", 720, 900],
        ["4:5", "1080p", 1080, 1350],
        ["4:5", "4k", 2160, 2700],
    ] as const)("%s at %s is %dx%d", (ratio, resolution, width, height) => {
        const format = resolveOutputFormat(ratio, resolution);
        expect([format.width, format.height]).toEqual([width, height]);
        expect(format.fps).toBe(30);
    });

    it("scales overlay pixels from the 1080p reference frame", () => {
        expect(resolveOutputFormat("16:9", "1080p").frameScale).toBe(1);
        expect(resolveOutputFormat("16:9", "720p").frameScale).toBeCloseTo(2 / 3);
        expect(resolveOutputFormat("9:16", "4k").frameScale).toBe(2);
        expect(resolveOutputFormat("9:16", "1080p").refHeight).toBe(1920);
    });
});

describe("resolutionWithin", () => {
    it("orders 720p < 1080p < 4k", () => {
        expect(resolutionWithin("1080p", "1080p")).toBe(true);
        expect(resolutionWithin("4k", "1080p")).toBe(false);
        expect(resolutionWithin("720p", "4k")).toBe(true);
    });
});

describe("resolveGifFormat (phase 10d)", () => {
    it("caps the width at 640 keeping the aspect with even sides, at 15 fps by default", async () => {
        const { resolveGifFormat, GIF_DEFAULT_FPS } = await import("./presets");
        expect(GIF_DEFAULT_FPS).toBe(15);
        expect(resolveGifFormat("16:9", "1080p")).toMatchObject({ width: 640, height: 360, fps: 15, refHeight: 1080, frameScale: 1 / 3 });
        expect(resolveGifFormat("9:16", "720p")).toMatchObject({ width: 640, height: 1138 });
        expect(resolveGifFormat("4:5", "4k", 12)).toMatchObject({ width: 640, height: 800, fps: 12 });
        // Already narrower: unchanged (a 1:5 strip at 720p is 720 × 3600 → 640 × 3200).
        expect(resolveGifFormat("1:5", "720p").width).toBe(640);
    });
});
