// The 20 built-in video effects. Animated or spatial effects are passes of looks IR over one input
// (export: `geq` with nearest sampling and T = seconds since the item or span started; preview: GLSL);
// static color effects are pointwise functions baked into a Hald CLUT like filters.
import type { EffectDef, EffectParam } from "../model/effects";
import { clampRgb, gradientMap, mixRgb, mono, sCurve, type Rgb } from "./color";
import {
    abs, add, atan2, bind, clip, cos, div, floor, gt, iff, imod, max, mix, mod, mul, param, pow, sample, sin, sqrt, sub, v,
    type Channel, type Expr, type ExprLike,
} from "./expr";

export const EFFECT_CATEGORIES = ["basic", "color", "motion", "retro", "glitch"] as const;
export type EffectCategory = (typeof EFFECT_CATEGORIES)[number];

/** One full-frame pass: channel `ch` of the output pixel at (X, Y) at time T. */
export interface EffectPass {
    channel(ch: Channel): Expr;
}

export interface EffectDefinition {
    id: string;
    category: EffectCategory;
    /** English name (the UI translates by id). */
    name: string;
    params: EffectParam[];
    /** Spatial/animated effects. */
    passes?: EffectPass[];
    /** Static pointwise effects (baked into a Hald CLUT). */
    lut?(params: Record<string, number>): (c: Rgb) => Rgb;
}

const X = v("X");
const Y = v("Y");
const W = v("W");
const H = v("H");
const T = v("T");
const CX = div(sub(W, 1), 2);
const CY = div(sub(H, 1), 2);
const S = (ch: Channel, x: ExprLike = X, y: ExprLike = Y) => sample(0, ch, x, y);
const luma = (x: ExprLike = X, y: ExprLike = Y) => add(mul(0.2126, S(0, x, y)), mul(0.7152, S(1, x, y)), mul(0.0722, S(2, x, y)));
const slider = (key: string, label: string, min: number, max: number, def: number): EffectParam => ({ key, label, type: "slider", min, max, default: def });
const amountParam = (def = 0.6) => slider("amount", "Intensity", 0, 1, def);
const speedParam = (def = 1) => slider("speed", "Speed", 0.1, 4, def);
const AMOUNT = param("amount");
const SPEED = param("speed");
/**
 * Frame step for hashes: 24 steps per second, wrapped to stay an exact float32 integer. The 0.37 offset
 * keeps T × 24 away from integers at common frame times (k/24, k/25, k/30, k/60), where float32 GLSL
 * and double ffmpeg would floor differently.
 */
const STEP = imod(floor(add(mul(T, 24), 0.37)), 4096);
/** Integer hash in [0, 1): exact in float32 (every intermediate is an integer below 2^24). */
function hash(a: ExprLike, b: ExprLike, c: ExprLike): Expr {
    const h = imod(add(mul(imod(mul(a, 2531), 65521), 3), mul(imod(mul(b, 4253), 65521), 5), mul(imod(mul(c, 2659), 65521), 7)), 65521);
    return div(imod(mul(h, 251), 65521), 65521);
}

function bilinear(ch: Channel, x: ExprLike, y: ExprLike): Expr {
    return bind(x, (xr) => bind(y, (yr) => bind(floor(xr), (x0) => bind(floor(yr), (y0) => {
        const fx = sub(xr, x0);
        const fy = sub(yr, y0);
        const s = (dx: number, dy: number) => S(ch, add(x0, dx), add(y0, dy));
        return add(mul(sub(1, fy), add(mul(s(0, 0), sub(1, fx)), mul(s(1, 0), fx))), mul(fy, add(mul(s(0, 1), sub(1, fx)), mul(s(1, 1), fx))));
    }))));
}

const zoomAbout = (ch: Channel, scale: ExprLike, ox: ExprLike = 0, oy: ExprLike = 0) =>
    bind(scale, (k) => bilinear(ch, add(CX, div(sub(X, CX), k), ox), add(CY, div(sub(Y, CY), k), oy)));

const radius01 = () => div(sqrt(add(mul(sub(X, CX), sub(X, CX)), mul(sub(Y, CY), sub(Y, CY)))), sqrt(add(mul(CX, CX), mul(CY, CY))));
const GAUSS7 = [1, 6, 15, 20, 15, 6, 1];

const pass = (channel: (ch: Channel) => Expr): EffectPass => ({ channel });

