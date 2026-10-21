import { TOOL_RULES } from "./rules-tools";
import { createKeymapHarness } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(TOOL_RULES, seed);

describe("tool, zoom, and text shortcuts", () => {
    it("+ and - zoom the timeline", async () => {
        const h = await setup();
        const start = h.store.getState().timelineZoom;
        h.press({ key: "=" });
        const zoomedIn = h.store.getState().timelineZoom;
        expect(zoomedIn).toBeGreaterThan(start);
        h.press({ key: "-", ctrlKey: true });
        expect(h.store.getState().timelineZoom).toBeLessThan(zoomedIn);
    });

    it("B and H toggle their tools, V returns to select, S toggles snapping", async () => {
        const h = await setup();
        h.press({ key: "b" });
        expect(h.store.getState().toolMode).toBe("blade");
        h.press({ key: "b" });
        expect(h.store.getState().toolMode).toBe("select");
        h.press({ key: "h" });
        expect(h.store.getState().toolMode).toBe("hand");
        h.press({ key: "v" });
        expect(h.store.getState().toolMode).toBe("select");
        const snap = h.store.getState().snapEnabled;
        h.press({ key: "s" });
        expect(h.store.getState().snapEnabled).toBe(!snap);
    });

    it("T, Shift+T, and Alt+T request a text, caption, or subtitle clip", async () => {
        const h = await setup();
        h.press({ key: "t" });
        expect(h.store.getState().addTextRequest).toEqual({ id: 42, preset: "text" });
        h.store.getState().setAddTextRequest(null);
        h.press({ key: "T", shiftKey: true });
        expect(h.store.getState().addTextRequest).toEqual({ id: 42, preset: "caption" });
        h.store.getState().setAddTextRequest(null);
        h.press({ key: "t", altKey: true });
        expect(h.store.getState().addTextRequest).toEqual({ id: 42, preset: "subtitle" });
    });
});
