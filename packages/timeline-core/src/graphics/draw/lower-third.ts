// Lower third: a name bar and a role bar slide in from the left at the lower third and slide out at the end.
// Layout in composition px: left inset 6 % and bottom inset 12 % of the width, name 44 px bold with 10/28 px
// padding, role 28 px regular with 6/28 px padding 6 px below, both 6 px rounded; the name bar spans the wider
// of the two rows.
import { clampedInterpolate, exitWindow, interpolate, spring } from "../spring";
import type { GraphicsDraw } from "../types";
import { INTER_LINE_HEIGHT, color, fillRoundedRect, graphicsFont, numberOr, str, textWidth } from "./helpers";

export { INTER_LINE_HEIGHT };

export const drawLowerThird: GraphicsDraw = (ctx, { width, height, frame, durationInFrames, fps, props }) => {
    const name = str(props.name);
    const role = str(props.role);
    const barColor = color(props.barColor, "#7c3aed");
    const textColor = color(props.textColor, "#ffffff");
    const speed = Math.max(0.1, numberOr(props.speed, 1) || 1);

    const enter = spring({ frame: frame * speed, fps, config: { damping: 200 } });
    const exit = clampedInterpolate(frame, exitWindow(fps, durationInFrames), [0, 1]);
    const shiftPercent = interpolate(enter, [0, 1], [-100, 0]) - exit * 110;

    ctx.font = graphicsFont(700, 44);
    const nameText = textWidth(ctx, name);
    ctx.font = graphicsFont(400, 28);
    const roleText = textWidth(ctx, role);
    const nameH = 44 * INTER_LINE_HEIGHT + 20;
    const roleH = 28 * INTER_LINE_HEIGHT + 12;
    const roleW = roleText + 56;
    const boxW = Math.max(nameText + 56, roleW);
    const boxH = nameH + 6 + roleH;
    const x = width * 0.06 + (shiftPercent / 100) * boxW;
    const y = height - width * 0.12 - boxH;

    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    fillRoundedRect(ctx, x, y, boxW, nameH, 6, barColor);
    ctx.fillStyle = textColor;
    ctx.font = graphicsFont(700, 44);
    ctx.fillText(name, x + 28, y + nameH / 2);
    fillRoundedRect(ctx, x, y + nameH + 6, roleW, roleH, 6, "rgba(0,0,0,0.75)");
    ctx.fillStyle = textColor;
    ctx.font = graphicsFont(400, 28);
    ctx.fillText(role, x + 28, y + nameH + 6 + roleH / 2);
    ctx.restore();

    const left = Math.max(0, x);
    const right = Math.min(width, x + boxW);
    return right > left ? { x: left, y, width: right - left, height: boxH } : null;
};
