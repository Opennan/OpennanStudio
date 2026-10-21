import { encoderChoice } from "../encoders";
import type { ExportPlan } from "../types";
import type { MuxPlan } from "../compile/mux";
import { loadVerifiedFfmpegCore } from "./core-loader";
import { createWasmRunner, wasmMediaName, type FFmpegLike } from "./wasm-runner";

function fakeFFmpeg(options: { execCode?: number } = {}) {
    const files = new Map<string, Uint8Array | string>();
    const listeners = new Set<(e: { type: string; message: string }) => void>();
    const calls: string[][] = [];
    const log = (message: string) => listeners.forEach((l) => l({ type: "stderr", message }));
    const ffmpeg: FFmpegLike = {
        load: async () => true,
        async exec(args) {
            calls.push(args);
            if (args.includes("-encoders")) {
                log(" V....D libx264              libx264 H.264");
                log(" V....D libvpx-vp9           libvpx VP9");
                log(" A....D libopus              libopus Opus");
                log(" A..X.D opus                 Opus");
                return 0;
            }
            log("frame=   30 fps= 10 q=-1.0 size=     1kB time=00:00:01.00 bitrate=");
            files.set(args[args.length - 1], new Uint8Array([1, 2, 3]));
            return options.execCode ?? 0;
        },
        async ffprobe(args) {
            calls.push(["ffprobe", ...args]);
            files.set(args[args.length - 1], JSON.stringify({ streams: [{ codec_type: "video", width: 64, height: 36 }], format: { duration: "2.0" } }));
            // ffmpeg.wasm 0.12 returns -1 from ffprobe even when it wrote the JSON.
            return -1;
        },
        writeFile: async (path, data) => { files.set(path, data); return true; },
        readFile: async (path) => files.get(path) ?? "",
        deleteFile: async (path) => { files.delete(path); return true; },
        on: (_e, cb) => { listeners.add(cb); },
        off: (_e, cb) => { listeners.delete(cb); },
        terminate: () => undefined,
    };
    return { ffmpeg, files, calls };
}

const plan: ExportPlan = {
    format: { width: 1280, height: 720, fps: 30, aspectRatio: 16 / 9, refWidth: 1920, refHeight: 1080, frameScale: 2 / 3 },
    durationSeconds: 2,
    inputs: [{ kind: "media", source: "/a.webm?x=1", options: [] }, { kind: "file", source: "raster-0.png", options: ["-loop", "1"] }],
    filterGraph: "[0:v][1:v]overlay[vout];\n[0:a]anull[aout]",
    videoLabel: "vout",
    audioLabel: "aout",
    files: [{ name: "raster-0.png", data: new Uint8Array([9]) }],
    glPasses: [],
    warnings: [],
    videoBitrateKbps: 5000,
    audioBitrateKbps: 192,
};

