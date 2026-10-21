// Animation helpers for the graphics templates (phase 10d): a closed-form damped spring and piecewise-linear
// interpolation with clamping, written from the physics (not ported from any animation library).

export interface SpringConfig {
    /** Default 10. */
    damping?: number;
    /** Default 100. */
    stiffness?: number;
    /** Default 1. */
    mass?: number;
}

export interface SpringInput {
    /** Frames since the spring started (negative: not started, returns `from`). */
    frame: number;
    fps: number;
    config?: SpringConfig;
    from?: number;
    to?: number;
}

/**
 * Position of a mass on a damped spring released at rest from `from` towards `to`, after `frame / fps` seconds:
 * x(t) = to − (to − from)·u(t), with u the unit step response of m·x'' + c·x' + k·x = 0. Damping at or above
 * critical settles like the critically damped spring (the timing the templates were authored with: "damping 200"
 * means a smooth ease that lands in about a second, not a crawl). Pure and exact, so every renderer gets the same
 * value for the same frame.
 */
export function spring({ frame, fps, config = {}, from = 0, to = 1 }: SpringInput): number {
    if (!(frame > 0) || !(fps > 0)) return from;
    const m = config.mass && config.mass > 0 ? config.mass : 1;
    const k = config.stiffness && config.stiffness > 0 ? config.stiffness : 100;
    const c = config.damping !== undefined && config.damping >= 0 ? config.damping : 10;
    const t = frame / fps;
    const w0 = Math.sqrt(k / m);
    const zeta = c / (2 * Math.sqrt(k * m));
    let u: number;
    if (zeta < 1 - 1e-9) {
        const wd = w0 * Math.sqrt(1 - zeta * zeta);
        u = Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    } else {
        u = Math.exp(-w0 * t) * (1 + w0 * t);
    }
    return to - (to - from) * u;
}

export type Extrapolate = "clamp" | "extend";

export interface InterpolateOptions {
    /** Default "extend". */
    extrapolateLeft?: Extrapolate;
    extrapolateRight?: Extrapolate;
}

/** Piecewise-linear map of `input` through increasing `inputRange` onto `outputRange` (same length, ≥ 2). */
export function interpolate(input: number, inputRange: readonly number[], outputRange: readonly number[], options: InterpolateOptions = {}): number {
    const n = Math.min(inputRange.length, outputRange.length);
    if (n < 2) return outputRange[0] ?? input;
    if (input <= inputRange[0]) {
        if (options.extrapolateLeft === "clamp") return outputRange[0];
        return segment(input, inputRange[0], inputRange[1], outputRange[0], outputRange[1]);
    }
    if (input >= inputRange[n - 1]) {
        if (options.extrapolateRight === "clamp") return outputRange[n - 1];
        return segment(input, inputRange[n - 2], inputRange[n - 1], outputRange[n - 2], outputRange[n - 1]);
    }
    let i = 1;
    while (i < n - 1 && input > inputRange[i]) i += 1;
    return segment(input, inputRange[i - 1], inputRange[i], outputRange[i - 1], outputRange[i]);
}

function segment(x: number, x0: number, x1: number, y0: number, y1: number): number {
    if (x1 === x0) return y1;
    return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/** `interpolate` clamped on both sides. */
export function clampedInterpolate(input: number, inputRange: readonly number[], outputRange: readonly number[]): number {
    return interpolate(input, inputRange, outputRange, { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/**
 * The fade-out most templates end with: 1 until half a second before the end, then down to 0 on the last frame
 * (the last two frames for very short clips).
 */
export function exitWindow(fps: number, durationInFrames: number): [number, number] {
    const start = Math.min(Math.max(0, durationInFrames - Math.round(fps / 2)), Math.max(0, durationInFrames - 2));
    return [start, Math.max(start + 1, durationInFrames - 1)];
}
