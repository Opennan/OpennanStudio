import type { SceneData } from "./canvas/types";
import type { TimelineTrack } from "../model/timeline";
import {
  buildSceneTimelineTrimCardConfig,
  defaultTracks,
  getEditableSceneTransitionTarget,
  getSceneAudioUrl,
  getSceneContentDuration,
  getSceneTimelineTrimStart,
  isContentBackedScene,
  stripVoiceoverLayersFromCardConfig,
  withRequiredBaseTimelineTracks,
  withSceneVideoTracks,
} from "./scene-helpers";
import { scenesToEngineItems } from "./engine/scene-items";

function scene(partial: Partial<SceneData>): SceneData {
  return {
    id: "s1", order: 0, caption: "", startTime: "00:00:00", endTime: "00:00:05",
    startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready",
    transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
    cardConfig: null, ...partial,
  };
}

describe("scene helpers", () => {
  it("reads trim start and builds trim card configs", () => {
    expect(getSceneTimelineTrimStart(scene({ cardConfig: JSON.stringify({ timelineTrimStart: 2 }) }))).toBe(2);
    expect(JSON.parse(buildSceneTimelineTrimCardConfig(scene({ cardConfig: '{"a":1}' }), -1, 3))).toEqual({ a: 1, timelineTrimStart: 0, timelineTrimEnd: 3 });
  });

  it("finds extracted or voiceover audio in card config layers", () => {
    const s = scene({ cardConfig: JSON.stringify({ audio_layers: [{ type: "music", url: "m" }, { type: "extracted", url: "x" }] }) });
    expect(getSceneAudioUrl(s)).toBe("x");
    expect(JSON.parse(stripVoiceoverLayersFromCardConfig(s.cardConfig)!).audio_layers).toEqual([{ type: "music", url: "m" }]);
  });

  it("classifies content-backed scenes and reports unknown content as Infinity", () => {
    expect(isContentBackedScene(scene({ cardType: "source_clip" }))).toBe(true);
    expect(isContentBackedScene(scene({ cardType: "ai_video" }))).toBe(false);
    expect(getSceneContentDuration(scene({}))).toBe(Number.POSITIVE_INFINITY);
    expect(getSceneContentDuration(scene({ videoUrl: "v", duration: 7 }))).toBe(7);
  });

  it("repairs base tracks and adds missing video lanes", () => {
    expect(withRequiredBaseTimelineTracks([]).tracks).toEqual(defaultTracks);
    const tracks = withSceneVideoTracks(defaultTracks, [scene({ trackIndex: 3 })]);
    expect(tracks.filter((t: TimelineTrack) => t.type === "video").map((t) => t.index).sort()).toEqual([1, 2, 3]);
  });

  it("finds an editable transition target only at an adjacent cut", () => {
    const scenes = [scene({ id: "a", duration: 5 }), scene({ id: "b", duration: 5 })];
    expect(getEditableSceneTransitionTarget(scenes, defaultTracks, "a")?.scene.id).toBe("a");
    expect(getEditableSceneTransitionTarget(scenes, defaultTracks, "b")).toBeNull();
  });

  it("maps scenes to engine items on v<track>", () => {
    expect(scenesToEngineItems([scene({ id: "a", duration: 4, trackIndex: 2 })])).toEqual([
      { id: "a", trackId: "v2", start: 0, duration: 4, kind: "scene" },
    ]);
  });
});
