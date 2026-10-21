// The transform model (phase 10b): one expression per motion channel for a clip or a scene, written once
// and evaluated by the preview (motionAt → evaluateScalar) and the export (motionFfmpeg → scalar target).
//
// Composition, per channel:
//   1. base: the item's fields, replaced by its keyframe curve where keyframes define the channel
//      (clip: positionX/Y 0..1, scale, rotationDegrees, opacity; scene: transformOffsetX/Y in percent,
//      transformScale, rotationDegrees, opacity — scene keyframes use the same channel names in scene units);
//   2. animations (animationJson): opacity, scale, scaleX multiply; dx, dy, rotation add. In / out / combo
//      use the window progress clip((T − start) / (end − start), 0, 1), so they are neutral outside their
//      window; a loop uses its phase mod(T − start, period) / period and is neutral outside its window;
//   3. legacy clip motion that the 10a export applied and the preview ignored: the `motionPreset` scale
//      (filters/video.ts motionScaleExpression, replaced by scale keyframes as in the export) and the alpha
//      fades of overlay clips (alphaFadeFilters, fadeDurations / effectiveTextFades for text).
//
// Legacy fade timing: the export's `fade` filter evaluates (t − st) / d at each frame's timestamp (n / fps,
// clip-local), and so does this expression, so the two agree at every frame. Between frames the preview's
// value moves continuously while the export holds the frame; and ffmpeg quantizes the factor to 1/65535
// (well below one 8-bit level). The `dip_black` / `dip_white` types fade the layer's colour (not its alpha)
// in the export, so they are not opacity and stay in the export path.
import { add, clip, div, evaluateScalar, emitFfmpeg, iff, lt, mod, mul, n, sin, sub, v, type Expr } from "../looks/expr";
import { normalizeTimelineTransitionType } from "../lib/timeline-editing-navigation";
import { parseTimelineKeyframes } from "../lib/timeline-editing-properties";
import type { TimelineClip } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { parseAnimationSpec, resolveAnimationWindows, type AnimationWindow } from "./animation-spec";
import { channelExpr, hasChannel, type KeyframePoints } from "./keyframes";
import { animationById, type AnimationTarget } from "./registry";
import { MOTION_CHANNELS, type AnimationSlot, type MotionChannel, type MotionChannels, type MotionDelta } from "./types";

export type MotionItem =
    | { kind: "clip"; clip: TimelineClip }
    | { kind: "scene"; scene: SceneData; duration: number };

export interface ItemMotion {
    /** Item length in seconds (clip: endTime − startTime). */
    duration: number;
    /** One expression of the item-local time T per channel; a static channel is a single number. */
    channels: MotionChannels<Expr>;
    /** Any channel varies over time. */
    animated: boolean;
}

const T = v("T");

// ── field normalization (export/src/clip-params.ts rules) ─────────────────

/** Number(value) when finite; `fallback` for null, undefined, "", NaN, and ±Infinity. */
function num(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === "") return fallback;
    const x = Number(value);
    return Number.isFinite(x) ? x : fallback;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const positiveOr1 = (value: unknown) => {
    const x = num(value, 1);
    return x > 0 ? x : 1;
};

/** export/src/format.ts fmt as a number: the export writes fade and preset constants with 6 significant digits. */
function fmt6(value: number): number {
    if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return 0;
    return Number(value.toPrecision(6));
}

// ── constant folding ─────────────────────────────────────

const isNum = (e: Expr, value?: number): e is { k: "num"; v: number } => e.k === "num" && (value === undefined || e.v === value);

/** Evaluates every time-independent subtree (same operations, same order, so values do not change). */
function fold(e: Expr): Expr {
    switch (e.k) {
        case "bin": {
            const a = fold(e.a);
            const b = fold(e.b);
            const node: Expr = { ...e, a, b };
            if (isNum(a) && isNum(b)) return n(evaluateScalar(node, 0));
            if (e.op === "*" && isNum(a, 1)) return b;
            if ((e.op === "*" || e.op === "/") && isNum(b, 1)) return a;
            if ((e.op === "+" || e.op === "-") && isNum(b, 0)) return a;
            if (e.op === "+" && isNum(a, 0)) return b;
            return node;
        }
        case "call": {
            const args = e.args.map(fold);
            const node: Expr = { ...e, args };
            return args.every((arg) => isNum(arg)) ? n(evaluateScalar(node, 0)) : node;
        }
        case "if": {
            const c = fold(e.c);
            if (isNum(c)) return fold(c.v !== 0 ? e.a : e.b);
            return { ...e, c, a: fold(e.a), b: fold(e.b) };
        }
        default:
            return e;
    }
}

