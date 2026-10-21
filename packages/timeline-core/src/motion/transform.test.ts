import { describe, expect, it, vi } from "vitest";
import { evaluateScalar } from "../looks/expr";
import type { TimelineClip } from "../model/timeline";
import type { SceneData } from "../timeline/canvas/types";
import { CLIP_ANIMATIONS } from "./animations";
import { channelValueAt } from "./keyframes";
import { MOTION_CHANNELS, type MotionChannel } from "./types";
import { itemMotion, motionAt, motionFfmpeg } from "./transform";

// A small stand-in text catalog, so these tests do not depend on the text task's definitions.
vi.mock("./text-animations", async () => {
    const { add, mul, sin } = await import("../looks/expr");
    return {
        TEXT_ANIMATIONS: [
            { id: "fade", kind: "text", slot: "in", defaultDuration: 0.5, delta: (u: never) => ({ opacity: u }) },
            { id: "pulse", kind: "text", slot: "loop", defaultDuration: 1, delta: (u: never) => ({ scale: add(1, mul(0.1, sin(mul(2 * Math.PI, u)))) }) },
            { id: "glow", kind: "text", slot: "loop", defaultDuration: 1, raster: "glow", delta: (u: never) => ({ dx: mul(0.1, u) }) },
        ],
    };
});

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
    return {
        id: "c1", projectId: "p", trackType: "video", trackIndex: 2, startTime: 10, endTime: 14, mediaUrl: "/m.mp4", mediaType: "video",
        sceneId: null, label: null, thumbnailUrl: null, locked: false, volume: 1, audioPan: 0, audioPitch: 0, audioEq: "none",
        audioDenoise: false, audioNormalize: false, playbackSpeed: 1, speedRamp: "none", reversePlayback: false, freezeFrame: false,
        fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none", transitionDuration: 0, opacity: 0.8, scale: 1.2,
        positionX: 0.3, positionY: 0.7, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
        brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false,
        chromaKeyColor: "#00ff00", chromaKeySimilarity: 0.1, chromaKeyBlend: 0, blendMode: "normal", mosaicStrength: 0,
        rotationDegrees: 15, keyframesJson: null, textContent: null, textStyle: null, trimStart: null, trimEnd: null,
        ...overrides,
    };
}

function scene(overrides: Partial<SceneData> = {}): SceneData {
    return {
        id: "s1", order: 0, caption: "", startTime: "0", endTime: "5", startImageUrl: null, endImageUrl: null, videoUrl: "/v.mp4",
        status: "ready", transition: "none", frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null,
        ...overrides,
    };
}

const constant = (motion: ReturnType<typeof itemMotion>, channel: MotionChannel) => {
    const e = motion.channels[channel];
    expect(e.k, channel).toBe("num");
    return e.k === "num" ? e.v : NaN;
};

const frames = (duration: number, fps = 30) => Array.from({ length: Math.round(duration * fps) + 1 }, (_, n) => n / fps);
const json = (value: unknown) => JSON.stringify(value);

/** The 10a export's alpha fade (filters/video.ts alphaFadeFilters → ffmpeg `fade` with st/d in seconds, alpha=1). */
function ffmpegFade(t: number, type: "in" | "out", st: number, d: number): number {
    const progress = Math.min(1, Math.max(0, (t - st) / d));
    return type === "in" ? progress : 1 - progress;
}

