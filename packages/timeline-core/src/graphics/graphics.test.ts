import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../model/timeline";
import { GRAPHICS_DRAWS } from "./draw/index";
import { graphicsLayerAt, graphicsLayerMatrix, graphicsOutputFrames } from "./layer";
import {
    drawGraphicsFrame, graphicsCompositionSize, graphicsDurationInFrames, graphicsFrameAt, graphicsProps, graphicsUnsupportedReason, isBuiltinGraphics,
} from "./render";
import { clampedInterpolate, exitWindow, interpolate, spring } from "./spring";
import { GRAPHICS_TEMPLATES } from "./templates";
import type { GraphicsContext } from "./types";

const clip = (patch: Partial<TimelineClip> = {}): TimelineClip => ({
    id: "g1", trackType: "remotion", trackIndex: 1, startTime: 2, endTime: 6, remotionTemplateId: "lower-third", remotionPropsJson: null,
    ...patch,
} as TimelineClip);

describe("spring", () => {
    it("starts at `from`, settles at `to`, and returns `from` before it starts", () => {
        expect(spring({ frame: -3, fps: 30 })).toBe(0);
        expect(spring({ frame: 0, fps: 30 })).toBe(0);
        expect(spring({ frame: 300, fps: 30 })).toBeCloseTo(1, 6);
        expect(spring({ frame: 300, fps: 30, from: 2, to: -1 })).toBeCloseTo(-1, 6);
    });
    it("overshoots when underdamped and never does when heavily damped", () => {
        const under = Array.from({ length: 90 }, (_, f) => spring({ frame: f, fps: 30 }));
        expect(Math.max(...under)).toBeGreaterThan(1.05);
        const over = Array.from({ length: 300 }, (_, f) => spring({ frame: f, fps: 30, config: { damping: 200 } }));
        for (let i = 1; i < over.length; i += 1) expect(over[i]).toBeGreaterThanOrEqual(over[i - 1] - 1e-12);
        expect(Math.max(...over)).toBeLessThanOrEqual(1 + 1e-9);
    });
    it("damping at or above critical settles like the critically damped spring (about a second)", () => {
        const critical = spring({ frame: 10, fps: 30, config: { damping: 20, stiffness: 100 } });
        expect(spring({ frame: 10, fps: 30, config: { damping: 19.999, stiffness: 100 } })).toBeCloseTo(critical, 3);
        expect(spring({ frame: 10, fps: 30, config: { damping: 200 } })).toBe(critical);
        expect(spring({ frame: 30, fps: 30, config: { damping: 200 } })).toBeGreaterThan(0.999);
    });
});

describe("interpolate", () => {
    it("maps piecewise and extrapolates or clamps", () => {
        expect(interpolate(5, [0, 10], [0, 100])).toBe(50);
        expect(interpolate(15, [0, 10, 20], [0, 100, 0])).toBe(50);
        expect(interpolate(-5, [0, 10], [0, 100])).toBe(-50);
        expect(clampedInterpolate(-5, [0, 10], [0, 100])).toBe(0);
        expect(clampedInterpolate(50, [0, 10], [0, 100])).toBe(100);
    });
    it("exit window covers the last half second", () => {
        expect(exitWindow(30, 120)).toEqual([105, 119]);
        expect(exitWindow(30, 2)).toEqual([0, 1]);
    });
});

