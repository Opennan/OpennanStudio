// The compositor (PreviewPanel) and masks (phase 10c): a masked V2 clip is drawn through the looks renderer with
// the mask step at item time; with the Mask tab open its mask handles replace the transform chrome, and a handle
// drag is one mask.set gesture (live coalesced writes, one undo step).
import { fireEvent, waitFor } from "@testing-library/react";
import { optimistic, type TimelineTrack } from "@opennan/timeline-core";
import { parseMask } from "@opennan/timeline-core/looks/masks";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { RecordingContext } from "./test-fixtures";

const fake = {
    isLost: false,
    canvas: { tag: "gl-canvas" },
    upload: vi.fn((_source: unknown, width: number, height: number) => ({ id: "u", width, height })),
    resize: vi.fn((_frame: unknown, width: number, height: number) => ({ id: "r", width, height })),
    lutMix: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    look: vi.fn((frame: unknown, ..._rest: unknown[]) => frame),
    presentRegion: vi.fn((_frame: unknown, width: number, height: number) => ({ x: 0, y: 0, width, height })),
    releaseAll: vi.fn(),
    onContextLost: () => () => {},
};
vi.mock("../use-look-renderer", () => ({ useLookRenderer: () => fake, lookRendererSupported: () => false }));

const { PreviewPanel } = await import("../preview-panel");

class LoadedImage {
    complete = true;
    naturalWidth = 1280;
    naturalHeight = 720;
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
}

