// Every built-in graphics template (phase 10d): paints at a settled frame inside its returned bounds, is
// deterministic, animates in, survives malformed parameters, scales with the output, and stays inside the frame.
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../model/timeline";
import { drawGraphicsFrame, graphicsProps } from "../render";
import { GRAPHICS_TEMPLATES } from "../templates";
import type { GraphicsAssets, GraphicsBounds, GraphicsContext } from "../types";
import { GRAPHICS_DRAWS } from "./index";
import { countdownRemaining } from "./countdown";
import { hashString, seededRandom, svgArc, wrapText } from "./helpers";
import { statCounterValue } from "./stat-counter";

const IDS: string[] = GRAPHICS_TEMPLATES.map((template) => template.id);

/** Templates covering the whole frame (or flying off it), exempt from the "stays inside the frame" check. */
const EDGE_TO_EDGE = new Set(["card", "gradient-backdrop", "shape-wipe", "confetti-burst", "progress-bar"]);

const W = 1280;
const H = 720;
const SETTLED_FRAME = 60;
/** Confetti has fallen out of the frame by 1.5 s (gravity 52 %/s², as the original), so it settles earlier. */
const settledFrame = (id: string) => (id === "confetti-burst" ? 20 : SETTLED_FRAME);

type Props = Record<string, unknown>;

const graphicsClip = (id: string, props: Props = {}, seconds = 4): TimelineClip => ({
    id: "g", trackType: "remotion", trackIndex: 1, startTime: 0, endTime: seconds, remotionTemplateId: id,
    remotionPropsJson: Object.keys(props).length ? JSON.stringify(props) : null,
} as TimelineClip);

interface Rendered {
    canvas: Canvas;
    bounds: GraphicsBounds | null;
    data: Uint8ClampedArray;
}

function render(id: string, frame: number, options: { props?: Props; width?: number; height?: number; seconds?: number; assets?: GraphicsAssets | null } = {}): Rendered {
    const width = options.width ?? W;
    const height = options.height ?? H;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d") as unknown as GraphicsContext;
    const bounds = drawGraphicsFrame(ctx, graphicsClip(id, options.props, options.seconds), { width, height, frame, assets: options.assets });
    const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
    return { canvas, bounds, data };
}

function alphaStats(r: Rendered, margin = 2): { total: number; inside: number } {
    const { width, height } = r.canvas;
    const b = r.bounds;
    let total = 0;
    let inside = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const a = r.data[(y * width + x) * 4 + 3];
            if (!a) continue;
            total += a;
            if (b && x + 1 > b.x - margin && x < b.x + b.width + margin && y + 1 > b.y - margin && y < b.y + b.height + margin) inside += a;
        }
    }
    return { total, inside };
}

function sameImage(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
}

function borderAlpha(r: Rendered): number {
    const { width, height } = r.canvas;
    let sum = 0;
    for (let x = 0; x < width; x += 1) sum += r.data[x * 4 + 3] + r.data[((height - 1) * width + x) * 4 + 3];
    for (let y = 0; y < height; y += 1) sum += r.data[y * width * 4 + 3] + r.data[(y * width + width - 1) * 4 + 3];
    return sum;
}

function malformedProps(id: string): Props[] {
    const template = GRAPHICS_TEMPLATES.find((t) => t.id === id)!;
    const variants: Props[] = [];
    const jsonValues = ["{broken", "", "null", "42", "{\"a\":1}", "[1, null, {\"label\": 5}, {\"label\": \"x\", \"value\": \"nope\"}]", "[]", "[{\"label\":\"a\",\"value\":-3}]", "[{\"label\":\"a\",\"value\":2,\"color\":\"nope\"},{\"label\":\"b\",\"value\":1,\"color\":7}]"];
    for (const value of jsonValues) {
        const props: Props = {};
        for (const p of template.params) {
            if (p.type === "json") props[p.key] = value;
            else if (p.type === "number") props[p.key] = "abc";
            else props[p.key] = "";
        }
        variants.push(props);
    }
    return variants;
}

