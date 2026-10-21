// Expression IR for looks (phase 10a). Every transition and effect is written once as an expression
// tree and compiled to three backends that must agree pixel for pixel:
//   - GLSL ES 3.00 for the preview's WebGL2 renderer (timeline-media/looks),
//   - ffmpeg expressions for the export: `geq` (effects) and `xfade=transition=custom` (transitions),
//   - a JS evaluator (double precision, like ffmpeg's av_expr_eval) used as the test reference.
//
// Values are 8-bit channel levels (0..255). Coordinates are pixel indices with (0,0) at the top-left
// pixel, as in ffmpeg's X/Y. The one sampling primitive, `sample`, has ffmpeg's nearest semantics
// (geq i=n and xfade a0..b3): clip x to [0, w-1] and y to [0, h-1], truncate, read the level.

export type Var = "X" | "Y" | "W" | "H" | "T" | "p";

export type Fn =
    | "sin" | "cos" | "atan2" | "sqrt" | "abs" | "floor" | "trunc" | "exp" | "log" | "pow"
    | "min" | "max" | "clip" | "mod" | "gt" | "lt" | "gte" | "lte" | "hypot"
    /** mod of non-negative integer values below 2^24 (exact in float32 GLSL through int %). */
    | "imod";

/** Channel index in RGBA order. */
export type Channel = 0 | 1 | 2 | 3;

export type Expr =
    | { k: "num"; v: number }
    | { k: "var"; name: Var }
    | { k: "param"; name: string }
    | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Expr; b: Expr }
    | { k: "call"; fn: Fn; args: Expr[] }
    /** c != 0 ? a : b (lazy in every backend). */
    | { k: "if"; c: Expr; a: Expr; b: Expr }
    /** src 0: the input (effects) or the outgoing frame A (transitions); src 1: the incoming frame B. */
    | { k: "sample"; src: 0 | 1; ch: Channel; x: Expr; y: Expr }
    | { k: "let"; id: number; value: Expr; body: Expr }
    | { k: "ref"; id: number };

const ARITY: Record<Fn, number> = {
    sin: 1, cos: 1, atan2: 2, sqrt: 1, abs: 1, floor: 1, trunc: 1, exp: 1, log: 1, pow: 2,
    min: 2, max: 2, clip: 3, mod: 2, gt: 2, lt: 2, gte: 2, lte: 2, hypot: 2, imod: 2,
};

// ── builders ─────────────────────────────────────────────

export type ExprLike = Expr | number;

export const toExpr = (e: ExprLike): Expr => (typeof e === "number" ? { k: "num", v: e } : e);
export const n = (v: number): Expr => ({ k: "num", v });
export const v = (name: Var): Expr => ({ k: "var", name });
export const param = (name: string): Expr => {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) throw new Error(`invalid parameter name: ${name}`);
    return { k: "param", name };
};
const bin = (op: "+" | "-" | "*" | "/", a: ExprLike, b: ExprLike): Expr => ({ k: "bin", op, a: toExpr(a), b: toExpr(b) });
export const add = (...xs: ExprLike[]): Expr => xs.map(toExpr).reduce((acc, x) => bin("+", acc, x));
export const sub = (a: ExprLike, b: ExprLike): Expr => bin("-", a, b);
export const mul = (...xs: ExprLike[]): Expr => xs.map(toExpr).reduce((acc, x) => bin("*", acc, x));
export const div = (a: ExprLike, b: ExprLike): Expr => bin("/", a, b);
export const call = (fn: Fn, ...args: ExprLike[]): Expr => {
    if (args.length !== ARITY[fn]) throw new Error(`${fn} takes ${ARITY[fn]} arguments`);
    return { k: "call", fn, args: args.map(toExpr) };
};
export const iff = (c: ExprLike, a: ExprLike, b: ExprLike): Expr => ({ k: "if", c: toExpr(c), a: toExpr(a), b: toExpr(b) });
export const sample = (src: 0 | 1, ch: Channel, x: ExprLike, y: ExprLike): Expr => ({ k: "sample", src, ch, x: toExpr(x), y: toExpr(y) });

