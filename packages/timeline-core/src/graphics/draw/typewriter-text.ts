// Typewriter text: characters appear at `speed` per second followed by a caret that blinks every 0.4 s. Layout
// as the CSS original: 8 % side padding, a fit-content box (0.4em/0.7em padding, 0.3em radius, optional
// background) that grows as the text types, weight 600 at `size` px with line height 1.35, `pre-wrap` lines
// breaking inside the padded width, placed centre / lower third (12 % of the width from the bottom) / top (8 %).
// The original's monospace face (JetBrains Mono) is not bundled; the graphics font (Inter) draws it instead.
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { clampedNumber, clipBounds, color, fillLines, fillRoundedRect, graphicsFont, isTransparent, numberOr, str, wrapText } from "./helpers";

export const drawTypewriterText: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const text = Array.from(str(props.text));
    const fg = color(props.color, "#ffffff");
    const bg = color(props.bgColor, "transparent");
    const size = clampedNumber(props.size, 54, 1, 1000);
    const cps = Math.max(1, numberOr(props.speed, 14));
    const position = str(props.position, "center");
    const chars = Math.max(0, Math.min(text.length, Math.floor((frame / fps) * cps)));
    const caretOn = Math.floor(frame / (fps * 0.4)) % 2 === 0;
    const shown = text.slice(0, chars).join("");
    const hasBg = !isTransparent(bg);
    if (!hasBg && !caretOn && !shown.trim()) return null;

    const avail = width * 0.84;
    const padX = 0.7 * size;
    const padY = 0.4 * size;
    const lineH = 1.35 * size;
    ctx.font = graphicsFont(600, size);
    const wrapped = wrapText(ctx, `${shown}|`, Math.max(1, avail - 2 * padX), "pre-wrap");
    const boxW = Math.min(avail, wrapped.width + 2 * padX);
    const textH = wrapped.lines.length * lineH;
    const boxH = textH + 2 * padY;
    const x = (width - boxW) / 2;
    const y = position === "top" ? width * 0.08 : position === "lower_third" ? height - width * 0.12 - boxH : (height - boxH) / 2;

    const last = wrapped.lines.length - 1;
    const visible = caretOn ? wrapped : { ...wrapped, lines: wrapped.lines.map((line, i) => (i === last ? line.replace(/\|$/, "") : line)) };
    ctx.save();
    if (hasBg) fillRoundedRect(ctx, x, y, boxW, boxH, 0.3 * size, bg);
    ctx.fillStyle = fg;
    fillLines(ctx, visible, x + padX, y + padY, boxW - 2 * padX, lineH, size);
    ctx.restore();
    const box: GraphicsBounds = hasBg ? { x, y, width: boxW, height: boxH } : { x: x + padX, y: y + padY, width: wrapped.width, height: textH };
    return clipBounds(box, width, height);
};
