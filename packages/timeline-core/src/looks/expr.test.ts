import { describe, expect, it } from "vitest";
import {
    add, bind, channelOut, clip, div, emitFfmpeg, emitGlsl, evaluate, ffNumber, geqOptions, glslNumber, gt, iff, mod, mul, n, param,
    letDepth, paramsOf, sample, sin, sub, v, xfadeExpression, evaluateScalar, type EvalEnv,
    compileExpr, cos, hypot, abs, floor, max, min, sqrt, lt,
} from "./expr";

function env(over: Partial<EvalEnv> = {}): EvalEnv {
    return { X: 3, Y: 2, W: 8, H: 4, T: 0.5, p: 0.25, params: {}, read: (src, ch, x, y) => src * 1000 + ch * 100 + y * 10 + x, ...over };
}

describe("expr builders and evaluator", () => {
    it("evaluates arithmetic, functions, and variables like av_expr_eval", () => {
        expect(evaluate(add(v("X"), mul(v("Y"), 2)), env())).toBe(7);
        expect(evaluate(div(1, 4), env())).toBe(0.25);
        expect(evaluate(sin(0), env())).toBe(0);
        expect(evaluate(mod(-1, 3), env())).toBe(2);
        expect(evaluate(mod(7.5, 2), env())).toBe(1.5);
        expect(evaluate(clip(300, 0, 255), env())).toBe(255);
        expect(evaluate(gt(v("p"), 0.2), env())).toBe(1);
        expect(evaluate(iff(0, 1, 2), env())).toBe(2);
        expect(evaluate(param("amount"), env({ params: { amount: 0.7 } }))).toBe(0.7);
    });

    it("samples with ffmpeg's clip-and-truncate semantics", () => {
        expect(evaluate(sample(0, 1, 2.9, 1.2), env())).toBe(100 + 10 + 2);
        expect(evaluate(sample(1, 0, -5, 99), env())).toBe(1000 + 30 + 0);
        expect(evaluate(sample(0, 2, 7.99, 0), env())).toBe(200 + 7);
        expect(evaluate(sample(0, 2, Number.NaN, 0), env())).toBe(200);
    });

    it("binds values once and keeps nested slots apart (lets need ten slots at most)", () => {
        const e = bind(add(v("X"), 1), (a) => bind(mul(a, 2), (b) => add(a, b)));
        expect(evaluate(e, env())).toBe(4 + 8);
        expect(letDepth(e)).toBe(2);
        expect(emitFfmpeg(e, { target: "geq" })).toBe("(st(0,(X+1));(st(1,(ld(0)*2));(ld(0)+ld(1))))");
    });

    it("lists parameters", () => {
        expect(paramsOf(add(param("b"), mul(param("a"), param("b"))))).toEqual(["a", "b"]);
        expect(() => param("bad-name")).toThrow();
    });
});

