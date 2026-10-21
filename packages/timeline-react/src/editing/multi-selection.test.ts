// Group delete / duplicate / copy (phase 10c) reach every selected item, visible at the playhead or not (phase 10d check).
import type { TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { createTimelineTestRuntime, seedTimeline } from "../test-utils/render-with-timeline";
import { copySelectedItems, deleteSelectedItems, duplicateSelectedItems } from "./multi-selection";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });

async function setup() {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("text", 1), track("sticker", 1)],
        clips: [
            optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 2, textContent: "Now" }, runtime.projectId, "now"),
            optimisticTimelineClipFromInput({ trackType: "sticker", trackIndex: 1, startTime: 6, endTime: 8, textContent: "★" }, runtime.projectId, "later"),
        ],
    });
    const state = runtime.store.getState();
    state.setCurrentTime(1);
    state.setSelectedClipIds(new Set(["now", "later"]));
    const execute = vi.fn(async (_command: unknown) => ({ ok: true, changed: {} }));
    return { runtime, execute };
}

describe("group delete, duplicate, and copy", () => {
    it("include the selected items that are not at the playhead", async () => {
        const { runtime, execute } = await setup();
        await deleteSelectedItems({ execute } as never, runtime.store);
        await duplicateSelectedItems({ execute } as never, runtime.store);
        expect(execute.mock.calls.map(([command]) => command)).toEqual([
            { type: "items.delete", clipIds: ["now", "later"], sceneIds: [] },
            { type: "items.duplicate", clipIds: ["now", "later"], sceneIds: [] },
        ]);
        expect(copySelectedItems(runtime.store.getState())?.clips.map((entry) => entry.input.textContent)).toEqual(["Now", "★"]);
    });
});
