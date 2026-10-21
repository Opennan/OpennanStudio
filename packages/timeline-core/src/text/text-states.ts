// Text raster states (phase 10b). A text item's raster animation (typewriter, wipe, blur, glow,
// letter rise/fall, karaoke) is a step function over a finite list of states: the export draws each
// state once into an atlas and picks the cell per frame with `crop` (atlasCellExpr), the preview
// draws `states[stateAt(T)]` with drawPreviewTextState. `stateAt` is one IR expression of item-local
// T, so both backends select the same state at every frame.
import { add, clip, div, floor, gt, gte, iff, lt, min, mod, mul, n, sub, v, evaluateScalar, type Expr } from "../looks/expr";
import { applyPreviewTextTransform, parsePreviewTextStyle } from "../lib/preview-text-draw";
import { splitGraphemes } from "../lib/preview-text-layout";
import { parseAnimationSpec, resolveAnimationWindows } from "../motion/animation-spec";
import { textAnimationById } from "../motion/text-animations";
import type { TextRasterKind } from "../motion/types";
import { captionWords, type CaptionWord } from "./captions";

export type TextState =
    | { kind: "full" }
    /** The first `visible` non-space glyphs (grapheme clusters) of the full layout. */
    | { kind: "typewriter"; visible: number }
    /** The left `fraction` of the padded box is revealed. */
    | { kind: "wipe"; fraction: number }
    /** Box blur radius in reference px (times the block's pixel scale when drawn). */
    | { kind: "blur"; radius: number }
    /** Extra glow, 0..1 (0 = the style's own glow). */
    | { kind: "glow"; level: number }
    /** Staggered letters: rise 0 → 1 (hidden → rest), fall 0 → 1 (rest → gone). */
    | { kind: "letters"; progress: number; direction: "rise" | "fall" }
    /** Karaoke: word `word` (through `through` when words are grouped) is current. */
    | { kind: "karaoke"; word: number; through?: number };

export interface TextStateClip {
    textContent: string | null;
    textStyle: string | null;
    animationJson?: string | null;
    captionWordsJson?: string | null;
    startTime: number;
    endTime: number;
}

export interface TextStatePlan {
    states: TextState[];
    /** Integer index into `states`, an expression of item-local T. */
    stateAt: Expr;
    /** More than one state. */
    animated: boolean;
}

/**
 * Seconds added to T inside every floor and comparison. ffmpeg computes frame times as n·(1/30),
 * which can sit one ulp below n/30; the bias makes frame-aligned boundaries pick the same state in
 * both backends.
 */
export const TEXT_STATE_TIME_BIAS = 1e-6;
export const MAX_TYPEWRITER_STATES = 64;
export const WINDOW_STATES_PER_SECOND = 30;
export const MAX_WINDOW_STATES = 30;
export const MIN_WINDOW_STATES = 2;
/** Blur levels per window, radius 0 (the full state) included. */
export const BLUR_LEVELS = 8;
export const GLOW_PHASES = 12;
export const MAX_KARAOKE_STATES = 64;
/** Largest blur, as a fraction of the font size. */
const BLUR_MAX_RATIO = 0.25;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Non-space glyphs the typewriter counts (grapheme clusters of the drawn text). */
export function textGlyphCount(text: string): number {
    return splitGraphemes(text).filter((g) => !/^\s+$/u.test(g)).length;
}

/** States, deduplicated, with every state that draws like the full block mapped to index 0. */
class StateTable {
    readonly states: TextState[] = [{ kind: "full" }];
    private readonly keys = new Map<string, number>([["full", 0]]);

    constructor(private readonly glyphs: number) {}

    private isFull(state: TextState): boolean {
        switch (state.kind) {
            case "full": return true;
            case "typewriter": return state.visible >= this.glyphs;
            case "wipe": return state.fraction >= 1;
            case "blur": return state.radius <= 0;
            case "glow": return state.level <= 0;
            case "letters": return state.direction === "rise" ? state.progress >= 1 : state.progress <= 0;
            case "karaoke": return state.word < 0;
        }
    }

    index(state: TextState): number {
        if (this.isFull(state)) return 0;
        const key = JSON.stringify(state);
        const found = this.keys.get(key);
        if (found !== undefined) return found;
        this.states.push(state);
        this.keys.set(key, this.states.length - 1);
        return this.states.length - 1;
    }
}

/**
 * The global index for integer `bin` (0..g.length-1) as a compact expression: a constant, an offset
 * of the bin with full-state guards at the ends, or a sum of steps.
 */
