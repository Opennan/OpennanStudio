import { describe, expect, it, vi } from "vitest";
import { FILTERS } from "@opennan/timeline-core/looks/filters";
import { itemLook } from "@opennan/timeline-core/looks/look-plan";
import { transitionById } from "@opennan/timeline-core/looks/transitions";

const counts = vi.hoisted(() => ({ exprProgram: 0, buildHaldClut: 0 }));
vi.mock("./gl-programs", async (importActual) => {
    const actual = await importActual<typeof import("./gl-programs")>();
    return { ...actual, exprProgram: (...args: Parameters<typeof actual.exprProgram>) => { counts.exprProgram += 1; return actual.exprProgram(...args); } };
});
vi.mock("@opennan/timeline-core/looks/lut", async (importActual) => {
    const actual = await importActual<typeof import("@opennan/timeline-core/looks/lut")>();
    // Counted, not built: a real CLUT is 262,144 evaluations, too slow for 60 of them in a unit test.
    return { ...actual, buildHaldClut: () => { counts.buildHaldClut += 1; return { level: 1, lutSize: 1, size: 2, rgb: new Uint8Array(12) }; } };
});

const { LookRenderer } = await import("./look-renderer");

/** A WebGL2 stand-in: every call succeeds; objects are plain tokens. */
function fakeCanvas(): HTMLCanvasElement {
    const listeners = new Map<string, EventListener>();
    const gl = new Proxy({}, {
        get(_target, prop) {
            if (prop === "isContextLost") return () => false;
            if (prop === "getShaderParameter" || prop === "getProgramParameter") return () => true;
            if (prop === "getExtension") return () => null;
            if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return 1;
            return () => ({});
        },
    });
    return {
        width: 0, height: 0,
        getContext: () => gl,
        addEventListener: (type: string, fn: EventListener) => listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type),
        dispatch: (type: string) => listeners.get(type)?.({ preventDefault() {} } as Event),
    } as unknown as HTMLCanvasElement;
}

describe("LookRenderer caches", () => {
    it("builds an effect or transition shader once per key, not every frame", () => {
        const renderer = new LookRenderer(fakeCanvas());
        const plan = itemLook({ kind: "scene", effects: [{ id: "r", effectId: "fx_rgb_split", order: 0, paramsJson: null, enabled: true }] })!;
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        const before = counts.exprProgram;
        for (let i = 0; i < 5; i += 1) {
            renderer.look(frame, plan, i / 30);
            renderer.transition(frame, frame, transitionById("wipe_left")!, i / 5);
            renderer.releaseAll();
        }
        expect(counts.exprProgram - before).toBe(2);
    });

    it("keeps every filter's CLUT warm while the 30 thumbnails redraw (no rebuild on the second pass)", () => {
        const renderer = new LookRenderer(fakeCanvas());
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        const ids = FILTERS.map((filter) => filter.id);
        expect(ids.length).toBeGreaterThanOrEqual(30);
        const plans = ids.map((id) => itemLook({ kind: "scene", visualFilter: id })).filter(Boolean);
        for (const plan of plans) renderer.look(frame, plan, 0);
        const built = counts.buildHaldClut;
        for (const plan of plans) renderer.look(frame, plan, 0);
        expect(counts.buildHaldClut).toBe(built);
    });
});

