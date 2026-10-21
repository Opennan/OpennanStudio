import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { EditorCommand, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../../test-utils/render-with-timeline";
import { getActiveRuntime } from "../../provider/registry";
import { Inspector } from "./inspector";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, keyframesJson?: string): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration: 4, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: 0.001, trackIndex: 1, ...(keyframesJson ? { keyframesJson } : {}),
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);

// Clip v: 0..2 s, scale keyframes 1.5 at 0.5 s and 2 at 1.5 s (bezier segment), opacity 1 at 0.5 s.
const KEYED = JSON.stringify({ keyframes: [
    { time: 0.5, scale: 1.5, opacity: 1, easing: 5, bx1: 0.2, by1: 0, bx2: 0.8, by2: 1 },
    { time: 1.5, scale: 2 },
] });

// jsdom has no layout: the graph keeps its 280 × 150 default and client pixels are graph pixels.
// Plot: x 40..268 (114 px/s over 2 s), y 10..132; scale axis 1.45..2.05 (203.33 px per unit).
const X = (t: number) => 40 + t * 114;
const Y = (v: number) => 132 - ((v - 1.45) / 0.6) * 122;
const at = (t: number, v: number, extra: Record<string, unknown> = {}) => ({ clientX: X(t), clientY: Y(v), pointerId: 1, ...extra });

async function setup(options: { keyframes?: string | null; time?: number; open?: boolean } = {}) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2)],
        scenes: [scene("a")],
        clips: [clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", mediaType: "video", ...(options.keyframes === null ? {} : { keyframesJson: options.keyframes ?? KEYED }) })],
    });
    const state = runtime.store.getState();
    state.setKeyframeGraph({ open: false, channel: null });
    state.setSelectedClipIds(new Set(["v"]));
    state.setCurrentTime(options.time ?? 1);
    if (options.open !== false) state.setKeyframeGraph({ open: true });
    renderWithTimeline(<Inspector />, { runtime });
    const execute = vi.spyOn(getActiveRuntime()!.controller, "execute");
    return { runtime, execute };
}

const commands = (execute: { mock: { calls: unknown[][] } }) => execute.mock.calls.map((call) => call[0] as EditorCommand).filter((c) => c.type !== "playhead.seek");
const pointsOf = (runtime: TimelineTestRuntime) => parseTimelineKeyframes(runtime.store.getState().timelineData!.clips[0].keyframesJson);

