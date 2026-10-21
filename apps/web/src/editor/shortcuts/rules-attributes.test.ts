import { optimistic, snapshotAttributes, type SceneData, type TimelineClip } from "@opennan/timeline-core";
import { EDITOR_SHORTCUT_RULES } from "./editor-keymap";
import { ATTRIBUTE_RULES } from "./rules-attributes";
import { TRACKS, createKeymapHarness, track, textClip } from "./keymap-test-harness";

const video = (id: string, startTime: number, endTime: number, extra: Partial<TimelineClip> = {}): TimelineClip => ({
    ...optimistic.optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime, endTime, mediaType: "video", mediaUrl: `${id}.mp4` }, "p1", id),
    ...extra,
});
const sceneAt = (id: string, at: number, duration: number): SceneData => ({
    id, order: 0, caption: id, startTime: "00:00:00", endTime: `00:00:0${duration}`, startImageUrl: null, endImageUrl: null, videoUrl: "v.mp4",
    status: "completed", transition: "cut", frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    cardType: "source_clip", sourceVideoUrl: "v.mp4", duration, timelinePositionSeconds: at || 0.001, trackIndex: 1,
} as SceneData);
const seed = { tracks: [...TRACKS, track("video", 2)], clips: [video("a", 0, 2, { visualFilter: "warm" }), video("b", 3, 5), video("c", 6, 8), textClip("t", 0, 2)] };

describe("copy and paste attributes shortcuts", () => {
    it("⌥⌘C copies the selected clip's attributes (matched by code: Option turns C into ç on macOS)", async () => {
        const h = await createKeymapHarness(ATTRIBUTE_RULES, seed);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        expect(h.press({ key: "ç", code: "KeyC", metaKey: true, altKey: true }).defaultPrevented).toBe(true);
        expect(h.store.getState().attributeClipboard).toMatchObject({ source: { id: "a" }, kinds: ["filter"] });
        expect(h.toasts.at(-1)?.message).toBe("attrCopied");
    });

    it("Ctrl+Alt+V opens the picker for every selected clip once attributes were copied", async () => {
        const h = await createKeymapHarness(ATTRIBUTE_RULES, seed);
        h.store.getState().setSelectedClipIds(new Set(["b", "c"]));
        // Nothing copied yet: the key is left to the next rule (the source's overwrite paste).
        expect(h.press({ key: "v", code: "KeyV", ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
        expect(h.store.getState().attributePastePicker).toBeNull();
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "c", code: "KeyC", ctrlKey: true, altKey: true });
        h.store.getState().setSelectedClipIds(new Set(["b", "c"]));
        h.press({ key: "√", code: "KeyV", metaKey: true, altKey: true });
        expect(h.store.getState().attributePastePicker).toEqual({ targets: [{ clipId: "b" }, { clipId: "c" }] });
    });

    it("leaves Shift variants and plain Ctrl/Cmd+C alone", async () => {
        const h = await createKeymapHarness(ATTRIBUTE_RULES, seed);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        expect(h.press({ key: "C", code: "KeyC", metaKey: true, altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
        expect(h.press({ key: "c", code: "KeyC", metaKey: true }).defaultPrevented).toBe(false);
        expect(h.press({ key: "ç", code: "KeyC", altKey: true }).defaultPrevented).toBe(false);
        expect(h.store.getState().attributeClipboard).toBeNull();
    });

    it("runs before the clip clipboard in the editor keymap, and not from a text field", async () => {
        const h = await createKeymapHarness(EDITOR_SHORTCUT_RULES, seed);
        h.store.getState().setSelectedClipIds(new Set(["a"]));
        h.press({ key: "c", code: "KeyC", ctrlKey: true, altKey: true });
        expect(h.store.getState().attributeClipboard).not.toBeNull();
        expect(h.store.getState().timelineClipboard).toBeNull();
        h.store.getState().setSelectedClipIds(new Set(["b"]));
        const before = h.clips().length;
        h.press({ key: "v", code: "KeyV", ctrlKey: true, altKey: true });
        expect(h.store.getState().attributePastePicker).toEqual({ targets: [{ clipId: "b" }] });
        expect(h.clips()).toHaveLength(before);
        h.store.getState().setAttributePastePicker(null);
        h.store.getState().setAttributeClipboard(null);
        const input = document.createElement("input");
        h.press({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }, input);
        expect(h.store.getState().attributeClipboard).toBeNull();
    });

    it("leaves the source's marker-range copy on ⌥⌘C with nothing selected, and its overwrite paste on ⌥⌘V without copied attributes", async () => {
        const h = await createKeymapHarness(EDITOR_SHORTCUT_RULES, { ...seed, clips: [textClip("t", 0, 4)] });
        h.store.getState().addTimelineMarker(1, "In");
        h.store.getState().addTimelineMarker(3, "Out");
        h.store.getState().setCurrentTime(2);
        h.press({ key: "c", code: "KeyC", metaKey: true, altKey: true });
        expect(h.store.getState().attributeClipboard).toBeNull();
        expect(h.store.getState().timelineClipboard?.clips).toHaveLength(1);
        h.store.getState().setSelectedClipIds(new Set(["t"]));
        h.store.getState().setCurrentTime(6);
        h.press({ key: "v", code: "KeyV", metaKey: true, altKey: true });
        expect(h.store.getState().attributePastePicker).toBeNull();
        await vi.waitFor(() => expect(h.clips()).toHaveLength(2));
    });

    it("falls through to the source's keys when the only scene is the one synced to the playhead", async () => {
        const h = await createKeymapHarness(EDITOR_SHORTCUT_RULES, { ...seed, clips: [textClip("t", 0, 4)], scenes: [sceneAt("s1", 0, 8)] });
        h.store.getState().addTimelineMarker(1, "In");
        h.store.getState().addTimelineMarker(3, "Out");
        h.store.getState().setCurrentTime(2);
        h.store.getState().syncActiveScene("s1");
        h.press({ key: "c", code: "KeyC", metaKey: true, altKey: true });
        expect(h.store.getState().attributeClipboard).toBeNull();
        expect(h.store.getState().timelineClipboard?.clips).toHaveLength(1);
        h.store.getState().setAttributeClipboard(snapshotAttributes({ kind: "clip", clip: video("a", 0, 2, { visualFilter: "warm" }) }));
        h.press({ key: "v", code: "KeyV", metaKey: true, altKey: true });
        expect(h.store.getState().attributePastePicker).toBeNull();
    });
});
