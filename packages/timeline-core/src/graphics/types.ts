// Types of the built-in graphics renderer (phase 10d). Graphics clips (trackType "remotion") are full-frame,
// transparent compositions drawn with Canvas 2D by one draw function per template, in composition units (the
// long side is GRAPHICS_COMPOSITION_LONG_SIDE px, like OpenNan's player), on a GRAPHICS_FPS frame grid. The same
// code draws the preview, the GPU export, and the ffmpeg export's image sequence, so all three agree.

export interface GraphicsTemplateParam {
    key: string;
    label: string;
    type: "text" | "color" | "number" | "select" | "json";
    default: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
}

export interface GraphicsTemplateDef {
    id: string;
    name: string;
    category: string;
    description: string;
    params: GraphicsTemplateParam[];
}

/**
 * The Canvas 2D surface a template draws on: the browser's CanvasRenderingContext2D, an OffscreenCanvas context,
 * or @napi-rs/canvas in Node tests. Only these members may be used by draw functions.
 */
export type GraphicsContext = Pick<
    CanvasRenderingContext2D,
    | "save" | "restore" | "translate" | "scale" | "rotate" | "transform" | "setTransform" | "resetTransform"
    | "beginPath" | "closePath" | "moveTo" | "lineTo" | "arc" | "arcTo" | "ellipse" | "rect" | "quadraticCurveTo" | "bezierCurveTo"
    | "fill" | "stroke" | "clip" | "fillRect" | "strokeRect" | "clearRect" | "fillText" | "strokeText" | "measureText"
    | "createLinearGradient" | "createRadialGradient" | "drawImage"
    | "fillStyle" | "strokeStyle" | "lineWidth" | "lineCap" | "lineJoin" | "globalAlpha" | "globalCompositeOperation"
    | "font" | "textAlign" | "textBaseline" | "shadowColor" | "shadowBlur" | "shadowOffsetX" | "shadowOffsetY"
> & {
    /** Rounded rectangles (all current canvases have it; draw code falls back to arcs when absent). */
    roundRect?: CanvasRenderingContext2D["roundRect"];
    setLineDash?: CanvasRenderingContext2D["setLineDash"];
};

/** Images a template needs (logo-sting's logo), decoded ahead of drawing by the host; null when unavailable. */
export interface GraphicsAssets {
    image(url: string): CanvasImageSource | null;
}

/** One frame of one template, in composition units. */
export interface GraphicsFrame {
    /** Composition size (long side GRAPHICS_COMPOSITION_LONG_SIDE). */
    width: number;
    height: number;
    /** Template frame, 0-based, on the GRAPHICS_FPS grid. */
    frame: number;
    /** Length of the clip in template frames (at least 1). */
    durationInFrames: number;
    fps: number;
    /** Template parameters (defaults merged with the clip's props, coerced to the declared types). */
    props: Record<string, unknown>;
    assets?: GraphicsAssets | null;
}

/** Painted area in composition units (selection handles frame it). */
export interface GraphicsBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Draws one template frame onto `ctx` in composition units (the caller already scaled the context) and returns
 * the painted bounds, or null when nothing is painted this frame.
 */
export type GraphicsDraw = (ctx: GraphicsContext, frame: GraphicsFrame) => GraphicsBounds | null;
