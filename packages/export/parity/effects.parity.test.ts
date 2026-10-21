import { describe, expect, it } from "vitest";
import { channelOut, evaluate, geqOptions, type Channel } from "@opennan/timeline-core/looks/expr";
import { EFFECTS, effectParams, type EffectDefinition } from "@opennan/timeline-core/looks/effects";
import { applyHaldToFrame, buildHaldClut, haldClutPng } from "@opennan/timeline-core/looks/lut";
import { ffmpegHosts } from "./ffmpeg";
import { compareFrames, runFilter, testFrame } from "./frames";

const hosts = await ffmpegHosts();
const W = 64;
const H = 36;
const frame = testFrame(W, H, 31);
const FRAME_TIMES = [0, 11, 60];

function reference(effect: EffectDefinition, params: Record<string, number>, T: number): Uint8Array {
    let input = frame.data;
    for (const pass of effect.passes ?? []) {
        const exprs = ([0, 1, 2] as Channel[]).map((ch) => channelOut(pass.channel(ch)));
        const src = input;
        const out = new Uint8Array(src.length);
        for (let y = 0; y < H; y += 1) {
            for (let x = 0; x < W; x += 1) {
                for (let ch = 0; ch < 3; ch += 1) {
                    out[(y * W + x) * 3 + ch] = Math.trunc(evaluate(exprs[ch], { X: x, Y: y, W, H, T, params, read: (_s, c, xi, yi) => src[(yi * W + xi) * 3 + c] }));
                }
            }
        }
        input = out;
    }
    return input;
}

describe.each(hosts.map((h) => [h.name, h] as const))("effects on %s", (_name, host) => {
    for (const effect of EFFECTS.filter((e) => e.passes)) {
        it(effect.id, async () => {
            const params = effectParams(effect, null);
            for (const k of FRAME_TIMES) {
                const geqs = (effect.passes ?? []).map((pass) => `geq=${geqOptions((ch) => pass.channel(ch), { params })}`).join(",");
                const out = await runFilter(host, { frames: [frame], graph: `[0:v]setpts=PTS+${k}/30/TB,format=gbrp,${geqs},format=rgb24[out]` });
                const diff = compareFrames(out, reference(effect, params, k * (1 / 30)));
                expect(diff.mean, `${effect.id} @${k}`).toBeLessThanOrEqual(0.05);
                expect(diff.p999, `${effect.id} @${k}`).toBeLessThanOrEqual(1);
            }
        });
    }

    for (const effect of EFFECTS.filter((e) => e.lut)) {
        it(`${effect.id} (LUT)`, async () => {
            const clut = buildHaldClut(effect.lut!(effectParams(effect, null)));
            const out = await runFilter(host, {
                frames: [frame],
                files: [{ name: "clut.png", data: haldClutPng(clut) }],
                graph: "[0:v]format=rgb24[a];[1:v]format=rgb24[c];[a][c]haldclut=interp=trilinear[out]",
            });
            expect(compareFrames(out, applyHaldToFrame(frame.data, 3, clut)).max).toBe(0);
        });
    }
});
