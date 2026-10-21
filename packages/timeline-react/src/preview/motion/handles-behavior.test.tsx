// Transform handles in the compositor (PreviewPanel): rotate knob, anchored corner scale, snapping guides,
// scene handles, and keyboard nudges, each committing one undoable command. jsdom has no canvas: every
// canvas gets a recording context; the canvas is 300×150 CSS px at its client origin (0, 0).
import { act, fireEvent, waitFor } from "@testing-library/react";
import { optimistic, type SceneData, type TimelineTrack } from "@opennan/timeline-core";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { selectLiveScenes } from "@opennan/timeline-core";
import { PreviewPanel } from "../preview-panel";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { useTimelineController } from "../../hooks/use-timeline-controller";
import { RecordingContext } from "./test-fixtures";
import { clipMotionAt, placedBox } from "./clip-motion";
import { cornerPoints, rotateKnob, rotateKnobOffset, type HandleBox } from "./handles";
import { getPreviewScreenFrame } from "../preview-screen-frame";

const contexts = new Map<HTMLCanvasElement, RecordingContext>();

beforeEach(() => {
    contexts.clear();
    vi.stubGlobal("ResizeObserver", class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
        let ctx = contexts.get(this);
        if (!ctx) {
            ctx = new RecordingContext(this);
            contexts.set(this, ctx);
        }
        return ctx as unknown as CanvasRenderingContext2D;
    } as never);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const STICKER_TRACK: TimelineTrack = { type: "sticker", index: 1, label: "S1", muted: false, locked: false, visible: true, volume: 1 };
const VIDEO_TRACK: TimelineTrack = { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 };
type Clip = ReturnType<typeof optimistic.optimisticTimelineClipFromInput>;

function sticker(id: string, extra: Partial<Clip> = {}): Clip {
    const runtime0 = createTimelineTestRuntime();
    return { ...optimistic.optimisticTimelineClipFromInput({ trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, textContent: "🔥" }, runtime0.projectId, id), ...extra };
}

function scene(extra: Partial<SceneData> = {}): SceneData {
    return {
        id: "scene-1", order: 0, caption: "Shot", startTime: "00:00:00,000", endTime: "00:00:10,000", startImageUrl: null, endImageUrl: null,
        videoUrl: "https://cdn.example.com/a.mp4", status: "video_ready", duration: 10, timelinePositionSeconds: 0, trackIndex: 1,
        sourceWidth: 1920, sourceHeight: 1080, fitMode: "contain", ...extra,
    } as SceneData;
}

/** The project frame inside the 300×150 canvas (16:9). */
function frameRect() {
    const { w: fw, h: fh } = getPreviewScreenFrame({ w: 300, h: 150 }, 16 / 9);
    return { x: (300 - fw) / 2, y: (150 - fh) / 2, w: fw, h: fh };
}

/** An emoji sticker's visual box (the compositor's placement). */
function stickerBox(clip: Clip, t: number): HandleBox {
    const frame = frameRect();
    const side = 64 * 1.2 * (frame.h / 1080);
    const placed = placedBox(frame, { w: side, h: side }, clipMotionAt(clip, t));
    return { cx: placed.cx, cy: placed.cy, w: placed.w, h: placed.h, rotation: placed.rotation };
}

let controllerRef: ReturnType<typeof useTimelineController> | null = null;
function ControllerProbe() {
    controllerRef = useTimelineController();
    return null;
}

async function setup(opts: { clips?: Clip[]; scenes?: SceneData[]; tracks: TimelineTrack[]; time: number }) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: opts.tracks, clips: opts.clips ?? [], scenes: opts.scenes ?? [] });
    runtime.store.getState().setCurrentTime(opts.time);
    renderWithTimeline(<><PreviewPanel /><ControllerProbe /></>, { runtime });
    const canvas = () => document.querySelector<HTMLCanvasElement>("[data-preview-canvas]")!;
    await waitFor(() => expect(canvas()).not.toBeNull());
    const c = canvas();
    c.setPointerCapture = () => {};
    c.hasPointerCapture = () => false;
    c.releasePointerCapture = () => {};
    const main = () => contexts.get(canvas());
    return { runtime, canvas: c, main };
}

