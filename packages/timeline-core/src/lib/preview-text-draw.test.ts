import {
    applyPreviewTextTransform, drawPreviewTextBlock, layoutPreviewTextBlock, parsePreviewTextStyle, previewTextBlockBleed,
    previewTextWrapWidth, type PreviewTextContext,
} from "./preview-text-draw";

// A 2D context double: every character is 10 px wide; calls are recorded.
function recordingContext() {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = {
        font: "", textAlign: "start", textBaseline: "alphabetic", fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "miter",
        shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
        measureText: (text: string) => ({ width: text.length * 10 }) as TextMetrics,
        fillText: (text: string, x: number, y: number) => calls.push(["fillText", text, x, y]),
        strokeText: (text: string, x: number, y: number) => calls.push(["strokeText", text, x, y]),
        fillRect: (x: number, y: number, w: number, h: number) => calls.push(["fillRect", x, y, w, h]),
        beginPath: () => calls.push(["beginPath"]),
        moveTo: (x: number, y: number) => calls.push(["moveTo", x, y]),
        lineTo: (x: number, y: number) => calls.push(["lineTo", x, y]),
        stroke: () => calls.push(["stroke"]),
    };
    return { ctx: ctx as unknown as PreviewTextContext, calls };
}

describe("preview text style", () => {
    it("parses with preview defaults and caches", () => {
        const style = parsePreviewTextStyle(JSON.stringify({ fontSize: 40, color: "#f00" }));
        expect(style).toMatchObject({ fontSize: 40, color: "#f00", fontWeight: "bold", textAlign: "center", captionKind: "text" });
        expect(parsePreviewTextStyle(JSON.stringify({ fontSize: 40, color: "#f00" }))).toBe(style);
        expect(parsePreviewTextStyle("{bad").fontSize).toBe(24);
    });

    it("transforms and wrap widths", () => {
        expect(applyPreviewTextTransform("hello wORLD", "capitalize")).toBe("Hello World");
        expect(previewTextWrapWidth(parsePreviewTextStyle(null), 1000)).toBe(900);
        expect(previewTextWrapWidth(parsePreviewTextStyle(JSON.stringify({ captionKind: "caption" })), 1000)).toBeCloseTo(780);
    });
});

describe("layout and draw", () => {
    const input = { text: "aa bb", textStyle: JSON.stringify({ fontSize: 20, bgColor: "#000", strokeWidth: 2 }), scale: 2, frameScale: 0.5, frameWidth: 1000 };

    it("lays out at fontSize × scale × frameScale", () => {
        const { ctx } = recordingContext();
        const block = layoutPreviewTextBlock(ctx, input);
        expect(ctx.font).toBe("bold 20px Inter, sans-serif");
        expect(block.lines.map((l) => l.text)).toEqual(["aa bb"]);
        expect([block.width, block.height]).toEqual([50 + 16, 26]);
        expect(previewTextBlockBleed(block)).toBe(6);
    });

    it("draws background, stroke, then fill at the line anchors", () => {
        const { ctx, calls } = recordingContext();
        const block = layoutPreviewTextBlock(ctx, input);
        drawPreviewTextBlock(ctx, block, 100, 50);
        expect(calls).toEqual([
            ["fillRect", 98, 48, 70, 30],
            ["strokeText", "aa bb", 133, 63],
            ["fillText", "aa bb", 133, 63],
        ]);
    });

    const plain = (style: Record<string, unknown>, text = "ab") => ({ text, textStyle: JSON.stringify({ fontSize: 20, ...style }), scale: 1, frameScale: 1, frameWidth: 1000 });
    const fills = (calls: Array<[string, ...unknown[]]>) => calls.filter((c) => c[0] === "fillText");

    it("draws letter-spaced text one character at a time from the line start", () => {
        const { ctx, calls } = recordingContext();
        const block = layoutPreviewTextBlock(ctx, plain({ letterSpacing: 3 }));
        drawPreviewTextBlock(ctx, block, 0, 0);
        const line = block.lines[0];
        const start = block.width / 2 - line.width / 2;
        expect(ctx.textAlign).toBe("left");
        expect(fills(calls)).toEqual([
            ["fillText", "a", start, block.lineHeight / 2],
            ["fillText", "b", start + 10 + 3, block.lineHeight / 2],
        ]);
    });

    it("underlines each line under its glyphs", () => {
        const { ctx, calls } = recordingContext();
        const block = layoutPreviewTextBlock(ctx, plain({ textDecoration: "underline" }));
        drawPreviewTextBlock(ctx, block, 10, 20);
        const line = block.lines[0];
        const startX = 10 + block.width / 2 - line.width / 2;
        const underlineY = 20 + block.lineHeight / 2 + 20 * 0.34;
        expect(calls.filter((c) => c[0] === "moveTo" || c[0] === "lineTo")).toEqual([
            ["moveTo", startX, underlineY],
            ["lineTo", startX + line.width, underlineY],
        ]);
        expect(ctx.lineWidth).toBe(Math.max(1, 20 * 0.07));
    });

    it("anchors left and right aligned lines 8 px inside the box", () => {
        for (const [textAlign, anchor] of [["left", (w: number) => 5 + 8], ["right", (w: number) => 5 + w - 8]] as const) {
            const { ctx, calls } = recordingContext();
            const block = layoutPreviewTextBlock(ctx, plain({ textAlign }));
            drawPreviewTextBlock(ctx, block, 5, 0);
            expect(ctx.textAlign).toBe(textAlign);
            expect(fills(calls)).toEqual([["fillText", "ab", anchor(block.width), block.lineHeight / 2]]);
        }
    });

    it("sets the shadow from the style at the pixel scale", () => {
        const { ctx } = recordingContext();
        const block = layoutPreviewTextBlock(ctx, { ...plain({ shadowBlur: 4, shadowColor: "#123", shadowOffsetX: 2, shadowOffsetY: -1 }), scale: 2 });
        drawPreviewTextBlock(ctx, block, 0, 0);
        expect([ctx.shadowColor, ctx.shadowBlur, ctx.shadowOffsetX, ctx.shadowOffsetY]).toEqual(["#123", 8, 4, -2]);
    });

    it("draws wrapped lines one line height apart", () => {
        const { ctx, calls } = recordingContext();
        const block = layoutPreviewTextBlock(ctx, { ...plain({}, "aaaa bbbb"), frameWidth: 60 });
        drawPreviewTextBlock(ctx, block, 0, 0);
        expect(block.lines.length).toBeGreaterThan(1);
        expect(fills(calls).map((c) => c[3])).toEqual(block.lines.map((_, i) => block.lineHeight * (i + 0.5)));
    });
});

