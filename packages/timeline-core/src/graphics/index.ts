// Built-in graphics (phase 10d): templates, renderer, layer placement.
export * from "./types";
export { GRAPHICS_FPS, GRAPHICS_TEMPLATES } from "./templates";
export { clampedInterpolate, exitWindow, interpolate, spring, type InterpolateOptions, type SpringConfig, type SpringInput } from "./spring";
export {
    GRAPHICS_COMPOSITION_LONG_SIDE, drawGraphicsFrame, graphicsAssetUrls, graphicsCompositionSize, graphicsDurationInFrames, graphicsFrameAt, graphicsProps,
    graphicsTemplateById, graphicsUnsupportedReason, isBuiltinGraphics, type DrawGraphicsOptions,
} from "./render";
export { graphicsLayerAt, graphicsLayerHidden, graphicsLayerMatrix, graphicsOutputFrames, type GraphicsLayerPlacement } from "./layer";
export { GRAPHICS_FONT_FACES, GRAPHICS_FONT_FAMILY, graphicsFont } from "./draw/helpers";
