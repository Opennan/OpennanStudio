// Story film's reel layout on the GPU export path: the film scene fitted "contain" into the 9:16 frame lands where the
// preview draws it (timeline-core's sceneFitRect): 1080 wide, about 608 tall, its top at y = 656.
import { REEL_LAYOUT, reelScenePatch } from "@opennan/timeline-core";
import { sceneFitRect } from "@opennan/timeline-core/looks/fit";
import { input, scene, info } from "../compile/test-helpers";
import type { MediaInfo } from "../types";
import { planGpuExport, type DrawOp, type LaneOp } from "./plan";

const FORMAT = { width: 1080, height: 1920, fps: 30, aspectRatio: 9 / 16, refWidth: 1080, refHeight: 1920, frameScale: 1 };
const MEDIA = new Map<string, MediaInfo>([["/m/s01.webm", info({ width: 1280, height: 720, durationSeconds: 5 })]]);
const lanes = (ops: DrawOp[]) => ops.filter((op): op is LaneOp => op.kind === "lane");

describe("reel layout on the GPU export path", () => {
    it("places the film as the preview does", () => {
        const patch = reelScenePatch({ mediaUrl: "/m/s01.webm", durationSeconds: 5, width: 1280, height: 720 });
        const timeline = input({ project: { aspectRatio: "9:16", musicUrl: null, musicVolume: 1 }, scenes: [scene("s01", 0, 5, { ...patch })] });
        const plan = planGpuExport(timeline, FORMAT, { media: MEDIA, rasters: new Map(), gl: false });
        const place = lanes(plan.drawList(10))[0]!.a!.place;
        const preview = sceneFitRect("contain", { width: 1280, height: 720 }, { width: 1080, height: 1920 }, 1, 0, Number(patch.transformOffsetY));
        expect(place.width).toBe(1080);
        expect(Math.abs(place.height - preview.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(place.cy - place.height / 2 - REEL_LAYOUT.film.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(place.cy - (preview.y + preview.height / 2))).toBeLessThanOrEqual(1);
    });
});
