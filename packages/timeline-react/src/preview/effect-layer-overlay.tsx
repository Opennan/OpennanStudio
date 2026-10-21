"use client";
// src/components/editor/effects/effect-layer-overlay.tsx
// Renders active EFFECT LAYERS over the live preview during playback.
// Each frame: find effect-track clips whose [start,end] contains the playhead,
// sample the currently-playing video, and run those effects' shaders onto an
// overlay canvas that sits above the video. Fallback only (phase 11): effects
// apply over graphics and text too, which PreviewPanel's compositor does; this
// footage-only pass runs while the compositor cannot (its GL failed).

import { useEffect, useMemo, useRef } from "react";
import { EffectRenderer } from "@opennan/timeline-media/effects/effect-renderer";
import { useEffectCatalog } from "../hooks/use-effect-catalog";
import { useDocumentVisible } from "../hooks/use-document-visible";
import { useEditorStoreApi } from "../hooks/use-editor-store";
import { prepareEffectLayers, isEffectTrackVisible, type PreparedEffectLayer } from "@opennan/timeline-media/effects/effect-layer-prep";
import type { TimelineClip, TimelineTrack } from "@opennan/timeline-core/model/timeline";

interface Props {
    getActiveVideo: () => HTMLVideoElement | null;
    clips: TimelineClip[];
    tracks?: TimelineTrack[];
}