// ── composition ──────────────────────────────────────────

/** The animation family of an item: text clips, sticker clips, or clip animations (video, image, scenes). */
export function motionTarget(item: MotionItem): AnimationTarget {
    if (item.kind === "scene") return "clip";
    if (item.clip.trackType === "text") return "text";
    if (item.clip.trackType === "sticker") return "sticker";
    return "clip";
}

interface Base {
    posX: number;
    posY: number;
    scale: number;
    rotation: number;
    opacity: number;
}

function baseFields(item: MotionItem): Base {
    if (item.kind === "clip") {
        const c = item.clip;
        return {
            posX: num(c.positionX, 0.5),
            posY: num(c.positionY, 0.5),
            scale: positiveOr1(c.scale),
            rotation: num(c.rotationDegrees, 0),
            opacity: clamp(num(c.opacity, 1), 0, 1),
        };
    }
    const s = item.scene;
    return {
        posX: num(s.transformOffsetX, 0),
        posY: num(s.transformOffsetY, 0),
        scale: positiveOr1(s.transformScale),
        rotation: num(s.rotationDegrees, 0),
        opacity: clamp(num(s.opacity, 1), 0, 1),
    };
}

type DeltaChannel = keyof MotionDelta;
const FACTOR_CHANNELS: readonly DeltaChannel[] = ["opacity", "scale", "scaleX"];
const neutralOf = (channel: DeltaChannel) => (FACTOR_CHANNELS.includes(channel) ? 1 : 0);

/** The deltas of every resolved window, each already gated to its window. */
function animationDeltas(item: MotionItem, duration: number, json: string | null | undefined): Array<Partial<Record<DeltaChannel, Expr>>> {
    const spec = parseAnimationSpec(json);
    const windows = resolveAnimationWindows(spec, duration);
    const target = motionTarget(item);
    const out: Array<Partial<Record<DeltaChannel, Expr>>> = [];
    const progressWindow = (slot: Exclude<AnimationSlot, "loop">, window: AnimationWindow | undefined) => {
        if (!window || !(window.end > window.start)) return;
        const def = animationById(target, slot, window.id);
        if (!def) return;
        out.push(def.delta(clip(div(sub(T, window.start), window.end - window.start), 0, 1)));
    };
    progressWindow("in", windows.in);
    progressWindow("out", windows.out);
    progressWindow("combo", windows.combo);
    const loop = windows.loop;
    if (loop && loop.end > loop.start && loop.period > 0) {
        const def = animationById(target, "loop", loop.id);
        if (def) {
            const delta = def.delta(div(mod(sub(T, loop.start), loop.period), loop.period));
            const gated: Partial<Record<DeltaChannel, Expr>> = {};
            for (const [channel, expr] of Object.entries(delta) as Array<[DeltaChannel, Expr]>) {
                const neutral = neutralOf(channel);
                const inside = iff(lt(T, loop.end), expr, neutral);
                gated[channel] = loop.start > 0 ? iff(lt(T, loop.start), neutral, inside) : inside;
            }
            out.push(gated);
        }
    }
    return out;
}

/** The motionPreset scale factor (motionScaleExpression), or null. */
function presetFactor(c: TimelineClip, duration: number): Expr | null {
    const preset = String(c.motionPreset ?? "").trim().toLowerCase();
    const d = fmt6(Math.max(0.001, duration));
    if (preset === "zoom_in") return add(1, div(mul(0.08, T), d));
    if (preset === "zoom_out") return sub(1.08, div(mul(0.08, T), d));
    if (preset === "pulse") return add(1, mul(0.04, sin(div(mul(mul(2, Math.PI), T), d))));
    return null;
}

