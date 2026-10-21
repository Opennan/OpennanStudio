// Line chart: a 48 px weight-800 title fading in over an SVG-style plot (viewBox -40 -30 1080 630, 1000 × 520
// plot area scaled to the padded width, clipped to its viewport) whose 8 px round polyline draws itself from
// 0.2 s to 1.6 s (the original's dash reveal of length 1000 + 520 × points), with a dot (r 14, bouncy spring)
// per point, the value above it (30 px weight 700) and its label below the plot (28 px), both fading in with
// the dot. Layout as the CSS original: 8 %-of-width padding, the title 30 px above the plot, centred vertically.
import { clampedInterpolate, spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { chartRows } from "./bar-chart";
import {
    INTER_ASCENT, INTER_LINE_HEIGHT, clamp01, clipBounds, color, fillLines, graphicsFont, intersectBounds, str, textWidth, unionBounds, wrapText,
} from "./helpers";

const PLOT_W = 1000;
const PLOT_H = 520;
const VIEW = { x: -40, y: -30, w: PLOT_W + 80, h: PLOT_H + 110 };

export const drawLineChart: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const title = str(props.title);
    const rows = chartRows(props.data);
    const lineColor = color(props.lineColor, "#7c3aed");
    const textColor = color(props.textColor, "#ffffff");
    const pad = width * 0.08;
    const contentW = width * 0.84;
    const k = contentW / VIEW.w;
    const svgH = VIEW.h * k;

    ctx.font = graphicsFont(800, 48);
    const titleLines = title ? wrapText(ctx, title, contentW) : null;
    const titleH = titleLines ? titleLines.lines.length * 48 * INTER_LINE_HEIGHT : 0;
    const top = (height - (titleH + 30 + svgH)) / 2;
    const svgTop = top + titleH + 30;
    const viewport: GraphicsBounds = { x: pad, y: svgTop, width: contentW, height: svgH };
    const toComp = (b: GraphicsBounds): GraphicsBounds => ({ x: pad + (b.x - VIEW.x) * k, y: svgTop + (b.y - VIEW.y) * k, width: b.width * k, height: b.height * k });

    const max = Math.max(1, ...rows.map((r) => r.value));
    const min = Math.min(0, ...rows.map((r) => r.value));
    const px = (i: number) => (rows.length > 1 ? (i / (rows.length - 1)) * PLOT_W : PLOT_W / 2);
    const py = (v: number) => PLOT_H - ((v - min) / (max - min || 1)) * PLOT_H;
    const draw = clampedInterpolate(frame, [fps * 0.2, fps * 1.6], [0, 1]);
    const pathLength = PLOT_W + PLOT_H * rows.length;

    const base = ctx.globalAlpha;
    const boxes: GraphicsBounds[] = [];
    const plotBoxes: GraphicsBounds[] = [];
    ctx.save();
    const titleIn = clamp01(spring({ frame, fps, config: { damping: 200 } }));
    if (titleLines && titleIn > 0) {
        ctx.globalAlpha = base * titleIn;
        ctx.fillStyle = textColor;
        ctx.font = graphicsFont(800, 48);
        fillLines(ctx, titleLines, pad, top, contentW, 48 * INTER_LINE_HEIGHT, 48);
        boxes.push({ x: pad, y: top, width: titleLines.width, height: titleH });
    }

    ctx.globalAlpha = base;
    ctx.beginPath();
    ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
    ctx.clip();
    ctx.translate(pad - VIEW.x * k, svgTop - VIEW.y * k);
    ctx.scale(k, k);

    // The polyline, revealed up to `pathLength × draw` along its length.
    let remaining = pathLength * draw;
    if (rows.length > 1 && remaining > 0) {
        ctx.beginPath();
        ctx.moveTo(px(0), py(rows[0].value));
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        const extend = (x: number, y: number) => {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
        };
        extend(px(0), py(rows[0].value));
        for (let i = 1; i < rows.length && remaining > 0; i += 1) {
            const ax = px(i - 1);
            const ay = py(rows[i - 1].value);
            const bx = px(i);
            const by = py(rows[i].value);
            const len = Math.hypot(bx - ax, by - ay);
            const t = len > 0 ? Math.min(1, remaining / len) : 1;
            ctx.lineTo(ax + (bx - ax) * t, ay + (by - ay) * t);
            extend(ax + (bx - ax) * t, ay + (by - ay) * t);
            remaining -= len;
        }
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 8;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        plotBoxes.push({ x: x0 - 4, y: y0 - 4, width: x1 - x0 + 8, height: y1 - y0 + 8 });
    }

    const textBox = (text: string, cx: number, baseline: number, size: number): GraphicsBounds => {
        const w = textWidth(ctx, text);
        return { x: cx - w / 2, y: baseline - INTER_ASCENT * size, width: w, height: INTER_LINE_HEIGHT * size };
    };
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    rows.forEach((row, i) => {
        const dotIn = spring({ frame: frame - fps * 0.2 - i * ((fps * 1.4) / Math.max(1, rows.length)), fps, config: { damping: 12, stiffness: 200 } });
        const x = px(i);
        const y = py(row.value);
        const r = 14 * dotIn;
        if (r > 0) {
            ctx.globalAlpha = base;
            ctx.fillStyle = lineColor;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            plotBoxes.push({ x: x - r, y: y - r, width: 2 * r, height: 2 * r });
        }
        const alpha = clamp01(dotIn);
        if (alpha > 0) {
            ctx.globalAlpha = base * alpha;
            ctx.fillStyle = textColor;
            ctx.font = graphicsFont(700, 30);
            const value = String(row.value);
            ctx.fillText(value, x, y - 28);
            plotBoxes.push(textBox(value, x, y - 28, 30));
            ctx.font = graphicsFont(400, 28);
            ctx.fillText(row.label, x, PLOT_H + 60);
            if (row.label) plotBoxes.push(textBox(row.label, x, PLOT_H + 60, 28));
        }
    });
    ctx.restore();

    const plot = unionBounds(...plotBoxes);
    return clipBounds(unionBounds(...boxes, plot ? intersectBounds(toComp(plot), viewport) : null), width, height);
};
