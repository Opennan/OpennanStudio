import { describe, expect, it } from "vitest";
import { emitFfmpeg, emitGlsl, evaluate, letDepth, paramsOf, v } from "./expr";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import {
    MASK_FEATHER_SCALE, MASK_KEYFRAME_CHANNELS, MASK_SHAPES, applyMaskPatch, centredMaskBox, clipTakesMask, defaultMask, isMaskAnimated, maskExpr, maskImage,
    maskLevelAt, maskLevelExpr, maskParamExprs, maskParamValues, parseMask, serializeMask, type MaskSpec,
} from "./masks";

const W = 200;
const H = 100;
const R = Math.min(W, H);

const spec = (over: Partial<MaskSpec>): MaskSpec => ({ ...defaultMask(over.shape ?? "circle"), ...over });
/** The level at the pixel whose centre is (px, py) (pixel centres sit at x + 0.5). */
const at = (s: MaskSpec, px: number, py: number, points: Parameters<typeof maskLevelAt>[5] = [], t = 0) => maskLevelAt(s, px - 0.5, py - 0.5, W, H, points, t);

describe("parse and serialize", () => {
    it("turns garbage, unknown shapes, and 'none' into no mask", () => {
        for (const raw of [null, undefined, "", "{", "[]", "42", '{"shape":"blob"}', '{"shape":"none"}', { shape: 7 }]) expect(parseMask(raw as never)).toBeNull();
    });

    it("fills defaults per shape and clamps every field", () => {
        const parsed = parseMask('{"shape":"rectangle","x":9,"y":-9,"width":0,"height":99,"feather":3,"roundness":-1,"rotation":"45","invert":1}')!;
        expect(parsed).toEqual({ shape: "rectangle", x: 3, y: -2, width: 0.01, height: 5, rotation: 45, feather: 1, roundness: 0, invert: true });
        expect(parseMask({ shape: "star" })).toEqual(defaultMask("star"));
        expect(defaultMask("circle")).toMatchObject({ x: 0.5, y: 0.5, rotation: 0, feather: 0, invert: false });
    });

    it("round-trips, and serializes no mask as null", () => {
        for (const shape of MASK_SHAPES) {
            const s = spec({ shape, x: 0.3, rotation: -20, feather: 0.25, invert: true });
            expect(parseMask(serializeMask(s))).toEqual(s);
        }
        expect(serializeMask(null)).toBeNull();
        expect(serializeMask(undefined)).toBeNull();
    });

    it("merges patches, keeping the geometry when the shape changes", () => {
        const base = spec({ shape: "circle", x: 0.2, width: 0.4 });
        expect(applyMaskPatch(base, { shape: "star" })).toEqual({ ...base, shape: "star" });
        expect(applyMaskPatch(null, { x: 0.7 })).toEqual({ ...defaultMask("circle"), x: 0.7 });
        expect(applyMaskPatch(base, { feather: 5 })!.feather).toBe(1);
    });
});

