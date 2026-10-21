import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import type { EditorCommand, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { selectLiveScenes } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { parseMask } from "@opennan/timeline-core/looks/masks";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../../test-utils/render-with-timeline";
import { getActiveRuntime } from "../../provider/registry";
import { Inspector } from "./inspector";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: start || 0.001, trackIndex: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);

async function setup(select: { clip?: string; scene?: string }, time = 0.5, masks: { clip?: string; scene?: string } = {}) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("audio", 1), track("text", 1), track("sticker", 1)],
        scenes: [scene("a", 0, 3, masks.scene ? { maskJson: masks.scene } : {})],
        clips: [
            clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", mediaType: "video", ...(masks.clip ? { maskJson: masks.clip } : {}) }),
            clip("img", { trackType: "video", trackIndex: 2, startTime: 2, endTime: 4, mediaUrl: "/m/i.png", mediaType: "image" }),
            clip("txt", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hello", mediaType: "text" }),
            clip("st", { trackType: "sticker", trackIndex: 1, startTime: 1, endTime: 3, mediaType: "image", mediaUrl: "/m/s.png" }),
        ],
    });
    const state = runtime.store.getState();
    if (select.clip) state.setSelectedClipIds(new Set([select.clip]));
    if (select.scene) state.selectScene(select.scene);
    state.setCurrentTime(time);
    renderWithTimeline(<Inspector />, { runtime });
    const execute = vi.spyOn(getActiveRuntime()!.controller, "execute");
    return { runtime, execute };
}

const clipOf = (runtime: TimelineTestRuntime, id: string) => runtime.store.getState().timelineData!.clips.find((c) => c.id === id)!;
const sceneOf = (runtime: TimelineTestRuntime, id: string) => selectLiveScenes(runtime.store.getState()).find((s) => s.id === id)!;
const commands = (execute: { mock: { calls: unknown[][] } }) => execute.mock.calls.map((call) => call[0] as EditorCommand);
const slider = (testId: string) => within(screen.getByTestId(testId)).getByRole("slider") as HTMLInputElement;

