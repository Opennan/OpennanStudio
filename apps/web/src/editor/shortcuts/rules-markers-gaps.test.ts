import { MARKER_GAP_RULES } from "./rules-markers-gaps";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(MARKER_GAP_RULES, seed);

describe("marker and gap-closing shortcuts", () => {
    it("I and O set the in and out markers at the playhead", async () => {
        const h = await setup();
        h.store.getState().setCurrentTime(1);
        h.press({ key: "i" });
        h.store.getState().setCurrentTime(3);
        h.press({ key: "O" });
        expect(h.store.getState().timelineMarkers.map((m) => [m.time, m.label])).toEqual([[1, "In"], [3, "Out"]]);
    });

    it("Ctrl/Cmd+Alt+Shift+P closes every gap", async () => {
        const h = await setup({ clips: [textClip("a", 0, 1), textClip("b", 3, 4)] });
        h.press({ key: "p", ctrlKey: true, altKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips().find((c) => c.id === "b")).toMatchObject({ startTime: 1, endTime: 2 }));
    });

    it("Ctrl/Cmd+Alt+P closes the gaps on the selected clip's track", async () => {
        const h = await setup({ clips: [textClip("a", 1, 3), textClip("b", 5, 6)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "p", metaKey: true, altKey: true });
        await vi.waitFor(() => expect(h.clips().find((c) => c.id === "b")).toMatchObject({ startTime: 3, endTime: 4 }));
    });
});
