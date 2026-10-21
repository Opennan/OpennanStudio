// Scene -> engine item adapter. Copied from opennan frontend
// components/editor/timeline/canvas/canvas-timeline.tsx:204-215 (it uses the
// renderer's scene timing, as canvas-timeline.tsx:10 does).
import type { SceneData } from "../canvas/types";
import type { EngineItem } from "./types";
import { getSceneDuration, getSceneStart } from "../canvas/timeline-renderer";

// Maps scenes to the engine's track-agnostic item shape so scene drags can be
// resolved through the shared free-placement + push-right algorithm
// (resolveMove) instead of bespoke constrain/ripple math.
export function scenesToEngineItems(scenes: SceneData[]): EngineItem[] {
  return scenes.map((s, i) => ({
    id: s.id,
    trackId: `v${Number(s.trackIndex || 1)}`,
    start: getSceneStart(s, scenes, i),
    duration: getSceneDuration(s),
    kind: "scene" as const,
  }));
}