describe("itemMotion: static items", () => {
    it("a static clip folds every channel to its field", () => {
        const motion = itemMotion({ kind: "clip", clip: clip() });
        expect(motion.animated).toBe(false);
        expect(motion.duration).toBe(4);
        expect(constant(motion, "posX")).toBe(0.3);
        expect(constant(motion, "posY")).toBe(0.7);
        expect(constant(motion, "scale")).toBe(1.2);
        expect(constant(motion, "scaleX")).toBe(1);
        expect(constant(motion, "rotation")).toBe(15);
        expect(constant(motion, "opacity")).toBe(0.8);
        expect(constant(motion, "dx")).toBe(0);
        expect(constant(motion, "dy")).toBe(0);
    });

    it("normalizes fields like the export (clip-params.ts)", () => {
        const motion = itemMotion({ kind: "clip", clip: clip({ scale: 0, opacity: 3, positionX: null as never, rotationDegrees: undefined as never }) });
        expect(constant(motion, "scale")).toBe(1);
        expect(constant(motion, "opacity")).toBe(1);
        expect(constant(motion, "posX")).toBe(0.5);
        expect(constant(motion, "rotation")).toBe(0);
    });

    it("a scene uses its own units: offsets in percent, transformScale, rotation, opacity", () => {
        const plain = itemMotion({ kind: "scene", scene: scene(), duration: 5 });
        expect(plain.animated).toBe(false);
        expect([constant(plain, "posX"), constant(plain, "posY"), constant(plain, "scale"), constant(plain, "rotation"), constant(plain, "opacity")]).toEqual([0, 0, 1, 0, 1]);
        const moved = itemMotion({ kind: "scene", scene: scene({ transformOffsetX: 12, transformOffsetY: -8, transformScale: 1.5, rotationDegrees: 30, opacity: 0.5 }), duration: 5 });
        expect([constant(moved, "posX"), constant(moved, "posY"), constant(moved, "scale"), constant(moved, "rotation"), constant(moved, "opacity")]).toEqual([12, -8, 1.5, 30, 0.5]);
    });

    it("ignores unknown animation ids and garbage", () => {
        expect(itemMotion({ kind: "clip", clip: clip({ animationJson: json({ in: { id: "warp_9", duration: 1 } }) }) }).animated).toBe(false);
        expect(itemMotion({ kind: "clip", clip: clip({ animationJson: "{oops" }) }).animated).toBe(false);
        // Clip ids mean nothing on text clips, text ids nothing on video clips.
        expect(itemMotion({ kind: "clip", clip: clip({ trackType: "text", animationJson: json({ in: { id: "zoom_in", duration: 1 } }) }) }).animated).toBe(false);
        expect(itemMotion({ kind: "clip", clip: clip({ animationJson: json({ in: { id: "fade", duration: 1 } }) }) }).animated).toBe(false);
    });
});

