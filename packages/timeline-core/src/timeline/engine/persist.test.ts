import { describe, it, expect } from "vitest";
import { buildScenePositionWrites } from "./persist";

describe("buildScenePositionWrites", () => {
    it("emits one write per changed scene, mapping vN → trackIndex N, skipping clips", () => {
        const changes = new Map([
            ["scene-1", { start: 4.25, trackId: "v1" }],
            ["scene-2", { start: 10, trackId: "v2" }],
            ["clip-1", { start: 3, trackId: "text1" }],
        ]);
        const writes = buildScenePositionWrites(changes, new Set(["scene-1", "scene-2"]));
        expect(writes).toEqual([
            { sceneId: "scene-1", timelinePositionSeconds: 4.25, trackIndex: 1 },
            { sceneId: "scene-2", timelinePositionSeconds: 10, trackIndex: 2 },
        ]);
    });
});
