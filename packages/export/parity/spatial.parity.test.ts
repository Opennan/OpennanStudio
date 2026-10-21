import { describe, expect, it } from "vitest";
import { encodePng } from "@opennan/timeline-core/looks/png";
import {
    convolve3x3Reference, grainCropOptions, grainImage, grainWindow, grainmergeReference, multiplyReference, sharpenFilters, sharpenKernel,
    vignetteMask,
} from "@opennan/timeline-core/looks/spatial";
import { ffmpegHosts } from "./ffmpeg";
import { compareFrames, runFilter, splitFrames, testFrame } from "./frames";

const hosts = await ffmpegHosts();
const W = 72;
const H = 40;

describe.each(hosts.map((h) => [h.name, h] as const))("spatial adjustments on %s", (_name, host) => {
    for (const amount of [0.25, 0.6, 1]) {
        it(`sharpen ${amount}`, async () => {
            const frame = testFrame(W, H, 11);
            const kernel = sharpenKernel(amount)!;
            const out = await runFilter(host, { frames: [frame], graph: `[0:v]format=gbrp,${sharpenFilters(kernel).join(",")},format=rgb24[out]` });
            expect(compareFrames(out, convolve3x3Reference(frame.data, W, H, 3, kernel)).max).toBe(0);
        });

        it(`vignette ${amount}`, async () => {
            const frame = testFrame(W, H, 12);
            const mask = vignetteMask(W, H, amount);
            const out = await runFilter(host, {
                frames: [frame],
                files: [{ name: "mask.png", data: encodePng({ width: W, height: H, channels: 1, data: mask }) }],
                graph: "[0:v]format=gbrp[a];[1:v]format=gbrp[m];[a][m]blend=all_mode=multiply,format=rgb24[out]",
            });
            expect(compareFrames(out, multiplyReference(frame.data, mask, 3)).max).toBe(0);
        });
    }

    it("grain moves its window with time and merges exactly", async () => {
        const frame = testFrame(W, H, 13);
        const grain = grainImage(W, H, 0.8);
        const fps = 30;
        const out = await runFilter(host, {
            frames: [frame],
            seconds: 0.2,
            fps,
            files: [{ name: "grain.png", data: encodePng({ width: grain.width, height: grain.height, channels: 1, data: grain.data }), options: ["-loop", "1", "-framerate", String(fps), "-t", "0.2"] }],
            graph: `[0:v]format=gbrp[a];[1:v]crop=${grainCropOptions(W, H)},format=gbrp[g];[a][g]blend=all_mode=grainmerge:shortest=1,format=rgb24[out]`,
        });
        const frames = splitFrames(out, W * H * 3);
        expect(frames.length).toBe(6);
        frames.forEach((f, n) => {
            expect(compareFrames(f, grainmergeReference(frame.data, grainWindow(grain, W, H, n / fps), 3)).max, `frame ${n}`).toBe(0);
        });
    });
});
