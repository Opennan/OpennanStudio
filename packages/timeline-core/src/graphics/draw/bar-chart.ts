// Bar chart: a 48 px weight-800 title fading in, then one row per data point growing from zero (damping-200
// springs, 6 frames in and 4 apart): a 140 px label column (28 px), a 34 px bar (radius 6) spanning value / max
// of the remaining width, and a 90 px right-aligned value (26 px) counting up and fading in. Layout as the CSS
// original: 8 %-of-width padding on every side, the block centred vertically; rows 14 px apart, title 28 px
// above them. Data is JSON [{label, value ≥ 0}]; anything else is skipped. Deviation: the chart shrinks to fit
// the frame height when there are too many rows (CSS would overflow).
import { interpolate, spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import {
    INTER_LINE_HEIGHT, clamp01, clipBounds, color, fillLines, fillRoundedRect, graphicsFont, jsonParam, str, textWidth, transformBounds, unionBounds,
    wrapText,
} from "./helpers";

export interface ChartRow {
    label: string;
    value: number;
}

/** Rows of a chart `data` parameter: objects with a string label and a finite value accepted by `keep`. */
export function chartRows(data: unknown, keep: (value: number) => boolean = Number.isFinite): ChartRow[] {
    const parsed = jsonParam<unknown>(data, []);
    if (!Array.isArray(parsed)) return [];
    const rows: ChartRow[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const { label, value } = item as { label?: unknown; value?: unknown };
        const n = Number(value);
        if (typeof label === "string" && Number.isFinite(n) && keep(n)) rows.push({ label, value: n });
    }
    return rows;
}

const LABEL_W = 140;
const VALUE_W = 90;
const BAR_H = 34;

export const drawBarChart: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const title = str(props.title);
    const rows = chartRows(props.data, (v) => v >= 0);
    const barColor = color(props.barColor, "#7c3aed");
    const textColor = color(props.textColor, "#ffffff");
    const max = Math.max(1, ...rows.map((r) => r.value));
    const pad = width * 0.08;
    const contentW = width * 0.84;
    const barArea = Math.max(0, contentW - LABEL_W - VALUE_W);

    ctx.font = graphicsFont(800, 48);
    const titleLines = title ? wrapText(ctx, title, contentW) : null;
    const titleH = titleLines ? titleLines.lines.length * 48 * INTER_LINE_HEIGHT : 0;
    ctx.font = graphicsFont(400, 28);
    const labels = rows.map((r) => wrapText(ctx, r.label, LABEL_W));
    const rowHs = labels.map((l) => Math.max(BAR_H, l.lines.length * 28 * INTER_LINE_HEIGHT, 26 * INTER_LINE_HEIGHT));
    const total = titleH + 28 + rowHs.reduce((sum, h) => sum + h + 14, 0);
    const fit = Math.min(1, (height * 0.96) / total);
    const top = (height - total) / 2;
    const cx = width / 2;
    const cy = height / 2;

    const base = ctx.globalAlpha;
    const boxes: GraphicsBounds[] = [];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(fit, fit);
    ctx.translate(-cx, -cy);
    const titleIn = clamp01(spring({ frame, fps, config: { damping: 200 } }));
    if (titleLines && titleIn > 0) {
        ctx.globalAlpha = base * titleIn;
        ctx.fillStyle = textColor;
        ctx.font = graphicsFont(800, 48);
        fillLines(ctx, titleLines, pad, top, contentW, 48 * INTER_LINE_HEIGHT, 48);
        boxes.push({ x: pad, y: top, width: titleLines.width, height: titleH });
    }
    let rowTop = top + titleH + 28;
    rows.forEach((row, i) => {
        const rowH = rowHs[i];
        const mid = rowTop + rowH / 2;
        const progress = spring({ frame: frame - 6 - i * 4, fps, config: { damping: 200 } });
        ctx.globalAlpha = base;
        ctx.fillStyle = textColor;
        ctx.font = graphicsFont(400, 28);
        const labelH = labels[i].lines.length * 28 * INTER_LINE_HEIGHT;
        fillLines(ctx, labels[i], pad, mid - labelH / 2, LABEL_W, 28 * INTER_LINE_HEIGHT, 28);
        if (labels[i].width > 0) boxes.push({ x: pad, y: mid - labelH / 2, width: labels[i].width, height: labelH });
        const barW = barArea * (interpolate(progress, [0, 1], [0, (row.value / max) * 100]) / 100);
        if (barW > 0) {
            fillRoundedRect(ctx, pad + LABEL_W, mid - BAR_H / 2, barW, BAR_H, 6, barColor);
            boxes.push({ x: pad + LABEL_W, y: mid - BAR_H / 2, width: barW, height: BAR_H });
        }
        const alpha = clamp01(progress);
        if (alpha > 0) {
            const text = String(Math.round(row.value * progress));
            ctx.font = graphicsFont(400, 26);
            const w = textWidth(ctx, text);
            const right = pad + contentW;
            const lineH = 26 * INTER_LINE_HEIGHT;
            ctx.globalAlpha = base * alpha;
            ctx.fillStyle = textColor;
            fillLines(ctx, { lines: [text], widths: [w], width: w }, right - w, mid - lineH / 2, w, lineH, 26);
            boxes.push({ x: right - w, y: mid - lineH / 2, width: w, height: lineH });
        }
        rowTop += rowH + 14;
    });
    ctx.restore();
    const painted = unionBounds(...boxes);
    return painted ? clipBounds(transformBounds(painted, 0, 0, fit, cx, cy), width, height) : null;
};
