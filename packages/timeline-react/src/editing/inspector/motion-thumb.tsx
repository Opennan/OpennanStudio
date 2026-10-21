"use client";
// Animation card previews (phase 10b): a small tile moved by the animation's own motion channels. The
// frame comes from the engine (itemMotion → motionAt on a synthetic item carrying just that animation), so
// the card moves exactly as the preview and the export will. Text raster animations (typewriter, wipe,
// blur, glow, letter rise / fall) are suggested with a clip-path, a blur, or a glow on the tile. Hover
// plays it; reduced motion keeps every tile still.
import { useEffect, useRef } from "react";
import type { TimelineClip } from "@opennan/timeline-core";
import { resolveAnimationWindows } from "@opennan/timeline-core/motion/animation-spec";
import type { AnimationTarget } from "@opennan/timeline-core/motion/registry";
import { itemMotion, motionAt, type ItemMotion } from "@opennan/timeline-core/motion/transform";
import type { AnimationDef, AnimationSlot, AnimationSpec } from "@opennan/timeline-core/motion/types";

/** The tile spans this fraction of the thumbnail, so frame-fraction offsets scale by 1 / TILE. */
const TILE = 0.6;
const PREVIEW_ITEM = 3;
const COMBO_ITEM = 1.6;
const LOOP_ITEM = 60;

export interface PreviewSchedule {
    duration: number;
    spec: AnimationSpec;
    /** Item-local seconds the hover preview cycles through. */
    start: number;
    end: number;
}

export function previewSchedule(def: AnimationDef, slot: AnimationSlot): PreviewSchedule {
    const window = Math.min(Math.max(def.defaultDuration || 0.5, 0.3), 1.2);
    if (slot === "in") return { duration: PREVIEW_ITEM, spec: { in: { id: def.id, duration: window } }, start: 0, end: window + 0.5 };
    if (slot === "out") return { duration: PREVIEW_ITEM, spec: { out: { id: def.id, duration: window } }, start: PREVIEW_ITEM - window - 0.4, end: PREVIEW_ITEM };
    if (slot === "combo") return { duration: COMBO_ITEM, spec: { combo: { id: def.id } }, start: 0, end: COMBO_ITEM };
    const period = Math.max(0.2, def.defaultDuration || 1);
    return { duration: LOOP_ITEM, spec: { loop: { id: def.id, period } }, start: 0, end: Math.max(1.6, period * 2) };
}

const TRACK: Record<AnimationTarget, TimelineClip["trackType"]> = { clip: "video", text: "text", sticker: "sticker" };
const motionCache = new Map<string, ItemMotion>();

function previewMotion(def: AnimationDef, slot: AnimationSlot, target: AnimationTarget, schedule: PreviewSchedule): ItemMotion {
    const key = `${target}:${slot}:${def.id}`;
    const cached = motionCache.get(key);
    if (cached) return cached;
    const clip = {
        id: `preview-${key}`, trackType: TRACK[target], mediaType: target === "text" ? "text" : "image", startTime: 0, endTime: schedule.duration,
        positionX: 0.5, positionY: 0.5, scale: 1, rotationDegrees: 0, opacity: 1, keyframesJson: null, motionPreset: null,
        fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none", transitionDuration: 0, animationJson: JSON.stringify(schedule.spec),
    } as unknown as TimelineClip;
    const motion = itemMotion({ kind: "clip", clip });
    motionCache.set(key, motion);
    return motion;
}

export interface PreviewFrame {
    opacity: number;
    transform: string;
    clipPath?: string;
    filter?: string;
}

const r2 = (x: number) => {
    const v = Math.round(x * 100) / 100;
    return Object.is(v, -0) ? 0 : v;
};

/** Raster progress 0..1 of a text animation at t (1 = fully drawn). */
function rasterProgress(slot: AnimationSlot, schedule: PreviewSchedule, t: number): number {
    const windows = resolveAnimationWindows(schedule.spec, schedule.duration);
    const w = slot === "in" ? windows.in : slot === "out" ? windows.out : windows.loop;
    if (!w || !(w.end > w.start)) return 1;
    if (slot === "loop") {
        const period = windows.loop!.period;
        return ((t - w.start) % period) / period;
    }
    const u = Math.min(1, Math.max(0, (t - w.start) / (w.end - w.start)));
    return slot === "in" ? u : 1 - u;
}

