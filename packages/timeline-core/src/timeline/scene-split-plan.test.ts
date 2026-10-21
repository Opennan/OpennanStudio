import type { SceneData } from "./canvas/types";
import { planSourceClipSceneSplit } from "./scene-split-plan";

function scene(partial: Partial<SceneData>): SceneData {
  return {
    id: "s1", order: 0, caption: "Shot", startTime: "00:00:00", endTime: "00:00:06",
    startImageUrl: null, endImageUrl: null, videoUrl: "https://cdn.test/a.mp4", status: "ready",
    transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
    cardConfig: null, duration: 6, timelinePositionSeconds: 10, trackIndex: 1, ...partial,
  };
}

describe("planSourceClipSceneSplit", () => {
  it("plans two source-clip scenes trimmed at the split time", () => {
    const plan = planSourceClipSceneSplit([scene({})], "s1", 12, { tempSceneId: "tmp", fallbackCaption: "Clip" })!;
    expect(plan.firstScene).toMatchObject({ id: "s1", cardType: "source_clip", duration: 2, shotBreakdown: "[]", timelinePositionSeconds: 10 });
    expect(JSON.parse(plan.firstScene.cardConfig as string)).toEqual({ timelineTrimStart: 0, timelineTrimEnd: 2 });
    expect(plan.secondScene).toMatchObject({ id: "tmp", order: 1, duration: 4, timelinePositionSeconds: 12, caption: "Shot" });
    expect(JSON.parse(plan.secondScene.cardConfig as string)).toEqual({ timelineTrimStart: 2, timelineTrimEnd: 6 });
    expect(plan.splitTime).toBe(12);
  });

  it("returns null within 0.1 s of an edge or without media", () => {
    expect(planSourceClipSceneSplit([scene({})], "s1", 10.05, { tempSceneId: "t", fallbackCaption: "" })).toBeNull();
    expect(planSourceClipSceneSplit([scene({ videoUrl: null, sourceVideoUrl: null })], "s1", 12, { tempSceneId: "t", fallbackCaption: "" })).toBeNull();
  });
});
