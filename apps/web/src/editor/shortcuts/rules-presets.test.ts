import { optimistic } from "@opennan/timeline-core";
import { PRESET_RULES } from "./rules-presets";
import { TRACKS, createKeymapHarness, track } from "./keymap-test-harness";

const overlay = optimistic.optimisticTimelineClipFromInput(
    { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "uploaded", mediaUrl: "https://cdn.test/v.mp4" }, "p1", "v",
);

async function setup() {
    const h = await createKeymapHarness(PRESET_RULES, { clips: [overlay], tracks: [...TRACKS, track("video", 2)] });
    h.store.getState().setSelectedClipIds(new Set(["v"]));
    return h;
}

describe("volume, speed, freeze, reverse, and keyframe-jump shortcuts", () => {
    it("Alt+Shift+6 sets the selected clip's volume to 50%; Alt+3 plays it at 2x", async () => {
        const h = await setup();
        expect(h.press({ key: "6", altKey: true, shiftKey: true }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(h.clips()[0].volume).toBe(0.5));
        h.press({ key: "3", altKey: true });
        // speed.set semantics: the length follows the speed (the source span is kept).
        await vi.waitFor(() => expect(h.clips()[0]).toMatchObject({ playbackSpeed: 2, startTime: 0, endTime: 2 }));
    });

    it("Alt+Shift+3 applies the hero curve at 1x and the length follows its mean speed; Alt+Shift+1 clears it", async () => {
        const h = await setup();
        h.press({ key: "3", altKey: true, shiftKey: true });
        await vi.waitFor(() => expect(JSON.parse(h.clips()[0].speedCurveJson ?? "{}").id).toBe("hero"));
        expect(h.clips()[0]).toMatchObject({ playbackSpeed: 1, speedRamp: "none" });
        expect(h.clips()[0].endTime).not.toBe(4);
        h.press({ key: "1", altKey: true, shiftKey: true });
        await vi.waitFor(() => expect(h.clips()[0].speedCurveJson ?? null).toBeNull());
        expect(h.clips()[0].endTime).toBeCloseTo(4, 6);
    });

    it("Alt+F and Alt+R toggle freeze frame and reverse playback", async () => {
        const h = await setup();
        h.press({ key: "f", altKey: true });
        await vi.waitFor(() => expect(h.clips()[0].freezeFrame).toBe(true));
        h.press({ key: "r", altKey: true });
        await vi.waitFor(() => expect(h.clips()[0].reversePlayback).toBe(true));
    });
});
