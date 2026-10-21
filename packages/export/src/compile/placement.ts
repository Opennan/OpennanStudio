// Where an overlay lands. Positions are fractions of the space left over by the box
// (x = posX * (W - boxW)), as in the preview (preview-panel.tsx:1146-1149, 1202-1205, 1266-1267)
// and the reference assembler's overlay=(W-w)*posX. Rotation turns about the box center.
import { fmt } from "../format";

export interface Size {
    width: number;
    height: number;
}

export interface StaticPlacement {
    /** Top-left of the bitmap handed to overlay. */
    x: number;
    y: number;
    /** Square canvas side when rotated (the rotate filter's ow/oh), else null. */
    rotatedSide: number | null;
}

/** Side of a square that holds a w×h box at any rotation, rounded up to even. */
export function rotatedSide(width: number, height: number): number {
    return Math.ceil(Math.hypot(width, height) / 2) * 2;
}

/**
 * Static placement. `box` is the anchored layout box; `outer` the bitmap around it (box plus
 * symmetric padding for text); both already scaled.
 */
export function staticPlacement(frame: Size, box: Size, outer: Size, posX: number, posY: number, rotationDegrees: number): StaticPlacement {
    const centerX = posX * Math.max(0, frame.width - box.width) + box.width / 2;
    const centerY = posY * Math.max(0, frame.height - box.height) + box.height / 2;
    const rotated = Math.abs(rotationDegrees % 360) > 0.001;
    const side = rotated ? rotatedSide(outer.width, outer.height) : null;
    const width = side ?? outer.width;
    const height = side ?? outer.height;
    return { x: Math.round(centerX - width / 2), y: Math.round(centerY - height / 2), rotatedSide: side };
}

export interface AnimatedPlacementInput {
    frame: Size;
    /** Bitmap and layout box at the reference scale (S = 1). */
    outer: Size;
    box: Size;
    margin: number;
    /** Expressions over the overlay's time variable: scale factor (<= 1), anchors, centre offsets in frame fractions. */
    scale: string;
    posX: string;
    posY: string;
    dx?: string;
    dy?: string;
    /** Largest |scaleX| any frame reaches (the bitmap's width is scaled by it). Default 1. */
    scaleXPeak?: number;
    /** Whether any frame rotates (keyframed, animated, or static rotation). */
    rotated: boolean;
    /**
     * The scaled bitmap's per-frame size and rotation (radians) over the overlay's time variable: `pad` puts the
     * bitmap at floor((PW − w) / 2), half a pixel left of the centre when PW − w is odd, and `rotate` turns that
     * offset with the bitmap; the position compensates it. Without it the offset is ignored.
     */
    layer?: { width: string; height: string; radians?: string };
}

export interface AnimatedPlacement {
    /** Fixed layer size after `pad` (bitmap centred). */
    pad: Size;
    /** Side of the square `rotate` outputs, or null when nothing rotates. */
    side: number | null;
    /**
     * overlay x/y expressions: the transformed bitmap's centre on the anchored box centre (transform model:
     * centre = posX·max(0, W − boxW·s) + boxW·s/2 + dx·W), rounded to the nearest even pixel. overlay itself
     * truncates x/y toward zero and then clears the low bit on a 4:2:0 main (chroma alignment); handing it
     * an even integer keeps the centre within one pixel of the model.
     */
    x: string;
    y: string;
}

const evenCeil = (value: number) => Math.ceil(value / 2) * 2;

/**
 * A filter's time variable snapped to the frame grid: floor(t·fps + ½) / fps is exactly the preview's n / fps in
 * double. Filters compute t as pts × (1 / fps), which can land one ulp below a keyframe time, and a hold easing
 * (or any step) at that keyframe would then switch a frame late.
 */
export const frameClock = (variable: string, fps: number) => `(floor(${variable}*${fps}+0.5)/${fps})`;

/** Nearest even integer of an expression (ties up), exact in overlay's truncating, chroma-aligned x/y. */
export const nearestEven = (expression: string) => `2*floor((${expression})/2+0.5)`;

/** LGPL replacement for the old perspective corners: per-frame scale about the centre, rotation, anchoring. */
export function animatedPlacement(input: AnimatedPlacementInput): AnimatedPlacement {
    const { frame, outer, box, margin } = input;
    const pad = { width: evenCeil(Math.ceil(outer.width * (input.scaleXPeak ?? 1)) + margin * 2), height: evenCeil(outer.height + margin * 2) };
    const side = input.rotated ? evenCeil(Math.hypot(pad.width, pad.height)) : null;
    const s = `(${input.scale})`;
    const boxW = `(${fmt(box.width)}*${s})`;
    const boxH = `(${fmt(box.height)}*${s})`;
    const offset = (expression: string | undefined, size: number) => (expression && expression !== "0" ? `+(${expression})*${size}` : "");
    const cx = `((${input.posX})*max(0,${frame.width}-${boxW})+${boxW}/2${offset(input.dx, frame.width)})`;
    const cy = `((${input.posY})*max(0,${frame.height}-${boxH})+${boxH}/2${offset(input.dy, frame.height)})`;
    const shift = input.layer ? padShift(pad, input.layer) : null;
    const x = shift ? `${cx}-${(side ?? pad.width) / 2}-${shift.x}` : `${cx}-${(side ?? pad.width) / 2}`;
    const y = shift ? `${cy}-${(side ?? pad.height) / 2}-${shift.y}` : `${cy}-${(side ?? pad.height) / 2}`;
    return { pad, side, x: nearestEven(x), y: nearestEven(y) };
}

/**
 * Where `pad` (x = (ow − iw) / 2, truncated) leaves the bitmap's centre relative to the pad's centre: −½ px on
 * an axis where pad − bitmap is odd, turned clockwise by `rotate` when the layer rotates. Expressions.
 */
export function padShift(pad: Size, layer: { width: string; height: string; radians?: string }): { x: string; y: string } {
    const dx = `(-mod(${pad.width}-(${layer.width}),2)/2)`;
    const dy = `(-mod(${pad.height}-(${layer.height}),2)/2)`;
    if (!layer.radians) return { x: dx, y: dy };
    const a = `(${layer.radians})`;
    return { x: `(${dx}*cos(${a})-${dy}*sin(${a}))`, y: `(${dx}*sin(${a})+${dy}*cos(${a}))` };
}

/** Fit of a scene's media inside the frame plus the user transform (scene-preview.tsx:671-688). */
export function sceneFit(
    fitMode: string | null | undefined,
    source: Size,
    frame: Size,
    transformScale: number,
    offsetXPercent: number,
    offsetYPercent: number,
): { width: number; height: number; x: number; y: number } {
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    const sw = Math.max(1, source.width);
    const sh = Math.max(1, source.height);
    let width: number;
    let height: number;
    if (fitMode === "fill") {
        width = frame.width * transformScale;
        height = frame.height * transformScale;
    } else {
        const base = fitMode === "cover" ? Math.max(frame.width / sw, frame.height / sh) : Math.min(frame.width / sw, frame.height / sh);
        width = sw * base * transformScale;
        height = sh * base * transformScale;
    }
    const w = even(width);
    const h = even(height);
    return {
        width: w,
        height: h,
        x: Math.round((frame.width - w) / 2 + (offsetXPercent / 100) * frame.width),
        y: Math.round((frame.height - h) / 2 + (offsetYPercent / 100) * frame.height),
    };
}
