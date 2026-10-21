// packages/timeline-core/src/design/model.ts
// Layered designs: a flat picture rebuilt as image layers and text layers that keep the original lettering.
// Plain JSON, design pixels (the source image's size). `box` is where a layer sat in the source; `transform`
// is the edit on top (offset, uniform scale and clockwise rotation in degrees, about the box centre).
// `layers` is the z-order, bottom first. Layers that share `group` move together (a tile and its label).

export const LAYER_DESIGN_VERSION = 1;

export interface DesignBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface LayerTransform {
    dx: number;
    dy: number;
    scale: number;
    /** Degrees, clockwise, about the box centre. */
    rotation: number;
}

interface LayerBase {
    id: string;
    name?: string;
    group?: string;
    box: DesignBox;
    transform: LayerTransform;
    opacity: number;
    visible: boolean;
    /** Locked layers are drawn but not picked or edited (the background). */
    locked?: boolean;
}

export interface ImageLayer extends LayerBase {
    kind: "image";
    src: string;
    role?: "background" | "element" | "shadow";
}

/** One original character, cut from the source with its outline and shadow; offsets from the text box's top-left. */
export interface GlyphCell {
    ch: string;
    src: string;
    dx: number;
    dy: number;
    w: number;
    h: number;
    /** Where the letter's ink sits inside the cell (x offset, width); spacing uses it when known. */
    ink?: { x: number; w: number };
}

export interface TextStyle {
    fill: string;
    stroke?: string;
    strokeWidth: number;
    shadow: boolean;
    /** Closest font, used only when the original lettering cannot spell the text. */
    font: string;
    weight: number;
    /** Extra letter spacing in em. */
    track: number;
}

export interface TextLayer extends LayerBase {
    kind: "text";
    text: string;
    original: {
        text: string;
        /** The whole original word, offsets from the text box's top-left. */
        word?: { src: string; dx: number; dy: number; w: number; h: number };
        glyphs?: GlyphCell[];
        /** Typical gap between letters' ink in the original word, design px. */
        gap?: number;
    };
    style: TextStyle;
    /** Texts with the same style group share glyphs (same typeface in the source). */
    styleGroup?: string;
    /** "auto": original lettering when it can spell the text; "font": always the font. */
    lettering: "auto" | "font";
}

export type DesignLayer = ImageLayer | TextLayer;

export interface LayerDesign {
    version: typeof LAYER_DESIGN_VERSION;
    width: number;
    height: number;
    /** The flat source image, for comparison. */
    source?: string;
    layers: DesignLayer[];
}

export interface LayerFrame {
    cx: number;
    cy: number;
    w: number;
    h: number;
    /** Radians, clockwise. */
    rotation: number;
}

export function layerFrame(layer: DesignLayer): LayerFrame {
    const { box, transform: t } = layer;
    return {
        cx: box.x + box.w / 2 + t.dx,
        cy: box.y + box.h / 2 + t.dy,
        w: box.w * t.scale,
        h: box.h * t.scale,
        rotation: (t.rotation * Math.PI) / 180,
    };
}

/** Axis-aligned bounds of a layer as drawn (rotation included). */
export function layerBounds(layer: DesignLayer): DesignBox {
    return framesBounds([layerFrame(layer)]);
}

export function framesBounds(frames: readonly LayerFrame[]): DesignBox {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of frames) {
        const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
            const lx = (sx * f.w) / 2, ly = (sy * f.h) / 2;
            const x = f.cx + lx * c - ly * s, y = f.cy + lx * s + ly * c;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Group ids in z order of their lowest member. */
export function groupIds(design: LayerDesign): string[] {
    const seen: string[] = [];
    for (const l of design.layers) if (l.group && !seen.includes(l.group)) seen.push(l.group);
    return seen;
}

export function groupMembers(design: LayerDesign, group: string): DesignLayer[] {
    return design.layers.filter((l) => l.group === group);
}

export const IDENTITY_TRANSFORM: LayerTransform = { dx: 0, dy: 0, scale: 1, rotation: 0 };
