import { describe, expect, it } from "vitest";
import { defaultMask, MASK_FEATHER_SCALE, type MaskSpec } from "@opennan/timeline-core/looks/masks";
import type { HandleBox } from "./handles";
import { FEATHER_HANDLE_GAP, MASK_ROTATE_OFFSET, hitTestMask, maskDragPatch, maskScreenGeometry } from "./mask-handles";

// The item on screen: 200 × 100 px centred at (300, 200), unrotated. Short side 100 px.
const item: HandleBox = { cx: 300, cy: 200, w: 200, h: 100, rotation: 0 };
const mask = (over: Partial<MaskSpec> = {}): MaskSpec => ({ ...defaultMask(over.shape ?? "circle"), ...over });

describe("maskScreenGeometry", () => {
    it("maps the mask box through the item box: centre in item fractions, sizes in short sides, rotation added", () => {
        const geometry = maskScreenGeometry(item, mask({ x: 0.75, y: 0.25, width: 0.5, height: 0.3, rotation: 30 }));
        expect(geometry.frame.cx).toBeCloseTo(350, 9);
        expect(geometry.frame.cy).toBeCloseTo(175, 9);
        expect(geometry.frame.w).toBeCloseTo(50, 9);
        expect(geometry.frame.h).toBeCloseTo(30, 9);
        expect(geometry.frame.rotation).toBeCloseTo(Math.PI / 6, 9);
        const turned = maskScreenGeometry({ ...item, rotation: Math.PI / 2 }, mask({ x: 0.75, y: 0.5 }));
        // The item turned 90° clockwise: its right half now points down.
        expect(turned.frame.cx).toBeCloseTo(300, 9);
        expect(turned.frame.cy).toBeCloseTo(250, 9);
        expect(turned.frame.rotation).toBeCloseTo(Math.PI / 2, 9);
    });

    it("outlines every shape with closed polylines (two lines for mirror, one for linear) inside its box", () => {
        for (const shape of ["circle", "rectangle", "heart", "star"] as const) {
            const geometry = maskScreenGeometry(item, mask({ shape, width: 0.6, height: 0.6, roundness: 0.5 }));
            expect(geometry.outline).toHaveLength(1);
            expect(geometry.outline[0].closed).toBe(true);
            for (const p of geometry.outline[0].points) {
                expect(Math.abs(p.x - 300)).toBeLessThanOrEqual(30 + 1e-6);
                expect(Math.abs(p.y - 200)).toBeLessThanOrEqual(30 + 1e-6);
            }
        }
        expect(maskScreenGeometry(item, mask({ shape: "mirror", width: 0.4 })).outline.map((o) => o.closed)).toEqual([false, false]);
        const line = maskScreenGeometry(item, mask({ shape: "linear" })).outline;
        expect(line).toHaveLength(1);
        expect(line[0].points.every((p) => Math.abs(p.y - 200) < 1e-9)).toBe(true);
    });

    it("places the size, rotate, and feather handles per shape", () => {
        const kinds = (shape: MaskSpec["shape"]) => maskScreenGeometry(item, mask({ shape })).handles.map((h) => h.kind).sort();
        expect(kinds("circle")).toEqual(["corner", "feather", "height", "rotate", "width"]);
        expect(kinds("mirror")).toEqual(["feather", "rotate", "width"]);
        expect(kinds("linear")).toEqual(["feather", "rotate"]);
        const geometry = maskScreenGeometry(item, mask({ width: 0.6, height: 0.4, feather: 0.2 }));
        const at = (kind: string) => geometry.handles.find((h) => h.kind === kind)!;
        expect(at("width")).toMatchObject({ x: 330, y: 200 });
        expect(at("height")).toMatchObject({ x: 300, y: 180 });
        expect(at("corner")).toMatchObject({ x: 330, y: 220 });
        expect(at("rotate")).toMatchObject({ x: 300, y: 220 + MASK_ROTATE_OFFSET });
        expect(at("feather").y).toBeCloseTo(180 - FEATHER_HANDLE_GAP - 0.2 * MASK_FEATHER_SCALE * 100, 9);
    });
});

describe("hitTestMask", () => {
    const geometry = maskScreenGeometry(item, mask({ width: 0.6, height: 0.4 }));
    it("finds handles first, then the body inside the mask box; outside is no hit", () => {
        expect(hitTestMask(geometry, 331, 201)).toBe("width");
        expect(hitTestMask(geometry, 300, 220 + MASK_ROTATE_OFFSET)).toBe("rotate");
        expect(hitTestMask(geometry, 305, 195)).toBe("move");
        expect(hitTestMask(geometry, 380, 200)).toBeNull();
    });

    it("a small mask keeps its middle for moving (handle hit areas shrink with the mask)", () => {
        const tiny = maskScreenGeometry(item, mask({ width: 0.1, height: 0.1 }));
        expect(hitTestMask(tiny, 300, 200)).toBe("move");
        expect(hitTestMask(tiny, 305, 200)).toBe("width");
    });

    it("linear and mirror masks move from anywhere on the item", () => {
        const line = maskScreenGeometry(item, mask({ shape: "linear" }));
        expect(hitTestMask(line, 390, 160)).toBe("move");
        expect(hitTestMask(line, 420, 160)).toBeNull();
    });
});