describe("itemMotion: keyframes and animations", () => {
    const keyframesJson = json({ keyframes: [{ time: 0, scale: 1, position_x: 0.2, easing: 2 }, { time: 2, scale: 2, position_x: 0.8 }] });

    it("composes keyframed channels with an in and an out animation", () => {
        const c = clip({ keyframesJson, animationJson: json({ in: { id: "zoom_in", duration: 1 }, out: { id: "slide_left_out", duration: 0.5 } }) });
        const motion = itemMotion({ kind: "clip", clip: c });
        expect(motion.animated).toBe(true);
        const points = [{ time: 0, scale: 1, position_x: 0.2, easing: 2 }, { time: 2, scale: 2, position_x: 0.8 }] as never;
        const zoom = CLIP_ANIMATIONS.find((def) => def.id === "zoom_in")!.delta;
        const slide = CLIP_ANIMATIONS.find((def) => def.id === "slide_left_out")!.delta;
        for (const t of [0, 0.25, 0.5, 1, 1.7, 3.5, 3.75, 4]) {
            const values = motionAt(motion, t);
            const u = Math.min(1, Math.max(0, t / 1));
            const w = Math.min(1, Math.max(0, (t - 3.5) / 0.5));
            const zoomScale = evaluateScalar(zoom({ k: "num", v: u }).scale!, 0);
            const zoomOpacity = evaluateScalar(zoom({ k: "num", v: u }).opacity!, 0);
            const slideDelta = slide({ k: "num", v: w });
            expect(values.scale).toBeCloseTo(channelValueAt(points, "scale", t, 1.2) * zoomScale, 12);
            expect(values.posX).toBeCloseTo(channelValueAt(points, "position_x", t, 0.3), 12);
            expect(values.posY).toBe(0.7);
            expect(values.dx).toBeCloseTo(evaluateScalar(slideDelta.dx!, 0), 12);
            expect(values.opacity).toBeCloseTo(0.8 * zoomOpacity * evaluateScalar(slideDelta.opacity!, 0), 12);
            expect(values.rotation).toBe(15);
        }
        // At rest between the windows: keyframes only.
        expect(motionAt(motion, 2.5).scale).toBe(2);
        expect(motionAt(motion, 2.5).dx).toBeCloseTo(0, 12);
    });

    it("a combo spans the item and rests at both ends", () => {
        const motion = itemMotion({ kind: "clip", clip: clip({ animationJson: json({ combo: { id: "combo_zoom_pulse" } }) }) });
        expect(motionAt(motion, 0).scale).toBeCloseTo(1.2, 12);
        expect(motionAt(motion, 2).scale).toBeCloseTo(1.2 * 1.15, 12);
        expect(motionAt(motion, 4).scale).toBeCloseTo(1.2, 12);
        expect(motionAt(motion, 9).scale).toBeCloseTo(1.2, 12);
    });

    it("scene keyframes use scene units and scene animations use clip definitions", () => {
        const s = scene({
            keyframesJson: json({ keyframes: [{ time: 0, position_x: -20, scale: 1 }, { time: 4, position_x: 20, scale: 2 }] }),
            animationJson: json({ in: { id: "fade_in", duration: 1 } }),
        });
        const motion = itemMotion({ kind: "scene", scene: s, duration: 4 });
        expect(motionAt(motion, 2).posX).toBeCloseTo(0, 12);
        expect(motionAt(motion, 2).scale).toBeCloseTo(1.5, 12);
        expect(motionAt(motion, 0).opacity).toBe(0);
        expect(motionAt(motion, 3).opacity).toBe(1);
    });

    it("text clips use text animations, loops run between in and out with their phase", () => {
        const c = clip({ trackType: "text", textContent: "Hi", opacity: 1, scale: 1, animationJson: json({ in: { id: "fade", duration: 1 }, loop: { id: "pulse", period: 0.8 } }) });
        const motion = itemMotion({ kind: "clip", clip: c });
        expect(motionAt(motion, 0.5).opacity).toBeCloseTo(0.5, 12);
        expect(motionAt(motion, 0.5).scale).toBe(1); // loop not started
        const phase = (t: number) => ((t - 1) % 0.8) / 0.8;
        for (const t of [1, 1.2, 1.5, 2.9, 3.99]) {
            expect(motionAt(motion, t).scale).toBeCloseTo(1 + 0.1 * Math.sin(2 * Math.PI * phase(t)), 9);
        }
    });

    it("sticker clips take clip in/out and only the loops without a raster part", () => {
        const sticker = (animation: unknown) => itemMotion({ kind: "clip", clip: clip({ trackType: "sticker", animationJson: json(animation) }) });
        expect(sticker({ in: { id: "zoom_in", duration: 1 } }).animated).toBe(true);
        expect(sticker({ loop: { id: "pulse", period: 1 } }).animated).toBe(true);
        expect(sticker({ loop: { id: "glow", period: 1 } }).animated).toBe(false);
    });
});

