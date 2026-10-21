import { describe, expect, it } from "vitest";
import type { SceneData } from "./canvas/types";
import { sceneSourceSeconds, sceneSpeedFactor, sceneTimelineSeconds } from "./scene-duration";
import { getSceneDuration } from "./scene-timing";

const base = { id: "s", order: 0, caption: "", startTime: "00:00:00,000", endTime: "00:00:04,000", startImageUrl: null, endImageUrl: null, videoUrl: null, status: "done", transition: "", frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null } as SceneData;

describe("scene speed and duration", () => {
    it("is identity without speed fields", () => {
        expect(sceneSpeedFactor(base)).toBe(1);
        expect(sceneTimelineSeconds(base, 4)).toBe(4);
        expect(getSceneDuration({ ...base, duration: 4 })).toBe(4);
    });

    it("divides the source span by the constant speed", () => {
        const fast = { ...base, duration: 4, playbackSpeed: 2 };
        expect(sceneSpeedFactor(fast)).toBe(2);
        expect(getSceneDuration(fast)).toBe(2);
        expect(sceneSourceSeconds(fast, 1)).toBe(2);
        const trimmed = { ...base, playbackSpeed: 0.5, cardConfig: JSON.stringify({ timelineTrimStart: 1, timelineTrimEnd: 3 }) };
        expect(getSceneDuration(trimmed)).toBe(4);
    });

    it("uses the curve's mean speed", () => {
        const curved = { ...base, duration: 6, speedCurveJson: JSON.stringify({ id: "custom", points: [[0, 1], [1, 3]] }) };
        expect(sceneSpeedFactor(curved)).toBeCloseTo(2, 9);
        expect(getSceneDuration(curved)).toBeCloseTo(3, 9);
    });
});
