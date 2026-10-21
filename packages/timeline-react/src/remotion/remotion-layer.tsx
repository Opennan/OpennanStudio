"use client";
import { GraphicsOverlay } from "./graphics-overlay";
import { getRemotionAddon, type RemotionOverlayProps } from "./registry";

export type { RemotionTransformOverride } from "./registry";

// The layer transform follows the shared motion model (phase 10c, remotion-transform.ts).
export { getRemotionLayerStyle, getRemotionLayerTransform, remotionLayerPlacement } from "./remotion-transform";

/** Renders the registered add-on's overlay, else the built-in graphics renderer (phase 10d). */
export function RemotionTimelineOverlay(props: RemotionOverlayProps) {
    const Overlay = getRemotionAddon()?.TimelineOverlay ?? GraphicsOverlay;
    return <Overlay {...props} />;
}
