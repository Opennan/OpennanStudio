// Intro / outro card: a full-frame 135° gradient with a centred 96 px weight-800 headline rising 30 px as it
// fades in (damping-200 spring) and an optional 40 px subline 20 px below fading to 85 % in the spring's second
// half; the whole card fades out over the last half second. Long text wraps inside the frame width, lines
// left-aligned in a centred fit-content box (CSS block text in a centred flex item).
import { clampedInterpolate, exitWindow, interpolate, spring } from "../spring";
import type { GraphicsDraw } from "../types";
import { INTER_LINE_HEIGHT, addStop, clamp01, color, cssLinearGradient, fillLines, fullFrame, graphicsFont, str, wrapText } from "./helpers";

export const drawCard: GraphicsDraw = (ctx, { width, height, frame, durationInFrames, fps, props }) => {
    const headline = str(props.headline);
    const subline = str(props.subline);
    const from = color(props.fromColor, "#1e1b4b");
    const to = color(props.toColor, "#7c3aed");
    const textColor = color(props.textColor, "#ffffff");
    const fade = clampedInterpolate(frame, exitWindow(fps, durationInFrames), [1, 0]);
    if (!(fade > 0)) return null;
    const enter = spring({ frame, fps, config: { damping: 200 } });

    ctx.font = graphicsFont(800, 96);
    const head = headline ? wrapText(ctx, headline, width) : null;
    const headH = head ? head.lines.length * 96 * INTER_LINE_HEIGHT : 0;
    ctx.font = graphicsFont(400, 40);
    const sub = subline ? wrapText(ctx, subline, width) : null;
    const subH = sub ? sub.lines.length * 40 * INTER_LINE_HEIGHT : 0;
    const top = (height - headH - (sub ? 20 + subH : 0)) / 2;

    const base = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = base * fade;
    const gradient = cssLinearGradient(ctx, 135, 0, 0, width, height);
    addStop(gradient, 0, from);
    addStop(gradient, 1, to);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = textColor;
    if (head && enter > 0) {
        ctx.globalAlpha = base * fade * clamp01(enter);
        ctx.font = graphicsFont(800, 96);
        fillLines(ctx, head, (width - head.width) / 2, top + interpolate(enter, [0, 1], [30, 0]), head.width, 96 * INTER_LINE_HEIGHT, 96);
    }
    const subAlpha = clamp01(interpolate(enter, [0.5, 1], [0, 0.85], { extrapolateLeft: "clamp" }));
    if (sub && subAlpha > 0) {
        ctx.globalAlpha = base * fade * subAlpha;
        ctx.font = graphicsFont(400, 40);
        fillLines(ctx, sub, (width - sub.width) / 2, top + headH + 20, sub.width, 40 * INTER_LINE_HEIGHT, 40);
    }
    ctx.restore();
    return fullFrame(width, height);
};
