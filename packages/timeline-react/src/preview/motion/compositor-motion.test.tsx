// The compositor (PreviewPanel) draws text states and animated overlays through the motion helpers.
// jsdom has no canvas: every canvas gets a recording context.
import { fireEvent, waitFor } from "@testing-library/react";
import { optimistic, type TimelineTrack } from "@opennan/timeline-core";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import { PreviewPanel } from "../preview-panel";
import { createTimelineTestRuntime, renderWithTimeline, seedTimeline } from "../../test-utils/render-with-timeline";
import { RecordingContext } from "./test-fixtures";
import { clipMotionAt, placedBox } from "./clip-motion";
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

const TEXT_TRACK: TimelineTrack = { type: "text", index: 1, label: "T1", muted: false, locked: false, visible: true, volume: 1 };
const STICKER_TRACK: TimelineTrack = { type: "sticker", index: 1, label: "S1", muted: false, locked: false, visible: true, volume: 1 };

async function renderAt(clips: ReturnType<typeof optimistic.optimisticTimelineClipFromInput>[], tracks: TimelineTrack[], time: number) {
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks, clips });
    runtime.store.getState().setCurrentTime(time);
    renderWithTimeline(<PreviewPanel />, { runtime });
    const main = () => [...contexts.entries()].find(([canvas]) => canvas.isConnected)?.[1];
    return { runtime, main };
}

it("draws a typewriter text state: the bitmap holds only the visible glyphs and is placed on the main canvas", async () => {
    const runtime0 = createTimelineTestRuntime();
    const clip = {
        ...optimistic.optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Hello world" }, runtime0.projectId, "t1"),
        animationJson: JSON.stringify({ in: { id: "typewriter", duration: 1 } }),
    };
    const { main } = await renderAt([clip], [TEXT_TRACK], 0.5);
    await waitFor(() => expect(main()?.named("drawImage").length ?? 0).toBeGreaterThan(0));
    const bitmapCtx = [...contexts.entries()].find(([canvas, ctx]) => !canvas.isConnected && ctx.named("fillText").length > 0)?.[1];
    expect(bitmapCtx).toBeDefined();
    const drawn = bitmapCtx!.named("fillText").map((call) => String(call.args[0])).join("").replace(/\s/g, "");
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan("Helloworld".length);
    expect("Helloworld".startsWith(drawn)).toBe(true);
});

