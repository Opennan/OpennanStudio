"use client";
// Built-in graphics in the preview (phase 10d): without a Remotion add-on, every built-in graphics clip draws with
// the shared Canvas 2D renderer (timeline-core graphics) on a full-frame canvas layer that takes the clip's layer
// style (shared motion model, live drag). The same draw code renders both exports, frame for frame: the template
// frame is graphicsFrameAt(clip, playhead − start). A hidden child spans the painted bounds so the editor frames
// the selection box to what the graphic paints (remotion-content-bounds.ts).
import { useEffect, useRef } from "react";
import { drawGraphicsFrame, graphicsAssetUrls, graphicsFrameAt, isBuiltinGraphics } from "@opennan/timeline-core/graphics/render";
import type { GraphicsContext } from "@opennan/timeline-core/graphics/types";
import type { TimelineClip } from "@opennan/timeline-core/model/timeline";
import { useEditorStoreApi } from "../hooks/use-editor-store";
import { useTimelineMedia } from "../hooks/use-timeline-media";
import { graphicsAssetImage, loadGraphicsFonts } from "./graphics-assets";
import type { RemotionOverlayProps, RemotionTransformOverride } from "./registry";
import { getRemotionLayerStyle } from "./remotion-transform";

interface LayerProps {
    clip: TimelineClip;
    layerStyle?: RemotionOverlayProps["layerStyle"];
    transformOverride?: RemotionTransformOverride | null;
}

function GraphicsClipLayer({ clip, layerStyle, transformOverride }: LayerProps) {
    const storeApi = useEditorStoreApi();
    const media = useTimelineMedia();
    const layerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    // Latest props for the imperative draw (playhead ticks never re-render React).
    const latest = useRef({ clip, layerStyle, transformOverride });
    latest.current = { clip, layerStyle, transformOverride };

    useEffect(() => {
        const layer = layerRef.current;
        const canvas = canvasRef.current;
        const content = contentRef.current;
        if (!layer || !canvas || !content) return;
        let lastKey = "";
        const draw = (time: number, force = false) => {
            const { clip: current, layerStyle: style, transformOverride: override } = latest.current;
            const visible = time >= current.startTime && time < current.endTime;
            layer.style.visibility = visible ? "visible" : "hidden";
            if (!visible) return;
            const local = time - current.startTime;
            const placed = style ? style(current, time) : getRemotionLayerStyle(current, local, override);
            layer.style.transform = placed.transform;
            layer.style.transformOrigin = placed.transformOrigin;
            layer.style.opacity = String(placed.opacity);
            const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
            const width = Math.max(1, Math.round(layer.clientWidth * dpr));
            const height = Math.max(1, Math.round(layer.clientHeight * dpr));
            const frame = graphicsFrameAt(current, local);
            const key = `${frame}|${width}x${height}|${current.remotionTemplateId}|${current.remotionPropsJson}|${current.endTime - current.startTime}`;
            if (!force && key === lastKey) return;
            lastKey = key;
            if (canvas.width !== width) canvas.width = width;
            if (canvas.height !== height) canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, width, height);
            const redraw = () => draw(storeApi.getState().currentTime, true);
            const bounds = drawGraphicsFrame(ctx as unknown as GraphicsContext, current, {
                // The host's mapping of a media URL (the export reads the same file through the media environment).
                width, height, frame, assets: { image: (url) => (graphicsAssetUrls(current).includes(url) ? graphicsAssetImage(media.resolveMediaUrl(url), current.id, redraw) : null) },
            });
            if (bounds) {
                content.style.display = "block";
                content.style.left = `${(bounds.x / width) * 100}%`;
                content.style.top = `${(bounds.y / height) * 100}%`;
                content.style.width = `${(bounds.width / width) * 100}%`;
                content.style.height = `${(bounds.height / height) * 100}%`;
            } else {
                content.style.display = "none";
            }
        };
        draw(storeApi.getState().currentTime, true);
        const unsubscribe = storeApi.subscribe((s) => s.currentTime, (time) => draw(time));
        const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => draw(storeApi.getState().currentTime)) : null;
        resize?.observe(layer);
        let alive = true;
        void loadGraphicsFonts().then(() => {
            if (alive) draw(storeApi.getState().currentTime, true);
        });
        return () => {
            alive = false;
            unsubscribe();
            resize?.disconnect();
        };
        // Redraw on every clip, style, or drag change.
    }, [storeApi, media, clip, layerStyle, transformOverride]);

    return (
        <div
            ref={layerRef}
            data-remotion-clip-id={clip.id}
            data-graphics-clip
            className="absolute inset-0"
            style={{ visibility: "hidden" }}
        >
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            <div ref={contentRef} data-graphics-content aria-hidden="true" className="absolute" style={{ display: "none" }} />
        </div>
    );
}

/** The preview overlay for built-in graphics clips (the default when no Remotion add-on is registered). */
export function GraphicsOverlay({ clips, layerStyle, transformOverride }: RemotionOverlayProps) {
    return (
        <>
            {clips.filter((clip) => isBuiltinGraphics(clip)).map((clip) => (
                <GraphicsClipLayer key={clip.id} clip={clip} layerStyle={layerStyle} transformOverride={transformOverride} />
            ))}
        </>
    );
}