/** A WebGL2 stand-in that records calls; uniform locations carry their names, shaders their sources. */
function recordingCanvas(extensions: readonly string[] = []) {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    let next = 0;
    const gl = new Proxy({}, {
        get(_target, prop) {
            if (prop === "isContextLost") return () => false;
            if (prop === "getShaderParameter" || prop === "getProgramParameter") return () => true;
            if (prop === "getExtension") return (name: string) => (extensions.includes(name) ? {} : null);
            if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return 1;
            if (prop === "getUniformLocation") return (_program: unknown, name: string) => ({ name });
            return (...args: unknown[]) => {
                calls.push({ fn: String(prop), args });
                return { id: (next += 1) };
            };
        },
    });
    const canvas = { width: 0, height: 0, getContext: () => gl, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
    const uniform = (name: string) => calls.filter((c) => c.fn.startsWith("uniform") && (c.args[0] as { name?: string })?.name === name).map((c) => c.args.slice(1));
    return { canvas, calls, uniform };
}

describe("LookRenderer.placeAffine", () => {
    it("draws the affine program with the inverse rows, opacity, and background, once compiled", async () => {
        const { PLACE_AFFINE_SHADER } = await import("./gl-programs");
        const { canvas, calls, uniform } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(4 * 6), 3, 2);
        const inverse = [0.5, 0.1, -0.2, 2, 3, -4] as const;
        const out = renderer.placeAffine(frame, 16, 9, inverse, 0.25, [0, 0, 0, 0]);
        renderer.placeAffine(frame, 16, 9, inverse, 1);
        expect(out).toMatchObject({ width: 16, height: 9 });
        expect(calls.filter((c) => c.fn === "shaderSource" && c.args[1] === PLACE_AFFINE_SHADER)).toHaveLength(1);
        // Rows of the inverse map: src.x = a·X + c·Y + e, src.y = b·X + d·Y + f.
        expect(uniform("u_inv0")[0]).toEqual([0.5, -0.2, 3]);
        expect(uniform("u_inv1")[0]).toEqual([0.1, 2, -4]);
        expect(uniform("u_opacity")).toEqual([[0.25], [1]]);
        expect(uniform("u_background")).toEqual([[0, 0, 0, 0], [0, 0, 0, 1]]);
        // A collapsed or non-finite map draws the background only.
        renderer.placeAffine(frame, 16, 9, [Number.NaN, 0, 0, 0, 0, 0], 1);
        expect(uniform("u_opacity").at(-1)).toEqual([0]);
        renderer.releaseAll();
    });
});

describe("LookRenderer.lutMix", () => {
    const lutA = { kind: "lut" as const, key: "mix-a", fn: (c: [number, number, number]) => c };
    const lutB = { kind: "lut" as const, key: "mix-b", fn: (c: [number, number, number]): [number, number, number] => [c[0] / 2, c[1], c[2]] };

    it("samples both CLUTs with the quantized weight, keeping them cached between frames", async () => {
        const { LUT_MIX_SHADER } = await import("./gl-programs");
        const { canvas, calls, uniform } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        const built = counts.buildHaldClut;
        renderer.lutMix(frame, lutA, lutB, 1 / 3);
        renderer.releaseAll();
        renderer.lutMix(frame, lutA, lutB, 0.5);
        renderer.releaseAll();
        expect(counts.buildHaldClut - built).toBe(2);
        expect(calls.filter((c) => c.fn === "shaderSource" && c.args[1] === LUT_MIX_SHADER)).toHaveLength(1);
        expect(uniform("u_w")).toEqual([[341 / 1024], [0.5]]);
        expect(uniform("u_lut0")).toHaveLength(2);
        expect(uniform("u_lut1")).toHaveLength(2);
    });

    it("runs one plain CLUT pass when the weight rounds to an end or both sides are the same CLUT", async () => {
        const { LUT_MIX_SHADER, LUT_SHADER } = await import("./gl-programs");
        const { canvas, calls } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        renderer.lutMix(frame, lutA, lutB, 0.0001);
        renderer.lutMix(frame, lutA, lutB, 0.9999);
        renderer.lutMix(frame, lutA, { ...lutA }, 0.5);
        expect(calls.some((c) => c.fn === "shaderSource" && c.args[1] === LUT_MIX_SHADER)).toBe(false);
        expect(calls.filter((c) => c.fn === "shaderSource" && c.args[1] === LUT_SHADER)).toHaveLength(1);
    });

    it("disposes the new programs with the others", () => {
        const { canvas, calls } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        renderer.lutMix(frame, lutA, lutB, 0.5);
        renderer.placeAffine(frame, 4, 4, [1, 0, 0, 1, 0, 0], 1);
        const programs = calls.filter((c) => c.fn === "createProgram").length;
        renderer.dispose();
        expect(programs).toBe(2);
        expect(calls.filter((c) => c.fn === "deleteProgram")).toHaveLength(2);
        // Two CLUTs and the pooled frames are freed too.
        expect(calls.filter((c) => c.fn === "deleteTexture").length).toBeGreaterThanOrEqual(2 + 3);
    });
});