describe("JS reference levels (item pixels; 255 visible, 0 hidden)", () => {
    it("circle: inside 255, far outside 0, the feather midpoint 128 on the edge, a hard edge antialiased over one pixel", () => {
        const radius = 0.5 * R / 2; // width 0.5 of the short side
        const soft = spec({ shape: "circle", width: 0.5, height: 0.5, feather: 0.2 });
        const f = 0.2 * MASK_FEATHER_SCALE * R;
        expect(at(soft, 100, 50)).toBe(255);
        expect(at(soft, 2, 2)).toBe(0);
        expect(at(soft, 100 + radius, 50)).toBe(128);
        expect(at(soft, 100 + radius - f / 2, 50)).toBe(255);
        expect(at(soft, 100 + radius + f / 4, 50)).toBe(64);
        const hard = spec({ shape: "circle", width: 0.5, height: 0.5 });
        expect(at(hard, 100 + radius - 0.5, 50)).toBe(255);
        expect(at(hard, 100 + radius, 50)).toBe(128);
        expect(at(hard, 100 + radius + 0.5, 50)).toBe(0);
    });

    it("an ellipse keeps an even feather on both axes", () => {
        const s = spec({ shape: "circle", width: 1.2, height: 0.4, feather: 0.1 });
        expect(at(s, 100 + 0.6 * R, 50)).toBe(128);
        expect(at(s, 100, 50 + 0.2 * R)).toBe(128);
        expect(at(s, 100, 50)).toBe(255);
    });

    it("invert swaps visible and hidden", () => {
        const s = spec({ shape: "circle", invert: true });
        expect(at(s, 100, 50)).toBe(0);
        expect(at(s, 2, 2)).toBe(255);
    });

    it("rotation turns the shape clockwise about its centre", () => {
        // A 1.4 × 0.2 bar: at 0° it reaches x = 100 ± 70; at 90° it reaches y = 50 ± 70 instead.
        const flat = spec({ shape: "rectangle", width: 1.4, height: 0.2 });
        expect(at(flat, 160, 50)).toBe(255);
        expect(at(flat, 100, 20)).toBe(0);
        const turned = { ...flat, rotation: 90 };
        expect(at(turned, 160, 50)).toBe(0);
        expect(at(turned, 100, 20)).toBe(255);
        // Linear at 30°: the line through the centre tilts clockwise (points just above/below it on the 30° ray).
        const line = spec({ shape: "linear", rotation: 30 });
        const ray = (d: number, n: number) => [100 + d * Math.cos(Math.PI / 6) + n * Math.sin(Math.PI / 6), 50 + d * Math.sin(Math.PI / 6) - n * Math.cos(Math.PI / 6)];
        expect(at(line, ...(ray(40, 3) as [number, number]))).toBe(255);
        expect(at(line, ...(ray(40, -3) as [number, number]))).toBe(0);
    });

    it("position moves the centre in fractions of the item box", () => {
        const s = spec({ shape: "circle", x: 0.25, y: 0.75, width: 0.3, height: 0.3 });
        expect(at(s, 50, 75)).toBe(255);
        expect(at(s, 100, 50)).toBe(0);
    });

    it("linear keeps the side above the line; mirror keeps a band of `width` thickness", () => {
        const line = spec({ shape: "linear" });
        expect(at(line, 100, 20)).toBe(255);
        expect(at(line, 100, 80)).toBe(0);
        expect(at(line, 100, 50)).toBe(128);
        const band = spec({ shape: "mirror", width: 0.4 }); // ±20 px
        expect(at(band, 10, 50)).toBe(255);
        expect(at(band, 10, 65)).toBe(255);
        expect(at(band, 10, 75)).toBe(0);
        expect(at(band, 10, 30)).toBe(128);
    });

    it("rectangle: rounded corners cut the corner, square corners keep it", () => {
        const square = spec({ shape: "rectangle", width: 0.8, height: 0.8 }); // ±40 px
        const round = { ...square, roundness: 1 };
        expect(at(square, 138, 88)).toBe(255);
        expect(at(round, 138, 88)).toBe(0);
        expect(at(round, 100, 88)).toBe(255);
        expect(at(round, 138, 50)).toBe(255);
    });

    it("heart: the centre and both lobes are inside, the dip between the lobes and the corners beside the tip are outside", () => {
        const s = spec({ shape: "heart", width: 0.8, height: 0.8 }); // box ±40 px
        expect(at(s, 100, 50)).toBe(255);
        expect(at(s, 100 - 18, 50 - 25)).toBe(255);
        expect(at(s, 100 + 18, 50 - 25)).toBe(255);
        expect(at(s, 100, 50 - 38)).toBe(0);
        expect(at(s, 100 - 30, 50 + 35)).toBe(0);
        expect(at(s, 100, 50 + 36)).toBe(255);
    });

    it("star: the centre and the top tip are inside, the notches between the tips are outside", () => {
        const s = spec({ shape: "star", width: 0.8, height: 0.8 }); // box ±40 px
        expect(at(s, 100, 50)).toBe(255);
        expect(at(s, 100, 50 - 36)).toBe(255);
        expect(at(s, 100, 50 + 30)).toBe(0);
        expect(at(s, 100 - 26, 50 - 26)).toBe(0);
        expect(at(s, 128, 45)).toBe(255);
    });

    it("degenerate sizes stay finite", () => {
        const tiny = spec({ shape: "circle", width: 0.01, height: 0.01 });
        expect(Number.isFinite(at(tiny, 100, 50))).toBe(true);
        expect(at(tiny, 10, 10)).toBe(0);
    });
});

