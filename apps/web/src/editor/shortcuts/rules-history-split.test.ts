import { HISTORY_SPLIT_RULES } from "./rules-history-split";
import { TRACKS, createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(HISTORY_SPLIT_RULES, seed);

describe("history and split shortcuts", () => {
    it("Escape leaves a tool first, then clears the selection", async () => {
        const h = await setup({ clips: [textClip("a", 0, 4)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.store.getState().setToolMode("blade");
        expect(h.press({ key: "Escape" }).defaultPrevented).toBe(true);
        expect(h.store.getState().toolMode).toBe("select");
        expect([...h.store.getState().selectedClipIds]).toEqual(["a"]);
        h.press({ key: "Escape" });
        expect(h.store.getState().selectedClipIds.size).toBe(0);
        expect(h.press({ key: "Escape" }).defaultPrevented).toBe(false);
    });

    it("undoes and redoes one step, or five with Alt", async () => {
        const h = await setup();
        for (let i = 0; i < 6; i += 1) {
            await h.controller.execute({ type: "clip.create", input: { trackType: "text", trackIndex: 1, startTime: i, endTime: i + 1 } });
        }
        h.press({ key: "z", ctrlKey: true, altKey: true });
        await vi.waitFor(() => expect(h.clips()).toHaveLength(1));
        h.press({ key: "z", metaKey: true });
        await vi.waitFor(() => expect(h.clips()).toHaveLength(0));
        h.press({ key: "Z", metaKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips()).toHaveLength(1));
        h.press({ key: "y", ctrlKey: true });
        await vi.waitFor(() => expect(h.clips()).toHaveLength(2));
        h.press({ key: "z", ctrlKey: true, altKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips()).toHaveLength(6));
    });

    it("Ctrl/Cmd+B asks the timeline to split at the playhead; Alt limits it to the active track", async () => {
        const h = await setup();
        expect(h.press({ key: "b", ctrlKey: true }).defaultPrevented).toBe(true);
        h.press({ key: "b", metaKey: true, altKey: true });
        expect(h.splitCalls).toEqual([false, true]);
    });

    it("Ctrl/Cmd+Alt+Shift+B splits every editable track at the playhead and selects the right halves", async () => {
        const h = await setup({ clips: [textClip("a", 0, 4), textClip("b", 0, 4, { trackIndex: 2 })] });
        h.store.getState().setCurrentTime(2);
        h.press({ key: "B", ctrlKey: true, altKey: true, shiftKey: true });
        await vi.waitFor(() => expect([...h.store.getState().selectedClipIds].sort()).toEqual(["srv-1", "srv-2"]));
        expect(h.clips()).toHaveLength(4);
        expect(h.splitCalls).toEqual([]);
    });

    it("Ctrl/Cmd+Alt+Shift+S splits at both ends of the marker range", async () => {
        const h = await setup({ clips: [textClip("a", 0, 10)], tracks: TRACKS });
        h.store.getState().addTimelineMarker(2, "In");
        h.store.getState().addTimelineMarker(6, "Out");
        h.store.getState().setCurrentTime(4);
        h.press({ key: "s", ctrlKey: true, altKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips().map((c) => [c.startTime, c.endTime]).sort((x, y) => x[0] - y[0])).toEqual([[0, 2], [2, 6], [6, 10]]));
    });
});
