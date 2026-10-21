// The built-in graphics renderer (phase 10d): which clips it draws, their parameters and frame, and one call that
// draws a clip's frame onto any Canvas 2D surface at any size. Used by the preview (timeline-react GraphicsOverlay),
// the GPU export (OffscreenCanvas per frame), and the ffmpeg export's rasterizer (image sequence).
import type { TimelineClip } from "../model/timeline";
import { GRAPHICS_DRAWS } from "./draw/index";
import { GRAPHICS_FPS, GRAPHICS_TEMPLATES } from "./templates";
import type { GraphicsAssets, GraphicsBounds, GraphicsContext, GraphicsTemplateDef } from "./types";

/** Long side of the composition graphics are authored in (px), as OpenNan's player. */
export const GRAPHICS_COMPOSITION_LONG_SIDE = 1280;

type GraphicsClip = Pick<TimelineClip, "trackType" | "startTime" | "endTime" | "remotionTemplateId" | "remotionPropsJson" | "remotionCode">;

export function graphicsTemplateById(id: string | null | undefined): GraphicsTemplateDef | undefined {
    return id ? GRAPHICS_TEMPLATES.find((template) => template.id === id) : undefined;
}

/** A graphics clip this build draws: a built-in template and no custom code (custom code needs the Remotion add-on). */
export function isBuiltinGraphics(clip: Partial<GraphicsClip>): boolean {
    return clip.trackType === "remotion" && !clip.remotionCode?.trim() && Boolean(clip.remotionTemplateId && GRAPHICS_DRAWS[clip.remotionTemplateId]);
}

/** Why a graphics clip is not drawn by this build, or null when it is. */
export function graphicsUnsupportedReason(clip: Partial<GraphicsClip>): "custom-code" | "unknown-template" | null {
    if (clip.trackType !== "remotion") return null;
    if (clip.remotionCode?.trim()) return "custom-code";
    return clip.remotionTemplateId && GRAPHICS_DRAWS[clip.remotionTemplateId] ? null : "unknown-template";
}

function coerce(type: GraphicsTemplateDef["params"][number]["type"], value: unknown, fallback: unknown): unknown {
    if (value === undefined || value === null) return fallback;
    if (type === "number") {
        const n = typeof value === "number" ? value : Number(value);
        return Number.isFinite(n) ? n : fallback;
    }
    if (type === "json") return value;
    return typeof value === "string" ? value : String(value);
}

/** Template defaults merged with the clip's props (`remotionPropsJson`), coerced to the declared parameter types. */
export function graphicsProps(clip: Pick<GraphicsClip, "remotionTemplateId" | "remotionPropsJson">): Record<string, unknown> {
    const template = graphicsTemplateById(clip.remotionTemplateId);
    let stored: Record<string, unknown> = {};
    if (clip.remotionPropsJson) {
        try {
            const parsed = JSON.parse(clip.remotionPropsJson) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
        } catch {
            stored = {};
        }
    }
    const out: Record<string, unknown> = { ...stored };
    for (const param of template?.params ?? []) out[param.key] = coerce(param.type, stored[param.key], param.default);
    return out;
}

/** Clip length in template frames (at least 1). */
export function graphicsDurationInFrames(clip: Pick<GraphicsClip, "startTime" | "endTime">): number {
    return Math.max(1, Math.ceil(Math.max(0, clip.endTime - clip.startTime) * GRAPHICS_FPS - 1e-9));
}

/** Template frame shown at clip-local `localSeconds`: round(local × fps), clamped to the clip. */
export function graphicsFrameAt(clip: Pick<GraphicsClip, "startTime" | "endTime">, localSeconds: number): number {
    const last = graphicsDurationInFrames(clip) - 1;
    const frame = Math.round((Number.isFinite(localSeconds) ? localSeconds : 0) * GRAPHICS_FPS);
    return Math.min(last, Math.max(0, frame));
}

/** Composition size for a frame aspect ratio (width / height): long side 1280, even sides. */
export function graphicsCompositionSize(aspect: number): { width: number; height: number } {
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    const long = GRAPHICS_COMPOSITION_LONG_SIDE;
    if (ratio >= 1) return { width: long, height: Math.max(2, Math.round(long / ratio / 2) * 2) };
    return { width: Math.max(2, Math.round((long * ratio) / 2) * 2), height: long };
}

export interface DrawGraphicsOptions {
    /** Target size in px (the canvas region the full-frame composition fills). */
    width: number;
    height: number;
    /** Template frame (graphicsFrameAt). */
    frame: number;
    assets?: GraphicsAssets | null;
}

/**
 * Draws the clip's template frame filling a `width × height` region at the context's current origin (the context
 * is left as it was). Returns the painted bounds in target px, or null when nothing is painted or the clip is not
 * a built-in graphic.
 */
export function drawGraphicsFrame(ctx: GraphicsContext, clip: GraphicsClip, options: DrawGraphicsOptions): GraphicsBounds | null {
    if (!isBuiltinGraphics(clip) || !(options.width > 0) || !(options.height > 0)) return null;
    const draw = GRAPHICS_DRAWS[clip.remotionTemplateId!];
    const comp = graphicsCompositionSize(options.width / options.height);
    const sx = options.width / comp.width;
    const sy = options.height / comp.height;
    ctx.save();
    try {
        ctx.scale(sx, sy);
        const bounds = draw(ctx, {
            width: comp.width, height: comp.height, frame: options.frame, durationInFrames: graphicsDurationInFrames(clip), fps: GRAPHICS_FPS,
            props: graphicsProps(clip), assets: options.assets ?? null,
        });
        return bounds ? { x: bounds.x * sx, y: bounds.y * sy, width: bounds.width * sx, height: bounds.height * sy } : null;
    } finally {
        ctx.restore();
    }
}

/** Image URLs a clip's template draws (preloaded by hosts into GraphicsAssets). */
export function graphicsAssetUrls(clip: Pick<GraphicsClip, "remotionTemplateId" | "remotionPropsJson">): string[] {
    if (clip.remotionTemplateId !== "logo-sting") return [];
    const url = graphicsProps(clip).logoUrl;
    return typeof url === "string" && url.trim() ? [url.trim()] : [];
}
