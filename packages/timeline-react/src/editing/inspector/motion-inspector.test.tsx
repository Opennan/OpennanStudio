import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import type { EditorCommand, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { selectLiveScenes } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { animationsFor } from "@opennan/timeline-core/motion/registry";
import { createTimelineTestRuntime, keyEchoExcept, renderWithTimeline, seedTimeline, type TimelineTestRuntime } from "../../test-utils/render-with-timeline";
import { getActiveRuntime } from "../../provider/registry";
import { Inspector } from "./inspector";

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1 });
const scene = (id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData => ({
    id, order: 0, caption: id, startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null, sourceVideoUrl: `/m/${id}.mp4`,
    status: "ready", transition: "cut", cardType: "source_clip", duration, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
    timelinePositionSeconds: start || 0.001, trackIndex: 1, ...patch,
});
const clip = (id: string, input: Record<string, unknown>): TimelineClip => optimisticTimelineClipFromInput(input, "project-1", id);
const KEYED = JSON.stringify({ keyframes: [{ time: 0.5, scale: 1.5 }, { time: 1.5, scale: 2 }] });

async function setup(options: { select?: { clip?: string; scene?: string }; time?: number; keyframes?: string; sceneKeyframes?: string; english?: string[] } = {}) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, {
        tracks: [track("video", 1), track("video", 2), track("audio", 1), track("text", 1), track("sticker", 1)],
        scenes: [scene("a", 0, 3, options.sceneKeyframes ? { keyframesJson: options.sceneKeyframes } : {}), scene("b", 3, 2)],
        clips: [
            clip("v", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/v.mp4", mediaType: "video", ...(options.keyframes ? { keyframesJson: options.keyframes } : {}) }),
            clip("txt", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hello", mediaType: "text" }),
            clip("st", { trackType: "sticker", trackIndex: 1, startTime: 1, endTime: 3, mediaType: "image", mediaUrl: "/m/s.png" }),
            clip("au", { trackType: "audio", trackIndex: 1, startTime: 0, endTime: 4, mediaUrl: "/m/a.mp3", mediaType: "audio" }),
        ],
    });
    const state = runtime.store.getState();
    if (options.select?.clip) state.setSelectedClipIds(new Set([options.select.clip]));
    if (options.select?.scene) state.selectScene(options.select.scene);
    state.setCurrentTime(options.time ?? 0);
    renderWithTimeline(<Inspector />, { runtime, ...(options.english ? { translate: keyEchoExcept(options.english) } : {}) });
    const execute = vi.spyOn(getActiveRuntime()!.controller, "execute");
    return { runtime, execute };
}

const clipOf = (runtime: TimelineTestRuntime, id: string) => runtime.store.getState().timelineData!.clips.find((c) => c.id === id)!;
const sceneOf = (runtime: TimelineTestRuntime, id: string) => selectLiveScenes(runtime.store.getState()).find((s) => s.id === id)!;
const commands = (execute: { mock: { calls: unknown[][] } }) => execute.mock.calls.map((call) => call[0] as EditorCommand);
const slider = (testId: string) => within(screen.getByTestId(testId)).getByRole("slider") as HTMLInputElement;
const seek = (runtime: TimelineTestRuntime, seconds: number) => act(() => runtime.store.getState().setCurrentTime(seconds));

describe("Animation tab", () => {
    it("applies an In animation to a video clip, sets its duration, and a combo replaces In and Out", async () => {
        const { runtime, execute } = await setup({ select: { clip: "v" } });
        fireEvent.click(screen.getByTestId("inspector-tab-animation"));
        expect(["in", "out", "combo"].map((s) => screen.queryByTestId(`anim-slot-${s}`) !== null)).toEqual([true, true, true]);
        expect(screen.queryByTestId("anim-slot-loop")).toBeNull();
        expect(screen.getAllByTestId(/^anim-card-in-/)).toHaveLength(animationsFor("clip", "in").length + 1);
        await act(async () => fireEvent.click(screen.getByTestId("anim-card-in-fade_in")));
        expect(commands(execute)[0]).toEqual({ type: "animation.set", clipId: "v", slot: "in", animationId: "fade_in" });
        await waitFor(() => expect(JSON.parse(clipOf(runtime, "v").animationJson!)).toEqual({ in: { id: "fade_in", duration: 0.5 } }));
        expect(screen.getByTestId("anim-card-in-fade_in").getAttribute("aria-pressed")).toBe("true");
        // Duration: 0.1 s to half the clip (2 s → 1 s), one coalesced command.
        expect(slider("anim-duration").max).toBe("1");
        await act(async () => fireEvent.change(slider("anim-duration"), { target: { value: "0.8" } }));
        expect(execute).toHaveBeenLastCalledWith({ type: "animation.set", clipId: "v", slot: "in", animationId: "fade_in", duration: 0.8 }, { coalesceKey: "anim-v-in", debounceMs: 120 });
        await waitFor(() => expect(JSON.parse(clipOf(runtime, "v").animationJson!).in.duration).toBe(0.8));
        fireEvent.click(screen.getByTestId("anim-slot-combo"));
        await act(async () => fireEvent.click(screen.getByTestId("anim-card-combo-combo_shake")));
        await waitFor(() => expect(JSON.parse(clipOf(runtime, "v").animationJson!)).toEqual({ combo: { id: "combo_shake" } }));
        await act(async () => fireEvent.click(screen.getByTestId("anim-card-combo-none")));
        await waitFor(() => expect(clipOf(runtime, "v").animationJson ?? null).toBeNull());
    });

    it("animates a scene (Out) through the same command", async () => {
        const { runtime, execute } = await setup({ select: { scene: "a" } });
        fireEvent.click(screen.getByTestId("inspector-tab-animation"));
        fireEvent.click(screen.getByTestId("anim-slot-out"));
        await act(async () => fireEvent.click(screen.getByTestId("anim-card-out-zoom_out_out")));
        expect(commands(execute)[0]).toEqual({ type: "animation.set", sceneId: "a", slot: "out", animationId: "zoom_out_out" });
        await waitFor(() => expect(JSON.parse(sceneOf(runtime, "a").animationJson!)).toEqual({ out: { id: "zoom_out_out", duration: 0.5 } }));
    });

    it("gives text clips a Text | Animation | Mask bar with In / Out / Loop", async () => {
        const { runtime } = await setup({ select: { clip: "txt" } });
        expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["tabText", "anim_tab", "tabMask", "tabAi"]);
        fireEvent.click(screen.getByTestId("inspector-tab-animation"));
        expect(["in", "out", "loop", "combo"].map((s) => screen.queryByTestId(`anim-slot-${s}`) !== null)).toEqual([true, true, true, false]);
        const loops = animationsFor("text", "loop");
        fireEvent.click(screen.getByTestId("anim-slot-loop"));
        expect(screen.getAllByTestId(/^anim-card-loop-/)).toHaveLength(loops.length + 1);
        if (loops.length > 0) {
            await act(async () => fireEvent.click(screen.getByTestId(`anim-card-loop-${loops[0].id}`)));
            await waitFor(() => expect(JSON.parse(clipOf(runtime, "txt").animationJson!).loop.id).toBe(loops[0].id));
            expect(slider("anim-duration").min).toBe("0.2");
            expect(slider("anim-duration").max).toBe("3");
        }
    });

    it("gives stickers In / Out / Combo / Loop", async () => {
        await setup({ select: { clip: "st" } });
        fireEvent.click(screen.getByTestId("inspector-tab-animation"));
        expect(["in", "out", "combo", "loop"].map((s) => screen.queryByTestId(`anim-slot-${s}`) !== null)).toEqual([true, true, true, true]);
    });
});