it("places an animated emoji sticker with its motion (slide offset, fade) about the box centre", async () => {
    const runtime0 = createTimelineTestRuntime();
    const clip = {
        ...optimistic.optimisticTimelineClipFromInput({ trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, textContent: "🔥" }, runtime0.projectId, "s1"),
        animationJson: JSON.stringify({ in: { id: "slide_left", duration: 1 } }),
    };
    const { main } = await renderAt([clip], [STICKER_TRACK], 0.5);
    await waitFor(() => expect(main()?.named("fillText").length ?? 0).toBeGreaterThan(0));
    const ctx = main()!;
    const translate = ctx.named("translate")[0].args as number[];
    // Recompute the expected centre from the same channels with the frame the panel used.
    const sample = clipMotionAt(clip, 0.5);
    expect(sample.dx).not.toBe(0);
    const canvas = [...contexts.keys()].find((c) => c.isConnected)!;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const { w: fw, h: fh } = getPreviewScreenFrame({ w, h }, 16 / 9);
    const frame = { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
    const side = 64 * 1.2 * (fh / 1080);
    const want = placedBox(frame, { w: side, h: side }, sample);
    expect(translate[0]).toBeCloseTo(want.cx, 6);
    expect(translate[1]).toBeCloseTo(want.cy, 6);
});

it("a move drag on a keyframed sticker commits a keyframe at the playhead, undoably, and the clip stays put", async () => {
    const runtime0 = createTimelineTestRuntime();
    const clip = {
        ...optimistic.optimisticTimelineClipFromInput({ trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, textContent: "🔥" }, runtime0.projectId, "s1"),
        keyframesJson: JSON.stringify([{ time: 0, position_x: 0.2, position_y: 0.5 }, { time: 4, position_x: 0.6, position_y: 0.5 }]),
    };
    const { runtime, main } = await renderAt([clip], [STICKER_TRACK], 2);
    await waitFor(() => expect(main()?.named("fillText").length ?? 0).toBeGreaterThan(0));
    const canvas = [...contexts.keys()].find((c) => c.isConnected)!;
    canvas.setPointerCapture = () => {};
    canvas.hasPointerCapture = () => false;
    canvas.releasePointerCapture = () => {};
    const [cx, cy] = main()!.named("translate")[0].args as number[];
    fireEvent.pointerDown(canvas, { clientX: cx, clientY: cy, pointerId: 1 });
    expect(runtime.store.getState().selectedClipIds.has("s1")).toBe(true);
    fireEvent.pointerMove(window, { clientX: cx + 30, clientY: cy, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: cx + 30, clientY: cy, pointerId: 1 });
    await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
    const saved = runtime.store.getState().timelineData!.clips.find((c) => c.id === "s1")!;
    expect(saved.positionX).toBe(clip.positionX);
    const key = parseTimelineKeyframes(saved.keyframesJson).find((point) => Math.abs(point.time - 2) < 1e-6)!;
    expect(key.position_x).toBeGreaterThan(0.4);
    expect(key.position_y).toBeCloseTo(0.5, 9);
});

it("a text corner drag reuses the last bitmap while the scale changes and draws the exact scale on release", async () => {
    const runtime0 = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Hello world" }, runtime0.projectId, "t1");
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [TEXT_TRACK], clips: [clip] });
    runtime.store.getState().setCurrentTime(1);
    runtime.store.getState().setSelectedClipIds(new Set(["t1"]));
    renderWithTimeline(<PreviewPanel />, { runtime });
    const main = () => [...contexts.entries()].find(([canvas]) => canvas.isConnected)?.[1];
    await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
    const bitmaps = () => [...contexts.entries()].filter(([canvas, ctx]) => !canvas.isConnected && ctx.named("fillText").length > 0).length;
    const before = bitmaps();
    expect(before).toBeGreaterThan(0);
    // The selection box: the translate before the last strokeRect is its centre.
    const calls = main()!.calls;
    const rectAt = calls.map((c) => c.name).lastIndexOf("strokeRect");
    const centre = calls.slice(0, rectAt).reverse().find((c) => c.name === "translate")!.args as number[];
    const [, , bw, bh] = calls[rectAt].args as number[];
    const canvas = [...contexts.keys()].find((c) => c.isConnected)!;
    canvas.setPointerCapture = () => {};
    canvas.hasPointerCapture = () => false;
    canvas.releasePointerCapture = () => {};
    const corner = { x: centre[0] + bw / 2, y: centre[1] + bh / 2 };
    fireEvent.pointerDown(canvas, { clientX: corner.x, clientY: corner.y, pointerId: 1 });
    for (let i = 1; i <= 6; i += 1) {
        fireEvent.pointerMove(window, { clientX: corner.x + i * 4, clientY: corner.y + i * 2, pointerId: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // At most one extra bitmap while the scale moves (×2 from the first), not one per move.
    expect(bitmaps() - before).toBeLessThanOrEqual(1);
    fireEvent.pointerUp(window, { clientX: corner.x + 24, clientY: corner.y + 12, pointerId: 1 });
    await waitFor(() => expect(bitmaps()).toBeGreaterThan(before));
    await waitFor(() => expect(runtime.store.getState().canUndo).toBe(true));
});

it("re-reads the selection chrome colours when the theme on <html> changes", async () => {
    let ring = "rgb(1, 2, 3)";
    const realComputed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element) => {
        const styles = realComputed(el);
        return new Proxy(styles, {
            get(target, prop) {
                if (prop === "getPropertyValue") return (name: string) => (name === "--timeline-selection-ring" ? ring : target.getPropertyValue(name));
                const value = Reflect.get(target, prop);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    }) as typeof window.getComputedStyle);
    const runtime0 = createTimelineTestRuntime();
    const clip = optimistic.optimisticTimelineClipFromInput({ trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "Hello" }, runtime0.projectId, "t1");
    const runtime = createTimelineTestRuntime();
    await seedTimeline(runtime, { tracks: [TEXT_TRACK], clips: [clip] });
    runtime.store.getState().setCurrentTime(1);
    runtime.store.getState().setSelectedClipIds(new Set(["t1"]));
    renderWithTimeline(<PreviewPanel />, { runtime });
    const main = () => [...contexts.entries()].find(([canvas]) => canvas.isConnected)?.[1];
    await waitFor(() => expect(main()?.named("strokeRect").length ?? 0).toBeGreaterThan(0));
    const ctx = main()!;
    const ringColours: unknown[] = [];
    const strokeRect = ctx.strokeRect.bind(ctx);
    ctx.strokeRect = (...args: unknown[]) => { ringColours.push(ctx.strokeStyle); strokeRect(...args); };
    runtime.store.getState().setCurrentTime(1.5);
    await waitFor(() => expect(ringColours).toContain("rgb(1, 2, 3)"));
    ring = "rgb(9, 8, 7)";
    document.documentElement.setAttribute("data-theme", "other");
    await waitFor(() => expect(ringColours).toContain("rgb(9, 8, 7)"));
    document.documentElement.removeAttribute("data-theme");
});