// Records every method call and every property assignment, in order, so old style JSON can be pinned
// to the exact canvas traffic it produced before phase 10b.
function tracingContext() {
    const trace: unknown[][] = [];
    const state: Record<string, unknown> = {
        font: "", textAlign: "start", textBaseline: "alphabetic", fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "miter",
        shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    };
    const methods: Record<string, (...args: unknown[]) => unknown> = {
        measureText: (text: unknown) => ({ width: String(text).length * 10 }),
    };
    const ctx = new Proxy({}, {
        get(_, key: string) {
            if (key in methods) return methods[key];
            if (key in state) return state[key];
            if (["fillText", "strokeText", "fillRect", "beginPath", "moveTo", "lineTo", "stroke"].includes(key)) {
                return (...args: unknown[]) => { trace.push([key, ...args]); };
            }
            return undefined;
        },
        set(_, key: string, value: unknown) {
            state[key] = value;
            trace.push(["set", key, value]);
            return true;
        },
        has(_, key: string) {
            return key in methods || key in state || ["fillText", "strokeText", "fillRect", "beginPath", "moveTo", "lineTo", "stroke"].includes(key);
        },
    });
    return { ctx: ctx as unknown as PreviewTextContext, trace };
}

// Recorded from the pre-10b drawing code (traces of tracingContext at scale 1.5 × frameScale 0.5, box at (10, 20)).
const PINNED: Record<string, string> = {
    "default": "{\"trace\":[[\"set\",\"font\",\"bold 18px Inter, sans-serif\"],[\"set\",\"textAlign\",\"center\"],[\"set\",\"textBaseline\",\"middle\"],[\"set\",\"textAlign\",\"center\"],[\"set\",\"fillStyle\",\"#FFFFFF\"],[\"fillText\",\"Hello\",43,31.700000000000003]],\"bleed\":4,\"box\":[66,23.400000000000002,23.400000000000002]}",
    "box stroke shadow": "{\"trace\":[[\"set\",\"font\",\"bold 22.5px Inter, sans-serif\"],[\"set\",\"textAlign\",\"center\"],[\"set\",\"textBaseline\",\"middle\"],[\"set\",\"fillStyle\",\"rgba(0,0,0,0.5)\"],[\"fillRect\",8,18,100,33.25],[\"set\",\"shadowColor\",\"rgba(0,0,0,0.6)\"],[\"set\",\"shadowBlur\",4.5],[\"set\",\"shadowOffsetX\",0],[\"set\",\"shadowOffsetY\",1.5],[\"set\",\"textAlign\",\"center\"],[\"set\",\"strokeStyle\",\"#111\"],[\"set\",\"lineWidth\",2.25],[\"set\",\"lineJoin\",\"round\"],[\"strokeText\",\"Hi there\",58,34.625],[\"set\",\"fillStyle\",\"#FFFFFF\"],[\"fillText\",\"Hi there\",58,34.625]],\"bleed\":17,\"box\":[96,29.25,29.25]}",
    "spaced underline italic": "{\"trace\":[[\"set\",\"font\",\"italic bold 15px Inter, sans-serif\"],[\"set\",\"textAlign\",\"center\"],[\"set\",\"textBaseline\",\"middle\"],[\"set\",\"textAlign\",\"left\"],[\"set\",\"fillStyle\",\"#abc\"],[\"fillText\",\"a\",18,29.75],[\"set\",\"fillStyle\",\"#abc\"],[\"fillText\",\"b\",29.5,29.75],[\"set\",\"fillStyle\",\"#abc\"],[\"fillText\",\" \",41,29.75],[\"set\",\"fillStyle\",\"#abc\"],[\"fillText\",\"c\",52.5,29.75],[\"set\",\"fillStyle\",\"#abc\"],[\"fillText\",\"d\",64,29.75],[\"beginPath\"],[\"set\",\"strokeStyle\",\"#abc\"],[\"set\",\"lineWidth\",1.05],[\"moveTo\",18,34.85],[\"lineTo\",74,34.85],[\"stroke\"]],\"bleed\":4,\"box\":[72,19.5,19.5]}",
    "right wrapped": "{\"trace\":[[\"set\",\"font\",\"bold 15px Inter, sans-serif\"],[\"set\",\"textAlign\",\"right\"],[\"set\",\"textBaseline\",\"middle\"],[\"set\",\"textAlign\",\"right\"],[\"set\",\"strokeStyle\",\"#000000\"],[\"set\",\"lineWidth\",0.75],[\"set\",\"lineJoin\",\"round\"],[\"strokeText\",\"aaaa bbbb\",108,29.75],[\"set\",\"fillStyle\",\"#FFFFFF\"],[\"fillText\",\"aaaa bbbb\",108,29.75],[\"set\",\"textAlign\",\"right\"],[\"set\",\"strokeStyle\",\"#000000\"],[\"set\",\"lineWidth\",0.75],[\"set\",\"lineJoin\",\"round\"],[\"strokeText\",\"cccc\",108,49.25],[\"set\",\"fillStyle\",\"#FFFFFF\"],[\"fillText\",\"cccc\",108,49.25]],\"bleed\":5,\"box\":[106,39,19.5]}",
    "caption preset": "{\"trace\":[[\"set\",\"font\",\"700 42px Inter, sans-serif\"],[\"set\",\"textAlign\",\"center\"],[\"set\",\"textBaseline\",\"middle\"],[\"set\",\"fillStyle\",\"rgba(0,0,0,0.62)\"],[\"fillRect\",8,18,200,58.6],[\"set\",\"shadowColor\",\"rgba(0,0,0,0.7)\"],[\"set\",\"shadowBlur\",3],[\"set\",\"shadowOffsetX\",0],[\"set\",\"shadowOffsetY\",1.5],[\"set\",\"textAlign\",\"center\"],[\"set\",\"fillStyle\",\"#ffffff\"],[\"fillText\",\"Caption words here\",108,47.3]],\"bleed\":12,\"box\":[196,54.6,54.6]}",
};