describe("maskDragPatch", () => {
    it("move: the centre follows the pointer in item fractions", () => {
        const start = { item, mask: mask({ x: 0.5, y: 0.5 }), kind: "move" as const, pointer: { x: 300, y: 200 } };
        expect(maskDragPatch(start, { x: 320, y: 190 })).toEqual({ x: 0.6, y: 0.4 });
        // On a rotated item the screen delta turns into the item's own axes.
        const turned = { ...start, item: { ...item, rotation: Math.PI / 2 } };
        const patch = maskDragPatch(turned, { x: 300, y: 220 });
        expect(patch.x).toBeCloseTo(0.6, 9);
        expect(patch.y).toBeCloseTo(0.5, 9);
    });

    it("width, height, and the corner resize about the mask centre in short sides; mirror's handle sets its band", () => {
        const base = { item, mask: mask({ width: 0.6, height: 0.4 }), pointer: { x: 0, y: 0 } };
        expect(maskDragPatch({ ...base, kind: "width" }, { x: 360, y: 210 })).toEqual({ width: 1.2 });
        expect(maskDragPatch({ ...base, kind: "height" }, { x: 290, y: 150 })).toEqual({ height: 1 });
        const corner = maskDragPatch({ ...base, kind: "corner" }, { x: 360, y: 240 });
        expect(corner.width).toBeCloseTo(1.2, 9);
        expect(corner.height).toBeCloseTo(0.8, 9);
        expect(maskDragPatch({ item, mask: mask({ shape: "mirror", width: 0.4 }), kind: "width", pointer: { x: 0, y: 0 } }, { x: 250, y: 170 })).toEqual({ width: 0.6 });
    });

    it("rotate turns by the pointer's angle about the mask centre (Shift snaps to 15°)", () => {
        const start = { item, mask: mask({ rotation: 10 }), kind: "rotate" as const, pointer: { x: 300, y: 260 } };
        expect(maskDragPatch(start, { x: 240, y: 200 }).rotation).toBeCloseTo(100, 6);
        expect(maskDragPatch(start, { x: 241, y: 192 }, { shift: true }).rotation).toBe(105);
    });

    it("feather follows the arrow's distance from the outline, 0..1", () => {
        const start = { item, mask: mask({ width: 0.6, height: 0.4 }), kind: "feather" as const, pointer: { x: 0, y: 0 } };
        const top = 200 - 20 - FEATHER_HANDLE_GAP;
        expect(maskDragPatch(start, { x: 300, y: top - 25 })).toEqual({ feather: 0.5 });
        expect(maskDragPatch(start, { x: 300, y: top + 30 })).toEqual({ feather: 0 });
        expect(maskDragPatch(start, { x: 300, y: top - 900 })).toEqual({ feather: 1 });
    });
});

describe("maskSpecAt and drawMaskChrome", async () => {
    const { drawMaskChrome, maskSpecAt } = await import("./mask-handles");
    const { parseTimelineKeyframes } = await import("@opennan/timeline-core/lib/timeline-editing-properties");

    it("evaluates keyframed mask channels at item time; static fields stay", () => {
        const points = parseTimelineKeyframes(JSON.stringify([{ time: 0, mask_x: 0.2, mask_rotation: 0 }, { time: 2, mask_x: 0.6, mask_rotation: 90 }]));
        expect(maskSpecAt(mask({ width: 0.3 }), points, 1)).toMatchObject({ x: 0.4, rotation: 45, width: 0.3 });
    });

    it("strokes the item box dashed, each outline, and draws every handle in the theme colours", () => {
        const calls: Array<{ name: string; args: unknown[] }> = [];
        const state: Record<string, unknown> = {};
        const ctx = new Proxy(state, {
            get: (target, prop: string) => (prop in target ? target[prop] : (...args: unknown[]) => calls.push({ name: prop, args })),
            set: (target, prop: string, value) => {
                target[prop] = value;
                calls.push({ name: `set:${prop}`, args: [value] });
                return true;
            },
        }) as unknown as CanvasRenderingContext2D;
        const geometry = maskScreenGeometry(item, mask({ shape: "star" }));
        drawMaskChrome(ctx, geometry, { ring: "RING", handleFill: "FILL", handleStroke: "STROKE" });
        expect(calls.filter((c) => c.name === "setLineDash").map((c) => c.args[0])).toContainEqual([4, 4]);
        expect(calls.filter((c) => c.name === "arc")).toHaveLength(geometry.handles.length - 1);
        expect(calls.some((c) => c.name === "set:strokeStyle" && c.args[0] === "RING")).toBe(true);
        expect(calls.some((c) => c.name === "set:fillStyle" && c.args[0] === "FILL")).toBe(true);
    });
});