describe("wasm runner", () => {
    it("names wasm files by index and extension", () => {
        expect(wasmMediaName(3, "blob:http://x/abc")).toBe("m3.bin");
        expect(wasmMediaName(0, "/media/clip.WEBM?token=1")).toBe("m0.webm");
    });

    it("probes media through ffprobe", async () => {
        const fake = fakeFFmpeg();
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array([1]), createFFmpeg: async () => fake.ffmpeg });
        const media = await runner.probe(["/a.webm?x=1"]);
        expect(media.get("/a.webm?x=1")).toEqual({ durationSeconds: 2, hasVideo: true, hasAudio: false, width: 64, height: 36 });
        expect(runner.supportsGl).toBe(false);
        expect(runner.maxResolution).toBe("1080p");
    });

    it("skips the wasm VP9 encoder: MPEG-4 without GPL, libx264 when allowed", async () => {
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array([1]), createFFmpeg: async () => fakeFFmpeg().ffmpeg });
        expect((await runner.chooseEncoder({ videoBitrateKbps: 1, audioBitrateKbps: 1 })).name).toBe("mpeg4");
        expect((await runner.chooseEncoder({ videoBitrateKbps: 1, audioBitrateKbps: 1, allowGpl: true })).name).toBe("libx264");
    });

    it("runs the job, reports progress, returns bytes and cleans up", async () => {
        const fake = fakeFFmpeg();
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array([7]), createFFmpeg: async () => fake.ffmpeg });
        const ratios: number[] = [];
        const output = await runner.run(plan, encoderChoice("libx264", { videoBitrateKbps: 5000, audioBitrateKbps: 192 }), { onProgress: (r) => ratios.push(r) });
        expect(output).toEqual({ kind: "bytes", data: new Uint8Array([1, 2, 3]) });
        expect(ratios).toEqual([0.5]);
        const args = fake.calls[fake.calls.length - 1];
        expect(args).toContain("-filter_complex_script");
        // Looped stills probe one packet: the default 5 MB probe holds several copies of the image per input.
        expect(args.slice(args.indexOf("-loop") - 2, args.indexOf("-loop") + 6)).toEqual(["-i", "m0.webm", "-loop", "1", "-probesize", "65536", "-i", "raster-0.png"]);
        expect([...fake.files.keys()]).toEqual([]);
    });

    it("turns a non-zero exit into ExportError ffmpeg-failed", async () => {
        const fake = fakeFFmpeg({ execCode: 1 });
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array([7]), createFFmpeg: async () => fake.ffmpeg });
        await expect(runner.run(plan, encoderChoice("mpeg4", { videoBitrateKbps: 1, audioBitrateKbps: 1 }))).rejects.toMatchObject({ code: "ffmpeg-failed" });
    });

    it("fails with too-large above the media budget and frees what it wrote", async () => {
        const fake = fakeFFmpeg();
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array(600), createFFmpeg: async () => fake.ffmpeg, maxMediaBytes: 1000 });
        await expect(runner.probe(["/a.webm", "/b.webm"])).rejects.toMatchObject({ code: "too-large" });
        expect([...fake.files.keys()]).toEqual([]);
    });

    it("counts job files (graphics image sequences) against the budget too", async () => {
        const fake = fakeFFmpeg();
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array(100), createFFmpeg: async () => fake.ffmpeg, maxMediaBytes: 1000 });
        const big = { ...plan, files: Array.from({ length: 4 }, (_v, i) => ({ name: `gfx0-0000${i}.png`, data: new Uint8Array(300) })) };
        await expect(runner.run(big, encoderChoice("libx264", { videoBitrateKbps: 5000, audioBitrateKbps: 192 }))).rejects.toMatchObject({ code: "too-large" });
        expect([...fake.files.keys()].filter((name) => name.startsWith("gfx"))).toEqual([]);
    });

    it("refuses an ffmpeg core whose SHA-256 does not match", async () => {
        const fetchStub = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
        await expect(loadVerifiedFfmpegCore("/ffmpeg-core", fetchStub)).rejects.toMatchObject({ code: "core-unavailable" });
        const sha = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"; // SHA-256 of bytes 1, 2, 3
        const core = await loadVerifiedFfmpegCore("/ffmpeg-core", fetchStub, { "ffmpeg-core.js": sha, "ffmpeg-core.wasm": sha });
        expect(core.coreURL).toMatch(/^blob:/);
        core.revoke();
    });

    it("muxes GPU video bytes with the audio graph and frees every file", async () => {
        const fake = fakeFFmpeg();
        const read: string[] = [];
        const runner = createWasmRunner({ readMedia: async (url) => { read.push(url); return new Uint8Array([7]); }, createFFmpeg: async () => fake.ffmpeg });
        const mux: MuxPlan = {
            format: plan.format, durationSeconds: 2, audioBitrateKbps: 128, warnings: [],
            inputs: [{ kind: "file", source: "gpu-video", options: [] }, { kind: "media", source: "/a.webm", options: [] }],
            filterGraph: "[1:a]anull[aout]", audioLabel: "aout",
        };
        const progress: number[] = [];
        const out = await runner.mux!(mux, { kind: "bytes", data: new Uint8Array([1, 2]) }, { container: "webm", onProgress: (r) => progress.push(r) });
        expect(out).toEqual({ kind: "bytes", data: new Uint8Array([1, 2, 3]) });
        const args = fake.calls.find((call) => call.includes("-c:v"))!;
        expect(args.join(" ")).toContain("-i gpu-video.webm");
        expect(args.join(" ")).toContain("-map 0:v:0 -c:v copy");
        expect(args.join(" ")).toContain("-c:a opus -strict -2");
        expect(read).toEqual(["/a.webm"]);
        expect(progress).toEqual([0.5]);
        expect([...fake.files.keys()]).toEqual([]);
    });

    it("refuses a file video (no shared filesystem with the page)", async () => {
        const fake = fakeFFmpeg();
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array([7]), createFFmpeg: async () => fake.ffmpeg });
        const mux = { format: plan.format, durationSeconds: 2, audioBitrateKbps: 128, warnings: [], inputs: [], filterGraph: "", audioLabel: "a" };
        await expect(runner.mux!(mux, { kind: "file", path: "/tmp/x" }, { container: "mp4" })).rejects.toMatchObject({ code: "runner-unsupported" });
    });

    it("makes a GIF from GPU video bytes in two passes and frees every file (phase 10d)", async () => {
        const fake = fakeFFmpeg();
        const runner = createWasmRunner({ readMedia: async () => new Uint8Array([7]), createFFmpeg: async () => fake.ffmpeg });
        const progress: number[] = [];
        const out = await runner.gif!({ format: { width: 640, height: 360, fps: 15 }, durationSeconds: 2 }, { kind: "bytes", data: new Uint8Array([1, 2]) }, { container: "mp4", onProgress: (r) => progress.push(r) });
        expect(out).toEqual({ kind: "bytes", data: new Uint8Array([1, 2, 3]) });
        const [palette, gif] = fake.calls.filter((call) => call.includes("-i"));
        expect(palette.join(" ")).toContain("-i gif-video.mp4 -vf fps=15,scale=640:360:flags=lanczos,palettegen");
        expect(gif.join(" ")).toContain("-i gif-video.mp4 -i gif-palette.png");
        expect(gif.at(-1)).toBe("gif-out.gif");
        expect(progress).toEqual([0.2, 0.7]);
        expect([...fake.files.keys()]).toEqual([]);
    });
});
