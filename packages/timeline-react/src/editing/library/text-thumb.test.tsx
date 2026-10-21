import { render } from "@testing-library/react";
import { textTemplateById } from "@opennan/timeline-core/text/templates";
import { captionStyleById } from "@opennan/timeline-core/text/captions";
import { TextThumb, drawTextThumb, restingKaraokeWord, textThumbFontQueries } from "./text-thumb";

/** A recording 2D context: glyphs are 0.55 em wide. */
function fakeContext() {
    const calls: Array<{ op: string; args: unknown[]; font: string; fillStyle: unknown }> = [];
    const ctx: Record<string, unknown> = {
        font: "10px sans-serif", textAlign: "left", textBaseline: "alphabetic", fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineJoin: "miter",
        shadowColor: "", shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, globalAlpha: 1,
    };
    const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(ctx.font))?.[1] ?? 10);
    const record = (op: string) => (...args: unknown[]) => { calls.push({ op, args, font: String(ctx.font), fillStyle: ctx.fillStyle }); };
    Object.assign(ctx, {
        measureText: (text: string) => ({ width: [...text].length * size() * 0.55 }),
        fillText: record("fillText"), strokeText: record("strokeText"), fillRect: record("fillRect"), clearRect: record("clearRect"),
        beginPath: record("beginPath"), moveTo: record("moveTo"), lineTo: record("lineTo"), stroke: record("stroke"), fill: record("fill"),
        save: record("save"), restore: record("restore"), roundRect: record("roundRect"),
        createLinearGradient: () => ({ addColorStop: () => undefined }),
    });
    return { ctx, calls };
}

describe("text thumbnails", () => {
    it("is a no-op without a 2D context", () => {
        expect(drawTextThumb(null, 160, 100, { text: "Hi", styleJson: null })).toBeNull();
    });

    it("fits a long template inside the thumbnail and draws it centred with the template's colours", () => {
        const tpl = textTemplateById("poster_bebas")!;
        const { ctx, calls } = fakeContext();
        const block = drawTextThumb(ctx as never, 160, 100, { text: tpl.defaultText, styleJson: JSON.stringify(tpl.style) })!;
        expect(block.width).toBeLessThanOrEqual(160 * 0.96);
        expect(block.height).toBeLessThanOrEqual(100 * 0.92);
        const fills = calls.filter((c) => c.op === "fillText");
        expect(fills.length).toBeGreaterThan(0);
        expect(fills.some((c) => c.fillStyle === "#FFFFFF")).toBe(true);
        expect(fills[0].font).toContain("Bebas Neue");
        expect(calls[0].op).toBe("clearRect");
    });

    it("draws a box for boxed templates and a karaoke state for karaoke captions", () => {
        const pill = textTemplateById("caption_pill")!;
        const boxed = fakeContext();
        drawTextThumb(boxed.ctx as never, 160, 100, { text: pill.defaultText, styleJson: JSON.stringify(pill.style) });
        expect(boxed.calls.some((c) => (c.op === "roundRect" || c.op === "fillRect") && c.fillStyle === "#FFFFFF")).toBe(true);
        const karaoke = captionStyleById("karaoke_highlight")!;
        const k = fakeContext();
        drawTextThumb(k.ctx as never, 160, 100, { text: "one two three", styleJson: JSON.stringify(karaoke.style), karaokeWord: 1 });
        expect(k.calls.some((c) => c.op === "fillText" && c.fillStyle === "#FFE14D")).toBe(true);
    });

    it("keeps the text above a reserved strip along the bottom (the karaoke card's badge)", () => {
        const style = JSON.stringify(captionStyleById("karaoke_highlight")!.style);
        const lowestLine = (reserveBottom?: number) => {
            const { ctx, calls } = fakeContext();
            drawTextThumb(ctx as never, 160, 100, { text: "Captions look like this", styleJson: style, karaokeWord: 1, reserveBottom });
            return Math.max(...calls.filter((c) => c.op === "fillText" || c.op === "strokeText").map((c) => Number(c.args[2])));
        };
        const free = lowestLine();
        const reserved = lowestLine(24);
        expect(reserved).toBeLessThanOrEqual(100 - 24);
        expect(reserved).toBeLessThan(free);
    });

    it("lists the bundled faces to load and the resting karaoke word", () => {
        expect(textThumbFontQueries(JSON.stringify(textTemplateById("title_bold")!.style))).toEqual(['900 32px "Montserrat"']);
        expect(textThumbFontQueries(JSON.stringify({ fontFamily: "Georgia, serif" }))).toEqual([]);
        expect(restingKaraokeWord("one two")).toBe(1);
        expect(restingKaraokeWord("one")).toBe(0);
    });

    it("renders a canvas without throwing in jsdom (no 2D context) and loads its faces", async () => {
        const load = vi.fn(async () => []);
        Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
        const { container } = render(<TextThumb text="Big title" styleJson={JSON.stringify(textTemplateById("title_bold")!.style)} />);
        expect(container.querySelector("canvas")).toBeTruthy();
        expect(load).toHaveBeenCalledWith('900 32px "Montserrat"');
        delete (document as { fonts?: unknown }).fonts;
    });
});