export const sin = (x: ExprLike) => call("sin", x);
export const cos = (x: ExprLike) => call("cos", x);
export const atan2 = (y: ExprLike, x: ExprLike) => call("atan2", y, x);
export const sqrt = (x: ExprLike) => call("sqrt", x);
export const abs = (x: ExprLike) => call("abs", x);
export const floor = (x: ExprLike) => call("floor", x);
export const trunc = (x: ExprLike) => call("trunc", x);
export const exp = (x: ExprLike) => call("exp", x);
export const pow = (x: ExprLike, y: ExprLike) => call("pow", x, y);
export const min = (a: ExprLike, b: ExprLike) => call("min", a, b);
export const max = (a: ExprLike, b: ExprLike) => call("max", a, b);
export const clip = (x: ExprLike, lo: ExprLike, hi: ExprLike) => call("clip", x, lo, hi);
export const mod = (a: ExprLike, b: ExprLike) => call("mod", a, b);
/** Integer mod for hashes: both values must be non-negative integers below 2^24. */
export const imod = (a: ExprLike, b: ExprLike) => call("imod", a, b);
export const gt = (a: ExprLike, b: ExprLike) => call("gt", a, b);
export const lt = (a: ExprLike, b: ExprLike) => call("lt", a, b);
export const gte = (a: ExprLike, b: ExprLike) => call("gte", a, b);
export const lte = (a: ExprLike, b: ExprLike) => call("lte", a, b);
export const hypot = (a: ExprLike, b: ExprLike) => call("hypot", a, b);
export const neg = (x: ExprLike) => sub(0, x);
/** a + (b - a) * t */
export const mix = (a: ExprLike, b: ExprLike, t: ExprLike) => add(a, mul(sub(b, a), t));
export const clamp01 = (x: ExprLike) => clip(x, 0, 1);
/** Hermite smoothstep of x in [e0, e1]. */
export function smoothstep(e0: number, e1: number, x: ExprLike): Expr {
    const t = clamp01(div(sub(x, e0), e1 - e0));
    return mul(t, t, sub(3, mul(2, t)));
}

/**
 * Binds `value` to a fresh slot for use inside `body(ref)`. ffmpeg stores it with st()/ld() (geq has
 * per-job expressions; custom xfade shares one AVExpr across slice threads, so it always runs with
 * threads=1 — see XFADE_THREADS); GLSL declares a local.
 */
let symbols = 0;

export function bind(value: ExprLike, body: (ref: Expr) => ExprLike): Expr {
    symbols += 1;
    const id = symbols;
    return { k: "let", id, value: toExpr(value), body: toExpr(body({ k: "ref", id })) };
}

/** Deepest nesting of bindings (ffmpeg allows ten: st/ld 0-9). */
export function letDepth(e: Expr): number {
    switch (e.k) {
        case "let": return Math.max(letDepth(e.value), 1 + letDepth(e.body));
        case "bin": return Math.max(letDepth(e.a), letDepth(e.b));
        case "call": return Math.max(0, ...e.args.map(letDepth));
        case "if": return Math.max(letDepth(e.c), letDepth(e.a), letDepth(e.b));
        case "sample": return Math.max(letDepth(e.x), letDepth(e.y));
        default: return 0;
    }
}

export function walk(e: Expr, visit: (node: Expr) => void): void {
    visit(e);
    switch (e.k) {
        case "bin": walk(e.a, visit); walk(e.b, visit); break;
        case "call": e.args.forEach((arg) => walk(arg, visit)); break;
        case "if": walk(e.c, visit); walk(e.a, visit); walk(e.b, visit); break;
        case "sample": walk(e.x, visit); walk(e.y, visit); break;
        case "let": walk(e.value, visit); walk(e.body, visit); break;
        default: break;
    }
}

/** Parameter names an expression reads. */
export function paramsOf(e: Expr): string[] {
    const names = new Set<string>();
    walk(e, (node) => {
        if (node.k === "param") names.add(node.name);
    });
    return [...names].sort();
}

