import { clipSpeedProfile, outputTimeAt, sourceTimeAt, speedCurvePreset, type SpeedProfile } from "@opennan/timeline-core/motion/speed";
import {
    MAX_AUDIO_SLICE_DENSITY, REMAP_BIAS_FRAMES, VIDEO_PREROLL_SECONDS, VIDEO_SLACK_SECONDS,
    audioSegmentOverlap, audioStretch, audioTempoFilters, clipRemap, pickSourceFrame, pieceRead, remapFilters,
} from "./speed-remap";

const constant = (speed: number, preservePitch = true): SpeedProfile => ({ speed, curve: null, preservePitch });
const curve = (id: string, speed = 1): SpeedProfile => ({ speed, curve: speedCurvePreset(id), preservePitch: true });

describe("remapFilters", () => {
    it("identity speed needs no remap", () => {
        expect(clipRemap(constant(1), 2)).toBeNull();
        expect(clipRemap(clipSpeedProfile({ playbackSpeed: 1, speedCurveJson: JSON.stringify({ id: "custom", points: [[0, 1], [1, 1]] }) }), 2)).toBeNull();
    });

    it("constant speed: a fine timebase, the clamped inverse, frames past the span pushed out, and a tie bias", () => {
        const remap = clipRemap(constant(2), 1.5)!;
        expect(remapFilters(remap, 30)).toEqual([
            "settb=AVTB",
            "setpts='((clip(T,0,3)/2)+gte(T,3)*0.066666667+0.000003333)/TB'",
        ]);
    });

    it("curves emit outputTimeExpr of the stream's source time", () => {
        const [, setpts] = remapFilters(clipRemap(curve("hero"), 2)!, 30);
        expect(setpts).toMatch(/^setpts='\(clip\(if\(lt\(T,/);
        expect(setpts).toContain("sqrt(");
        expect(setpts).toContain("+gte(T,");
    });

    it("scene pieces shift by the piece start and read their source from a pre-roll", () => {
        const profile = constant(2);
        const read = pieceRead({ profile, length: 3, from: 1, duration: 1, origin: 0.5, rate: 1 });
        // S(1) = 2 source seconds → media 2.5; pre-roll 0.25 s; S(2) = 4 → media 4.5 plus slack.
        expect(read.readStart).toBe(2.25);
        expect(read.readLength).toBeCloseTo(4.5 - 2.25 + VIDEO_SLACK_SECONDS, 9);
        expect(read.remap).toEqual({ profile, length: 3, from: 1, sourceAtZero: 1.75, rate: 1 });
        expect(remapFilters(read.remap, 30)[1]).toBe("setpts='(max(0,(clip((T+1.75),0,6)/2)-1)+gte((T+1.75),6)*0.066666667+0.000003333)/TB'");
    });

    it("read windows are whole milliseconds (the -ss/-t text ffmpeg parses), floored at the start and rounded up at the end", () => {
        const read = pieceRead({ profile: constant(1.37), length: 4, from: 0.1, duration: 0.3, origin: 0, rate: 1 });
        expect(read.readStart).toBe(0);
        expect(Math.abs(read.readLength * 1000 - Math.round(read.readLength * 1000))).toBeLessThan(1e-6);
        expect(read.readLength).toBeGreaterThanOrEqual(1.37 * 0.4 + VIDEO_SLACK_SECONDS);
        const late = pieceRead({ profile: constant(1.37), length: 4, from: 2, duration: 0.5, origin: 0, rate: 1 });
        expect(late.readStart).toBe(Math.floor((1.37 * 2 - VIDEO_PREROLL_SECONDS) * 1000) / 1000);
        expect(late.remap.sourceAtZero).toBe(late.readStart);
    });

    it("shot media maps through its rate and origin", () => {
        const read = pieceRead({ profile: constant(1), length: 6, from: 4, duration: 2, origin: -2, rate: 0.5 });
        // Scene source 4 → shot media 0.5·4 − 2 = 0; pre-roll clamps at 0, so T = 0 is scene source (0 + 2) / 0.5 = 4.
        expect(read.readStart).toBe(0);
        expect(read.remap.sourceAtZero).toBe(4);
        expect(remapFilters(read.remap, 30)[1]).toContain("((T/0.5)+4)");
    });
});

describe("pickSourceFrame (the reference rule)", () => {
    it("is the frame visible at the middle of the output frame, ties to the next output frame", () => {
        // 2x: output frame n spans source [2n, 2n + 2) frames, its middle is source frame 2n + 1 exactly (a tie): frame 2n.
        const frames = (profile: SpeedProfile, D: number) =>
            Array.from({ length: Math.round(D * 30) }, (_, n) => pickSourceFrame(profile, D, n, 30, 30));
        expect(frames(constant(2), 0.2)).toEqual([0, 2, 4, 6, 8, 10]);
        expect(frames(constant(0.5), 0.2)).toEqual([0, 0, 1, 1, 2, 2]);
        expect(frames(constant(1.5), 0.2)).toEqual([0, 2, 3, 5, 6, 8]);
        expect(frames(constant(1), 0.2)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("agrees with S at the frame middle for curves", () => {
        const profile = curve("flash_in");
        for (let n = 0; n < 60; n += 1) {
            const k = pickSourceFrame(profile, 2, n, 30, 30);
            const middle = sourceTimeAt(profile, (n + 0.5) / 30, 2) * 30;
            expect(k).toBeLessThan(middle);
            expect(k + 1).toBeGreaterThanOrEqual(middle - 1e-6);
            expect(outputTimeAt(profile, k / 30, 2) + REMAP_BIAS_FRAMES / 30).toBeLessThan((n + 0.5) / 30);
        }
    });
});

describe("audioStretch", () => {
    it("identity plays 1:1; constant speed is one exact segment", () => {
        expect(audioStretch(constant(1), 4, 0, 4, 1, 30)).toEqual({ mediaStart: 0, stretch: null });
        expect(audioStretch(constant(1), 4, 1, 3, 1, 30)).toEqual({ mediaStart: 1, stretch: null });
        const { mediaStart, stretch } = audioStretch(constant(2, false), 4, 1, 3, 1, 30);
        expect(mediaStart).toBe(2);
        expect(stretch).toEqual({ segments: [{ outputStart: 0, outputEnd: 2, sourceStart: 0, sourceEnd: 4, speed: 2 }], preservePitch: false, drift: 0 });
    });

    it("legacy ramps are step curves: flat segments, exact, no drift", () => {
        const profile = clipSpeedProfile({ speedRamp: "montage" });
        const { stretch } = audioStretch(profile, 4, 0, 4, 1, 30);
        expect(stretch!.segments.map((s) => [s.outputStart, s.outputEnd, s.speed])).toEqual([[0, 1, 0.55], [1, 3, 1.85], [3, 4, 0.75]]);
        expect(stretch!.drift).toBe(0);
    });

    it("slices sloped curves finely enough to keep audio within half a frame of the picture", () => {
        const { stretch } = audioStretch(curve("bullet"), 5, 0, 5, 1, 30);
        expect(stretch!.drift).toBeLessThanOrEqual(0.5 / 30 + 1e-12);
        const segments = stretch!.segments;
        expect(segments[0].outputStart).toBe(0);
        expect(segments[segments.length - 1].outputEnd).toBe(5);
        segments.slice(1).forEach((s, i) => {
            expect(s.outputStart).toBe(segments[i].outputEnd);
            expect(s.sourceStart).toBe(segments[i].sourceEnd);
        });
        // Slice ends land on the exact time map.
        for (const s of segments) expect(s.sourceEnd).toBeCloseTo(sourceTimeAt(curve("bullet"), s.outputEnd, 5), 9);
    });

    it("reports drift when the slice density cap is reached", () => {
        const steep: SpeedProfile = { speed: 1, curve: { id: "custom", points: [[0, 10], [0.02, 0.1], [1, 0.1]] }, preservePitch: true };
        const { stretch } = audioStretch(steep, 60, 0, 60, 1, 30);
        expect(stretch!.segments.length).toBeLessThanOrEqual(MAX_AUDIO_SLICE_DENSITY + 4);
        expect(stretch!.drift).toBeGreaterThan(1 / 30);
    });

    it("windows restrict the map to [from, to) and scale by the media rate", () => {
        const profile = curve("hero");
        const { mediaStart, stretch } = audioStretch(profile, 4, 1, 3, 2, 30);
        expect(mediaStart).toBeCloseTo(2 * sourceTimeAt(profile, 1, 4), 12);
        const segments = stretch!.segments;
        expect(segments[0].outputStart).toBe(0);
        expect(segments[segments.length - 1].outputEnd).toBeCloseTo(2, 12);
        expect(segments[segments.length - 1].sourceEnd).toBeCloseTo(2 * (sourceTimeAt(profile, 3, 4) - sourceTimeAt(profile, 1, 4)), 9);
    });
});

describe("audioTempoFilters", () => {
    it("keeps pitch with atempo steps inside 0.5-2 (atempo skips samples above 2)", () => {
        expect(audioTempoFilters(1.5, true)).toEqual(["atempo=1.5"]);
        expect(audioTempoFilters(10, true)).toEqual(["atempo=2", "atempo=2", "atempo=2", "atempo=1.25"]);
        expect(audioTempoFilters(0.1, true)).toEqual(["atempo=0.5", "atempo=0.5", "atempo=0.5", "atempo=0.8"]);
        expect(audioTempoFilters(1, true)).toEqual([]);
    });

    it("lets pitch follow the speed by resampling", () => {
        expect(audioTempoFilters(2, false)).toEqual(["asetrate=96000", "aresample=48000"]);
        expect(audioTempoFilters(0.75, false)).toEqual(["asetrate=36000", "aresample=48000"]);
    });

    it("overlap is enough source for atempo's flush at any speed", () => {
        expect(audioSegmentOverlap(0.25)).toBeGreaterThanOrEqual(0.1);
        expect(audioSegmentOverlap(10)).toBeGreaterThanOrEqual(1);
    });
});
