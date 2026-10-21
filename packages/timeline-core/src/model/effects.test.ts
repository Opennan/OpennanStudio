import { buildOptimisticClipEffect } from "./effects";

describe("buildOptimisticClipEffect", () => {
  it("builds an enabled, project-scoped temp effect row for a clip", () => {
    const row = buildOptimisticClipEffect("clip-1", "glitch", 2);
    expect(row).toMatchObject({ clipId: "clip-1", sceneId: null, effectId: "glitch", order: 2, paramsJson: null, enabled: true, ownerScope: "project" });
    expect(row.id.startsWith("temp-effect-")).toBe(true);
  });
});
