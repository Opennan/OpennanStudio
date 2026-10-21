// Clip animations (phase 10b): 12 in, 12 out, and 8 combo animations for video, image, and sticker clips
// and main-track scenes, CapCut-style. Each is a MotionDelta of the window progress u (types.ts): in
// animations decelerate into rest, out animations mirror them and accelerate away in the direction of
// their name, combos leave rest and return to it over the whole item. Offsets dx/dy are frame fractions.
import { abs, add, clip, cos, div, exp, mul, sin, sub, type Expr, type ExprLike } from "../looks/expr";
import { DEFAULT_ANIMATION_SECONDS } from "./animation-spec";
import { easeExpr } from "./easing";
import type { AnimationDef, AnimationSlot, MotionDelta } from "./types";

const PI = Math.PI;

/** Cubic ease-out (decelerates): 0 → 1. */
const eo = (u: ExprLike) => easeExpr("ease_out", u);
/** Quadratic ease-out, for opacity ramps. */
const eoQuad = (u: ExprLike) => {
    const r = sub(1, u);
    return sub(1, mul(r, r));
};
/** Opacity 0 → 1 over the first `share` of the window. */
const ramp = (u: ExprLike, share: number) => clip(div(u, share), 0, 1);
/** Remaining travel of an in animation: 1 at u = 0, exactly 0 at u = 1. */
const left = (u: ExprLike) => sub(1, eo(u));
const sinSq = (x: ExprLike) => {
    const s = sin(x);
    return mul(s, s);
};

type DeltaFn = (u: Expr) => MotionDelta;

/** In animations: rest at u = 1. */
const IN: Record<string, DeltaFn> = {
    fade_in: (u) => ({ opacity: eoQuad(u) }),
    zoom_in: (u) => ({ scale: add(0.4, mul(0.6, eo(u))), opacity: ramp(u, 0.4) }),
    zoom_out: (u) => ({ scale: sub(1.6, mul(0.6, eo(u))), opacity: ramp(u, 0.4) }),
    // Slides travel in the direction of their name, from about off-frame.
    slide_left: (u) => ({ dx: mul(0.6, left(u)), opacity: ramp(u, 0.2) }),
    slide_right: (u) => ({ dx: mul(-0.6, left(u)), opacity: ramp(u, 0.2) }),
    slide_up: (u) => ({ dy: mul(0.6, left(u)), opacity: ramp(u, 0.2) }),
    slide_down: (u) => ({ dy: mul(-0.6, left(u)), opacity: ramp(u, 0.2) }),
    rotate_in: (u) => ({ rotation: mul(-90, left(u)), opacity: eoQuad(u) }),
    spin_in: (u) => ({ rotation: mul(-360, left(u)), scale: add(0.3, mul(0.7, eo(u))), opacity: ramp(u, 0.3) }),
    // Damped overshoot: 0 → ~1.18 → ~0.98 → 1, exactly 1 at u = 1.
    bounce_in: (u) => ({ scale: sub(1, mul(sub(1, u), exp(mul(-4, u)), cos(mul(3 * PI, u)))), opacity: ramp(u, 0.15) }),
    // A pendulum settling: −30° → +8° → … → 0°.
    swing_in: (u) => ({ rotation: mul(-30, sub(1, u), exp(mul(-2.5, u)), cos(mul(3 * PI, u))), opacity: ramp(u, 0.25) }),
    flip_in: (u) => ({ scaleX: eo(u) }),
};

/** An out animation as an in animation run backwards (rest at u = 0), offsets optionally negated. */
function mirrored(source: DeltaFn, negate: Array<"dx" | "dy" | "rotation"> = []): DeltaFn {
    return (u) => {
        const delta = source(sub(1, u));
        for (const channel of negate) {
            const value = delta[channel];
            if (value) delta[channel] = mul(-1, value);
        }
        return delta;
    };
}

