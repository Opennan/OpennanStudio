// INVARIANTS: see ../TIMELINE_RULES.md before changing these semantics.
// Shared scene timeline-position helpers for canvas render, hit-test, and snap logic.

export interface ScenePositionLike {
  trackIndex?: number | null;
  timelinePositionSeconds?: number | null;
}

export function getSceneTrackIndex(scene: ScenePositionLike): number {
  const trackIndex = Number(scene.trackIndex ?? 1);
  return Number.isFinite(trackIndex) && trackIndex > 0 ? trackIndex : 1;
}

export function hasExplicitSceneTimelinePositions(scenes: readonly ScenePositionLike[]): boolean {
  return scenes.some((scene) => Number(scene.timelinePositionSeconds ?? 0) > 0);
}

function explicitSceneStart(scene: ScenePositionLike): number | null {
  const position = Number(scene.timelinePositionSeconds ?? 0);
  return Number.isFinite(position) && position > 0 ? position : null;
}

export function getSceneTimelineStart<T extends ScenePositionLike>(
  scene: T,
  scenes: readonly T[],
  index: number,
  getDuration: (scene: T) => number,
): number {
  // ONE layout rule for every project state: walk the scenes on this scene's
  // track in array order carrying a cursor. A scene with an explicit saved
  // position (> 0) sits exactly there; a scene without one is auto-placed at
  // the cursor (after the previous scene's end). The old dual-mode logic
  // ("if ANY scene has a position, use raw positions for ALL") collapsed
  // every unpositioned scene to 0 the moment one scene was dragged — stacking
  // clips on top of each other and re-laying-out differently after refresh.
  const trackIndex = getSceneTrackIndex(scene);
  let cursor = 0;
  for (let i = 0; i < index; i++) {
    const previous = scenes[i];
    if (getSceneTrackIndex(previous) !== trackIndex) continue;
    const previousStart = explicitSceneStart(previous) ?? cursor;
    cursor = Math.max(cursor, previousStart + getDuration(previous));
  }
  return explicitSceneStart(scene) ?? cursor;
}

export function getSceneTimelineStartAt<T extends ScenePositionLike>(
  scenes: readonly T[],
  index: number,
  getDuration: (scene: T) => number,
): number {
  const scene = scenes[index];
  return scene ? getSceneTimelineStart(scene, scenes, index, getDuration) : 0;
}
