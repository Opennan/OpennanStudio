// Speed in the preview (phase 10b, plan Architecture item 7). Every <video>/<audio> that plays a sped-up
// item (main-track scenes, V2+ overlay clips, under-scene clips, timeline audio clips, a scene's extracted
// source audio) goes through these helpers, so they all agree with the export's time map:
//
//   media time  = trimStart + S(t)          (S = sourceTimeAt, the exact time map of motion/speed.ts)
//   element rate = s·y(t/D) × shuttle         (speedAt), clamped to the browser range
//
// The element plays at the instantaneous rate and drift toward S(t) is corrected with the same discipline
// ScenePreview has always used (rare rate writes, hysteresis, hard seek only past a second). Outside the
// browser's range (Chrome plays 0.0625-16×) the element is paused and stepped by seeking each frame.
//
// Pure helpers (mediaTimeAt, targetRate, driftAction) plus one imperative applier (syncMediaElement).
import { clipSpeedProfile, isIdentitySpeed, sourceTimeAt, speedAt, type SpeedProfile } from "@opennan/timeline-core/motion/speed";

type ClipSpeedInput = Parameters<typeof clipSpeedProfile>[0];
const clipProfiles = new WeakMap<ClipSpeedInput, SpeedProfile>();

/**
 * clipSpeedProfile memoized per clip object: clips are immutable (an edit makes a new object), and the
 * compositor asks for every visible clip on every frame (parsing the speed curve each time).
 */
export function cachedClipSpeedProfile(clip: ClipSpeedInput): SpeedProfile {
    let profile = clipProfiles.get(clip);
    if (!profile) {
        profile = clipSpeedProfile(clip);
        clipProfiles.set(clip, profile);
    }
    return profile;
}

/** Chrome's playbackRate range; Firefox and Safari accept at least this range. */
export const MIN_ELEMENT_RATE = 0.0625;
export const MAX_ELEMENT_RATE = 16;

// Drift thresholds, in TIMELINE seconds (media drift ÷ rate): ScenePreview's existing values, so 1× plays
// exactly as before. Measuring in timeline seconds keeps the audible/visible sync error the same at any speed.
/** Past this drift a playing element is hard-seeked. */
export const HARD_SEEK_DRIFT = 1.0;
/** Past this drift the rate is nudged ±NUDGE_FACTOR … */
export const NUDGE_ENTER_DRIFT = 0.15;
/** … until the drift falls under this (hysteresis: no rate flapping inside the band). */
export const NUDGE_EXIT_DRIFT = 0.05;
export const NUDGE_FACTOR = 0.02;
/** Nudge changes at most this often: every playbackRate write restarts Chrome's audio resampler (crackle). */
export const RATE_WRITE_INTERVAL_MS = 600;
/** A paused element is re-seeked when it is further than this (media seconds) from the playhead frame. */
export const PAUSED_SEEK_TOLERANCE = 0.05;
/** In step mode an element is re-seeked when it lags more than this (media seconds, ~1 frame at 60 fps). */
export const STEP_SEEK_TOLERANCE = 1 / 60;
/** Base-rate changes (curves) smaller than this fraction are not written (fewer resampler restarts). */
export const RATE_WRITE_TOLERANCE = 0.01;

const EPSILON = 1e-9;
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export interface RateTarget {
    /** The playbackRate to set, within [MIN_ELEMENT_RATE, MAX_ELEMENT_RATE]. */
    rate: number;
    /** True when the true rate is outside the browser's range: step the element by seeking each frame. */
    seek: boolean;
}

/**
 * Media seconds to show at item-local timeline time `localT` for an item of timeline length `D` that
 * starts `trimStart` seconds into its media. Constant speeds extrapolate linearly (like the old
 * `trimStart + local` at 1×); curves use the exact time map, clamped to the item.
 */
export function mediaTimeAt(profile: SpeedProfile, localT: number, D: number, trimStart = 0): number {
    const local = Math.max(0, localT);
    const base = Math.max(0, trimStart);
    if (isIdentitySpeed(profile)) return base + local;
    if (!profile.curve || !(D > 0)) return base + profile.speed * local;
    return base + sourceTimeAt(profile, local, D);
}

/** The element rate at item-local `localT` (× an optional shuttle multiplier), clamped to the browser range. */
export function targetRate(profile: SpeedProfile, localT: number, D: number, multiplier = 1): RateTarget {
    const base = profile.curve && D > 0 ? speedAt(profile, clamp(localT, 0, D), D) : profile.speed;
    return clampRate(base * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1));
}

/** Any true rate as an element target: clamped to the browser range, `seek` when it had to be clamped. */
export function clampRate(raw: number): RateTarget {
    const value = Number.isFinite(raw) && raw > 0 ? raw : 1;
    const seek = value < MIN_ELEMENT_RATE - EPSILON || value > MAX_ELEMENT_RATE + EPSILON;
    return { rate: clamp(value, MIN_ELEMENT_RATE, MAX_ELEMENT_RATE), seek };
}

export interface DriftDecision {
    /** Seek here (media seconds), or null. */
    seek: number | null;
    /** The playbackRate to set (base, or base ± NUDGE_FACTOR), or null to keep the current one. */
    rate: number | null;
}

/**
 * What to do with an element at `current` that should be at `desired` (media seconds) and runs at base
 * rate `rate`. Playing: hard seek past HARD_SEEK_DRIFT, nudge ±2% past NUDGE_ENTER_DRIFT, back to the
 * base rate under NUDGE_EXIT_DRIFT, keep the current rate in between. Paused: snap to the frame.
 * `hardSeekDrift` lets audio-only and overlay elements keep their tighter snap (a seek there is cheap).
 */
