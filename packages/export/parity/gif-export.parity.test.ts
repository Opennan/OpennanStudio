// GIF export (phase 10d) on native ffmpeg and ffmpeg.wasm: the GPU path's two-pass GIF step (buildGifPaletteArgs +
// buildGifArgs over the intermediate video) gives exactly the frames of the ffmpeg path's one-graph palette chain
// (gifEncoder) for the same input frames, and the files loop forever.
import { buildGifArgs, buildGifPaletteArgs } from "../src/args";
import { gifEncoder } from "../src/encoders";
import { ffmpegHosts, nativeFfmpeg } from "./ffmpeg";

const hosts = await ffmpegHosts();
const native = nativeFfmpeg();
const format = { width: 320, height: 180, fps: 15 };
const plan = { format, durationSeconds: 2 };

describe.skipIf(!native).each(hosts.map((h) => [h.name, h] as const))("GIF export on %s", (_name, host) => {
    it("makes the same GIF frames in two passes as in one palette graph", async () => {
        // Lossless frames (what both engines hand the palette step), made once on the native ffmpeg.
        const video = await native!.run({ files: {}, args: ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=15:d=2", "-c:v", "ffv1", "v.mkv"], outputName: "v.mkv" });
        const encoder = gifEncoder(format);
        const oneGraph = await host.run({
            files: { "v.mkv": video },
            args: ["-i", "v.mkv", "-filter_complex", `[0:v]${encoder.videoFilters.join(",")}[venc]`, "-map", "[venc]", ...encoder.videoArgs, "-an", "one.gif"],
            outputName: "one.gif",
        });
        const palette = await host.run({ files: { "v.mkv": video }, args: buildGifPaletteArgs({ plan, inputPath: "v.mkv", outputPath: "p.png" }).slice(4), outputName: "p.png" });
        const twoPass = await host.run({ files: { "v.mkv": video, "p.png": palette }, args: buildGifArgs({ plan, inputPath: "v.mkv", palettePath: "p.png", outputPath: "two.gif" }).slice(4), outputName: "two.gif" });
        const frames = (gif: Uint8Array) => native!.run({ files: { "g.gif": gif }, args: ["-i", "g.gif", "-f", "rawvideo", "-pix_fmt", "rgb24", "f.raw"], outputName: "f.raw" });
        const [a, b] = [await frames(oneGraph), await frames(twoPass)];
        expect(a.length).toBe(30 * 320 * 180 * 3);
        expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
        for (const gif of [oneGraph, twoPass]) {
            expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");
            expect(Buffer.from(gif).includes(Buffer.from("NETSCAPE2.0"))).toBe(true);
        }
    }, 120_000);
});
