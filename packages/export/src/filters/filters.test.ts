import { clipSpeedProfile, sourceSpan } from "@opennan/timeline-core/motion/speed";
import { clipKeyframes } from "../keyframes";
import * as audio from "./audio";
import * as video from "./video";

describe("video filters", () => {
    it("crop/color/preset/blur/chroma/blend/mosaic/flip", () => {
        expect(video.cropFilters({ left: 0.1, right: 0, top: 0, bottom: 0.2 })).toEqual(["crop=w=iw*(1-0.1-0):h=ih*(1-0-0.2):x=iw*0.1:y=ih*0"]);
        expect(video.cropFilters({ left: 0, right: 0, top: 0, bottom: 0 })).toEqual([]);
        expect(video.colorFilters({ brightness: 0.1, contrast: 1, saturation: 1.2 })).toEqual([
            "lutyuv=y='clip(floor(val*4096/4096)+25,0,255)':u='clip(floor(val*4915/4096)-26,0,255)':v='clip(floor(val*4915/4096)-26,0,255)'",
        ]);
        expect(video.colorFilters({ brightness: 0, contrast: 1, saturation: 1 })).toEqual([]);
        expect(video.visualFilterPreset("cool")).toEqual([
            "colorbalance=bs=0.08:rs=-0.04", "lutyuv=y=val:u='clip(floor(val*3891/4096)+6,0,255)':v='clip(floor(val*3891/4096)+6,0,255)'",
        ]);
        expect(video.blurFilters(4)).toEqual(["avgblur=sizeX=4:sizeY=4"]);
        expect(video.blurFilters(0.5)).toEqual([]);
        expect(video.chromaKeyFilters({ enabled: true, color: "0x00FF00", similarity: 0.1, blend: 0 })).toEqual(["chromakey=0x00FF00:0.1:0"]);
        expect(video.blendModeFilters("screen")).toEqual(["lutyuv=y='clip(floor(val*3686/4096)+30,0,255)':u=val:v=val"]);
        expect(video.mosaicFilters(8)).toEqual(["scale=iw/8:ih/8:flags=neighbor", "scale=iw*8:ih*8:flags=neighbor"]);
        expect(video.flipFilters(true, true)).toEqual(["hflip", "vflip"]);
    });

    it("time filters", () => {
        // tpad cannot clone the last frame of a stream trimmed to one frame (it emits nothing more): loop repeats it.
        expect(video.freezeFilters(true, 3, 30)).toEqual(["trim=end_frame=1", "setpts=PTS-STARTPTS", "loop=loop=89:size=1:start=0", "setpts=N/30/TB"]);
        expect(video.freezeFilters(true, 1.01, 30)).toEqual(["trim=end_frame=1", "setpts=PTS-STARTPTS", "loop=loop=30:size=1:start=0", "setpts=N/30/TB"]);
        expect(video.reverseFilters(true)).toEqual(["reverse"]);
    });

    it("legacy speed ramp tables (bounds as fractions of the clip) match their step curves", () => {
        const table = video.speedRampTable("hero", 4, 1)!;
        expect(table.sourceSpan).toBeCloseTo(3.16);
        // Each segment's line reaches the next segment's output start: the remap never jumps back.
        table.segments.slice(1).forEach((segment, i) => {
            const prev = table.segments[i];
            expect(prev.outputStart + (segment.sourceStart - prev.sourceStart) / prev.speed).toBeCloseTo(segment.outputStart);
        });
        const last = table.segments[table.segments.length - 1];
        expect(last.outputStart + (table.sourceSpan - last.sourceStart) / last.speed).toBeCloseTo(4);
        expect(video.averageSourceSpeed("hero", 4, 2)).toBeCloseTo(1.58);
        expect(video.averageSourceSpeed("none", 4, 2)).toBe(2);
        for (const ramp of ["montage", "hero", "bullet"] as const) {
            expect(sourceSpan(clipSpeedProfile({ speedRamp: ramp, playbackSpeed: 1.5 }), 4)).toBeCloseTo(video.speedRampTable(ramp, 4, 1.5)!.sourceSpan, 12);
        }
    });

    it("fades and clip transitions", () => {
        expect(video.alphaFadeFilters(0.5, 1, 4)).toEqual(["format=yuva444p", "fade=t=in:st=0:d=0.5:alpha=1", "fade=t=out:st=3:d=1:alpha=1"]);
        expect(video.clipTransitionFilters("dip_white", 0.5, 0, 4)).toEqual(["fade=t=in:st=0:d=0.5:color=white"]);
        expect(video.clipTransitionFilters("slide_left", 0.5, 0, 4)).toEqual(["format=yuva444p", "fade=t=in:st=0:d=0.5:alpha=1"]);
    });

    it("motion presets", () => {
        expect(video.motionScaleExpression("zoom_in", 4, "T")).toBe("(1+0.08*T/4)");
        expect(video.motionScaleExpression("none", 4, "T")).toBeNull();
        expect(video.motionScalePeak("pulse")).toBe(1.04);
    });
});

describe("audio filters", () => {
    it("tempo chains stay within atempo's range", () => {
        expect(audio.tempoFilters(4)).toEqual(["atempo=2", "atempo=2"]);
        expect(audio.tempoFilters(5)).toEqual(["atempo=2", "atempo=2", "atempo=1.25"]);
        expect(audio.tempoFilters(0.25)).toEqual(["atempo=0.5", "atempo=0.5"]);
        expect(audio.tempoFilters(1.5)).toEqual(["atempo=1.5"]);
    });

    it("pan, pitch, eq, denoise, normalize, fades", () => {
        expect(audio.panFilters(-1)).toEqual(["pan=stereo|c0=1*c0|c1=0*c1"]);
        expect(audio.panFilters(0.5)).toEqual(["pan=stereo|c0=0.5*c0|c1=1*c1"]);
        expect(audio.pitchFilters(12)).toEqual(["asetrate=48000*2", "aresample=48000", "atempo=0.5"]);
        expect(audio.eqFilters("vocal")).toEqual(["equalizer=f=1000:t=q:w=1:g=4", "equalizer=f=120:t=q:w=1:g=-2"]);
        expect(audio.denoiseFilters(true)).toEqual(["afftdn=nf=-25"]);
        // loudnorm outputs 192 kHz; pitch's asetrate=48000*f needs 48 kHz input.
        expect(audio.normalizeFilters(true)).toEqual(["loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=48000"]);
        expect(audio.audioFadeFilters(1, 2, 5)).toEqual(["afade=t=in:st=0:d=1", "afade=t=out:st=3:d=2"]);
    });

    it("volume: static gain, keyframed envelope, mutes", () => {
        expect(audio.volumeFilters([], 0.5, 0.5)).toEqual(["volume=0.25"]);
        expect(audio.volumeFilters([], 1, 1)).toEqual([]);
        const points = clipKeyframes(JSON.stringify([{ time: 0, volume: 0 }, { time: 1, volume: 1 }]));
        expect(audio.volumeFilters(points, 1, 0.5)).toEqual(["volume='(if(lte(t,0),0,if(gte(t,1),1,(0+(1*clip(((t-0)/1),0,1))))))*0.5':eval=frame"]);
        expect(audio.muteFilters([[1, 2], [3, 3]])).toEqual(["volume=0:enable='between(t,1,2)'"]);
    });
});