function lookup(bin: Expr, g: number[]): Expr {
    if (g.every((x) => x === g[0])) return n(g[0]);
    const nonZero = g.map((x, k) => (x !== 0 ? k : -1)).filter((k) => k >= 0);
    const lo = nonZero[0];
    const hi = nonZero[nonZero.length - 1];
    const c = g[lo] - lo;
    const affine = nonZero.length === hi - lo + 1 && nonZero.every((k) => g[k] === c + k) && g.every((x, k) => (k >= lo && k <= hi) || x === 0);
    if (affine) {
        let expr: Expr = c === 0 ? bin : add(bin, c);
        if (hi < g.length - 1) expr = iff(gt(bin, hi), 0, expr);
        if (lo > 0 && !(lo === 1 && c === 0)) expr = iff(lt(bin, lo), 0, expr);
        return expr;
    }
    let expr: Expr = n(g[0]);
    for (let k = 1; k < g.length; k += 1) {
        if (g[k] !== g[k - 1]) expr = add(expr, mul(g[k] - g[k - 1], gte(bin, k)));
    }
    return expr;
}

/** Biased item-local time. */
const biasedT = (): Expr => add(v("T"), TEXT_STATE_TIME_BIAS);

/** floor((T − start + bias)·bins / length), clipped to 0..bins−1. */
function windowBin(start: number, length: number, bins: number): Expr {
    const elapsed = start === 0 ? biasedT() : add(sub(v("T"), start), TEXT_STATE_TIME_BIAS);
    return clip(floor(div(mul(elapsed, bins), length)), 0, bins - 1);
}

function windowStateCount(seconds: number): number {
    return Math.min(MAX_WINDOW_STATES, Math.max(MIN_WINDOW_STATES, Math.round(seconds * WINDOW_STATES_PER_SECOND)));
}

/** Per-bin states of a raster in/out window, in bin order (bin 0 at the window start). */
function windowStates(raster: TextRasterKind, slot: "in" | "out", seconds: number, glyphs: number, fontSize: number): TextState[] {
    switch (raster) {
        case "typewriter":
        case "typewriter_erase": {
            const bins = Math.min(glyphs + 1, MAX_TYPEWRITER_STATES);
            const shown = (k: number) => (bins === glyphs + 1 ? k : Math.round((k * glyphs) / (bins - 1)));
            return Array.from({ length: bins }, (_, k) => ({ kind: "typewriter" as const, visible: slot === "in" ? shown(k) : glyphs - shown(k) }));
        }
        case "wipe": {
            const bins = windowStateCount(seconds);
            return Array.from({ length: bins }, (_, k) => {
                const u = k / (bins - 1);
                const fraction = slot === "in" ? 1 - (1 - u) * (1 - u) : 1 - u * u;
                return { kind: "wipe" as const, fraction: round6(fraction) };
            });
        }
        case "letter_rise":
        case "letter_fall": {
            const bins = windowStateCount(seconds);
            const direction = raster === "letter_rise" ? "rise" as const : "fall" as const;
            return Array.from({ length: bins }, (_, k) => ({ kind: "letters" as const, progress: round6(k / (bins - 1)), direction }));
        }
        case "blur": {
            const max = Math.max(2, fontSize * BLUR_MAX_RATIO);
            const top = BLUR_LEVELS - 1;
            return Array.from({ length: BLUR_LEVELS }, (_, k) => ({ kind: "blur" as const, radius: round6((max * (slot === "in" ? top - k : k)) / top) }));
        }
        case "glow":
            return [];
    }
}

const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

/** Karaoke units: word index ranges (punctuation-only words join a neighbour), grouped to fit the state cap. */
function karaokeUnits(words: CaptionWord[]): Array<{ first: number; last: number; start: number }> {
    const units: Array<{ first: number; last: number; start: number }> = [];
    let lead: number | null = null;
    words.forEach((word, index) => {
        if (PUNCTUATION_ONLY.test(word.text)) {
            if (units.length > 0) units[units.length - 1].last = index;
            else lead ??= index;
            return;
        }
        units.push({ first: lead ?? index, last: index, start: word.start });
        lead = null;
    });
    if (units.length === 0 && words.length > 0) units.push({ first: 0, last: words.length - 1, start: words[0].start });
    const cap = MAX_KARAOKE_STATES - 1;
    if (units.length <= cap) return units;
    const size = Math.ceil(units.length / cap);
    const grouped: typeof units = [];
    for (let i = 0; i < units.length; i += size) {
        const chunk = units.slice(i, i + size);
        grouped.push({ first: chunk[0].first, last: chunk[chunk.length - 1].last, start: chunk[0].start });
    }
    return grouped;
}

