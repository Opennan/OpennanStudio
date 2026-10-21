// Social handle: a fully rounded badge (0.5em/1em padding at 34 px, weight 700) holding a 40 px platform mark
// (the original's 24-unit YouTube / TikTok / Instagram / X icons in the text colour) and the handle 14 px to
// its right, sliding 120 px in from its side and fading in with a spring (damping 16, stiffness 140). Placement
// as the CSS original: 4 % of the width from the left or right edge and 5 % of the height from the top or bottom.
import { spring } from "../spring";
import type { GraphicsContext, GraphicsDraw } from "../types";
import { INTER_LINE_HEIGHT, clamp01, clipBounds, color, fillLines, fillRoundedRect, graphicsFont, roundedRectPath, str, svgArc, textWidth } from "./helpers";

const SIZE = 34;
const MARK = 40;

function polygon(ctx: GraphicsContext, points: number[]): void {
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.closePath();
}

/** Draws a platform mark in 24-unit icon space (the caller scales). */
function drawMark(ctx: GraphicsContext, platform: string, fill: string, base: number): void {
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    if (platform === "youtube") {
        roundedRectPath(ctx, 2, 5, 20, 14, 4);
        ctx.fill();
        ctx.globalAlpha = base * 0.85;
        ctx.fillStyle = "#000";
        polygon(ctx, [10, 9.2, 10, 14.8, 15, 12]);
        ctx.fill();
    } else if (platform === "tiktok") {
        ctx.beginPath();
        ctx.moveTo(14, 3);
        ctx.lineTo(17, 3);
        svgArc(ctx, 17, 3, 5, false, false, 21, 7);
        ctx.lineTo(21, 10);
        svgArc(ctx, 21, 10, 8, false, true, 17, 8.7);
        ctx.lineTo(17, 15);
        svgArc(ctx, 17, 15, 6, true, true, 11, 9);
        ctx.lineTo(11, 12);
        svgArc(ctx, 11, 12, 3, true, false, 14, 15);
        ctx.closePath();
        ctx.fill();
    } else if (platform === "instagram") {
        ctx.lineWidth = 2.2;
        roundedRectPath(ctx, 3, 3, 18, 18, 5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(12, 12, 4.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(17.2, 6.8, 1.4, 0, Math.PI * 2);
        ctx.fill();
    } else {
        polygon(ctx, [4, 4, 8.6, 4, 12.6, 9.6, 17.4, 4, 20, 4, 14, 12, 20.4, 20, 16, 20, 11.6, 14, 7, 20, 4.4, 20, 10.8, 11.6]);
        ctx.fill();
    }
}

export const drawSocialHandle: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const handle = str(props.handle);
    const platform = str(props.platform, "youtube");
    const bg = color(props.bgColor, "#111111");
    const textColor = color(props.textColor, "#ffffff");
    const corner = str(props.corner, "bottom_left");
    const enter = spring({ frame, fps, config: { damping: 16, stiffness: 140 } });
    const alpha = clamp01(enter);
    if (!(alpha > 0)) return null;
    const fromLeft = corner.endsWith("left");
    const slide = (1 - enter) * 120 * (fromLeft ? -1 : 1);

    ctx.font = graphicsFont(700, SIZE);
    const textW = handle ? textWidth(ctx, handle) : 0;
    const lineH = SIZE * INTER_LINE_HEIGHT;
    const boxW = SIZE + MARK + 14 + textW + SIZE;
    const boxH = Math.max(MARK, lineH) + SIZE;
    const x = (fromLeft ? width * 0.04 : width - width * 0.04 - boxW) + slide;
    const y = corner.startsWith("top") ? height * 0.05 : height - height * 0.05 - boxH;
    const mid = y + boxH / 2;

    const base = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = base * alpha;
    fillRoundedRect(ctx, x, y, boxW, boxH, boxH / 2, bg);
    ctx.fillStyle = textColor;
    fillLines(ctx, { lines: [handle], widths: [textW], width: textW }, x + SIZE + MARK + 14, mid - lineH / 2, textW, lineH, SIZE);
    ctx.save();
    ctx.translate(x + SIZE, mid - MARK / 2);
    ctx.scale(MARK / 24, MARK / 24);
    drawMark(ctx, platform, textColor, base * alpha);
    ctx.restore();
    ctx.restore();
    return clipBounds({ x, y, width: boxW, height: boxH }, width, height);
};
