import { CANVAS_PRESETS, canvasSize, parseAspectRatio } from "./canvas-presets";

describe("canvas presets", () => {
    it("offers the four CapCut presets", () => {
        expect(CANVAS_PRESETS.map((preset) => preset.ratio)).toEqual(["16:9", "9:16", "1:1", "4:5"]);
    });

    it("parses ratios and falls back to 16:9", () => {
        expect(parseAspectRatio("4:5")).toEqual({ w: 4, h: 5 });
        expect(parseAspectRatio("2.39:1")).toEqual({ w: 2.39, h: 1 });
        expect(parseAspectRatio("0:5")).toEqual({ w: 16, h: 9 });
        expect(parseAspectRatio(undefined)).toEqual({ w: 16, h: 9 });
    });

    it("sizes the export frame by its short side", () => {
        expect(canvasSize("16:9", "720p")).toEqual({ width: 1280, height: 720 });
        expect(canvasSize("16:9", "1080p")).toEqual({ width: 1920, height: 1080 });
        expect(canvasSize("9:16", "1080p")).toEqual({ width: 1080, height: 1920 });
        expect(canvasSize("1:1", "720p")).toEqual({ width: 720, height: 720 });
        expect(canvasSize("4:5", "1080p")).toEqual({ width: 1080, height: 1350 });
        expect(canvasSize("4:3", "720p")).toEqual({ width: 960, height: 720 });
        expect(canvasSize("2.39:1", "720p")).toEqual({ width: 1720, height: 720 });
        expect(canvasSize("bogus", "720p")).toEqual({ width: 1280, height: 720 });
    });
});