function rawProps(id: string, pick: (type: string) => unknown): Props {
    const template = GRAPHICS_TEMPLATES.find((t) => t.id === id)!;
    return Object.fromEntries(template.params.map((p) => [p.key, pick(p.type)]));
}

describe.each(IDS)("graphics template %s", (id) => {
    const SETTLED = settledFrame(id);
    it("has a draw function", () => {
        expect(GRAPHICS_DRAWS[id]).toBeTypeOf("function");
    });

    it("paints at a settled frame, inside the returned bounds", () => {
        const r = render(id, SETTLED);
        expect(r.bounds).not.toBeNull();
        const { total, inside } = alphaStats(r);
        expect(total).toBeGreaterThan(0);
        expect(inside / total).toBeGreaterThan(0.99);
        const b = r.bounds!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(W + 1e-6);
        expect(b.y + b.height).toBeLessThanOrEqual(H + 1e-6);
    });

    it("keeps painted pixels inside the bounds across the clip", () => {
        for (const frame of [0, 1, 5, 12, 30, 90, 110, 119]) {
            const r = render(id, frame);
            const { total, inside } = alphaStats(r);
            if (total === 0) continue;
            expect(r.bounds, `frame ${frame}`).not.toBeNull();
            expect(inside / total, `frame ${frame}`).toBeGreaterThan(0.99);
        }
    });

    it("draws the same pixels for the same frame", () => {
        expect(sameImage(render(id, SETTLED).data, render(id, SETTLED).data)).toBe(true);
        expect(sameImage(render(id, 7).data, render(id, 7).data)).toBe(true);
    });

    it("leaves the host's context state as it was and honours its opacity", () => {
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext("2d");
        ctx.globalAlpha = 0.5;
        ctx.font = "10px serif";
        ctx.textAlign = "right";
        ctx.fillStyle = "#123456";
        const draw = GRAPHICS_DRAWS[id];
        draw(ctx as unknown as GraphicsContext, { width: W, height: H, frame: SETTLED, durationInFrames: 120, fps: 30, props: graphicsProps(graphicsClip(id)) });
        expect(ctx.globalAlpha).toBeCloseTo(0.5, 2);
        expect(ctx.font).toBe("10px serif");
        expect(ctx.textAlign).toBe("right");
        const m = ctx.getTransform();
        expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([1, 0, 0, 1, 0, 0]);
        const half = canvas.getContext("2d").getImageData(0, 0, W, H).data;
        let maxAlpha = 0;
        for (let i = 3; i < half.length; i += 4) maxAlpha = Math.max(maxAlpha, half[i]);
        expect(maxAlpha).toBeGreaterThan(0);
        // Each paint is at half opacity (overlapping paints compound, as with any per-draw globalAlpha).
        expect(maxAlpha).toBeLessThan(250);
        // The fill colour is back (checked by painting: @napi-rs/canvas reports a stale fillStyle after restore).
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        expect([...ctx.getImageData(0, 0, 1, 1).data]).toEqual([0x12, 0x34, 0x56, 255]);
    });

    it("animates in (the entrance frame differs from the settled frame)", () => {
        expect(sameImage(render(id, 0).data, render(id, SETTLED).data)).toBe(false);
    });

    it("survives malformed and empty parameters", () => {
        for (const props of malformedProps(id)) {
            for (const frame of [0, SETTLED]) {
                const r = render(id, frame, { props });
                if (r.bounds) for (const v of Object.values(r.bounds)) expect(Number.isFinite(v)).toBe(true);
            }
        }
        const draw = GRAPHICS_DRAWS[id];
        const raw = [
            {},
            rawProps(id, () => null),
            rawProps(id, () => ({})),
            rawProps(id, (t) => (t === "number" ? Number.NaN : t === "json" ? { not: "an array" } : 12)),
            rawProps(id, (t) => (t === "number" ? Number.POSITIVE_INFINITY : t === "json" ? [{ label: "a", value: 1e300 }, { label: "b", value: 2 }] : "x".repeat(400))),
            rawProps(id, (t) => (t === "number" ? -1e9 : t === "json" ? [] : " ")),
        ];
        for (const props of raw) {
            for (const frame of [0, SETTLED]) {
                const canvas = createCanvas(320, 180);
                const ctx = canvas.getContext("2d") as unknown as GraphicsContext;
                const bounds = draw(ctx, { width: W, height: H, frame, durationInFrames: 120, fps: 30, props });
                if (bounds) for (const v of Object.values(bounds)) expect(Number.isFinite(v)).toBe(true);
            }
        }
    });

    it("scales with the output size", () => {
        const small = render(id, SETTLED, { width: 640, height: 360 }).bounds!;
        const large = render(id, SETTLED, { width: 1920, height: 1080 }).bounds!;
        expect(small).not.toBeNull();
        expect(large).not.toBeNull();
        expect(large.x / 3).toBeCloseTo(small.x, 1);
        expect(large.y / 3).toBeCloseTo(small.y, 1);
        expect(large.width / 3).toBeCloseTo(small.width, 1);
        expect(large.height / 3).toBeCloseTo(small.height, 1);
    });

    it("keeps painted pixels inside the bounds for every select option", () => {
        const template = GRAPHICS_TEMPLATES.find((t) => t.id === id)!;
        for (const param of template.params.filter((p) => p.type === "select")) {
            for (const option of param.options ?? []) {
                for (const [width, height] of [[1280, 720], [720, 1280]]) {
                    const r = render(id, SETTLED, { props: { [param.key]: option }, width, height });
                    const { total, inside } = alphaStats(r);
                    if (total === 0) continue;
                    expect(inside / total, `${param.key}=${option} ${width}x${height}`).toBeGreaterThan(0.99);
                }
            }
        }
    });

    it.skipIf(EDGE_TO_EDGE.has(id))("stays inside the frame with default parameters (landscape and portrait)", () => {
        for (const [width, height] of [[1280, 720], [720, 1280], [1080, 1080]]) {
            for (const frame of [SETTLED, 100]) expect(borderAlpha(render(id, frame, { width, height })), `${width}x${height} @${frame}`).toBe(0);
        }
    });
});

