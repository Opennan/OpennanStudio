import { getSceneDuration, getSceneStart, parseSceneCardConfig } from "./scene-timing";
import type { SceneData } from "./canvas/types";

function scene(partial: Partial<SceneData>): SceneData {
    return {
        id: "s1", order: 0, caption: "", startTime: "00:00:00", endTime: "00:00:05",
        startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready",
        transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: null,
        ...partial,
    };
}

describe("parseSceneCardConfig", () => {
    it("returns {} for null, invalid JSON, and arrays", () => {
        expect(parseSceneCardConfig({ cardConfig: null })).toEqual({});
        expect(parseSceneCardConfig({ cardConfig: "{bad" })).toEqual({});
        expect(parseSceneCardConfig({ cardConfig: "[1]" })).toEqual({});
    });
});

describe("getSceneDuration", () => {
    it("prefers timeline trim range", () => {
        const s = scene({ cardConfig: JSON.stringify({ timelineTrimStart: 1, timelineTrimEnd: 3.5 }) });
        expect(getSceneDuration(s)).toBe(2.5);
    });
    it("uses explicit duration when there are no shots", () => {
        expect(getSceneDuration(scene({ duration: 7 }))).toBe(7);
    });
    it("falls back to endTime - startTime, then 5", () => {
        expect(getSceneDuration(scene({ startTime: "00:00:01", endTime: "00:00:04" }))).toBe(3);
        expect(getSceneDuration(scene({ startTime: "x", endTime: "x" }))).toBe(5);
    });
});

describe("getSceneStart", () => {
    it("lays scenes end to end when unpositioned", () => {
        const scenes = [scene({ id: "a", duration: 4 }), scene({ id: "b", duration: 2 })];
        expect(getSceneStart(scenes[1], scenes, 1)).toBe(4);
    });
    it("uses timelinePositionSeconds when set", () => {
        const scenes = [scene({ id: "a", duration: 4, timelinePositionSeconds: 10 })];
        expect(getSceneStart(scenes[0], scenes, 0)).toBe(10);
    });
});
