// Subscribe button: a button (44 px weight 800, 1 px letter spacing, 0.45em/1.1em padding, 0.35em radius) and an
// optional 64 px bell 22 px to its right pop in with a bouncy spring (damping 12, stiffness 180), dip to 92 % in
// a "click" at 1.2 s, then the bell shakes (±14° decaying over 24 frames, pivot at the top centre). Placement as
// the CSS original: centred, 6 % of the width from the bottom or top edge, or in the middle.
import { interpolate, spring } from "../spring";
import type { GraphicsContext, GraphicsDraw } from "../types";
import { INTER_LINE_HEIGHT, baselineOffset, clipBounds, color, fillRoundedRect, graphicsFont, str, svgArc, textWidth, transformBounds } from "./helpers";

const SIZE = 44;
const BELL = 64;
const SPACING = 1;

/** Fills `text` with CSS letter spacing, keeping the font's kerning between neighbours. */
function fillSpaced(ctx: GraphicsContext, text: string, x: number, y: number): void {
    const chars = Array.from(text);
    let prefix = "";
    chars.forEach((ch, i) => {
        ctx.fillText(ch, x + textWidth(ctx, prefix) + i * SPACING, y);
        prefix += ch;
    });
}

function bellPath(ctx: GraphicsContext): void {
    ctx.beginPath();
    ctx.moveTo(12, 2);
    svgArc(ctx, 12, 2, 6, false, false, 6, 8);
    ctx.lineTo(6, 11.6);
    ctx.lineTo(4.3, 15);
    svgArc(ctx, 4.3, 15, 0.7, false, false, 4.93, 16);
    ctx.lineTo(19.1, 16);
    svgArc(ctx, 19.1, 16, 0.7, false, false, 19.72, 15);
    ctx.lineTo(18, 11.6);
    ctx.lineTo(18, 8);
    svgArc(ctx, 18, 8, 6, false, false, 12, 2);
    ctx.closePath();
    ctx.moveTo(9.8, 18);
    svgArc(ctx, 9.8, 18, 2.4, false, false, 14.2, 18);
    ctx.closePath();
}

export const drawSubscribeButton: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const text = str(props.text);
    const buttonColor = color(props.buttonColor, "#ff0033");
    const textColor = color(props.textColor, "#ffffff");
    const position = str(props.position, "bottom");
    const showBell = str(props.showBell, "yes") === "yes";
    const enter = spring({ frame, fps, config: { damping: 12, stiffness: 180 } });
    const clickAt = fps * 1.2;
    const pulse = interpolate(frame, [clickAt, clickAt + 4, clickAt + 10], [1, 0.92, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const shake = frame > clickAt + 10
        ? Math.sin((frame - clickAt - 10) * 0.9) * interpolate(frame, [clickAt + 10, clickAt + 34], [14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        : 0;
    const scale = enter * pulse;
    if (!(scale > 0)) return null;

    ctx.font = graphicsFont(800, SIZE);
    const chars = Array.from(text).length;
    const textW = textWidth(ctx, text) + chars * SPACING;
    const lineH = SIZE * INTER_LINE_HEIGHT;
    const buttonW = textW + 2.2 * SIZE;
    const buttonH = lineH + 0.9 * SIZE;
    const rowW = buttonW + (showBell ? 22 + BELL : 0);
    const rowH = Math.max(buttonH, showBell ? BELL : 0);
    const x = (width - rowW) / 2;
    const y = position === "top" ? width * 0.06 : position === "center" ? (height - rowH) / 2 : height - width * 0.06 - rowH;
    const cx = x + rowW / 2;
    const cy = y + rowH / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    const by = cy - buttonH / 2;
    fillRoundedRect(ctx, x, by, buttonW, buttonH, 0.35 * SIZE, buttonColor);
    ctx.fillStyle = textColor;
    ctx.font = graphicsFont(800, SIZE);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    fillSpaced(ctx, text, x + 1.1 * SIZE, by + 0.45 * SIZE + baselineOffset(lineH, SIZE));
    if (showBell) {
        const bx = x + buttonW + 22;
        const bellY = cy - BELL / 2;
        ctx.translate(bx + BELL / 2, bellY + BELL * 0.1);
        ctx.rotate((shake * Math.PI) / 180);
        ctx.translate(-BELL / 2, -BELL * 0.1);
        ctx.scale(BELL / 24, BELL / 24);
        bellPath(ctx);
        ctx.fillStyle = buttonColor;
        ctx.fill();
    }
    ctx.restore();
    return clipBounds(transformBounds({ x, y, width: rowW, height: rowH }, 0, 0, scale, cx, cy), width, height);
};
