// Shared shot_breakdown parsing and duration helpers.
//
// The pattern `JSON.parse(scene.shotBreakdown || "[]")` followed by
// `shots.reduce((t, s) => t + Number(s.duration || 0), 0)` was copy-pasted
// across 20+ files. Centralize here so:
//   - malformed JSON returns [] instead of throwing at the call site
//   - duration math handles non-numeric / missing values consistently
//   - future shot_breakdown schema changes have one migration point

export interface ShotBreakdownEntry {
    prompt?: string;
    duration?: string | number;
    duration_seconds?: string | number;
    speech?: string | null;
    video_url?: string | null;
    keyframe_url?: string | null;
    panel_url?: string | null;
    source_frame_url?: string | null;
    [key: string]: unknown;
}

const EMPTY_SHOT_BREAKDOWN: never[] = [];
const MAX_CACHED_SHOT_BREAKDOWNS = 250;
const cachedShotBreakdowns = new Map<string, unknown[]>();

/** Parse a shot_breakdown JSON string into an array. Returns [] on any error.
 *  Pass a type argument to narrow the element shape without an `as` cast at
 *  the call site: `parseShotBreakdown<{ duration: string }>(raw)`.
 */
export function parseShotBreakdown<T = ShotBreakdownEntry>(raw: string | null | undefined): T[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Cached parser for read-only render/hit-test paths.
 *  Do not use this in editing workflows that mutate the returned array or its
 *  entries; use parseShotBreakdown() there to preserve fresh-object semantics.
 */
export function parseCachedShotBreakdown<T = ShotBreakdownEntry>(raw: string | null | undefined): T[] {
    if (!raw) return EMPTY_SHOT_BREAKDOWN as T[];

    const cached = cachedShotBreakdowns.get(raw);
    if (cached) return cached as T[];

    let parsed: unknown[] = EMPTY_SHOT_BREAKDOWN;
    try {
        const value = JSON.parse(raw);
        parsed = Array.isArray(value) ? value : EMPTY_SHOT_BREAKDOWN;
    } catch {
        parsed = EMPTY_SHOT_BREAKDOWN;
    }

    cachedShotBreakdowns.set(raw, parsed);
    if (cachedShotBreakdowns.size > MAX_CACHED_SHOT_BREAKDOWNS) {
        const oldest = cachedShotBreakdowns.keys().next().value;
        if (oldest !== undefined) cachedShotBreakdowns.delete(oldest);
    }
    return parsed as T[];
}

export function shotDurationSeconds(
    shotOrDuration:
        | { duration?: string | number; duration_seconds?: string | number }
        | string
        | number
        | null
        | undefined,
): number {
    if (shotOrDuration && typeof shotOrDuration === "object") {
        return Number(shotOrDuration.duration_seconds ?? shotOrDuration.duration) || 0;
    }
    return Number(shotOrDuration) || 0;
}

/** Sum per-shot durations. Handles copy-video duration_seconds, strings, and missing values. */
export function totalShotDuration(shots: { duration?: string | number; duration_seconds?: string | number }[]): number {
    return shots.reduce((t, s) => t + shotDurationSeconds(s), 0);
}

/** Sum durations of only shots that have a video_url (for auto-stitch etc). */
export function totalVideoDuration(shots: { duration?: string | number; video_url?: string | null }[]): number {
    return shots
        .filter((s) => s.video_url)
        .reduce((t, s) => t + (Number(s.duration) || 0), 0);
}

/** Visual width of a single shot inside its scene strip. Floors at 0.1 so a
 *  missing / zero / NaN duration still renders (and hit-tests) as a thin
 *  sliver instead of collapsing to width 0. The renderer and hit detector
 *  MUST share this — if they diverge, clicks resolve to the wrong shot. */
export function shotVisualDuration(
    shotOrDuration:
        | { duration?: string | number; duration_seconds?: string | number }
        | string
        | number
        | null
        | undefined,
): number {
    return Math.max(shotDurationSeconds(shotOrDuration), 0.1);
}
