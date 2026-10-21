import { CLIPBOARD_RULES } from "./rules-clipboard";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(CLIPBOARD_RULES, seed);

describe("copy, cut, and detach shortcuts", () => {
    it("Ctrl/Cmd+C copies the selected clips", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        expect(h.press({ key: "c", ctrlKey: true }).defaultPrevented).toBe(true);
        expect(h.store.getState().timelineClipboard?.clips).toHaveLength(1);
    });

    it("leaves Ctrl/Cmd+C alone with nothing selected", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        expect(h.press({ key: "c", metaKey: true }).defaultPrevented).toBe(false);
        expect(h.store.getState().timelineClipboard).toBeNull();
    });

    it("Ctrl/Cmd+C on a selected scene leaves the copy to the timeline and clears the clip clipboard", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "c", ctrlKey: true });
        h.store.getState().selectScene("scene-1");
        expect(h.press({ key: "c", ctrlKey: true }).defaultPrevented).toBe(false);
        expect(h.store.getState().timelineClipboard).toBeNull();
    });

    it("cuts the selection to the clipboard", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2), textClip("b", 3, 4)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "x", ctrlKey: true });
        await vi.waitFor(() => expect(h.clips().map((c) => c.id)).toEqual(["b"]));
        expect(h.store.getState().timelineClipboard?.clips).toHaveLength(1);
        expect(h.store.getState().selectedClipIds.has("a")).toBe(false);
    });
});
