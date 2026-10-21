// Multi-item selection (phase 10c): clips and scenes selected together, with a primary item for single-item UI.
import { createEditorStore } from "./editor-store";

describe("multi-item selection", () => {
  it("selects clips and scenes together; the primary clip wins and no primary scene is set", () => {
    const store = createEditorStore();
    store.getState().setSelection({ clipIds: ["c1", "c2"], sceneIds: ["s1"] });
    const s = store.getState();
    expect([...s.selectedClipIds]).toEqual(["c1", "c2"]);
    expect([...s.selectedSceneIds]).toEqual(["s1"]);
    expect(s.selectedClipId).toBe("c1");
    expect(s.selectedSceneId).toBeNull();
    expect(s.sceneSelectedByUser).toBe(true);
  });

  it("scenes only: the first scene is the primary scene", () => {
    const store = createEditorStore();
    store.getState().setSelection({ sceneIds: ["s2", "s1"] });
    const s = store.getState();
    expect(s.selectedSceneId).toBe("s2");
    expect(s.selectedClipId).toBeNull();
    expect([...s.selectedSceneIds]).toEqual(["s2", "s1"]);
    expect(s.selectedClipIds.size).toBe(0);
  });

  it("an empty selection clears everything, transitions and audio targets too", () => {
    const store = createEditorStore();
    store.getState().selectTransition({ kind: "scene", id: "s1" });
    store.getState().setSelection({ clipIds: [], sceneIds: [] });
    const s = store.getState();
    expect(s.selectedTransition).toBeNull();
    expect(s.selectedSceneId).toBeNull();
    expect(s.selectedSceneIds.size).toBe(0);
  });

  it("toggles clips and scenes in and out of the selection", () => {
    const store = createEditorStore();
    store.getState().selectClip("c1");
    store.getState().toggleItemInSelection({ sceneId: "s1" });
    expect([...store.getState().selectedSceneIds]).toEqual(["s1"]);
    expect([...store.getState().selectedClipIds]).toEqual(["c1"]);
    store.getState().toggleItemInSelection({ clipId: "c1" });
    expect(store.getState().selectedClipIds.size).toBe(0);
    expect(store.getState().selectedSceneId).toBe("s1");
    store.getState().toggleItemInSelection({ sceneId: "s1" });
    expect(store.getState().selectedSceneIds.size).toBe(0);
    expect(store.getState().selectedSceneId).toBeNull();
  });

  it("single-select actions keep their meaning and reset the scene set", () => {
    const store = createEditorStore();
    store.getState().setSelection({ clipIds: ["c1"], sceneIds: ["s1", "s2"] });
    store.getState().selectScene("s3");
    expect([...store.getState().selectedSceneIds]).toEqual(["s3"]);
    expect(store.getState().selectedClipIds.size).toBe(0);
    store.getState().setSelectedClipIds(new Set(["c2"]));
    expect(store.getState().selectedSceneIds.size).toBe(0);
    store.getState().setSelection({ sceneIds: ["s1"] });
    store.getState().selectClip("c3");
    expect(store.getState().selectedSceneIds.size).toBe(0);
    store.getState().setSelection({ sceneIds: ["s1"] });
    store.getState().clearSelection();
    expect(store.getState().selectedSceneIds.size).toBe(0);
    store.getState().setSelection({ sceneIds: ["s1"] });
    store.getState().selectTransition({ kind: "clip", id: "c1" });
    expect(store.getState().selectedSceneIds.size).toBe(0);
    store.getState().setSelection({ sceneIds: ["s1"] });
    store.getState().setSelectedSceneId(null);
    expect(store.getState().selectedSceneIds.size).toBe(0);
  });

  it("a scene synced to the playhead is not part of the user selection", () => {
    const store = createEditorStore();
    store.getState().syncActiveScene("s1");
    expect(store.getState().selectedSceneId).toBe("s1");
    expect(store.getState().selectedSceneIds.size).toBe(0);
  });

  it("setSelectedSceneIds replaces the scenes and keeps the clips", () => {
    const store = createEditorStore();
    store.getState().selectClip("c1");
    store.getState().setSelectedSceneIds(new Set(["s1"]));
    expect([...store.getState().selectedClipIds]).toEqual(["c1"]);
    expect([...store.getState().selectedSceneIds]).toEqual(["s1"]);
    expect(store.getState().selectedClipId).toBe("c1");
    store.getState().setSelectedSceneIds(new Set());
    expect([...store.getState().selectedClipIds]).toEqual(["c1"]);
    expect(store.getState().selectedSceneIds.size).toBe(0);
  });

  it("setSelectedSceneIds with the same scenes keeps a transition pick", () => {
    const store = createEditorStore();
    store.getState().selectTransition({ kind: "scene", id: "s1" });
    store.getState().setSelectedSceneIds(new Set());
    expect(store.getState().selectedTransition).toEqual({ kind: "scene", id: "s1" });
  });

  it("keeps the state object when nothing changes", () => {
    const store = createEditorStore();
    store.getState().setSelection({ clipIds: ["c1"], sceneIds: ["s1"] });
    const before = store.getState();
    store.getState().setSelection({ clipIds: ["c1"], sceneIds: ["s1"] });
    expect(store.getState()).toBe(before);
  });

  it("a keyframe can only be selected for one item", () => {
    const store = createEditorStore();
    store.getState().setSelection({ sceneIds: ["s1", "s2"] });
    store.getState().selectKeyframe({ sceneId: "s1", time: 1 });
    expect(store.getState().selectedKeyframe).toBeNull();
    store.getState().selectScene("s1");
    store.getState().selectKeyframe({ sceneId: "s1", time: 1 });
    expect(store.getState().selectedKeyframe).toEqual({ sceneId: "s1", time: 1 });
    store.getState().toggleItemInSelection({ sceneId: "s2" });
    expect(store.getState().selectedKeyframe).toBeNull();
  });

  it("resetForProject clears the scene set", () => {
    const store = createEditorStore();
    store.getState().setSelection({ sceneIds: ["s1"] });
    store.getState().resetForProject();
    expect(store.getState().selectedSceneIds.size).toBe(0);
  });
});
