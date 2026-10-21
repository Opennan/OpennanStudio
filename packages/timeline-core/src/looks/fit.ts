// Where a scene's media sits on the frame: CSS object-fit (contain/cover/fill) plus the scene transform
// (scale about the center, offsets in % of the frame), as the preview's sceneFitStyle and the export's
// sceneFit lay it out. Continuous values (the export rounds to even pixels at its own size).
export interface FitRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function sceneFitRect(
    fitMode: string | null | undefined,
    source: { width: number; height: number },
    frame: { width: number; height: number },
    transformScale = 1,
    offsetXPercent = 0,
    offsetYPercent = 0,
): FitRect {
    const sw = Math.max(1, source.width);
    const sh = Math.max(1, source.height);
    const scale = Number.isFinite(transformScale) && transformScale > 0 ? transformScale : 1;
    let width: number;
    let height: number;
    if (fitMode === "fill") {
        width = frame.width * scale;
        height = frame.height * scale;
    } else {
        const base = fitMode === "cover" ? Math.max(frame.width / sw, frame.height / sh) : Math.min(frame.width / sw, frame.height / sh);
        width = sw * base * scale;
        height = sh * base * scale;
    }
    return {
        width,
        height,
        x: (frame.width - width) / 2 + ((Number(offsetXPercent) || 0) / 100) * frame.width,
        y: (frame.height - height) / 2 + ((Number(offsetYPercent) || 0) / 100) * frame.height,
    };
}