export const EFFECTS: readonly EffectDefinition[] = [
    // ── basic ──
    {
        id: "fx_blur", category: "basic", name: "Blur", params: [amountParam(0.5)],
        passes: ["x", "y"].map((axis) => pass((ch) => bind(mul(AMOUNT, W, 0.006), (r) => div(
            add(...GAUSS7.map((w, i) => mul(w, axis === "x" ? S(ch, add(X, mul(r, i - 3)), Y) : S(ch, X, add(Y, mul(r, i - 3)))))),
            64,
        )))),
    },
    {
        id: "fx_zoom_blur", category: "basic", name: "Zoom blur", params: [amountParam(0.5)],
        passes: [pass((ch) => bind(mul(AMOUNT, 0.12), (s) => div(add(...Array.from({ length: 8 }, (_, i) => {
            const k = sub(1, mul(s, i / 7));
            return S(ch, add(CX, mul(sub(X, CX), k)), add(CY, mul(sub(Y, CY), k)));
        })), 8)))],
    },
    {
        id: "fx_pixelate", category: "basic", name: "Pixelate", params: [amountParam(0.4)],
        passes: [pass((ch) => bind(add(1, floor(mul(AMOUNT, W, 0.05))), (size) => S(
            ch,
            add(mul(floor(div(X, size)), size), floor(div(size, 2))),
            add(mul(floor(div(Y, size)), size), floor(div(size, 2))),
        )))],
    },
    {
        id: "fx_mirror", category: "basic", name: "Mirror", params: [],
        passes: [pass((ch) => iff(gt(X, CX), S(ch, sub(sub(W, 1), X)), S(ch)))],
    },
    {
        id: "fx_kaleidoscope", category: "basic", name: "Kaleidoscope", params: [slider("segments", "Segments", 3, 12, 6), slider("speed", "Spin", 0, 2, 0.2)],
        passes: [pass((ch) => bind(sub(X, CX), (dx) => bind(sub(Y, CY), (dy) => bind(div(2 * Math.PI, floor(param("segments"))), (seg) => {
            const angle = add(atan2(dy, dx), mul(T, param("speed")));
            return bind(abs(sub(mod(angle, seg), div(seg, 2))), (a) => bind(sqrt(add(mul(dx, dx), mul(dy, dy))), (r) =>
                // +0.5 rounds to the nearest pixel: mirrored angles land exactly on pixel centers, where
                // truncation would flip with last-ulp libm differences between ffmpeg, V8, and GPUs.
                S(ch, add(CX, mul(r, cos(a)), 0.5), add(CY, mul(r, sin(a)), 0.5))));
        }))))],
    },
    // ── color ──
    {
        id: "fx_black_white", category: "color", name: "Black & white", params: [slider("contrast", "Contrast", 0, 1, 0.3)],
        lut: (p) => (c) => {
            const m = mono(c)[0];
            const s = sCurve(m, p.contrast ?? 0.3);
            return [s, s, s];
        },
    },
    {
        id: "fx_sepia", category: "color", name: "Sepia", params: [amountParam(0.8)],
        lut: (p) => (c) => clampRgb(mixRgb(c, [
            c[0] * 0.393 + c[1] * 0.769 + c[2] * 0.189,
            c[0] * 0.349 + c[1] * 0.686 + c[2] * 0.168,
            c[0] * 0.272 + c[1] * 0.534 + c[2] * 0.131,
        ], p.amount ?? 0.8)),
    },
    {
        id: "fx_duotone", category: "color", name: "Duotone", params: [slider("hue", "Hue", 0, 1, 0.6), amountParam(1)],
        lut: (p) => {
            const hue = p.hue ?? 0.6;
            const dark = hueColor(hue, 0.18);
            const light = hueColor((hue + 0.45) % 1, 0.92);
            return (c) => clampRgb(mixRgb(c, gradientMap(c, dark, light), p.amount ?? 1));
        },
    },
    {
        id: "fx_edge_glow", category: "color", name: "Edge glow", params: [amountParam(0.7)],
        passes: [pass((ch) => {
            const edge = div(add(abs(sub(luma(add(X, 1), Y), luma(sub(X, 1), Y))), abs(sub(luma(X, add(Y, 1)), luma(X, sub(Y, 1))))), 255);
            const glow = [0.45, 0.85, 1][ch] ?? 1;
            return add(mul(S(ch), sub(1, mul(AMOUNT, 0.5))), mul(clip(mul(edge, 3), 0, 1), AMOUNT, 255 * glow));
        })],
    },
    // ── motion ──
    {
        id: "fx_shake", category: "motion", name: "Shake", params: [amountParam(0.5), speedParam(1)],
        passes: [pass((ch) => {
            const t = mul(T, SPEED);
            const dx = mul(AMOUNT, W, 0.02, add(sin(mul(t, 31)), mul(0.5, sin(mul(t, 17)))));
            const dy = mul(AMOUNT, H, 0.02, add(cos(mul(t, 27)), mul(0.5, sin(mul(t, 13)))));
            return zoomAbout(ch, add(1, mul(AMOUNT, 0.06)), dx, dy);
        })],
    },
    {
        id: "fx_zoom_pulse", category: "motion", name: "Zoom pulse", params: [amountParam(0.5), speedParam(1)],
        passes: [pass((ch) => zoomAbout(ch, add(1, mul(AMOUNT, 0.12, sub(0.5, mul(0.5, cos(mul(T, SPEED, 2 * Math.PI))))))))],
    },
    {
        id: "fx_strobe", category: "motion", name: "Strobe", params: [amountParam(0.7), slider("speed", "Rate", 1, 12, 6)],
        passes: [pass((ch) => iff(gt(mod(mul(T, SPEED), 1), 0.5), mul(S(ch), sub(1, AMOUNT)), S(ch)))],
    },
    {
        id: "fx_flash", category: "motion", name: "Flash", params: [amountParam(0.8), slider("speed", "Rate", 0.25, 4, 1)],
        passes: [pass((ch) => {
            const f = pow(max(0, sub(1, mul(mod(mul(T, SPEED), 1), 4))), 2);
            return add(S(ch), mul(sub(255, S(ch)), f, AMOUNT));
        })],
    },
    {
        id: "fx_vignette_pulse", category: "motion", name: "Vignette pulse", params: [amountParam(0.7), speedParam(1)],
        passes: [pass((ch) => {
            const inner = add(0.3, mul(0.15, sin(mul(T, SPEED, 2 * Math.PI))));
            return mul(S(ch), sub(1, mul(AMOUNT, 0.9, smoothstepExpr(inner, 1.1, radius01()))));
        })],
    },
    // ── retro ──
    {
        id: "fx_vhs", category: "retro", name: "VHS", params: [amountParam(0.6)],
        passes: [pass((ch) => {
            const wobble = mul(AMOUNT, 3, sin(add(mul(Y, 0.05), mul(T, 10))));
            const tear = mul(AMOUNT, W, 0.03, gt(hash(floor(div(Y, 6)), STEP, 3), 0.97));
            const shift = mul(AMOUNT, W, 0.004, ch === 0 ? 1 : ch === 2 ? -1 : 0);
            const value = S(ch, add(X, wobble, tear, shift));
            const scan = sub(1, mul(AMOUNT, 0.18, imod(Y, 2)));
            const noise = mul(AMOUNT, 18, sub(hash(X, Y, STEP), 0.5));
            return add(mul(value, scan), noise);
        })],
    },
    {
        id: "fx_film_grain", category: "retro", name: "Film grain", params: [amountParam(0.5)],
        passes: [pass((ch) => add(S(ch), mul(AMOUNT, 60, sub(hash(X, Y, STEP), 0.5))))],
    },
    {
        id: "fx_old_film", category: "retro", name: "Old film", params: [amountParam(0.7)],
        passes: [pass((ch) => {
            const l = luma();
            const tone = [1.07, 0.95, 0.78][ch] ?? 1;
            const graded = mix(S(ch), mul(l, tone), AMOUNT);
            const flicker = add(1, mul(AMOUNT, 0.06, sin(mul(T, 47))));
            const scratch = mul(AMOUNT, gt(hash(floor(div(X, 3)), STEP, 11), 0.995), 90);
            const vig = sub(1, mul(AMOUNT, 0.5, smoothstepExpr(0.4, 1.2, radius01())));
            return add(mul(graded, flicker, vig), scratch);
        })],
    },
    {
        id: "fx_light_leak", category: "retro", name: "Light leak", params: [amountParam(0.6), speedParam(0.5)],
        passes: [pass((ch) => {
            const cx = add(0.5, mul(0.45, sin(mul(T, SPEED, 1.3))));
            const cy = add(0.35, mul(0.3, cos(mul(T, SPEED, 0.9))));
            const du = sub(div(X, W), cx);
            const dv = sub(div(Y, H), cy);
            const d = sqrt(add(mul(du, du), mul(dv, dv)));
            const leak = mul(AMOUNT, pow(max(0, sub(1, div(d, 0.7))), 2), [255, 150, 70][ch] ?? 0);
            // screen blend: c + leak - c * leak / 255
            return sub(add(S(ch), leak), div(mul(S(ch), leak), 255));
        })],
    },
    // ── glitch ──
    {
        id: "fx_rgb_split", category: "glitch", name: "RGB split", params: [amountParam(0.5), slider("speed", "Wobble", 0, 4, 0)],
        passes: [pass((ch) => {
            const d = mul(AMOUNT, W, 0.012, add(1, mul(0.5, sin(mul(T, SPEED, 6)))));
            return S(ch, add(X, mul(d, ch === 0 ? 1 : ch === 2 ? -1 : 0)), Y);
        })],
    },
    {
        id: "fx_glitch", category: "glitch", name: "Glitch", params: [amountParam(0.6), slider("speed", "Rate", 1, 24, 12)],
        passes: [pass((ch) => {
            const step = imod(floor(add(mul(T, SPEED), 0.37)), 4096);
            const rows = floor(div(Y, max(1, floor(div(H, 24)))));
            const h1 = hash(rows, step, 5);
            const h2 = hash(rows, step, 9);
            const active = gt(h2, sub(1, mul(AMOUNT, 0.35)));
            const shift = mul(active, sub(h1, 0.5), W, 0.2, AMOUNT);
            const split = mul(active, AMOUNT, W, 0.01, ch === 0 ? 1 : ch === 2 ? -1 : 0);
            return S(ch, add(X, shift, split), Y);
        })],
    },
];

