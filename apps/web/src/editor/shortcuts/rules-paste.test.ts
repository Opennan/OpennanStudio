import { CLIPBOARD_RULES } from "./rules-clipboard";
import { PASTE_RULES } from "./rules-paste";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness([...CLIPBOARD_RULES, ...PASTE_RULES], seed);

describe("paste shortcuts", () => {
    it("pastes the clipboard at the playhead and selects the paste", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "c", ctrlKey: true });
        h.store.getState().clearSelection();
        h.store.getState().setCurrentTime(5);
        expect(h.press({ key: "v", ctrlKey: true }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect([...h.store.getState().selectedClipIds]).toEqual(["srv-1"]));
        expect(h.clips().map((c) => [c.startTime, c.endTime])).toEqual([[0, 2], [5, 7]]);
    });

    it("leaves Ctrl/Cmd+V alone with an empty clipboard", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        expect(h.press({ key: "v", metaKey: true }).defaultPrevented).toBe(false);
        expect(h.clips()).toHaveLength(1);
    });

    it("insert-pastes with Ctrl/Cmd+Shift+V, shifting later clips on the track", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2), textClip("b", 2, 4)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "c", ctrlKey: true });
        h.store.getState().clearSelection();
        h.store.getState().setCurrentTime(2);
        h.press({ key: "V", ctrlKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips()).toHaveLength(3));
        expect(h.clips().find((c) => c.id === "b")).toMatchObject({ startTime: 4, endTime: 6 });
    });
});
