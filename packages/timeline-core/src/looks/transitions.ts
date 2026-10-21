// The 25 library transitions, each written once in the looks IR over the outgoing frame A (src 0)
// and the incoming frame B (src 1) with CapCut progress p (0 → 1). The export runs them as
// `xfade=transition=custom` (p = 1 - P), the preview as GLSL. Every transition shows exactly A at
// p = 0 and exactly B at p = 1, and uses no time-dependent randomness, so both backends agree.
import {
    abs, add, atan2, bind, clip, cos, div, floor, gt, gte, iff, imod, lt, max, min, mix, mod, mul, sample, sin, smoothstep, sqrt, sub, toExpr, v,
    type Channel, type Expr, type ExprLike,
} from "./expr";

export const TRANSITION_CATEGORIES = ["basic", "slide", "wipe", "camera", "distort"] as const;
export type TransitionCategory = (typeof TRANSITION_CATEGORIES)[number];

export interface TransitionDef {
    id: string;
    category: TransitionCategory;
    /** Seconds. */
    defaultDuration: number;
    /** Channel `ch` of the output pixel at (X, Y). */
    channel(ch: Channel): Expr;
}

export const MIN_TRANSITION_SECONDS = 0.1;
export const MAX_TRANSITION_SECONDS = 2;
export const DEFAULT_TRANSITION_SECONDS = 0.5;

const X = v("X");
const Y = v("Y");
const W = v("W");
const H = v("H");
const P = v("p");
const A = (ch: Channel, x: ExprLike = X, y: ExprLike = Y) => sample(0, ch, x, y);
const B = (ch: Channel, x: ExprLike = X, y: ExprLike = Y) => sample(1, ch, x, y);
const CX = div(sub(W, 1), 2);
const CY = div(sub(H, 1), 2);
const U = div(X, W);
const VV = div(Y, H);
/** Ease in-out. */
const E = smoothstep(0, 1, P);
/** 0 at both ends, 1 in the middle. */
const BUMP = mul(4, P, sub(1, P));
const FEATHER = 0.04;

/** Bilinear sample built from four nearest samples (pixel centers on integers, edges clamp). Uses 4 slots. */
function bilinear(src: 0 | 1, ch: Channel, x: ExprLike, y: ExprLike): Expr {
    return bind(x, (xr) => bind(y, (yr) => bind(floor(xr), (x0) => bind(floor(yr), (y0) => {
        const fx = sub(xr, x0);
        const fy = sub(yr, y0);
        const s = (dx: number, dy: number) => sample(src, ch, add(x0, dx), add(y0, dy));
        return add(
            mul(sub(1, fy), add(mul(s(0, 0), sub(1, fx)), mul(s(1, 0), fx))),
            mul(fy, add(mul(s(0, 1), sub(1, fx)), mul(s(1, 1), fx))),
        );
    }))));
}

/** Feathered mask: 0 before the moving edge, 1 after; exactly 0 at p = 0 and 1 at p = 1 for s in [0, 1]. */
const sweep = (s: ExprLike) => clip(div(add(sub(s, 1), mul(P, 1 + FEATHER)), FEATHER), 0, 1);
/** Feathered mask growing with p from s = 0 outward. */
const grow = (s: ExprLike) => clip(div(sub(mul(P, 1 + FEATHER), s), FEATHER), 0, 1);

const rec709 = (src: 0 | 1, x: ExprLike = X, y: ExprLike = Y) =>
    add(mul(0.2126, sample(src, 0, x, y)), mul(0.7152, sample(src, 1, x, y)), mul(0.0722, sample(src, 2, x, y)));

/** Bilinear sample of `src` rotated by `angle` and scaled by `scale` about the center. */
function rotatedSample(src: 0 | 1, ch: Channel, angle: ExprLike, scale: ExprLike): Expr {
    return bind(cos(angle), (c) => bind(sin(angle), (s) => bind(scale, (k) => {
        const dx = sub(X, CX);
        const dy = sub(Y, CY);
        return bilinear(src, ch, add(CX, div(add(mul(dx, c), mul(dy, s)), k)), add(CY, div(sub(mul(dy, c), mul(dx, s)), k)));
    })));
}

const t = (id: string, category: TransitionCategory, channel: (ch: Channel) => Expr, defaultDuration = DEFAULT_TRANSITION_SECONDS): TransitionDef => ({
    id, category, defaultDuration, channel,
});

