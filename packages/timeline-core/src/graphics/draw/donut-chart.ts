// Donut chart: a 48 px weight-800 title fading in, 26 px above a row of a 420 px donut (radius 160, 72 px ring)
// whose segments sweep in clockwise from 12 o'clock between 0.2 s and 1.5 s with a 44 px weight-800 centre label
// (wrapping in the 240 px hole), and, 60 px to its right, a legend (26 px radius-6 swatch, 14 px gap, 30 px
// "label · NN%") whose rows fade in from 0.6 s, 5 frames apart. Everything is centred as the CSS original.
// Data is JSON [{label, value > 0, color?}]; segments without a colour cycle the original's palette.
// Deviation: the chart shrinks to fit the frame (portrait frames) where the CSS row would overflow.
import { clampedInterpolate, spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { chartRows } from "./bar-chart";
import {
    INTER_LINE_HEIGHT, clamp01, clipBounds, color, fillLines, fillRoundedRect, fitScale, graphicsFont, jsonParam, str, textWidth, transformBounds,
    unionBounds, wrapText,
} from "./helpers";

const FALLBACK_COLORS = ["#7c3aed", "#06b6d4", "#f59e0b", "#ef4444", "#22c55e", "#e879f9"];
const BOX = 420;
const R = 160;
const RING_W = 72;
const LEGEND_LINE = 30 * INTER_LINE_HEIGHT;

export const drawDonutChart: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const title = str(props.title);
    const centerLabel = str(props.centerLabel);
    const textColor = color(props.textColor, "#ffffff");
    // Colours come from the same JSON items chartRows accepted (value > 0, string label).
    const items = jsonParam<unknown>(props.data, []);
    const colors = Array.isArray(items)
        ? items.filter((item) => {
            if (!item || typeof item !== "object") return false;
            const { label, value } = item as { label?: unknown; value?: unknown };
            return typeof label === "string" && Number.isFinite(Number(value)) && Number(value) > 0;
        }).map((item) => (item as { color?: unknown }).color)
        : [];
    const rows = chartRows(props.data, (v) => v > 0).map((row, i) => ({
        ...row, color: typeof colors[i] === "string" && colors[i] ? (colors[i] as string) : FALLBACK_COLORS[i % FALLBACK_COLORS.length],
    }));
    const total = rows.reduce((sum, r) => sum + r.value, 0) || 1;
    const sweep = clampedInterpolate(frame, [fps * 0.2, fps * 1.5], [0, 1]);

    ctx.font = graphicsFont(800, 48);
    const titleLines = title ? wrapText(ctx, title, width) : null;
    const titleH = titleLines ? titleLines.lines.length * 48 * INTER_LINE_HEIGHT : 0;
    ctx.font = graphicsFont(400, 30);
    const legendTexts = rows.map((r) => `${r.label} · ${Math.round((r.value / total) * 100)}%`);
    const legendTextW = Math.max(0, ...legendTexts.map((t) => textWidth(ctx, t)));
    const legendW = rows.length ? 26 + 14 + legendTextW : 0;
    const legendH = rows.length * (LEGEND_LINE + 14);
    const rowW = BOX + 60 + legendW;
    const rowH = Math.max(BOX, legendH);
    const totalH = titleH + 26 + rowH;
    const fit = fitScale(Math.max(rowW, titleLines?.width ?? 0), totalH, width * 0.94, height * 0.96);
    const cx = width / 2;
    const cy = height / 2;
    const top = (height - totalH) / 2;
    const rowTop = top + titleH + 26;
    const rowX = (width - rowW) / 2;
    const dcx = rowX + BOX / 2;
    const dcy = rowTop + rowH / 2;

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
        fillLines(ctx, titleLines, (width - titleLines.width) / 2, top, titleLines.width, 48 * INTER_LINE_HEIGHT, 48);
        boxes.push({ x: (width - titleLines.width) / 2, y: top, width: titleLines.width, height: titleH });
    }

    ctx.globalAlpha = base;
    ctx.lineWidth = RING_W;
    ctx.lineCap = "butt";
    let start = 0;
    let anySegment = false;
    for (const row of rows) {
        const frac = row.value / total;
        const visible = Math.max(0, Math.min(frac, sweep - start));
        if (visible > 0) {
            ctx.strokeStyle = row.color;
            ctx.beginPath();
            ctx.arc(dcx, dcy, R, -Math.PI / 2 + start * Math.PI * 2, -Math.PI / 2 + (start + visible) * Math.PI * 2);
            ctx.stroke();
            anySegment = true;
        }
        start += frac;
    }
    if (anySegment) boxes.push({ x: dcx - R - RING_W / 2, y: dcy - R - RING_W / 2, width: 2 * R + RING_W, height: 2 * R + RING_W });

    if (centerLabel) {
        ctx.font = graphicsFont(800, 44);
        const label = wrapText(ctx, centerLabel, BOX - 180);
        const lineH = 44 * INTER_LINE_HEIGHT;
        const labelTop = dcy - (label.lines.length * lineH) / 2;
        ctx.fillStyle = textColor;
        fillLines(ctx, label, dcx - label.width / 2, labelTop, label.width, lineH, 44, "center");
        boxes.push({ x: dcx - label.width / 2, y: labelTop, width: label.width, height: label.lines.length * lineH });
    }

    const legendX = rowX + BOX + 60;
    let legendTop = dcy - legendH / 2;
    rows.forEach((row, i) => {
        const alpha = clamp01(spring({ frame: frame - fps * 0.6 - i * 5, fps, config: { damping: 200 } }));
        const mid = legendTop + LEGEND_LINE / 2;
        if (alpha > 0) {
            ctx.globalAlpha = base * alpha;
            fillRoundedRect(ctx, legendX, mid - 13, 26, 26, 6, row.color);
            ctx.fillStyle = textColor;
            ctx.font = graphicsFont(400, 30);
            const w = textWidth(ctx, legendTexts[i]);
            fillLines(ctx, { lines: [legendTexts[i]], widths: [w], width: w }, legendX + 40, legendTop, w, LEGEND_LINE, 30);
            boxes.push({ x: legendX, y: legendTop, width: 40 + w, height: LEGEND_LINE });
        }
        legendTop += LEGEND_LINE + 14;
    });
    ctx.restore();
    const painted = unionBounds(...boxes);
    return painted ? clipBounds(transformBounds(painted, 0, 0, fit, cx, cy), width, height) : null;
};
