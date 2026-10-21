// Transition windows on a lane (phase 10a semantics): centered on the cut, length 2·half, where
// half = min(duration / 2, outgoing / 2, incoming / 2) so neighbouring windows never overlap and
// every item keeps a body. The export snaps half down to whole frames; the preview uses it as is.
import { normalizeTimelineTransitionType } from "../lib/timeline-editing-navigation";
import { MAX_TRANSITION_SECONDS, transitionById } from "./transitions";

export interface LaneJoin {
    type: string;
    /** Authored duration in seconds. */
    duration: number;
}

export interface TransitionWindow {
    type: string;
    /** Half of the window: before and after the cut. */
    half: number;
}

/**
 * `durations[i]` is item i's length; `joins` maps i to the transition between item i and i + 1
 * (only touching scene pairs). Joins of unknown types or too short to hold a frame are dropped.
 */
export function planTransitionWindows(durations: readonly number[], joins: ReadonlyMap<number, LaneJoin>, fps?: number): Map<number, TransitionWindow> {
    const out = new Map<number, TransitionWindow>();
    for (const [i, join] of joins) {
        if (!transitionById(join.type)) continue;
        const a = durations[i];
        const b = durations[i + 1];
        if (!(a > 0) || !(b > 0) || !(join.duration > 0)) continue;
        let half = Math.min(join.duration / 2, a / 2, b / 2);
        if (fps) half = Math.floor(half * fps + 1e-6) / fps;
        if (half < (fps ? 1 / fps : 0.02)) continue;
        out.set(i, { type: join.type, half });
    }
    return out;
}

/** CapCut progress (0 → 1) at timeline time t inside a window centered on `cut`; null outside. */
export function windowProgress(t: number, cut: number, half: number): number | null {
    if (half <= 0 || t < cut - half || t >= cut + half) return null;
    return (t - (cut - half)) / (2 * half);
}

// ── upper-track clip cuts (phase 10b) ─────────────────────

/** The editor's cut tolerance (lib/scene-transitions.ts SCENE_CUT_TOLERANCE), shared by clip junctions. */
const CUT_TOLERANCE = 0.06;

/** The clip fields chain detection reads. */
export interface ChainClip {
    id: string;
    trackType: string;
    trackIndex: number;
    startTime: number;
    endTime: number;
    mediaUrl?: string | null;
    transitionType?: string | null;
    transitionDuration?: number | null;
    fadeOutDuration?: number | null;
}

export interface ClipChain<T extends ChainClip> {
    trackIndex: number;
    /** Clips in time order. */
    clips: T[];
    /** Transition between clips[i] and clips[i + 1], keyed by i (the outgoing clip owns it). */
    joins: Map<number, LaneJoin>;
}

/** A V2+ video or image clip with media: the clips that can sit in a transition lane. */
export function isLaneClip(clip: ChainClip): boolean {
    return clip.trackType === "video" && (clip.trackIndex ?? 2) >= 2 && Boolean(clip.mediaUrl);
}

/** Tolerance of the legacy preset fade match (the controller's transition.set uses the same). */
const PRESET_FADE_TOLERANCE = 0.0015;

/**
 * True when the clip's fade-out was written by phase 10a's transition preset (getTimelineTransitionPresetUpdate:
 * a transition type with fadeIn = fadeOut = transitionDuration, which 10a exported as per-clip alpha fades): the
 * fade-out is positive and equal to the transition duration within 1 ms (rounding). The 10b transition.set path
 * clears such fades when it writes a transition, so a match means the clip still carries the old preset.
 */
export function isLegacyPresetFade(clip: Pick<ChainClip, "transitionType" | "transitionDuration" | "fadeOutDuration">): boolean {
    if (normalizeTimelineTransitionType(String(clip.transitionType ?? "none")) === "none") return false;
    const fadeOut = Number(clip.fadeOutDuration ?? 0);
    return fadeOut > 0 && Math.abs(fadeOut - Number(clip.transitionDuration ?? 0)) < PRESET_FADE_TOLERANCE;
}

/**
 * The library transition a clip owns at its end, or null (none, legacy-only types, zero duration, or a legacy
 * preset — isLegacyPresetFade — which keeps the 10a per-clip fades instead of a window).
 */