describe("LookRenderer.presentRegion (one backing canvas for every size)", () => {
    /** The recording canvas with counted width/height writes. */
    function sizedCanvas() {
        const recording = recordingCanvas();
        let width = 0;
        let height = 0;
        const resizes: string[] = [];
        Object.defineProperties(recording.canvas, {
            width: { get: () => width, set: (v: number) => { resizes.push(`w${v}`); width = v; } },
            height: { get: () => height, set: (v: number) => { resizes.push(`h${v}`); height = v; } },
        });
        return { ...recording, resizes };
    }

    it("only grows the canvas and draws each size into its bottom-left viewport, with the present math unchanged", async () => {
        const { PRESENT_SHADER } = await import("./gl-programs");
        const { canvas, calls, uniform, resizes } = sizedCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        const sizes: Array<[number, number]> = [[320, 180], [100, 50], [320, 180], [64, 64], [400, 120], [100, 50]];
        const regions = sizes.map(([w, h]) => renderer.presentRegion(frame, w, h));
        // Two growth steps (first size, then the wider one): no resize per draw.
        expect(resizes).toEqual(["w320", "h180", "w400"]);
        expect([canvas.width, canvas.height]).toEqual([400, 180]);
        // Each region is at the canvas's left edge, bottom-aligned (GL rows run bottom-up), in canvas px top-first.
        expect(regions[0]).toEqual({ x: 0, y: 0, width: 320, height: 180 });
        expect(regions[1]).toEqual({ x: 0, y: 130, width: 100, height: 50 });
        expect(regions[4]).toEqual({ x: 0, y: 60, width: 400, height: 120 });
        expect(regions[5]).toEqual({ x: 0, y: 130, width: 100, height: 50 });
        // The present pass sees exactly the size it would on a canvas of that size.
        const viewports = calls.filter((c) => c.fn === "viewport").map((c) => c.args);
        expect(viewports).toEqual(sizes.map(([w, h]) => [0, 0, w, h]));
        expect(uniform("u_canvas")).toEqual(sizes);
        expect(uniform("u_size")).toEqual(sizes);
        expect(calls.filter((c) => c.fn === "shaderSource" && c.args[1] === PRESENT_SHADER)).toHaveLength(1);
    });

    it("present() still sizes the canvas to the frame (thumbnails draw the whole canvas)", () => {
        const { canvas, resizes } = sizedCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        renderer.presentRegion(frame, 320, 180);
        renderer.present(frame, 96, 54);
        expect([canvas.width, canvas.height]).toEqual([96, 54]);
        expect(resizes).toEqual(["w320", "h180", "w96", "h54"]);
    });
});

describe("LookRenderer GPU export compositing (phase 10c)", () => {
    it("returns frames of the expected sizes and skips no-op steps", () => {
        const renderer = new LookRenderer(fakeCanvas());
        const frame = renderer.uploadPixels(new Uint8Array(8 * 4 * 4), 8, 4);
        expect(renderer.fill(16, 9, [0, 0, 0, 1])).toMatchObject({ width: 16, height: 9 });
        expect(renderer.crop(frame, { x: 2, y: 1, width: 4, height: 2 })).toMatchObject({ width: 4, height: 2 });
        expect(renderer.crop(frame, { x: 0, y: 0, width: 8, height: 4 })).toBe(frame);
        expect(renderer.crop(frame, { x: 6, y: 3, width: 9, height: 9 })).toMatchObject({ width: 2, height: 1 });
        expect(renderer.nearest(frame, 8, 4)).toBe(frame);
        expect(renderer.nearest(frame, 2, 1)).toMatchObject({ width: 2, height: 1 });
        expect(renderer.rotate90(frame, 90)).toMatchObject({ width: 4, height: 8 });
        expect(renderer.rotate90(frame, 180)).toMatchObject({ width: 8, height: 4 });
        expect(renderer.rotate90(frame, 360)).toBe(frame);
        expect(renderer.adjustLayer(frame, {})).toBe(frame);
        expect(renderer.adjustLayer(frame, { flipX: true })).not.toBe(frame);
        expect(renderer.downscale(frame, 2, 1)).toMatchObject({ width: 2, height: 1 });
        const base = renderer.fill(16, 9, [0, 0, 0, 1]);
        expect(renderer.composite(base, frame, [1, 0, 0, 1, 0, 0], 0)).toBe(base);
        expect(renderer.composite(base, frame, [1, 0, 0, 1, Number.NaN, 0], 1)).toBe(base);
        expect(renderer.composite(base, frame, [1, 0, 0, 1, 0, 0], 1)).toMatchObject({ width: 16, height: 9 });
        renderer.releaseAll();
        renderer.dispose();
    });
});

