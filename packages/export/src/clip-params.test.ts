import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import * as params from "./clip-params";

const clip = (input: Record<string, unknown> = {}) => optimisticTimelineClipFromInput({ trackType: "video", trackIndex: 2, ...input }, "p", "c1");

describe("clip params", () => {
    it("speed: 0 and missing are 1x, range 0.1..100", () => {
        expect(params.playbackSpeed(clip({ playbackSpeed: 0 }))).toBe(1);
        expect(params.playbackSpeed(clip({ playbackSpeed: -2 }))).toBe(1);
        expect(params.playbackSpeed(clip({ playbackSpeed: 20 }))).toBe(20);
        expect(params.playbackSpeed(clip({ playbackSpeed: 250 }))).toBe(100);
        expect(params.playbackSpeed(clip({ playbackSpeed: 0.05 }))).toBe(0.1);
    });

    it("enums fall back on unknown values", () => {
        expect(params.speedRamp(clip({ speedRamp: "HERO" }))).toBe("hero");
        expect(params.speedRamp(clip({ speedRamp: "warp" }))).toBe("none");
        expect(params.audioEq(clip({ audioEq: "bass" }))).toBe("bass");
        expect(params.visualFilter(clip({ visualFilter: "sepia" }))).toBe("none");
        expect(params.motionPreset(clip({ motionPreset: "pulse" }))).toBe("pulse");
        expect(params.blendMode(clip({ blendMode: "Screen" }))).toBe("screen");
    });

    it("crop pairs sum to at most 0.95", () => {
        expect(params.crop(clip({ cropLeft: 0.6, cropRight: 0.6, cropTop: 0.1 }))).toEqual({ left: 0.475, right: 0.475, top: 0.1, bottom: 0 });
    });

    it("color, blur, mosaic, pan, pitch clamp", () => {
        expect(params.colorAdjustments(clip({ brightness: 2, contrast: -1, saturation: 1.5 }))).toEqual({ brightness: 1, contrast: 0, saturation: 1.5 });
        expect(params.blurStrength(clip({ blurStrength: 30 }))).toBe(20);
        expect(params.mosaicStrength(clip({ mosaicStrength: 12.7 }))).toBe(12);
        expect(params.audioPan(clip({ audioPan: -3 }))).toBe(-1);
        expect(params.audioPitch(clip({ audioPitch: 13 }))).toBe(12);
    });

    it("chroma key color accepts #, 0x and bare hex", () => {
        expect(params.chromaKey(clip({ chromaKeyEnabled: true, chromaKeyColor: "#12abEF" })).color).toBe("0x12abEF");
        expect(params.chromaKey(clip({ chromaKeyColor: "green" })).color).toBe("0x00FF00");
        expect(params.chromaKey(clip({ chromaKeySimilarity: 3 })).similarity).toBe(1);
    });

    it("transition aliases normalize", () => {
        expect(params.clipTransitionType(clip({ transitionType: "crossfade" }))).toBe("cross_dissolve");
        expect(params.clipTransitionType(clip({ transitionType: "warp" }))).toBe("none");
    });

    it("fades are capped at half the clip; text falls back to the transition duration", () => {
        expect(params.fadeDurations(clip({ fadeInDuration: 3, fadeOutDuration: 0.5 }), 4)).toEqual({ fadeIn: 2, fadeOut: 0.5 });
        expect(params.effectiveTextFades(clip({ transitionType: "dip_black", transitionDuration: 0.4 }), 4)).toEqual({ fadeIn: 0.4, fadeOut: 0.4 });
        expect(params.effectiveTextFades(clip({ transitionDuration: 0.4 }), 4)).toEqual({ fadeIn: 0, fadeOut: 0 });
    });

    it("rotation keeps any angle; opacity and scale have safe defaults", () => {
        expect(params.rotationDegrees(clip({ rotationDegrees: 33 }))).toBe(33);
        expect(params.clipOpacity(clip({ opacity: 4 }))).toBe(1);
        expect(params.clipScale(clip({ scale: 0 }))).toBe(1);
        expect(params.normalizedVolume(1.7)).toBe(1);
    });
});

describe("legacy controls shared with the GPU path", () => {
    it("normalizes blur, chroma key, and blend mode exactly as timeline-core legacyClipParams", async () => {
        const { legacyClipParams } = await import("@opennan/timeline-core/looks/legacy");
        const { blendMode, blurStrength, chromaKey } = await import("./clip-params");
        const samples: Array<Record<string, unknown>> = [
            {}, { blurStrength: "3.4567" }, { blurStrength: 99 }, { blurStrength: -2 }, { blurStrength: "x" },
            { chromaKeyEnabled: "yes", chromaKeyColor: "#12abef", chromaKeySimilarity: 2, chromaKeyBlend: "0.33333" },
            { chromaKeyEnabled: 1, chromaKeyColor: "red", chromaKeySimilarity: null }, { chromaKeyEnabled: "off" },
            { blendMode: " Screen " }, { blendMode: "darken" }, { blendMode: null },
        ];
        for (const clip of samples) {
            const shared = legacyClipParams(clip);
            expect(shared.blurStrength).toBe(blurStrength(clip as never));
            expect(shared.chromaKey).toEqual(chromaKey(clip as never));
            expect(shared.blendMode).toBe(blendMode(clip as never));
        }
    });
});
