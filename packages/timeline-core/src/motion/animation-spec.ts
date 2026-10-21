// The `animationJson` field of clips and scenes (phase 10b): which in / out / combo / loop animation an
// item uses and for how long. Pure structure; unknown ids are ignored when motion is composed.
import type { AnimationSpec } from "./types";

export const MIN_ANIMATION_SECONDS = 0.1;
export const DEFAULT_ANIMATION_SECONDS = 0.5;
export const MIN_LOOP_PERIOD = 0.2;
export const MAX_LOOP_PERIOD = 10;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function id(value: unknown): string | null {
    return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

function positive(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseAnimationSpec(json: string | null | undefined): AnimationSpec {
    if (!json) return {};
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return {};
    }
    const root = record(raw);
    if (!root) return {};
    const spec: AnimationSpec = {};
    const combo = record(root.combo);
    const comboId = combo && id(combo.id);
    if (comboId) {
        spec.combo = combo!.duration !== undefined && positive(combo!.duration, 0) > 0 ? { id: comboId, duration: positive(combo!.duration, 0) } : { id: comboId };
    } else {
        for (const slot of ["in", "out"] as const) {
            const entry = record(root[slot]);
            const entryId = entry && id(entry.id);
            if (entryId) spec[slot] = { id: entryId, duration: positive(entry!.duration, DEFAULT_ANIMATION_SECONDS) };
        }
    }
    const loop = record(root.loop);
    const loopId = loop && id(loop.id);
    if (loopId) spec.loop = { id: loopId, period: Math.min(MAX_LOOP_PERIOD, Math.max(MIN_LOOP_PERIOD, positive(loop!.period, 1))) };
    return spec;
}

export function serializeAnimationSpec(spec: AnimationSpec): string | null {
    const out: AnimationSpec = {};
    if (spec.combo) out.combo = spec.combo;
    else {
        if (spec.in) out.in = spec.in;
        if (spec.out) out.out = spec.out;
    }
    if (spec.loop) out.loop = spec.loop;
    return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

export interface AnimationWindow {
    id: string;
    /** Item-local seconds. */
    start: number;
    end: number;
}

export interface ResolvedAnimationWindows {
    in?: AnimationWindow;
    out?: AnimationWindow;
    combo?: AnimationWindow;
    loop?: AnimationWindow & { period: number };
}

/**
 * Item-local windows for an item of `duration` seconds: in and out each get at most half the item
 * (at least MIN_ANIMATION_SECONDS), a combo spans the item (or its own duration from the start), a loop
 * runs between the end of in and the start of out.
 */
export function resolveAnimationWindows(spec: AnimationSpec, duration: number): ResolvedAnimationWindows {
    const d = Math.max(0, duration);
    const half = d / 2;
    const clampWindow = (seconds: number) => Math.min(Math.max(seconds, MIN_ANIMATION_SECONDS), Math.max(MIN_ANIMATION_SECONDS, half));
    const out: ResolvedAnimationWindows = {};
    if (spec.combo) {
        out.combo = { id: spec.combo.id, start: 0, end: spec.combo.duration ? Math.min(d, spec.combo.duration) : d };
    } else {
        if (spec.in) out.in = { id: spec.in.id, start: 0, end: Math.min(d, clampWindow(spec.in.duration)) };
        if (spec.out) out.out = { id: spec.out.id, start: Math.max(0, d - clampWindow(spec.out.duration)), end: d };
    }
    if (spec.loop) {
        const start = out.in?.end ?? 0;
        const end = out.out?.start ?? d;
        if (end > start) out.loop = { id: spec.loop.id, start, end, period: spec.loop.period };
    }
    return out;
}