describe("graphics helpers", () => {
    it("wraps words, keeps pre-wrap spaces, and breaks over-long words", () => {
        const ctx = createCanvas(10, 10).getContext("2d") as unknown as GraphicsContext;
        ctx.font = "20px sans-serif";
        const wrapped = wrapText(ctx, "one two three four five six", ctx.measureText("one two three").width + 1);
        expect(wrapped.lines[0]).toBe("one two three");
        expect(wrapped.lines.join(" ")).toBe("one two three four five six");
        expect(wrapText(ctx, "a\nb", 1000, "pre-wrap").lines).toEqual(["a", "b"]);
        const long = wrapText(ctx, "x".repeat(50), 100);
        expect(long.lines.length).toBeGreaterThan(1);
        for (const w of long.widths) expect(w).toBeLessThanOrEqual(100);
        expect(wrapText(ctx, "", 100).lines).toEqual([""]);
    });
    it("converts SVG arcs to canvas arcs", () => {
        const calls: number[][] = [];
        const ctx = { arc: (...a: unknown[]) => calls.push((a as number[]).slice(0, 5)) } as unknown as GraphicsContext;
        svgArc(ctx, 12, 2, 6, false, false, 6, 8);
        const [cx, cy, r, a0, a1] = calls[0];
        expect(cx).toBeCloseTo(12, 9);
        expect(cy).toBeCloseTo(8, 9);
        expect(r).toBeCloseTo(6, 9);
        expect(a0).toBeCloseTo(-Math.PI / 2, 9);
        expect(Math.abs(a1)).toBeCloseTo(Math.PI, 9);
    });
    it("has a stable integer PRNG", () => {
        expect(seededRandom(1)).toBe(seededRandom(1));
        expect(seededRandom(1)).not.toBe(seededRandom(2));
        const values = Array.from({ length: 1000 }, (_, i) => seededRandom(hashString("confetti") + i));
        expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...values)).toBeLessThan(1);
        expect(values.reduce((s, v) => s + v, 0) / values.length).toBeCloseTo(0.5, 1);
    });
});

