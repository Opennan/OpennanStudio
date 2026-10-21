import { asCreateClipInput, isLocalCommand } from "./commands";
import { emptyPatch, patchClipIds, patchSceneIds } from "./patch";
import { DEFAULT_COMMAND_ERROR_MESSAGES } from "./messages";

describe("command helpers", () => {
  it("validates create inputs", () => {
    expect(asCreateClipInput({ startTime: "1", endTime: 2, trackType: "text" })).toEqual({ startTime: 1, endTime: 2, trackType: "text" });
    expect(() => asCreateClipInput({ trackType: "text" })).toThrow("numeric startTime and endTime");
  });

  it("classifies store-only commands", () => {
    expect(isLocalCommand({ type: "playhead.seek", seconds: 1 })).toBe(true);
    expect(isLocalCommand({ type: "clip.delete", clipIds: ["a"] })).toBe(false);
  });

  it("collects ids touched by a patch", () => {
    const patch = { ...emptyPatch(), clipsRemove: ["c1"], scenePositions: [{ sceneId: "s1", timelinePositionSeconds: 2 }], scenesRemove: ["s2"] };
    expect([...patchClipIds(patch)]).toEqual(["c1"]);
    expect([...patchSceneIds(patch)].sort()).toEqual(["s1", "s2"]);
  });

  it("uses the source English failure strings", () => {
    expect(DEFAULT_COMMAND_ERROR_MESSAGES["clip.create"]).toBe("Failed to create clip");
    expect(DEFAULT_COMMAND_ERROR_MESSAGES["scene.split"]).toBe("Failed to cut scene.");
  });
});
