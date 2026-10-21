import { emitFfmpeg, evaluateScalar } from "../looks/expr";
import { TEXT_ANIMATIONS } from "../motion/text-animations";
import { atlasCellExpr, atlasLayout, textStateAt, textStatePlan, type TextState } from "./text-states";

const clip = (over: Partial<{ textContent: string; textStyle: Record<string, unknown> | null; animation: unknown; words: unknown; start: number; end: number }> = {}) => ({
    textContent: over.textContent ?? "Hello world",
    textStyle: over.textStyle === null ? null : JSON.stringify(over.textStyle ?? { fontSize: 40 }),
    animationJson: over.animation ? JSON.stringify(over.animation) : null,
    captionWordsJson: over.words ? JSON.stringify(over.words) : null,
    startTime: over.start ?? 5,
    endTime: over.end ?? 8,
});

const at = (plan: ReturnType<typeof textStatePlan>, t: number): TextState => textStateAt(plan, t);
const frames = (plan: ReturnType<typeof textStatePlan>, from: number, to: number) => {
    const out: TextState[] = [];
    for (let k = Math.round(from * 30); k < Math.round(to * 30); k += 1) out.push(at(plan, k / 30));
    return out;
};

describe("textStatePlan", () => {
    it("is one full state for static text and transform-only animations", () => {
        for (const animation of [undefined, { in: { id: "fade", duration: 0.5 }, loop: { id: "pulse", period: 1 } }]) {
            const plan = textStatePlan(clip({ animation }));
            expect(plan.states).toEqual([{ kind: "full" }]);
            expect(plan.animated).toBe(false);
            expect(evaluateScalar(plan.stateAt, 1.2)).toBe(0);
        }
    });

    it("types glyphs in over the in window, one state per glyph count", () => {
        const plan = textStatePlan(clip({ animation: { in: { id: "typewriter", duration: 1 } } }));
        expect(plan.animated).toBe(true);
        expect(plan.states).toHaveLength(11);
        expect(at(plan, 0)).toEqual({ kind: "typewriter", visible: 0 });
        const visible = frames(plan, 0, 1).map((s) => (s.kind === "typewriter" ? s.visible : 10));
        expect(visible).toEqual([...visible].sort((a, b) => a - b));
        expect(new Set(visible).size).toBe(11);
        expect(at(plan, 1)).toEqual({ kind: "full" });
        expect(at(plan, 2.9)).toEqual({ kind: "full" });
    });

    it("groups long texts into at most 64 typewriter states and counts grapheme clusters", () => {
        const plan = textStatePlan(clip({ textContent: "abcdefghij ".repeat(20), animation: { in: { id: "typewriter", duration: 1.5 } } }));
        expect(plan.states).toHaveLength(64);
        const visible = plan.states.filter((s): s is Extract<TextState, { kind: "typewriter" }> => s.kind === "typewriter").map((s) => s.visible);
        expect(visible[0]).toBe(0);
        expect(visible.every((v, i) => i === 0 || v > visible[i - 1])).toBe(true);
        expect(Math.max(...visible)).toBeLessThan(200);
        const emoji = textStatePlan(clip({ textContent: "\u{1F44D}\u{1F3FD}\u{1F44D}\u{1F3FD}", animation: { in: { id: "typewriter", duration: 1 } } }));
        expect(emoji.states).toEqual([{ kind: "full" }, { kind: "typewriter", visible: 0 }, { kind: "typewriter", visible: 1 }]);
    });

    it("erases glyphs over the out window, starting full", () => {
        const plan = textStatePlan(clip({ animation: { out: { id: "typewriter_erase", duration: 1 } } }));
        expect(at(plan, 1.99)).toEqual({ kind: "full" });
        expect(at(plan, 2)).toEqual({ kind: "full" });
        expect(at(plan, 2.99)).toEqual({ kind: "typewriter", visible: 0 });
        const visible = frames(plan, 2, 3).map((s) => (s.kind === "typewriter" ? s.visible : 10));
        expect(visible).toEqual([...visible].sort((a, b) => b - a));
    });

    it("wipes and letters at 30 states per second of window, between 2 and 30", () => {
        const half = textStatePlan(clip({ animation: { in: { id: "wipe", duration: 0.5 } } }));
        expect(half.states).toHaveLength(15);
        expect(half.states.slice(1).every((s) => s.kind === "wipe" && s.fraction < 1)).toBe(true);
        expect(at(half, 0)).toEqual({ kind: "wipe", fraction: 0 });
        const long = textStatePlan(clip({ end: 10, animation: { in: { id: "wipe", duration: 2 } } }));
        expect(long.states).toHaveLength(30);
        const short = textStatePlan(clip({ animation: { in: { id: "letter_rise", duration: 0.1 } } }));
        expect(short.states).toEqual([{ kind: "full" }, { kind: "letters", progress: 0, direction: "rise" }, { kind: "letters", progress: 0.5, direction: "rise" }]);
        const fall = textStatePlan(clip({ animation: { out: { id: "letter_fall", duration: 0.5 } } }));
        expect(at(fall, 2.5)).toEqual({ kind: "full" });
        expect(at(fall, 2.99)).toMatchObject({ kind: "letters", direction: "fall", progress: 1 });
        const wipeOut = textStatePlan(clip({ animation: { out: { id: "wipe", duration: 0.5 } } }));
        expect(at(wipeOut, 2.99)).toEqual({ kind: "wipe", fraction: 0 });
    });

    it("blurs through 8 radii (0 = full), sharing radii between in and out", () => {
        const plan = textStatePlan(clip({ animation: { in: { id: "blur_in", duration: 0.8 }, out: { id: "blur_out", duration: 0.8 } } }));
        const radii = plan.states.filter((s): s is Extract<TextState, { kind: "blur" }> => s.kind === "blur").map((s) => s.radius);
        expect(radii).toHaveLength(7);
        expect(plan.states).toHaveLength(8);
        expect(Math.max(...radii)).toBeGreaterThan(0);
        expect(at(plan, 0)).toEqual({ kind: "blur", radius: Math.max(...radii) });
        expect(at(plan, 1.5)).toEqual({ kind: "full" });
        expect(at(plan, 2.2)).toEqual({ kind: "full" });
        expect(at(plan, 2.99)).toEqual({ kind: "blur", radius: Math.max(...radii) });
    });

    it("glows in 12 phases per loop period (symmetric phases share a state)", () => {
        const plan = textStatePlan(clip({ animation: { in: { id: "fade", duration: 0.5 }, loop: { id: "glow", period: 0.4 } } }));
        expect(plan.states).toHaveLength(7);
        expect(at(plan, 0.25)).toEqual({ kind: "full" });
        expect(at(plan, 0.5)).toEqual({ kind: "full" });
        const levels = frames(plan, 0.5, 0.9).map((s) => (s.kind === "glow" ? s.level : 0));
        expect(levels).toHaveLength(12);
        expect(levels[0]).toBe(0);
        expect(levels[6]).toBeCloseTo(1);
        expect(levels[1]).toBeCloseTo(levels[11]);
        expect(at(plan, 0.9)).toEqual({ kind: "full" });
    });

    const words = [{ start: 0.2, end: 0.6, text: "one" }, { start: 0.6, end: 1.0, text: "two" }, { start: 1.1, end: 2.0, text: "three" }];
    const karaokeStyle = { fontSize: 40, karaoke: "highlight", highlightColor: "#ff0", captionKind: "caption" };

    it("steps karaoke words at their start times, none before the first", () => {
        const plan = textStatePlan(clip({ textContent: "one two three", textStyle: karaokeStyle, words }));
        expect(plan.states).toEqual([{ kind: "full" }, { kind: "karaoke", word: 0 }, { kind: "karaoke", word: 1 }, { kind: "karaoke", word: 2 }]);
        expect(at(plan, 0.19)).toEqual({ kind: "full" });
        expect(at(plan, 0.2)).toEqual({ kind: "karaoke", word: 0 });
        expect(at(plan, 0.6)).toEqual({ kind: "karaoke", word: 1 });
        expect(at(plan, 1.05)).toEqual({ kind: "karaoke", word: 1 });
        expect(at(plan, 2.5)).toEqual({ kind: "karaoke", word: 2 });
        expect(textStatePlan(clip({ textContent: "one two three", textStyle: { fontSize: 40 }, words })).animated).toBe(false);
    });

    it("groups karaoke words beyond 63", () => {
        const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
        const plan = textStatePlan(clip({ textContent: text, textStyle: karaokeStyle, end: 25 }));
        expect(plan.states.length).toBeLessThanOrEqual(64);
        const last = plan.states[plan.states.length - 1];
        expect(last).toMatchObject({ kind: "karaoke", through: 99 });
        expect(at(plan, 19.99)).toMatchObject({ kind: "karaoke", through: 99 });
    });

    it("phases karaoke with raster in and out windows", () => {
        const plan = textStatePlan(clip({ textContent: "one two three", textStyle: karaokeStyle, words, animation: { in: { id: "wipe", duration: 0.5 }, out: { id: "blur_out", duration: 0.5 } } }));
        expect(at(plan, 0.1).kind).toBe("wipe");
        expect(at(plan, 0.6)).toEqual({ kind: "karaoke", word: 1 });
        expect(at(plan, 2.6).kind).toBe("blur");
        const fadeIn = textStatePlan(clip({ textContent: "one two three", textStyle: karaokeStyle, words, animation: { in: { id: "fade", duration: 0.5 } } }));
        expect(at(fadeIn, 0.3)).toEqual({ kind: "karaoke", word: 0 });
    });

    it("picks the same state for t = k/30 and t = k·(1/30), for every animation", () => {
        const dt = 1 / 30;
        const specs: unknown[] = [];
        for (const a of TEXT_ANIMATIONS) {
            for (const duration of [0.1, 0.4, 0.5, 1, 1.2]) {
                if (a.slot === "in") specs.push({ in: { id: a.id, duration } });
                if (a.slot === "out") specs.push({ out: { id: a.id, duration } });
            }
            if (a.slot === "loop") for (const period of [0.4, 0.6, 1.2]) specs.push({ in: { id: "typewriter", duration: 0.5 }, loop: { id: a.id, period }, out: { id: "wipe", duration: 0.5 } });
        }
        const karaokeWords = Array.from({ length: 30 }, (_, i) => ({ start: i * 0.1, end: i * 0.1 + 0.1, text: `w${i}` }));
        const cases = specs.map((animation) => clip({ animation, end: 15 }));
        cases.push(clip({ textContent: karaokeWords.map((w) => w.text).join(" "), textStyle: karaokeStyle, words: karaokeWords, start: 0, end: 10 }));
        for (const c of cases) {
            const plan = textStatePlan(c);
            for (let k = 0; k <= 300; k += 1) {
                const a = evaluateScalar(plan.stateAt, k / 30);
                const b = evaluateScalar(plan.stateAt, k * dt);
                expect(a, `${c.animationJson} frame ${k}`).toBe(b);
                expect(Number.isInteger(a) && a >= 0 && a < plan.states.length).toBe(true);
            }
        }
    });

    it("emits stateAt for ffmpeg scalar options", () => {
        const plan = textStatePlan(clip({ animation: { in: { id: "typewriter", duration: 1 }, loop: { id: "glow", period: 1 }, out: { id: "wipe", duration: 0.5 } } }));
        const text = emitFfmpeg(plan.stateAt, { target: "scalar", time: "t" });
        expect(text).not.toContain("st(");
        expect(text).toContain("t");
        expect(text.split("(").length).toBe(text.split(")").length);
    });
});