/** Counts the context method calls a draw makes (by name). */
function spyRender(id: string, frame: number, props: Props): Record<string, number> {
    const canvas = createCanvas(W, H);
    const target = canvas.getContext("2d") as unknown as Record<string | symbol, unknown>;
    const calls: Record<string, number> = {};
    const spy = new Proxy(target, {
        get(t, p) {
            const value = Reflect.get(t, p);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
                calls[String(p)] = (calls[String(p)] ?? 0) + 1;
                return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
        },
        set(t, p, value) {
            return Reflect.set(t, p, value);
        },
    });
    drawGraphicsFrame(spy as unknown as GraphicsContext, graphicsClip(id, props), { width: W, height: H, frame });
    return calls;
}

function pixel(r: Rendered, x: number, y: number): number[] {
    const i = (Math.round(y) * r.canvas.width + Math.round(x)) * 4;
    return [...r.data.slice(i, i + 4)];
}

function crop(r: Rendered, cx: number, cy: number, w: number, h: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
        const start = ((cy - h / 2 + y) * r.canvas.width + (cx - w / 2)) * 4;
        out.set(r.data.subarray(start, start + w * 4), y * w * 4);
    }
    return out;
}

const DATA5 = JSON.stringify([
    { label: "A", value: 10 }, { label: "B", value: 30 }, { label: "C", value: 20 }, { label: "D", value: 50 }, { label: "E", value: 40 },
]);

describe("graphics template semantics", () => {
    it("countdown shows the remaining whole seconds", () => {
        expect(countdownRemaining(0, 30, 5)).toBe(5);
        expect(countdownRemaining(29, 30, 5)).toBe(5);
        expect(countdownRemaining(30, 30, 5)).toBe(4);
        expect(countdownRemaining(119, 30, 5)).toBe(2);
        expect(countdownRemaining(150, 30, 5)).toBe(0);
        expect(countdownRemaining(400, 30, 5)).toBe(0);
        // The digit drawn mid-second is the same picture for the same remaining count, whatever `from` is.
        const digit = (frame: number, from: number) => crop(render("countdown", frame, { props: { from }, seconds: 10 }), W / 2, H / 2, 160, 200);
        expect(sameImage(digit(15, 5), digit(45, 6))).toBe(true);
        expect(sameImage(digit(15, 5), digit(75, 7))).toBe(true);
        expect(sameImage(digit(15, 5), digit(45, 5))).toBe(false);
        expect(sameImage(digit(165, 5), digit(195, 5))).toBe(true);
    });

    it("stat counter counts up to the final value and holds it", () => {
        expect(statCounterValue(0, 30, 1000)).toBe(0);
        expect(statCounterValue(54, 30, 1000)).toBe(1000);
        expect(statCounterValue(200, 30, 1234567)).toBe(1234567);
        let previous = 0;
        for (let f = 0; f <= 60; f += 1) {
            const v = statCounterValue(f, 30, 1000);
            expect(v).toBeGreaterThanOrEqual(previous);
            previous = v;
        }
        expect(sameImage(render("stat-counter", 90).data, render("stat-counter", 110).data)).toBe(true);
        expect(sameImage(render("stat-counter", 20).data, render("stat-counter", 90).data)).toBe(false);
    });

    it("progress bar width tracks the clip progress", () => {
        const props = { barColor: "#00ff00", trackColor: "#ff0000" };
        const mid = render("progress-bar", 60, { props });
        expect(pixel(mid, W * 0.45, H - 5)).toEqual([0, 255, 0, 255]);
        expect(pixel(mid, W * 0.55, H - 5)).toEqual([255, 0, 0, 255]);
        const late = render("progress-bar", 107, { props });
        expect(pixel(late, W * 0.85, H - 5)).toEqual([0, 255, 0, 255]);
        expect(pixel(late, W * 0.95, H - 5)).toEqual([255, 0, 0, 255]);
        const top = render("progress-bar", 60, { props: { ...props, position: "top", label: "Loading" } });
        expect(top.bounds!.y).toBe(0);
    });

    it("bar chart draws one bar per data point", () => {
        const r = render("bar-chart", SETTLED_FRAME, { props: { data: DATA5, barColor: "#00ff00" } });
        const x = W * 0.08 + 140 + 3;
        let runs = 0;
        let inside = false;
        for (let y = 0; y < H; y += 1) {
            const [red, green, blue] = pixel(r, x, y);
            const bar = red < 40 && green > 215 && blue < 40;
            if (bar && !inside) runs += 1;
            inside = bar;
        }
        expect(runs).toBe(5);
    });

    it("line chart draws one dot per data point", () => {
        expect(spyRender("line-chart", SETTLED_FRAME, { data: DATA5 }).arc).toBe(5);
        expect(spyRender("line-chart", 0, { data: DATA5 }).arc ?? 0).toBe(0);
    });

    it("donut chart draws one segment per data point", () => {
        const data = JSON.stringify([{ label: "A", value: 1 }, { label: "B", value: 2 }, { label: "C", value: 3, color: "#123456" }, { label: "D", value: 4 }]);
        expect(spyRender("donut-chart", SETTLED_FRAME, { data }).arc).toBe(4);
        expect(spyRender("donut-chart", 0, { data }).arc ?? 0).toBe(0);
    });
});

