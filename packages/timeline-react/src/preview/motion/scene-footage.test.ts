import { describe, expect, it } from "vitest";
import { RecordingContext } from "./test-fixtures";
import { drawSceneFootage } from "./scene-footage";
import { applyAffine, sceneMediaMatrix, sceneMotionAt } from "../scene-motion";

/** Records globalAlpha and the current matrix at every drawImage (the base context records only args). */
class AlphaContext extends RecordingContext {
    readonly draws: Array<{ alpha: number; matrix: number[] | null; args: unknown[] }> = [];
    private matrix: number[] | null = null;
    private stack: Array<number[] | null> = [];
    override setTransform(...args: unknown[]) {
        super.setTransform(...args);
        this.matrix = args as number[];
    }
    override save() {
        super.save();
        this.stack.push(this.matrix);
    }
    override restore() {
        super.restore();
        this.matrix = this.stack.pop() ?? null;
    }
    override drawImage(...args: unknown[]) {
        super.drawImage(...args);
        this.draws.push({ alpha: this.globalAlpha, matrix: this.matrix, args });
    }
}

const element = { tag: "video" } as unknown as CanvasImageSource;
const source = { element, width: 1920, height: 1080 };
const comp = { width: 1280, height: 720 };

describe("drawSceneFootage", () => {
    it("draws a still scene into the rect it is given (the on-screen element's box)", () => {
        const ctx = new AlphaContext();
        const drew = drawSceneFootage(ctx as unknown as CanvasRenderingContext2D, source, { id: "s" }, 5, 1, comp, { x: 10, y: 20, w: 300, h: 200 });
        expect(drew).toBe(true);
        expect(ctx.draws).toHaveLength(1);
        expect(ctx.draws[0].args).toEqual([element, 10, 20, 300, 200]);
        expect(ctx.named("setTransform")).toHaveLength(0);
    });

    it("places a rotated, half-transparent scene through its affine at the scene-local time", () => {
        const ctx = new AlphaContext();
        const scene = { id: "s", rotationDegrees: 30, opacity: 0.5, transformScale: 0.8, transformOffsetX: 10 };
        const drew = drawSceneFootage(ctx as unknown as CanvasRenderingContext2D, source, scene, 5, 1, comp, { x: 0, y: 0, w: 1, h: 1 });
        expect(drew).toBe(true);
        expect(ctx.draws).toHaveLength(1);
        const draw = ctx.draws[0];
        // The whole media in its own pixels, mapped by the forward matrix; alpha × opacity.
        expect(draw.args).toEqual([element, 0, 0, 1920, 1080]);
        expect(draw.alpha).toBeCloseTo(0.5);
        const values = sceneMotionAt(scene, 5, 1);
        const expected = sceneMediaMatrix(undefined, { width: 1920, height: 1080 }, comp, values, { width: 1920, height: 1080 });
        expect(draw.matrix).toEqual(expected);
        // The media centre lands on the frame centre moved by 10 % of the width.
        const [cx, cy] = applyAffine(expected, 960, 540);
        expect(cx).toBeCloseTo(640 + 128);
        expect(cy).toBeCloseTo(360);
        // The context is restored (no transform or alpha leaks into the overlay stamp after it).
        expect(ctx.named("save")).toHaveLength(1);
        expect(ctx.named("restore")).toHaveLength(1);
    });

    it("follows a keyframed scene over time", () => {
        const keyframesJson = JSON.stringify([{ time: 0, rotation_degrees: 0 }, { time: 2, rotation_degrees: 90 }]);
        const scene = { id: "s", keyframesJson };
        const at = (t: number) => {
            const ctx = new AlphaContext();
            drawSceneFootage(ctx as unknown as CanvasRenderingContext2D, source, scene, 4, t, comp, { x: 0, y: 0, w: 1, h: 1 });
            return ctx.draws[0].matrix!;
        };
        const start = at(0);
        const end = at(2);
        // Rotation 0: no shear; rotation 90: a = cos·sx ≈ 0.
        expect(start[1]).toBeCloseTo(0);
        expect(end[0]).toBeCloseTo(0);
        expect(Math.abs(end[1])).toBeGreaterThan(0.1);
    });

    it("draws nothing for a fully transparent frame but still reports the footage handled", () => {
        const ctx = new AlphaContext();
        const drew = drawSceneFootage(ctx as unknown as CanvasRenderingContext2D, source, { id: "s", opacity: 0, rotationDegrees: 5 }, 5, 1, comp, { x: 0, y: 0, w: 1, h: 1 });
        expect(drew).toBe(true);
        expect(ctx.draws).toHaveLength(0);
    });

    it("reports false without a decoded frame", () => {
        const ctx = new AlphaContext();
        expect(drawSceneFootage(ctx as unknown as CanvasRenderingContext2D, { element, width: 0, height: 0 }, { id: "s", rotationDegrees: 10 }, 5, 1, comp, null)).toBe(false);
        expect(drawSceneFootage(ctx as unknown as CanvasRenderingContext2D, source, { id: "s" }, 5, 1, comp, null)).toBe(false);
        expect(ctx.draws).toHaveLength(0);
    });
});
