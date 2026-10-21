import { MARKER_RANGE_RULES } from "./rules-marker-range";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(MARKER_RANGE_RULES, seed);

describe("marker range and duplicate shortcuts", () => {
    it("Ctrl/Cmd+D duplicates the selected clip and selects the copy", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        expect(h.press({ key: "d", metaKey: true }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect([...h.store.getState().selectedClipIds]).toEqual(["srv-1"]));
        expect(h.clips().map((c) => [c.id, c.startTime, c.endTime])).toEqual([["a", 0, 2], ["srv-1", 2, 4]]);
    });

    it("Ctrl/Cmd+D without a selection falls through", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        expect(h.press({ key: "d", ctrlKey: true }).defaultPrevented).toBe(false);
        expect(h.clips()).toHaveLength(1);
    });

    it("Ctrl/Cmd+Alt+C copies the marker range to the clipboard", async () => {
        const h = await setup({ clips: [textClip("a", 0, 10)] });
        h.store.getState().addTimelineMarker(2, "In");
        h.store.getState().addTimelineMarker(6, "Out");
        h.store.getState().setCurrentTime(4);
        h.press({ key: "c", ctrlKey: true, altKey: true });
        expect(h.store.getState().timelineClipboard?.clips).toHaveLength(1);
    });

    it("Ctrl/Cmd+Alt+Shift+T trims the selection to the marker range", async () => {
        const h = await setup({ clips: [textClip("a", 0, 10)] });
        h.store.getState().addTimelineMarker(2, "In");
        h.store.getState().addTimelineMarker(6, "Out");
        h.store.getState().setCurrentTime(4);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "T", metaKey: true, altKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips().map((c) => [c.startTime, c.endTime])).toEqual([[2, 6]]));
    });
});