describe("keyframe diamonds", () => {
    it("shows filled, outlined, and empty states from the keyframes and the playhead", async () => {
        const { runtime } = await setup({ select: { clip: "v" }, time: 0.5, keyframes: KEYED });
        expect(screen.getByTestId("kf-toggle-scale").dataset.state).toBe("on");
        expect(screen.getByTestId("kf-toggle-position").dataset.state).toBe("off");
        expect(screen.getByTestId("kf-toggle-opacity").dataset.state).toBe("off");
        await seek(runtime, 1);
        await waitFor(() => expect(screen.getByTestId("kf-toggle-scale").dataset.state).toBe("keyed"));
        // The keyed slider shows the interpolated value at the playhead (1.5 → 2 halfway = 1.75).
        expect(slider("clip-scale").value).toBe("175");
        await seek(runtime, 1.5 + 1 / 60);
        await waitFor(() => expect(screen.getByTestId("kf-toggle-scale").dataset.state).toBe("on"));
    });

    it("adds a keyframe with the current values, then removes it", async () => {
        const { runtime, execute } = await setup({ select: { clip: "v" }, time: 1 });
        await act(async () => fireEvent.click(screen.getByTestId("kf-toggle-position")));
        expect(commands(execute)[0]).toEqual({ type: "keyframe.set", clipId: "v", time: 1, values: { position_x: 0.5, position_y: 0.5 } });
        await waitFor(() => expect(parseTimelineKeyframes(clipOf(runtime, "v").keyframesJson)).toEqual([{ time: 1, position_x: 0.5, position_y: 0.5 }]));
        await waitFor(() => expect(screen.getByTestId("kf-toggle-position").dataset.state).toBe("on"));
        await act(async () => fireEvent.click(screen.getByTestId("kf-toggle-position")));
        expect(commands(execute)[1]).toEqual({ type: "keyframe.remove", clipId: "v", time: 1, channels: ["position_x", "position_y"] });
        await waitFor(() => expect(clipOf(runtime, "v").keyframesJson ?? null).toBeNull());
    });

    it("writes a keyframe at the playhead when a keyed slider moves, and the static field otherwise", async () => {
        const { runtime, execute } = await setup({ select: { clip: "v" }, time: 1, keyframes: KEYED });
        await act(async () => fireEvent.change(slider("clip-scale"), { target: { value: "300" } }));
        expect(execute).toHaveBeenLastCalledWith({ type: "keyframe.set", clipId: "v", time: 1, values: { scale: 3 } }, { coalesceKey: "kf-v-scale", debounceMs: 120 });
        await waitFor(() => expect(parseTimelineKeyframes(clipOf(runtime, "v").keyframesJson).find((p) => p.time === 1)).toEqual({ time: 1, scale: 3 }));
        expect(clipOf(runtime, "v").scale).toBe(1);
        await act(async () => fireEvent.change(slider("clip-opacity"), { target: { value: "40" } }));
        expect(execute).toHaveBeenLastCalledWith({ type: "clip.update", clipIds: ["v"], patch: { opacity: 0.4 } }, { coalesceKey: "clip-v-opacity", debounceMs: 120 });
    });

    it("disables keyed sliders and diamonds while the playhead is outside the item", async () => {
        await setup({ select: { clip: "v" }, time: 2.5, keyframes: KEYED });
        expect(slider("clip-scale").disabled).toBe(true);
        expect(slider("clip-opacity").disabled).toBe(false);
        expect((screen.getByTestId("kf-toggle-opacity") as HTMLButtonElement).disabled).toBe(true);
    });

    it("jumps to the previous and next keyframe and sets the easing of the one under the playhead", async () => {
        const { runtime, execute } = await setup({ select: { clip: "v" }, time: 0, keyframes: KEYED });
        await act(async () => fireEvent.click(screen.getByTestId("kf-next")));
        expect(commands(execute)[0]).toEqual({ type: "playhead.seek", seconds: 0.5 });
        await waitFor(() => expect(runtime.store.getState().currentTime).toBe(0.5));
        await waitFor(() => expect(screen.getByTestId("kf-easing")).toBeTruthy());
        await act(async () => fireEvent.click(screen.getByTestId("ease-hold")));
        expect(commands(execute).at(-1)).toEqual({ type: "keyframe.easing", clipId: "v", time: 0.5, easing: "hold" });
        await waitFor(() => expect(parseTimelineKeyframes(clipOf(runtime, "v").keyframesJson)[0]).toMatchObject({ time: 0.5, easing: 4 }));
        await act(async () => fireEvent.click(screen.getByTestId("ease-bezier")));
        expect(commands(execute).at(-1)).toMatchObject({ type: "keyframe.easing", easing: "bezier", bezier: [0.25, 0.1, 0.25, 1] });
        await waitFor(() => expect(screen.getByTestId("bezier-editor")).toBeTruthy());
        // Keyboard nudges move a handle (coalesced).
        await act(async () => fireEvent.keyDown(screen.getByTestId("bezier-handle-1"), { key: "ArrowUp" }));
        expect(execute).toHaveBeenLastCalledWith(
            { type: "keyframe.easing", clipId: "v", time: 0.5, easing: "bezier", bezier: [0.25, 0.15, 0.25, 1] },
            { coalesceKey: "kf-ease-v-0.5", debounceMs: 120 },
        );
        await act(async () => fireEvent.click(screen.getByTestId("kf-next")));
        expect(commands(execute).at(-1)).toEqual({ type: "playhead.seek", seconds: 1.5 });
        await waitFor(() => expect(runtime.store.getState().currentTime).toBe(1.5));
        await waitFor(() => expect((screen.getByTestId("kf-prev") as HTMLButtonElement).disabled).toBe(false));
        await act(async () => fireEvent.click(screen.getByTestId("kf-prev")));
        expect(commands(execute).at(-1)).toEqual({ type: "playhead.seek", seconds: 0.5 });
    });

    it("keys scenes in scene units, with new Rotation and Opacity sliders", async () => {
        const { runtime, execute } = await setup({ select: { scene: "b" }, time: 4 });
        await act(async () => fireEvent.change(slider("scene-rotation"), { target: { value: "30" } }));
        await waitFor(() => expect(sceneOf(runtime, "b").rotationDegrees).toBe(30));
        await act(async () => fireEvent.change(slider("scene-opacity"), { target: { value: "50" } }));
        await waitFor(() => expect(sceneOf(runtime, "b").opacity).toBe(0.5));
        await act(async () => fireEvent.click(screen.getByTestId("kf-toggle-position")));
        // Scene b starts at 3 s: playhead 4 s is item time 1 s; position holds transformOffsetX/Y (percent).
        expect(commands(execute).at(-1)).toEqual({ type: "keyframe.set", sceneId: "b", time: 1, values: { position_x: 0, position_y: 0 } });
        await act(async () => fireEvent.click(screen.getByTestId("kf-toggle-rotation")));
        await waitFor(() => expect(parseTimelineKeyframes(sceneOf(runtime, "b").keyframesJson)).toEqual([{ time: 1, position_x: 0, position_y: 0, rotation_degrees: 30 }]));
    });

    it("reads scene keyframes for the diamond state", async () => {
        await setup({ select: { scene: "a" }, time: 1, sceneKeyframes: JSON.stringify({ keyframes: [{ time: 1, scale: 1.2 }] }) });
        expect(screen.getByTestId("kf-toggle-scale").dataset.state).toBe("on");
        expect(slider("scene-scale").value).toBe("120");
    });

    it("keys volume on the Audio tab", async () => {
        const { runtime } = await setup({ select: { clip: "au" }, time: 2 });
        await act(async () => fireEvent.click(screen.getByTestId("kf-toggle-volume")));
        await waitFor(() => expect(parseTimelineKeyframes(clipOf(runtime, "au").keyframesJson)).toEqual([{ time: 2, volume: 1 }]));
    });

    it("keys every pointwise Adjust control (and the filter intensity) from the Adjust header", async () => {
        const { runtime, execute } = await setup({ select: { clip: "v" }, time: 1 });
        const ctrl = getActiveRuntime()!.controller;
        await act(async () => {
            await ctrl.execute({ type: "look.set", clipId: "v", filter: "vivid", adjustments: { exposure: 0.2 } });
        });
        fireEvent.click(screen.getByTestId("inspector-tab-adjust"));
        execute.mockClear();
        await act(async () => fireEvent.click(screen.getByTestId("kf-toggle-adjust")));
        const set = commands(execute)[0] as Extract<EditorCommand, { type: "keyframe.set" }>;
        expect(set.type).toBe("keyframe.set");
        expect(Object.keys(set.values).sort()).toEqual([
            "adj_brightness", "adj_contrast", "adj_exposure", "adj_fade", "adj_highlights", "adj_saturation", "adj_shadows", "adj_temperature", "adj_tint", "adj_vibrance", "filter_intensity",
        ]);
        expect(set.values.adj_exposure).toBeCloseTo(0.2);
        await waitFor(() => expect(screen.getByTestId("kf-toggle-adjust").dataset.state).toBe("on"));
        // Keyed: an Adjust slider writes the keyframe, a non-keyframable one (sharpen) still writes look.set.
        await act(async () => fireEvent.change(slider("adjust-exposure"), { target: { value: "50" } }));
        expect((commands(execute).at(-1) as Extract<EditorCommand, { type: "keyframe.set" }>).values.adj_exposure).toBe(0.5);
        await act(async () => fireEvent.change(slider("adjust-sharpen"), { target: { value: "30" } }));
        expect(commands(execute).at(-1)).toMatchObject({ type: "look.set", clipId: "v", adjustments: { sharpen: 0.3 } });
        await waitFor(() => expect(parseTimelineKeyframes(clipOf(runtime, "v").keyframesJson)[0].adj_exposure).toBe(0.5));
    });
});