function drag(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) {
    fireEvent.pointerDown(canvas, { clientX: from.x, clientY: from.y, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y, pointerId: 1, ...mods });
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
}

const savedClip = (runtime: Awaited<ReturnType<typeof setup>>["runtime"], id: string) => runtime.store.getState().timelineData!.clips.find((c) => c.id === id)!;
const savedScene = (runtime: Awaited<ReturnType<typeof setup>>["runtime"], id: string) => selectLiveScenes(runtime.store.getState()).find((s) => s.id === id)!;

describe("rotate handle", () => {
    it("rotates a static sticker about its centre with the 90° magnet: clip.update rotationDegrees, one undo step", async () => {
        const clip = sticker("s1", { scale: 3 });
        const { runtime, canvas, main } = await setup({ clips: [clip], tracks: [STICKER_TRACK], time: 1 });
        runtime.store.getState().setSelectedClipIds(new Set(["s1"]));
        // The selection chrome (with its knob) is drawn.
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const box = stickerBox(clip, 1);
        const { knob } = rotateKnob(box, rotateKnobOffset(box, { w: 300, h: 150 }));
        // From straight above the centre to 88° clockwise: snaps to 90.
        const angle = (88 - 90) * (Math.PI / 180);
        drag(canvas, knob, { x: box.cx + 40 * Math.cos(angle), y: box.cy + 40 * Math.sin(angle) });
        await waitFor(() => expect(savedClip(runtime, "s1").rotationDegrees).toBe(90));
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
        await act(async () => { await controllerRef!.execute({ type: "history.undo" }); });
        expect(savedClip(runtime, "s1").rotationDegrees).toBe(0);
        expect(runtime.store.getState().canUndo).toBe(false);
    });

    it("Shift snaps the rotation to 15° steps", async () => {
        const clip = sticker("s1", { scale: 3 });
        const { runtime, canvas, main } = await setup({ clips: [clip], tracks: [STICKER_TRACK], time: 1 });
        runtime.store.getState().setSelectedClipIds(new Set(["s1"]));
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const box = stickerBox(clip, 1);
        const { knob } = rotateKnob(box, rotateKnobOffset(box, { w: 300, h: 150 }));
        const angle = (37 - 90) * (Math.PI / 180);
        drag(canvas, knob, { x: box.cx + 40 * Math.cos(angle), y: box.cy + 40 * Math.sin(angle) }, { shiftKey: true });
        await waitFor(() => expect(savedClip(runtime, "s1").rotationDegrees).toBe(30));
    });

    it("on a keyframed rotation commits keyframe.set at the playhead and the sticker stays rotated", async () => {
        const clip = sticker("s1", { scale: 3, keyframesJson: JSON.stringify([{ time: 0, rotation_degrees: 0 }, { time: 4, rotation_degrees: 90 }]) });
        const { runtime, canvas, main } = await setup({ clips: [clip], tracks: [STICKER_TRACK], time: 2 });
        runtime.store.getState().setSelectedClipIds(new Set(["s1"]));
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const box = stickerBox(clip, 2);
        expect(box.rotation).toBeCloseTo(Math.PI / 4, 9);
        const { knob } = rotateKnob(box, rotateKnobOffset(box, { w: 300, h: 150 }));
        // The knob points at −45° (45° base rotation); turn it to +15° → 105°.
        const angle = 15 * (Math.PI / 180);
        drag(canvas, knob, { x: box.cx + 40 * Math.cos(angle), y: box.cy + 40 * Math.sin(angle) });
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
        const saved = savedClip(runtime, "s1");
        expect(saved.rotationDegrees).toBe(0);
        const key = parseTimelineKeyframes(saved.keyframesJson).find((p) => Math.abs(p.time - 2) < 1e-6)!;
        expect(key.rotation_degrees).toBeCloseTo(105, 1);
        expect(runtime.recording.calls.filter((c) => c.method === "updateClips" || c.method === "updateClip").length).toBe(1);
    });
});

