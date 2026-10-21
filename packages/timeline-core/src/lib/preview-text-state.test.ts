import {
    drawPreviewTextBlock, drawPreviewTextState, layoutPreviewTextBlock, previewTextBlockBleed, type PreviewTextContext,
} from "./preview-text-draw";

type Call = [string, ...unknown[]];

// A context double with the optional members: 10 px per character; calls and alpha/fill at each text call are recorded.
function fakeContext(options: { size?: [number, number] } = {}) {
    const calls: Call[] = [];
    const ctx: Record<string, unknown> = {
        font: "", textAlign: "start", textBaseline: "alphabetic", fillStyle: "#000", strokeStyle: "", lineWidth: 1, lineJoin: "miter",
        shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, globalAlpha: 1,
        measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
        fillText: (text: string, x: number, y: number) => calls.push(["fillText", text, x, y, ctx.fillStyle, ctx.globalAlpha, ctx.textAlign]),
        strokeText: (text: string, x: number, y: number) => calls.push(["strokeText", text, x, y]),
        fillRect: (...a: number[]) => calls.push(["fillRect", ...a]),
        beginPath: () => calls.push(["beginPath"]),
        moveTo: (...a: number[]) => calls.push(["moveTo", ...a]),
        lineTo: (...a: number[]) => calls.push(["lineTo", ...a]),
        stroke: () => calls.push(["stroke"]),
        fill: () => calls.push(["fill", ctx.fillStyle]),
        save: () => calls.push(["save"]),
        restore: () => calls.push(["restore"]),
        rect: (...a: number[]) => calls.push(["rect", ...a]),
        clip: () => calls.push(["clip"]),
        roundRect: (...a: number[]) => calls.push(["roundRect", ...a]),
        drawImage: (image: unknown, x: number, y: number) => calls.push(["drawImage", image, x, y]),
        getImageData: (x: number, y: number, w: number, h: number) => {
            calls.push(["getImageData", x, y, w, h]);
            const data = new Uint8ClampedArray(w * h * 4);
            data[((h >> 1) * w + (w >> 1)) * 4 + 3] = 255;
            return { data, width: w, height: h };
        },
        putImageData: (image: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) => calls.push(["putImageData", image.width, image.height, x, y, image.data[((image.height >> 1) * image.width + (image.width >> 1)) * 4 + 3]]),
    };
    void options;
    return { ctx: ctx as unknown as PreviewTextContext, calls };
}

const layout = (ctx: PreviewTextContext, style: Record<string, unknown> = {}, text = "Hello world", frameWidth = 1000) =>
    layoutPreviewTextBlock(ctx, { text, textStyle: JSON.stringify({ fontSize: 20, ...style }), scale: 1, frameScale: 1, frameWidth });

const texts = (calls: Call[]) => calls.filter((c) => c[0] === "fillText").map((c) => c[1]);

