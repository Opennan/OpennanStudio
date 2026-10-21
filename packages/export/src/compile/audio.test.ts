import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import type { AudioSource } from "../audio-model";
import { FilterGraph } from "../graph";
import { resolveOutputFormat } from "../presets";
import type { MediaInfo } from "../types";
import { compileAudio } from "./audio";
import type { CompileContext } from "./context";

const info: MediaInfo = { durationSeconds: 10, hasVideo: false, hasAudio: true, width: 0, height: 0 };
const ctx = (media: Record<string, MediaInfo>): CompileContext =>
    ({ graph: new FilterGraph(), format: resolveOutputFormat("16:9", "720p"), duration: 4, media: new Map(Object.entries(media)), rasters: new Map(), warnings: [], files: [], fileKeys: new Map() });
const base: AudioSource = { kind: "music", url: "/m/a.mp3", start: 0, duration: 4, sourceOffset: 0, stretch: null, volume: 0.5, trackVolume: 1, muted: [], clip: null };
const stretch = (segments: Array<[number, number, number, number]>, preservePitch = true, drift = 0): AudioSource["stretch"] => ({
    segments: segments.map(([outputStart, outputEnd, sourceStart, sourceEnd]) => ({ outputStart, outputEnd, sourceStart, sourceEnd, speed: (sourceEnd - sourceStart) / (outputEnd - outputStart) })),
    preservePitch,
    drift,
});

