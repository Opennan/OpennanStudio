import { buildFfmpegArgs, buildFrameArgs, filterScript, filterScriptFlag, frameFilterScript } from "./args";
import { encoderCandidates, encoderChoice, INTERMEDIATE_ENCODER, parseEncoderList } from "./encoders";
import { parseFfprobeJson } from "./probe-json";
import { parseProgressSeconds, progressRatio } from "./progress";
import type { ExportPlan } from "./types";

const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D mpeg4                MPEG-4 part 2
 V....D libvpx-vp9           libvpx VP9 (codec vp9)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopus              libopus Opus (codec opus)
`;
const options = { videoBitrateKbps: 8000, audioBitrateKbps: 192 };

describe("encoders", () => {
    it("parses `ffmpeg -encoders`", () => {
        expect([...parseEncoderList(ENCODERS)]).toEqual(["libx264", "h264_videotoolbox", "mpeg4", "libvpx-vp9", "aac", "libopus"]);
    });

    it("prefers LGPL H.264 and never needs libx264", () => {
        expect(encoderCandidates(parseEncoderList(ENCODERS), options).map((c) => c.name)).toEqual(["h264_videotoolbox", "libvpx-vp9", "mpeg4"]);
        expect(encoderCandidates(parseEncoderList(ENCODERS), { ...options, allowGpl: true }).map((c) => c.name))
            .toEqual(["h264_videotoolbox", "libx264", "libvpx-vp9", "mpeg4"]);
        expect(encoderCandidates(new Set(["libopenh264", "h264_mf"]), options).map((c) => c.name)).toEqual(["h264_mf", "libopenh264", "mpeg4"]);
        expect(encoderCandidates(new Set(), options).map((c) => c.name)).toEqual(["mpeg4"]);
    });

    it("VAAPI uploads frames and WebM uses Opus", () => {
        const vaapi = encoderChoice("h264_vaapi", options);
        expect(vaapi.globalArgs).toEqual(["-vaapi_device", "/dev/dri/renderD128"]);
        expect(vaapi.videoFilters).toEqual(["format=nv12", "hwupload"]);
        expect(encoderChoice("libvpx-vp9", options).audioArgs.slice(0, 2)).toEqual(["-c:a", "libopus"]);
        expect(encoderChoice("libx264", options).gpl).toBe(true);
    });
});

const plan: ExportPlan = {
    format: { width: 1280, height: 720, fps: 30, aspectRatio: 16 / 9, refWidth: 1920, refHeight: 1080, frameScale: 2 / 3 },
    durationSeconds: 2,
    inputs: [{ kind: "media", source: "/a.mp4", options: ["-ss", "0.500", "-t", "2.000"] }, { kind: "file", source: "t.png", options: ["-loop", "1"] }],
    filterGraph: "[0:v]null[vout];\n[0:a]anull[aout]",
    videoLabel: "vout",
    audioLabel: "aout",
    files: [],
    glPasses: [],
    warnings: [],
    videoBitrateKbps: 5000,
    audioBitrateKbps: 192,
};

describe("args", () => {
    it("picks the filter script flag by ffmpeg version", () => {
        expect(filterScriptFlag(7)).toBe("-/filter_complex");
        expect(filterScriptFlag(6)).toBe("-filter_complex_script");
    });

    it("builds the command line", () => {
        const args = buildFfmpegArgs({
            plan, encoder: encoderChoice("h264_videotoolbox", options), inputPaths: ["/a.mp4", "/tmp/t.png"],
            filterScriptPath: "/tmp/graph.txt", scriptFlag: "-/filter_complex", outputPath: "/tmp/out.mp4", progressPipe: true,
        });
        expect(args).toEqual([
            "-hide_banner", "-y", "-loglevel", "error",
            "-ss", "0.500", "-t", "2.000", "-i", "/a.mp4", "-loop", "1", "-i", "/tmp/t.png",
            "-/filter_complex", "/tmp/graph.txt", "-map", "[vout]", "-map", "[aout]",
            "-c:v", "h264_videotoolbox", "-b:v", "8000k", "-allow_sw", "1", "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-t", "2.000", "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats", "/tmp/out.mp4",
        ]);
    });

    it("builds a single-frame PNG command", () => {
        expect(buildFrameArgs({
            plan, inputPaths: ["/a.mp4", "/tmp/t.png"], filterScriptPath: "/tmp/g.txt", scriptFlag: "-filter_complex_script", outputPath: "/tmp/f.png", seconds: 1.5,
        }).slice(14)).toEqual([
            "-filter_complex_script", "/tmp/g.txt", "-map", "[vout]", "-ss", "1.500", "-frames:v", "1", "-an", "-c:v", "png", "-f", "image2", "-update", "1", "/tmp/f.png",
        ]);
    });

    it("frame scripts consume the audio pad and scale on request", () => {
        // ffmpeg rejects an unconnected [aout] ("output 1 (aout) unconnected", exit 234).
        expect(frameFilterScript(plan)).toEqual({ script: "[0:v]null[vout];\n[0:a]anull[aout];\n[aout]anullsink", videoPad: "vout" });
        expect(frameFilterScript(plan, { width: 320, height: 180 })).toEqual({
            script: "[0:v]null[vout];\n[0:a]anull[aout];\n[vout]scale=320:180[frame];\n[aout]anullsink", videoPad: "frame",
        });
    });

    it("guards every input with the runner's whitelists", () => {
        const guards = ["-protocol_whitelist", "file,pipe"];
        const args = buildFfmpegArgs({
            plan, encoder: encoderChoice("mpeg4", options), inputPaths: ["/a.mp4", "/tmp/t.png"], filterScriptPath: "/g", scriptFlag: "-/filter_complex",
            outputPath: "/o.mp4", inputGuards: guards,
        });
        expect(args.slice(4, 18)).toEqual([
            "-protocol_whitelist", "file,pipe", "-ss", "0.500", "-t", "2.000", "-i", "/a.mp4",
            "-protocol_whitelist", "file,pipe", "-loop", "1", "-i", "/tmp/t.png",
        ]);
    });

    it("appends hardware upload to the graph", () => {
        expect(filterScript(plan, encoderChoice("h264_vaapi", options))).toEqual({
            script: "[0:v]null[vout];\n[0:a]anull[aout];\n[vout]format=nv12,hwupload[venc]", videoPad: "venc",
        });
        expect(INTERMEDIATE_ENCODER.container).toBe("mkv");
    });
});

describe("progress and probe parsing", () => {
    it("reads -progress and log lines", () => {
        expect(parseProgressSeconds("out_time_us=1500000")).toBe(1.5);
        expect(parseProgressSeconds("out_time=00:00:02.250000")).toBe(2.25);
        expect(parseProgressSeconds("frame=  60 fps=0.0 q=-1.0 size=  256kB time=00:01:02.50 bitrate=")).toBe(62.5);
        expect(parseProgressSeconds("time=-577014:32:22.77")).toBeNull();
        expect(parseProgressSeconds("progress=continue")).toBeNull();
        expect(progressRatio(3, 2)).toBe(1);
    });

    it("reads ffprobe JSON", () => {
        expect(parseFfprobeJson(JSON.stringify({
            streams: [{ codec_type: "video", width: 640, height: 360 }, { codec_type: "audio" }], format: { duration: "4.000000" },
        }))).toEqual({ durationSeconds: 4, hasVideo: true, hasAudio: true, width: 640, height: 360 });
        expect(parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: "video", width: 10, height: 10 }], format: {} }))?.durationSeconds).toBe(0);
        expect(parseFfprobeJson("nope")).toBeNull();
        expect(parseFfprobeJson(JSON.stringify({ streams: [] }))).toBeNull();
    });
});

describe("GIF output (phase 10d)", () => {
    const gifPlan: ExportPlan = { ...plan, format: { ...plan.format, width: 640, height: 360, fps: 15 } };

    it("writes a GIF through the palette chain, without audio, looping forever", async () => {
        const { gifEncoder, containerMimeType } = await import("./encoders");
        const encoder = gifEncoder(gifPlan.format);
        expect(containerMimeType("gif")).toBe("image/gif");
        expect(encoder).toMatchObject({ name: "gif", container: "gif", gpl: false, noAudio: true });
        const { script, videoPad } = filterScript(gifPlan, encoder);
        expect(videoPad).toBe("venc");
        expect(script).toContain(`[${gifPlan.videoLabel}]fps=15,scale=640:360:flags=lanczos,split[gifa][gifb];[gifa]palettegen[gifp];[gifb][gifp]paletteuse[venc]`);
        // The audio chain still exists in the graph and must end somewhere.
        expect(script.endsWith(`[${gifPlan.audioLabel}]anullsink`)).toBe(true);
        const args = buildFfmpegArgs({ plan: gifPlan, encoder, inputPaths: ["a", "b"], filterScriptPath: "g.txt", scriptFlag: "-/filter_complex", outputPath: "out.gif" });
        expect(args).not.toContain(`[${gifPlan.audioLabel}]`);
        expect(args).toEqual(expect.arrayContaining(["-c:v", "gif", "-loop", "0", "-an"]));
        expect(args).not.toContain("+faststart");
    });

    it("builds the GPU path's two-pass GIF step with the same filters", async () => {
        const { buildGifArgs, buildGifPaletteArgs } = await import("./args");
        const step = { format: { width: 640, height: 360, fps: 15 }, durationSeconds: 2.5 };
        expect(buildGifPaletteArgs({ plan: step, inputPath: "v.mp4", outputPath: "p.png", inputGuards: ["-g", "x"] })).toEqual([
            "-hide_banner", "-y", "-loglevel", "info", "-g", "x", "-i", "v.mp4", "-vf", "fps=15,scale=640:360:flags=lanczos,palettegen", "-t", "2.500",
            "-frames:v", "1", "-update", "1", "p.png",
        ]);
        const args = buildGifArgs({ plan: step, inputPath: "v.mp4", palettePath: "p.png", outputPath: "o.gif", progressPipe: true });
        expect(args).toEqual(expect.arrayContaining(["-lavfi", "[0:v]fps=15,scale=640:360:flags=lanczos[gifx];[gifx][1:v]paletteuse", "-loop", "0", "-an", "-progress", "pipe:1"]));
        expect(args.at(-1)).toBe("o.gif");
    });
});
