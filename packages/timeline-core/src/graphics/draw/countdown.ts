// Countdown: the remaining whole seconds in 160 px weight-800 digits at the centre, popping from 125 % to 100 %
// in the first fifth of each second, inside a 140 px ring (10 px stroke): a 25 % track and an arc from 12 o'clock
// clockwise that empties over `from` seconds (round caps), as the SVG original.
import { interpolate } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { INTER_LINE_HEIGHT, baselineOffset, clampedNumber, clipBounds, color, graphicsFont, textWidth, transformBounds, unionBounds } from "./helpers";

const RING_R = 140;
const RING_W = 10;
const DIGIT_SIZE = 160;

/** Whole seconds left at `frame` when counting down from `from`. */
export function countdownRemaining(frame: number, fps: number, from: number): number {
    return Math.max(0, Math.ceil(from - frame / fps));
}

export const drawCountdown: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const from = clampedNumber(props.from, 5, -1e6, 1e6);
    const digitColor = color(props.color, "#ffffff");
    const accent = color(props.accentColor, "#7c3aed");
    const elapsed = frame / fps;
    const label = String(countdownRemaining(frame, fps, from));
    const withinSecond = (frame % fps) / fps;
    const scale = interpolate(withinSecond, [0, 0.2, 1], [1.25, 1, 1], { extrapolateRight: "clamp" });
    const ringProgress = from > 0 ? Math.min(1, elapsed / from) : 1;
    const cx = width / 2;
    const cy = height / 2;

    const base = ctx.globalAlpha;
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = RING_W;
    ctx.globalAlpha = base * 0.25;
    ctx.beginPath();
    ctx.arc(cx, cy, RING_R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = base;
    if (ringProgress < 1) {
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(cx, cy, RING_R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - ringProgress));
        ctx.stroke();
    }

    ctx.font = graphicsFont(800, DIGIT_SIZE);
    const digitW = textWidth(ctx, label);
    const lineH = DIGIT_SIZE * INTER_LINE_HEIGHT;
    const box: GraphicsBounds = { x: cx - digitW / 2, y: cy - lineH / 2, width: digitW, height: lineH };
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.fillStyle = digitColor;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(label, -digitW / 2, -lineH / 2 + baselineOffset(lineH, DIGIT_SIZE));
    ctx.restore();

    const ringOuter = RING_R + RING_W / 2;
    const ring: GraphicsBounds = { x: cx - ringOuter, y: cy - ringOuter, width: ringOuter * 2, height: ringOuter * 2 };
    return clipBounds(unionBounds(ring, transformBounds(box, 0, 0, scale, cx, cy)), width, height);
};