function smoothstepExpr(e0: ExprLike, e1: ExprLike, x: ExprLike): Expr {
    const t = clip(div(sub(x, e0), sub(e1, e0)), 0, 1);
    return mul(t, t, sub(3, mul(2, t)));
}

/** A saturated color for `hue` (0..1) at lightness-ish `level` (0..1). */
function hueColor(hue: number, level: number): Rgb {
    const k = (n: number) => (n + hue * 6) % 6;
    const f = (n: number) => 1 - Math.max(0, Math.min(k(n), 4 - k(n), 1));
    const base: Rgb = [f(5), f(3), f(1)];
    return level < 0.5 ? [base[0] * level * 2, base[1] * level * 2, base[2] * level * 2] : [
        base[0] + (1 - base[0]) * (level - 0.5) * 2, base[1] + (1 - base[1]) * (level - 0.5) * 2, base[2] + (1 - base[2]) * (level - 0.5) * 2,
    ];
}

const BY_ID = new Map(EFFECTS.map((effect) => [effect.id, effect]));

export function effectById(id: string | null | undefined): EffectDefinition | null {
    return id ? BY_ID.get(id) ?? null : null;
}

export function isBuiltinEffect(id: string | null | undefined): boolean {
    return Boolean(id && BY_ID.has(id));
}

