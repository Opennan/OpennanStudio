// The inspector's group mode and the graphics clip inspector (phase 10c).
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { EditorCommand, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { selectLiveScenes } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { createTimelineTestRuntime, keyOnly, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { getActiveRuntime } from "../../provider/registry";
import { Inspector } from "./inspector";
import { groupTabs } from "./group-inspector";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: start || 0.001, trackIndex: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);

async function setup(select: { clipIds?: string[]; sceneIds?: string[] }) {
    const runtime = createTimelineTestRuntime();
    runtime.store.getState().resetForProject();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("text", 1), track("audio", 1), track("remotion", 1)],
        scenes: [scene("a", 0, 3, { visualFilter: "warm", filterIntensity: 0.5 }), scene("b", 3, 3)],
        clips: [
            clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", mediaType: "video", visualFilter: "warm", filterIntensity: 0.5 }),
            clip("txt", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hello", mediaType: "text" }),
            clip("au", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4, mediaUrl: "/m/a.mp3", mediaType: "audio" }),
            clip("g", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "remotion", label: "Title card" }),
        ],
    });
    act(() => runtime.store.getState().setSelection(select));
    renderWithTimeline(<Inspector />, { runtime, translate: keyOnly });
    const execute = vi.spyOn(getActiveRuntime()!.controller, "execute");
    return { runtime, execute };
}

const commands = (execute: { mock: { calls: unknown[][] } }) => execute.mock.calls.map((call) => call[0] as EditorCommand);

