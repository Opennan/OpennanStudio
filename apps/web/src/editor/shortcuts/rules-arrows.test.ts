import type { SceneData } from "@opennan/timeline-core";
import { ARROW_RULES } from "./rules-arrows";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(ARROW_RULES, seed);

function scene(id: string, order: number, start: number): SceneData {
    return {
        id, order, caption: id, startTime: "00:00:00.000", endTime: "00:00:05.000", startImageUrl: null, endImageUrl: null,
        videoUrl: "https://cdn.test/v.mp4", sourceVideoUrl: "https://cdn.test/v.mp4", status: "completed", transition: "cut",
        cardType: "source_clip", duration: 5, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
        shotBreakdown: "[]", timelinePositionSeconds: start, trackIndex: 1,
    };
}

describe("slide, roll, slip, nudge, track move, and arrow shortcuts", () => {
    it("Alt+Arrow nudges the selected clip and falls through without a selection", async () => {
        const h = await setup({ clips: [textClip("a", 2, 4)] });
        expect(h.press({ key: "ArrowRight", altKey: true }).defaultPrevented).toBe(false);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "ArrowRight", altKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips()[0]).toMatchObject({ startTime: 3, endTime: 5 }));
    });

    it("ArrowRight selects the next scene and seeks to it; Shift+ArrowRight steps one second", async () => {
        const h = await setup({ scenes: [scene("s1", 0, 0.001), scene("s2", 1, 5)] });
        h.store.getState().selectScene("s1");
        h.press({ key: "ArrowRight" });
        expect(h.store.getState().selectedSceneId).toBe("s2");
        expect(h.store.getState().seekRequest).toBe(5);
        h.store.getState().setCurrentTime(2);
        h.press({ key: "ArrowRight", shiftKey: true });
        expect(h.store.getState().seekRequest).toBe(3);
    });
});
