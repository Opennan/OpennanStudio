import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SceneData, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import { exportTimeline } from "../export-timeline";
import { mixTimelineAudio } from "../mix-audio";
import type { GlFrameProcessor } from "../gl";
import { createExportFrameRenderer } from "../frame-renderer";
import type { ExportInput } from "../types";
import { createNodeRunner } from "./runner";
import { compileMux } from "../compile/mux";

const FFMPEG = process.env.OPENNAN_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.OPENNAN_FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE);

describe.skipIf(!HAS_FFMPEG)("node runner with the local ffmpeg", () => {
    let dir: string;
    let clip: string;
    const tracks: TimelineTrack[] = [
        { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
        { type: "effect", index: 1, label: "E1", muted: false, locked: false, visible: true, volume: 1 },
    ];

    beforeAll(() => {
        dir = mkdtempSync(path.join(tmpdir(), "opennan-runner-"));
        clip = path.join(dir, "clip.mkv");
        execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "ffv1", "-c:a", "flac", "-shortest", clip]);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function input(clips: ExportInput["clips"] = [], sourceVideoUrl = `file://${clip}`): ExportInput {
        const scene: SceneData = {
            id: "s", order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null,
            sourceVideoUrl, status: "ready", transition: "cut", cardType: "source_clip", duration: 2,
            frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, timelinePositionSeconds: 0.001,
        };
        return { project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 }, tracks, scenes: [scene], clips };
    }
    const noText = { rasterize: async () => { throw new Error("no text in these fixtures"); } };
    const runner = () => createNodeRunner({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputPath: (c) => path.join(dir, `out-${Date.now()}.${c}`), mediaRoots: [dir] });

    it("renders the timeline audio to a 16 kHz mono PCM WAV (transcription input)", async () => {
        const wav = path.join(dir, "mix.wav");
        const progress: number[] = [];
        const result = await mixTimelineAudio(input(), { runner: runner(), outputPath: wav, onProgress: (r) => progress.push(r) });
        expect(result).toMatchObject({ durationSeconds: 2, sourceCount: 1 });
        const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", wav], { encoding: "utf8" }));
        expect(probe.streams).toEqual([{ codec_name: "pcm_s16le", sample_rate: "16000", channels: 1 }]);
        expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
        expect(progress.length).toBeGreaterThan(0);
    });

    it("never hands ffmpeg audio from outside the media roots", async () => {
        const outside = mkdtempSync(path.join(tmpdir(), "opennan-outside-"));
        try {
            const other = path.join(outside, "other.mkv");
            execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "flac", other]);
            await expect(mixTimelineAudio(input([], `file://${other}`), { runner: runner(), outputPath: path.join(dir, "no.wav") }))
                .rejects.toMatchObject({ code: "no-audio" });
            expect(existsSync(path.join(dir, "no.wav"))).toBe(false);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("exports an MP4 with the planned duration and streams", async () => {
        const result = await exportTimeline(input(), { resolution: "720p" }, { runner: runner(), rasterizer: noText });
        expect(result.output.kind).toBe("file");
        const file = (result.output as { path: string }).path;
        const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file], { encoding: "utf8" }));
        expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
        expect(probe.streams.map((s: { codec_type: string }) => s.codec_type).sort()).toEqual(["audio", "video"]);
        expect(probe.streams.find((s: { codec_type: string }) => s.codec_type === "video")).toMatchObject({ width: 1280, height: 720 });
    });

    it("runs GL passes through the processor (two-pass)", async () => {
        const times: number[] = [];
        const invert: GlFrameProcessor = {
            async process(frame) {
                times.push(frame.time);
                const out = new Uint8Array(frame.data.length);
                for (let i = 0; i < out.length; i += 4) {
                    out[i] = 255 - frame.data[i];
                    out[i + 1] = 255 - frame.data[i + 1];
                    out[i + 2] = 255 - frame.data[i + 2];
                    out[i + 3] = 255;
                }
                return out;
            },
        };
        const fx = {
            ...optimisticTimelineClipFromInput({ trackType: "effect", trackIndex: 1, startTime: 1, endTime: 2 }, "p", "fx"),
            effects: [{ id: "r", clipId: "fx", sceneId: null, effectId: "invert", order: 0, paramsJson: null, enabled: true, ownerScope: "project" }],
        };
        const result = await exportTimeline(
            { ...input([fx]), effects: [{ id: "invert", name: "Invert", kind: "effect", category: "", params: [], glsl: "", thumbnail: null, ownerScope: "builtin" }] },
            { resolution: "720p" },
            { runner: runner(), rasterizer: noText, glProcessor: invert },
        );
        expect(times).toHaveLength(30);
        expect(times[0]).toBeCloseTo(1);
        const plain = await exportTimeline(input(), { resolution: "720p" }, { runner: runner(), rasterizer: noText });
        const pixel = (file: string, t: number) => [...execFileSync(FFMPEG, [
            "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "crop=1:1:200:600,format=rgb24", "-f", "rawvideo", "-",
        ])];
        const withGl = (result.output as { path: string }).path;
        const without = (plain.output as { path: string }).path;
        // Outside the pass the frames match; inside, every channel is inverted (allowing codec error).
        pixel(withGl, 0.5).forEach((value, i) => expect(Math.abs(value - pixel(without, 0.5)[i])).toBeLessThan(16));
        pixel(withGl, 1.5).forEach((value, i) => expect(Math.abs(value - (255 - pixel(without, 1.5)[i]))).toBeLessThan(16));
    });

    it("renders single PNG frames for the read API", async () => {
        const renderer = createExportFrameRenderer({ runner: runner(), rasterizer: noText });
        const frame = await renderer.renderFrame({ snapshot: { ...input(), project: input().project }, seconds: 1, width: 320 });
        expect(frame).toMatchObject({ mimeType: "image/png", width: 320, height: 180 });
        expect([...frame.data.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
        expect(new DataView(frame.data.buffer, frame.data.byteOffset).getUint32(16)).toBe(320);
    });

    it("never opens media outside the media roots (exports it as unreadable)", async () => {
        const result = await exportTimeline(input([], "file:///etc/passwd"), { resolution: "720p" }, { runner: runner() });
        expect(result.warnings.map((w) => w.code)).toContain("media-unreadable");
        expect(result.output.kind).toBe("file");
    });

    it("cancels a running export", async () => {
        const controller = new AbortController();
        const pending = exportTimeline(input(), { resolution: "720p" }, { runner: runner(), rasterizer: noText, signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    });

    // A one-second invert pass over [1, 2) and a runner whose job dirs go into their own parent dir.
    const invertInput = (): ExportInput => ({
        ...input([{
            ...optimisticTimelineClipFromInput({ trackType: "effect", trackIndex: 1, startTime: 1, endTime: 2 }, "p", "fx"),
            effects: [{ id: "r", clipId: "fx", sceneId: null, effectId: "invert", order: 0, paramsJson: null, enabled: true, ownerScope: "project" }],
        }]),
        effects: [{ id: "invert", name: "Invert", kind: "effect", category: "", params: [], glsl: "", thumbnail: null, ownerScope: "builtin" }],
    });
    function jobRunner() {
        const tempDir = mkdtempSync(path.join(dir, "jobs-"));
        return { tempDir, runner: createNodeRunner({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, outputPath: (c) => path.join(dir, `out-${Date.now()}.${c}`), mediaRoots: [dir], tempDir }) };
    }
    const ffmpegChildren = () => spawnSync("pgrep", ["-P", String(process.pid), "ffmpeg"], { encoding: "utf8" }).stdout.trim();
    async function expectCleanedUp(tempDir: string) {
        await vi.waitFor(() => {
            expect(readdirSync(tempDir)).toEqual([]);
            expect(ffmpegChildren()).toBe("");
        }, { timeout: 5000, interval: 50 });
    }

    it("cancels while ffmpeg is encoding and removes the job dir", async () => {
        const controller = new AbortController();
        const { tempDir, runner: jobs } = jobRunner();
        const pending = exportTimeline(input(), { resolution: "720p" }, {
            runner: jobs, rasterizer: noText, signal: controller.signal,
            onProgress: (p) => { if (p.phase === "encode" && p.ratio > 0) controller.abort(); },
        });
        await expect(pending).rejects.toMatchObject({ code: "cancelled" });
        await expectCleanedUp(tempDir);
    });

    it("cancels from inside a GL pass, kills its ffmpeg processes and removes the job dir", async () => {
        const controller = new AbortController();
        const { tempDir, runner: jobs } = jobRunner();
        let frames = 0;
        const aborting: GlFrameProcessor = {
            async process(frame) {
                frames += 1;
                if (frames === 5) controller.abort();
                return frame.data;
            },
        };
        const pending = exportTimeline(invertInput(), { resolution: "720p" }, { runner: jobs, rasterizer: noText, glProcessor: aborting, signal: controller.signal });
        await expect(pending).rejects.toMatchObject({ code: "cancelled" });
        await expectCleanedUp(tempDir);
        expect(frames).toBeLessThan(30);
    });

    it("kills the GL pass ffmpeg processes when the processor throws", async () => {
        const { tempDir, runner: jobs } = jobRunner();
        let frames = 0;
        const failing: GlFrameProcessor = {
            async process(frame) {
                frames += 1;
                if (frames === 5) throw new Error("WebGL context lost");
                return frame.data;
            },
        };
        await expect(exportTimeline(invertInput(), { resolution: "720p" }, { runner: jobs, rasterizer: noText, glProcessor: failing }))
            .rejects.toThrow("WebGL context lost");
        await expectCleanedUp(tempDir);
    });

    it("refuses a GL frame that is not width*height*4 bytes", async () => {
        const { tempDir, runner: jobs } = jobRunner();
        const short: GlFrameProcessor = { async process(frame) { return frame.data.subarray(4); } };
        await expect(exportTimeline(invertInput(), { resolution: "720p" }, { runner: jobs, rasterizer: noText, glProcessor: short }))
            .rejects.toMatchObject({ code: "ffmpeg-failed" });
        await expectCleanedUp(tempDir);
    });
    describe("mux (GPU export path)", () => {
        function encodedVideo(codec: "libx264" | "libvpx-vp9", container: "mp4" | "webm"): string {
            const file = path.join(dir, `gpu-${codec}.${container}`);
            execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
                "-c:v", codec, "-pix_fmt", "yuv420p", "-an", file]);
            return file;
        }
        const probeStreams = (file: string) => JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", file], { encoding: "utf8" }));

        it("stream-copies an H.264 MP4 next to the timeline's AAC audio", async () => {
            const jobs = runner();
            const media = await jobs.probe([`file://${clip}`]);
            const plan = compileMux(input(), { resolution: "720p" }, { media });
            const progress: number[] = [];
            const out = await jobs.mux!(plan, { kind: "file", path: encodedVideo("libx264", "mp4") }, { container: "mp4", onProgress: (r) => progress.push(r) });
            expect(out.kind).toBe("file");
            const probe = probeStreams((out as { path: string }).path);
            expect(probe.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual(["aac", "h264"]);
            expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
            expect(progress.length).toBeGreaterThan(0);
        });

        it("muxes VP9 bytes into WebM with Opus", async () => {
            const jobs = runner();
            const media = await jobs.probe([`file://${clip}`]);
            const plan = compileMux(input(), { resolution: "720p" }, { media });
            const bytes = new Uint8Array(readFileSync(encodedVideo("libvpx-vp9", "webm")));
            const out = await jobs.mux!(plan, { kind: "bytes", data: bytes }, { container: "webm" });
            const probe = probeStreams((out as { path: string }).path);
            expect(probe.streams.map((s: { codec_name: string }) => s.codec_name).sort()).toEqual(["opus", "vp9"]);
        });

        it("stops on cancel", async () => {
            const jobs = runner();
            const media = await jobs.probe([`file://${clip}`]);
            const plan = compileMux(input(), { resolution: "720p" }, { media });
            const controller = new AbortController();
            controller.abort();
            await expect(jobs.mux!(plan, { kind: "file", path: encodedVideo("libx264", "mp4") }, { container: "mp4", signal: controller.signal }))
                .rejects.toMatchObject({ code: "cancelled" });
        });
    });

    describe("GIF export (phase 10d)", () => {
        const probeGif = (file: string) => JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames,r_frame_rate:format=duration", "-of", "json", file], { encoding: "utf8" }));
        const loops = (file: string) => readFileSync(file).includes(Buffer.from("NETSCAPE2.0"));

        it("exports the timeline as a looping 15 fps GIF at most 640 wide, without audio (ffmpeg path)", async () => {
            const result = await exportTimeline(input(), { resolution: "720p", format: "gif" }, { runner: runner(), rasterizer: noText });
            expect(result).toMatchObject({ container: "gif", mimeType: "image/gif", encoder: "gif", width: 640, height: 360, engine: "ffmpeg" });
            const file = (result.output as { path: string }).path;
            expect(file.endsWith(".gif")).toBe(true);
            const probe = probeGif(file);
            expect(probe.streams).toHaveLength(1);
            expect(probe.streams[0]).toMatchObject({ codec_name: "gif", width: 640, height: 360, r_frame_rate: "15/1" });
            expect(Number(probe.streams[0].nb_read_frames)).toBe(30);
            expect(loops(file)).toBe(true);
        });

        it("turns a GPU-encoded video into the GIF in two passes (GPU path step)", async () => {
            const video = path.join(dir, "gif-src.mp4");
            execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
            const progress: number[] = [];
            const out = await runner().gif!({ format: { width: 640, height: 360, fps: 15 }, durationSeconds: 2 }, { kind: "file", path: video }, { container: "mp4", onProgress: (r) => progress.push(r) });
            const file = (out as { path: string }).path;
            const probe = probeGif(file);
            expect(probe.streams[0]).toMatchObject({ codec_name: "gif", width: 640, height: 360 });
            expect(Number(probe.streams[0].nb_read_frames)).toBe(30);
            expect(loops(file)).toBe(true);
            expect(progress.at(-1)).toBeGreaterThan(0.9);
            // The job folder (intermediate copy, palette) is gone.
            expect(readdirSync(tmpdir()).some((name) => name.startsWith("opennan-gif-") && existsSync(path.join(tmpdir(), name, "palette.png")))).toBe(false);
        });

        it("stops the GIF step on cancel and leaves no file", async () => {
            const controller = new AbortController();
            controller.abort();
            await expect(runner().gif!({ format: { width: 640, height: 360, fps: 15 }, durationSeconds: 2 }, { kind: "bytes", data: new Uint8Array([1]) }, { container: "mp4", signal: controller.signal }))
                .rejects.toMatchObject({ code: "cancelled" });
        });
    });
});
