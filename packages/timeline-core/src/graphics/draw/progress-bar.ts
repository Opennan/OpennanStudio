// Progress bar: a full-width 10 px track at the top or bottom edge filling with the bar colour across the clip,
// with an optional "label NN%" text (wrapping; 24 px weight 600 in the bar colour, 24 px from the left, 8 px off the bar).
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { INTER_LINE_HEIGHT, clipBounds, color, fillLines, graphicsFont, isTransparent, str, unionBounds, wrapText } from "./helpers";

const BAR_H = 10;
const LABEL_SIZE = 24;

export const drawProgressBar: GraphicsDraw = (ctx, { width, height, frame, durationInFrames, props }) => {
    const label = str(props.label);
    const barColor = color(props.barColor, "#7c3aed");
    const trackColor = color(props.trackColor, "#333333");
    const top = str(props.position, "bottom") === "top";
    const pct = Math.max(0, Math.min(100, (frame / Math.max(1, durationInFrames - 1)) * 100));
    const lineH = LABEL_SIZE * INTER_LINE_HEIGHT;
    ctx.font = graphicsFont(600, LABEL_SIZE);
    const wrapped = label ? wrapText(ctx, `${label} ${Math.round(pct)}%`, width - 48) : null;
    const labelH = wrapped ? wrapped.lines.length * lineH : 0;
    const blockH = label ? labelH + 8 + BAR_H : BAR_H;
    const blockY = top ? 0 : height - blockH;
    const barY = blockY + blockH - BAR_H;

    const boxes: GraphicsBounds[] = [];
    ctx.save();
    if (!isTransparent(trackColor)) {
        ctx.fillStyle = trackColor;
        ctx.fillRect(0, barY, width, BAR_H);
        boxes.push({ x: 0, y: barY, width, height: BAR_H });
    }
    if (pct > 0) {
        ctx.fillStyle = barColor;
        ctx.fillRect(0, barY, (width * pct) / 100, BAR_H);
        boxes.push({ x: 0, y: barY, width: (width * pct) / 100, height: BAR_H });
    }
    if (wrapped) {
        ctx.font = graphicsFont(600, LABEL_SIZE);
        ctx.fillStyle = barColor;
        fillLines(ctx, wrapped, 24, blockY, wrapped.width, lineH, LABEL_SIZE);
        boxes.push({ x: 24, y: blockY, width: wrapped.width, height: labelH });
    }
    ctx.restore();
    return clipBounds(unionBounds(...boxes), width, height);
};