describe("keyframe graph drawer", () => {
    it("opens from the Keyframes bar, picks a channel, and closes", async () => {
        const { runtime } = await setup({ open: false });
        expect(screen.queryByTestId("kf-graph")).toBeNull();
        fireEvent.click(screen.getByTestId("kf-graph-toggle"));
        expect(screen.getByTestId("kf-graph")).toBeInTheDocument();
        expect(screen.getByTestId("kf-graph-toggle")).toHaveAttribute("aria-pressed", "true");
        const picker = screen.getByTestId("kf-graph-channel") as HTMLSelectElement;
        expect([...picker.options].map((o) => o.value)).toEqual(["scale", "opacity"]);
        expect(screen.getAllByTestId(/^kf-graph-point-/)).toHaveLength(2);
        fireEvent.change(picker, { target: { value: "opacity" } });
        expect(runtime.store.getState().keyframeGraph.channel).toBe("opacity");
        expect(screen.getAllByTestId(/^kf-graph-point-/)).toHaveLength(1);
        fireEvent.click(screen.getByTestId("kf-graph-close"));
        expect(screen.queryByTestId("kf-graph")).toBeNull();
    });

    it("plots the curve with labels, the playhead, and bezier handles", async () => {
        await setup();
        expect(screen.getByTestId("kf-graph-curve").getAttribute("d")).toMatch(/^M/);
        expect(screen.getByTestId("kf-graph-playhead")).toHaveAttribute("x1", String(X(1)));
        expect(screen.getByText("160%")).toBeInTheDocument();
        expect(screen.getByText("1s")).toBeInTheDocument();
        expect(screen.getByTestId("kf-graph-handle-0-1")).toBeInTheDocument();
        expect(screen.getByTestId("kf-graph-point-0")).toHaveAttribute("aria-valuetext", "150%");
    });

    it("drags a point's value with one keyframe.set on release", async () => {
        const { runtime, execute } = await setup();
        const point = screen.getByTestId("kf-graph-point-0");
        fireEvent.pointerDown(point, at(0.5, 1.5));
        fireEvent.pointerMove(point, at(0.5, 1.55));
        fireEvent.pointerMove(point, at(0.5, 1.6));
        expect(commands(execute)).toHaveLength(0);
        expect(screen.getByTestId("kf-graph-point-0")).toHaveAttribute("aria-valuetext", "160%");
        await act(async () => fireEvent.pointerUp(point, at(0.5, 1.6)));
        expect(commands(execute)).toEqual([{ type: "keyframe.set", clipId: "v", time: 0.5, values: { scale: 1.6 } }]);
        await waitFor(() => expect(pointsOf(runtime)[0].scale).toBeCloseTo(1.6, 6));
        expect(pointsOf(runtime)[0].opacity).toBe(1);
    });

    it("drags a point in time with one keyframe.retime of its property, Shift locking the value", async () => {
        const { runtime, execute } = await setup();
        const point = screen.getByTestId("kf-graph-point-0");
        fireEvent.pointerDown(point, at(0.5, 1.5));
        fireEvent.pointerMove(point, at(0.8, 1.52, { shiftKey: true }));
        await act(async () => fireEvent.pointerUp(point, at(0.8, 1.52, { shiftKey: true })));
        expect(commands(execute)).toEqual([{ type: "keyframe.retime", clipId: "v", from: 0.5, to: 0.8, channels: ["scale"] }]);
        await waitFor(() => expect(pointsOf(runtime).map((p) => p.time)).toEqual([0.5, 0.8, 1.5]));
        // Opacity stays at 0.5 s; scale moved with its easing.
        expect(pointsOf(runtime)[0]).toEqual({ time: 0.5, opacity: 1, easing: 5, bx1: 0.2, by1: 0, bx2: 0.8, by2: 1 });
        expect(runtime.store.getState().selectedKeyframe).toEqual({ clipId: "v", time: 0.8 });
    });

    it("commits a diagonal drag as one retime with the new value", async () => {
        const { execute } = await setup();
        const point = screen.getByTestId("kf-graph-point-1");
        fireEvent.pointerDown(point, at(1.5, 2));
        fireEvent.pointerMove(point, at(1.2, 1.9));
        await act(async () => fireEvent.pointerUp(point, at(1.2, 1.9)));
        expect(commands(execute)).toEqual([{ type: "keyframe.retime", clipId: "v", from: 1.5, to: 1.2, channels: ["scale"], values: { scale: 1.9 } }]);
    });

    it("selects a clicked point, seeks to it, and follows the timeline's selection", async () => {
        const { runtime, execute } = await setup();
        const point = screen.getByTestId("kf-graph-point-1");
        fireEvent.pointerDown(point, at(1.5, 2));
        await act(async () => fireEvent.pointerUp(point, at(1.5, 2)));
        expect(execute).toHaveBeenCalledWith({ type: "playhead.seek", seconds: 1.5 });
        expect(runtime.store.getState().selectedKeyframe).toEqual({ clipId: "v", time: 1.5 });
        expect(screen.getByTestId("kf-graph-point-1")).toHaveAttribute("data-selected", "true");
        act(() => runtime.store.getState().selectKeyframe({ clipId: "v", time: 0.5 }));
        expect(screen.getByTestId("kf-graph-point-0")).toHaveAttribute("data-selected", "true");
        expect(commands(execute)).toHaveLength(0);
    });

    it("nudges and deletes the focused point with the keyboard", async () => {
        const { execute } = await setup();
        const point = screen.getByTestId("kf-graph-point-0");
        await act(async () => fireEvent.keyDown(point, { key: "ArrowRight" }));
        expect(commands(execute)[0]).toEqual({ type: "keyframe.retime", clipId: "v", from: 0.5, to: 0.533, channels: ["scale"] });
        execute.mockClear();
        await act(async () => fireEvent.keyDown(screen.getByTestId("kf-graph-point-1"), { key: "ArrowUp", shiftKey: true }));
        expect(execute).toHaveBeenCalledWith({ type: "keyframe.set", clipId: "v", time: 1.5, values: { scale: 2.1 } }, { coalesceKey: "kfg-v-scale-1.5", debounceMs: 120 });
        execute.mockClear();
        const deleting = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
        await act(async () => { screen.getByTestId("kf-graph-point-1").dispatchEvent(deleting); });
        expect(commands(execute)).toEqual([{ type: "keyframe.remove", clipId: "v", time: 1.5, channels: ["scale"] }]);
        expect(deleting.defaultPrevented).toBe(true);
    });

    it("chooses a segment's easing from its menu", async () => {
        const { execute } = await setup();
        fireEvent.click(screen.getByTestId("kf-graph-segment-0"), { clientX: X(1), clientY: Y(1.75) });
        expect(screen.getByTestId("kf-graph-easing-menu")).toBeInTheDocument();
        expect(screen.getByTestId("kf-graph-ease-bezier")).toHaveAttribute("aria-checked", "true");
        await act(async () => fireEvent.click(screen.getByTestId("kf-graph-ease-ease_in")));
        expect(commands(execute)).toEqual([{ type: "keyframe.easing", clipId: "v", time: 0.5, easing: "ease_in" }]);
        expect(screen.queryByTestId("kf-graph-easing-menu")).toBeNull();
        // The keyboard opens it too, and Escape closes it.
        fireEvent.keyDown(screen.getByTestId("kf-graph-segment-0"), { key: "Enter" });
        fireEvent.keyDown(screen.getByTestId("kf-graph-easing-menu"), { key: "Escape" });
        expect(screen.queryByTestId("kf-graph-easing-menu")).toBeNull();
    });

    it("drags a bezier handle into one keyframe.easing, x clamped to [0, 1]", async () => {
        const { execute } = await setup();
        const handle = screen.getByTestId("kf-graph-handle-0-2");
        fireEvent.pointerDown(handle, { clientX: X(1.3), clientY: Y(2), pointerId: 1 });
        fireEvent.pointerMove(handle, { clientX: X(1.9), clientY: Y(1.75), pointerId: 1 });
        await act(async () => fireEvent.pointerUp(handle, { clientX: X(1.9), clientY: Y(1.75), pointerId: 1 }));
        expect(commands(execute)).toEqual([{ type: "keyframe.easing", clipId: "v", time: 0.5, easing: "bezier", bezier: [0.2, 0, 1, 0.5] }]);
    });

    it("adds a keyframe on the curve with a double-click", async () => {
        const { runtime, execute } = await setup();
        fireEvent.doubleClick(screen.getByTestId("kf-graph-svg"), { clientX: X(1.8), clientY: Y(1.6) });
        await waitFor(() => expect(commands(execute)).toEqual([{ type: "keyframe.set", clipId: "v", time: 1.8, values: { scale: 2 } }]));
        expect(runtime.store.getState().selectedKeyframe).toEqual({ clipId: "v", time: 1.8 });
    });

    it("explains how to start when the item has no keyframes", async () => {
        await setup({ keyframes: null });
        expect(screen.getByTestId("kf-graph-empty")).toBeInTheDocument();
    });

    it("resizes with the keyboard", async () => {
        await setup();
        const handle = screen.getByTestId("kf-graph-resize");
        const before = Number(handle.getAttribute("aria-valuenow"));
        fireEvent.keyDown(handle, { key: "ArrowDown" });
        expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before + 16);
        expect(screen.getByTestId("kf-graph").style.height).toBe(`${before + 16}px`);
    });

    it("opens on a property's channel from its diamond's context menu", async () => {
        const { runtime } = await setup({ open: false });
        fireEvent.contextMenu(screen.getByTestId("kf-toggle-opacity"));
        expect(runtime.store.getState().keyframeGraph).toEqual({ open: true, channel: "opacity" });
        expect((screen.getByTestId("kf-graph-channel") as HTMLSelectElement).value).toBe("opacity");
    });
});