describe("pre-10b styles draw exactly as before", () => {
    const cases: Array<[string, string | null, string]> = [
        ["default", null, "Hello"],
        ["box stroke shadow", JSON.stringify({ fontSize: 30, bgColor: "rgba(0,0,0,0.5)", strokeWidth: 3, strokeColor: "#111", shadowBlur: 6, shadowOffsetY: 2 }), "Hi there"],
        ["spaced underline italic", JSON.stringify({ fontSize: 20, letterSpacing: 2, textDecoration: "underline", fontStyle: "italic", color: "#abc" }), "ab cd"],
        ["right wrapped", JSON.stringify({ fontSize: 20, textAlign: "right", strokeWidth: 1 }), "aaaa bbbb cccc"],
        ["caption preset", '{"textClipKind":"caption","captionKind":"caption","captionPosition":"bottom","wordsPerLine":"multiple","maxWidthRatio":0.78,"fontSize":56,"fontWeight":"700","fontFamily":"Inter, sans-serif","color":"#ffffff","textAlign":"center","strokeWidth":0,"strokeColor":"#000000","bgColor":"rgba(0,0,0,0.62)","letterSpacing":0,"shadowColor":"rgba(0,0,0,0.7)","shadowBlur":4,"shadowOffsetY":2}', "Caption words here"],
    ];

    for (const [name, textStyle, text] of cases) {
        it(name, () => {
            const { ctx, trace } = tracingContext();
            const block = layoutPreviewTextBlock(ctx, { text, textStyle, scale: 1.5, frameScale: 0.5, frameWidth: name === "right wrapped" ? 120 : 1000 });
            drawPreviewTextBlock(ctx, block, 10, 20);
            const got = { trace, bleed: previewTextBlockBleed(block), box: [block.width, block.height, block.lineHeight] };
            expect(got).toEqual(JSON.parse(PINNED[name]));
        });
    }
});