/** Param values for a stack row: JSON values clamped to the param ranges, defaults for the rest. */
export function effectParams(effect: EffectDefinition, paramsJson: string | null | undefined): Record<string, number> {
    let parsed: Record<string, unknown> = {};
    if (paramsJson) {
        try {
            const value = JSON.parse(paramsJson);
            if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
        } catch {
            parsed = {};
        }
    }
    const out: Record<string, number> = {};
    for (const p of effect.params) {
        const raw = parsed[p.key];
        const value = typeof raw === "boolean" ? (raw ? 1 : 0) : typeof raw === "number" && Number.isFinite(raw) ? raw : p.default;
        out[p.key] = Math.min(p.max, Math.max(p.min, value));
    }
    return out;
}

/** Legacy renderer contract: a pass-through body, so an older host that does not know built-ins shows the frame. */
const PASSTHROUGH_GLSL = "vec4 effect(sampler2D tex, vec2 uv) { return texture2D(tex, uv); }";

/** The built-ins as EffectDef rows (backend listEffects("effect"), MCP list_visual_effects). */
export function builtinEffectDefs(): EffectDef[] {
    return EFFECTS.map((effect) => ({
        id: effect.id,
        name: effect.name,
        kind: "effect" as const,
        category: effect.category,
        params: effect.params.map((p) => ({ ...p })),
        glsl: PASSTHROUGH_GLSL,
        thumbnail: null,
        ownerScope: "builtin",
    }));
}
