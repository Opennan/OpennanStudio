// Canvas presets (spec §1.1 "Canvas presets 9:16, 16:9, 1:1, 4:5"). The ratio is
// ProjectMeta.aspectRatio, which the preview already frames to
// (packages/timeline-react/src/preview/preview-panel.tsx:54-58,1006-1008).
export type CanvasRatio = "16:9" | "9:16" | "1:1" | "4:5";

export interface CanvasPreset {
    ratio: CanvasRatio;
    label: string;
    hint: string;
}

export const CANVAS_PRESETS: readonly CanvasPreset[] = [
    { ratio: "16:9", label: "Landscape", hint: "YouTube, desktop" },
    { ratio: "9:16", label: "Vertical", hint: "TikTok, Reels, Shorts" },
    { ratio: "1:1", label: "Square", hint: "Feed posts" },
    { ratio: "4:5", label: "Portrait", hint: "Instagram feed" },
];

export const DEFAULT_CANVAS_RATIO: CanvasRatio = "16:9";

export type ExportQuality = "720p" | "1080p";

export interface CanvasSize {
    width: number;
    height: number;
}

/** "9:16" -> { w: 9, h: 16 }. Anything unparsable falls back to 16:9. */
export function parseAspectRatio(value: string | null | undefined): { w: number; h: number } {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value ?? "");
    const w = match ? Number(match[1]) : 0;
    const h = match ? Number(match[2]) : 0;
    return w > 0 && h > 0 ? { w, h } : { w: 16, h: 9 };
}

/** Output frame size: the short side is the quality's line count, both sides even (H.264 needs even sizes). */
export function canvasSize(aspectRatio: string | null | undefined, quality: ExportQuality): CanvasSize {
    const { w, h } = parseAspectRatio(aspectRatio);
    const short = quality === "1080p" ? 1080 : 720;
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    return w >= h ? { width: even((short * w) / h), height: short } : { width: short, height: even((short * h) / w) };
}
