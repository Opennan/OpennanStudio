import { describe, expect, it } from "vitest";
import { applyHaldToFrame, buildHaldClut, haldClutPng } from "@opennan/timeline-core/looks/lut";
import { ffmpegHosts } from "./ffmpeg";
import { compareFrames, runFilter, testFrame } from "./frames";

const hosts = await ffmpegHosts();

describe("parity harness", () => {
    it("finds the native LGPL ffmpeg and the ffmpeg.wasm core", () => {
        expect(hosts.map((h) => h.name.split(" ")[0])).toEqual(["native", "wasm"]);
        expect(hosts[1].version).toMatch(/^5\.1/);
    });

    for (const host of hosts) {
        it(`round-trips raw RGB unchanged on ${host.name}`, async () => {
            const frame = testFrame(48, 32, 7);
            const out = await runFilter(host, { frames: [frame], graph: "[0:v]null[out]" });
            expect(compareFrames(out, frame.data).max).toBe(0);
        });

        it(`haldclut on packed RGB matches the trilinear reference on ${host.name}`, async () => {
            const frame = testFrame(64, 40, 3);
            const clut = buildHaldClut((c) => [c[1] * 0.9, Math.sqrt(c[2]), 1 - c[0]]);
            const out = await runFilter(host, {
                frames: [frame],
                files: [{ name: "clut.png", data: haldClutPng(clut) }],
                graph: "[0:v]format=rgb24[a];[1:v]format=rgb24[c];[a][c]haldclut=interp=trilinear[out]",
            });
            expect(compareFrames(out, applyHaldToFrame(frame.data, 3, clut)).max).toBe(0);
        });
    }
});