describe("ffmpeg emitter", () => {
    it("formats numbers without exponents and parenthesizes negatives", () => {
        expect(ffNumber(2)).toBe("2");
        expect(ffNumber(0.000001)).toBe("0.000001");
        expect(ffNumber(-0.5)).toBe("(-0.5)");
        expect(ffNumber(-0)).toBe("0");
        expect(() => ffNumber(Number.NaN)).toThrow();
    });

    it("writes geq readers, st/ld for bindings, and the time offset", () => {
        const e = bind(add(v("X"), v("T")), (x) => sample(0, 0, x, v("Y")));
        expect(emitFfmpeg(e, { target: "geq" })).toBe("(st(0,(X+T));r(ld(0),Y))");
        expect(emitFfmpeg(v("T"), { target: "geq" }, { timeOffset: 2 })).toBe("(T-2)");
        expect(emitFfmpeg(param("k"), { target: "geq" }, { params: { k: -1.25 } })).toBe("(-1.25)");
        expect(() => emitFfmpeg(v("p"), { target: "geq" })).toThrow();
        expect(() => emitFfmpeg(sample(1, 0, 0, 0), { target: "geq" })).toThrow();
    });

    it("maps RGBA to gbrp planes in xfade and uses A/B at the current pixel", () => {
        const channels = (ch: 0 | 1 | 2 | 3) => add(mul(sample(0, ch, v("X"), v("Y")), sub(1, v("p"))), mul(sample(1, ch, add(v("X"), 1), v("Y")), v("p")));
        expect(emitFfmpeg(channels(0), { target: "xfade", channel: 0 })).toBe("((A*(1-(1-P)))+(b2((X+1),Y)*(1-P)))");
        const bound = bind(add(v("X"), 1), (x) => sample(1, 1, x, v("Y")));
        expect(emitFfmpeg(bound, { target: "xfade", channel: 1 })).toBe("(st(0,(X+1));b0(ld(0),Y))");
        const full = xfadeExpression(channels, 3);
        expect(full.startsWith("if(eq(PLANE,0),")).toBe(true);
        expect(full).toContain("b0((X+1),Y)");
        expect(full).toContain("b1((X+1),Y)");
        expect(full).toContain("b2((X+1),Y)");
        expect(xfadeExpression(channels, 4)).toContain("b3((X+1),Y)");
    });

    it("clips and rounds channel outputs because ffmpeg truncates on store", () => {
        expect(emitFfmpeg(channelOut(v("X")), { target: "geq" })).toBe("(clip(X,0,255)+0.5)");
        expect(evaluate(channelOut(n(254.6)), env())).toBeCloseTo(255.1);
        expect(geqOptions((ch) => sample(0, ch, v("X"), v("Y")), { alpha: true })).toBe(
            "i=n:r='(clip(r(X,Y),0,255)+0.5)':g='(clip(g(X,Y),0,255)+0.5)':b='(clip(b(X,Y),0,255)+0.5)':a='alpha(X,Y)'",
        );
    });
});

describe("GLSL emitter", () => {
    it("formats floats with a decimal point", () => {
        expect(glslNumber(2)).toBe("2.0");
        expect(glslNumber(-0.25)).toBe("(-0.25)");
        expect(glslNumber(1e-7)).toMatch(/^0\.0+1$/);
    });

    it("emits uniforms, samplers, comparisons, and let statements", () => {
        const e = bind(add(v("X"), param("shift")), (x) => iff(gt(x, v("W")), sample(1, 3, x, v("Y")), mod(x, 2)));
        const { statements, expr } = emitGlsl(e);
        expect(statements).toHaveLength(1);
        const name = statements[0].match(/^float (l\d+_0)=\(X\+u_shift\);$/)![1];
        expect(expr).toBe(`((float(${name}>W))!=0.0?(S1(3,${name},Y)):(mod(${name},2.0)))`);
    });
});

describe("scalar target (motion)", () => {
    it("writes T as the given time variable and inlines bindings", () => {
        const e = bind(mul(v("T"), 2), (r) => add(r, r));
        const text = emitFfmpeg(e, { target: "scalar", time: "t" });
        expect(text).not.toContain("st(");
        expect(text).not.toContain("ld(");
        expect(text).toBe("((t*2)+(t*2))");
        expect(emitFfmpeg(add(v("T"), 1), { target: "scalar", time: "(n/30)" })).toBe("((n/30)+1)");
    });

    it("refuses samples, progress, and pixel variables", () => {
        expect(() => emitFfmpeg(sample(0, 0, 0, 0), { target: "scalar", time: "t" })).toThrow(/sample/);
        expect(() => emitFfmpeg(v("p"), { target: "scalar", time: "t" })).toThrow(/progress/);
        expect(() => emitFfmpeg(v("X"), { target: "scalar", time: "t" })).toThrow(/pixel/);
    });

    it("evaluates scalars at a time with parameters", () => {
        expect(evaluateScalar(add(mul(v("T"), 2), param("k")), 1.25, { k: 0.5 })).toBe(3);
        expect(evaluateScalar(bind(v("T"), (r) => mul(r, r)), 3)).toBe(9);
    });
});

