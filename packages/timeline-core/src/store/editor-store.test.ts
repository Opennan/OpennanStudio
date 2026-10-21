import type { SceneData } from "../timeline/canvas/types";
import { createEditorStore } from "./editor-store";
import { selectLiveScenes } from "./live-scenes";
import { snapshotAttributes } from "../attributes/attributes";

function scene(id: string, partial: Partial<SceneData> = {}): SceneData {
  return {
    id, order: 0, caption: id, startTime: "00:00:00", endTime: "00:00:05",
    startImageUrl: null, endImageUrl: null, videoUrl: null, status: "ready",
    transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null,
    cardConfig: null, duration: 5, trackIndex: 1, ...partial,
  };
}

describe("createEditorStore", () => {
  it("creates independent stores", () => {
    const a = createEditorStore();
    const b = createEditorStore();
    a.getState().selectClip("c1");
    expect(b.getState().selectedClipId).toBeNull();
  });

  it("keeps selection exclusive and never writes panel tabs", () => {
    const store = createEditorStore();
    store.getState().selectScene("s1");
    store.getState().selectClip("c1");
    const state = store.getState();
    expect(state.selectedSceneId).toBeNull();
    expect([...state.selectedClipIds]).toEqual(["c1"]);
    expect("leftPanelTab" in state).toBe(false);
    expect("rightPanelTab" in state).toBe(false);
  });

  it("playhead follow does not steal an existing selection", () => {
    const store = createEditorStore();
    store.getState().selectClip("c1");
    store.getState().syncActiveScene("s2");
    expect(store.getState().selectedSceneId).toBeNull();
    store.getState().clearSelection();
    store.getState().syncActiveScene("s2");
    expect(store.getState().selectedSceneId).toBe("s2");
  });

  it("numbers markers with the next free label and replaces In/Out", () => {
    const store = createEditorStore();
    const s = () => store.getState();
    s().addTimelineMarker(1);
    s().addTimelineMarker(2);
    s().removeTimelineMarker(s().timelineMarkers[0].id);
    s().addTimelineMarker(3);
    expect(s().timelineMarkers.map((m) => m.label)).toEqual(["M2", "M3"]);
    s().addTimelineMarker(5, "In");
    s().addTimelineMarker(6, "In");
    expect(s().timelineMarkers.filter((m) => m.label === "In").map((m) => m.time)).toEqual([6]);
  });

  it("never lets active saves go negative and ignores bad source durations", () => {
    const store = createEditorStore();
    store.getState().endTimelineSave();
    expect(store.getState().activeTimelineSaves).toBe(0);
    store.getState().setSourceDuration("c1", -1);
    expect(store.getState().sourceDurations.size).toBe(0);
  });

  it("drops local scene patches that already match the server", () => {
    const store = createEditorStore();
    store.getState().replaceServerScenes([scene("s1", { caption: "a" })]);
    store.getState().applyLocalScenePatch("s1", { caption: "a", duration: 7 });
    expect(store.getState().sceneFieldOverrides.get("s1")).toEqual({ duration: 7 });
  });

  it("converges overrides when the server catches up", () => {
    const store = createEditorStore();
    store.getState().replaceServerScenes([scene("s1")]);
    store.getState().applySceneOverrides(new Map([["s1", 12]]), "s1", 2);
    store.getState().mergeServerScenes([scene("s1", { timelinePositionSeconds: 12.01, trackIndex: 2 })]);
    expect(store.getState().scenePositionOverrides.size).toBe(0);
    expect(store.getState().sceneTrackOverrides.size).toBe(0);
  });

  it("keeps unconverged overrides when server scenes are re-synced", () => {
    const store = createEditorStore();
    store.getState().replaceServerScenes([scene("s1")]);
    store.getState().applySceneOverrides(new Map([["s1", 9]]));
    store.getState().syncServerScenes([scene("s1", { timelinePositionSeconds: 2 })]);
    expect(store.getState().scenePositionOverrides.get("s1")).toBe(9);
  });

  it("derives live scenes: overrides applied, deleted hidden, optimistic inserted by start", () => {
    const store = createEditorStore();
    const s = () => store.getState();
    s().replaceServerScenes([scene("a", { timelinePositionSeconds: 0.001 }), scene("b", { timelinePositionSeconds: 5 })]);
    s().applyOptimisticSceneAdd(scene("tmp", { timelinePositionSeconds: 2 }));
    s().applyOptimisticSceneDelete("b");
    expect(selectLiveScenes(s()).map((x) => x.id)).toEqual(["a", "tmp"]);
    expect(selectLiveScenes(s())).toBe(selectLiveScenes(s()));
    s().applyOptimisticSceneDelete("b", true);
    expect(selectLiveScenes(s()).map((x) => x.id)).toEqual(["a", "tmp", "b"]);
  });

  it("commits and rolls back optimistic scene splits", () => {
    const store = createEditorStore();
    const s = () => store.getState();
    s().replaceServerScenes([scene("s1")]);
    s().applyOptimisticSceneSplit({ sourceSceneId: "s1", tempSceneId: "tmp", firstScene: { duration: 2 }, secondScene: scene("tmp"), splitTime: 2 });
    expect(s().selectedSceneId).toBe("tmp");
    expect(s().seekRequest).toBe(2);
    s().commitOptimisticSceneSplit("tmp", "s2");
    expect(s().optimisticScenes.has("s2")).toBe(true);
    expect(s().selectedSceneId).toBe("s2");
    s().rollbackOptimisticSceneSplit("s1", "s2");
    expect(s().optimisticScenes.size).toBe(0);
    expect(s().sceneFieldOverrides.size).toBe(0);
  });

  it("captures and restores scene overrides for a set of ids", () => {
    const store = createEditorStore();
    const capture = store.getState().captureSceneOverrides(["s1"]);
    store.getState().applyLocalScenePatch("s1", { duration: 9 });
    store.getState().applyOptimisticSceneDelete("s1");
    store.getState().restoreSceneOverrides(capture);
    expect(store.getState().sceneFieldOverrides.has("s1")).toBe(false);
    expect(store.getState().deletedSceneIds.has("s1")).toBe(false);
  });

  it("holds an attribute clipboard and the paste picker's targets until the project changes", () => {
    const store = createEditorStore();
    const s = () => store.getState();
    expect(s().attributeClipboard).toBeNull();
    expect(s().attributePastePicker).toBeNull();
    const snapshot = snapshotAttributes({ kind: "scene", scene: scene("s1", { visualFilter: "warm" }) });
    s().setAttributeClipboard(snapshot);
    expect(s().attributeClipboard).toBe(snapshot);
    s().setAttributePastePicker({ targets: [{ clipId: "c1" }] });
    expect(s().attributePastePicker).toEqual({ targets: [{ clipId: "c1" }] });
    // Selection changes keep the clipboard (copy, select another item, paste).
    s().selectClip("c2");
    expect(s().attributeClipboard).toBe(snapshot);
    s().resetForProject();
    expect(s().attributeClipboard).toBeNull();
    expect(s().attributePastePicker).toBeNull();
  });

  it("supports selector subscriptions", () => {
    const store = createEditorStore();
    const seen: number[] = [];
    store.subscribe((state) => state.currentTime, (time) => seen.push(time));
    store.getState().setCurrentTime(3);
    store.getState().setCurrentTime(3);
    expect(seen).toEqual([3]);
  });
});

describe("mask editing flag (phase 10c)", () => {
  it("is off by default and toggles without needless updates", () => {
    const store = createEditorStore();
    expect(store.getState().maskEditing).toBe(false);
    const before = store.getState();
    store.getState().setMaskEditing(false);
    expect(store.getState()).toBe(before);
    store.getState().setMaskEditing(true);
    expect(store.getState().maskEditing).toBe(true);
  });
});