describe("LookRenderer mask step (phase 10c)", () => {
    it("runs the mask as one cached program per shape, with the parameters evaluated at the given keyframe time", async () => {
        const { itemLook } = await import("@opennan/timeline-core/looks/look-plan");
        const { canvas, calls, uniform } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        const plan = itemLook({
            kind: "scene", maskJson: '{"shape":"star","x":0.5,"width":0.4,"height":0.4,"rotation":10,"feather":0.2}',
            keyframesJson: JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2 }, { time: 2, mask_x: 0.6 }] }),
        })!;
        for (const t of [0, 1, 2]) {
            expect(renderer.look(frame, plan, t)).toMatchObject({ width: 2, height: 2 });
        }
        expect(calls.filter((c) => c.fn === "createProgram")).toHaveLength(1);
        expect(uniform("u_mx")).toEqual([[0.2], [0.4], [0.6]]);
        expect(uniform("u_mw")).toEqual([[0.4], [0.4], [0.4]]);
        expect(uniform("u_mr")).toEqual([[10], [10], [10]]);
        expect(uniform("u_mf")).toEqual([[0.2], [0.2], [0.2]]);
    });
});

describe("LookRenderer mask box (phase 10d: text and sticker bitmaps)", () => {
    it("feeds the item's box inside the bitmap as u_mbox; without one the whole frame", async () => {
        const { itemLook } = await import("@opennan/timeline-core/looks/look-plan");
        const { canvas, uniform } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(4 * 60 * 34), 60, 34);
        const plan = itemLook({ kind: "clip", trackType: "text", maskJson: '{"shape":"circle"}' })!;
        renderer.look(frame, plan, 0);
        renderer.look(frame, plan, 0, 0, { x: 9.75, y: 6.5, width: 40.5, height: 21 });
        const step = plan.steps[0] as Extract<(typeof plan.steps)[number], { kind: "mask" }>;
        renderer.mask(frame, step, 0, { x: 1, y: 2, width: 3, height: 4 });
        expect(uniform("u_mbox")).toEqual([[0, 0, 60, 34], [9.75, 6.5, 40.5, 21], [1, 2, 3, 4]]);
    });
});

