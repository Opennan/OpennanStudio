// The Storyboards board's reading of a scene (phase 9c): its sheets (sheet image, then panels) when OpenNan drew them,
// else the panels of its shots (9b), in viewing order.
import type { SceneData } from "@opennan/timeline-core";
import { boardImages, scenePanels } from "./storyboard-board";

const base = { id: "s", order: 0, caption: "", startTime: "", endTime: "", startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null } as SceneData;

describe("Storyboards board", () => {
    it("reads the sheets first: the sheet image, then its panels", () => {
        const scene = { ...base, storyboardSheets: [{ imageUrl: "/sheet.png", panels: [{ index: 0, shotIndex: 0, imageUrl: "/p0.png" }, { index: 1, shotIndex: 1, imageUrl: "/p1.png" }] }] };
        expect(boardImages(scene).map((i) => [i.kind, i.url])).toEqual([["sheet", "/sheet.png"], ["panel", "/p0.png"], ["panel", "/p1.png"]]);
        expect(scenePanels(scene)).toEqual(["/p0.png", "/p1.png"]);
    });

    it("falls back to the shots' panels (9b) and to nothing", () => {
        const scene = { ...base, shotBreakdown: JSON.stringify([{ keyframe_url: "/k.png", readOnly: true }]) };
        expect(boardImages(scene).map((i) => i.kind)).toEqual(["panel"]);
        expect(scenePanels(base)).toEqual([]);
    });
});
