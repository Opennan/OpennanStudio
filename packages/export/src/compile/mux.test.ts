import { buildMuxArgs, muxAudioArgs } from "../args";
import { MUX_VIDEO_SOURCE, compileMux } from "./mux";
import { COMPILE_OPTIONS, clip, input, scene } from "./test-helpers";

describe("compileMux", () => {
    const timeline = input({
        project: { aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 0.5 },
        scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" }), scene("b", 2, 2, { sourceVideoUrl: "/m/b.webm" })],
        clips: [clip("au", { trackType: "audio", trackIndex: 1, startTime: 0.5, endTime: 2.5, mediaUrl: "/m/sfx.wav", mediaType: "audio" })],
    });

    it("reads the pre-encoded video as input 0 and only audio after it", () => {
        const plan = compileMux(timeline, { resolution: "720p" }, COMPILE_OPTIONS);
        expect(plan.inputs[0]).toEqual({ kind: "file", source: MUX_VIDEO_SOURCE, options: [] });
        expect(plan.inputs.slice(1).map((i) => i.source).sort()).toEqual(["/m/a.webm", "/m/music.mp3", "/m/sfx.wav"]);
        // No video filters at all: the graph only touches audio pads.
        expect(plan.filterGraph).not.toMatch(/:v\]/);
        expect(plan.filterGraph).not.toMatch(/\[0:/);
        expect(plan.audioLabel).toBeTruthy();
        expect(plan.durationSeconds).toBeCloseTo(4, 6);
    });

    it("keeps the export's duration rule (whole frames) and audio warnings", () => {
        const plan = compileMux(input({ scenes: [scene("a", 0, 1.01, { sourceVideoUrl: "/m/a.webm" })] }), { resolution: "720p", fps: 30 }, COMPILE_OPTIONS);
        expect(plan.durationSeconds * 30).toBeCloseTo(Math.round(plan.durationSeconds * 30), 9);
        expect(plan.format.fps).toBe(30);
    });
});

describe("buildMuxArgs", () => {
    const plan = compileMux(input({ scenes: [scene("a", 0, 2, { sourceVideoUrl: "/m/a.webm" })] }), { resolution: "720p" }, COMPILE_OPTIONS);

    it("copies the video stream and encodes the mixed audio", () => {
        const args = buildMuxArgs({
            plan, container: "mp4", audioArgs: muxAudioArgs("mp4", 192), inputPaths: ["video.mp4", "a.webm"], filterScriptPath: "graph.txt",
            scriptFlag: "-/filter_complex", outputPath: "out.mp4",
        });
        const joined = args.join(" ");
        expect(joined).toContain("-i video.mp4");
        expect(joined).toContain("-map 0:v:0 -c:v copy");
        expect(joined).toContain(`-map [${plan.audioLabel}] -c:a aac -b:a 192k`);
        expect(joined).toContain("-movflags +faststart");
        expect(args[args.length - 1]).toBe("out.mp4");
    });

    it("uses Opus in WebM: ffmpeg's own encoder (libopus crashes in ffmpeg.wasm 0.12), libopus only without it", () => {
        expect(muxAudioArgs("webm", 128, new Set(["libopus", "opus"]))).toEqual(["-c:a", "opus", "-strict", "-2", "-b:a", "128k", "-ar", "48000", "-ac", "2"]);
        expect(muxAudioArgs("webm", 128, new Set(["opus"]))).toEqual(["-c:a", "opus", "-strict", "-2", "-b:a", "128k", "-ar", "48000", "-ac", "2"]);
        expect(muxAudioArgs("webm", 128, new Set(["libopus"]))).toEqual(["-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"]);
        const args = buildMuxArgs({
            plan, container: "webm", audioArgs: muxAudioArgs("webm", 128, new Set(["libopus"])), inputPaths: ["video.webm", "a.webm"],
            filterScriptPath: "graph.txt", scriptFlag: "-filter_complex_script", outputPath: "out.webm",
        });
        expect(args).not.toContain("-movflags");
    });

    it("needs one path per input", () => {
        expect(() => buildMuxArgs({
            plan, container: "mp4", audioArgs: muxAudioArgs("mp4", 192), inputPaths: ["video.mp4"], filterScriptPath: "g", scriptFlag: "-/filter_complex", outputPath: "o",
        })).toThrow();
    });
});
