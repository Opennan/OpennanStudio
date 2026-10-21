// Highlight spot: a circle or rounded box (radius 12 %) `size` % of the width across, centred on (x, y), with a
// 6 px border breathing ±4 % and a 4 px ring expanding to 145 % and fading every 1.2 s, both scaling in with a
// spring (damping 14, stiffness 150). The optional dim darkens the frame by 45 % outside a soft circular hole
// (clear to 60 %, full at 72 % of a radius of 0.75 × size % of the width). The original's mask was written as
// `radial-gradient(circle <percent> …)`, which CSS does not accept for circles; this draws the hole it meant.
import { interpolate, spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { clamp01, clampedNumber, clipBounds, color, fullFrame, roundedRectPath, str, unionBounds } from "./helpers";

export const drawHighlightSpot: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const x = clampedNumber(props.x, 0.5, -10, 10) * width;
    const y = clampedNumber(props.y, 0.5, -10, 10) * height;
    const size = clampedNumber(props.size, 22, 0, 1000);
    const box = str(props.shape, "circle") === "box";
    const stroke = color(props.color, "#f59e0b");
    const dim = str(props.dimBackground, "no") === "yes";
    const enter = spring({ frame, fps, config: { damping: 14, stiffness: 150 } });
    const pulse = 1 + Math.sin(frame / 7) * 0.04;
    const phase = (frame % (fps * 1.2)) / (fps * 1.2);
    const ringOpacity = interpolate(phase, [0, 1], [0.8, 0]);
    const ringScale = 1 + phase * 0.45;
    const side = (size / 100) * width;

    const base = ctx.globalAlpha;
    const boxes: GraphicsBounds[] = [];
    ctx.save();
    if (dim && enter > 0) {
        const r = (size * 0.75 * width) / 100;
        ctx.globalAlpha = base * clamp01(enter);
        if (r > 0) {
            const hole = ctx.createRadialGradient(x, y, 0, x, y, r);
            hole.addColorStop(0, "rgba(0,0,0,0)");
            hole.addColorStop(0.6, "rgba(0,0,0,0)");
            hole.addColorStop(0.72, "rgba(0,0,0,0.45)");
            hole.addColorStop(1, "rgba(0,0,0,0.45)");
            ctx.fillStyle = hole;
        } else {
            ctx.fillStyle = "rgba(0,0,0,0.45)";
        }
        ctx.fillRect(0, 0, width, height);
        boxes.push(fullFrame(width, height));
    }
    // A border-box square of `side` with a `border` px border, scaled by `scale` about (x, y).
    const outline = (scale: number, border: number, alpha: number) => {
        const s = side * scale;
        const bw = border * scale;
        if (!(s > 0) || !(alpha > 0)) return;
        ctx.globalAlpha = base * alpha;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.min(bw, s / 2);
        const inset = ctx.lineWidth / 2;
        if (box) {
            roundedRectPath(ctx, x - s / 2 + inset, y - s / 2 + inset, s - 2 * inset, s - 2 * inset, Math.max(0, s * 0.12 - inset));
        } else {
            ctx.beginPath();
            ctx.arc(x, y, Math.max(0, s / 2 - inset), 0, Math.PI * 2);
        }
        ctx.stroke();
        boxes.push({ x: x - s / 2, y: y - s / 2, width: s, height: s });
    };
    outline(enter * ringScale, 4, clamp01(ringOpacity * enter));
    outline(enter * pulse, 6, 1);
    ctx.restore();
    return clipBounds(unionBounds(...boxes), width, height);
};
