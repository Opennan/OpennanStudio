// The compositor (PreviewPanel) stacks like both exports (phase 11): scene lanes, V2+ media, built-in graphics,
// text and stickers, then the effect layers over all of them. Built-in graphics are drawn on the compositor canvas
// (the 10d renderer) while it composites, and the DOM graphics layer leaves them out; an effect alone at the
// playhead turns the compositor on, so the preview never runs an effect over the footage only.
import { waitFor } from "@testing-library/react";
import { optimistic, type TimelineClip, type TimelineTrack } from "@opennan/timeline-core";
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

// The template draw itself is the 10d renderer's (tested in timeline-core): here it only marks the layer it paints
// on and reports bounds in the lower part of the frame.
const draw = vi.hoisted(() => vi.fn((ctx: { fillText(text: string, x: number, y: number): void }, clip: { remotionCode?: string | null } | undefined, options: { width: number; height: number }) => {
    if (!clip || clip.remotionCode) return null;
    ctx.fillText("GRAPHIC", 0, 0);
    return { x: options.width * 0.1, y: options.height * 0.7, width: options.width * 0.4, height: options.height * 0.15 };
}));
vi.mock("@opennan/timeline-core/graphics/render", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@opennan/timeline-core/graphics/render")>()),
    drawGraphicsFrame: draw,
}));

const { PreviewPanel } = await import("../preview-panel");

class LoadedImage {
    complete = true;
    naturalWidth = 640;
    naturalHeight = 360;
    crossOrigin: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
}

const contexts = new Map<object, RecordingContext>();
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
    // jsdom lays nothing out: give the preview area a size so the frame rect is not empty.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const track = (type: TimelineTrack["type"], index: number): TimelineTrack => ({ type, index, label: `${type}${index}`, muted: false, locked: false, visible: true, volume: 1 });

function clip(id: string, input: Record<string, unknown>, projectId: string): TimelineClip {
    return optimistic.optimisticTimelineClipFromInput(input as never, projectId, id);
}

function effectClip(projectId: string): TimelineClip {
    return {
        ...clip("fx", { trackType: "effect", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "effect" }, projectId),
        effects: [{ id: "row", clipId: "fx", sceneId: null, effectId: "fx_black_white", order: 0, paramsJson: null, enabled: true, ownerScope: "clip" }],
    };
}

function graphicClip(projectId: string, overrides: Record<string, unknown> = {}): TimelineClip {
    return { ...clip("g1", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "remotion" }, projectId), remotionTemplateId: "lower-third", remotionPropsJson: null, remotionCode: null, ...overrides } as TimelineClip;
}

/** The connected (on-screen) compositor canvas's recording context. */
function main(): RecordingContext | undefined {
    const canvas = document.querySelector("canvas[data-preview-canvas]");
    return canvas ? contexts.get(canvas) : undefined;
}

/** What a drawImage source is: the V2 still, the graphics layer, the text bitmap, the effect result, or other. */
function sourceKind(source: unknown): string {
    if (source instanceof LoadedImage) return "v2";
    if (source === fake.canvas) return "effect";
    const ctx = contexts.get(source as object);
    const texts = ctx?.named("fillText").map((call) => String(call.args[0])) ?? [];
    if (texts.includes("GRAPHIC")) return "graphic";
    if (texts.some((text) => text.includes("Hello"))) return "text";
    return "other";
}

/** Kinds of the main canvas's drawImage calls since its last full clear, in order. */
function frameDraws(ctx: RecordingContext | undefined): string[] {
    if (!ctx) return [];
    let start = 0;
    ctx.calls.forEach((call, i) => {
        if (call.name === "clearRect" && call.args[0] === 0 && call.args[1] === 0) start = i;
    });
    return ctx.calls.slice(start).filter((call) => call.name === "drawImage").map((call) => sourceKind(call.args[0])).filter((kind) => kind !== "other");
}

