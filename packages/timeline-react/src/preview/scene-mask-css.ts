// Masks on scenes the DOM draws (phase 10c): upper-track scenes (SceneOverlayLayer) are <video>/<img> elements
// with object-fit and a CSS transform, not WebGL, so their mask is a CSS mask image: timeline-core's mask levels
// (maskImage, the export's own reference) rendered small as white with alpha = level, placed over the element's
// fitted content rect (the item's pixel box) so the element's transform carries it like the media. Keyframed
// masks re-render when their values change (smaller image). The main track draws masks through LookRenderer.
import { maskImage, parseMask, type MaskSpec } from "@opennan/timeline-core/looks/masks";
import { parseTimelineKeyframes } from "@opennan/timeline-core/lib/timeline-editing-properties";
import type { SceneData } from "@opennan/timeline-core/timeline/canvas/types";
import { maskSpecAt } from "./motion/mask-handles";

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** The content rect of media `natural` inside an element box with CSS object-fit `mode`. */
export function objectFitRect(mode: SceneData["fitMode"], natural: { w: number; h: number }, box: { w: number; h: number }): Rect {
    if (!(natural.w > 0 && natural.h > 0) || mode === "fill") return { x: 0, y: 0, w: box.w, h: box.h };
    const scale = mode === "cover" ? Math.max(box.w / natural.w, box.h / natural.h) : Math.min(box.w / natural.w, box.h / natural.h);
    const w = natural.w * scale;
    const h = natural.h * scale;
    return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}

/** Longest side of a static / keyframed mask image (CSS scales it to the rect). */
const STATIC_SIDE = 256;
const ANIMATED_SIDE = 160;

export interface SceneMaskLayer {
    key: string;
    spec: MaskSpec;
    rect: Rect;
    image: { w: number; h: number };
}

/** What the scene's element needs at scene-local `t`, or null without a mask. */
export function sceneMaskLayer(
    scene: Pick<SceneData, "id"> & Partial<Pick<SceneData, "maskJson" | "keyframesJson" | "fitMode">>,
    natural: { w: number; h: number }, frame: { w: number; h: number }, t: number,
): SceneMaskLayer | null {
    const base = parseMask(scene.maskJson);
    if (!base) return null;
    const points = scene.keyframesJson ? parseTimelineKeyframes(scene.keyframesJson) : [];
    const animated = points.some((point) => Object.keys(point).some((key) => key.startsWith("mask_")));
    const spec = animated ? maskSpecAt(base, points, Math.max(0, t)) : base;
    const rect = objectFitRect(scene.fitMode ?? "contain", natural, frame);
    const side = animated ? ANIMATED_SIDE : STATIC_SIDE;
    const aspect = rect.w > 0 && rect.h > 0 ? rect.w / rect.h : 1;
    const image = aspect >= 1
        ? { w: Math.max(1, Math.min(side, Math.round(rect.w))), h: Math.max(1, Math.round(Math.min(side, Math.round(rect.w)) / aspect)) }
        : { w: Math.max(1, Math.round(Math.min(side, Math.round(rect.h)) * aspect)), h: Math.max(1, Math.min(side, Math.round(rect.h))) };
    const r = (x: number) => Math.round(x * 1000) / 1000;
    const key = `${JSON.stringify(spec)}|${image.w}x${image.h}|${r(rect.x)},${r(rect.y)},${r(rect.w)},${r(rect.h)}`;
    return { key, spec, rect, image };
}

/** The mask levels as a PNG data URL (white, alpha = level), or null without a 2D canvas. */
export function renderMaskDataUrl(layer: SceneMaskLayer): string | null {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = layer.image.w;
    canvas.height = layer.image.h;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
        ctx = canvas.getContext("2d");
    } catch {
        ctx = null;
    }
    if (!ctx || typeof ctx.createImageData !== "function") return null;
    const levels = maskImage(layer.spec, layer.image.w, layer.image.h);
    const data = ctx.createImageData(layer.image.w, layer.image.h);
    for (let i = 0; i < levels.length; i += 1) {
        data.data[i * 4] = 255;
        data.data[i * 4 + 1] = 255;
        data.data[i * 4 + 2] = 255;
        data.data[i * 4 + 3] = levels[i];
    }
    ctx.putImageData(data, 0, 0);
    try {
        return canvas.toDataURL("image/png");
    } catch {
        return null;
    }
}

const applied = new WeakMap<HTMLElement, string>();
const MASK_PROPERTIES = ["mask-image", "-webkit-mask-image", "mask-size", "-webkit-mask-size", "mask-position", "-webkit-mask-position", "mask-repeat", "-webkit-mask-repeat"];

/** Sets (or clears, for null) the element's CSS mask; the image is rendered once per distinct layer. */
export function applySceneMask(el: HTMLElement, layer: SceneMaskLayer | null, render: (layer: SceneMaskLayer) => string | null = renderMaskDataUrl): void {
    if (!layer) {
        if (!applied.has(el)) return;
        applied.delete(el);
        for (const property of MASK_PROPERTIES) el.style.removeProperty(property);
        return;
    }
    if (applied.get(el) === layer.key) return;
    const url = render(layer);
    if (!url) return;
    applied.set(el, layer.key);
    const set = (name: string, value: string) => {
        el.style.setProperty(name, value);
        el.style.setProperty(`-webkit-${name}`, value);
    };
    set("mask-image", `url("${url}")`);
    set("mask-size", `${layer.rect.w}px ${layer.rect.h}px`);
    set("mask-position", `${layer.rect.x}px ${layer.rect.y}px`);
    set("mask-repeat", "no-repeat");
}
