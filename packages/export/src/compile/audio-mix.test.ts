import { buildAudioMixArgs } from "../args";
import { ExportError } from "../types";
import { compileAudioMix } from "./audio-mix";
import { FEATURE_MEDIA, clip, info, input, scene } from "./test-helpers";

describe("compileAudioMix (timeline audio for transcription)", () => {
    it("mixes scene audio and music without any video filter", () => {
        const plan = compileAudioMix(input({ scenes: [scene("a", 0, 2)], project: { aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 0.5 } }), { media: FEATURE_MEDIA });
        expect(plan.durationSeconds).toBe(2);
        expect(plan.audioLabel).toBe("aout");
        expect(plan.sourceCount).toBe(2);
        expect(plan.inputs.map((i) => i.source).sort()).toEqual(["/m/a.webm", "/m/music.mp3"]);
        expect(plan.filterGraph).toMatch(/amix=inputs=2/);
        expect(plan.filterGraph).not.toMatch(/\[v|scale=|overlay=|format=yuv/);
    });

    it("includes audio clips on audio tracks", () => {
        const plan = compileAudioMix(input({
            scenes: [scene("b", 0, 3)],
            clips: [clip("sfx", { trackType: "audio", trackIndex: 2, startTime: 1, endTime: 2, mediaUrl: "/m/sfx.wav", mediaType: "audio" })],
        }), { media: FEATURE_MEDIA });
        expect(plan.sourceCount).toBe(1);
        expect(plan.inputs.map((i) => i.source)).toEqual(["/m/sfx.wav"]);
    });

    it("refuses a timeline without audio and an empty timeline", () => {
        expect(() => compileAudioMix(input({ scenes: [scene("b", 0, 2)] }), { media: FEATURE_MEDIA })).toThrow(ExportError);
        try {
            compileAudioMix(input({ scenes: [scene("b", 0, 2)] }), { media: FEATURE_MEDIA });
        } catch (error) {
            expect((error as ExportError).code).toBe("no-audio");
        }
        // Media the probe rejected (left out of the map) counts as no audio.
        expect(() => compileAudioMix(input({ scenes: [scene("a", 0, 2)] }), { media: new Map() })).toThrow(/no audio/);
        expect(() => compileAudioMix(input({}), { media: new Map([["/m/a.webm", info()]]) })).toThrow(/empty/);
    });
});

describe("buildAudioMixArgs", () => {
    it("writes 16 kHz mono PCM WAV for the plan's duration", () => {
        const plan = compileAudioMix(input({ scenes: [scene("a", 0, 2)] }), { media: FEATURE_MEDIA });
        const args = buildAudioMixArgs({
            plan, inputPaths: ["/media/a.webm"], filterScriptPath: "/job/graph.txt", scriptFlag: "-/filter_complex", outputPath: "/job/mix.wav",
            inputGuards: ["-protocol_whitelist", "file"], progressPipe: true,
        });
        expect(args.slice(0, 4)).toEqual(["-hide_banner", "-y", "-loglevel", "error"]);
        expect(args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-i", "/media/a.webm", "-/filter_complex", "/job/graph.txt"]));
        const tail = args.slice(args.indexOf("-map"));
        expect(tail).toEqual(["-map", "[aout]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", "2.000", "-progress", "pipe:1", "-nostats", "-f", "wav", "/job/mix.wav"]);
        expect(() => buildAudioMixArgs({ plan, inputPaths: [], filterScriptPath: "g", scriptFlag: "-/filter_complex", outputPath: "o" })).toThrow(/one input path/);
        expect(buildAudioMixArgs({ plan, inputPaths: ["a"], filterScriptPath: "g", scriptFlag: "-/filter_complex", outputPath: "o", sampleRate: 48000 })).toContain("48000");
    });
});

describe("timelineAudioSources (phase 11: the timeline mix in the browser, for cloud captions)", () => {
    it("lists the audible sources and the duration without probing anything", async () => {
        const { timelineAudioSources } = await import("./audio-mix");
        const mix = timelineAudioSources(input({
            scenes: [scene("a", 0, 2)],
            clips: [clip("sfx", { trackType: "audio", trackIndex: 2, startTime: 1, endTime: 2, mediaUrl: "/m/sfx.wav", mediaType: "audio" })],
            project: { aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 0.5 },
        }));
        expect(mix.durationSeconds).toBe(2);
        expect(mix.sources.map((s) => s.url).sort()).toEqual(["/m/a.webm", "/m/music.mp3", "/m/sfx.wav"]);
        expect(mix.sources.find((s) => s.url === "/m/sfx.wav")).toMatchObject({ kind: "clip", start: 1, duration: 1 });
        expect(() => timelineAudioSources(input({}))).toThrow(/empty/);
    });
});
