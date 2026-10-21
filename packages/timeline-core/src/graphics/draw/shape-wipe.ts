// Shape wipe: a full-frame stinger that covers the frame by the middle of the clip and reveals it again by the
// end, as the CSS original: "wipe" is a band whose leading then trailing edge cross the frame in `direction`
// with a 12 px accent edge on its leading side; "circle" is a centred disc whose diameter grows to 160 % of the
// width and shrinks back, ringed by a spread shadow (radius × 0.5 px) of the accent at 13 % alpha (only for
// #rrggbb accents, where the original's `${accent}22` is a valid colour); "split" is two bands closing from the
// top and bottom edges to the middle with 10 px accent borders on their inner edges, then opening again.
import { clampedInterpolate } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import { clipBounds, color, hexWithAlpha, str, unionBounds } from "./helpers";

export const drawShapeWipe: GraphicsDraw = (ctx, { width, height, frame, durationInFrames, props }) => {
    const fill = color(props.color, "#111111");
    const accent = color(props.accentColor, "#7c3aed");
    const style = str(props.style, "wipe");
    const direction = str(props.direction, "left_to_right");
    const t = frame / Math.max(1, durationInFrames - 1);
    const cover = clampedInterpolate(t, [0, 0.5], [0, 1]);
    const reveal = clampedInterpolate(t, [0.5, 1], [0, 1]);
    const boxes: GraphicsBounds[] = [];

    ctx.save();
    if (style === "circle") {
        const radiusPct = t < 0.5 ? cover * 160 : (1 - reveal) * 160;
        const r = ((radiusPct / 100) * width) / 2;
        const spread = radiusPct * 0.5;
        const ring = hexWithAlpha(accent, "22");
        const cx = width / 2;
        const cy = height / 2;
        if (ring && spread > 0) {
            ctx.fillStyle = ring;
            ctx.beginPath();
            ctx.arc(cx, cy, r + spread, 0, Math.PI * 2);
            ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
            ctx.fill();
            boxes.push({ x: cx - r - spread, y: cy - r - spread, width: 2 * (r + spread), height: 2 * (r + spread) });
        }
        if (r > 0) {
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            boxes.push({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r });
        }
    } else if (style === "split") {
        const gap = t < 0.5 ? (1 - cover) * 50 : reveal * 50;
        const h = ((50 - gap) / 100) * height;
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, width, h);
        ctx.fillRect(0, height - h, width, h);
        ctx.fillStyle = accent;
        ctx.fillRect(0, h, width, 10);
        ctx.fillRect(0, height - h - 10, width, 10);
        boxes.push({ x: 0, y: 0, width, height: h + 10 }, { x: 0, y: height - h - 10, width, height: h + 10 });
    } else {
        const horizontal = direction === "left_to_right" || direction === "right_to_left";
        const forward = direction === "left_to_right" || direction === "top_to_bottom";
        const lead = cover * 100;
        const trail = reveal * 100;
        const from = forward ? trail : 100 - lead;
        const to = forward ? lead : 100 - trail;
        const extent = horizontal ? width : height;
        const start = (from / 100) * extent;
        const size = (Math.max(0, to - from) / 100) * extent;
        // The 12 px edge sits inside the band's leading side (and hangs out of it while the band is thinner).
        const edgeStart = forward ? start + size - 12 : start;
        const band: GraphicsBounds = horizontal ? { x: start, y: 0, width: size, height } : { x: 0, y: start, width, height: size };
        const edge: GraphicsBounds = horizontal ? { x: edgeStart, y: 0, width: 12, height } : { x: 0, y: edgeStart, width, height: 12 };
        if (size > 0) {
            ctx.fillStyle = fill;
            ctx.fillRect(band.x, band.y, band.width, band.height);
            boxes.push(band);
        }
        ctx.fillStyle = accent;
        ctx.fillRect(edge.x, edge.y, edge.width, edge.height);
        boxes.push(edge);
    }
    ctx.restore();
    return clipBounds(unionBounds(...boxes), width, height);
};
