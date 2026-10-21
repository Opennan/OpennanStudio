import { describe, expect, it } from "vitest";
import { XFADE_THREADS, channelOut, evaluate, xfadeExpression, type Channel } from "@opennan/timeline-core/looks/expr";
import { TRANSITIONS } from "@opennan/timeline-core/looks/transitions";
import { ffmpegHosts } from "./ffmpeg";
import { compareFrames, runFilter, splitFrames, testFrame, type RgbFrame } from "./frames";

const hosts = await ffmpegHosts();
const W = 64;
const H = 36;
const FRAMES = 6;
const FPS = 30;
const a = testFrame(W, H, 21);
const b = testFrame(W, H, 22);

/** xfade's float32 progress for output frame k of a FRAMES-frame transition, as CapCut progress. */
const progressAt = (k: number) => 1 - Math.fround(1 - Math.fround(Math.fround(k) / Math.fround(FRAMES)));

function reference(id: string, p: number, fa: RgbFrame, fb: RgbFrame): Uint8Array {
    const def = TRANSITIONS.find((t) => t.id === id)!;
    const out = new Uint8Array(W * H * 3);
    const exprs = ([0, 1, 2] as Channel[]).map((ch) => channelOut(def.channel(ch)));
    for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
            for (let ch = 0; ch < 3; ch += 1) {
                const value = evaluate(exprs[ch], { X: x, Y: y, W, H, p, read: (src, c, xi, yi) => (src === 0 ? fa : fb).data[(yi * W + xi) * 3 + c] });
                out[(y * W + x) * 3 + ch] = Math.trunc(value);
            }
        }
    }
    return out;
}

describe.each(hosts.map((h) => [h.name, h] as const))("transitions on %s", (_name, host) => {
    for (const def of TRANSITIONS) {
        it(def.id, async () => {
            const expr = xfadeExpression((ch) => def.channel(ch), 3);
            const seconds = FRAMES / FPS;
            const out = await runFilter(host, {
                frames: [a, b],
                seconds,
                fps: FPS,
                graph: `[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]xfade=transition=custom:duration=${seconds}:offset=0:${XFADE_THREADS}:expr='${expr}',format=rgb24[out]`,
            });
            const frames = splitFrames(out, W * H * 3);
            expect(frames.length).toBe(FRAMES);
            for (let k = 0; k < FRAMES; k += 1) {
                const diff = compareFrames(frames[k], reference(def.id, progressAt(k), a, b));
                expect(diff.mean, `${def.id} frame ${k}`).toBeLessThanOrEqual(0.05);
                expect(diff.p999, `${def.id} frame ${k}`).toBeLessThanOrEqual(1);
            }
        });
    }
});