/** The tile's style at item-local time t of the preview schedule. */
export function previewFrame(def: AnimationDef, slot: AnimationSlot, target: AnimationTarget, t: number): PreviewFrame {
    const schedule = previewSchedule(def, slot);
    const m = motionAt(previewMotion(def, slot, target, schedule), Math.min(schedule.duration, Math.max(0, t)));
    const frame: PreviewFrame = {
        opacity: r2(m.opacity),
        transform: `translate(${r2((m.dx * 100) / TILE)}%, ${r2((m.dy * 100) / TILE)}%) rotate(${r2(m.rotation)}deg) scale(${r2(m.scale * m.scaleX)}, ${r2(m.scale)})`,
    };
    if (def.raster) {
        const p = rasterProgress(slot, schedule, t);
        if (def.raster === "typewriter" || def.raster === "typewriter_erase" || def.raster === "wipe") frame.clipPath = `inset(0 ${Math.round((1 - p) * 100)}% 0 0)`;
        else if (def.raster === "letter_rise" || def.raster === "letter_fall") frame.clipPath = `inset(${Math.round((1 - p) * 100)}% 0 0 0)`;
        else if (def.raster === "blur") frame.filter = `blur(${r2((1 - p) * 4)}px)`;
        else if (def.raster === "glow") frame.filter = `drop-shadow(0 0 ${r2(Math.sin(Math.PI * p) ** 2 * 5)}px var(--on-foreground-strong))`;
    }
    return frame;
}

/** A still pose that tells the animations apart at rest: part-way through the motion (a mid-flight frame). */
export function restingFrame(def: AnimationDef, slot: AnimationSlot, target: AnimationTarget): PreviewFrame {
    const schedule = previewSchedule(def, slot);
    const windows = resolveAnimationWindows(schedule.spec, schedule.duration);
    const w = slot === "in" ? windows.in : slot === "out" ? windows.out : slot === "combo" ? windows.combo : windows.loop;
    if (!w) return previewFrame(def, slot, target, schedule.start);
    const span = w.end - w.start;
    const at = slot === "loop" ? w.start + 0.25 * (windows.loop?.period ?? 1)
        : slot === "out" ? w.start + 0.55 * span
            : slot === "combo" ? w.start + 0.3 * span
                : w.start + 0.45 * span;
    return previewFrame(def, slot, target, at);
}

function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function applyFrame(el: HTMLElement, frame: PreviewFrame | null) {
    el.style.opacity = frame ? String(frame.opacity) : "";
    el.style.transform = frame ? frame.transform : "";
    el.style.clipPath = frame?.clipPath ?? "";
    el.style.filter = frame?.filter ?? "";
}

/** The card's moving tile; `active` (hover / focus) plays the animation in a loop. */
export function MotionThumb({ def, slot, target, active }: { def: AnimationDef | null; slot: AnimationSlot; target: AnimationTarget; active: boolean }) {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || !def) return;
        if (!active || prefersReducedMotion()) {
            // At rest every card shows its own mid-flight pose, so the grid is readable without hovering.
            applyFrame(el, restingFrame(def, slot, target));
            return () => applyFrame(el, null);
        }
        const schedule = previewSchedule(def, slot);
        const span = Math.max(0.2, schedule.end - schedule.start);
        // Hold the first and last state briefly so the motion reads.
        const hold = 0.25;
        let frame = 0;
        const begin = performance.now();
        const tick = (now: number) => {
            const cycle = ((now - begin) / 1000) % (span + 2 * hold);
            const t = schedule.start + Math.min(span, Math.max(0, cycle - hold));
            applyFrame(el, previewFrame(def, slot, target, t));
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(frame);
            applyFrame(el, null);
        };
    }, [def, slot, target, active]);
    return (
        <span className="on-anim-stage" aria-hidden="true">
            <span ref={ref} className="on-anim-tile" data-kind={target === "text" ? "text" : "clip"}>{target === "text" ? "Aa" : null}</span>
        </span>
    );
}
