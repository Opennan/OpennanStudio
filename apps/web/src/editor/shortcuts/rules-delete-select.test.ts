import { DELETE_SELECT_RULES } from "./rules-delete-select";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(DELETE_SELECT_RULES, seed);

describe("delete, select-all, and gap-insertion shortcuts", () => {
    it("Delete removes the selected clips and moves the selection on", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2), textClip("b", 3, 4)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        expect(h.press({ key: "Delete" }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(h.clips().map((c) => c.id)).toEqual(["b"]));
        expect([...h.store.getState().selectedClipIds]).toEqual(["b"]);
    });

    it("explains a fully locked selection instead of deleting", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2, { locked: true })] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "Backspace" });
        expect(h.toasts).toEqual([{ message: "Locked", icon: "\u{1F512}" }]);
        expect(h.clips()).toHaveLength(1);
    });

    it("a selected marker owns Delete", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        h.store.getState().addTimelineMarker(1);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.store.getState().setSelectedMarkerId(h.store.getState().timelineMarkers[0].id);
        h.press({ key: "Delete" });
        expect(h.store.getState().timelineMarkers).toEqual([]);
        expect(h.clips()).toHaveLength(1);
    });

    it("a selected scene deletes through the timeline's delete-selection request", async () => {
        const h = await setup();
        h.store.getState().selectScene("scene-1");
        h.press({ key: "Delete" });
        expect(h.store.getState().deleteSelectionRequest).toBe(42);
    });

    it("does nothing when another handler already consumed Delete", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        const event = new KeyboardEvent("keydown", { key: "Delete", cancelable: true });
        event.preventDefault();
        h.dispatch(event);
        expect(h.clips()).toHaveLength(1);
    });

    it("Shift+Delete ripple-deletes and pulls later clips left", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2), textClip("b", 2, 4)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "Delete", shiftKey: true });
        await vi.waitFor(() => expect(h.clips().map((c) => [c.id, c.startTime, c.endTime])).toEqual([["b", 0, 2]]));
    });

    it("Ctrl/Cmd+A selects every editable clip and Ctrl/Cmd+Shift+A inverts", async () => {
        const h = await setup({ clips: [textClip("a", 0, 2), textClip("b", 3, 4), textClip("c", 5, 6, { locked: true })] });
        h.press({ key: "a", metaKey: true });
        expect([...h.store.getState().selectedClipIds].sort()).toEqual(["a", "b"]);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "A", metaKey: true, shiftKey: true });
        expect([...h.store.getState().selectedClipIds]).toEqual(["b"]);
    });
});
