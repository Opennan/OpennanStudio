import type { SceneData } from "@opennan/timeline-core";
import { EDITOR_SHORTCUT_RULES } from "./editor-keymap";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

function scene(id: string, at: number, duration: number, order: number): SceneData {
    return {
        id, order, caption: id, startTime: "00:00:00", endTime: `00:00:0${duration}`, startImageUrl: null, endImageUrl: null, videoUrl: "v.mp4",
        status: "completed", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
        cardType: "source_clip", sourceVideoUrl: "v.mp4", duration, timelinePositionSeconds: at, trackIndex: 1,
    } as SceneData;
}

const seed = () => ({ clips: [textClip("a", 0, 2), textClip("b", 3, 4)], scenes: [scene("s1", 0.001, 4, 0), scene("s2", 4.001, 3, 1)] });
const setup = () => createKeymapHarness(EDITOR_SHORTCUT_RULES, seed());

describe("multi-item shortcuts", () => {
    it("Delete removes the selected clips and scenes in one undo step", async () => {
        const h = await setup();
        h.store.getState().setSelection({ clipIds: ["a"], sceneIds: ["s1"] });
        expect(h.press({ key: "Delete" }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(h.clips().map((c) => c.id)).toEqual(["b"]));
        await vi.waitFor(() => expect(h.controller.snapshot().scenes.map((s) => s.id)).toEqual(["s2"]));
        await vi.waitFor(() => expect(h.controller.historyDepth().undo).toBe(1));
        await h.controller.execute({ type: "history.undo" });
        expect(h.clips()).toHaveLength(2);
        expect(h.controller.snapshot().scenes).toHaveLength(2);
    });

    it("a clip-only selection still deletes through the clip rule", async () => {
        const h = await setup();
        h.store.getState().setSelectedClipIds(new Set(["a", "b"]));
        h.press({ key: "Backspace" });
        await vi.waitFor(() => expect(h.clips()).toEqual([]));
        expect(h.controller.snapshot().scenes).toHaveLength(2);
    });

    it("Ctrl/Cmd+C copies clips and scenes; Ctrl/Cmd+V pastes them after the selection", async () => {
        const h = await setup();
        h.store.getState().setSelection({ clipIds: ["a"], sceneIds: ["s2"] });
        h.press({ key: "c", metaKey: true });
        expect(h.store.getState().timelineClipboard?.scenes?.map((s) => s.sceneId)).toEqual(["s2"]);
        expect(h.press({ key: "v", metaKey: true }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(h.controller.snapshot().scenes).toHaveLength(3));
        expect(h.clips()).toHaveLength(3);
        expect(h.controller.historyDepth().undo).toBe(1);
    });

    it("Ctrl/Cmd+D duplicates a selection with scenes in one step", async () => {
        const h = await setup();
        h.store.getState().setSelection({ clipIds: ["b"], sceneIds: ["s1"] });
        h.press({ key: "d", ctrlKey: true });
        await vi.waitFor(() => expect(h.controller.snapshot().scenes).toHaveLength(3));
        expect(h.clips()).toHaveLength(3);
        expect(h.controller.historyDepth().undo).toBe(1);
    });

    it("Ctrl/Cmd+A selects every clip and scene", async () => {
        const h = await setup();
        h.press({ key: "a", metaKey: true });
        expect([...h.store.getState().selectedClipIds].sort()).toEqual(["a", "b"]);
        expect([...h.store.getState().selectedSceneIds].sort()).toEqual(["s1", "s2"]);
        h.press({ key: "Escape" });
        expect(h.store.getState().selectedSceneIds.size).toBe(0);
        expect(h.store.getState().selectedClipIds.size).toBe(0);
    });
});