describe("atlas", () => {
    it("lays out cells in a grid within the side limit", () => {
        expect(atlasLayout(1, 300, 100)).toMatchObject({ cols: 1, rows: 1, width: 300, height: 100, scale: 1 });
        const grid = atlasLayout(11, 400, 100);
        expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(11);
        expect(grid.width).toBe(grid.cols * 400);
        expect(grid.scale).toBe(1);
        expect(Math.max(grid.width, grid.height)).toBeLessThanOrEqual(8192);
        for (const [count, w, h] of [[64, 2400, 300], [64, 5000, 900], [30, 9000, 200], [1, 10000, 10000]] as const) {
            const layout = atlasLayout(count, w, h);
            expect(layout.cols * layout.rows).toBeGreaterThanOrEqual(count);
            expect(layout.width).toBeLessThanOrEqual(8192);
            expect(layout.height).toBeLessThanOrEqual(8192);
            expect(layout.scale).toBeLessThanOrEqual(1);
            expect(layout.width).toBe(layout.cols * layout.cellWidth);
            expect(layout.height).toBe(layout.rows * layout.cellHeight);
            expect(layout.cellWidth).toBe(Math.max(1, Math.floor(w * layout.scale)));
        }
        expect(atlasLayout(64, 5000, 900).scale).toBeLessThan(1);
        expect(atlasLayout(4, 100, 100, 150)).toMatchObject({ cols: 2, rows: 2, scale: 0.75, width: 150, height: 150 });
    });

    it("selects cells with crop expressions", () => {
        const plan = textStatePlan(clip({ animation: { in: { id: "typewriter", duration: 1 } } }));
        const cell = atlasCellExpr(plan.stateAt, 4, 120, 50);
        for (let k = 0; k < 30; k += 1) {
            const index = evaluateScalar(plan.stateAt, k / 30);
            expect(evaluateScalar(cell.x, k / 30)).toBe((index % 4) * 120);
            expect(evaluateScalar(cell.y, k / 30)).toBe(Math.floor(index / 4) * 50);
        }
    });
});