describe("corner scale", () => {
    it("keeps the opposite corner in place (CapCut) and commits scale + position as one clip.update", async () => {
        const clip = sticker("s1", { scale: 3, positionX: 0.4, positionY: 0.6 });
        const { runtime, canvas, main } = await setup({ clips: [clip], tracks: [STICKER_TRACK], time: 1 });
        runtime.store.getState().setSelectedClipIds(new Set(["s1"]));
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const before = cornerPoints(stickerBox(clip, 1));
        const br = before[3];
        drag(canvas, br, { x: br.x + 12, y: br.y + 12 });
        await waitFor(() => expect(savedClip(runtime, "s1").scale).toBeGreaterThan(3));
        const saved = savedClip(runtime, "s1");
        const after = cornerPoints(stickerBox(saved, 1));
        expect(after[0].x).toBeCloseTo(before[0].x, 6);
        expect(after[0].y).toBeCloseTo(before[0].y, 6);
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
        await act(async () => { await controllerRef!.execute({ type: "history.undo" }); });
        expect(savedClip(runtime, "s1")).toMatchObject({ scale: 3, positionX: 0.4, positionY: 0.6 });
    });
});

describe("snapping guides", () => {
    it("snaps the centre to the frame centre and draws a white guide across the frame; Ctrl/Cmd moves freely", async () => {
        const clip = sticker("s1", { scale: 3, positionX: 0.3, positionY: 0.5 });
        const { runtime, canvas, main } = await setup({ clips: [clip], tracks: [STICKER_TRACK], time: 1 });
        await waitFor(() => expect(main()?.named("fillText").length ?? 0).toBeGreaterThan(0));
        const frame = frameRect();
        const box = stickerBox(clip, 1);
        const centreX = frame.x + frame.w / 2;
        const to = { x: box.cx + (centreX - box.cx) + 3, y: box.cy };
        fireEvent.pointerDown(canvas, { clientX: box.cx, clientY: box.cy, pointerId: 1 });
        fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
        const guideX = Math.round(centreX) + 0.5;
        await waitFor(() => {
            const ctx = main()!;
            expect(ctx.named("moveTo").some((call) => call.args[0] === guideX && call.args[1] === frame.y)).toBe(true);
            expect(ctx.named("lineTo").some((call) => call.args[0] === guideX && call.args[1] === frame.y + frame.h)).toBe(true);
        });
        expect(main()!.strokeStyle).toBeDefined();
        fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y, pointerId: 1 });
        await waitFor(() => expect(savedClip(runtime, "s1").positionX).toBeCloseTo(0.5, 9));

        // Ctrl held: no snap, the pointer wins.
        const box2 = stickerBox(savedClip(runtime, "s1"), 1);
        drag(canvas, { x: box2.cx, y: box2.cy }, { x: box2.cx + 3, y: box2.cy }, { ctrlKey: true });
        await waitFor(() => expect(savedClip(runtime, "s1").positionX).toBeGreaterThan(0.5));
    });
});