/** True when the expression samples source `src` anywhere. */
export function samplesSource(e: Expr, src: 0 | 1): boolean {
    let found = false;
    walk(e, (node) => {
        if (node.k === "sample" && node.src === src) found = true;
    });
    return found;
}

/** The 8-bit output of a channel: ffmpeg truncates on store, so round explicitly (and avoid UB outside 0..255). */
export function channelOut(e: ExprLike): Expr {
    return add(clip(e, 0, 255), 0.5);
}

// ── JS evaluator (the reference) ─────────────────────────

export interface EvalEnv {
    X: number;
    Y: number;
    W: number;
    H: number;
    T?: number;
    p?: number;
    params?: Record<string, number>;
    /** Level of channel `ch` of source `src` at already-clipped integer pixel (xi, yi). */
    read(src: 0 | 1, ch: Channel, xi: number, yi: number): number;
    /** Source size when it differs from the output (defaults to W×H). */
    sourceSize?(src: 0 | 1): { w: number; h: number };
}

/** ffmpeg av_clipd + (int) conversion for non-negative values. */
export function clipIndex(value: number, size: number): number {
    if (!(value > 0)) return 0; // NaN and negatives clip to 0
    return Math.trunc(Math.min(value, size - 1));
}

// The functions of the IR as av_expr_eval computes them (shared by evaluate and compileExpr, so both agree exactly).
const UNARY: Partial<Record<Fn, (x: number) => number>> = {
    sin: Math.sin, cos: Math.cos, sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, trunc: Math.trunc, exp: Math.exp, log: Math.log,
};
// eval.c e_mod: d - floor(d / d2) * d2
const modFn = (a: number, b: number) => a - Math.floor(b ? a / b : a * Infinity) * b;
const BINARY: Partial<Record<Fn, (a: number, b: number) => number>> = {
    atan2: Math.atan2, pow: Math.pow, min: Math.min, max: Math.max, mod: modFn, imod: modFn, hypot: Math.hypot,
    gt: (a, b) => (a > b ? 1 : 0), lt: (a, b) => (a < b ? 1 : 0), gte: (a, b) => (a >= b ? 1 : 0), lte: (a, b) => (a <= b ? 1 : 0),
};
// av_clipd(a, amin, amax): amin > a ? amin : (amax < a ? amax : a)
const clipFn = (x: number, lo: number, hi: number) => (lo > x ? lo : hi < x ? hi : x);

function applyFn(fn: Fn, x: number[]): number {
    const unary = UNARY[fn];
    if (unary) return unary(x[0]);
    const binary = BINARY[fn];
    if (binary) return binary(x[0], x[1]);
    return clipFn(x[0], x[1], x[2]);
}

export function evaluate(e: Expr, env: EvalEnv, lets: Map<number, number> = new Map()): number {
    switch (e.k) {
        case "num": return e.v;
        case "var": {
            if (e.name === "T") return env.T ?? 0;
            if (e.name === "p") return env.p ?? 0;
            return env[e.name];
        }
        case "param": {
            const value = env.params?.[e.name];
            if (value === undefined) throw new Error(`missing parameter ${e.name}`);
            return value;
        }
        case "bin": {
            const a = evaluate(e.a, env, lets);
            const b = evaluate(e.b, env, lets);
            if (e.op === "+") return a + b;
            if (e.op === "-") return a - b;
            if (e.op === "*") return a * b;
            return a / b;
        }
        case "call": return applyFn(e.fn, e.args.map((arg) => evaluate(arg, env, lets)));
        case "if": return evaluate(e.c, env, lets) !== 0 ? evaluate(e.a, env, lets) : evaluate(e.b, env, lets);
        case "sample": {
            const size = env.sourceSize?.(e.src) ?? { w: env.W, h: env.H };
            const x = clipIndex(evaluate(e.x, env, lets), size.w);
            const y = clipIndex(evaluate(e.y, env, lets), size.h);
            return env.read(e.src, e.ch, x, y);
        }
        case "let": {
            const inner = new Map(lets);
            inner.set(e.id, evaluate(e.value, env, lets));
            return evaluate(e.body, env, inner);
        }
        case "ref": {
            const value = lets.get(e.id);
            if (value === undefined) throw new Error(`unbound slot ${e.id}`);
            return value;
        }
    }
}

