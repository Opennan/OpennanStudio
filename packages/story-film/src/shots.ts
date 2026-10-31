// A copied video cut into its shots (pure: the host decodes the frames and measures how much each one differs from the
// one before). A cut is a frame that differs from the last one far more than its neighbours do; the pieces between cuts
// become shots of 2 to 15 seconds (a shorter piece joins its shorter neighbour, a longer one is split evenly), so each
// one can be sent as a reference video. The story writer then writes one story shot per real shot, and a remake
// copies each real shot's motion, blocking and camera with the new cast.
import { STORY_LIMITS } from "./validate";
import type { StoryFilm, StoryShot } from "./types";

/** The length a real shot may have: a reference video needs 2 s at least, and a story shot is 15 s at most. */
export const SHOT_SPLIT = Object.freeze({ minSeconds: 2, maxSeconds: 15 });

/** How a frame difference (0..1: the mean colour change of a small picture) counts as a cut. */
export const CUT_DETECTION = Object.freeze({
    /** Always a cut from this much change. */
    hard: 0.32,
    /** A cut from this much change when it also stands out from the frames around it. */
    soft: 0.14,
    /** "Stands out": this many times the median change of the frames around it. */
    ratio: 4,
    /** Frames on each side the median looks at. */
    window: 6,
});

export interface ShotRange {
    start: number;
    end: number;
}

const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Cut times from sampled frames: `times[i]` is a frame's time and `diffs[i]` how much it differs from frame i - 1
 * (0..1; diffs[0] is ignored). A cut is placed at the first frame after it.
 */
export function findCuts(times: readonly number[], diffs: readonly number[]): number[] {
    const cuts: number[] = [];
    for (let i = 1; i < Math.min(times.length, diffs.length); i += 1) {
        const diff = diffs[i]!;
        if (!(diff >= CUT_DETECTION.soft)) continue;
        const around = [...diffs.slice(Math.max(1, i - CUT_DETECTION.window), i), ...diffs.slice(i + 1, i + 1 + CUT_DETECTION.window)];
        if (diff >= CUT_DETECTION.hard || diff >= CUT_DETECTION.ratio * Math.max(0.01, median(around))) cuts.push(ms(times[i]!));
    }
    return cuts;
}

/**
 * The shots between cuts, each 2 to 15 s: a piece under 2 s joins its shorter neighbour, a piece over 15 s is split
 * into equal parts. At most `maxShots` (a story's limit); `truncated` says the rest of the video was left out.
 */
export function splitShots(cuts: readonly number[], durationSeconds: number, maxShots: number = STORY_LIMITS.shots): { shots: ShotRange[]; truncated: boolean } {
    if (!(durationSeconds > 0)) return { shots: [], truncated: false };
    const edges = [...new Set(cuts.map(ms).filter((t) => t > 0 && t < durationSeconds))].sort((a, b) => a - b);
    let pieces: ShotRange[] = [0, ...edges].map((start, i) => ({ start, end: i < edges.length ? edges[i]! : ms(durationSeconds) }));
    // Short pieces join a neighbour (the shorter one) until none is left or one piece is the whole video.
    for (;;) {
        if (pieces.length < 2) break;
        let shortest = -1;
        for (const [i, piece] of pieces.entries()) {
            const length = piece.end - piece.start;
            if (length < SHOT_SPLIT.minSeconds - 1e-9 && (shortest < 0 || length < pieces[shortest]!.end - pieces[shortest]!.start)) shortest = i;
        }
        if (shortest < 0) break;
        const before = pieces[shortest - 1];
        const after = pieces[shortest + 1];
        const into = !after || (before && before.end - before.start <= after.end - after.start) ? shortest - 1 : shortest + 1;
        const a = Math.min(into, shortest);
        pieces = [...pieces.slice(0, a), { start: pieces[a]!.start, end: pieces[a + 1]!.end }, ...pieces.slice(a + 2)];
    }
    // Long pieces are split evenly (each part over 7.5 s, so never under the minimum).
    const shots: ShotRange[] = [];
    for (const piece of pieces) {
        const length = piece.end - piece.start;
        const parts = Math.max(1, Math.ceil(length / SHOT_SPLIT.maxSeconds - 1e-9));
        for (let p = 0; p < parts; p += 1) shots.push({ start: ms(piece.start + (length * p) / parts), end: p === parts - 1 ? piece.end : ms(piece.start + (length * (p + 1)) / parts) });
    }
    return { shots: shots.slice(0, maxShots), truncated: shots.length > maxShots };
}

/**
 * The contact sheet's frames, shot by shot: up to three per shot (evenly inside it) while the sheet holds
 * `maxFrames`, at least one per shot. `shot` is the frame's 0-based shot.
 */
export function shotSheetTimes(shots: readonly ShotRange[], maxFrames = 24): Array<{ time: number; shot: number }> {
    if (shots.length === 0) return [];
    const each = Math.max(1, Math.min(3, Math.floor(maxFrames / shots.length)));
    return shots.flatMap((shot, index) => Array.from({ length: each }, (_, k) => ({ time: ms(shot.start + ((k + 0.5) * (shot.end - shot.start)) / each), shot: index })));
}

/** A story shot's seconds for a real shot's length: the whole number nearest it, within a story shot's 4 to 15. */
export function storySecondsOf(length: number): number {
    return Math.min(STORY_LIMITS.maxSeconds, Math.max(STORY_LIMITS.minSeconds, Math.round(length)));
}

/** A remake's output length: the model's length nearest the real shot's (a tie takes the longer), else the story shot's seconds. */
export function remakeSeconds(length: number, durations: readonly number[] | undefined): number {
    const choices = (durations ?? []).filter((d) => Number.isFinite(d) && d > 0);
    if (choices.length === 0) return storySecondsOf(length);
    return choices.reduce((best, d) => (Math.abs(d - length) < Math.abs(best - length) || (Math.abs(d - length) === Math.abs(best - length) && d > best) ? d : best));
}

/**
 * The story with each shot placed on its real shot, in order (story shot i ↔ real shot i), its seconds the real
 * shot's rounded, and its clip when the host cut one. Story shots past the real ones keep no source (they animate
 * from their keyframes).
 */
export function withShotSources(story: StoryFilm, shots: ReadonlyArray<ShotRange & { clip?: string }>): StoryFilm {
    return {
        ...story,
        shots: story.shots.map((shot, i): StoryShot => {
            const real = shots[i];
            const next: StoryShot = { ...shot };
            delete next.source;
            if (!real) return next;
            return { ...next, seconds: storySecondsOf(real.end - real.start), source: { start: real.start, end: real.end, ...(real.clip ? { clip: real.clip } : {}) } };
        }),
    };
}