describe("inspector group mode", () => {
    it("shows the item count and the tabs every item supports", async () => {
        await setup({ clipIds: ["v"], sceneIds: ["a", "b"] });
        expect(screen.getByTestId("inspector-group-title").textContent).toBe("groupTitle");
        expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual([
            "inspector-tab-filter", "inspector-tab-adjust", "inspector-tab-animation", "inspector-tab-mask", "inspector-tab-effects",
        ]);
    });

    it("applies a filter to every selected item with one command", async () => {
        const { runtime, execute } = await setup({ clipIds: ["v"], sceneIds: ["b"] });
        fireEvent.click(screen.getByTestId("group-filter-cool"));
        expect(commands(execute)).toEqual([expect.objectContaining({ type: "look.set", targets: [{ clipId: "v" }, { sceneId: "b" }], filter: "cool" })]);
        await waitFor(() => expect(selectLiveScenes(runtime.store.getState()).find((s) => s.id === "b")?.visualFilter).toBe("cool"));
        expect(runtime.store.getState().timelineData!.clips.find((c) => c.id === "v")!.visualFilter).toBe("cool");
    });

    it("marks properties whose values differ as mixed", async () => {
        await setup({ clipIds: ["v"], sceneIds: ["b"] });
        expect(screen.getByTestId("group-filter-mixed")).toBeTruthy();
        fireEvent.click(screen.getByTestId("inspector-tab-adjust"));
        expect(screen.queryByTestId("adjust-exposure-hint")).toBeNull();
    });

    it("animation and effects apply with targets", async () => {
        const { execute } = await setup({ sceneIds: ["a", "b"] });
        fireEvent.click(screen.getByTestId("inspector-tab-animation"));
        fireEvent.click(screen.getByTestId("anim-card-in-fade_in"));
        fireEvent.click(screen.getByTestId("inspector-tab-effects"));
        fireEvent.click(screen.getByTestId("group-effect-fx_blur"));
        expect(commands(execute)).toEqual([
            expect.objectContaining({ type: "animation.set", targets: [{ sceneId: "a" }, { sceneId: "b" }], slot: "in", animationId: "fade_in" }),
            expect.objectContaining({ type: "clip.effect.add", targets: [{ sceneId: "a" }, { sceneId: "b" }], effectId: "fx_blur" }),
        ]);
    });

    it("hides tabs an item cannot take; the Mask tab shows when any item takes a mask (phase 10d)", () => {
        const items = [{ clip: clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 1, mediaType: "video" }) }, { clip: clip("au", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "audio" }) }];
        expect(groupTabs(items).tabs).toEqual(["mask"]);
        const mixedFamilies = [items[0], { clip: clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "text" }) }];
        expect(groupTabs(mixedFamilies).tabs).toEqual(["mask"]);
        const unmaskable = [items[1], { clip: clip("g", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 1, mediaType: "remotion" }) }];
        expect(groupTabs(unmaskable).tabs).toEqual([]);
    });

    it("the group Mask tab: one mask.set with the maskable targets, mixed shapes and values marked (phase 10d)", async () => {
        const { runtime, execute } = await setup({ clipIds: ["v", "txt", "au"], sceneIds: ["b"] });
        // Text and audio share no other tab: Mask is the only one.
        expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual(["inspector-tab-mask"]);
        expect(screen.getByTestId("group-mask-partial").textContent).toBe("groupMaskPartial");
        expect(screen.getByTestId("mask-shape-none").getAttribute("aria-pressed")).toBe("true");
        await act(async () => fireEvent.click(screen.getByTestId("mask-shape-star")));
        expect(commands(execute)).toEqual([{ type: "mask.set", targets: [{ clipId: "v" }, { clipId: "txt" }, { sceneId: "b" }], mask: { shape: "star" } }]);
        const clipMask = (id: string) => runtime.store.getState().timelineData!.clips.find((c) => c.id === id)!.maskJson;
        await waitFor(() => expect(JSON.parse(clipMask("txt")!).shape).toBe("star"));
        expect(JSON.parse(clipMask("v")!).shape).toBe("star");
        expect(clipMask("au") ?? null).toBeNull();
        expect(screen.getByTestId("mask-shape-star").getAttribute("aria-pressed")).toBe("true");
        // One item changes: its shape and width differ, so the grid presses nothing and the slider says Mixed.
        await act(async () => { await getActiveRuntime()!.controller.execute({ type: "mask.set", clipId: "txt", mask: { shape: "circle", width: 1.5 } }); });
        await waitFor(() => expect(screen.getByTestId("group-mask-mixed")).toBeTruthy());
        expect(screen.getAllByTestId(/^mask-shape-/).filter((b) => b.getAttribute("aria-pressed") === "true")).toEqual([]);
        expect(screen.getByTestId("mask-width-hint").textContent).toBe("groupMixed");
        execute.mockClear();
        fireEvent.click(screen.getByRole("switch", { name: "mask_invert" }));
        expect(commands(execute)).toEqual([{ type: "mask.set", targets: [{ clipId: "v" }, { clipId: "txt" }, { sceneId: "b" }], mask: { invert: true } }]);
        await act(async () => { await execute.mock.results.at(-1)!.value; });
        // None removes every mask in one step; one undo brings them back.
        execute.mockClear();
        await act(async () => fireEvent.click(screen.getByTestId("mask-shape-none")));
        expect(commands(execute)).toEqual([{ type: "mask.set", targets: [{ clipId: "v" }, { clipId: "txt" }, { sceneId: "b" }], mask: null }]);
        await waitFor(() => expect(clipMask("txt") ?? null).toBeNull());
        // Let the write settle (it is one history entry once saved), then undo it.
        await act(async () => { await execute.mock.results.at(-1)!.value; });
        await act(async () => { await getActiveRuntime()!.controller.execute({ type: "history.undo" }); });
        await waitFor(() => expect(JSON.parse(clipMask("txt")!).shape).toBe("circle"));
        expect(JSON.parse(clipMask("v")!).shape).toBe("star");
    });

    it("a single item keeps the single-item inspector", async () => {
        await setup({ clipIds: ["v"] });
        expect(screen.queryByTestId("inspector-group")).toBeNull();
        expect(screen.getByTestId("inspector-tab-video")).toBeTruthy();
    });
});

describe("graphics clip inspector", () => {
    it("has the graphics editor, transform keyframes, and animations", async () => {
        const { runtime, execute } = await setup({ clipIds: ["g"] });
        expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("data-testid"))).toEqual(["inspector-tab-graphics", "inspector-tab-video", "inspector-tab-animation"]);
        fireEvent.click(screen.getByTestId("inspector-tab-video"));
        expect(screen.getByTestId("clip-rotation")).toBeTruthy();
        expect(screen.getByTestId("kf-toggle-rotation")).toBeTruthy();
        fireEvent.click(screen.getByTestId("inspector-tab-animation"));
        fireEvent.click(screen.getByTestId("anim-card-in-fade_in"));
        expect(commands(execute)).toContainEqual(expect.objectContaining({ type: "animation.set", clipId: "g", slot: "in", animationId: "fade_in" }));
        await waitFor(() => expect(runtime.store.getState().timelineData!.clips.find((c) => c.id === "g")!.animationJson).toContain("fade_in"));
    });
});