describe("drawPreviewTextState", () => {
    it("draws the full state exactly like drawPreviewTextBlock", () => {
        for (const style of [{}, { bgColor: "#000", bgPadding: 6, bgRadius: 4, strokeWidth: 2, glowSize: 5, glowColor: "#0ff" }, { letterSpacing: 3, textDecoration: "underline" }]) {
            const a = fakeContext();
            drawPreviewTextBlock(a.ctx, layout(a.ctx, style), 5, 7);
            const b = fakeContext();
            drawPreviewTextState(b.ctx, layout(b.ctx, style), 5, 7, { kind: "full" });
            expect(b.calls).toEqual(a.calls);
        }
    });

    it("typewriter draws the first glyphs of the full layout without reflow", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx);
        drawPreviewTextState(ctx, block, 0, 0, { kind: "typewriter", visible: 7 });
        const start = block.width / 2 - block.lines[0].width / 2;
        expect(calls.filter((c) => c[0] === "fillText")).toEqual([["fillText", "Hello wo", start, block.lineHeight / 2, "#FFFFFF", 1, "left"]]);
    });

    it("typewriter continues across wrapped lines and draws nothing at zero", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx, {}, "aaaa bbbb", 60);
        expect(block.lines.map((l) => l.text)).toEqual(["aaaa", "bbbb"]);
        drawPreviewTextState(ctx, block, 0, 0, { kind: "typewriter", visible: 6 });
        expect(texts(calls)).toEqual(["aaaa", "bb"]);
        const empty = fakeContext();
        drawPreviewTextState(empty.ctx, layout(empty.ctx, { bgColor: "#111" }), 0, 0, { kind: "typewriter", visible: 0 });
        expect(texts(empty.calls)).toEqual([]);
        expect(empty.calls[0][0]).toBe("fillRect");
    });

    it("typewriter with letter spacing draws glyph by glyph at the full layout positions", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx, { letterSpacing: 2 }, "abc");
        drawPreviewTextState(ctx, block, 0, 0, { kind: "typewriter", visible: 2 });
        const start = block.width / 2 - block.lines[0].width / 2;
        expect(calls.filter((c) => c[0] === "fillText").map((c) => [c[1], c[2]])).toEqual([["a", start], ["b", start + 12]]);
    });

    it("typewriter at the glyph count equals the full block", () => {
        const a = fakeContext();
        drawPreviewTextBlock(a.ctx, layout(a.ctx), 0, 0);
        const b = fakeContext();
        drawPreviewTextState(b.ctx, layout(b.ctx), 0, 0, { kind: "typewriter", visible: 10 });
        expect(b.calls).toEqual(a.calls);
    });

    it("wipe clips the full drawing to the revealed fraction of the padded box", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx);
        const bleed = previewTextBlockBleed(block);
        drawPreviewTextState(ctx, block, 10, 20, { kind: "wipe", fraction: 0.25 });
        expect(calls.slice(0, 4)).toEqual([["save"], ["beginPath"], ["rect", 10 - bleed, 20 - bleed, (block.width + bleed * 2) * 0.25, block.height + bleed * 2], ["clip"]]);
        expect(calls.at(-1)).toEqual(["restore"]);
        expect(texts(calls)).toEqual(["Hello world"]);
        const none = fakeContext();
        drawPreviewTextState(none.ctx, layout(none.ctx), 0, 0, { kind: "wipe", fraction: 0 });
        expect(none.calls).toEqual([]);
    });

    it("blur draws into a temporary canvas, blurs its pixels, and draws the bitmap back", () => {
        const { ctx, calls } = fakeContext();
        const temp = fakeContext();
        const created: Array<[number, number]> = [];
        const tempCanvas = { width: 0, height: 0, getContext: () => temp.ctx };
        const helpers = { createCanvas: (w: number, h: number) => { created.push([w, h]); tempCanvas.width = w; tempCanvas.height = h; return tempCanvas; } };
        const block = layout(ctx);
        drawPreviewTextState(ctx, block, 10, 20, { kind: "blur", radius: 4 }, helpers);
        const pad = previewTextBlockBleed(block, [{ kind: "blur", radius: 4 }]);
        expect(created).toEqual([[Math.ceil(block.width + pad * 2), Math.ceil(block.height + pad * 2)]]);
        expect(texts(temp.calls)).toEqual(["Hello world"]);
        const put = temp.calls.find((c) => c[0] === "putImageData")!;
        expect(put[5]).toBeLessThan(255);
        expect(calls.filter((c) => c[0] === "drawImage")).toEqual([["drawImage", tempCanvas, 10 - pad, 20 - pad]]);
        expect(texts(calls)).toEqual([]);
        const fallback = fakeContext();
        drawPreviewTextState(fallback.ctx, layout(fallback.ctx), 0, 0, { kind: "blur", radius: 4 });
        expect(texts(fallback.calls)).toEqual(["Hello world"]);
    });

    it("glow scales the glow passes by level", () => {
        const { ctx, calls } = fakeContext();
        const blurs: number[] = [];
        const record = ctx as unknown as Record<string, unknown>;
        const fillText = record.fillText as (...a: unknown[]) => void;
        record.fillText = (...a: unknown[]) => { blurs.push(ctx.shadowBlur); fillText(...a); };
        const block = layout(ctx, { glowColor: "#f0f", glowSize: 10 });
        drawPreviewTextState(ctx, block, 0, 0, { kind: "glow", level: 1 });
        expect(blurs.slice(0, 2)).toEqual([20, 10]);
        expect(calls.filter((c) => c[0] === "fillText").slice(0, 2).every((c) => c[4] === "#f0f")).toBe(true);
        expect(previewTextBlockBleed(block, [{ kind: "glow", level: 1 }])).toBeGreaterThan(previewTextBlockBleed(block));
    });

    it("letters draw glyphs with staggered offset and alpha", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx, {}, "abcd");
        drawPreviewTextState(ctx, block, 0, 0, { kind: "letters", progress: 0.5, direction: "rise" });
        const fills = calls.filter((c) => c[0] === "fillText");
        expect(fills.map((c) => c[1])).toEqual(["a", "b", "c", "d"].filter((_, i) => (fills[i]?.[5] as number) > 0));
        const alphas = fills.map((c) => c[5] as number);
        expect(alphas[0]).toBe(1);
        expect(alphas).toEqual([...alphas].sort((a, b) => b - a));
        const ys = fills.map((c) => c[3] as number);
        expect(ys[0]).toBe(block.lineHeight / 2);
        expect(ys.at(-1)!).toBeGreaterThan(block.lineHeight / 2);
        expect(ctx.globalAlpha).toBe(1);
        const fall = fakeContext();
        drawPreviewTextState(fall.ctx, layout(fall.ctx, {}, "abcd"), 0, 0, { kind: "letters", progress: 0.5, direction: "fall" });
        const fallFills = fall.calls.filter((c) => c[0] === "fillText");
        expect(fallFills[0][1]).not.toBe("a");
        expect(fallFills.at(-1)![1]).toBe("d");
    });

    it("karaoke highlights the current word", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx, { karaoke: "highlight", highlightColor: "#ff0", strokeWidth: 2 }, "one two three");
        drawPreviewTextState(ctx, block, 0, 0, { kind: "karaoke", word: 1 });
        const fills = calls.filter((c) => c[0] === "fillText");
        expect(fills.map((c) => [c[1], c[4]])).toEqual([["one", "#FFFFFF"], ["two", "#ff0"], ["three", "#FFFFFF"]]);
        const start = block.width / 2 - block.lines[0].width / 2;
        expect(fills.map((c) => c[2])).toEqual([start, start + 40, start + 80]);
        expect(calls.filter((c) => c[0] === "strokeText")).toHaveLength(3);
    });

    it("karaoke box draws a rounded pill behind the current word (and its group)", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx, { karaoke: "box", highlightColor: "#70f" }, "one two three four");
        drawPreviewTextState(ctx, block, 0, 0, { kind: "karaoke", word: 1, through: 2 });
        const pills = calls.filter((c) => c[0] === "roundRect");
        expect(pills).toHaveLength(2);
        expect(calls.filter((c) => c[0] === "fill").every((c) => c[1] === "#70f")).toBe(true);
        expect(calls.findIndex((c) => c[0] === "roundRect")).toBeLessThan(calls.findIndex((c) => c[0] === "fillText"));
        expect(calls.filter((c) => c[0] === "fillText").every((c) => c[4] === "#FFFFFF")).toBe(true);
    });

    it("karaoke maps words across wrapped lines", () => {
        const { ctx, calls } = fakeContext();
        const block = layout(ctx, { karaoke: "highlight", highlightColor: "#ff0" }, "aaaa bbbb cc", 60);
        drawPreviewTextState(ctx, block, 0, 0, { kind: "karaoke", word: 2 });
        expect(calls.filter((c) => c[0] === "fillText" && c[4] === "#ff0").map((c) => c[1])).toEqual(["cc"]);
    });

    it("bleed covers blur and letter offsets", () => {
        const { ctx } = fakeContext();
        const block = layout(ctx);
        const base = previewTextBlockBleed(block);
        expect(previewTextBlockBleed(block, [{ kind: "full" }])).toBe(base);
        expect(previewTextBlockBleed(block, [{ kind: "blur", radius: 5 }])).toBeGreaterThanOrEqual(base + 15);
        expect(previewTextBlockBleed(block, [{ kind: "letters", progress: 0, direction: "rise" }])).toBeGreaterThan(base);
    });
});