export const TRANSITIONS: readonly TransitionDef[] = [
    // ── basic ──
    t("cross_dissolve", "basic", (ch) => mix(A(ch), B(ch), P)),
    t("dip_black", "basic", (ch) => iff(lt(P, 0.5), mul(A(ch), sub(1, mul(2, P))), mul(B(ch), sub(mul(2, P), 1))), 0.8),
    t("dip_white", "basic", (ch) => iff(
        lt(P, 0.5),
        add(A(ch), mul(sub(255, A(ch)), mul(2, P))),
        add(B(ch), mul(sub(255, B(ch)), sub(2, mul(2, P)))),
    ), 0.8),
    t("flash", "basic", (ch) => {
        const base = mix(A(ch), B(ch), smoothstep(0.4, 0.6, P));
        const flash = clip(sub(1, mul(abs(sub(mul(2, P), 1)), 1.4)), 0, 1);
        return add(base, mul(sub(255, base), flash));
    }, 0.6),
    t("luma_fade", "basic", (ch) => {
        const soft = 0.2;
        const l = div(rec709(1), 255);
        return mix(A(ch), B(ch), clip(div(sub(mul(P, 1 + soft), l), soft), 0, 1));
    }, 0.8),
    // ── slide (B covers A) and push (B pushes A out) ──
    t("slide_left", "slide", (ch) => {
        const edge = mul(W, sub(1, E));
        return iff(gte(X, edge), B(ch, sub(X, edge)), A(ch));
    }),
    t("slide_right", "slide", (ch) => {
        const edge = mul(W, E);
        return iff(lt(X, edge), B(ch, add(X, sub(W, edge))), A(ch));
    }),
    t("slide_up", "slide", (ch) => {
        const edge = mul(H, sub(1, E));
        return iff(gte(Y, edge), B(ch, X, sub(Y, edge)), A(ch));
    }),
    t("slide_down", "slide", (ch) => {
        const edge = mul(H, E);
        return iff(lt(Y, edge), B(ch, X, add(Y, sub(H, edge))), A(ch));
    }),
    t("push_left", "slide", (ch) => {
        const edge = mul(W, sub(1, E));
        return iff(gte(X, edge), B(ch, sub(X, edge)), A(ch, add(X, mul(W, E))));
    }),
    t("push_right", "slide", (ch) => {
        const edge = mul(W, E);
        return iff(lt(X, edge), B(ch, add(X, sub(W, edge))), A(ch, sub(X, edge)));
    }),
    // ── wipe ──
    t("wipe_left", "wipe", (ch) => mix(A(ch), B(ch), sweep(U))),
    t("wipe_right", "wipe", (ch) => mix(A(ch), B(ch), sweep(sub(1, U)))),
    t("wipe_up", "wipe", (ch) => mix(A(ch), B(ch), sweep(VV))),
    t("wipe_down", "wipe", (ch) => mix(A(ch), B(ch), sweep(sub(1, VV)))),
    t("circle_open", "wipe", (ch) => {
        const r = div(sqrt(add(mul(sub(X, CX), sub(X, CX)), mul(sub(Y, CY), sub(Y, CY)))), sqrt(add(mul(CX, CX), mul(CY, CY))));
        return mix(A(ch), B(ch), grow(min(r, 1)));
    }, 0.7),
    t("clock_wipe", "wipe", (ch) => {
        // Clockwise from 12 o'clock, 0..1.
        const angle = mod(add(div(atan2(sub(X, CX), sub(CY, Y)), 2 * Math.PI), 1), 1);
        return mix(A(ch), B(ch), grow(angle));
    }, 0.8),
    // ── camera ──
    t("zoom_in", "camera", (ch) => bind(E, (e) => {
        const zoom = (src: 0 | 1, scale: Expr) => bind(scale, (k) => bilinear(src, ch, add(CX, div(sub(X, CX), k)), add(CY, div(sub(Y, CY), k))));
        return mix(zoom(0, add(1, mul(1.5, e))), zoom(1, sub(1.5, mul(0.5, e))), smoothstep(0.35, 0.65, P));
    })),
    t("zoom_out", "camera", (ch) => bind(sub(1, mul(0.6, E)), (k) => {
        const inside = mul(
            gte(add(mul(CX, k), 0.5), abs(sub(X, CX))),
            gte(add(mul(CY, k), 0.5), abs(sub(Y, CY))),
        );
        const za = bilinear(0, ch, add(CX, div(sub(X, CX), k)), add(CY, div(sub(Y, CY), k)));
        return mix(iff(inside, za, B(ch)), B(ch), smoothstep(0.5, 1, P));
    })),
    t("spin", "camera", (ch) => bind(E, (e) => mix(
        rotatedSample(0, ch, mul(e, Math.PI), add(1, e)),
        rotatedSample(1, ch, mul(sub(e, 1), Math.PI), sub(2, e)),
        smoothstep(0.4, 0.6, P),
    )), 0.6),
    t("blur_dissolve", "camera", (ch) => bind(mul(BUMP, W, 0.012), (r) => bind(mul(r, 0.7071), (d) => {
        const taps: Array<[ExprLike, ExprLike]> = [[0, 0], [r, 0], [mul(-1, r), 0], [0, r], [0, mul(-1, r)], [d, d], [mul(-1, d), d], [d, mul(-1, d)], [mul(-1, d), mul(-1, d)]];
        const blur = (src: 0 | 1) => div(add(...taps.map(([dx, dy]) => sample(src, ch, add(X, dx), add(Y, dy)))), taps.length);
        return mix(blur(0), blur(1), smoothstep(0.3, 0.7, P));
    })), 0.6),
    // ── distort ──
    t("glitch", "distort", (ch) => {
        const g = sub(1, abs(sub(mul(2, P), 1)));
        const rows = floor(div(Y, max(1, floor(div(H, 18)))));
        // +0.37 keeps p × 12 off integers at frame-aligned progress values (float32 vs double floors).
        const step = floor(add(mul(P, 12), 0.37));
        const h1 = div(imod(add(mul(rows, 7919), mul(step, 104729)), 1000), 1000);
        const h2 = div(imod(add(mul(rows, 6007), mul(step, 3571), 17), 997), 997);
        const shift = mul(sub(h1, 0.5), W, 0.16, g, gt(h2, 0.45));
        const split = mul(g, W, 0.012, ch === 0 ? 1 : ch === 2 ? -1 : 0);
        const sx = add(X, shift, split);
        const useB = gte(P, add(0.5, mul(sub(h2, 0.5), 0.3, g)));
        return iff(useB, B(ch, sx), A(ch, sx));
    }, 0.5),
    t("swirl", "distort", (ch) => bind(sub(X, CX), (dx) => bind(sub(Y, CY), (dy) => {
        const radius = mul(min(W, H), 0.6);
        const k = clip(sub(1, div(sqrt(add(mul(dx, dx), mul(dy, dy))), radius)), 0, 1);
        return bind(mul(BUMP, 5, k, k), (angle) => bind(cos(angle), (c) => bind(sin(angle), (s) => {
            const sx = add(CX, sub(mul(dx, c), mul(dy, s)));
            const sy = add(CY, add(mul(dx, s), mul(dy, c)));
            return mix(bilinear(0, ch, sx, sy), bilinear(1, ch, sx, sy), smoothstep(0.4, 0.6, P));
        })));
    })), 0.7),
    t("pixelate", "distort", (ch) => {
        // 37.3 and +0.31: block sizes change between, never at, frame-aligned progress values.
        const size = add(1, floor(add(mul(37.3, sub(1, abs(sub(mul(2, P), 1)))), 0.31)));
        const sx = mul(floor(div(X, size)), size);
        const sy = mul(floor(div(Y, size)), size);
        return iff(lt(P, 0.5), A(ch, sx, sy), B(ch, sx, sy));
    }, 0.6),
    t("ripple", "distort", (ch) => bind(sub(X, CX), (dx) => bind(sub(Y, CY), (dy) => bind(sqrt(add(mul(dx, dx), mul(dy, dy))), (d) => {
        return bind(div(mul(BUMP, 12, sin(sub(div(d, 12), mul(P, 20)))), add(d, 1)), (k) => {
            const sx = add(X, mul(dx, k));
            const sy = add(Y, mul(dy, k));
            return mix(bilinear(0, ch, sx, sy), bilinear(1, ch, sx, sy), smoothstep(0.3, 0.7, P));
        });
    }))), 0.8),
];

const BY_ID = new Map(TRANSITIONS.map((def) => [def.id, def]));

export const TRANSITION_IDS: readonly string[] = TRANSITIONS.map((def) => def.id);

export function transitionById(id: string | null | undefined): TransitionDef | null {
    return id ? BY_ID.get(id) ?? null : null;
}

export function clampTransitionSeconds(seconds: number): number {
    const value = Number.isFinite(seconds) ? seconds : DEFAULT_TRANSITION_SECONDS;
    return Math.min(MAX_TRANSITION_SECONDS, Math.max(MIN_TRANSITION_SECONDS, value));
}

/** Expression for one channel, 8-bit store semantics applied by the caller (channelOut). */
export function transitionChannel(def: TransitionDef, ch: Channel): Expr {
    return toExpr(def.channel(ch));
}