describe("itemMotion: legacy motion (matches the 10a export)", () => {
    it("motionPreset zoom_in / zoom_out / pulse scale the clip like motionScaleExpression", () => {
        const d = 4;
        const cases: Array<[string, (t: number) => number]> = [
            ["zoom_in", (t) => 1 + (0.08 * t) / d],
            ["zoom_out", (t) => 1.08 - (0.08 * t) / d],
            ["pulse", (t) => 1 + 0.04 * Math.sin((2 * Math.PI * t) / d)],
        ];
        for (const [preset, factor] of cases) {
            const motion = itemMotion({ kind: "clip", clip: clip({ motionPreset: preset }) });
            expect(motion.animated).toBe(true);
            for (const t of frames(d)) expect(motionAt(motion, t).scale).toBeCloseTo(1.2 * factor(t), 12);
        }
    });

    it("scale keyframes replace the motion preset (as the export does)", () => {
        const c = clip({ motionPreset: "zoom_in", keyframesJson: json([{ time: 0, scale: 1 }, { time: 4, scale: 2 }]) });
        expect(motionAt(itemMotion({ kind: "clip", clip: c }), 2).scale).toBeCloseTo(1.5, 12);
    });

    it("clip fades are alpha factors with the export's timing at every frame", () => {
        const c = clip({ fadeInDuration: 0.5, fadeOutDuration: 1, transitionType: "cross_dissolve" });
        const motion = itemMotion({ kind: "clip", clip: c });
        for (const t of frames(4)) {
            const expected = 0.8 * ffmpegFade(t, "in", 0, 0.5) * ffmpegFade(t, "out", 3, 1);
            expect(motionAt(motion, t).opacity).toBeCloseTo(expected, 12);
        }
    });

    it("fades are clamped to half the clip", () => {
        const motion = itemMotion({ kind: "clip", clip: clip({ opacity: 1, fadeInDuration: 9 }) });
        expect(motionAt(motion, 1).opacity).toBeCloseTo(0.5, 12);
        expect(motionAt(motion, 2).opacity).toBe(1);
    });

    it("text clips without fades fade over their transition duration (effectiveTextFades)", () => {
        const c = clip({ trackType: "text", textContent: "Hi", opacity: 1, transitionType: "slide_left", transitionDuration: 0.6 });
        const motion = itemMotion({ kind: "clip", clip: c });
        for (const t of frames(4)) {
            expect(motionAt(motion, t).opacity).toBeCloseTo(ffmpegFade(t, "in", 0, 0.6) * ffmpegFade(t, "out", 3.4, 0.6), 12);
        }
        // Video clips do not: their transition type alone adds nothing.
        expect(itemMotion({ kind: "clip", clip: clip({ transitionType: "slide_left", transitionDuration: 0.6 }) }).animated).toBe(false);
    });

    it("dip transitions fade through a color in the export, so they are not opacity", () => {
        const motion = itemMotion({ kind: "clip", clip: clip({ fadeInDuration: 0.5, transitionType: "dip_black" }) });
        expect(constant(motion, "opacity")).toBe(0.8);
    });

    it("scenes have no legacy clip motion", () => {
        const s = { ...scene(), motionPreset: "zoom_in", fadeInDuration: 1 } as SceneData;
        expect(itemMotion({ kind: "scene", scene: s, duration: 5 }).animated).toBe(false);
    });
});

describe("itemMotion: evaluation and emission", () => {
    const busy = clip({
        motionPreset: "pulse",
        fadeInDuration: 0.4,
        keyframesJson: json([{ time: 0, rotation_degrees: 0, opacity: 0.5, easing: 5, bx1: 0.2, by1: 0, bx2: 0.4, by2: 1.3 }, { time: 3, rotation_degrees: 90, opacity: 1 }]),
        animationJson: json({ in: { id: "bounce_in", duration: 0.8 }, out: { id: "spin_out", duration: 0.6 } }),
    });

    it("memoizes per clip object and per scene object and duration", () => {
        const a = itemMotion({ kind: "clip", clip: busy });
        expect(itemMotion({ kind: "clip", clip: busy })).toBe(a);
        expect(itemMotion({ kind: "clip", clip: { ...busy } })).not.toBe(a);
        const s = scene({ animationJson: json({ in: { id: "fade_in", duration: 1 } }) });
        const b = itemMotion({ kind: "scene", scene: s, duration: 5 });
        expect(itemMotion({ kind: "scene", scene: s, duration: 5 })).toBe(b);
        expect(itemMotion({ kind: "scene", scene: s, duration: 6 }).duration).toBe(6);
    });

    it("motionAt equals evaluateScalar of every channel", () => {
        const motion = itemMotion({ kind: "clip", clip: busy });
        for (const t of frames(4, 60)) {
            const values = motionAt(motion, t);
            for (const channel of MOTION_CHANNELS) expect(values[channel]).toBe(evaluateScalar(motion.channels[channel], t));
        }
        expect(motionAt(motion, 0.1).opacity).toBeGreaterThanOrEqual(0);
    });

    it("motionFfmpeg writes scalar expressions without st()/ld() state", () => {
        const motion = itemMotion({ kind: "clip", clip: busy });
        for (const channel of MOTION_CHANNELS) {
            const text = motionFfmpeg(motion, channel, "t", 10);
            expect(text).not.toContain("st(");
            expect(text).not.toContain("ld(");
        }
        expect(motionFfmpeg(motion, "scale", "(n/30)")).toContain("(n/30)");
        expect(motionFfmpeg(motion, "scale", "t", 10)).toContain("(t-10)");
        expect(motionFfmpeg(itemMotion({ kind: "clip", clip: clip() }), "posX", "t")).toBe("0.3");
        const total = MOTION_CHANNELS.reduce((sum, channel) => sum + motionFfmpeg(motion, channel, "t").length, 0);
        expect(total).toBeLessThan(20_000);
    });
});