describe("LookRenderer legacy passes (blur slider, chroma key, blend modes)", () => {
    const programsDrawn = (calls: Array<{ fn: string; args: unknown[] }>, sources: Map<unknown, string>) =>
        calls.filter((c) => c.fn === "useProgram").map((c) => sources.get(c.args[0]));

    /** Program token → the fragment shader source it was linked with. */
    function programSources(calls: Array<{ fn: string; args: unknown[] }>): Map<unknown, string> {
        const shaders = new Map<unknown, string>();
        const out = new Map<unknown, string>();
        let lastProgram: unknown = null;
        for (const c of calls) {
            if (c.fn === "shaderSource") shaders.set(c.args[0], c.args[1] as string);
            if (c.fn === "createProgram") lastProgram = c;
            if (c.fn === "attachShader") {
                const src = shaders.get(c.args[1]);
                if (src && !src.includes("in vec2 a_position")) out.set(c.args[0], src);
            }
        }
        void lastProgram;
        return out;
    }

    it("blurs in two passes through a float frame when float targets exist, with the clamped radii", async () => {
        const { BLUR_H_SHADER, BLUR_V_SHADER } = await import("./gl-programs");
        const { canvas, calls, uniform } = recordingCanvas(["EXT_color_buffer_float"]);
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16 * 12 * 4), 16, 12);
        const out = renderer.boxBlur(frame, 5, "yuv420");
        expect(out).toMatchObject({ width: 16, height: 12 });
        expect(out).not.toBe(frame);
        const drawn = programsDrawn(calls, programSources(calls));
        expect(drawn).toEqual([BLUR_H_SHADER, BLUR_V_SHADER]);
        // 4:2:0: the radius is limited by the 8×6 chroma planes (avgBlurRadii).
        expect(uniform("u_rx")).toEqual([[4]]);
        expect(uniform("u_ry")).toEqual([[3]]);
        expect(uniform("u_mode")).toEqual([[2], [2]]);
        expect(uniform("u_area")).toEqual([[63]]);
        expect(calls.some((c) => c.fn === "texStorage2D" && c.args[2] === 1 && c.args[3] === 16 && c.args[4] === 12)).toBe(true);
        renderer.releaseAll();
    });

    it("blurs in one 2D pass without float targets, and not at all below radius 1", async () => {
        const { BLUR_2D_SHADER } = await import("./gl-programs");
        const { canvas, calls, uniform } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(40 * 30 * 4), 40, 30);
        expect(renderer.boxBlur(frame, 0.5, "rgb")).toBe(frame);
        renderer.boxBlur(frame, 3, "rgb");
        expect(programsDrawn(calls, programSources(calls))).toEqual([BLUR_2D_SHADER]);
        expect(uniform("u_rx")).toEqual([[3]]);
        expect(uniform("u_mode")).toEqual([[0]]);
        renderer.releaseAll();
    });

    it("keys with the key chroma, similarity, blend, and block mode as uniforms", async () => {
        const { CHROMA_KEY_SHADER } = await import("./gl-programs");
        const { canvas, calls, uniform } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        renderer.chromaKey(frame, { u: 44, v: 21, similarity: 0.1, blend: 0.05 }, true);
        expect(programsDrawn(calls, programSources(calls))).toEqual([CHROMA_KEY_SHADER]);
        expect(uniform("u_key")).toEqual([[44, 21]]);
        expect(uniform("u_similarity")).toEqual([[0.1]]);
        expect(uniform("u_blend")).toEqual([[0.05]]);
        expect(uniform("u_sub")).toEqual([[1]]);
        renderer.releaseAll();
    });

    it("runs eq's lookups as one YUV pass and skips identity planes", async () => {
        const { EQ_YUV_SHADER } = await import("./gl-programs");
        const { canvas, calls, uniform } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(16), 2, 2);
        expect(renderer.eqYuv(frame, { luma: null, chroma: null })).toBe(frame);
        renderer.eqYuv(frame, { luma: [5120, -33], chroma: null });
        expect(programsDrawn(calls, programSources(calls))).toEqual([EQ_YUV_SHADER]);
        expect(uniform("u_eq")).toEqual([[5120, -33, 4096, 0]]);
        expect(uniform("u_on")).toEqual([[1, 0]]);
        renderer.releaseAll();
    });

    it("applies the legacy ops in ffmpeg's order: blur, chroma key, eq", async () => {
        const { BLUR_2D_SHADER, CHROMA_KEY_SHADER, EQ_YUV_SHADER } = await import("./gl-programs");
        const { canvas, calls } = recordingCanvas();
        const renderer = new LookRenderer(canvas);
        const frame = renderer.uploadPixels(new Uint8Array(8 * 8 * 4), 8, 8);
        renderer.legacy(frame, {
            blur: { radius: 2, mode: "yuv444" },
            chromaKey: { key: { u: 44, v: 21, similarity: 0.1, blend: 0 }, subsampled: false },
            eq: { luma: [4710, -40], chroma: null },
        });
        expect(programsDrawn(calls, programSources(calls))).toEqual([BLUR_2D_SHADER, CHROMA_KEY_SHADER, EQ_YUV_SHADER]);
        renderer.releaseAll();
    });
});