/** Pixel state of a compiled expression. */
interface CompiledState {
    X: number;
    Y: number;
    W: number;
    H: number;
    T: number;
    slots: Float64Array;
}

type Compiled = { constant: true; value: number } | { constant: false; run(s: CompiledState): number };

/**
 * The expression as a JS function of (X, Y, W, H, T) with `params` folded in: exactly the numbers `evaluate`
 * returns (the same operations in the same order, constant subtrees computed once), without walking the tree
 * per pixel. Generated mask images (looks/masks.ts) evaluate millions of pixels with it. No samples, no `p`.
 */
export function compileExpr(
    e: Expr, params: Record<string, number> = {}, fixed: Partial<Record<"W" | "H" | "T", number>> = {},
): (X: number, Y: number, W: number, H: number, T?: number) => number {
    const constant = (value: number): Compiled => ({ constant: true, value });
    const runner = (c: Compiled): ((s: CompiledState) => number) => {
        if (c.constant) {
            const value = c.value;
            return () => value;
        }
        return c.run;
    };
    const lets = new Map<number, Compiled>();
    let slotCount = 0;
    const compile = (node: Expr): Compiled => {
        switch (node.k) {
            case "num": return constant(node.v);
            case "var": {
                const known = node.name === "W" || node.name === "H" || node.name === "T" ? fixed[node.name] : undefined;
                if (known !== undefined) return constant(known);
                switch (node.name) {
                    case "X": return { constant: false, run: (s) => s.X };
                    case "Y": return { constant: false, run: (s) => s.Y };
                    case "W": return { constant: false, run: (s) => s.W };
                    case "H": return { constant: false, run: (s) => s.H };
                    case "T": return { constant: false, run: (s) => s.T };
                    default: throw new Error("progress is only defined in transitions");
                }
            }
            case "param": {
                const value = params[node.name];
                if (value === undefined) throw new Error(`missing parameter ${node.name}`);
                return constant(value);
            }
            case "bin": {
                const a = compile(node.a);
                const b = compile(node.b);
                const op = node.op;
                const apply = (x: number, y: number) => (op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y);
                if (a.constant && b.constant) return constant(apply(a.value, b.value));
                const ra = runner(a);
                const rb = runner(b);
                if (op === "+") return { constant: false, run: (s) => ra(s) + rb(s) };
                if (op === "-") return { constant: false, run: (s) => ra(s) - rb(s) };
                if (op === "*") return { constant: false, run: (s) => ra(s) * rb(s) };
                return { constant: false, run: (s) => ra(s) / rb(s) };
            }
            case "call": {
                const args = node.args.map(compile);
                const fn = node.fn;
                if (args.every((arg) => arg.constant)) return constant(applyFn(fn, args.map((arg) => (arg as { value: number }).value)));
                const runs = args.map(runner);
                const unary = UNARY[fn];
                if (unary) {
                    const [r0] = runs;
                    return { constant: false, run: (s) => unary(r0(s)) };
                }
                const binary = BINARY[fn];
                if (binary) {
                    const [r0, r1] = runs;
                    return { constant: false, run: (s) => binary(r0(s), r1(s)) };
                }
                const [r0, r1, r2] = runs;
                return { constant: false, run: (s) => clipFn(r0(s), r1(s), r2(s)) };
            }
            case "if": {
                const c = compile(node.c);
                const a = compile(node.a);
                const b = compile(node.b);
                if (c.constant) return c.value !== 0 ? a : b;
                const rc = runner(c);
                const ra = runner(a);
                const rb = runner(b);
                return { constant: false, run: (s) => (rc(s) !== 0 ? ra(s) : rb(s)) };
            }
            case "sample": throw new Error("compiled expressions cannot sample pixels");
            case "let": {
                const value = compile(node.value);
                if (value.constant) {
                    lets.set(node.id, value);
                    return compile(node.body);
                }
                const slot = slotCount++;
                lets.set(node.id, { constant: false, run: (s) => s.slots[slot] });
                const body = runner(compile(node.body));
                const rv = value.run;
                return { constant: false, run: (s) => {
                    s.slots[slot] = rv(s);
                    return body(s);
                } };
            }
            case "ref": {
                const bound = lets.get(node.id);
                if (!bound) throw new Error(`unbound slot ${node.id}`);
                return bound;
            }
        }
    };
    const run = runner(compile(e));
    const state: CompiledState = { X: 0, Y: 0, W: 0, H: 0, T: 0, slots: new Float64Array(slotCount) };
    return (X, Y, W, H, T = 0) => {
        state.X = X;
        state.Y = Y;
        state.W = W;
        state.H = H;
        state.T = T;
        return run(state);
    };
}

