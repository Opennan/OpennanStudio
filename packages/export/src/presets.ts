// Output frame sizes: canvas presets × 720p/1080p/4K.
import type { ExportResolution, OutputFormat } from "./types";

export const CANVAS_PRESETS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type CanvasPreset = (typeof CANVAS_PRESETS)[number];

export const EXPORT_RESOLUTIONS: readonly ExportResolution[] = ["720p", "1080p", "4k"];
export const DEFAULT_FPS = 30;
export const DEFAULT_AUDIO_BITRATE_KBPS = 192;
export const RESOLUTION_BITRATE_KBPS: Record<ExportResolution, number> = { "720p": 5000, "1080p": 8000, "4k": 35000 };

const RESOLUTION_FACTOR: Record<ExportResolution, number> = { "720p": 2 / 3, "1080p": 1, "4k": 2 };

/** Same parse as the preview (timeline-react preview/preview-panel.tsx:54-60): "W:H", else 16:9. */
export function parseAspectRatio(value: string | null | undefined): number {
    const match = value?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return 16 / 9;
    const w = Number(match[1]);
    const h = Number(match[2]);
    // Clamped to 1:5 … 5:1: "1:100" from an agent would otherwise ask ffmpeg for a 1080×108000 frame.
    return w > 0 && h > 0 ? Math.min(5, Math.max(0.2, w / h)) : 16 / 9;
}

function even(value: number): number {
    return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Output frame for a project ratio and resolution. Text and sticker sizes are authored for the
 * 1080p reference frame (1920 wide when landscape, else 1080 wide), the same reference the
 * preview scales by (preview-panel.tsx:1018-1019); frameScale converts them to output pixels.
 */
export function resolveOutputFormat(
    aspectRatio: string | null | undefined,
    resolution: ExportResolution,
    fps: number = DEFAULT_FPS,
): OutputFormat {
    const ratio = parseAspectRatio(aspectRatio);
    const refWidth = ratio > 1 ? 1920 : 1080;
    const refHeight = refWidth / ratio;
    const factor = RESOLUTION_FACTOR[resolution];
    const width = even(refWidth * factor);
    const height = even(refHeight * factor);
    return { width, height, fps, aspectRatio: ratio, refWidth, refHeight, frameScale: height / refHeight };
}

/** GIF exports (phase 10d): frames per second unless the settings give one, and the widest frame. */
export const GIF_DEFAULT_FPS = 15;
export const GIF_MAX_WIDTH = 640;

/**
 * A GIF's frame: the video frame for the ratio and resolution, scaled down (if needed) to GIF_MAX_WIDTH wide keeping
 * the aspect, even sides. frameScale follows, so text and stickers keep their place.
 */
export function resolveGifFormat(aspectRatio: string | null | undefined, resolution: ExportResolution, fps: number = GIF_DEFAULT_FPS): OutputFormat {
    const base = resolveOutputFormat(aspectRatio, resolution, fps);
    if (base.width <= GIF_MAX_WIDTH) return base;
    const width = even(GIF_MAX_WIDTH);
    const height = even((base.height * GIF_MAX_WIDTH) / base.width);
    return { ...base, width, height, frameScale: height / base.refHeight };
}

/** True when `resolution` is at most `max` (runner limits, e.g. ffmpeg.wasm memory). */
export function resolutionWithin(resolution: ExportResolution, max: ExportResolution): boolean {
    return EXPORT_RESOLUTIONS.indexOf(resolution) <= EXPORT_RESOLUTIONS.indexOf(max);
}
