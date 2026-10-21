// Gradient backdrop: a full-frame CSS linear gradient from colour A to colour B whose angle sways ±12° and a soft
// white glow (18 % at its centre, transparent at 55 % of the distance to the farthest corner) drifting around
// the frame, both on slow sines of the clip time × `speed`.
import type { GraphicsDraw } from "../types";
import { addStop, color, cssLinearGradient, fullFrame, numberOr } from "./helpers";

export const drawGradientBackdrop: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const colorA = color(props.colorA, "#1e1b4b");
    const colorB = color(props.colorB, "#7c3aed");
    const angle = numberOr(props.angle, 135);
    const speed = numberOr(props.speed, 1);
    const t = (frame / fps) * speed;
    const drift = Math.sin(t * 0.6) * 12;
    const glowX = ((50 + Math.sin(t * 0.4) * 30) / 100) * width;
    const glowY = ((50 + Math.cos(t * 0.5) * 30) / 100) * height;

    ctx.save();
    const linear = cssLinearGradient(ctx, angle + drift, 0, 0, width, height);
    addStop(linear, 0, colorA);
    addStop(linear, 1, colorB);
    ctx.fillStyle = linear;
    ctx.fillRect(0, 0, width, height);
    // CSS `circle` with the default farthest-corner size.
    const radius = Math.hypot(Math.max(glowX, width - glowX), Math.max(glowY, height - glowY));
    const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, Math.max(1e-3, radius));
    glow.addColorStop(0, "rgba(255,255,255,0.18)");
    glow.addColorStop(0.55, "rgba(255,255,255,0)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    return fullFrame(width, height);
};