/** The raster state plan of a text clip (in window → in states; middle → karaoke or loop glow; out window → out states). */
export function textStatePlan(clip: TextStateClip): TextStatePlan {
    const style = parsePreviewTextStyle(clip.textStyle);
    const text = applyPreviewTextTransform(clip.textContent || "Text", style.textTransform);
    const glyphs = textGlyphCount(text);
    const duration = Math.max(0, clip.endTime - clip.startTime);
    const windows = resolveAnimationWindows(parseAnimationSpec(clip.animationJson), duration);
    const table = new StateTable(glyphs);
    const tt = biasedT();

    // Middle: karaoke (assigned first so its count needs no guard), else a glow loop.
    let middle: Expr = n(0);
    let karaoke = false;
    if (style.karaoke) {
        const units = karaokeUnits(captionWords(clip));
        if (units.length > 0) {
            const g = [0, ...units.map((u) => table.index(u.last > u.first ? { kind: "karaoke", word: u.first, through: u.last } : { kind: "karaoke", word: u.first }))];
            let count: Expr = n(0);
            units.forEach((u, i) => {
                count = i === 0 ? gte(tt, u.start) : add(count, gte(tt, u.start));
            });
            middle = lookup(count, g);
            karaoke = true;
        }
    }

    const rasterWindow = (slot: "in" | "out") => {
        const window = windows[slot];
        const raster = window && textAnimationById(slot, window.id)?.raster;
        if (!window || !raster || window.end <= window.start) return null;
        if ((raster === "typewriter" || raster === "typewriter_erase") && glyphs === 0) return null;
        const states = windowStates(raster, slot, window.end - window.start, glyphs, style.fontSize);
        return states.length > 0 ? { window, states } : null;
    };
    const inRaster = rasterWindow("in");
    const outRaster = rasterWindow("out");
    const inExpr = inRaster && lookup(windowBin(0, inRaster.window.end, inRaster.states.length), inRaster.states.map((s) => table.index(s)));
    const outExpr = outRaster && lookup(windowBin(outRaster.window.start, outRaster.window.end - outRaster.window.start, outRaster.states.length), outRaster.states.map((s) => table.index(s)));

    const loop = windows.loop;
    if (!karaoke && loop && textAnimationById("loop", loop.id)?.raster === "glow") {
        const levels = Array.from({ length: GLOW_PHASES / 2 + 1 }, (_, m) => round6(0.5 - 0.5 * Math.cos((2 * Math.PI * m) / GLOW_PHASES)));
        const g = levels.map((level) => table.index({ kind: "glow", level }));
        const phase = mod(floor(div(mul(add(sub(v("T"), loop.start), TEXT_STATE_TIME_BIAS), GLOW_PHASES), loop.period)), GLOW_PHASES);
        const folded = min(phase, sub(GLOW_PHASES, phase));
        middle = iff(mul(gte(tt, loop.start), lt(tt, loop.end)), lookup(folded, g), 0);
    }

    let stateAt = middle;
    if (outExpr && outRaster) stateAt = iff(gte(tt, outRaster.window.start), outExpr, stateAt);
    if (inExpr && inRaster) stateAt = iff(lt(tt, inRaster.window.end), inExpr, stateAt);
    const states = table.states;
    return { states, stateAt: states.length > 1 ? stateAt : n(0), animated: states.length > 1 };
}

/** The state at item-local time t (the preview's side of stateAt). */
export function textStateAt(plan: TextStatePlan, t: number): TextState {
    const index = evaluateScalar(plan.stateAt, t);
    return plan.states[Math.min(plan.states.length - 1, Math.max(0, Math.round(index)))];
}

export interface AtlasLayout {
    cols: number;
    rows: number;
    /** Atlas size in px (cols × cellWidth, rows × cellHeight). */
    width: number;
    height: number;
    /** Cell bitmap scale, ≤ 1 when the atlas had to shrink to fit maxSide. */
    scale: number;
    /** Cell size in px after scaling. */
    cellWidth: number;
    cellHeight: number;
}

/** A grid for `stateCount` cells of cellW × cellH within maxSide px per side: largest scale, then squarest, then fewest empty cells. */
export function atlasLayout(stateCount: number, cellW: number, cellH: number, maxSide = 8192): AtlasLayout {
    const count = Math.max(1, Math.floor(stateCount));
    const w = Math.max(1, Math.ceil(cellW));
    const h = Math.max(1, Math.ceil(cellH));
    let best: AtlasLayout | null = null;
    let bestSide = Infinity;
    for (let cols = 1; cols <= count; cols += 1) {
        const rows = Math.ceil(count / cols);
        if (cols > 1 && (cols - 1) * rows >= count) continue; // same rows with fewer columns
        const scale = Math.min(1, maxSide / (cols * w), maxSide / (rows * h));
        const cellWidth = Math.max(1, Math.floor(w * scale));
        const cellHeight = Math.max(1, Math.floor(h * scale));
        const side = Math.max(cols * cellWidth, rows * cellHeight);
        const candidate = { cols, rows, width: cols * cellWidth, height: rows * cellHeight, scale, cellWidth, cellHeight };
        if (!best || scale > best.scale + 1e-12 || (Math.abs(scale - best.scale) <= 1e-12 && (side < bestSide || (side === bestSide && cols * rows < best.cols * best.rows)))) {
            best = candidate;
            bestSide = side;
        }
    }
    return best!;
}

/** Top-left of the current state's cell, for ffmpeg `crop=w:h:x:y` (x and y evaluate per frame). */
export function atlasCellExpr(stateAt: Expr, cols: number, cellW: number, cellH: number): { x: Expr; y: Expr } {
    return {
        x: mul(mod(stateAt, cols), cellW),
        y: mul(floor(div(stateAt, cols)), cellH),
    };
}
