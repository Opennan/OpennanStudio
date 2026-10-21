// Text state atlases and bundled stickers in the compiled graph (phase 10b).
import { textStatePlan } from "@opennan/timeline-core/text/text-states";
import type { RasterResult } from "../types";
import { atlasCropFilter } from "../motion/text-atlas";
import { stickerJobId } from "../raster/jobs";
import { collectMediaUrls, compileExport, staticExportWarnings } from "./index";
import { clip, input, scene } from "./test-helpers";

const typewriter = JSON.stringify({ in: { id: "typewriter", duration: 1 } });
const textClip = (patch: Record<string, unknown> = {}) =>
    clip("t", { trackType: "text", trackIndex: 1, textContent: "Hello", startTime: 0.5, endTime: 2.5, animationJson: typewriter, ...patch });
const SCENES = [scene("a", 0, 3, { cardType: "image", sourceVideoUrl: null, startImageUrl: "/m/a.png" })];
const MEDIA = new Map([["/m/a.png", { durationSeconds: 0, hasVideo: true, hasAudio: false, width: 1280, height: 720 }]]);

// 6 states ("Hello" typewriter): a 3 × 2 grid of 64 × 40 cells around a 44 × 20 box (pad 10).
const atlasRaster: RasterResult = {
    id: "text-t", png: new Uint8Array([1]), width: 192, height: 80, boxWidth: 44, boxHeight: 20, pad: 10, scale: 1,
    atlas: { cols: 3, rows: 2, cellWidth: 64, cellHeight: 40, count: 6 },
};

const compile = (clips: ReturnType<typeof clip>[], rasters: RasterResult[]) =>
    compileExport(input({ scenes: SCENES, clips }), { resolution: "720p" }, { media: MEDIA, rasters: new Map(rasters.map((r) => [r.id, r])), gl: false });

describe("compileExport: text state atlases", () => {
    it("crops the state's cell right after the time filters and places the cell-size bitmap", () => {
        const text = textClip();
        const plan = compile([text], [atlasRaster]);
        const crop = atlasCropFilter(textStatePlan(text), atlasRaster.atlas!);
        expect(plan.filterGraph).toContain(`setpts=PTS-STARTPTS,fps=30,trim=duration=2.000,${crop}[`);
        // The atlas PNG is looped like any bitmap; the cell is 64 × 40 at scale 1 (no rescale).
        expect(plan.inputs.find((i) => i.kind === "file")?.options).toEqual(["-loop", "1", "-framerate", "30", "-t", "2.000"]);
        expect(plan.filterGraph).not.toMatch(/crop=w=64:h=40[^;]*scale=/);
        // Centered on the 1280 × 720 frame: the 64 × 40 cell around the box center (640, 360).
        expect(plan.filterGraph).toContain("overlay=x=608:y=340:");
        expect(plan.warnings).toEqual([]);
    });

    it("scales a shrunk cell back to the unshrunk padded box", () => {
        const shrunk: RasterResult = { ...atlasRaster, width: 96, height: 40, atlas: { cols: 3, rows: 2, cellWidth: 32, cellHeight: 20, count: 6 } };
        const plan = compile([textClip()], [shrunk]);
        expect(plan.filterGraph).toMatch(/crop=w=32:h=20:x='[^']+':y='[^']+':exact=1,scale=64:40/);
    });

    it("draws a raster without an atlas as the static bitmap (an older rasterizer)", () => {
        const { atlas: _atlas, ...single } = atlasRaster;
        const plan = compile([textClip()], [{ ...single, width: 64, height: 40 }]);
        expect(plan.filterGraph).not.toContain("crop=w=");
        expect(plan.warnings).toEqual([]);
    });

    it("leaves the clip out when the atlas does not match the clip's states or the PNG", () => {
        for (const atlas of [{ ...atlasRaster.atlas!, count: 5 }, { ...atlasRaster.atlas!, cellWidth: 65 }, { ...atlasRaster.atlas!, cols: "3:x=0" as unknown as number }]) {
            const plan = compile([textClip()], [{ ...atlasRaster, atlas }]);
            expect(plan.filterGraph).not.toContain("crop=w=");
            expect(plan.inputs.some((i) => i.kind === "file")).toBe(false);
            expect(plan.warnings.map((w) => [w.code, w.clipId])).toEqual([["text-unsupported", "t"]]);
        }
    });

    it("keeps static text byte-identical (no crop)", () => {
        const plan = compile([textClip({ animationJson: null })], [{ ...atlasRaster, atlas: undefined, width: 64, height: 40 }]);
        expect(plan.filterGraph).not.toContain("crop=");
    });
});

describe("compileExport: bundled stickers", () => {
    const sticker = (patch: Record<string, unknown> = {}) =>
        clip("s", { trackType: "sticker", trackIndex: 1, stickerId: "opennan:arrow-right", startTime: 0, endTime: 2, scale: 0.5, ...patch });
    // 720p: the 240 × 140 reference box is 160 × 93.33 px at scale 1, 80 × 46.67 at 0.5.
    const raster = (patch: Partial<RasterResult> = {}): RasterResult => ({
        id: stickerJobId("s"), png: new Uint8Array([2]), width: 80, height: 47, boxWidth: 80, boxHeight: 47, pad: 0, scale: 0.5, ...patch,
    });

    it("places the sticker bitmap with the sticker box like an emoji sticker", () => {
        const plan = compile([sticker()], [raster()]);
        expect(plan.inputs.filter((i) => i.kind === "file")).toHaveLength(1);
        expect(plan.files.map((f) => f.data)).toEqual([new Uint8Array([2])]);
        // Centered: x = 0.5 × (1280 − 80) = 600, y = 0.5 × (720 − 46.67) − 0.17 ≈ 337.
        expect(plan.filterGraph).toContain("overlay=x=600:y=337:");
        expect(plan.filterGraph).not.toMatch(/\[1:v\][^;]*scale=/);
        expect(plan.warnings).toEqual([]);
    });

    it("scales a capped bitmap up to the sticker box", () => {
        const plan = compile([sticker({ scale: 20 })], [raster({ width: 2048, height: 1195, boxWidth: 2048, boxHeight: 1195, scale: 20 })]);
        expect(plan.filterGraph).toContain("scale=3200:1867");
    });

    it("is not media: nothing to probe and no media warnings, even with a stray mediaUrl-less emoji text", () => {
        const doc = input({ scenes: SCENES, clips: [sticker({ textContent: "→" })] });
        expect(collectMediaUrls(doc)).toEqual(["/m/a.png"]);
        expect(staticExportWarnings(doc, { gl: false })).toEqual([]);
        const plan = compile([sticker({ textContent: "→" })], [raster()]);
        expect(plan.inputs.map((i) => i.kind)).toEqual(["media", "file"]);
        expect(plan.files).toHaveLength(1);
    });

    it("warns when the host could not draw it, and leaves unknown sticker ids out with media-missing", () => {
        expect(compile([sticker()], []).warnings.map((w) => [w.code, w.clipId])).toEqual([["text-unsupported", "s"]]);
        const unknown = input({ scenes: SCENES, clips: [sticker({ stickerId: "opennan:nope" })] });
        expect(staticExportWarnings(unknown, { gl: false }).map((w) => [w.code, w.clipId])).toEqual([["media-missing", "s"]]);
        expect(collectMediaUrls(unknown)).toEqual(["/m/a.png"]);
    });
});
