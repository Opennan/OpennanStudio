// Arrow callout: a 72 px arrow (the original's 24-unit icon: a 3.4-unit round stroke shaft and head) pointing
// at (x, y) and bobbing 10 px along its axis, with a pill label (34 px weight 700, 0.35em/0.8em padding, 0.4em
// radius, no wrapping) on the side away from the head, 6 px apart; the group fades in with a spring (damping
// 13, stiffness 160). Placement as the CSS original: "down" puts the group's bottom centre on the target, "up"
// its top centre, "left" its left middle, "right" its right middle.
import { spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import {
    INTER_LINE_HEIGHT, clamp01, clampedNumber, clipBounds, color, fillLines, fillRoundedRect, graphicsFont, str, textWidth, unionBounds,
} from "./helpers";

const ROTATION: Record<string, number> = { down: 0, up: 180, left: 90, right: -90 };
const ICON = 72;
const UNIT = ICON / 24;
const LABEL_SIZE = 34;

export const drawArrowCallout: GraphicsDraw = (ctx, { width, height, frame, fps, props }) => {
    const label = str(props.label);
    const tx = clampedNumber(props.x, 0.5, -10, 10) * width;
    const ty = clampedNumber(props.y, 0.5, -10, 10) * height;
    const rawDirection = str(props.direction, "down");
    const direction = rawDirection in ROTATION ? rawDirection : "down";
    const fill = color(props.color, "#f59e0b");
    const textColor = color(props.textColor, "#111111");
    const enter = spring({ frame, fps, config: { damping: 13, stiffness: 160 } });
    const alpha = clamp01(enter);
    if (!(alpha > 0)) return null;
    const bob = Math.sin(frame / 9) * 10 * enter;
    const column = direction === "down" || direction === "up";
    const labelFirst = direction === "down" || direction === "right";

    ctx.font = graphicsFont(700, LABEL_SIZE);
    const textW = label ? textWidth(ctx, label) : 0;
    const lineH = LABEL_SIZE * INTER_LINE_HEIGHT;
    const labelW = label ? textW + 1.6 * LABEL_SIZE : 0;
    const labelH = label ? lineH + 0.7 * LABEL_SIZE : 0;
    const gap = label ? 6 : 0;
    const groupW = column ? Math.max(labelW, ICON) : labelW + gap + ICON;
    const groupH = column ? labelH + gap + ICON : Math.max(labelH, ICON);
    const gx = column ? tx - groupW / 2 : direction === "right" ? tx - groupW : tx;
    const gy = column ? (direction === "down" ? ty - groupH : ty) : ty - groupH / 2;

    // Main-axis positions of the label and the icon inside the group.
    const labelPos = labelFirst ? 0 : ICON + gap;
    const iconPos = labelFirst ? (column ? labelH : labelW) + gap : 0;
    const labelBox: GraphicsBounds = column
        ? { x: gx + (groupW - labelW) / 2, y: gy + labelPos, width: labelW, height: labelH }
        : { x: gx + labelPos, y: gy + (groupH - labelH) / 2, width: labelW, height: labelH };
    const iconX = column ? gx + (groupW - ICON) / 2 : gx + iconPos;
    const iconY = column ? gy + iconPos : gy + (groupH - ICON) / 2;

    const base = ctx.globalAlpha;
    const boxes: GraphicsBounds[] = [];
    ctx.save();
    ctx.globalAlpha = base * alpha;
    if (label) {
        fillRoundedRect(ctx, labelBox.x, labelBox.y, labelW, labelH, 0.4 * LABEL_SIZE, fill);
        ctx.fillStyle = textColor;
        ctx.font = graphicsFont(700, LABEL_SIZE);
        fillLines(ctx, { lines: [label], widths: [textW], width: textW }, labelBox.x + 0.8 * LABEL_SIZE, labelBox.y + 0.35 * LABEL_SIZE, textW, lineH, LABEL_SIZE);
        boxes.push(labelBox);
    }
    // The icon: rotate(r) translateY(bob) about its centre, in 24-unit icon space.
    const rad = (ROTATION[direction] * Math.PI) / 180;
    ctx.save();
    ctx.translate(iconX + ICON / 2, iconY + ICON / 2);
    ctx.rotate(rad);
    ctx.translate(0, bob);
    ctx.scale(UNIT, UNIT);
    ctx.translate(-12, -12);
    ctx.beginPath();
    ctx.moveTo(12, 3);
    ctx.lineTo(12, 16);
    ctx.moveTo(12, 16);
    ctx.lineTo(6.5, 10.5);
    ctx.moveTo(12, 16);
    ctx.lineTo(17.5, 10.5);
    ctx.strokeStyle = fill;
    ctx.lineWidth = 3.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
    // Painted box of the arrow: its icon-space extent (stroke included) moved by the bob, then turned.
    const half = 1.7;
    const local = { x0: (6.5 - half - 12) * UNIT, x1: (17.5 + half - 12) * UNIT, y0: (3 - half - 12) * UNIT + bob, y1: (16 + half - 12) * UNIT + bob };
    const corners = [[local.x0, local.y0], [local.x1, local.y0], [local.x0, local.y1], [local.x1, local.y1]].map(([px, py]) => [
        px * Math.cos(rad) - py * Math.sin(rad), px * Math.sin(rad) + py * Math.cos(rad),
    ]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    boxes.push({
        x: iconX + ICON / 2 + Math.min(...xs), y: iconY + ICON / 2 + Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    });
    ctx.restore();
    return clipBounds(unionBounds(...boxes), width, height);
};
