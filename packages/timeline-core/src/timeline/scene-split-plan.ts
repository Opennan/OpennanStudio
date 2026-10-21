// Source-clip scene split planner. Logic copied from the optimistic split in
// opennan frontend components/editor/timeline/nle-timeline.tsx:1838-1901, as a
// pure function so LocalBackend, the controller, and agents produce the same split.
import type { SceneData } from "./canvas/types";
import { getSceneDuration, getSceneStart } from "./scene-timing";
import { buildSceneTimelineTrimCardConfig, getSceneAudioUrl, getSceneTimelineTrimStart } from "./scene-helpers";

export interface SceneSplitPlan {
  sourceSceneId: string;
  tempSceneId: string;
  firstScene: Partial<SceneData>;
  secondScene: SceneData;
  splitTime: number;
}

export function planSourceClipSceneSplit(
  scenes: SceneData[],
  sceneId: string,
  atSeconds: number,
  options: { tempSceneId: string; fallbackCaption: string },
): SceneSplitPlan | null {
  const sceneIndex = scenes.findIndex((scene) => scene.id === sceneId);
  if (sceneIndex < 0) return null;
  const scene = scenes[sceneIndex];
  const sceneStart = getSceneStart(scene, scenes, sceneIndex);
  const sceneDuration = getSceneDuration(scene);
  const sceneEnd = sceneStart + sceneDuration;
  const localSplitTime = atSeconds - sceneStart;
  if (atSeconds <= sceneStart + 0.1 || atSeconds >= sceneEnd - 0.1) return null;

  const mediaUrl = scene.videoUrl || scene.sourceVideoUrl;
  if (!mediaUrl) return null;

  const trackIndex = Math.max(1, Number(scene.trackIndex || 1));
  const baseTrimStart = getSceneTimelineTrimStart(scene);
  const firstTrimEnd = baseTrimStart + localSplitTime;
  const secondTrimEnd = baseTrimStart + sceneDuration;
  const splitAudioUrl = getSceneAudioUrl(scene);

  return {
    sourceSceneId: scene.id,
    tempSceneId: options.tempSceneId,
    firstScene: {
      id: scene.id,
      cardType: "source_clip",
      sourceVideoUrl: mediaUrl,
      videoUrl: mediaUrl,
      audioUrl: splitAudioUrl,
      audioText: scene.audioText ?? null,
      duration: localSplitTime,
      shotBreakdown: "[]",
      cardConfig: buildSceneTimelineTrimCardConfig(scene, baseTrimStart, firstTrimEnd),
      timelinePositionSeconds: sceneStart,
      trackIndex,
    },
    secondScene: {
      ...scene,
      id: options.tempSceneId,
      order: scene.order + 1,
      caption: scene.caption || options.fallbackCaption,
      cardType: "source_clip",
      sourceVideoUrl: mediaUrl,
      videoUrl: mediaUrl,
      audioUrl: splitAudioUrl,
      audioText: scene.audioText ?? null,
      duration: sceneEnd - atSeconds,
      shotBreakdown: "[]",
      cardConfig: buildSceneTimelineTrimCardConfig(scene, firstTrimEnd, secondTrimEnd),
      timelinePositionSeconds: atSeconds,
      trackIndex,
    },
    splitTime: atSeconds,
  };
}
