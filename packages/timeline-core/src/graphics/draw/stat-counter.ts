// Stat counter: a 150 px weight-800 number (line height 1) counting up to `value` with an ease-out cubic between
// 0.15 s and 1.8 s, formatted with en-US thousands separators between the prefix and suffix; an 8 px accent bar
// (radius 4) 22 px below grows from the centre with the count, and an optional 42 px weight-600 label fades in
// 20 px below from 0.5 s. The block pops in with a spring (damping 14, stiffness 130) and is centred.
// Deviations: digits are proportional (canvas cannot select Inter's tabular figures), and the block shrinks to
// fit the frame when the final number is wider than 92 % of it (CSS would overflow).
import { clampedInterpolate, spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import {
    INTER_LINE_HEIGHT, clamp01, clampedNumber, clipBounds, color, fillLines, fillRoundedRect, fitScale, graphicsFont, str, textWidth, transformBounds,
    unionBounds, wrapText,
} from "./helpers";

const NUMBER_SIZE = 150;
const LABEL_SIZE = 42;

/** The number shown at `frame` (eased count from 0 to `value`, rounded). */
export function statCounterValue(frame: number, fps: number, value: number): number {
    const progress = clampedInterpolate(frame, [fps * 0.15, fps * 1.8], [0, 1]);
    return Math.round(value * (1 - Math.pow(1 - progress, 3)));
}

/** `n` rounded with en-US thousands separators (integer arithmetic, identical everywhere). */
export function formatThousands(n: number): string {
    if (!Number.isFinite(n)) return "0";
    const rounded = Math.round(n);
    const digits = BigInt(Math.abs(rounded)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return rounded < 0 ? `-${digits}` : digits;
}

export const drawStatCounter: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const value = clampedNumber(props.value, 1000000, -1e15, 1e15);
    const prefix = str(props.prefix);
    const suffix = str(props.suffix);
    const label = str(props.label);
    const textColor = color(props.color, "#ffffff");
    const accent = color(props.accentColor, "#7c3aed");
    const progress = clampedInterpolate(frame, [fps * 0.15, fps * 1.8], [0, 1]);
    const eased = 1 - Math.pow(1 - progress, 3);
    const enter = spring({ frame, fps, config: { damping: 14, stiffness: 130 } });
    const labelIn = clamp01(spring({ frame: frame - fps * 0.5, fps, config: { damping: 200 } }));
    if (!(enter > 0)) return null;

    const numberText = `${prefix}${formatThousands(statCounterValue(frame, fps, value))}${suffix}`;
    ctx.font = graphicsFont(800, NUMBER_SIZE);
    const numberW = textWidth(ctx, numberText);
    const finalW = textWidth(ctx, `${prefix}${formatThousands(value)}${suffix}`);
    ctx.font = graphicsFont(600, LABEL_SIZE);
    const labelLines = label ? wrapText(ctx, label, Math.max(numberW, width * 0.92)) : null;
    const labelLineH = LABEL_SIZE * INTER_LINE_HEIGHT;
    const labelH = labelLines ? labelLines.lines.length * labelLineH : 0;
    const blockW = Math.max(numberW, labelLines?.width ?? 0);
    const blockH = NUMBER_SIZE + 22 + 8 + (labelLines ? 20 + labelH : 0);
    const fit = fitScale(Math.max(finalW, labelLines?.width ?? 0), blockH, width * 0.92, height * 0.92);
    const cx = width / 2;
    const cy = height / 2;
    const top = cy - blockH / 2;
    const s = enter * fit;

    const base = ctx.globalAlpha;
    const boxes: GraphicsBounds[] = [];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = textColor;
    ctx.font = graphicsFont(800, NUMBER_SIZE);
    fillLines(ctx, { lines: [numberText], widths: [numberW], width: numberW }, cx - numberW / 2, top, numberW, NUMBER_SIZE, NUMBER_SIZE);
    boxes.push({ x: cx - numberW / 2, y: top, width: numberW, height: NUMBER_SIZE });
    const barW = blockW * eased;
    if (barW > 0) {
        fillRoundedRect(ctx, cx - barW / 2, top + NUMBER_SIZE + 22, barW, 8, 4, accent);
        boxes.push({ x: cx - barW / 2, y: top + NUMBER_SIZE + 22, width: barW, height: 8 });
    }
    if (labelLines && labelIn > 0) {
        const labelTop = top + NUMBER_SIZE + 30 + 20;
        ctx.globalAlpha = base * labelIn;
        ctx.fillStyle = textColor;
        ctx.font = graphicsFont(600, LABEL_SIZE);
        fillLines(ctx, labelLines, cx - blockW / 2, labelTop, blockW, labelLineH, LABEL_SIZE, "center");
        boxes.push({ x: cx - labelLines.width / 2, y: labelTop, width: labelLines.width, height: labelH });
    }
    ctx.restore();
    return clipBounds(transformBounds(unionBounds(...boxes)!, 0, 0, s, cx, cy), width, height);
};