describe("Mask tab", () => {
    it("is offered for video and image clips, scenes, text, and stickers (phase 10d), not audio", async () => {
        const first = await setup({ clip: "v" });
        expect(screen.getByTestId("inspector-tab-mask")).toBeTruthy();
        act(() => first.runtime.store.getState().setSelectedClipIds(new Set(["txt"])));
        await waitFor(() => expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["tabText", "anim_tab", "tabMask", "tabAi"]), { timeout: 5000 });
        act(() => first.runtime.store.getState().setSelectedClipIds(new Set(["st"])));
        await waitFor(() => expect(screen.getByTestId("inspector-tab-mask")).toBeTruthy(), { timeout: 5000 });
        act(() => first.runtime.store.getState().setSelectedClipIds(new Set(["img"])));
        await waitFor(() => expect(screen.getByTestId("inspector-tab-mask")).toBeTruthy(), { timeout: 5000 });
        act(() => first.runtime.store.getState().selectScene("a"));
        await waitFor(() => expect(screen.getByTestId("inspector-tab-mask")).toBeTruthy(), { timeout: 5000 });
    });

    it("masks a text clip from its Mask tab (one mask.set) and turns the preview's mask editing on", async () => {
        const { runtime, execute } = await setup({ clip: "txt" });
        fireEvent.click(screen.getByTestId("inspector-tab-mask"));
        expect(runtime.store.getState().maskEditing).toBe(true);
        await act(async () => fireEvent.click(screen.getByTestId("mask-shape-heart")));
        expect(commands(execute)[0]).toEqual({ type: "mask.set", clipId: "txt", mask: { shape: "heart" } });
        await waitFor(() => expect(parseMask(clipOf(runtime, "txt").maskJson)?.shape).toBe("heart"), { timeout: 5000 });
        expect(screen.getByTestId("mask-shape-heart").getAttribute("aria-pressed")).toBe("true");
    });

    it("adds a shape, shows its controls, and turns the preview's mask editing on while open", async () => {
        const { runtime, execute } = await setup({ clip: "v" });
        expect(runtime.store.getState().maskEditing).toBe(false);
        fireEvent.click(screen.getByTestId("inspector-tab-mask"));
        expect(runtime.store.getState().maskEditing).toBe(true);
        expect(screen.getAllByTestId(/^mask-shape-/)).toHaveLength(7);
        expect(screen.getByTestId("mask-shape-none").getAttribute("aria-pressed")).toBe("true");
        expect(screen.queryByTestId("mask-position-x")).toBeNull();
        await act(async () => fireEvent.click(screen.getByTestId("mask-shape-circle")));
        expect(commands(execute)[0]).toEqual({ type: "mask.set", clipId: "v", mask: { shape: "circle" } });
        await waitFor(() => expect(parseMask(clipOf(runtime, "v").maskJson)?.shape).toBe("circle"), { timeout: 5000 });
        expect(screen.getByTestId("mask-shape-circle").getAttribute("aria-pressed")).toBe("true");
        expect(slider("mask-position-x").value).toBe("50");
        expect(slider("mask-width").value).toBe("60");
        expect(screen.queryByTestId("mask-roundness")).toBeNull();
        fireEvent.click(screen.getByTestId("inspector-tab-video"));
        expect(runtime.store.getState().maskEditing).toBe(false);
    });

    it("writes slider moves as coalesced mask.set patches, and roundness only for rectangles", async () => {
        const { runtime, execute } = await setup({ clip: "v" }, 0.5, { clip: '{"shape":"rectangle"}' });
        fireEvent.click(screen.getByTestId("inspector-tab-mask"));
        await act(async () => fireEvent.change(slider("mask-position-x"), { target: { value: "30" } }));
        expect(execute).toHaveBeenLastCalledWith({ type: "mask.set", clipId: "v", mask: { x: 0.3 } }, { coalesceKey: "mask-v-x", debounceMs: 120 });
        await act(async () => fireEvent.change(slider("mask-rotation"), { target: { value: "-45" } }));
        await act(async () => fireEvent.change(slider("mask-feather"), { target: { value: "25" } }));
        await act(async () => fireEvent.change(slider("mask-roundness"), { target: { value: "40" } }));
        await waitFor(() => expect(parseMask(clipOf(runtime, "v").maskJson)).toMatchObject({ x: 0.3, rotation: -45, feather: 0.25, roundness: 0.4 }), { timeout: 5000 });
        await act(async () => fireEvent.click(screen.getByTestId("mask-invert").querySelector("button,[role=switch]") ?? screen.getByTestId("mask-invert")));
        await waitFor(() => expect(parseMask(clipOf(runtime, "v").maskJson)?.invert).toBe(true), { timeout: 5000 });
    });

    it("keys the mask position with its diamond (both axes), and edits keyframes once keyed", async () => {
        const { runtime, execute } = await setup({ scene: "a" }, 1, { scene: '{"shape":"star"}' });
        fireEvent.click(screen.getByTestId("inspector-tab-mask"));
        await act(async () => fireEvent.click(screen.getByTestId("kf-toggle-mask-position")));
        expect(commands(execute).at(-1)).toMatchObject({ type: "keyframe.set", sceneId: "a", values: { mask_x: 0.5, mask_y: 0.5 } });
        await waitFor(() => expect(parseTimelineKeyframes(sceneOf(runtime, "a").keyframesJson)).toHaveLength(1), { timeout: 5000 });
        await act(async () => fireEvent.change(slider("mask-position-y"), { target: { value: "70" } }));
        await waitFor(() => expect(parseTimelineKeyframes(sceneOf(runtime, "a").keyframesJson)[0]).toMatchObject({ mask_x: 0.5, mask_y: 0.7 }), { timeout: 5000 });
    });

    it("Reset restores the shape's defaults in one command; None removes the mask", async () => {
        const { runtime, execute } = await setup({ clip: "v" }, 0.5, { clip: '{"shape":"heart","x":0.2,"rotation":30}' });
        fireEvent.click(screen.getByTestId("inspector-tab-mask"));
        await act(async () => fireEvent.click(screen.getByTestId("mask-reset")));
        expect(commands(execute).at(-1)).toEqual({ type: "mask.set", clipId: "v", mask: { shape: "heart" }, replace: true });
        await waitFor(() => expect(parseMask(clipOf(runtime, "v").maskJson)).toMatchObject({ shape: "heart", x: 0.5, rotation: 0 }), { timeout: 5000 });
        await act(async () => fireEvent.click(screen.getByTestId("mask-shape-none")));
        expect(commands(execute).at(-1)).toEqual({ type: "mask.set", clipId: "v", mask: null });
        await waitFor(() => expect(clipOf(runtime, "v").maskJson ?? null).toBeNull(), { timeout: 5000 });
    });
});