/** The overlay clip's alpha fade factors (clipTransitionFilters / alphaFadeFilters), empty for dips. */
function fadeFactors(c: TimelineClip, duration: number): Expr[] {
    const type = normalizeTimelineTransitionType(String(c.transitionType ?? "none"));
    if (type === "dip_black" || type === "dip_white") return [];
    const max = Math.max(0, duration / 2);
    let fadeIn = clamp(num(c.fadeInDuration, 0), 0, max);
    let fadeOut = clamp(num(c.fadeOutDuration, 0), 0, max);
    // effectiveTextFades: text clips without fades fade over their transition duration.
    if (c.trackType === "text" && fadeIn <= 0 && fadeOut <= 0 && type !== "none") {
        fadeIn = fadeOut = clamp(num(c.transitionDuration, 0), 0, max);
    }
    const factors: Expr[] = [];
    const d0 = fmt6(fadeIn);
    if (fadeIn > 0 && d0 > 0) factors.push(clip(div(T, d0), 0, 1));
    const d1 = fmt6(fadeOut);
    if (fadeOut > 0 && d1 > 0) factors.push(sub(1, clip(div(sub(T, fmt6(Math.max(0, duration - fadeOut))), d1), 0, 1)));
    return factors;
}

function compose(item: MotionItem, duration: number): ItemMotion {
    const keyframesJson = item.kind === "clip" ? item.clip.keyframesJson : item.scene.keyframesJson;
    const animationJson = item.kind === "clip" ? item.clip.animationJson : item.scene.animationJson;
    const points: KeyframePoints = parseTimelineKeyframes(keyframesJson);
    const base = baseFields(item);
    const deltas = animationDeltas(item, duration, animationJson);
    const collect = (channel: DeltaChannel) => deltas.map((delta) => delta[channel]).filter((e): e is Expr => Boolean(e));
    const product = (first: Expr, factors: Expr[]) => factors.reduce<Expr>((acc, f) => mul(acc, f), first);
    const sum = (first: Expr, terms: Expr[]) => terms.reduce<Expr>((acc, x) => add(acc, x), first);

    let scale = product(channelExpr(points, "scale", base.scale), collect("scale"));
    let opacityFactors = collect("opacity");
    if (item.kind === "clip") {
        const preset = hasChannel(points, "scale") ? null : presetFactor(item.clip, duration);
        if (preset) scale = mul(scale, preset);
        opacityFactors = [...opacityFactors, ...fadeFactors(item.clip, duration)];
    }
    const channels: MotionChannels<Expr> = {
        opacity: clip(product(channelExpr(points, "opacity", base.opacity), opacityFactors), 0, 1),
        scale,
        scaleX: product(n(1), collect("scaleX")),
        posX: channelExpr(points, "position_x", base.posX),
        posY: channelExpr(points, "position_y", base.posY),
        dx: sum(n(0), collect("dx")),
        dy: sum(n(0), collect("dy")),
        rotation: sum(channelExpr(points, "rotation_degrees", base.rotation), collect("rotation")),
    };
    for (const channel of MOTION_CHANNELS) channels[channel] = fold(channels[channel]);
    const animated = MOTION_CHANNELS.some((channel) => channels[channel].k !== "num");
    return { duration, channels, animated };
}

// Items are immutable store objects: one motion per clip object, and per scene object and duration.
const memo = new WeakMap<object, ItemMotion>();

/** The item's motion channels (memoized per object identity: the preview calls this every frame). */
export function itemMotion(item: MotionItem): ItemMotion {
    const key = item.kind === "clip" ? item.clip : item.scene;
    const duration = item.kind === "clip" ? Math.max(0, item.clip.endTime - item.clip.startTime) : Math.max(0, item.duration);
    const cached = memo.get(key);
    if (cached && cached.duration === duration) return cached;
    const motion = compose(item, duration);
    memo.set(key, motion);
    return motion;
}

/** Channel values at item-local `t` seconds (the preview). */
export function motionAt(motion: ItemMotion, t: number): MotionChannels<number> {
    const value = (channel: MotionChannel) => {
        const e = motion.channels[channel];
        return e.k === "num" ? e.v : evaluateScalar(e, t);
    };
    return {
        opacity: value("opacity"), scale: value("scale"), scaleX: value("scaleX"), posX: value("posX"),
        posY: value("posY"), dx: value("dx"), dy: value("dy"), rotation: value("rotation"),
    };
}

/** One channel as a per-frame ffmpeg expression of `timeVar` (minus `timeOffset`, e.g. the item start on the main clock). */
export function motionFfmpeg(motion: ItemMotion, channel: MotionChannel, timeVar: string, timeOffset?: number): string {
    return emitFfmpeg(motion.channels[channel], { target: "scalar", time: timeVar }, { timeOffset });
}

/** True when a channel never changes (the export can place it statically). */
export function isConstantChannel(motion: ItemMotion, channel: MotionChannel): boolean {
    return motion.channels[channel].k === "num";
}