describe("slot reuse and time variable (masks, phase 10c)", () => {
    it("reuses the slot of a binding that is dead in the rest of a let chain (opt-in)", () => {
        // a and b feed c only, so c takes a's slot; d needs c, so it takes b's.
        const e = bind(add(v("X"), 1), (a) => bind(add(v("Y"), 2), (b) => bind(mul(a, b), (c) => bind(add(c, 1), (d) => add(c, d)))));
        expect(emitFfmpeg(e, { target: "geq" })).toContain("st(3,");
        const text = emitFfmpeg(e, { target: "geq" }, { reuseSlots: true });
        expect(text).toBe("(st(0,(X+1));(st(1,(Y+2));(st(0,(ld(0)*ld(1)));(st(1,(ld(0)+1));(ld(0)+ld(1))))))");
        expect(text).not.toContain("st(2,");
    });

    it("never reuses a slot that is read after a nested binding outside the let chain", () => {
        // a is read after the inner binding (in the sum), so the inner binding must not take a's slot.
        const e = bind(add(v("X"), 1), (a) => add(bind(mul(v("Y"), 3), (b) => add(b, 1)), a));
        const text = emitFfmpeg(e, { target: "geq" }, { reuseSlots: true });
        expect(text).toBe("(st(0,(X+1));((st(1,(Y*3));(ld(1)+1))+ld(0)))");
    });

    it("evaluates to the same value with and without reuse", () => {
        const e = bind(add(v("X"), 1), (a) => bind(mul(a, 3), (b) => bind(sub(b, a), (c) => bind(mul(c, c), (d) => add(d, b)))));
        expect(evaluate(e, env())).toBe(4 * 3 + (12 - 4) * (12 - 4));
        const text = emitFfmpeg(e, { target: "geq" }, { reuseSlots: true });
        // a dies once c is computed (c takes its slot), c dies once d is (d takes it too); b lives to the end.
        expect(text).toBe("(st(0,(X+1));(st(1,(ld(0)*3));(st(0,(ld(1)-ld(0)));(st(0,(ld(0)*ld(0)));(ld(0)+ld(1))))))");
    });

    it("writes T as a custom clock in geq", () => {
        expect(emitFfmpeg(add(v("T"), 1), { target: "geq" }, { timeVar: "(floor(T*30+0.5)/30)" })).toBe("((floor(T*30+0.5)/30)+1)");
        expect(emitFfmpeg(v("T"), { target: "geq" }, { timeVar: "TT", timeOffset: 2 })).toBe("(TT-2)");
    });
});

describe("compileExpr (fast pixel evaluator, phase 10c)", () => {
    const exprs = [
        bind(sub(add(v("X"), 0.5), mul(param("cx"), v("W"))), (ex) => bind(sub(add(v("Y"), 0.5), mul(param("cy"), v("H"))), (ey) =>
            iff(gt(hypot(ex, ey), mul(min(v("W"), v("H")), 0.25)), floor(mul(clip(div(ex, 7), 0, 1), 255)), sqrt(abs(add(mul(ex, cos(param("cx"))), ey)))))),
        add(max(v("X"), v("Y")), mod(v("T"), 0.3), sin(mul(v("T"), 3)), lt(v("X"), 4)),
    ];
    it("returns exactly what evaluate returns at every pixel", () => {
        for (const e of exprs) {
            const params = { cx: 0.37, cy: 0.61 };
            const fn = compileExpr(e, params);
            for (let y = 0; y < 9; y += 1) {
                for (let x = 0; x < 13; x += 1) {
                    const expected = evaluate(e, { X: x, Y: y, W: 13, H: 9, T: 1.7, params, read: () => 0 });
                    expect(fn(x, y, 13, 9, 1.7)).toBe(expected);
                }
            }
        }
    });

    it("refuses samples and missing parameters", () => {
        expect(() => compileExpr(sample(0, 0, 0, 0))).toThrow(/sample/);
        expect(() => compileExpr(param("k"))).toThrow(/parameter/);
    });
});