describe("compileAudio", () => {
    it("emits silence when nothing is audible", () => {
        const c = ctx({});
        expect(compileAudio(c, [base])).toBe("aout");
        expect(c.graph.toString()).toBe("anullsrc=r=48000:cl=stereo,atrim=0:4.000,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]");
    });

    it("delays, mutes and mixes sources to the exact duration", () => {
        const c = ctx({ "/m/a.mp3": info });
        compileAudio(c, [{ ...base, kind: "scene-video", start: 1, duration: 2, sourceOffset: 0.5, muted: [[1.5, 2], [9, 10]] }]);
        expect(c.graph.inputs[0].options).toEqual(["-ss", "0.500", "-t", "2.000"]);
        expect(c.graph.toString()).toBe([
            "[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=0:2.000,volume=0.5,volume=0:enable='between(t,0.5,1)',adelay=delays=1000:all=1[a0]",
            "[a0]amix=inputs=1:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=4.000,atrim=0:4.000,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]",
        ].join(";\n"));
    });

    it("applies clip audio filters in the reference order", () => {
        const c = ctx({ "/m/a.mp3": info });
        const clip = optimisticTimelineClipFromInput({
            trackType: "audio", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/a.mp3", reversePlayback: true, audioDenoise: true,
            audioEq: "bass", audioPan: 0.5, fadeInDuration: 0.5, volume: 0.5,
        }, "p", "c");
        compileAudio(c, [{ ...base, kind: "clip", duration: 2, stretch: stretch([[0, 2, 0, 4]]), volume: 0.5, trackVolume: 0.5, clip }]);
        // The read adds atempo's flush overlap; reverse trims it first, so the source span is what plays backwards.
        expect(c.graph.inputs[0].options).toEqual(["-ss", "0.000", "-t", "4.200"]);
        expect(c.graph.toString()).toContain("atrim=end=4,areverse,atempo=2,asetpts=N/SR/TB,apad=whole_len=96000,atrim=end_sample=96000,afftdn=nf=-25,equalizer=f=100:t=q:w=1:g=5,pan=stereo|c0=0.5*c0|c1=1*c1,atrim=0:2.000,afade=t=in:st=0:d=0.5,volume=0.25[a0]");
    });

    it("resamples loudnorm's 192 kHz output to 48 kHz before pitch", () => {
        const c = ctx({ "/m/a.mp3": info });
        const clip = optimisticTimelineClipFromInput({ trackType: "audio", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/a.mp3", audioNormalize: true, audioPitch: 12 }, "p", "n");
        compileAudio(c, [{ ...base, kind: "clip", duration: 2, clip }]);
        expect(c.graph.toString()).toContain("loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,asetrate=48000*2,aresample=48000,atempo=0.5");
    });

    it("reports audio media that could not be read, but not media without an audio stream", () => {
        const c = ctx({ "/m/silent.webm": { ...info, hasVideo: true, hasAudio: false } });
        const clip = optimisticTimelineClipFromInput({ trackType: "audio", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/etc/rejected.mp3" }, "p", "a2");
        const overlay = optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: "/m/gone.webm" }, "p", "v2");
        expect(compileAudio(c, [
            { ...base, kind: "clip", url: "/etc/rejected.mp3", duration: 2, clip },
            { ...base, kind: "overlay-clip", url: "/m/gone.webm", duration: 2, clip: overlay },
            { ...base, kind: "music", url: "/m/song.mp3" },
            { ...base, kind: "scene-voiceover", url: "/m/vo.mp3", sceneId: "s1" },
            { ...base, kind: "scene-video", url: "/m/scene.webm", sceneId: "s2" },
            { ...base, kind: "overlay-clip", url: "/m/silent.webm", clip: overlay },
        ])).toBe("aout");
        const message = "Audio media could not be read; it is left out.";
        expect(c.warnings).toEqual([
            { code: "media-unreadable", message, clipId: "a2" },
            { code: "media-unreadable", message, clipId: "v2" },
            { code: "media-unreadable", message },
            { code: "media-unreadable", message, sceneId: "s1" },
        ]);
        expect(c.graph.inputs).toEqual([]);
    });

    it("plays each speed segment from one read and concatenates them to exact sample counts", () => {
        const c = ctx({ "/m/v.webm": info });
        const clip = optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/m/v.webm", speedRamp: "montage" }, "p", "r");
        compileAudio(c, [{ ...base, kind: "overlay-clip", url: "/m/v.webm", duration: 4, volume: 1, clip, stretch: stretch([[0, 1, 0, 0.55], [1, 3, 0.55, 4.25], [3, 4, 4.25, 5]]) }]);
        expect(c.graph.inputs).toHaveLength(1);
        expect(c.graph.inputs[0].options).toEqual(["-ss", "0.000", "-t", "5.100"]);
        expect(c.graph.toString()).toBe([
            "[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asplit=3[as0][as1][as2]",
            "[as0]atrim=start=0:end=0.65,asetpts=PTS-STARTPTS,atempo=0.55,asetpts=N/SR/TB,apad=whole_len=48000,atrim=end_sample=48000[ag3]",
            "[as1]atrim=start=0.55:end=4.435,asetpts=PTS-STARTPTS,atempo=1.85,asetpts=N/SR/TB,apad=whole_len=96000,atrim=end_sample=96000[ag4]",
            "[as2]atrim=start=4.25:end=5.1,asetpts=PTS-STARTPTS,atempo=0.75,asetpts=N/SR/TB,apad=whole_len=48000,atrim=end_sample=48000[ag5]",
            "[ag3][ag4][ag5]concat=n=3:v=0:a=1,atrim=0:4.000[a6]",
            "[a6]amix=inputs=1:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=4.000,atrim=0:4.000,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]",
        ].join(";\n"));
        // Step curves (legacy ramps) are exact: nothing to report.
        expect(c.warnings).toEqual([]);
    });

    it("renumbers a delayed atempo chain by sample count (adelay's silence would be trimmed away)", () => {
        const c = ctx({ "/m/a.mp3": info });
        compileAudio(c, [{ ...base, kind: "scene-video", start: 0.5, duration: 1, stretch: stretch([[0, 1, 0, 2]]) }]);
        expect(c.graph.toString()).toContain("atrim=0:1.000,volume=0.5,adelay=delays=500:all=1,asetpts=N/SR/TB[a0]");
        const plain = ctx({ "/m/a.mp3": info });
        compileAudio(plain, [{ ...base, kind: "scene-video", start: 0.5, duration: 1, stretch: stretch([[0, 1, 0, 2]], false) }]);
        expect(plain.graph.toString()).toContain("adelay=delays=500:all=1[a0]");
    });

    it("lets the pitch follow the speed when keep-pitch is off", () => {
        const c = ctx({ "/m/a.mp3": info });
        compileAudio(c, [{ ...base, kind: "scene-video", duration: 2, stretch: stretch([[0, 2, 0, 1]], false) }]);
        expect(c.graph.toString()).toContain("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetrate=24000,aresample=48000,asetpts=N/SR/TB,apad=whole_len=96000,atrim=end_sample=96000,atrim=0:2.000,volume=0.5");
    });

    it("reports curve audio only when it can drift more than a frame from the picture", () => {
        const c = ctx({ "/m/v.webm": info });
        const clip = optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: "/m/v.webm" }, "p", "r");
        compileAudio(c, [
            { ...base, kind: "overlay-clip", url: "/m/v.webm", duration: 4, clip, stretch: stretch([[0, 4, 0, 6]], true, 0.01) },
            { ...base, kind: "scene-video", url: "/m/v.webm", duration: 4, sceneId: "s", stretch: stretch([[0, 4, 0, 6]], true, 0.25) },
        ]);
        expect(c.warnings).toEqual([{ code: "speed-ramp-audio-approximated", message: expect.stringContaining("250 ms"), sceneId: "s" }]);
    });
});