describe("keyframes", () => {
    const points = parseTimelineKeyframes(JSON.stringify([
        { time: 0, mask_x: 0.25, mask_feather: 0 },
        { time: 1, mask_x: 0.75, mask_feather: 0.5 },
    ]));

    it("keyframed channels override the static values; others stay static", () => {
        const s = spec({ shape: "circle", x: 0.5, width: 0.3, height: 0.3 });
        expect(maskParamValues(s, points, 0.5)).toMatchObject({ mx: 0.5, mf: 0.25, mw: 0.3 });
        expect(maskParamValues(s, points, 0)).toMatchObject({ mx: 0.25 });
        expect(maskParamValues(s, [], 0)).toMatchObject({ mx: 0.5, mf: 0 });
        expect(at(s, 50, 50, points, 0)).toBe(255);
        expect(at(s, 50, 50, points, 1)).toBe(0);
        expect(isMaskAnimated(s, points)).toBe(true);
        expect(isMaskAnimated(s, [])).toBe(false);
        expect(isMaskAnimated(s, parseTimelineKeyframes(JSON.stringify([{ time: 0, scale: 2 }, { time: 1, scale: 1 }])))).toBe(false);
    });

    it("clamps keyframed values to the spec ranges and never yields a non-finite parameter", () => {
        const s = spec({ shape: "rectangle", x: 0.4, width: 0.3, height: 0.3 });
        const huge = parseTimelineKeyframes(JSON.stringify([
            { time: 0, mask_x: -1e300, mask_y: 1e300, mask_w: 1e300, mask_h: -1e300, mask_rotation: 1e300, mask_feather: 1e300 },
            { time: 1, mask_x: 1e300, mask_y: -1e300, mask_w: -1e300, mask_h: 1e300, mask_rotation: -1e300, mask_feather: -1e300, easing: 3 },
        ]));
        for (const t of [0, 0.25, 0.5, 1]) {
            const values = maskParamValues(s, huge, t);
            for (const value of Object.values(values)) expect(Number.isFinite(value)).toBe(true);
            expect(values.mx).toBeGreaterThanOrEqual(-2);
            expect(values.mx).toBeLessThanOrEqual(3);
            expect(values.mw).toBeGreaterThanOrEqual(0.01);
            expect(values.mw).toBeLessThanOrEqual(5);
            expect(Math.abs(values.mr)).toBeLessThanOrEqual(3600);
            expect(values.mf).toBeGreaterThanOrEqual(0);
            expect(values.mf).toBeLessThanOrEqual(1);
            const level = maskLevelAt(s, 100, 50, W, H, huge, t);
            expect(Number.isFinite(level)).toBe(true);
            expect(evaluate(maskExpr(s, huge), { X: 100, Y: 50, W, H, T: t, read: () => 0 })).toBe(level);
        }
        expect(maskParamValues(s, huge, 0)).toMatchObject({ mx: -2, my: 3, mw: 5, mh: 0.01, mr: 3600, mf: 1 });
        // A point that slipped past parsing with a non-finite value falls back to the static value.
        const broken = [{ time: 0, mask_x: Number.NaN, mask_w: Number.POSITIVE_INFINITY }] as unknown as Parameters<typeof maskParamValues>[1];
        expect(maskParamValues(s, broken, 0)).toMatchObject({ mx: 0.4, mw: 0.3 });
    });

    it("channels are the six numeric mask channels", () => {
        expect([...MASK_KEYFRAME_CHANNELS]).toEqual(["mask_x", "mask_y", "mask_w", "mask_h", "mask_rotation", "mask_feather"]);
    });

    it("maskExpr (keyframes as expressions of T) evaluates like the parameter path", () => {
        const s = spec({ shape: "star", width: 0.5, height: 0.6, rotation: 10 });
        const e = maskExpr(s, points);
        for (const t of [0, 0.3, 0.5, 1, 1.5]) {
            for (const [x, y] of [[100, 50], [70, 50], [130, 40], [100, 20]]) {
                expect(evaluate(e, { X: x, Y: y, W, H, T: t, read: () => 0 })).toBe(maskLevelAt(s, x, y, W, H, points, t));
            }
        }
        const exprs = maskParamExprs(s, points);
        expect(exprs.mw).toEqual({ k: "num", v: 0.5 });
    });
});

