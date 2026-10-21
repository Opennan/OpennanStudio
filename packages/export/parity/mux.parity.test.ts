// The GPU path's audio mux on ffmpeg.wasm (the web app's engine): a VP9 WebM video stream-copied next to Opus audio
// with the encoder muxAudioArgs picks. libopus in the 0.12 core crashes ("memory access out of bounds"), so the mux
// must use FFmpeg's own Opus encoder.
import { muxAudioArgs } from "../src/args";
import { nativeFfmpeg, wasmFfmpeg } from "./ffmpeg";

const native = nativeFfmpeg();
const wasm = await wasmFfmpeg();

describe.skipIf(!native || !wasm)("WebM mux on ffmpeg.wasm", () => {
    it("copies a VP9 stream next to Opus audio without crashing", async () => {
        const video = await native!.run({
            files: {},
            args: ["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-an", "v.webm"],
            outputName: "v.webm",
        }).catch(() => null);
        if (!video) return; // the native build has no VP9 encoder: nothing to mux
        const encoders = new Set(["libopus", "opus"]);
        const out = await wasm!.run({
            files: { "v.webm": video },
            args: ["-i", "v.webm", "-f", "lavfi", "-i", "sine=d=2", "-map", "0:v:0", "-c:v", "copy", "-map", "1:a", ...muxAudioArgs("webm", 128, encoders), "-t", "2", "out.webm"],
            outputName: "out.webm",
        });
        expect(out.length).toBeGreaterThan(video.length);
    }, 120_000);
});