describe("scene handles", () => {
    it("dragging the selected scene's media commits scene.update (offset in % of the frame) once, undoably", async () => {
        const { runtime, canvas, main } = await setup({ scenes: [scene()], tracks: [VIDEO_TRACK], time: 1 });
        act(() => runtime.store.getState().selectScene("scene-1"));
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const frame = frameRect();
        const centre = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
        fireEvent.pointerDown(canvas, { clientX: centre.x, clientY: centre.y, pointerId: 1 });
        fireEvent.pointerMove(window, { clientX: centre.x + 20, clientY: centre.y, pointerId: 1 });
        // Live: the store follows the pointer (ScenePreview draws from it) before anything is written.
        expect(savedScene(runtime, "scene-1").transformOffsetX).toBeCloseTo((20 / frame.w) * 100, 3);
        fireEvent.pointerMove(window, { clientX: centre.x + 30, clientY: centre.y + 10, pointerId: 1 });
        expect(runtime.recording.calls.filter((c) => c.method === "updateScene")).toHaveLength(0);
        fireEvent.pointerUp(window, { clientX: centre.x + 30, clientY: centre.y + 10, pointerId: 1 });
        await waitFor(() => expect(runtime.recording.calls.filter((c) => c.method === "updateScene")).toHaveLength(1));
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
        expect(savedScene(runtime, "scene-1").transformOffsetX).toBeCloseTo((30 / frame.w) * 100, 3);
        expect(savedScene(runtime, "scene-1").transformOffsetY).toBeCloseTo((10 / frame.h) * 100, 3);
        expect(runtime.recording.calls.filter((c) => c.method === "updateScene")).toHaveLength(1);
        await act(async () => { await controllerRef!.execute({ type: "history.undo" }); });
        expect(Number(savedScene(runtime, "scene-1").transformOffsetX ?? 0)).toBe(0);
        expect(runtime.store.getState().canUndo).toBe(false);
    });

    it("rotating a scene with keyframed rotation commits keyframe.set (sceneId) at the scene-local playhead", async () => {
        const keyed = scene({ keyframesJson: JSON.stringify([{ time: 0, rotation_degrees: 0 }, { time: 10, rotation_degrees: 20 }]) });
        const { runtime, canvas, main } = await setup({ scenes: [keyed], tracks: [VIDEO_TRACK], time: 5 });
        act(() => runtime.store.getState().selectScene("scene-1"));
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const frame = frameRect();
        const box: HandleBox = { cx: frame.x + frame.w / 2, cy: frame.y + frame.h / 2, w: frame.w, h: frame.h, rotation: (10 * Math.PI) / 180 };
        const offset = rotateKnobOffset(box, { w: 300, h: 150 });
        // A full-frame scene's knob would leave the canvas: it is tucked inside below the top edge.
        expect(offset).toBeLessThan(0);
        const { knob } = rotateKnob(box, offset);
        // Knob at −80°; turn to −60° → 30°.
        const angle = -60 * (Math.PI / 180);
        drag(canvas, knob, { x: box.cx + 30 * Math.cos(angle), y: box.cy + 30 * Math.sin(angle) });
        await waitFor(() => expect(runtime.recording.calls.filter((c) => c.method === "updateScene")).toHaveLength(1));
        const saved = savedScene(runtime, "scene-1");
        expect(Number(saved.rotationDegrees ?? 0)).toBe(0);
        const key = parseTimelineKeyframes(saved.keyframesJson).find((p) => Math.abs(p.time - 5) < 1e-6)!;
        expect(key.rotation_degrees).toBeCloseTo(30, 1);
    });

    it("clicking an empty area of the frame over a scene selects the scene (overlays still win)", async () => {
        const clip = sticker("s1", { scale: 3, positionX: 0.1, positionY: 0.1 });
        const { runtime, canvas, main } = await setup({ clips: [clip], scenes: [scene()], tracks: [VIDEO_TRACK, STICKER_TRACK], time: 1 });
        await waitFor(() => expect(main()?.named("fillText").length ?? 0).toBeGreaterThan(0));
        const box = stickerBox(clip, 1);
        fireEvent.pointerDown(canvas, { clientX: box.cx, clientY: box.cy, pointerId: 1 });
        fireEvent.pointerUp(window, { clientX: box.cx, clientY: box.cy, pointerId: 1 });
        expect(runtime.store.getState().selectedClipIds.has("s1")).toBe(true);
        const frame = frameRect();
        fireEvent.pointerDown(canvas, { clientX: frame.x + frame.w * 0.7, clientY: frame.y + frame.h * 0.7, pointerId: 2 });
        fireEvent.pointerUp(window, { clientX: frame.x + frame.w * 0.7, clientY: frame.y + frame.h * 0.7, pointerId: 2 });
        expect(runtime.store.getState().selectedSceneId).toBe("scene-1");
        expect(runtime.store.getState().selectedClipIds.size).toBe(0);
        // A click without movement writes nothing.
        expect(runtime.recording.calls.filter((c) => c.method === "updateScene")).toHaveLength(0);
    });
});

describe("keyboard nudge", () => {
    it("arrows move the selected sticker 1 px (Shift 10 px) as one coalesced undo step; Delete is left alone", async () => {
        const clip = sticker("s1", { scale: 3 });
        const { runtime, canvas, main } = await setup({ clips: [clip], tracks: [STICKER_TRACK], time: 1 });
        runtime.store.getState().setSelectedClipIds(new Set(["s1"]));
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const frame = frameRect();
        const span = frame.w - stickerBox(clip, 1).w;
        canvas.focus();
        fireEvent.keyDown(canvas, { key: "ArrowRight" });
        fireEvent.keyDown(canvas, { key: "ArrowRight" });
        fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true });
        expect(savedClip(runtime, "s1").positionX).toBeCloseTo(0.5 + 12 / span, 9);
        const del = fireEvent.keyDown(canvas, { key: "Delete" });
        expect(del).toBe(true);
        // The burst is written once, after the debounce.
        const writes = () => runtime.recording.calls.filter((c) => c.method === "updateClips" || c.method === "updateClip");
        expect(writes()).toHaveLength(0);
        await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
        await act(async () => { await controllerRef!.execute({ type: "history.undo" }); });
        expect(savedClip(runtime, "s1").positionX).toBe(0.5);
        expect(runtime.store.getState().canUndo).toBe(false);
    });
});

