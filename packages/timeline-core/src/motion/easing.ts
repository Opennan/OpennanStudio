// Keyframe and animation easing (phase 10b). Each curve maps progress u in [0, 1] to [0, 1] (bezier
// handles may overshoot). Every easing is defined once as an expression (looks/expr.ts) so ffmpeg and
// the preview evaluate the same function; bezier curves are defined as their 32-segment polyline,
// solved once in JS, so no backend needs to invert x(s).
import { add, clip, div, gte, iff, lt, mul, sub, toExpr, type Expr, type ExprLike } from "../looks/expr";

export const EASING_IDS = ["linear", "ease_in", "ease_out", "ease_in_out", "hold", "bezier"] as const;
export type EasingId = (typeof EASING_IDS)[number];

/** CSS cubic-bezier handles: x1, y1, x2, y2 (x in [0, 1], y in [-1, 2]). */
export type BezierHandles = readonly [number, number, number, number];

export const DEFAULT_BEZIER: BezierHandles = [0.25, 0.1, 0.25, 1];
export const BEZIER_SEGMENTS = 32;

/** Keyframe points store easing as a number (points are numbers only). */
export function easingCode(id: EasingId): number {
    return EASING_IDS.indexOf(id);
}

export function easingFromCode(code: unknown): EasingId {
    const n = Number(code);
    return Number.isInteger(n) && n >= 0 && n < EASING_IDS.length ? EASING_IDS[n] : "linear";
}

export function normalizeBezier(handles: readonly number[] | null | undefined): BezierHandles {
    if (!handles || handles.length !== 4 || !handles.every((h) => Number.isFinite(h))) return DEFAULT_BEZIER;
    const c = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
    return [c(handles[0], 0, 1), c(handles[1], -1, 2), c(handles[2], 0, 1), c(handles[3], -1, 2)];
}

function cubic(p1: number, p2: number, s: number): number {
    const r = 1 - s;
    return 3 * r * r * s * p1 + 3 * r * s * s * p2 + s * s * s;
}

const tableCache = new Map<string, Array<[number, number]>>();

/** The curve's polyline: 33 points at x = i/32, y solved by bisection on x(s) (x(s) is monotone for x1, x2 in [0, 1]). */
export function bezierTable(handles: readonly number[] | null | undefined): Array<[number, number]> {
    const [x1, y1, x2, y2] = normalizeBezier(handles);
    const key = `${x1},${y1},${x2},${y2}`;
    const cached = tableCache.get(key);
    if (cached) return cached;
    const table: Array<[number, number]> = [];
    for (let i = 0; i <= BEZIER_SEGMENTS; i += 1) {
        const x = i / BEZIER_SEGMENTS;
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 60; k += 1) {
            const mid = (lo + hi) / 2;
            if (cubic(x1, x2, mid) < x) lo = mid;
            else hi = mid;
        }
        const y = i === 0 ? 0 : i === BEZIER_SEGMENTS ? 1 : Math.round(cubic(y1, y2, (lo + hi) / 2) * 1e9) / 1e9;
        table.push([x, y]);
    }
    if (tableCache.size > 64) tableCache.clear();
    tableCache.set(key, table);
    return table;
}

const clamp01 = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u);

/** JS value of the easing at progress u (clamped to [0, 1]). */
export function easeValue(id: EasingId, u: number, handles?: readonly number[] | null): number {
    const x = clamp01(u);
    switch (id) {
        case "linear": return x;
        case "ease_in": return x * x * x;
        case "ease_out": {
            const r = 1 - x;
            return 1 - r * r * r;
        }
        case "ease_in_out": return x < 0.5 ? 4 * x * x * x : 1 - 4 * (1 - x) * (1 - x) * (1 - x);
        case "hold": return x >= 1 ? 1 : 0;
        case "bezier": {
            const table = bezierTable(handles);
            const i = Math.min(BEZIER_SEGMENTS - 1, Math.floor(x * BEZIER_SEGMENTS));
            const [x0, y0] = table[i];
            const [x1, y1] = table[i + 1];
            return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
        }
    }
}

/** The easing as an expression of `u` (any expression; clamped to [0, 1] first). */
export function easeExpr(id: EasingId, u: ExprLike, handles?: readonly number[] | null): Expr {
    const x = clip(u, 0, 1);
    switch (id) {
        case "linear": return x;
        case "ease_in": return mul(x, x, x);
        case "ease_out": {
            const r = sub(1, x);
            return sub(1, mul(r, r, r));
        }
        case "ease_in_out": {
            const r = sub(1, x);
            return iff(lt(x, 0.5), mul(4, x, x, x), sub(1, mul(4, r, r, r)));
        }
        case "hold": return iff(gte(x, 1), 1, 0);
        case "bezier": {
            const table = bezierTable(handles);
            // Segment i covers [i/32, (i+1)/32); the last also takes x = 1. Nested from the right.
            const segment = (i: number): Expr => {
                const [x0, y0] = table[i];
                const [x1, y1] = table[i + 1];
                return add(y0, mul(y1 - y0, div(sub(x, x0), x1 - x0)));
            };
            let expr = segment(BEZIER_SEGMENTS - 1);
            for (let i = BEZIER_SEGMENTS - 2; i >= 0; i -= 1) expr = iff(lt(x, table[i + 1][0]), segment(i), expr);
            return toExpr(expr);
        }
    }
}
