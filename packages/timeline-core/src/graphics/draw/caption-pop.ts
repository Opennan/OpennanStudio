// Caption pop: a centred pill (weight 800 at `size` px, 0.3em/0.8em padding, 0.5em radius, line height 1.15)
// pops in with a bouncy spring (damping 12, stiffness 200). Layout as the CSS original: 6 % side padding, the
// pill at most the padded width with words wrapping (and over-long words breaking) inside it, placed top /
// centre / lower third / bottom with padding in % of the width (CSS percentages), plus the letterbox bar.
import { spring } from "../spring";
import type { GraphicsDraw } from "../types";
import { clampedNumber, clipBounds, color, fillLines, fillRoundedRect, graphicsFont, isTransparent, str, transformBounds, wrapText } from "./helpers";

export const drawCaptionPop: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const text = str(props.text);
    const fg = color(props.color, "#ffffff");
    const bg = color(props.bgColor, "#111111");
    const size = clampedNumber(props.size, 64, 1, 1000);
    const position = str(props.position, "lower_third");
    const bar = clampedNumber(props.safeBottom, 0, 0, 45);
    const scale = spring({ frame, fps, config: { damping: 12, stiffness: 200 } });
    if (!(scale > 0) || (!text.trim() && isTransparent(bg))) return null;

    const avail = width * 0.88;
    const padX = 0.8 * size;
    const padY = 0.3 * size;
    const lineH = 1.15 * size;
    ctx.font = graphicsFont(800, size);
    const wrapped = wrapText(ctx, text, Math.max(1, avail - 2 * padX));
    const boxW = Math.min(avail, wrapped.width + 2 * padX);
    const boxH = wrapped.lines.length * lineH + 2 * padY;
    const x = (width - boxW) / 2;
    const y = position === "top" ? ((bar + 4) / 100) * width
        : position === "center" ? (height - boxH) / 2
        : height - ((bar + (position === "bottom" ? 3 : 10)) / 100) * width - boxH;
    const cx = x + boxW / 2;
    const cy = y + boxH / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    if (!isTransparent(bg)) fillRoundedRect(ctx, x, y, boxW, boxH, 0.5 * size, bg);
    ctx.fillStyle = fg;
    fillLines(ctx, wrapped, x + padX, y + padY, boxW - 2 * padX, lineH, size, "center");
    ctx.restore();
    return clipBounds(transformBounds({ x, y, width: boxW, height: boxH }, 0, 0, scale, cx, cy), width, height);
};