describe("backends", () => {
    it("the generated image is the evaluator's level at every pixel", () => {
        for (const shape of MASK_SHAPES) {
            const s = spec({ shape, x: 0.45, y: 0.55, width: 0.7, height: 0.5, rotation: 23, feather: 0.15, roundness: 0.4 });
            const image = maskImage(s, 40, 24);
            for (let y = 0; y < 24; y += 1) for (let x = 0; x < 40; x += 1) expect(image[y * 40 + x], `${shape} ${x},${y}`).toBe(maskLevelAt(s, x, y, 40, 24));
        }
    });

    it("a mask image is fast enough for the export", () => {
        const started = performance.now();
        maskImage(spec({ shape: "star", feather: 0.2, rotation: 12 }), 640, 360);
        // About 0.25 s for a star at 640×360 alone (2 s at 1080p): once per distinct mask and size, at compile time. The
        // bound leaves room for a fully loaded machine (the whole test suite runs in parallel).
        expect(performance.now() - started).toBeLessThan(10_000);
    }, 20_000);

    it("every shape emits GLSL with the seven parameters and geq within ffmpeg's ten slots, keyframed or not", () => {
        const keyframed = parseTimelineKeyframes(JSON.stringify([0, 0.4, 0.9, 1.3].map((time, i) => ({
            time, mask_x: 0.3 + i * 0.1, mask_y: 0.4, mask_w: 0.5 + i * 0.05, mask_h: 0.4, mask_rotation: i * 15, mask_feather: i * 0.1, easing: i % 4,
        }))));
        for (const shape of MASK_SHAPES) {
            for (const invert of [false, true]) {
                const level = maskLevelExpr(shape, invert);
                expect(paramsOf(level).every((name) => ["mf", "mh", "mo", "mr", "mw", "mx", "my"].includes(name))).toBe(true);
                expect(emitGlsl(level).expr.length).toBeGreaterThan(0);
                const s = spec({ shape, invert });
                const text = emitFfmpeg(maskExpr(s, keyframed), { target: "geq" }, { reuseSlots: true });
                expect(text.length, shape).toBeLessThan(8000);
                const slots = [...text.matchAll(/st\((\d+),/g)].map((m) => Number(m[1]));
                expect(Math.max(...slots)).toBeLessThanOrEqual(9);
                expect(letDepth(level)).toBeGreaterThan(0);
            }
        }
        expect(emitFfmpeg(maskExpr(spec({ shape: "circle" }), []), { target: "geq" }, { reuseSlots: true })).not.toContain("T");
        expect(emitFfmpeg(maskExpr(spec({ shape: "circle" }), keyframed, v("T")), { target: "geq" }, { reuseSlots: true })).toContain("T");
    });
});

describe("item boxes inside padded bitmaps (phase 10d: text and stickers)", () => {
    // A text bitmap is its layout box plus padding on every side; the mask lives in the box, not the bitmap.
    const outer = { width: 60, height: 34 };
    const inner = { width: 40.5, height: 21 };
    const box = centredMaskBox(outer, inner);

    it("centres the item box in the bitmap", () => {
        expect(box).toEqual({ x: 9.75, y: 6.5, width: 40.5, height: 21 });
        expect(centredMaskBox({ width: 10, height: 10 }, { width: 10, height: 10 })).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    });

    it("the level at a bitmap pixel is the item-box level at the shifted pixel, the box sizing the mask", () => {
        const s = spec({ shape: "star", x: 0.4, y: 0.6, width: 0.7, height: 0.5, rotation: 15, feather: 0.1 });
        for (const [x, y] of [[0, 0], [20, 17], [30, 10], [59, 33], [12, 6]]) {
            expect(maskLevelAt(s, x, y, outer.width, outer.height, [], 0, box)).toBe(maskLevelAt(s, x - box.x, y - box.y, box.width, box.height));
        }
        // Without a box the bitmap is the item (video clips): unchanged.
        expect(maskLevelAt(s, 20, 17, outer.width, outer.height, [], 0, undefined)).toBe(maskLevelAt(s, 20, 17, outer.width, outer.height));
    });

    it("the padding takes the mask's continuation (a big circle keeps a text's outline, a small one cuts it)", () => {
        const big = spec({ shape: "circle", width: 5, height: 5 });
        const small = spec({ shape: "circle", width: 0.3, height: 0.3 });
        expect(maskLevelAt(big, 1, 1, outer.width, outer.height, [], 0, box)).toBe(255);
        expect(maskLevelAt(small, 1, 1, outer.width, outer.height, [], 0, box)).toBe(0);
        expect(maskLevelAt(small, 29, 16, outer.width, outer.height, [], 0, box)).toBe(255);
    });

    it("the image, the keyframed expression, and the evaluator agree on a boxed mask", () => {
        const points = parseTimelineKeyframes(JSON.stringify({ keyframes: [{ time: 0, mask_x: 0.2, mask_rotation: 0 }, { time: 1, mask_x: 0.8, mask_rotation: 90 }] }));
        for (const shape of MASK_SHAPES) {
            const s = spec({ shape, width: 0.6, height: 0.5, feather: 0.2, roundness: 0.3 });
            const image = maskImage(s, outer.width, outer.height, points, 0.4, box);
            const e = maskExpr(s, points, v("T"), box);
            for (let y = 0; y < outer.height; y += 3) {
                for (let x = 0; x < outer.width; x += 3) {
                    const want = maskLevelAt(s, x, y, outer.width, outer.height, points, 0.4, box);
                    expect(image[y * outer.width + x], `${shape} image ${x},${y}`).toBe(want);
                    expect(evaluate(e, { X: x, Y: y, W: outer.width, H: outer.height, T: 0.4, read: () => 0 }), `${shape} expr ${x},${y}`).toBe(want);
                }
            }
        }
        // geq stays within ffmpeg's ten slots with the box shift.
        const text = emitFfmpeg(maskExpr(spec({ shape: "heart" }), points, v("T"), box), { target: "geq" }, { reuseSlots: true });
        expect(Math.max(...[...text.matchAll(/st\((\d+),/g)].map((m) => Number(m[1])))).toBeLessThanOrEqual(9);
    });

    it("video, image, text, and sticker clips take a mask; audio, effect, and graphics clips do not", () => {
        for (const trackType of ["video", "text", "sticker"]) expect(clipTakesMask({ trackType })).toBe(true);
        for (const trackType of ["audio", "effect", "remotion", "", null]) expect(clipTakesMask({ trackType })).toBe(false);
    });
});

describe("renderLookReference with a mask step", () => {
    it("adds the mask as alpha on RGB, multiplies an existing alpha (floor(a·L/255)), and keeps the colour", async () => {
        const { renderLookReference } = await import("./reference");
        const { itemLook } = await import("./look-plan");
        const plan = itemLook({ kind: "scene", maskJson: '{"shape":"circle","width":0.5,"height":0.5,"feather":0.3}' })!;
        const w = 20;
        const h = 10;
        const rgb = Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * 7) % 256);
        const out = renderLookReference({ width: w, height: h, channels: 3, data: rgb }, plan);
        expect(out.channels).toBe(4);
        const step = plan.steps[0] as Extract<typeof plan.steps[number], { kind: "mask" }>;
        const levels = maskImage(step.mask, w, h);
        for (let i = 0; i < w * h; i += 1) {
            expect([out.data[i * 4], out.data[i * 4 + 1], out.data[i * 4 + 2]]).toEqual([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
            expect(out.data[i * 4 + 3]).toBe(levels[i]);
        }
        const rgba = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 200 : 9));
        const masked = renderLookReference({ width: w, height: h, channels: 4, data: rgba }, plan);
        for (let i = 0; i < w * h; i += 1) expect(masked.data[i * 4 + 3]).toBe(Math.floor((200 * levels[i]) / 255));
    });
});
