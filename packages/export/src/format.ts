// Number formatting and coercion for ffmpeg filter arguments.

/** Python "%g"-like: at most 6 significant digits, no trailing zeros, never exponent notation. */
export function fmt(value: number): string {
    if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return "0";
    const text = String(Number(value.toPrecision(6)));
    return text.includes("e") ? value.toFixed(6).replace(/\.?0+$/, "") : text;
}

/** Seconds with millisecond precision, for -ss/-t/d= arguments. */
export function sec(value: number): string {
    return Math.max(0, value).toFixed(3);
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** Number(value) when finite; `fallback` for null, undefined, "", NaN and ±Infinity. */
export function num(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** Reference assembler boolean coercion: "1"/"true"/"yes"/"on" strings, else JS truthiness. */
export function truthy(value: unknown): boolean {
    if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    return Boolean(value);
}

export function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/** Rounds to a whole number of frames at `fps`. */
export function quantize(seconds: number, fps: number): number {
    return Math.round(seconds * fps) / fps;
}
