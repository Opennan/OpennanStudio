"use client";
// Library card thumbnails rendered by the preview's own looks renderer: what a card shows is what the
// timeline will show. Static until hovered (or focused), then animated; static only under
// prefers-reduced-motion. Sample frames are drawn procedurally (no bundled images).
import { useEffect, useRef } from "react";
import type { LookRenderer } from "@opennan/timeline-media/looks/look-renderer";
import { useLookRenderer } from "../../preview/use-look-renderer";

export const THUMB_W = 192;
export const THUMB_H = 108;

let samples: [HTMLCanvasElement, HTMLCanvasElement] | null = null;

/** Two 192×108 sample frames: a warm landscape at dusk and a cool city at night. */
export function sampleFrames(): [HTMLCanvasElement, HTMLCanvasElement] {
    if (samples) return samples;
    const make = (paint: (ctx: CanvasRenderingContext2D) => void) => {
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_W;
        canvas.height = THUMB_H;
        const ctx = canvas.getContext("2d");
        if (ctx) paint(ctx);
        return canvas;
    };
    // Sample artwork colors: picture content, not UI chrome (the theme rule covers CSS).
    const dusk = make((ctx) => {
        const sky = ctx.createLinearGradient(0, 0, 0, THUMB_H);
        sky.addColorStop(0, "#2b3a67");
        sky.addColorStop(0.55, "#e9826a");
        sky.addColorStop(1, "#f6c27a");
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, THUMB_W, THUMB_H);
        ctx.fillStyle = "#ffe3a3";
        ctx.beginPath();
        ctx.arc(130, 62, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3b2f4a";
        ctx.beginPath();
        ctx.moveTo(0, 80);
        ctx.lineTo(40, 58);
        ctx.lineTo(78, 76);
        ctx.lineTo(118, 52);
        ctx.lineTo(160, 74);
        ctx.lineTo(192, 60);
        ctx.lineTo(192, 108);
        ctx.lineTo(0, 108);
        ctx.fill();
        ctx.fillStyle = "#1f2433";
        ctx.fillRect(0, 92, THUMB_W, 16);
    });
    const night = make((ctx) => {
        const sky = ctx.createLinearGradient(0, 0, 0, THUMB_H);
        sky.addColorStop(0, "#0b1530");
        sky.addColorStop(1, "#1d3b5c");
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, THUMB_W, THUMB_H);
        const widths = [18, 26, 14, 30, 20, 24, 16, 28];
        let x = 0;
        widths.forEach((w, i) => {
            const h = 40 + ((i * 37) % 45);
            ctx.fillStyle = i % 2 ? "#14243d" : "#1a2f4d";
            ctx.fillRect(x, THUMB_H - h, w, h);
            ctx.fillStyle = "#ffd36e";
            for (let wy = THUMB_H - h + 6; wy < THUMB_H - 6; wy += 9) {
                for (let wx = x + 4; wx < x + w - 4; wx += 7) if ((wx * 7 + wy * 3 + i) % 5 < 2) ctx.fillRect(wx, wy, 3, 4);
            }
            x += w;
        });
        ctx.fillStyle = "#7fd3ff";
        ctx.fillRect(0, THUMB_H - 3, THUMB_W, 3);
    });
    samples = [dusk, night];
    return samples;
}

export type ThumbPainter = (renderer: LookRenderer, t: number) => HTMLCanvasElement | OffscreenCanvas | null;

function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A card thumbnail canvas. `paint` draws into the renderer and returns the canvas to copy. */
export function LookThumb({ paint, active, staticTime = 0.5, version }: { paint: ThumbPainter; active: boolean; staticTime?: number; version?: string | number }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const renderer = useLookRenderer(true);
    const paintRef = useRef(paint);
    paintRef.current = paint;
    const visibleRef = useRef(false);

    useEffect(() => {
        const canvas = ref.current;
        if (!renderer || !canvas) return;
        const draw = (t: number) => {
            try {
                const source = paintRef.current(renderer, t);
                renderer.releaseAll();
                if (!source) return;
                const ctx = canvas.getContext("2d");
                ctx?.clearRect(0, 0, canvas.width, canvas.height);
                ctx?.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
            } catch {
                renderer.releaseAll();
            }
        };
        let frame: number | null = null;
        const animate = active && !prefersReducedMotion();
        if (animate) {
            const start = performance.now();
            let last = 0;
            const tick = (now: number) => {
                if (now - last >= 33) {
                    last = now;
                    draw((now - start) / 1000);
                }
                frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
        } else if (visibleRef.current || typeof IntersectionObserver === "undefined") {
            draw(staticTime);
        }
        let observer: IntersectionObserver | null = null;
        if (!animate && typeof IntersectionObserver !== "undefined") {
            observer = new IntersectionObserver((entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    visibleRef.current = true;
                    draw(staticTime);
                    observer?.disconnect();
                }
            });
            observer.observe(canvas);
        }
        return () => {
            if (frame !== null) cancelAnimationFrame(frame);
            observer?.disconnect();
        };
    }, [renderer, active, staticTime, version]);

    return <canvas ref={ref} width={THUMB_W} height={THUMB_H} aria-hidden="true" />;
}
