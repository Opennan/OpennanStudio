import { describe, expect, it } from "vitest";
import { sceneFitRect } from "./fit";

describe("sceneFitRect", () => {
    it("contains, covers, fills, and applies the scene transform", () => {
        expect(sceneFitRect("contain", { width: 640, height: 480 }, { width: 1280, height: 720 })).toEqual({ width: 960, height: 720, x: 160, y: 0 });
        expect(sceneFitRect("cover", { width: 640, height: 480 }, { width: 1280, height: 720 })).toEqual({ width: 1280, height: 960, x: 0, y: -120 });
        expect(sceneFitRect("fill", { width: 640, height: 480 }, { width: 1280, height: 720 }, 0.5, 10, -10)).toEqual({ width: 640, height: 360, x: 448, y: 108 });
    });
});
