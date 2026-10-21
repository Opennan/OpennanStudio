import { TRANSFORM_MARKER_RULES } from "./rules-transform-markers";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(TRANSFORM_MARKER_RULES, seed);

describe("transform and marker-placement shortcuts", () => {
    it("M toggles a marker at the playhead", async () => {
        const h = await setup();
        h.store.getState().setCurrentTime(2);
        h.press({ key: "m" });
        expect(h.store.getState().timelineMarkers.map((m) => m.time)).toEqual([2]);
        h.press({ key: "m" });
        expect(h.store.getState().timelineMarkers).toEqual([]);
    });

    it("Alt+M marks the selected clip's edges; Alt+Shift+M marks them as In and Out", async () => {
        const h = await setup({ clips: [textClip("a", 1, 3)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "m", altKey: true });
        expect(h.store.getState().timelineMarkers.map((m) => m.time)).toEqual([1, 3]);
        h.store.getState().clearTimelineMarkers();
        h.press({ key: "M", altKey: true, shiftKey: true });
        expect(h.store.getState().timelineMarkers.map((m) => [m.time, m.label])).toEqual([[1, "In"], [3, "Out"]]);
    });
});