describe("logo sting logo image", () => {
    const logo = createCanvas(200, 100);
    const lctx = logo.getContext("2d");
    lctx.fillStyle = "#ff0000";
    lctx.fillRect(0, 0, 200, 100);
    const assets: GraphicsAssets = { image: (url) => (url === "https://cdn.example/logo.png" ? (logo as unknown as CanvasImageSource) : null) };

    it("draws the host-decoded logo above the text, fitted into 280 × 280", () => {
        const textOnly = render("logo-sting", SETTLED_FRAME).bounds!;
        const withLogo = render("logo-sting", SETTLED_FRAME, { props: { logoUrl: " https://cdn.example/logo.png " }, assets });
        expect(withLogo.bounds!.height).toBeCloseTo(textOnly.height + 280 + 18, 0);
        // A 2:1 logo is contained in 280 × 140, centred in the 280 px box above the text.
        const b = withLogo.bounds!;
        const [red, green, blue, alpha] = pixel(withLogo, W / 2, b.y + 20 + 140);
        expect(red).toBeGreaterThan(200);
        expect(green).toBeLessThan(60);
        expect(blue).toBeLessThan(60);
        expect(alpha).toBe(255);
        expect(pixel(withLogo, W / 2, b.y + 20 + 50)[3]).toBe(0);
    });

    it("draws the text only when the logo is not available (never fetches)", () => {
        const textOnly = render("logo-sting", SETTLED_FRAME).data;
        expect(sameImage(render("logo-sting", SETTLED_FRAME, { props: { logoUrl: "https://cdn.example/missing.png" }, assets }).data, textOnly)).toBe(true);
        expect(sameImage(render("logo-sting", SETTLED_FRAME, { props: { logoUrl: "https://cdn.example/logo.png" } }).data, textOnly)).toBe(true);
    });
});

describe("confetti burst", () => {
    it("is the same burst in every renderer and grows with the particle count", () => {
        const few = render("confetti-burst", 20, { props: { count: 10 } });
        const many = render("confetti-burst", 20, { props: { count: 200 } });
        expect(alphaStats(many).total).toBeGreaterThan(alphaStats(few).total * 5);
        expect(sameImage(render("confetti-burst", 20, { props: { count: 10 } }).data, few.data)).toBe(true);
    });
});

describe("shape wipe", () => {
    it("covers the whole frame at the middle of the clip and nothing near the start", () => {
        const props = { color: "#00ff00" };
        const mid = render("shape-wipe", 59, { props, seconds: 4 - 1 / 30 });
        for (const [x, y] of [[5, 5], [W / 2, H / 2], [W - 20, H - 5]]) expect(pixel(mid, x, y)).toEqual([0, 255, 0, 255]);
        expect(render("shape-wipe", 0, { props }).bounds).toBeNull();
    });
});