/** A scalar expression (no pixels) at time `t` seconds: the preview's side of every motion curve. */
export function evaluateScalar(e: Expr, t: number, params?: Record<string, number>): number {
    return evaluate(e, {
        X: 0, Y: 0, W: 0, H: 0, T: t, params,
        read: () => {
            throw new Error("scalar expressions cannot sample pixels");
        },
    });
}

// ── ffmpeg emitter ───────────────────────────────────────

/** A number for an ffmpeg expression: plain decimal, parenthesized when negative. */
export function ffNumber(value: number): string {
    if (!Number.isFinite(value)) throw new Error(`non-finite constant ${value}`);
    let text = Number.isInteger(value) ? String(value) : value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
    if (text === "-0") text = "0";
    return text.startsWith("-") ? `(${text})` : text;
}

export type FfmpegTarget =
    /** geq in RGB mode: r(x,y) g(x,y) b(x,y) alpha(x,y). */
    | { target: "geq" }
    /** xfade custom on gbrp/gbrap: planes G,B,R,A = a0,a1,a2,a3 (b* for the second input). `channel` is the plane being written. */
    | { target: "xfade"; channel: Channel }
    /**
     * A per-frame scalar option (overlay x/y, scale w/h, rotate, crop x/y, setpts, volume, geq alpha factor): `T` becomes
     * `time` (e.g. "t", "T", "(n/30)"), bindings are inlined (no st/ld state shared across threads), no pixel access.
     */
    | { target: "scalar"; time: string };

const GEQ_READERS = ["r", "g", "b", "alpha"] as const;
/** RGBA channel → gbrp plane index. */
export const GBRP_PLANE: Record<Channel, number> = { 0: 2, 1: 0, 2: 1, 3: 3 };

export interface FfmpegEmitOptions {
    params?: Record<string, number>;
    /** Time offset folded into T (effect-track spans read the composite's clock). */
    timeOffset?: number;
    /** geq only: the text written for T (e.g. a frame-snapped clock); default "T". */
    timeVar?: string;
    /**
     * geq / xfade: a binding may take the st/ld slot of an enclosing binding that is dead from there on (masks,
     * phase 10c). Only bindings reached through a chain of let bodies qualify (everything after the new st() is
     * then the new binding's body), so a slot is never overwritten while a later read is pending.
     */
    reuseSlots?: boolean;
}

/** Ids of bindings referenced in `e`. */
function referencedIds(e: Expr): Set<number> {
    const ids = new Set<number>();
    walk(e, (node) => {
        if (node.k === "ref") ids.add(node.id);
    });
    return ids;
}

