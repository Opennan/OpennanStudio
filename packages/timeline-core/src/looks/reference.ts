// JS reference renderer for looks and transitions on raw RGB(A) frames: the ffmpeg-exact math the
// export runs and the preview shaders mirror. Used by parity tests (export: real ffmpeg; web e2e:
// WebGL) — never on the playback path.
import { channelOut, evaluate, type Channel } from "./expr";
import { applyHaldToFrame, buildHaldClut, type HaldClut } from "./lut";
import type { LookPlan } from "./look-plan";
import { maskImage, maskedAlpha, type MaskBox } from "./masks";
import { convolve3x3Reference, grainImage, grainWindow, grainmergeReference, multiplyReference, vignetteMask } from "./spatial";
import type { TransitionDef } from "./transitions";

export interface RawFrame {
    width: number;
    height: number;
    channels: 3 | 4;
    data: Uint8Array;
}

const clutCache = new Map<string, HaldClut>();

function clutFor(key: string, fn: Parameters<typeof buildHaldClut>[0]): HaldClut {
    let clut = clutCache.get(key);
    if (!clut) {
        clut = buildHaldClut(fn);
        if (clutCache.size > 32) clutCache.clear();
        clutCache.set(key, clut);
    }
    return clut;
}

/** One expression pass over a frame (8-bit store after each channel, alpha copied). */
export function renderPass(frame: RawFrame, channel: (ch: Channel) => import("./expr").Expr, env: { T?: number; p?: number; params?: Record<string, number>; second?: RawFrame }): Uint8Array {
    const { width: W, height: H, channels } = frame;
    const exprs = ([0, 1, 2] as Channel[]).map((ch) => channelOut(channel(ch)));
    const out = new Uint8Array(frame.data.length);
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const o = (y * W + x) * channels;
            for (let ch = 0; ch < 3; ch += 1) {
                out[o + ch] = Math.trunc(evaluate(exprs[ch], {
                    X: x, Y: y, W, H, T: env.T, p: env.p, params: env.params,
                    read: (src, c, xi, yi) => (src === 0 ? frame : env.second ?? frame).data[(yi * W + xi) * channels + c],
                }));
            }
            if (channels === 4) out[o + 3] = frame.data[o + 3];
        }
    }
    return out;
}

/** The mask levels as alpha: an RGB frame gains the level as its alpha, an RGBA frame's alpha is multiplied (blend multiply). */
function applyMaskReference(data: Uint8Array, width: number, height: number, channels: 3 | 4, levels: Uint8Array): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        out[i * 4] = data[i * channels];
        out[i * 4 + 1] = data[i * channels + 1];
        out[i * 4 + 2] = data[i * channels + 2];
        out[i * 4 + 3] = maskedAlpha(channels === 4 ? data[i * 4 + 3] : 255, levels[i]);
    }
    return out;
}

/**
 * The plan on one frame at item-local time t (seconds; the mask's keyframe time). A mask makes the frame RGBA.
 * `maskBox`: the item's box inside the frame (text and sticker bitmaps, looks/masks.ts MaskBox).
 */
export function renderLookReference(frame: RawFrame, plan: LookPlan | null, t = 0, maskBox?: MaskBox | null): RawFrame {
    if (!plan) return frame;
    let data = frame.data;
    const { width, height } = frame;
    let channels = frame.channels;
    for (const step of plan.steps) {
        switch (step.kind) {
            case "lut": data = applyHaldToFrame(data, channels, clutFor(step.key, step.fn)); break;
            case "sharpen": data = convolve3x3Reference(data, width, height, channels, step.kernel); break;
            case "vignette": data = multiplyReference(data, vignetteMask(width, height, step.amount), channels); break;
            case "grain": data = grainmergeReference(data, grainWindow(grainImage(width, height, step.amount), width, height, t), channels); break;
            case "pass": data = renderPass({ width, height, channels, data }, (ch) => step.pass.channel(ch), { T: t, params: step.params }); break;
            case "mask":
                data = applyMaskReference(data, width, height, channels, maskImage(step.mask, width, height, step.points, t, maskBox));
                channels = 4;
                break;
        }
    }
    return { width, height, channels, data };
}

/** A transition frame at CapCut progress p (both frames the same size and channel count). */
export function renderTransitionReference(def: TransitionDef, a: RawFrame, b: RawFrame, p: number): RawFrame {
    const { width: W, height: H, channels } = a;
    const out = new Uint8Array(a.data.length);
    const chans = channels === 4 ? ([0, 1, 2, 3] as Channel[]) : ([0, 1, 2] as Channel[]);
    const exprs = chans.map((ch) => channelOut(def.channel(ch)));
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            const o = (y * W + x) * channels;
            chans.forEach((ch, i) => {
                out[o + ch] = Math.trunc(evaluate(exprs[i], { X: x, Y: y, W, H, p, read: (src, c, xi, yi) => (src === 0 ? a : b).data[(yi * W + xi) * channels + c] }));
            });
        }
    }
    return { width: W, height: H, channels, data: out };
}