describe("Speed tab", () => {
    it("sets a normal speed on a log slider and by number; the length follows", async () => {
        const { runtime, execute } = await setup({ select: { clip: "v" }, english: ["speed_lengthValue"] });
        fireEvent.click(screen.getByTestId("inspector-tab-speed"));
        expect(screen.getByTestId("speed-length").textContent).toContain("2.0 s → 2.0 s");
        // Slider position 2/3 of the way is 10x.
        await act(async () => fireEvent.change(slider("speed-slider"), { target: { value: "667" } }));
        expect(execute).toHaveBeenLastCalledWith({ type: "speed.set", clipId: "v", speed: 10 }, { coalesceKey: "speed-v", debounceMs: 120 });
        await waitFor(() => expect(clipOf(runtime, "v").endTime).toBeCloseTo(0.2));
        const input = screen.getByTestId("speed-input");
        fireEvent.change(input, { target: { value: "0.5" } });
        await act(async () => fireEvent.blur(input));
        expect(execute).toHaveBeenLastCalledWith({ type: "speed.set", clipId: "v", speed: 0.5 }, undefined);
        await waitFor(() => expect(clipOf(runtime, "v").endTime).toBeCloseTo(4));
        await waitFor(() => expect(screen.getByTestId("speed-length").textContent).toContain("2.0 s → 4.0 s"));
        await act(async () => fireEvent.click(screen.getByRole("switch", { name: "speed_keepPitch" })));
        expect(commands(execute).at(-1)).toEqual({ type: "speed.set", clipId: "v", preservePitch: false });
        expect(screen.getByRole("switch", { name: "reverse" })).toBeTruthy();
    });

    it("applies a curve preset and edits it in the curve editor (one command per gesture)", async () => {
        const { runtime, execute } = await setup({ select: { clip: "v" } });
        fireEvent.click(screen.getByTestId("inspector-tab-speed"));
        fireEvent.click(screen.getByRole("button", { name: "speed_curve" }));
        expect(screen.getAllByTestId(/^speed-preset-/).map((el) => el.dataset.testid!.replace("speed-preset-", ""))).toEqual(
            ["none", "montage", "hero", "bullet", "jump_cut", "flash_in", "flash_out", "custom"],
        );
        await act(async () => fireEvent.click(screen.getByTestId("speed-preset-hero")));
        expect(commands(execute)[0]).toMatchObject({ type: "speed.set", clipId: "v", speed: 1, curve: { id: "hero" } });
        await waitFor(() => expect(JSON.parse(clipOf(runtime, "v").speedCurveJson!).id).toBe("hero"));
        expect(screen.getAllByTestId(/^curve-point-/)).toHaveLength(6);
        // Delete an interior point with the keyboard.
        await act(async () => fireEvent.keyDown(screen.getByTestId("curve-point-2"), { key: "Delete" }));
        expect(commands(execute).at(-1)).toMatchObject({ type: "speed.set", curve: { id: "custom" } });
        await waitFor(() => expect(JSON.parse(clipOf(runtime, "v").speedCurveJson!).points).toHaveLength(5));
        expect(screen.getByTestId("speed-preset-custom").getAttribute("aria-pressed")).toBe("true");
        // Arrow keys nudge the focused point (coalesced).
        await act(async () => fireEvent.keyDown(screen.getByTestId("curve-point-0"), { key: "ArrowUp" }));
        expect(execute.mock.calls.at(-1)![1]).toEqual({ coalesceKey: "speed-v", debounceMs: 120 });
        // None removes the curve.
        await act(async () => fireEvent.click(screen.getByTestId("speed-preset-none")));
        await waitFor(() => expect(clipOf(runtime, "v").speedCurveJson ?? null).toBeNull());
    });

    it("gives scenes a speed tab that writes speed.set on the scene", async () => {
        const { runtime, execute } = await setup({ select: { scene: "a" } });
        fireEvent.click(screen.getByTestId("inspector-tab-speed"));
        expect(screen.queryByRole("switch", { name: "reverse" })).toBeNull();
        const input = screen.getByTestId("speed-input");
        fireEvent.change(input, { target: { value: "2" } });
        await act(async () => fireEvent.blur(input));
        expect(commands(execute)[0]).toEqual({ type: "speed.set", sceneId: "a", speed: 2 });
        await waitFor(() => expect(sceneOf(runtime, "a").playbackSpeed).toBe(2));
    });
});
