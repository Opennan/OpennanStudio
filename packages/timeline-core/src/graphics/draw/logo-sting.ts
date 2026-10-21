// Logo sting: the logo (contained in 280 × 280) above the brand text (64 px weight 800), 18 px apart in a
// 20 px-padded box, springs in (damping 14, stiffness 120) and a skewed (-18°) white shine band (18 % of the box
// wide, a 105° transparent → 45 % white → transparent gradient) sweeps across it from 0.8 s to 1.6 s, clipped to
// the box, over an optional full-frame background. The logo comes from the host's decoded assets
// (graphicsAssetUrls); when it is not available the sting draws the text alone. Nothing is ever fetched here.
import { clampedInterpolate, spring } from "../spring";
import type { GraphicsBounds, GraphicsDraw } from "../types";
import {
    INTER_LINE_HEIGHT, clipBounds, color, cssLinearGradient, fillLines, fullFrame, graphicsFont, isTransparent, str, textWidth, transformBounds, unionBounds,
} from "./helpers";

const LOGO = 280;

/** Intrinsic size of a decoded image source (HTMLImageElement, ImageBitmap, canvases, VideoFrame), or null. */
function imageSize(image: CanvasImageSource): { width: number; height: number } | null {
    const source = image as unknown as Record<string, unknown>;
    for (const [w, h] of [["naturalWidth", "naturalHeight"], ["displayWidth", "displayHeight"], ["videoWidth", "videoHeight"], ["width", "height"]]) {
        const width = source[w];
        const height = source[h];
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) return { width, height };
    }
    return null;
}

export const drawLogoSting: GraphicsDraw = (ctx, { width, height, frame, fps, props, assets }) => {
    const url = str(props.logoUrl).trim();
    const text = str(props.text);
    const textColor = color(props.color, "#ffffff");
    const bg = color(props.bgColor, "transparent");
    const scale = spring({ frame, fps, config: { damping: 14, stiffness: 120 } });
    const shine = clampedInterpolate(frame, [fps * 0.8, fps * 1.6], [-60, 160]);
    let logo: CanvasImageSource | null = null;
    try {
        logo = url && assets ? assets.image(url) : null;
    } catch {
        logo = null;
    }
    const logoSize = logo ? imageSize(logo) : null;
    if (!logoSize) logo = null;

    ctx.font = graphicsFont(800, 64);
    const textW = text ? textWidth(ctx, text) : 0;
    const lineH = 64 * INTER_LINE_HEIGHT;
    const contentW = Math.max(logo ? LOGO : 0, textW);
    const contentH = (logo ? LOGO : 0) + (logo && text ? 18 : 0) + (text ? lineH : 0);
    const boxW = contentW + 40;
    const boxH = contentH + 40;
    const cx = width / 2;
    const cy = height / 2;
    const x = cx - boxW / 2;
    const y = cy - boxH / 2;

    const boxes: GraphicsBounds[] = [];
    ctx.save();
    if (!isTransparent(bg)) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);
        boxes.push(fullFrame(width, height));
    }
    if (scale > 0) {
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
        ctx.beginPath();
        ctx.rect(x, y, boxW, boxH);
        ctx.clip();
        let top = y + 20;
        if (logo && logoSize) {
            const fit = Math.min(LOGO / logoSize.width, LOGO / logoSize.height);
            const w = logoSize.width * fit;
            const h = logoSize.height * fit;
            ctx.drawImage(logo, cx - w / 2, top + (LOGO - h) / 2, w, h);
            top += LOGO + 18;
        }
        if (text) {
            ctx.fillStyle = textColor;
            fillLines(ctx, { lines: [text], widths: [textW], width: textW }, cx - textW / 2, top, textW, lineH, 64);
        }
        // The shine: a box 18 % of the width at `shine` % from the left, skewed about its centre.
        const sw = boxW * 0.18;
        const sx = x + (boxW * shine) / 100;
        ctx.translate(sx + sw / 2, cy);
        ctx.transform(1, 0, Math.tan((-18 * Math.PI) / 180), 1, 0, 0);
        const gradient = cssLinearGradient(ctx, 105, -sw / 2, -boxH / 2, sw, boxH);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(0.5, "rgba(255,255,255,0.45)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(-sw / 2, -boxH / 2, sw, boxH);
        boxes.push(transformBounds({ x, y, width: boxW, height: boxH }, 0, 0, scale, cx, cy));
    }
    ctx.restore();
    return clipBounds(unionBounds(...boxes), width, height);
};
