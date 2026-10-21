"use client";
// The main track (V1) through the looks renderer: scene filters, adjustments, and effects, centered
// transition windows (real media past the cut through a hidden decoder where the media continues — live
// handles, looks/handles.ts — held first/last frames otherwise), and (when the compositor is not running a full
// composite pass) built-in effect-track spans; while it runs the effects, the plain lane frame under them is
// presented as the composite's footage. Draws only when something applies; otherwise the
// editor's <video> elements show directly and this canvas is transparent. Mirrors the export's
// compile/lanes.ts: fit → look → frame → transition → spans. Phase 10b: Adjust keyframes cross-fade two
// CLUTs (LookRenderer.lutMix) before the rest of the look, and a scene with motion (animation, keyframed
// transform, rotation, opacity) is placed through LookRenderer.placeAffine at its own local time, on each
// side of a transition window before the transition pass.
import { useEffect, useMemo, useRef } from "react";
import type { TimelineClip } from "@opennan/timeline-core";
import { isBuiltinEffect } from "@opennan/timeline-core/looks/effects";
import { sceneFitRect } from "@opennan/timeline-core/looks/fit";
import { itemLook, type LookPlan } from "@opennan/timeline-core/looks/look-plan";
import { transitionById } from "@opennan/timeline-core/looks/transitions";
import { FrameSnapshots } from "@opennan/timeline-media/looks/frame-snapshots";
import type { GlFrame, LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { useEditorStoreApi } from "../hooks/use-editor-store";
import { useTimelineMedia } from "../hooks/use-timeline-media";
import { laneLookFrame, laneSceneSource, type LaneLook, type LaneRange, type LaneSide } from "./lane-look-plan";
import { invertAffine, isIdentitySceneMotion, sceneMediaMatrix, sceneMotionAt } from "./scene-motion";
import { useLookRenderer } from "./use-look-renderer";

interface Props {
    ranges: LaneRange[];
    /** The editor's element for a scene when it shows that scene's current frame. */
    getSceneVideo(sceneId: string): HTMLVideoElement | null;
    screenFrame: { w: number; h: number } | null;
    /** Effect-track clips (built-in effects only) to run here; empty when the compositor runs them. */
    effectSpans: TimelineClip[];
    /**
     * Effect-track clips the compositor runs (phase 11): while one is at the playhead the lane frame is presented
     * even with no look, as the footage the compositor's effect pass composites.
     */
    footageSpans?: TimelineClip[];
    /** Receives the overlay canvas while it shows a frame (the compositor composites it), else null. */
    onLaneCanvas?(canvas: HTMLCanvasElement | null): void;
}

const MAX_PROCESS_WIDTH = 1920;
/** While playing, a decoder frame this close to the wanted time stands in for it (a window's half is ≤ 1 s). */
const LIVE_FALLBACK_SECONDS = 0.25;

export function spanPlans(clips: TimelineClip[], t: number): Array<{ plan: LookPlan; local: number }> {
    return clips
        .filter((clip) => clip.trackType === "effect" && t >= clip.startTime && t < clip.endTime)
        .sort((a, b) => a.trackIndex - b.trackIndex || a.startTime - b.startTime)
        .map((clip) => ({ plan: itemLook({ kind: "scene", effects: (clip.effects ?? []).filter((row) => isBuiltinEffect(row.effectId)) }), local: t - clip.startTime }))
        .filter((entry): entry is { plan: LookPlan; local: number } => Boolean(entry.plan));
}

const NO_SPANS: TimelineClip[] = [];

export function LaneLookOverlay({ ranges, getSceneVideo, screenFrame, effectSpans, footageSpans = NO_SPANS, onLaneCanvas }: Props) {
    const storeApi = useEditorStoreApi();
    const media = useTimelineMedia();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderer = useLookRenderer(true);
    const stateRef = useRef({ ranges, effectSpans, footageSpans, screenFrame, getSceneVideo });
    stateRef.current = { ranges, effectSpans, footageSpans, screenFrame, getSceneVideo };
    const plans = useMemo(() => new Map<string, LaneLook>(), [ranges]);
    const requestRef = useRef<() => void>(() => {});
    useEffect(() => requestRef.current(), [ranges, effectSpans, footageSpans, screenFrame]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!renderer || !canvas) return;
        let running = true;
        let frameRequest: number | null = null;
        let videoRequest: { video: HTMLVideoElement; id: number } | null = null;
        const snapshots = new FrameSnapshots({ resolveUrl: (url) => media.resolveMediaUrl(url), onReady: () => schedule() });
        // The effect re-runs on scene edits; the canvas may still show the previous run's frame.
        let showing = canvas.style.opacity === "1";
        const waiting = new WeakSet<HTMLVideoElement>();

        const hide = () => {
            if (showing) {
                canvas.style.opacity = "0";
                showing = false;
                onLaneCanvas?.(null);
            }
        };

        const sideFrame = (gl: LookRenderer, side: LaneSide, frameW: number, frameH: number): GlFrame | null => {
            const source = laneSceneSource(side.scene, side.local, side.length);
            if (!source) return null;
            let element: TexImageSource | null = null;
            let width = 0;
            let height = 0;
            // The editor's element for the scene: the stitched video, or the active shot's (shot-local time).
            const live = side.live ? stateRef.current.getSceneVideo(side.scene.id) : null;
            const playing = storeApi.getState().isPlaying;
            // Paused, the element must already show this time (the editor seeks it after the playhead moves).
            const expected = live && Number.isFinite(live.duration) && live.duration > 0 ? Math.min(source.time, live.duration - 0.05) : source.time;
            const settled = playing || (live !== null && Math.abs(live.currentTime - expected) <= 0.08);
            if (live && live.readyState >= 2 && live.videoWidth > 0 && !live.seeking && settled) {
                element = live;
                width = live.videoWidth;
                height = live.videoHeight;
            } else if (live) {
                // Mid-seek the element still shows the previous frame: keep what is on screen, redraw once it lands.
                if (!waiting.has(live)) {
                    waiting.add(live);
                    const done = new AbortController();
                    const land = () => {
                        done.abort();
                        waiting.delete(live);
                        schedule();
                    };
                    for (const event of ["seeked", "loadeddata", "canplay", "timeupdate"]) live.addEventListener(event, land, { signal: done.signal });
                }
                return null;
            } else if (side.live && playing) {
                // Playing without the editor's element (not mounted yet): keep the last frame rather than
                // decoding a hidden snapshot per frame.
                return null;
            } else if (side.decoder && source.video) {
                // A live handle frame (real media past the cut) from the hidden decoder. Paused: only the exact
                // frame (keep what is on screen until the seek lands; onReady redraws). Playing: never wait —
                // the decoder's last frame when it is near, else the held frame the export clones after the handle.
                // Media that failed (error, timeout) is never waited for: the held frame stands in, paused too.
                const frame = snapshots.live(source.url, source.time);
                const near = frame && (frame.exact || (playing && Math.abs(frame.time - source.time) <= LIVE_FALLBACK_SECONDS));
                const held = !near && (playing || snapshots.failed(source.url)) ? laneSceneSource(side.scene, side.heldLocal, side.length) : null;
                const snap = near ? frame : held ? snapshots.video(held.url, held.time) : null;
                if (!snap) return null;
                element = snap.source;
                width = snap.width;
                height = snap.height;
            } else {
                const snap = source.video ? snapshots.video(source.url, source.time) : snapshots.image(source.url);
                if (snap) {
                    element = snap.source;
                    width = snap.width;
                    height = snap.height;
                }
            }
            if (!element || width <= 0 || height <= 0) return null;
            const scene = side.scene;
            // The look runs at the static fit size (the scene's own fields), as before motion existed.
            const rect = sceneFitRect(scene.fitMode, { width, height }, { width: frameW, height: frameH }, Number(scene.transformScale ?? 1) || 1, Number(scene.transformOffsetX ?? 0), Number(scene.transformOffsetY ?? 0));
            const uploaded = gl.upload(element, width, height);
            const fitted = gl.resize(uploaded, rect.width, rect.height);
            const graded = side.mix ? gl.lutMix(fitted, side.mix.a, side.mix.b, side.mix.w) : fitted;
            const looked = gl.look(graded, side.plan, side.local);
            const motion = sceneMotionAt(scene, side.length, side.local);
            if (isIdentitySceneMotion(motion, scene)) return gl.place(looked, frameW, frameH, rect.x, rect.y, [0, 0, 0, 1]);
            // Moving: the looked texture through the scene's placement at this local time (over black: V1).
            const forward = sceneMediaMatrix(scene.fitMode, { width, height }, { width: frameW, height: frameH }, motion, { width: looked.width, height: looked.height });
            const inverse = invertAffine(forward) ?? [Number.NaN, 0, 0, 0, 0, 0];
            return gl.placeAffine(looked, frameW, frameH, inverse, motion.opacity, [0, 0, 0, 1]);
        };

        const draw = () => {
            frameRequest = null;
            if (!running) return;
            snapshots.beginDraw();
            const { ranges: currentRanges, effectSpans: spans, footageSpans: footage, screenFrame: frame } = stateRef.current;
            if (!frame || frame.w < 2 || frame.h < 2 || renderer.isLost) return hide();
            const t = storeApi.getState().currentTime;
            const lane = laneLookFrame(currentRanges, t, plans);
            const active = spanPlans(spans, t);
            const presentFootage = active.length > 0 || footage.some((clip) => t >= clip.startTime && t < clip.endTime);
            if (lane.kind === "none" && !presentFootage) return hide();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const scale = Math.min(1, MAX_PROCESS_WIDTH / (frame.w * dpr));
            const frameW = Math.max(2, Math.round(frame.w * dpr * scale));
            const frameH = Math.max(2, Math.round(frame.h * dpr * scale));
            try {
                let out: GlFrame | null = null;
                if (lane.kind === "scene") out = sideFrame(renderer, lane.side, frameW, frameH);
                if (lane.kind === "window") {
                    const a = sideFrame(renderer, lane.a, frameW, frameH);
                    const b = sideFrame(renderer, lane.b, frameW, frameH);
                    const def = transitionById(lane.transitionId);
                    out = a && b && def ? renderer.transition(a, b, def, lane.p) : null;
                }
                if (lane.kind === "none" && presentFootage) {
                    // Spans (or the compositor's effect pass) over plain footage: the live element of the scene at the playhead.
                    const range = currentRanges.find((r) => r.trackIndex === 1 && t >= r.start && t < r.end);
                    out = range ? sideFrame(renderer, { scene: range.scene, plan: null, mix: null, local: t - range.start, live: true, length: range.end - range.start, decoder: false, heldLocal: t - range.start }, frameW, frameH) : null;
                }
                if (!out) {
                    renderer.releaseAll();
                    // Keep the last drawn frame while a snapshot or the element loads (no flash of the raw cut).
                    if (!showing) hide();
                    return;
                }
                for (const span of active) out = renderer.look(out, span.plan, span.local);
                const region = renderer.presentRegion(out, frameW, frameH);
                renderer.releaseAll();
                if (canvas.width !== frameW) canvas.width = frameW;
                if (canvas.height !== frameH) canvas.height = frameH;
                const ctx = canvas.getContext("2d");
                ctx?.clearRect(0, 0, frameW, frameH);
                ctx?.drawImage(renderer.canvas as CanvasImageSource, region.x, region.y, region.width, region.height, 0, 0, frameW, frameH);
                if (!showing) {
                    canvas.style.opacity = "1";
                    showing = true;
                    onLaneCanvas?.(canvas);
                }
            } catch {
                renderer.releaseAll();
                hide();
            }
            if (storeApi.getState().isPlaying) followVideo();
        };

        const schedule = () => {
            if (!running || frameRequest !== null) return;
            frameRequest = requestAnimationFrame(draw);
        };
        requestRef.current = schedule;

        // During playback follow decoded frames when possible (requestVideoFrameCallback), else rAF.
        const followVideo = () => {
            const t = storeApi.getState().currentTime;
            const range = stateRef.current.ranges.find((r) => r.trackIndex === 1 && t >= r.start && t < r.end);
            const video = range ? stateRef.current.getSceneVideo(range.scene.id) : null;
            if (video && typeof video.requestVideoFrameCallback === "function") {
                if (videoRequest?.video === video) return;
                if (videoRequest) videoRequest.video.cancelVideoFrameCallback?.(videoRequest.id);
                videoRequest = { video, id: video.requestVideoFrameCallback(() => {
                    videoRequest = null;
                    schedule();
                }) };
            } else {
                schedule();
            }
        };

        const unsubscribeTime = storeApi.subscribe((s) => s.currentTime, () => schedule());
        const unsubscribePlaying = storeApi.subscribe((s) => s.isPlaying, () => schedule());
        schedule();
        return () => {
            running = false;
            requestRef.current = () => {};
            unsubscribeTime();
            unsubscribePlaying();
            if (frameRequest !== null) cancelAnimationFrame(frameRequest);
            if (videoRequest) videoRequest.video.cancelVideoFrameCallback?.(videoRequest.id);
            snapshots.dispose();
            onLaneCanvas?.(null);
        };
    }, [renderer, storeApi, media, plans, onLaneCanvas]);

    if (!renderer) return null;
    return (
        <canvas
            ref={canvasRef}
            data-testid="lane-look-overlay"
            className="absolute inset-0 h-full w-full"
            // Inside the frame-sized media wrapper, above the scene <video> layers (z 1-3).
            style={{ zIndex: 5, opacity: 0, pointerEvents: "none" }}
        />
    );
}
