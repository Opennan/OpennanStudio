import { SELECT_JUMP_RULES } from "./rules-select-jump";
import { createKeymapHarness, textClip } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(SELECT_JUMP_RULES, seed);

describe("marker snapping, range selection, jumps, and Space", () => {
    it("Home and End seek to the start and the content end; [ and ] jump between markers", async () => {
        const h = await setup({ clips: [textClip("a", 0, 8)] });
        h.press({ key: "End" });
        expect(h.store.getState().seekRequest).toBe(8);
        h.press({ key: "Home" });
        expect(h.store.getState().seekRequest).toBe(0);
        h.store.getState().addTimelineMarker(3);
        h.store.getState().addTimelineMarker(6);
        h.store.getState().setCurrentTime(4);
        h.press({ key: "]" });
        expect(h.store.getState().seekRequest).toBe(6);
        h.press({ key: "[" });
        expect(h.store.getState().seekRequest).toBe(3);
    });

    it("Space requests play and stops shuttling", async () => {
        const h = await setup();
        h.store.getState().setShuttleSpeed(2);
        expect(h.press({ key: " " }).defaultPrevented).toBe(true);
        expect(h.store.getState().playRequest).toBe("play");
        expect(h.store.getState().shuttleSpeed).toBe(0);
    });
});
