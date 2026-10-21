import { graphicsLayerMatrix } from "@opennan/timeline-core/graphics/layer";
import { GraphicsLayerCache, graphicsBoundsFractions, paintGraphicsLayer } from "./graphics-layer";
import { RecordingContext, recordingCanvasFactory, testClip } from "./test-fixtures";

// The template draw is the 10d renderer's (tested in timeline-core): here it marks the layer and reports bounds.
const draw = vi.hoisted(() => vi.fn((ctx: { fillText(text: string, x: number, y: number): void }, clip: { remotionCode?: string | null; remotionTemplateId?: string | null; remotionPropsJson?: string | null }, options: { width: number; height: number; assets?: { image(url: string): unknown } }) => {
    if (!clip) return null;
    if (clip.remotionCode) return null;
    if (clip.remotionTemplateId === "logo-sting") options.assets?.image(JSON.parse(clip.remotionPropsJson ?? "{}").logoUrl);
    ctx.fillText("GRAPHIC", 0, 0);
    return { x: options.width * 0.25, y: options.height * 0.5, width: options.width * 0.5, height: options.height * 0.25 };
}));
vi.mock("@opennan/timeline-core/graphics/render", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@opennan/timeline-core/graphics/render")>()),
    drawGraphicsFrame: draw,
}));

const graphic = (overrides: Record<string, unknown> = {}) => testClip({ id: "g", trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 4, remotionTemplateId: "lower-third", remotionPropsJson: null, remotionCode: null, ...overrides } as never);

function cache(assets: { image?: (url: string) => CanvasImageSource | null; settled?: (url: string) => boolean } = {}) {
    const factory = recordingCanvasFactory();
    const layers = new GraphicsLayerCache({
        createCanvas: () => factory.createCanvas(0, 0),
        assetImage: assets.image ?? (() => null),
        assetSettled: assets.settled ?? (() => true),
    });
    return { layers, factory };
}

beforeEach(() => draw.mockClear());

describe("GraphicsLayerCache", () => {
    it("draws a built-in graphic's template frame on a full-frame layer and reports its bounds", () => {
        const { layers } = cache();
        const frame = layers.frame(graphic(), 1, 640, 360)!;
        expect(frame).toMatchObject({ width: 640, height: 360, bounds: { x: 160, y: 180, width: 320, height: 90 } });
        expect(draw).toHaveBeenCalledTimes(1);
        expect(draw.mock.calls[0][2]).toMatchObject({ width: 640, height: 360, frame: 30 });
        expect(graphicsBoundsFractions(frame)).toEqual({ x0: 0.25, y0: 0.5, x1: 0.75, y1: 0.75 });
    });

    it("redraws only when the template frame (30 fps), size, or parameters change", () => {
        const { layers } = cache();
        layers.frame(graphic(), 1, 640, 360);
        layers.frame(graphic(), 1.001, 640, 360);
        expect(draw).toHaveBeenCalledTimes(1);
        layers.frame(graphic(), 1.1, 640, 360);
        layers.frame(graphic(), 1.1, 320, 180);
        layers.frame(graphic({ remotionPropsJson: '{"name":"B"}' }), 1.1, 320, 180);
        expect(draw).toHaveBeenCalledTimes(4);
        layers.invalidate();
        layers.frame(graphic({ remotionPropsJson: '{"name":"B"}' }), 1.1, 320, 180);
        expect(draw).toHaveBeenCalledTimes(5);
    });

    it("draws nothing for custom-code graphics (they keep the DOM layer)", () => {
        const { layers } = cache();
        expect(layers.frame(graphic({ remotionCode: "export default () => null;" }), 1, 640, 360)).toBeNull();
        expect(draw).not.toHaveBeenCalled();
    });

    it("redraws a frame drawn while its logo loads", () => {
        let loaded = false;
        const { layers } = cache({ image: () => null, settled: () => loaded });
        const logo = graphic({ remotionTemplateId: "logo-sting", remotionPropsJson: '{"logoUrl":"/logo.png"}' });
        layers.frame(logo, 1, 640, 360);
        layers.frame(logo, 1, 640, 360);
        expect(draw).toHaveBeenCalledTimes(2);
        loaded = true;
        layers.frame(logo, 1, 640, 360);
        layers.frame(logo, 1, 640, 360);
        expect(draw).toHaveBeenCalledTimes(3);
    });
});

describe("paintGraphicsLayer", () => {
    const placement = { x: 0.1, y: -0.05, scale: 0.8, scaleX: 1, rotation: 10, opacity: 0.5 };

    it("places the layer over the frame rect through the layer matrix, clipped, at group opacity", () => {
        const { layers } = cache();
        const frame = layers.frame(graphic(), 1, 1280, 720)!;
        const ctx = new RecordingContext();
        let alphaAtDraw = -1;
        const drawImage = ctx.drawImage.bind(ctx);
        ctx.drawImage = (...args: unknown[]) => {
            alphaAtDraw = ctx.globalAlpha;
            drawImage(...args);
        };
        paintGraphicsLayer(ctx as unknown as CanvasRenderingContext2D, frame, placement, { x: 20, y: 10, w: 640, h: 360 });
        expect(ctx.calls.map((c) => c.name)).toEqual(["save", "beginPath", "rect", "clip", "translate", "transform", "drawImage", "restore"]);
        expect(ctx.named("rect")[0].args).toEqual([20, 10, 640, 360]);
        expect(ctx.named("translate")[0].args).toEqual([20, 10]);
        expect(ctx.named("transform")[0].args).toEqual(graphicsLayerMatrix(placement, 640, 360));
        expect(ctx.named("drawImage")[0].args.slice(1)).toEqual([0, 0, 640, 360]);
        expect(alphaAtDraw).toBe(0.5);
    });

    it("draws nothing for a hidden layer (opacity or scale zero)", () => {
        const { layers } = cache();
        const frame = layers.frame(graphic(), 1, 640, 360)!;
        const ctx = new RecordingContext();
        paintGraphicsLayer(ctx as unknown as CanvasRenderingContext2D, frame, { ...placement, opacity: 0 }, { x: 0, y: 0, w: 640, h: 360 });
        paintGraphicsLayer(ctx as unknown as CanvasRenderingContext2D, frame, { ...placement, scale: 0 }, { x: 0, y: 0, w: 640, h: 360 });
        expect(ctx.calls).toEqual([]);
    });
});