export function emitFfmpeg(e: Expr, target: FfmpegTarget, options: FfmpegEmitOptions = {}): string {
    // Scalar target: a binding's value text, referenced by a negative slot (-1 - index into `inlined`).
    const inlined: string[] = [];
    // A binding's slot is its nesting depth: siblings reuse slots, nested ones never collide. With reuseSlots,
    // `chain` holds the bindings whose body we are in through let bodies only (see FfmpegEmitOptions).
    const NO_CHAIN: ReadonlySet<number> = new Set();
    const out = (node: Expr, lets: Map<number, number>, chain: ReadonlySet<number> = NO_CHAIN): string => {
        switch (node.k) {
            case "num": return ffNumber(node.v);
            case "var": {
                if (target.target === "scalar") {
                    if (node.name === "T") return options.timeOffset ? `(${target.time}-${ffNumber(options.timeOffset)})` : target.time;
                    if (node.name === "p") throw new Error("progress is only defined in transitions");
                    throw new Error(`pixel variable ${node.name} is not defined in scalar expressions`);
                }
                if (node.name === "p") {
                    if (target.target !== "xfade") throw new Error("progress is only defined in transitions");
                    return "(1-P)";
                }
                if (node.name === "T") {
                    if (target.target === "xfade") throw new Error("time is not defined in transitions");
                    const time = options.timeVar ?? "T";
                    return options.timeOffset ? `(${time}-${ffNumber(options.timeOffset)})` : time;
                }
                return node.name;
            }
            case "param": {
                const value = options.params?.[node.name];
                if (value === undefined) throw new Error(`missing parameter ${node.name}`);
                return ffNumber(value);
            }
            case "bin": return `(${out(node.a, lets)}${node.op}${out(node.b, lets)})`;
            case "call": return `${node.fn === "imod" ? "mod" : node.fn}(${node.args.map((arg) => out(arg, lets)).join(",")})`;
            case "if": return `if(${out(node.c, lets)},${out(node.a, lets)},${out(node.b, lets)})`;
            case "sample": {
                if (target.target === "scalar") throw new Error("scalar expressions cannot sample pixels");
                const x = out(node.x, lets);
                const y = out(node.y, lets);
                if (target.target === "geq") {
                    if (node.src !== 0) throw new Error("geq reads one input");
                    return `${GEQ_READERS[node.ch]}(${x},${y})`;
                }
                // xfade: A/B are the current plane's values at (X, Y) — cheaper than a0(X,Y).
                if (node.ch === target.channel && node.x.k === "var" && node.x.name === "X" && node.y.k === "var" && node.y.name === "Y") {
                    return node.src === 0 ? "A" : "B";
                }
                return `${node.src === 0 ? "a" : "b"}${GBRP_PLANE[node.ch]}(${x},${y})`;
            }
            case "let": {
                if (target.target === "scalar") {
                    inlined.push(out(node.value, lets));
                    return out(node.body, new Map(lets).set(node.id, -inlined.length));
                }
                if (options.reuseSlots) {
                    const live = referencedIds(node.body);
                    const inner = new Map<number, number>();
                    for (const [id, slot] of lets) if (!chain.has(id) || live.has(id)) inner.set(id, slot);
                    const taken = new Set(inner.values());
                    let slot = 0;
                    while (taken.has(slot)) slot += 1;
                    if (slot > 9) throw new Error("ffmpeg expressions have ten variables (st/ld 0-9)");
                    inner.set(node.id, slot);
                    const nextChain = new Set([...chain].filter((id) => inner.has(id)));
                    nextChain.add(node.id);
                    return `(st(${slot},${out(node.value, lets)});${out(node.body, inner, nextChain)})`;
                }
                const slot = lets.size;
                if (slot > 9) throw new Error("ffmpeg expressions have ten variables (st/ld 0-9)");
                const inner = new Map(lets);
                inner.set(node.id, slot);
                return `(st(${slot},${out(node.value, lets)});${out(node.body, inner)})`;
            }
            case "ref": {
                const slot = lets.get(node.id);
                if (slot === undefined) throw new Error(`unbound binding ${node.id}`);
                if (slot < 0) return inlined[-1 - slot];
                return `ld(${slot})`;
            }
        }
    };
    return out(e, new Map());
}

/**
 * Custom xfade evaluates one shared AVExpr from every slice thread; the expressions keep values with
 * st()/ld(), so the filter must run on one thread (the wasm core is single-threaded anyway).
 */
export const XFADE_THREADS = "threads=1";

