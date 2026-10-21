import { createEditorStore } from "./editor-store";

describe("selectedKeyframe", () => {
    it("selects a keyframe of the selected clip and clears it when the selection changes", () => {
        const store = createEditorStore();
        store.getState().selectClip("c1");
        store.getState().selectKeyframe({ clipId: "c1", time: 1.5 });
        expect(store.getState().selectedKeyframe).toEqual({ clipId: "c1", time: 1.5 });
        // Same clip still selected: the keyframe stays.
        store.getState().selectClip("c1");
        expect(store.getState().selectedKeyframe).toEqual({ clipId: "c1", time: 1.5 });
        store.getState().selectClip("c2");
        expect(store.getState().selectedKeyframe).toBeNull();
    });

    it("selects a scene keyframe and clears it on any other selection", () => {
        const store = createEditorStore();
        store.getState().selectScene("s1");
        store.getState().selectKeyframe({ sceneId: "s1", time: 0.25 });
        expect(store.getState().selectedKeyframe).toEqual({ sceneId: "s1", time: 0.25 });
        store.getState().clearSelection();
        expect(store.getState().selectedKeyframe).toBeNull();
        store.getState().selectScene("s1");
        store.getState().selectKeyframe({ sceneId: "s1", time: 0.25 });
        store.getState().setSelectedClipIds(new Set(["c1", "c2"]));
        expect(store.getState().selectedKeyframe).toBeNull();
    });

    it("refuses a keyframe of an item that is not the single selection", () => {
        const store = createEditorStore();
        store.getState().selectKeyframe({ clipId: "c1", time: 1 });
        expect(store.getState().selectedKeyframe).toBeNull();
        store.getState().setSelectedClipIds(new Set(["c1", "c2"]));
        store.getState().selectKeyframe({ clipId: "c1", time: 1 });
        expect(store.getState().selectedKeyframe).toBeNull();
        store.getState().selectClip("c1");
        store.getState().selectKeyframe({ clipId: "c1", time: 1 });
        store.getState().selectKeyframe(null);
        expect(store.getState().selectedKeyframe).toBeNull();
    });

    it("is cleared for a new project", () => {
        const store = createEditorStore();
        store.getState().selectClip("c1");
        store.getState().selectKeyframe({ clipId: "c1", time: 1 });
        store.getState().resetForProject();
        expect(store.getState().selectedKeyframe).toBeNull();
    });
});

describe("keyframe graph", () => {
    it("opens and closes the graph editor with an optional channel", () => {
        const store = createEditorStore();
        expect(store.getState().keyframeGraph).toEqual({ open: false, channel: null });
        store.getState().setKeyframeGraph({ open: true, channel: "opacity" });
        expect(store.getState().keyframeGraph).toEqual({ open: true, channel: "opacity" });
        store.getState().setKeyframeGraph({ open: false });
        expect(store.getState().keyframeGraph).toEqual({ open: false, channel: "opacity" });
        store.getState().setKeyframeGraph({ channel: "scale" });
        expect(store.getState().keyframeGraph).toEqual({ open: false, channel: "scale" });
    });
});
