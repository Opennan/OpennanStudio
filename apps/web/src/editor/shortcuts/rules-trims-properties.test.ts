import { optimistic } from "@opennan/timeline-core";
import { TRIM_PROPERTY_RULES } from "./rules-trims-properties";
import { TRACKS, createKeymapHarness, textClip, track } from "./keymap-test-harness";

const setup = (seed?: Parameters<typeof createKeymapHarness>[1]) => createKeymapHarness(TRIM_PROPERTY_RULES, seed);

describe("trim-to-playhead, marker-clearing, and clip property shortcuts", () => {
    it("W trims the selected clip's end to the playhead; without a target it falls through", async () => {
        const h = await setup({ clips: [textClip("a", 0, 4)] });
        expect(h.press({ key: "w" }).defaultPrevented).toBe(false);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.store.getState().setCurrentTime(3);
        expect(h.press({ key: "w" }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(h.clips()[0]).toMatchObject({ startTime: 0, endTime: 3 }));
    });

    it("Ctrl/Cmd+M toggles mute on a selected audio clip", async () => {
        const song = optimistic.optimisticTimelineClipFromInput(
            { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 4, mediaType: "audio", mediaUrl: "https://cdn.test/a.mp3" }, "p1", "song",
        );
        const h = await setup({ clips: [song], tracks: [...TRACKS, track("audio", 2)] });
        h.store.getState().setSelectedClipIds(new Set(["song"]));
        h.press({ key: "m", ctrlKey: true });
        await vi.waitFor(() => expect(h.clips()[0].volume).toBe(0));
    });

    it("Ctrl/Cmd+L locks the selected clip", async () => {
        const h = await setup({ clips: [textClip("a", 1, 3)] });
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        expect(h.press({ key: "l", ctrlKey: true }).defaultPrevented).toBe(true);
        await vi.waitFor(() => expect(h.clips()[0].locked).toBe(true));
    });
});