/** One xfade custom expression for all planes of gbrp (3 channels) or gbrap (4). */
export function xfadeExpression(channels: (ch: Channel) => Expr, planes: 3 | 4): string {
    const parts = ([1, 2, 0, 3] as Channel[]).slice(0, planes).map((ch) => emitFfmpeg(channelOut(channels(ch)), { target: "xfade", channel: ch }));
    // plane 0 = G, 1 = B, 2 = R, 3 = A
    if (planes === 3) return `if(eq(PLANE,0),${parts[0]},if(eq(PLANE,1),${parts[1]},${parts[2]}))`;
    return `if(eq(PLANE,0),${parts[0]},if(eq(PLANE,1),${parts[1]},if(eq(PLANE,2),${parts[2]},${parts[3]})))`;
}

/** geq options for an RGB(A) pass: `i=n` (nearest, the IR's sampling) and one expression per channel. */
export function geqOptions(channels: (ch: Channel) => Expr, options: FfmpegEmitOptions & { alpha?: boolean } = {}): string {
    const expr = (ch: Channel) => emitFfmpeg(channelOut(channels(ch)), { target: "geq" }, options);
    const parts = [`i=n`, `r='${expr(0)}'`, `g='${expr(1)}'`, `b='${expr(2)}'`];
    if (options.alpha) parts.push(`a='alpha(X,Y)'`);
    return parts.join(":");
}

// ── GLSL emitter ─────────────────────────────────────────

export function glslNumber(value: number): string {
    if (!Number.isFinite(value)) throw new Error(`non-finite constant ${value}`);
    const text = Number.isInteger(value) ? `${value}.0` : String(Number(value.toPrecision(9)));
    const fixed = text.includes("e") ? value.toFixed(12).replace(/0+$/, "") : text;
    const withPoint = fixed.includes(".") ? fixed : `${fixed}.0`;
    return withPoint.startsWith("-") ? `(${withPoint})` : withPoint;
}

const GLSL_FN: Partial<Record<Fn, string>> = { atan2: "atan", clip: "clamp", trunc: "trunc" };

/**
 * GLSL for one channel: statements (let slots) and the final expression. Variables X Y W H T p are
 * floats in scope; params are uniforms `u_<name>`; samples call `S0(ch, x, y)` / `S1(…)`.
 */
export function emitGlsl(e: Expr): { statements: string[]; expr: string } {
    const statements: string[] = [];
    const declared = new Set<number>();
    const out = (node: Expr): string => {
        switch (node.k) {
            case "num": return glslNumber(node.v);
            case "var": return node.name;
            case "param": return `u_${node.name}`;
            case "bin": return `(${out(node.a)}${node.op}${out(node.b)})`;
            case "call": {
                const args = node.args.map(out);
                switch (node.fn) {
                    case "gt": return `float(${args[0]}>${args[1]})`;
                    case "lt": return `float(${args[0]}<${args[1]})`;
                    case "gte": return `float(${args[0]}>=${args[1]})`;
                    case "lte": return `float(${args[0]}<=${args[1]})`;
                    // ffmpeg mod: d - floor(d/d2)*d2 (GLSL mod is the same formula)
                    case "mod": return `mod(${args[0]},${args[1]})`;
                    case "imod": return `float(int(${args[0]})%int(${args[1]}))`;
                    case "hypot": return `length(vec2(${args[0]},${args[1]}))`;
                    default: return `${GLSL_FN[node.fn] ?? node.fn}(${args.join(",")})`;
                }
            }
            case "if": return `((${out(node.c)})!=0.0?(${out(node.a)}):(${out(node.b)}))`;
            case "sample": return `S${node.src}(${node.ch},${out(node.x)},${out(node.y)})`;
            case "let": {
                const value = out(node.value);
                const name = `l${node.id}_${statements.length}`;
                statements.push(`float ${name}=${value};`);
                letNames.set(node.id, [...(letNames.get(node.id) ?? []), name]);
                const body = out(node.body);
                letNames.get(node.id)!.pop();
                declared.add(node.id);
                return body;
            }
            case "ref": {
                const names = letNames.get(node.id);
                const name = names?.[names.length - 1];
                if (!name) throw new Error(`unbound slot ${node.id}`);
                return name;
            }
        }
    };
    const letNames = new Map<number, string[]>();
    const expr = out(e);
    return { statements, expr };
}