describe("graphics clips", () => {
    it("every declared template has a draw function, and only those", () => {
        const ids = new Set(GRAPHICS_TEMPLATES.map((template) => template.id));
        for (const id of Object.keys(GRAPHICS_DRAWS)) expect(ids.has(id), id).toBe(true);
        for (const id of ids) expect(GRAPHICS_DRAWS[id], id).toBeTypeOf("function");
        expect(Object.keys(GRAPHICS_DRAWS)).toHaveLength(GRAPHICS_TEMPLATES.length);
    });
    it("draws built-in templates only, never custom code", () => {
        expect(isBuiltinGraphics(clip())).toBe(true);
        expect(isBuiltinGraphics(clip({ remotionCode: "export default () => null" }))).toBe(false);
        expect(graphicsUnsupportedReason(clip({ remotionCode: "x" }))).toBe("custom-code");
        expect(graphicsUnsupportedReason(clip({ remotionTemplateId: "nope" }))).toBe("unknown-template");
        expect(graphicsUnsupportedReason(clip())).toBeNull();
        expect(isBuiltinGraphics(clip({ trackType: "text" }))).toBe(false);
    });
    it("merges defaults with stored props and coerces types", () => {
        const props = graphicsProps(clip({ remotionPropsJson: JSON.stringify({ name: "Ada", speed: "2", extra: 1 }) }));
        expect(props).toMatchObject({ name: "Ada", role: "Title, Company", speed: 2, extra: 1 });
        expect(graphicsProps(clip({ remotionPropsJson: "{broken" })).name).toBe("Name Surname");
        expect(graphicsProps(clip({ remotionPropsJson: JSON.stringify({ speed: "fast" }) })).speed).toBe(1);
    });
    it("quantizes time to the 30 fps template grid, clamped to the clip", () => {
        expect(graphicsDurationInFrames(clip())).toBe(120);
        expect(graphicsFrameAt(clip(), 0)).toBe(0);
        expect(graphicsFrameAt(clip(), 1 / 60 - 1e-6)).toBe(0);
        expect(graphicsFrameAt(clip(), 1 / 60 + 1e-6)).toBe(1);
        expect(graphicsFrameAt(clip(), 99)).toBe(119);
        expect(graphicsFrameAt(clip(), -1)).toBe(0);
    });
    it("authors in a 1280 long-side composition", () => {
        expect(graphicsCompositionSize(16 / 9)).toEqual({ width: 1280, height: 720 });
        expect(graphicsCompositionSize(9 / 16)).toEqual({ width: 720, height: 1280 });
        expect(graphicsCompositionSize(1)).toEqual({ width: 1280, height: 1280 });
    });
    it("export frames are the frames with start ≤ k/fps < end", () => {
        expect(graphicsOutputFrames(clip(), 30, 1000)).toEqual({ first: 60, count: 120 });
        expect(graphicsOutputFrames(clip({ startTime: 2.01, endTime: 2.05 }), 30, 1000)).toEqual({ first: 61, count: 1 });
        expect(graphicsOutputFrames(clip(), 30, 100)).toEqual({ first: 60, count: 40 });
    });
});

describe("graphics layer placement", () => {
    it("is the identity for a resting clip and follows position, scale, rotation, and opacity", () => {
        const resting = graphicsLayerAt(clip(), 1);
        expect(resting).toMatchObject({ x: 0, y: 0, scale: 1, scaleX: 1, rotation: 0, opacity: 1 });
        expect(graphicsLayerMatrix(resting, 1920, 1080)).toEqual([1, 0, -0, 1, 0, 0]);
        const moved = graphicsLayerAt(clip({ positionX: 0.75, positionY: 0.25, scale: 0.5, rotationDegrees: 90, opacity: 0.5 } as Partial<TimelineClip>), 1);
        expect(moved).toMatchObject({ x: 0.25, y: -0.25, scale: 0.5, rotation: 90, opacity: 0.5 });
        const [a, b, c, d, e, f] = graphicsLayerMatrix(moved, 200, 100);
        // The layer centre (100, 50) lands at the frame centre plus the offset (150, 25).
        expect(a * 100 + c * 50 + e).toBeCloseTo(150, 9);
        expect(b * 100 + d * 50 + f).toBeCloseTo(25, 9);
        // +x of the layer points down after a 90° clockwise turn, at half size.
        expect(a).toBeCloseTo(0, 9);
        expect(b).toBeCloseTo(0.5, 9);
    });
});

function alphaAt(canvas: Canvas, x: number, y: number): number {
    return canvas.getContext("2d").getImageData(x, y, 1, 1).data[3];
}

describe("lower third", () => {
    const draw = (frame: number, width = 1280, height = 720) => {
        const canvas = createCanvas(width, height);
        const bounds = drawGraphicsFrame(canvas.getContext("2d") as unknown as GraphicsContext, clip(), { width, height, frame });
        return { canvas, bounds };
    };
    it("starts left of its inset and settles at the lower left", () => {
        const first = draw(0).bounds!;
        expect(first.x).toBe(0);
        expect(first.x + first.width).toBeCloseTo(1280 * 0.06, 6);
        const { canvas, bounds } = draw(60);
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeCloseTo(1280 * 0.06, 0);
        expect(bounds!.y + bounds!.height).toBeCloseTo(720 - 1280 * 0.12, 0);
        const pixel = canvas.getContext("2d").getImageData(Math.round(bounds!.x + 8), Math.round(bounds!.y + 8), 1, 1).data;
        expect([...pixel]).toEqual([0x7c, 0x3a, 0xed, 255]);
        expect(alphaAt(canvas, 1270, 10)).toBe(0);
    });
    it("draws the same picture at any output size (scaled composition)", () => {
        const small = draw(60, 640, 360).bounds!;
        const large = draw(60, 1920, 1080).bounds!;
        expect(large.x / 3).toBeCloseTo(small.x, 3);
        expect(large.width / 3).toBeCloseTo(small.width, 3);
    });
    it("slides out to the left by the last frame", () => {
        const last = draw(119).bounds;
        expect(last === null || last.x + last.width < 1280 * 0.06).toBe(true);
    });
});
