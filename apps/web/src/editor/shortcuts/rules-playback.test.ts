import { PLAYBACK_RULES } from "./rules-playback";
import { createKeymapHarness } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(PLAYBACK_RULES, seed);

describe("frame step, J/K/L, and keyframe shortcuts", () => {
    it("comma and period step one frame", async () => {
        const h = await setup();
        h.press({ key: "." });
        expect(h.store.getState().currentTime).toBeCloseTo(1 / 30, 6);
        expect(h.store.getState().frameStepRequest).toMatchObject({ direction: 1 });
        h.press({ key: "," });
        expect(h.store.getState().currentTime).toBe(0);
        expect(h.store.getState().frameStepRequest).toMatchObject({ direction: -1, targetTime: 0 });
    });

    it("L doubles the forward shuttle up to 4x, J reverses it, K stops and pauses", async () => {
        const h = await setup();
        for (let i = 0; i < 4; i += 1) h.press({ key: "l" });
        expect(h.store.getState().shuttleSpeed).toBe(4);
        h.press({ key: "j" });
        expect(h.store.getState().shuttleSpeed).toBe(-1);
        h.press({ key: "k" });
        expect(h.store.getState().shuttleSpeed).toBe(0);
        expect(h.store.getState().playRequest).toBe("pause");
    });
});
