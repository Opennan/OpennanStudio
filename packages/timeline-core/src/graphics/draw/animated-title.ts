// Animated title: words rise 40 px and fade in one after another (5 frames apart, damping-200 spring), an
// optional accent subtitle follows, and everything fades out over the last half second. Layout as the CSS
// original: 8 % side padding, 90 px weight-800 words in a flex-wrap row with a 0.25em gap of the inherited
// 16 px font (4 px) whose lines are centred, the row placed left/centre/right by `align`; the subtitle is 36 px
// weight 500, 18 px below, left-aligned in its own fit-content box. The block is centred vertically.
import { clampedInterpolate, exitWindow, interpolate, spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import {
    INTER_LINE_HEIGHT, baselineOffset, clamp01, clipBounds, color, fillLines, graphicsFont, numberOr, str, textWidth, unionBounds, wrapText,
} from "./helpers";

const WORD_SIZE = 90;
const WORD_GAP = 4;
const SUB_SIZE = 36;

export const drawAnimatedTitle: GraphicsDraw = (ctx, { width, height, frame, durationInFrames, fps, props }) => {
    const words = str(props.title).split(" ").filter(Boolean);
    const subtitle = str(props.subtitle);
    const textColor = color(props.color, "#ffffff");
    const accent = color(props.accentColor, "#7c3aed");
    const align = str(props.align);
    const speed = Math.max(0.1, numberOr(props.speed, 1) || 1);
    const fade = clampedInterpolate(frame, exitWindow(fps, durationInFrames), [1, 0]);
    if (!(fade > 0)) return null;

    const padX = width * 0.08;
    const avail = width * 0.84;
    const place = (w: number) => (align === "left" ? padX : align === "right" ? padX + avail - w : padX + (avail - w) / 2);

    // Words: shrink only when a single word is wider than the row (CSS would overflow).
    ctx.font = graphicsFont(800, WORD_SIZE);
    const natural = words.map((word) => textWidth(ctx, word));
    const widest = Math.max(0, ...natural);
    const size = widest > avail ? (WORD_SIZE * avail) / widest : WORD_SIZE;
    const wordWidths = natural.map((w) => (w * size) / WORD_SIZE);
    const rows: number[][] = [];
    let rowWidth = 0;
    wordWidths.forEach((w, i) => {
        const row = rows[rows.length - 1];
        if (row && rowWidth + WORD_GAP + w <= avail + 1e-6) {
            row.push(i);
            rowWidth += WORD_GAP + w;
        } else {
            rows.push([i]);
            rowWidth = w;
        }
    });
    const rowWidths = rows.map((row) => row.reduce((sum, i) => sum + wordWidths[i], 0) + WORD_GAP * (row.length - 1));
    const wordH = size * INTER_LINE_HEIGHT;
    const wrapperW = rows.length > 1 ? avail : rowWidths[0] ?? 0;
    const wrapperH = rows.length ? rows.length * wordH + (rows.length - 1) * WORD_GAP : 0;

    ctx.font = graphicsFont(500, SUB_SIZE);
    const sub = subtitle ? wrapText(ctx, subtitle, avail) : null;
    const subH = sub ? sub.lines.length * SUB_SIZE * INTER_LINE_HEIGHT : 0;
    const total = wrapperH + (sub ? 18 + subH : 0);
    const top = (height - total) / 2;
    const wrapperX = place(wrapperW);

    const base = ctx.globalAlpha;
    const boxes: GraphicsBounds[] = [];
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = textColor;
    ctx.font = graphicsFont(800, size);
    rows.forEach((row, r) => {
        let x = wrapperX + (wrapperW - rowWidths[r]) / 2;
        const rowTop = top + r * (wordH + WORD_GAP);
        for (const i of row) {
            const progress = spring({ frame: frame * speed - i * 5, fps, config: { damping: 200 } });
            const alpha = clamp01(progress) * fade;
            if (alpha > 0) {
                const y = rowTop + interpolate(progress, [0, 1], [40, 0]);
                ctx.globalAlpha = base * alpha;
                ctx.fillText(words[i], x, y + baselineOffset(wordH, size));
                boxes.push({ x, y, width: wordWidths[i], height: wordH });
            }
            x += wordWidths[i] + WORD_GAP;
        }
    });
    if (sub) {
        const alpha = clamp01(spring({ frame: frame * speed - words.length * 5 - 8, fps, config: { damping: 200 } })) * fade;
        if (alpha > 0) {
            const subX = place(sub.width);
            const subTop = top + wrapperH + 18;
            ctx.globalAlpha = base * alpha;
            ctx.fillStyle = accent;
            ctx.font = graphicsFont(500, SUB_SIZE);
            fillLines(ctx, sub, subX, subTop, sub.width, SUB_SIZE * INTER_LINE_HEIGHT, SUB_SIZE);
            boxes.push({ x: subX, y: subTop, width: sub.width, height: subH });
        }
    }
    ctx.restore();
    return clipBounds(unionBounds(...boxes), width, height);
};