async function seedAll(withEffect: boolean, graphic: Partial<TimelineClip> = {}) {
    const runtime = createTimelineTestRuntime();
    const id = runtime.projectId;
    const clips = [
        clip("v2", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/still.png", mediaType: "image", scale: 0.5 }, id),
        graphicClip(id, graphic),
        clip("t1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, mediaType: "text", textContent: "Hello" }, id),
        ...(withEffect ? [effectClip(id)] : []),
    ];
    await seedTimeline(runtime, { tracks: [track("video", 1), track("video", 2), track("remotion", 1), track("text", 1), track("effect", 1)], clips });
    runtime.store.getState().setTimelineData({ ...runtime.store.getState().timelineData!, clips });
    runtime.store.getState().setCurrentTime(2);
    return runtime;
}

it("draws built-in graphics after V2+ media and before text, and the effect pass after all of them", async () => {
    const runtime = await seedAll(true);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(frameDraws(main())).toEqual(["v2", "graphic", "text", "effect"]));
    // The effect ran on the composite that holds the canvas (V2 + graphic + text) and was stamped back.
    expect(fake.look).toHaveBeenCalled();
    const [, plan] = fake.look.mock.calls.at(-1) as [unknown, { steps: Array<{ kind: string }> }];
    expect(plan.steps.length).toBeGreaterThan(0);
});

it("without an effect the compositor still draws the graphic between V2+ media and text", async () => {
    const runtime = await seedAll(false);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(frameDraws(main())).toEqual(["v2", "graphic", "text"]));
    expect(fake.look).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ steps: expect.arrayContaining([expect.objectContaining({ kind: "effect" })]) }), expect.anything());
});

it("hides built-in graphics from the DOM layer while the compositor draws them", async () => {
    const runtime = await seedAll(false);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(frameDraws(main())).toContain("graphic"));
    await waitFor(() => expect(document.querySelector('[data-remotion-clip-id="g1"]')).toBeNull());
});

it("keeps the DOM graphics layer when nothing needs the compositor", async () => {
    const runtime = createTimelineTestRuntime();
    const clips = [graphicClip(runtime.projectId)];
    await seedTimeline(runtime, { tracks: [track("video", 1), track("remotion", 1)], clips });
    runtime.store.getState().setTimelineData({ ...runtime.store.getState().timelineData!, clips });
    runtime.store.getState().setCurrentTime(2);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(document.querySelector('[data-remotion-clip-id="g1"]')).not.toBeNull());
    await waitFor(() => expect(main()?.named("clearRect").length).toBeGreaterThan(0));
    expect(frameDraws(main())).not.toContain("graphic");
});

it("custom-code graphics keep the DOM layer (the canvas cannot draw them)", async () => {
    const runtime = await seedAll(false, { remotionCode: "export default () => null;" });
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(frameDraws(main())).toEqual(["v2", "text"]));
    expect(frameDraws(main())).not.toContain("graphic");
});

it("an effect alone at the playhead turns the compositor on and runs the effect over the graphic", async () => {
    const runtime = createTimelineTestRuntime();
    const clips = [graphicClip(runtime.projectId), effectClip(runtime.projectId)];
    await seedTimeline(runtime, { tracks: [track("video", 1), track("remotion", 1), track("effect", 1)], clips });
    runtime.store.getState().setTimelineData({ ...runtime.store.getState().timelineData!, clips });
    runtime.store.getState().setCurrentTime(2);
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(frameDraws(main())).toEqual(["graphic", "effect"]));
    // The canvas shows (it composites) and the DOM layer leaves the built-in graphic to it.
    const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-preview-canvas]")!;
    await waitFor(() => expect(canvas.style.opacity).toBe("1"));
    expect(document.querySelector('[data-remotion-clip-id="g1"]')).toBeNull();
});

it("the selected graphic's box comes from the bounds the renderer returns", async () => {
    const runtime = await seedAll(false);
    runtime.store.getState().setSelectedClipIds(new Set(["g1"]));
    renderWithTimeline(<PreviewPanel />, { runtime });
    await waitFor(() => expect(frameDraws(main())).toContain("graphic"));
    await waitFor(() => expect(main()!.named("strokeRect").length).toBeGreaterThan(0));
    const calls = main()!.calls;
    // The project frame: the clip rect the graphic layer is painted in.
    const clipAt = calls.findIndex((c, i) => c.name === "rect" && calls[i + 1]?.name === "clip");
    const [fx, fy, fw, fh] = calls[clipAt].args as number[];
    // The chrome is drawn about the box centre: the frame's (0.1 + 0.2, 0.7 + 0.075) fractions, 0.4 × 0.15 of it.
    const rectAt = calls.map((c) => c.name).lastIndexOf("strokeRect");
    const [cx, cy] = calls.slice(0, rectAt).reverse().find((c) => c.name === "translate")!.args as number[];
    const [, , bw, bh] = calls[rectAt].args as number[];
    expect(fw).toBeGreaterThan(100);
    expect(cx).toBeCloseTo(fx + 0.3 * fw, 0);
    expect(cy).toBeCloseTo(fy + 0.775 * fh, 0);
    expect(Math.abs(bw)).toBeCloseTo(0.4 * fw, 0);
    expect(Math.abs(bh)).toBeCloseTo(0.15 * fh, 0);
});