export function EffectLayerOverlay({ getActiveVideo, clips, tracks }: Props) {
    const storeApi = useEditorStoreApi();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<EffectRenderer | null>(null);
    const rafRef = useRef<number | null>(null);
    const docVisible = useDocumentVisible();
    const currentTimeRef = useRef(storeApi.getState().currentTime);
    const isPlayingRef = useRef(storeApi.getState().isPlaying);
    const requestDrawRef = useRef<() => void>(() => {});
    // Avoid forced layout (getBoundingClientRect) + style writes every frame.
    // The overlay only needs repositioning when the preview resizes, the active
    // video element changes, or its intrinsic dimensions (letterbox) change.
    const needsRepositionRef = useRef(true);
    const lastVideoRef = useRef<HTMLVideoElement | null>(null);
    const lastVideoDimsRef = useRef<string>("");
    const hasEnabledEffectClips = useMemo(
        () => clips.some(
            (c) =>
                c.trackType === "effect" &&
                isEffectTrackVisible(c.trackIndex, tracks) &&
                c.effects?.some((e) => e.enabled)
        ),
        [clips, tracks]
    );
    const { items } = useEffectCatalog("effect", { enabled: hasEnabledEffectClips });
    const defsById = useMemo(() => new Map(items.map((d) => [d.id, d])), [items]);
    const visibleEffectLayers = useMemo<PreparedEffectLayer[]>(
        () => prepareEffectLayers(clips, defsById, tracks),
        [clips, defsById, tracks],
    );
    const hasRenderableEffectLayers = visibleEffectLayers.length > 0;
    const visibleEffectLayersRef = useRef(visibleEffectLayers);
    useEffect(() => {
        visibleEffectLayersRef.current = visibleEffectLayers;
        requestDrawRef.current();
    }, [visibleEffectLayers]);

    useEffect(() => {
        if (!docVisible || !hasRenderableEffectLayers) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        let renderer: EffectRenderer;
        try {
            renderer = new EffectRenderer(canvas);
        } catch {
            return;
        }
        rendererRef.current = renderer;
        let running = true;
        let scheduled = false;
        let videoFrameRequest: { video: HTMLVideoElement; id: number } | null = null;

        const cancelVideoFrameRequest = () => {
            if (!videoFrameRequest) return;
            videoFrameRequest.video.cancelVideoFrameCallback?.(videoFrameRequest.id);
            videoFrameRequest = null;
        };

        const draw = () => {
            if (!running) return;
            scheduled = false;
            rafRef.current = null;
            const time = currentTimeRef.current;

            // Active effect layers at the playhead, ordered by track then start.
            const active = visibleEffectLayersRef.current.filter((layer) => time >= layer.startTime && time < layer.endTime);
            const renderEffects = active.flatMap((layer) => layer.renderEffects);

            // The scene resolver only hands back an element that is drawable
            // RIGHT NOW. Mid-scrub the sampled video is `seeking` (readyState
            // can dip below HAVE_CURRENT_DATA), so it briefly resolves to null —
            // the old code treated that as "no effect here", cleared the canvas,
            // and nothing rescheduled a draw. The effect flashed once and never
            // came back. Fall back to the element we last drew from and treat
            // the gap as PENDING, not absent.
            const resolved = getActiveVideo();
            const fallback = lastVideoRef.current;
            const video = resolved
                ?? (fallback && fallback.isConnected && fallback.readyState >= 1 && fallback.videoWidth > 0 ? fallback : null);
            // Mid-seek the element still presents the PREVIOUS frame — drawing
            // now would freeze that stale image onto the canvas. Skip and
            // re-render once the seek lands (or the frame arrives).
            const settled = isPlayingRef.current || !video?.seeking;
            const ready = !!video && video.readyState >= 2 && video.videoWidth > 0;
            if (video && renderEffects.length > 0 && !(ready && settled)) {
                // Pending: keep whatever is on screen and redraw when the
                // element settles. Clearing here is what produced the flash.
                for (const event of ["seeked", "canplay", "loadeddata"]) {
                    video.addEventListener(event, () => scheduleDraw(), { once: true });
                }
                return;
            }
            if (ready && renderEffects.length > 0 && settled) {
                // Position the canvas to exactly overlap the on-screen video rect
                // (the video is letterbox-centered in the preview; match it).
                // Reading getBoundingClientRect forces a synchronous layout, so we
                // only do it when something that affects the rect has changed.
                // While paused/scrubbing draws are rare, so we reposition freely.
                const dims = `${video!.videoWidth}x${video!.videoHeight}`;
                if (video !== lastVideoRef.current || dims !== lastVideoDimsRef.current) {
                    lastVideoRef.current = video!;
                    lastVideoDimsRef.current = dims;
                    needsRepositionRef.current = true;
                }
                if (needsRepositionRef.current || !isPlayingRef.current) {
                    const parent = canvas.parentElement;
                    if (parent) {
                        const vr = video!.getBoundingClientRect();
                        const pr = parent.getBoundingClientRect();
                        canvas.style.left = `${vr.left - pr.left}px`;
                        canvas.style.top = `${vr.top - pr.top}px`;
                        canvas.style.width = `${vr.width}px`;
                        canvas.style.height = `${vr.height}px`;
                    }
                    needsRepositionRef.current = false;
                }
                canvas.style.opacity = "1";
                try {
                    // Timeline seconds, as the export's GL passes use: preview and export animate alike.
                    renderer.render(video!, renderEffects, time);
                } catch {
                    canvas.style.opacity = "0";
                }
            } else {
                canvas.style.opacity = "0";
            }
            if (isPlayingRef.current) scheduleNextVideoFrame(video);
        };

        const scheduleDraw = () => {
            if (!running || scheduled) return;
            scheduled = true;
            rafRef.current = requestAnimationFrame(draw);
        };

        // Rendering a video texture from an ordinary RAF can repeatedly upload
        // the same presented frame while the media decoder advances underneath
        // it. Because the effect canvas is opaque, that looks like a frozen
        // one-frame video. Follow decoded video frames when the browser exposes
        // requestVideoFrameCallback, with RAF as the compatibility fallback.
        const scheduleNextVideoFrame = (video: HTMLVideoElement | null) => {
            if (!running) return;
            if (!video || typeof video.requestVideoFrameCallback !== "function") {
                scheduleDraw();
                return;
            }
            if (videoFrameRequest?.video === video) return;
            cancelVideoFrameRequest();
            const id = video.requestVideoFrameCallback(() => {
                videoFrameRequest = null;
                scheduleDraw();
            });
            videoFrameRequest = { video, id };
        };

        requestDrawRef.current = scheduleDraw;
        // Recompute the overlay rect when the preview area resizes instead of
        // reading layout every animation frame.
        let resizeObserver: ResizeObserver | null = null;
        const parentEl = canvas.parentElement;
        if (parentEl && typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => {
                needsRepositionRef.current = true;
                scheduleDraw();
            });
            resizeObserver.observe(parentEl);
        }
        const unsubscribeTime = storeApi.subscribe((state) => state.currentTime, (currentTime) => {
            const timeChanged = currentTimeRef.current !== currentTime;
            currentTimeRef.current = currentTime;
            if (timeChanged) scheduleDraw();
        });
        const unsubscribePlaying = storeApi.subscribe((state) => state.isPlaying, (isPlaying) => {
            const playingChanged = isPlayingRef.current !== isPlaying;
            isPlayingRef.current = isPlaying;
            if (!isPlaying) cancelVideoFrameRequest();
            if (playingChanged) scheduleDraw();
        });
        scheduleDraw();

        return () => {
            running = false;
            requestDrawRef.current = () => {};
            resizeObserver?.disconnect();
            unsubscribeTime();
            unsubscribePlaying();
            cancelVideoFrameRequest();
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
            renderer.destroy();
            rendererRef.current = null;
        };
    }, [getActiveVideo, docVisible, hasRenderableEffectLayers, storeApi]);

    if (!hasEnabledEffectClips) return null;

    return (
        <canvas
            ref={canvasRef}
            className="absolute"
            // Sits inside ScenePreview's compositing stack: z-index 3 is above the
            // footage/media wrapper (z1) but below the Remotion graphics overlay
            // (z11) and transition dip (z12), so an active effect never occludes a
            // graphic. Only opaque when an effect is actually active.
            style={{ left: 0, top: 0, zIndex: 3, opacity: 0, pointerEvents: "none" }}
        />
    );
}