export function driftAction(current: number, desired: number, playing: boolean, rate: number, hardSeekDrift = HARD_SEEK_DRIFT): DriftDecision {
    const drift = current - desired;
    if (!playing) return { seek: Math.abs(drift) > PAUSED_SEEK_TOLERANCE ? desired : null, rate };
    const timelineDrift = Math.abs(drift) / Math.max(rate, MIN_ELEMENT_RATE);
    if (timelineDrift > Math.max(hardSeekDrift, NUDGE_ENTER_DRIFT)) return { seek: desired, rate };
    if (timelineDrift > NUDGE_ENTER_DRIFT) return { seek: null, rate: rate * (drift > 0 ? 1 - NUDGE_FACTOR : 1 + NUDGE_FACTOR) };
    if (timelineDrift < NUDGE_EXIT_DRIFT) return { seek: null, rate };
    return { seek: null, rate: null };
}

type PitchElement = HTMLMediaElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };

/** Keep (true: time-stretch) or let the pitch follow the rate (false: varispeed), on every engine's flag. */
export function applyPitch(el: HTMLMediaElement, preservePitch: boolean): void {
    const holder = el as PitchElement;
    try {
        // Change-only writes: toggling the flag reconfigures the audio pipeline.
        // Older Safari reads only the webkit flag, older Firefox only the moz one; elsewhere they are inert.
        if (holder.preservesPitch !== preservePitch) holder.preservesPitch = preservePitch;
        if (holder.webkitPreservesPitch !== preservePitch) holder.webkitPreservesPitch = preservePitch;
        if (holder.mozPreservesPitch !== preservePitch) holder.mozPreservesPitch = preservePitch;
    } catch {
        /* read-only on some engines */
    }
}

interface SyncState {
    /** -1 slowing down, 0 none, 1 speeding up. */
    nudge: -1 | 0 | 1;
    lastNudgeWrite: number;
}

const syncStates = new WeakMap<HTMLMediaElement, SyncState>();

/** Forget an element's nudge state (e.g. it now plays another item). */
export function resetMediaSync(el: HTMLMediaElement): void {
    syncStates.delete(el);
}

export interface MediaSyncOptions {
    /** Media seconds the element should show now (mediaTimeAt). */
    desired: number;
    /** Whether the timeline is playing. Play/pause stays with the caller, except step mode pauses. */
    playing: boolean;
    /** targetRate(...) for this moment. */
    target: RateTarget;
    /** The item's keep-pitch setting. */
    preservePitch: boolean;
    /** performance.now(); injectable for tests. */
    now?: number;
    /** Hard-seek threshold in timeline seconds (default HARD_SEEK_DRIFT). */
    hardSeekDrift?: number;
}

export type MediaSyncResult = "seek" | "step" | "rate" | "none";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * One sync step for an element: rate, pitch, drift correction or per-frame stepping. Callers keep their
 * own play()/pause() logic but must not play() an element while `target.seek` is true (step mode).
 *
 * Pitch: the item's preservePitch, except that a drift nudge on a 1× element uses varispeed (a 2% pitch
 * change is inaudible and avoids running the time-stretcher); the flag returns to the item's setting as
 * soon as the nudge ends, so it never sticks off.
 */
export function syncMediaElement(el: HTMLMediaElement, options: MediaSyncOptions): MediaSyncResult {
    const { desired, playing, target, preservePitch } = options;
    const at = options.now ?? now();
    let state = syncStates.get(el);
    if (!state) {
        state = { nudge: 0, lastNudgeWrite: -Infinity };
        syncStates.set(el, state);
    }
    const base = target.rate;

    if (playing && target.seek) {
        // Step mode: the browser cannot play this fast/slow. Hold the element and seek it each frame, but
        // never queue a seek behind one that is still decoding (seeks would pile up and lag further).
        state.nudge = 0;
        if (!el.paused) el.pause();
        writeRate(el, base);
        applyPitch(el, preservePitch);
        if (!el.seeking && Math.abs(el.currentTime - desired) > STEP_SEEK_TOLERANCE) {
            el.currentTime = desired;
            return "step";
        }
        return "none";
    }

    const decision = driftAction(el.currentTime, desired, playing, base, options.hardSeekDrift);
    if (decision.seek !== null || !playing) {
        state.nudge = 0;
        applyPitch(el, preservePitch);
        const rateChanged = writeRate(el, base);
        if (decision.seek !== null) {
            el.currentTime = decision.seek;
            return "seek";
        }
        return rateChanged ? "rate" : "none";
    }

    const wanted: -1 | 0 | 1 = decision.rate === null ? state.nudge : decision.rate > base * (1 + EPSILON) ? 1 : decision.rate < base * (1 - EPSILON) ? -1 : 0;
    if (wanted !== state.nudge && at - state.lastNudgeWrite > RATE_WRITE_INTERVAL_MS) {
        state.nudge = wanted;
        state.lastNudgeWrite = at;
    }
    const varispeedNudge = state.nudge !== 0 && Math.abs(base - 1) < EPSILON;
    applyPitch(el, varispeedNudge ? false : preservePitch);
    const rate = clamp(base * (1 + NUDGE_FACTOR * state.nudge), MIN_ELEMENT_RATE, MAX_ELEMENT_RATE);
    return writeRate(el, rate) ? "rate" : "none";
}

/** Writes playbackRate when it is off by more than RATE_WRITE_TOLERANCE (exact when the target is 1). */
function writeRate(el: HTMLMediaElement, rate: number): boolean {
    const current = el.playbackRate;
    const tolerance = Math.abs(rate - 1) < EPSILON ? EPSILON : RATE_WRITE_TOLERANCE;
    if (Math.abs(current - rate) <= tolerance * rate) return false;
    try {
        el.playbackRate = rate;
    } catch {
        return false;
    }
    return true;
}