export function clipLibraryTransition(clip: ChainClip): LaneJoin | null {
    const type = normalizeTimelineTransitionType(String(clip.transitionType ?? "none"));
    const duration = Number(clip.transitionDuration ?? 0);
    if (!transitionById(type) || !(duration > 0) || isLegacyPresetFade(clip)) return null;
    return { type, duration };
}

const touches = (a: ChainClip, b: ChainClip) => Math.abs(b.startTime - a.endTime) <= CUT_TOLERANCE;

/**
 * Upper-track clips joined by library transitions: on each V2+ video track, the runs of touching video/image
 * clips (next start within the editor's 0.06 s cut tolerance of the previous end) where every cut in the run
 * carries the outgoing clip's library transition (not a 10a preset, see isLegacyPresetFade). Clips outside such
 * runs keep the legacy overlay path (their fades). The preview and the export both read lanes through this one rule.
 */
export function clipTransitionChains<T extends ChainClip>(clips: readonly T[]): Array<ClipChain<T>> {
    const byTrack = new Map<number, T[]>();
    for (const clip of clips) {
        if (!isLaneClip(clip)) continue;
        const list = byTrack.get(clip.trackIndex) ?? [];
        list.push(clip);
        byTrack.set(clip.trackIndex, list);
    }
    const chains: Array<ClipChain<T>> = [];
    for (const trackIndex of [...byTrack.keys()].sort((a, b) => a - b)) {
        const sorted = byTrack.get(trackIndex)!.slice().sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
        let current: ClipChain<T> | null = null;
        for (let i = 0; i + 1 < sorted.length; i += 1) {
            const join = touches(sorted[i], sorted[i + 1]) ? clipLibraryTransition(sorted[i]) : null;
            if (!join) {
                current = null;
                continue;
            }
            if (!current) {
                current = { trackIndex, clips: [sorted[i]], joins: new Map() };
                chains.push(current);
            }
            current.joins.set(current.clips.length - 1, join);
            current.clips.push(sorted[i + 1]);
        }
    }
    return chains;
}

/**
 * A chain clip as the lane draws it: the window replaces the fades at its junctions, so the outgoing side
 * drops its fade-out and the incoming side its fade-in (other fades stay). Same object when nothing changes.
 */
export function chainClipFades<T extends { fadeInDuration?: number | null; fadeOutDuration?: number | null }>(clip: T, sides: { incoming: boolean; outgoing: boolean }): T {
    const dropIn = sides.incoming && Number(clip.fadeInDuration ?? 0) > 0;
    const dropOut = sides.outgoing && Number(clip.fadeOutDuration ?? 0) > 0;
    if (!dropIn && !dropOut) return clip;
    return { ...clip, ...(dropIn ? { fadeInDuration: 0 } : {}), ...(dropOut ? { fadeOutDuration: 0 } : {}) };
}

export interface ClipJunction {
    outgoingId: string;
    incomingId: string;
    /** Timeline seconds of the cut (the outgoing clip's end). */
    cut: number;
    /** Longest transition the cut can hold (2 s and each neighbour's length). */
    maxDuration: number;
}

/**
 * The cut a clip's transition lives on: its own cut to the next touching lane clip on its track (it owns that
 * transition), else the previous clip's cut into it. Null when neither neighbour touches.
 */
export function clipJunction<T extends ChainClip>(clips: readonly T[], clipId: string): ClipJunction | null {
    const clip = clips.find((c) => c.id === clipId);
    if (!clip || !isLaneClip(clip)) return null;
    const lane = clips.filter((c) => c.id !== clip.id && isLaneClip(c) && c.trackIndex === clip.trackIndex);
    const nearest = (candidates: T[], key: (c: T) => number) => candidates.sort((a, b) => key(a) - key(b))[0];
    const next = nearest(lane.filter((c) => touches(clip, c)), (c) => Math.abs(c.startTime - clip.endTime));
    const previous = next ? undefined : nearest(lane.filter((c) => touches(c, clip)), (c) => Math.abs(clip.startTime - c.endTime));
    const [a, b] = next ? [clip, next] : previous ? [previous, clip] : [null, null];
    if (!a || !b) return null;
    const maxDuration = Math.round(Math.max(0, Math.min(MAX_TRANSITION_SECONDS, a.endTime - a.startTime, b.endTime - b.startTime)) * 1e6) / 1e6;
    return { outgoingId: a.id, incomingId: b.id, cut: a.endTime, maxDuration };
}