const contexts = new Map<HTMLCanvasElement, RecordingContext>();
beforeEach(() => {
    contexts.clear();
    vi.stubGlobal("ResizeObserver", class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    vi.stubGlobal("Image", LoadedImage);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
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
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const VIDEO_1: TimelineTrack = { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 };
const VIDEO_2: TimelineTrack = { type: "video", index: 2, label: "V2", muted: false, locked: false, visible: true, volume: 1 };

async function renderMasked(maskEditing: boolean) {
    const runtime = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput(
        { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/still.png", mediaType: "image", scale: 1, maskJson: '{"shape":"circle","width":0.5,"height":0.5}' },
        runtime.projectId, "v2",
    );
    await seedTimeline(runtime, { tracks: [VIDEO_1, VIDEO_2], clips: [clip] });
    runtime.store.getState().setCurrentTime(1.5);
    runtime.store.getState().setSelectedClipIds(new Set(["v2"]));
    runtime.store.getState().setMaskEditing(maskEditing);
    renderWithTimeline(<PreviewPanel />, { runtime });
    const main = () => [...contexts.entries()].find(([canvas]) => canvas.isConnected)?.[1];
    return { runtime, main };
}

it("draws a masked clip through the renderer with the mask step at item time", async () => {
    await renderMasked(false);
    await waitFor(() => expect(fake.look).toHaveBeenCalled());
    const [, plan, t] = fake.look.mock.calls.at(-1) as [unknown, { steps: Array<{ kind: string }> }, number];
    expect(plan.steps.map((s) => s.kind)).toEqual(["mask"]);
    expect(t).toBeCloseTo(1.5, 9);
});

it("with the Mask tab open, the mask handles replace the transform chrome and a move drag is one undoable mask.set", async () => {
    const { runtime, main } = await renderMasked(true);
    // The mask chrome: the item box dashed, then the outline and round handles.
    await waitFor(() => expect(main()?.named("setLineDash").some((c) => JSON.stringify(c.args[0]) === "[4,4]")).toBe(true));
    const canvas = [...contexts.keys()].find((c) => c.isConnected)!;
    canvas.setPointerCapture = () => {};
    canvas.hasPointerCapture = () => false;
    canvas.releasePointerCapture = () => {};
    // The item box's centre: the translate before the dashed strokeRect.
    const calls = main()!.calls;
    const rectAt = calls.map((c) => c.name).lastIndexOf("strokeRect");
    const [cx, cy] = calls.slice(0, rectAt).reverse().find((c) => c.name === "translate")!.args as number[];
    const [, , bw] = calls[rectAt].args as number[];
    const controller = (await import("../../provider/registry")).getActiveRuntime()!.controller;
    const execute = vi.spyOn(controller, "execute");
    fireEvent.pointerDown(canvas, { clientX: cx, clientY: cy, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: cx + bw / 10, clientY: cy, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: cx + bw / 5, clientY: cy, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: cx + bw / 5, clientY: cy, pointerId: 1 });
    const clipNow = () => runtime.store.getState().timelineData!.clips.find((c) => c.id === "v2")!;
    expect(execute.mock.calls.map(([command]) => (command as { type: string }).type)).toContain("mask.set");
    await waitFor(() => expect(parseMask(clipNow().maskJson)!.x).toBeCloseTo(0.7, 3));
    const saved = clipNow();
    // The clip itself did not move.
    expect(saved.positionX).toBe(0.5);
    const maskCommands = execute.mock.calls.filter(([command]) => (command as { type: string }).type === "mask.set");
    expect(maskCommands.length).toBeGreaterThanOrEqual(2);
    expect(new Set(maskCommands.map(([, options]) => (options as { coalesceKey: string }).coalesceKey)).size).toBe(1);
    // One undo step takes the whole drag back.
    await controller.execute({ type: "history.undo" });
    await waitFor(() => expect(parseMask(runtime.store.getState().timelineData!.clips.find((c) => c.id === "v2")!.maskJson)!.x).toBe(0.5));
});

it("unmounting mid mask drag removes the window listeners (later pointer moves write nothing)", async () => {
    const runtime = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput(
        { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/still.png", mediaType: "image", scale: 1, maskJson: '{"shape":"circle","width":0.5,"height":0.5}' },
        runtime.projectId, "v2",
    );
    await seedTimeline(runtime, { tracks: [VIDEO_1, VIDEO_2], clips: [clip] });
    runtime.store.getState().setCurrentTime(1.5);
    runtime.store.getState().setSelectedClipIds(new Set(["v2"]));
    runtime.store.getState().setMaskEditing(true);
    const view = renderWithTimeline(<PreviewPanel />, { runtime });
    const main = () => [...contexts.entries()].find(([canvas]) => canvas.isConnected)?.[1];
    await waitFor(() => expect(main()?.named("setLineDash").some((c) => JSON.stringify(c.args[0]) === "[4,4]")).toBe(true));
    const canvas = [...contexts.keys()].find((c) => c.isConnected)!;
    canvas.setPointerCapture = () => {};
    canvas.hasPointerCapture = () => false;
    canvas.releasePointerCapture = () => {};
    const calls = main()!.calls;
    const rectAt = calls.map((c) => c.name).lastIndexOf("strokeRect");
    const [cx, cy] = calls.slice(0, rectAt).reverse().find((c) => c.name === "translate")!.args as number[];
    const [, , bw] = calls[rectAt].args as number[];
    const controller = (await import("../../provider/registry")).getActiveRuntime()!.controller;
    const execute = vi.spyOn(controller, "execute");
    const removed = vi.spyOn(window, "removeEventListener");
    fireEvent.pointerDown(canvas, { clientX: cx, clientY: cy, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: cx + bw / 10, clientY: cy, pointerId: 1 });
    const maskSets = () => execute.mock.calls.filter(([command]) => (command as { type: string }).type === "mask.set").length;
    expect(maskSets()).toBe(1);
    view.unmount();
    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]));
    const afterUnmount = maskSets();
    fireEvent.pointerMove(window, { clientX: cx + bw / 5, clientY: cy, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: cx + bw / 5, clientY: cy, pointerId: 1 });
    expect(maskSets()).toBe(afterUnmount);
});

const TEXT_1: TimelineTrack = { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 };
const STICKER_1: TimelineTrack = { type: "sticker", index: 1, label: "S1", muted: false, locked: false, visible: true, volume: 1 };

it("masks text and emoji stickers through the renderer's mask pass, in the item box (phase 10d)", async () => {
    const runtime = createTimelineTestRuntime();
    const maskJson = '{"shape":"star","width":0.8,"height":0.8}';
    const text = optimistic.optimisticTimelineClipFromInput(
        { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Masked", maskJson, keyframesJson: JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 4, mask_x: 0.8 }] }) },
        runtime.projectId, "t1",
    );
    const emoji = optimistic.optimisticTimelineClipFromInput({ trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, textContent: "★", maskJson }, runtime.projectId, "e1");
    const plain = optimistic.optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Plain" }, runtime.projectId, "t2");
    await seedTimeline(runtime, { tracks: [VIDEO_1, TEXT_1, STICKER_1], clips: [text, emoji, plain] });
    runtime.store.getState().setCurrentTime(2);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(fake.look.mock.calls.length).toBeGreaterThanOrEqual(2));
    const calls = fake.look.mock.calls as unknown as Array<[{ width: number; height: number }, { steps: Array<{ kind: string; mask?: { shape: string } }> }, number, number, { x: number; y: number; width: number; height: number }]>;
    // Each masked layer: a mask-only plan at item time, with the item box inside the uploaded layer.
    for (const [frame, plan, t, keyframeTime, box] of calls.slice(-2)) {
        expect(plan.steps.map((s) => s.kind)).toEqual(["mask"]);
        expect(plan.steps[0].mask?.shape).toBe("star");
        expect([t, keyframeTime]).toEqual([2, 2]);
        expect(box.x).toBeGreaterThan(0);
        expect(box.y).toBeGreaterThan(0);
        expect(box.x + box.width).toBeLessThan(frame.width);
        expect(box.y + box.height).toBeLessThan(frame.height);
    }
    // The emoji layer pads its box by a quarter on every side.
    const [emojiFrame, , , , emojiBox] = calls.at(-1)!;
    expect(emojiBox.x / emojiFrame.width).toBeCloseTo(1 / 6, 2);
    expect(emojiBox.width / emojiFrame.width).toBeCloseTo(2 / 3, 2);
    // Unmasked text never goes through the renderer: two masked layers, two uploads per frame drawn.
    expect(fake.upload.mock.calls.length % 2).toBe(0);
});
