import { describe, expect, it } from "vitest";
import type { SceneData } from "../timeline/canvas/types";
import { clampJunctionDuration, sceneJunctions } from "./scene-transitions";

const scene = (id: string, start: number, duration: number, trackIndex = 1): SceneData => ({
    id, order: 0, caption: "", startTime: "00:00:00.000", endTime: "00:00:00.000", timelinePositionSeconds: start, trackIndex,
    startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready", transition: "", frameConsistencyScore: null,
    audioUrl: null, audioText: null, cardConfig: null, duration,
} as SceneData);

describe("sceneJunctions", () => {
    it("finds touching scenes on the same track and their longest transition", () => {
        const junctions = sceneJunctions([scene("a", 0.001, 4), scene("b", 4.001, 1.5), scene("c", 6, 3), scene("d", 4.02, 2, 2), scene("e", 6.03, 3, 2)]);
        expect(junctions.map((j) => `${j.sceneId}>${j.nextSceneId}`)).toEqual(["a>b", "d>e"]);
        expect(junctions[0].maxDuration).toBe(1.5);
        expect(junctions[0].cut).toBeCloseTo(4.001, 6);
    });

    it("marks cuts on locked tracks as not editable", () => {
        const [j] = sceneJunctions([scene("a", 0.001, 2), scene("b", 2.001, 2)], [{ type: "video", index: 1, label: "V1", muted: false, locked: true, visible: true, volume: 1 }]);
        expect(j.editable).toBe(false);
    });

    it("clamps durations to the cut", () => {
        expect(clampJunctionDuration({ maxDuration: 1.5 }, 3)).toBe(1.5);
        expect(clampJunctionDuration({ maxDuration: 1.5 }, 0.01)).toBe(0.1);
        expect(clampJunctionDuration({ maxDuration: 0.05 }, 0.5)).toBe(0.05);
    });
});
