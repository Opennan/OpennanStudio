// Text in / out / loop animations (phase 10b). The transform part is a MotionDelta like clip
// animations (small frame-fraction slides for text); the raster part (`raster`) names the text state
// sequence text/text-states.ts builds (typewriter, wipe, blur, glow, letter rise/fall). Ids repeat
// across slots (in "fade" vs out "fade"): the slot disambiguates.
import { add, clip, cos, gte, iff, lt, mul, sin, sub, toExpr, type Expr } from "../looks/expr";
import type { AnimationDef, AnimationSlot, MotionDelta, TextRasterKind } from "./types";

const TAU = Math.PI * 2;
/** Slide distance for text, in frame fractions. */
const SLIDE = 0.08;
const BOUNCE_HEIGHT = 0.12;
const BACK = 1.70158;

const clamp01 = (u: Expr) => clip(u, 0, 1);
/** Quadratic ease out (in windows: fast start, soft landing). */
const easeOut = (u: Expr) => {
    const r = sub(1, clamp01(u));
    return sub(1, mul(r, r));
};
/** Quadratic ease in (out windows: soft start, fast exit). */
const easeIn = (u: Expr) => {
    const x = clamp01(u);
    return mul(x, x);
};
/** Back-out overshoot: 0 → 1 passing ~1.1. */
const backOut = (u: Expr) => {
    const r = sub(clamp01(u), 1);
    return add(1, mul(BACK + 1, r, r, r), mul(BACK, r, r));
};
/** Back-in: dips below 0 before rising to 1. */
const backIn = (u: Expr) => {
    const x = clamp01(u);
    return sub(mul(BACK + 1, x, x, x), mul(BACK, x, x));
};
/** Robert Penner's bounce-out, 0 → 1 with three decaying bounces. */
const bounceOut = (u: Expr): Expr => {
    const x = clamp01(u);
    const k = 7.5625;
    const d = 2.75;
    const seg = (shift: number, offset: number) => {
        const s = sub(x, shift / d);
        return add(mul(k, s, s), offset);
    };
    return iff(lt(x, 1 / d), mul(k, x, x), iff(lt(x, 2 / d), seg(1.5, 0.75), iff(lt(x, 2.5 / d), seg(2.25, 0.9375), seg(2.625, 0.984375))));
};
const fadeInOpacity = (u: Expr, speed = 1) => clamp01(mul(u, speed));

type Def = Omit<AnimationDef, "kind">;
const def = (slot: AnimationSlot, id: string, delta: (u: Expr) => MotionDelta, raster?: TextRasterKind, defaultDuration?: number): Def => ({
    id, slot, delta, raster, defaultDuration: defaultDuration ?? (slot === "loop" ? 1 : 0.5),
});

const IN: Def[] = [
    def("in", "fade", (u) => ({ opacity: easeOut(u) })),
    def("in", "pop", (u) => ({ scale: add(0.3, mul(0.7, backOut(u))), opacity: fadeInOpacity(u, 4) })),
    def("in", "slide_up", (u) => ({ dy: mul(SLIDE, sub(1, easeOut(u))), opacity: easeOut(u) })),
    def("in", "slide_down", (u) => ({ dy: mul(-SLIDE, sub(1, easeOut(u))), opacity: easeOut(u) })),
    def("in", "slide_left", (u) => ({ dx: mul(SLIDE, sub(1, easeOut(u))), opacity: easeOut(u) })),
    def("in", "slide_right", (u) => ({ dx: mul(-SLIDE, sub(1, easeOut(u))), opacity: easeOut(u) })),
    def("in", "typewriter", () => ({}), "typewriter", 1),
    def("in", "zoom", (u) => ({ scale: add(1, mul(0.5, sub(1, easeOut(u)))), opacity: easeOut(u) })),
    def("in", "blur_in", (u) => ({ opacity: easeOut(u) }), "blur"),
    def("in", "bounce", (u) => ({ dy: mul(-BOUNCE_HEIGHT, sub(1, bounceOut(u))), opacity: fadeInOpacity(u, 5) }), undefined, 0.8),
    def("in", "wipe", () => ({}), "wipe"),
    def("in", "letter_rise", () => ({}), "letter_rise", 0.8),
];

const OUT: Def[] = [
    def("out", "fade", (u) => ({ opacity: sub(1, easeIn(u)) })),
    def("out", "shrink", (u) => ({ scale: sub(1, mul(0.7, easeIn(u))), opacity: sub(1, easeIn(u)) })),
    def("out", "slide_up", (u) => ({ dy: mul(-SLIDE, easeIn(u)), opacity: sub(1, easeIn(u)) })),
    def("out", "slide_down", (u) => ({ dy: mul(SLIDE, easeIn(u)), opacity: sub(1, easeIn(u)) })),
    def("out", "slide_left", (u) => ({ dx: mul(-SLIDE, easeIn(u)), opacity: sub(1, easeIn(u)) })),
    def("out", "slide_right", (u) => ({ dx: mul(SLIDE, easeIn(u)), opacity: sub(1, easeIn(u)) })),
    def("out", "typewriter_erase", () => ({}), "typewriter_erase", 0.8),
    def("out", "zoom", (u) => ({ scale: add(1, mul(0.5, easeIn(u))), opacity: sub(1, easeIn(u)) })),
    def("out", "blur_out", (u) => ({ opacity: sub(1, easeIn(u)) }), "blur"),
    // A small hop up, then a drop below the rest position, fading over the last 40 %.
    def("out", "bounce", (u) => ({ dy: mul(BOUNCE_HEIGHT, backIn(u)), opacity: sub(1, clamp01(mul(sub(u, 0.6), 2.5))) }), undefined, 0.6),
    def("out", "wipe", () => ({}), "wipe"),
    def("out", "letter_fall", () => ({}), "letter_fall", 0.8),
];

/** Phase u in [0, 1): every loop is at rest at u = 0 and periodic. */
const wave = (u: Expr, cycles: number) => sin(mul(TAU * cycles, u));
const LOOP: Def[] = [
    def("loop", "pulse", (u) => ({ scale: add(1, mul(0.03, sub(1, cos(mul(TAU, u))))) }), undefined, 1),
    def("loop", "shake", (u) => ({ dx: mul(0.008, wave(u, 4)), dy: mul(0.004, wave(u, 3)) }), undefined, 0.5),
    def("loop", "float", (u) => ({ dy: mul(-0.012, wave(u, 1)) }), undefined, 2),
    def("loop", "glow", () => ({}), "glow", 1.5),
    // Two short dips per period (neon flicker): 30 % opacity over 6 % and 4 % of the period.
    def("loop", "flicker", (u) => {
        const x = toExpr(u);
        const dip = (a: number, b: number) => mul(gte(x, a), lt(x, b));
        return { opacity: sub(1, mul(0.7, add(dip(0.12, 0.18), dip(0.52, 0.56)))) };
    }, undefined, 1.2),
    def("loop", "swing", (u) => ({ rotation: mul(6, wave(u, 1)) }), undefined, 1.5),
];

export const TEXT_ANIMATIONS: readonly AnimationDef[] = [...IN, ...OUT, ...LOOP].map((d) => ({ ...d, kind: "text" as const }));

/** The text animation for a slot and id (ids repeat across slots). */
export function textAnimationById(slot: AnimationSlot, id: string): AnimationDef | undefined {
    return TEXT_ANIMATIONS.find((a) => a.slot === slot && a.id === id);
}