describe("group gestures reach selected items off the playhead (phase 10d)", () => {
    it("a group nudge moves the visible sticker by pixels and a later, keyframed one by the same frame fraction: one undo step", async () => {
        const visible = sticker("s1", { scale: 3 });
        const later = sticker("s2", {
            startTime: 5, endTime: 8, positionX: 0.3,
            keyframesJson: JSON.stringify({ keyframes: [{ time: 0, position_x: 0.2, position_y: 0.4 }, { time: 2, position_x: 0.6, position_y: 0.4 }] }),
        });
        const { runtime, canvas, main } = await setup({ clips: [visible, later], tracks: [STICKER_TRACK], time: 1 });
        runtime.store.getState().setSelectedClipIds(new Set(["s1", "s2"]));
        // The group box (around the one visible member) is drawn.
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const frame = frameRect();
        const span = frame.w - stickerBox(visible, 1).w;
        canvas.focus();
        fireEvent.keyDown(canvas, { key: "ArrowRight", shiftKey: true });
        expect(savedClip(runtime, "s1").positionX).toBeCloseTo(0.5 + 10 / span, 6);
        const moved = savedClip(runtime, "s2");
        expect(moved.positionX).toBeCloseTo(0.3 + 10 / frame.w, 5);
        expect(parseTimelineKeyframes(moved.keyframesJson).map((p) => [p.time, p.position_x, p.position_y])).toEqual([
            // Keyframe values keep three decimals (keyframes v2).
            [0, expect.closeTo(0.2 + 10 / frame.w, 3), 0.4], [2, expect.closeTo(0.6 + 10 / frame.w, 3), 0.4],
        ]);
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true), { timeout: 3000 });
        await act(async () => { await controllerRef!.execute({ type: "history.undo" }); });
        expect(savedClip(runtime, "s1").positionX).toBe(0.5);
        expect(savedClip(runtime, "s2").positionX).toBe(0.3);
        expect(parseTimelineKeyframes(savedClip(runtime, "s2").keyframesJson)[0].position_x).toBe(0.2);
        expect(runtime.store.getState().canUndo).toBe(false);
    });

    it("a group drag (move) writes the follower's delta in the same items.transform", async () => {
        const visible = sticker("s1", { scale: 3 });
        const later = sticker("s2", { startTime: 5, endTime: 8, positionX: 0.3, positionY: 0.7 });
        const { runtime, canvas, main } = await setup({ clips: [visible, later], tracks: [STICKER_TRACK], time: 1 });
        runtime.store.getState().setSelectedClipIds(new Set(["s1", "s2"]));
        await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
        const box = stickerBox(visible, 1);
        const frame = frameRect();
        // Ctrl: no snapping, the drag is exactly 20 × 10 px.
        drag(canvas, { x: box.cx, y: box.cy }, { x: box.cx + 20, y: box.cy + 10 }, { ctrlKey: true });
        await waitFor(() => expect(savedClip(runtime, "s2").positionX).toBeCloseTo(0.3 + 20 / frame.w, 5));
        expect(savedClip(runtime, "s2").positionY).toBeCloseTo(0.7 + 10 / frame.h, 5);
        expect(savedClip(runtime, "s1").positionX).toBeCloseTo(0.5 + 20 / (frame.w - box.w), 5);
        await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true), { timeout: 3000 });
        await act(async () => { await controllerRef!.execute({ type: "history.undo" }); });
        expect([savedClip(runtime, "s1").positionX, savedClip(runtime, "s2").positionX]).toEqual([0.5, 0.3]);
    });
});