// A context with the optional 10b members (rounded rects, gradients, fill).
function richContext(options: { roundRect?: boolean } = {}) {
    const { ctx, calls } = recordingContext();
    const rich = ctx as unknown as Record<string, unknown>;
    rich.fill = () => calls.push(["fill"]);
    rich.closePath = () => calls.push(["closePath"]);
    rich.arcTo = (...args: number[]) => calls.push(["arcTo", ...args]);
    if (options.roundRect !== false) rich.roundRect = (...args: number[]) => calls.push(["roundRect", ...args]);
    rich.createLinearGradient = (...args: number[]) => {
        const stops: Array<[number, string]> = [];
        calls.push(["createLinearGradient", ...args]);
        return { stops, addColorStop: (offset: number, color: string) => stops.push([offset, color]) };
    };
    return { ctx, calls };
}

describe("phase 10b style fields", () => {
    const block10b = (style: Record<string, unknown>, ctx: PreviewTextContext, text = "ab") =>
        layoutPreviewTextBlock(ctx, { text, textStyle: JSON.stringify({ fontSize: 20, ...style }), scale: 2, frameScale: 0.5, frameWidth: 1000 });

    it("parses new fields with neutral defaults", () => {
        const style = parsePreviewTextStyle(JSON.stringify({ fontSize: 31 }));
        expect(style).toMatchObject({ bgPadding: null, bgRadius: 0, gradient: null, glowColor: "", glowSize: 0, lineHeight: 1.3, highlightColor: "", karaoke: null });
        const rich = parsePreviewTextStyle(JSON.stringify({
            bgPadding: 12, bgRadius: 8, gradient: { from: "#f00", to: "#00f", angle: 45 }, glowColor: "#0ff", glowSize: 10,
            lineHeight: 1.6, highlightColor: "#ff0", karaoke: "box",
        }));
        expect(rich).toMatchObject({ bgPadding: 12, bgRadius: 8, gradient: { from: "#f00", to: "#00f", angle: 45 }, glowColor: "#0ff", glowSize: 10, lineHeight: 1.6, highlightColor: "#ff0", karaoke: "box" });
        const bad = parsePreviewTextStyle(JSON.stringify({ bgPadding: -3, lineHeight: 99, karaoke: "wave", gradient: { from: "#f00" }, glowSize: "x" }));
        expect(bad).toMatchObject({ bgPadding: null, lineHeight: 1.3, karaoke: null, gradient: null, glowSize: 0 });
        expect(parsePreviewTextStyle(JSON.stringify({ gradient: { from: "#f00", to: "#0f0" } })).gradient).toEqual({ from: "#f00", to: "#0f0", angle: 90 });
    });

    it("lays out with the line height multiplier", () => {
        const { ctx } = recordingContext();
        const block = block10b({ lineHeight: 2 }, ctx);
        expect(block.lineHeight).toBe(40);
        expect(block.height).toBe(40);
    });

    it("pads the background box at the pixel scale", () => {
        const { ctx, calls } = recordingContext();
        const block = block10b({ bgColor: "#000", bgPadding: 10 }, ctx);
        drawPreviewTextBlock(ctx, block, 100, 50);
        expect(calls[0]).toEqual(["fillRect", 90, 40, block.width + 20, block.height + 20]);
        expect(previewTextBlockBleed(block)).toBe(14);
    });

    it("rounds the box with roundRect, clamping the radius to half the short side", () => {
        const { ctx, calls } = richContext();
        const block = block10b({ bgColor: "#000", bgPadding: 4, bgRadius: 999 }, ctx);
        drawPreviewTextBlock(ctx, block, 0, 0);
        const h = block.height + 8;
        expect(calls.slice(0, 3)).toEqual([["beginPath"], ["roundRect", -4, -4, block.width + 8, h, h / 2], ["fill"]]);
        expect(calls.some((c) => c[0] === "fillRect")).toBe(false);
    });

    it("rounds the box with arcs when roundRect is missing", () => {
        const { ctx, calls } = richContext({ roundRect: false });
        const block = block10b({ bgColor: "#000", bgRadius: 3 }, ctx);
        drawPreviewTextBlock(ctx, block, 0, 0);
        expect(calls.filter((c) => c[0] === "arcTo")).toHaveLength(4);
        expect(calls.slice(0, 2)).toEqual([["beginPath"], ["moveTo", -2 + 3, -2]]);
        expect(calls.findIndex((c) => c[0] === "fill")).toBeLessThan(calls.findIndex((c) => c[0] === "fillText"));
    });

    it("fills with a linear gradient across the box", () => {
        const { ctx, calls } = richContext();
        const block = block10b({ gradient: { from: "#f00", to: "#00f", angle: 0 } }, ctx);
        let filled: unknown = null;
        const rec = ctx as unknown as Record<string, unknown>;
        const fillText = rec.fillText as (...a: unknown[]) => void;
        rec.fillText = (...a: unknown[]) => { filled = ctx.fillStyle; fillText(...a); };
        drawPreviewTextBlock(ctx, block, 10, 0);
        const gradientCall = calls.find((c) => c[0] === "createLinearGradient")!;
        expect(gradientCall.slice(1)).toEqual([10, block.height / 2, 10 + block.width, block.height / 2]);
        expect((filled as { stops: unknown[] }).stops).toEqual([[0, "#f00"], [1, "#00f"]]);
    });

    it("falls back to the plain fill colour when a gradient colour is unparsable (addColorStop throws)", () => {
        // Browsers throw a SyntaxError from addColorStop on a bad colour: the draw (preview loop, export raster)
        // must not stop.
        const { ctx, calls } = richContext();
        const rec = ctx as unknown as Record<string, unknown>;
        rec.createLinearGradient = (...args: number[]) => {
            calls.push(["createLinearGradient", ...args]);
            return { addColorStop: (_offset: number, color: string) => { if (color === "not-a-colour") throw new SyntaxError(`bad colour ${color}`); } };
        };
        const fills: unknown[] = [];
        const fillText = rec.fillText as (...a: unknown[]) => void;
        rec.fillText = (...a: unknown[]) => { fills.push(ctx.fillStyle); fillText(...a); };
        const block = block10b({ color: "#123456", strokeWidth: 2, gradient: { from: "#f00", to: "not-a-colour", angle: 0 } }, ctx);
        expect(() => drawPreviewTextBlock(ctx, block, 0, 0)).not.toThrow();
        expect(fills).toEqual(["#123456"]);
        // A context that cannot build the gradient at all (throws) falls back the same way.
        rec.createLinearGradient = () => { throw new TypeError("non-finite"); };
        fills.length = 0;
        expect(() => drawPreviewTextBlock(ctx, block, 0, 0)).not.toThrow();
        expect(fills).toEqual(["#123456"]);
    });

    it("draws glow passes before the shadow, stroke, and fill", () => {
        const { ctx, calls } = recordingContext();
        const shadows: unknown[] = [];
        const rec = ctx as unknown as Record<string, unknown>;
        const fillText = rec.fillText as (...a: unknown[]) => void;
        rec.fillText = (...a: unknown[]) => { shadows.push([ctx.shadowColor, ctx.shadowBlur, ctx.fillStyle]); fillText(...a); };
        const block = block10b({ glowColor: "#0ff", glowSize: 8, strokeWidth: 2 }, ctx);
        drawPreviewTextBlock(ctx, block, 0, 0);
        expect(calls.map((c) => c[0])).toEqual(["fillText", "fillText", "strokeText", "fillText"]);
        expect(shadows).toEqual([["#0ff", 8, "#0ff"], ["#0ff", 4, "#0ff"], [ctx.shadowColor, 0, "#FFFFFF"]]);
        expect(previewTextBlockBleed(block)).toBe(Math.ceil(4 + 2 + 16));
    });
});