/** Out animations: rest at u = 0, gone at u = 1. */
const OUT: Record<string, DeltaFn> = {
    fade_out: mirrored(IN.fade_in),
    zoom_in_out: mirrored(IN.zoom_out), // grows and vanishes
    zoom_out_out: mirrored(IN.zoom_in), // shrinks
    slide_left_out: mirrored(IN.slide_right),
    slide_right_out: mirrored(IN.slide_left),
    slide_up_out: mirrored(IN.slide_down),
    slide_down_out: mirrored(IN.slide_up),
    rotate_out: mirrored(IN.rotate_in, ["rotation"]), // keeps turning clockwise: 0 → 90°
    spin_out: mirrored(IN.spin_in, ["rotation"]), // 0 → 360°
    bounce_out: mirrored(IN.bounce_in),
    swing_out: mirrored(IN.swing_in),
    flip_out: mirrored(IN.flip_in),
};

/** sin(πu): 0 at both ends, the envelope of the jittery combos. */
const envelope = (u: Expr) => sin(mul(PI, u));

/** Combos: the whole item, rest at u = 0 and u = 1. */
const COMBO: Record<string, DeltaFn> = {
    combo_zoom_pulse: (u) => ({ scale: add(1, mul(0.15, sinSq(mul(PI, u)))) }),
    combo_rotate_zoom: (u) => ({ rotation: mul(12, sin(mul(2 * PI, u))), scale: add(1, mul(0.2, sinSq(mul(PI, u)))) }),
    combo_swing: (u) => ({ rotation: mul(8, sin(mul(4 * PI, u))) }),
    // A deterministic jitter (incommensurate sines) whose amplitude decays to 0 at both ends.
    combo_shake: (u) => ({
        dx: mul(0.015, envelope(u), add(sin(mul(14 * PI, u)), mul(0.6, sin(add(mul(26 * PI, u), 1))), mul(0.4, sin(add(mul(46 * PI, u), 2))))),
        dy: mul(0.008, envelope(u), add(sin(add(mul(18 * PI, u), 0.5)), mul(0.5, sin(add(mul(34 * PI, u), 1.5))))),
    }),
    // Jelly: width and height breathe in opposition, with a slight rock.
    combo_wobble: (u) => {
        const w = mul(envelope(u), sin(mul(8 * PI, u)));
        return { scaleX: add(1, mul(0.08, w)), scale: sub(1, mul(0.04, w)), rotation: mul(3, envelope(u), sin(mul(6 * PI, u))) };
    },
    // One eased full turn (ends on 360°, which is rest) while shrinking to half size and back.
    combo_spin_shrink: (u) => {
        // smoothstep 3u² − 2u³: exact 0 and 1 at the ends.
        const smooth = sub(mul(3, u, u), mul(2, u, u, u));
        return { rotation: mul(360, smooth), scale: sub(1, mul(0.5, sinSq(mul(PI, u)))) };
    },
    combo_bounce: (u) => ({ dy: mul(-0.08, abs(sin(mul(3 * PI, u))), sub(1, mul(0.6, u))) }),
    // Flips through edge-on twice (|scaleX| is drawn, so the image is never mirrored).
    combo_flip: (u) => ({ scaleX: cos(mul(2 * PI, u)) }),
};

function defs(slot: AnimationSlot, table: Record<string, DeltaFn>, defaultDuration: number): AnimationDef[] {
    return Object.entries(table).map(([id, delta]) => ({ id, kind: "clip", slot, defaultDuration, delta }));
}

/** 0 for combos: the item's length. */
export const COMBO_DEFAULT_DURATION = 0;

export const CLIP_ANIMATIONS: readonly AnimationDef[] = [
    ...defs("in", IN, DEFAULT_ANIMATION_SECONDS),
    ...defs("out", OUT, DEFAULT_ANIMATION_SECONDS),
    ...defs("combo", COMBO, COMBO_DEFAULT_DURATION),
];
