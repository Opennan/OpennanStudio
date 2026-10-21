// Golden fixtures shared by the export golden test (Node) and the preview snapshot capture
// (apps/playground ?golden=<name>). Media URLs are served by the playground from /golden/media and
// mapped to golden/media/* in Node.
import type { SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";

export const GOLDEN_MEDIA_URL = "/golden/media";
export const GOLDEN_FONT_FAMILY = "OpenNan Golden";

export interface GoldenFixture {
    name: string;
    aspectRatio: string;
    resolution: "720p" | "1080p" | "4k";
    tracks: TimelineTrack[];
    scenes: SceneData[];
    clips: TimelineClip[];
    musicUrl: string | null;
    musicVolume: number;
    /** Expected export length in seconds. */
    duration: number;
    /**
     * Timeline seconds compared against preview snapshots (empty: export-only fixture). Mid-frame
     * times (k + 0.5) / fps avoid off-by-one frame picks between the browser and ffmpeg.
     */
    samples: number[];
    /** Minimum SSIM ("All") per sampled frame. */
    ssimMin: number;
}

const media = (name: string) => `${GOLDEN_MEDIA_URL}/${name}`;

function track(type: TimelineTrack["type"], index: number, patch: Partial<TimelineTrack> = {}): TimelineTrack {
    return { type, index, label: `${type[0].toUpperCase()}${index}`, muted: false, locked: false, visible: true, volume: 1, ...patch };
}

const TRACKS: TimelineTrack[] = [
    track("video", 1), track("video", 2), track("audio", 1), track("audio", 2), track("text", 1), track("sticker", 1), track("effect", 1),
];

function scene(id: string, order: number, start: number, duration: number, file: string, patch: Partial<SceneData> = {}): SceneData {
    return {
        id, order, caption: id, startTime: "00:00:00.000", endTime: "00:00:05.000", startImageUrl: null, endImageUrl: null,
        videoUrl: null, sourceVideoUrl: media(file), status: "completed", transition: "cut", cardType: "source_clip",
        duration, frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, shotBreakdown: "[]",
        // 0.001, not 0: an exact 0 means "unpositioned" (scene-position.ts explicitSceneStart).
        timelinePositionSeconds: start === 0 ? 0.001 : start, trackIndex: 1, fitMode: "contain",
        ...patch,
    };
}

function clip(id: string, input: Record<string, unknown>): TimelineClip {
    return optimisticTimelineClipFromInput(input, "golden", id);
}

const TEXT_STYLE = JSON.stringify({
    fontSize: 64, fontWeight: "bold", fontFamily: `${GOLDEN_FONT_FAMILY}, sans-serif`, color: "#ffffff",
    strokeWidth: 3, strokeColor: "#000000", bgColor: "rgba(0,0,0,0.5)", textAlign: "center",
});

const base = { aspectRatio: "16:9", resolution: "720p" as const, tracks: TRACKS, musicUrl: null, musicVolume: 1, ssimMin: 0.9 };

export const GOLDEN_FIXTURES: GoldenFixture[] = [
    {
        ...base,
        name: "base-scenes",
        scenes: [
            scene("a", 0, 0, 3, "clip-a.webm", { cardConfig: JSON.stringify({ trimStart: 0.5 }) }),
            scene("b", 1, 4, 2, "clip-b.webm", { fitMode: "cover" }),
        ],
        clips: [],
        duration: 6,
        samples: [1.05, 5.05],
    },
    {
        ...base,
        name: "transitions",
        scenes: [
            scene("a", 0, 0, 2, "clip-a.webm", { visualTransition: "dip_black", visualTransitionDuration: 1 }),
            // The dissolving scene fills the frame: the preview fades the outgoing picture without its
            // letterbox. The incoming scene is static bars, so its first-frame timing cannot differ.
            scene("b", 1, 2, 2, "clip-a.webm", { visualTransition: "cross_dissolve", visualTransitionDuration: 1, cardConfig: JSON.stringify({ trimStart: 1 }) }),
            scene("c", 2, 4, 2, "clip-b.webm"),
        ],
        clips: [],
        duration: 6,
        samples: [1.05, 2, 5.55],
    },
    {
        ...base,
        name: "overlays",
        scenes: [scene("a", 0, 0, 4, "clip-a.webm")],
        clips: [
            clip("v2", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 4, mediaUrl: media("clip-b.webm"), mediaType: "video", scale: 0.5, positionX: 0.9, positionY: 0.1, opacity: 0.8, volume: 0 }),
            clip("st", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, mediaUrl: media("sticker.png"), mediaType: "image", positionX: 0.1, positionY: 0.9 }),
            clip("im", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: media("image.png"), mediaType: "image", positionX: 0.5, positionY: 0.5, rotationDegrees: 15 }),
        ],
        duration: 4,
        samples: [1.55, 3.05],
    },
    {
        ...base,
        name: "text",
        scenes: [scene("a", 0, 0, 4, "clip-a.webm")],
        clips: [
            clip("t1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 4, textContent: "OpenNan Studio export", textStyle: TEXT_STYLE, positionX: 0.5, positionY: 0.85 }),
            clip("t2", { trackType: "text", trackIndex: 1, startTime: 1, endTime: 3, textContent: "Tilted", textStyle: TEXT_STYLE, positionX: 0.2, positionY: 0.2, rotationDegrees: 12, scale: 0.8 }),
        ],
        duration: 4,
        samples: [0.55, 2.05],
        ssimMin: 0.88,
    },
    {
        ...base,
        name: "keyframes",
        scenes: [scene("a", 0, 0, 4, "clip-a.webm")],
        clips: [
            clip("kf", {
                trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 4, mediaUrl: media("sticker.png"), mediaType: "image",
                keyframesJson: JSON.stringify([
                    { time: 0, position_x: 0.1, position_y: 0.1, scale: 0.5, opacity: 1, rotation_degrees: 0 },
                    { time: 3, position_x: 0.9, position_y: 0.8, scale: 1.2, opacity: 0.4, rotation_degrees: 45 },
                ]),
            }),
        ],
        duration: 4,
        samples: [0.55, 1.55, 2.55, 3.55],
        // Measured 0.90 at 3.55 s (40% opacity, 45° rotation resampled twice).
        ssimMin: 0.88,
    },
    {
        ...base,
        name: "canvas-9x16",
        aspectRatio: "9:16",
        scenes: [scene("a", 0, 0, 3, "clip-a.webm", { fitMode: "cover", transformScale: 1.2, transformOffsetX: 10, transformOffsetY: -5 })],
        clips: [clip("t1", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Vertical", textStyle: TEXT_STYLE, positionX: 0.5, positionY: 0.2 })],
        duration: 3,
        samples: [1.55],
        ssimMin: 0.88,
    },
    {
        ...base,
        name: "audio-mix",
        scenes: [scene("b", 0, 0, 3, "clip-b.webm")],
        clips: [clip("au", { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 3, mediaUrl: media("tone.webm"), mediaType: "audio", audioPan: -1, fadeInDuration: 0.5 })],
        musicUrl: null,
        duration: 3,
        samples: [],
    },
    {
        ...base,
        name: "kitchen-sink",
        tracks: [...TRACKS, track("remotion", 1)],
        scenes: [
            scene("a", 0, 0, 3, "clip-a.webm", { visualTransition: "slide_left", visualTransitionDuration: 0.6 }),
            scene("b", 1, 3, 3, "clip-b.webm", { visualTransition: "wipe_left", visualTransitionDuration: 0.6 }),
            scene("i", 2, 6, 2, "image.png", { sourceVideoUrl: null, cardType: "image", startImageUrl: media("image.png") }),
            scene("o", 3, 1, 3, "clip-b.webm", { trackIndex: 2, fitMode: "contain", transformScale: 0.4, transformOffsetX: 25 }),
        ],
        clips: [
            clip("all", {
                trackType: "video", trackIndex: 2, startTime: 0.5, endTime: 3.5, mediaUrl: media("clip-a.webm"), mediaType: "video",
                cropLeft: 0.1, cropTop: 0.05, horizontalFlip: true, verticalFlip: true, brightness: 0.1, contrast: 1.2, saturation: 0.8,
                visualFilter: "cinematic", blurStrength: 2, chromaKeyEnabled: true, chromaKeyColor: "#00ff00", blendMode: "screen",
                mosaicStrength: 4, playbackSpeed: 1.5, speedRamp: "hero", reversePlayback: true, fadeInDuration: 0.3, fadeOutDuration: 0.3,
                transitionType: "dip_white", motionPreset: "zoom_in", scale: 0.4, rotationDegrees: 90, opacity: 0.9,
            }),
            clip("frz", { trackType: "video", trackIndex: 2, startTime: 4, endTime: 6, mediaUrl: media("clip-a.webm"), mediaType: "video", freezeFrame: true, scale: 0.3, positionX: 0, positionY: 1 }),
            clip("emo", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 8, textContent: "★", positionX: 1, positionY: 0 }),
            clip("cap", {
                trackType: "text", trackIndex: 1, startTime: 2, endTime: 7, textContent: "Every filter at once", textStyle: TEXT_STYLE,
                keyframesJson: JSON.stringify([{ time: 0, opacity: 0, scale: 0.6 }, { time: 1, opacity: 1, scale: 1 }]), transitionType: "cross_dissolve", transitionDuration: 0.5,
            }),
            clip("sfx", {
                trackType: "audio", trackIndex: 2, startTime: 1, endTime: 5, mediaUrl: media("tone.webm"), mediaType: "audio", trimStart: 1,
                audioPitch: 3, audioEq: "vocal", audioDenoise: true, audioNormalize: true, playbackSpeed: 1.25, reversePlayback: true,
                fadeOutDuration: 1, keyframesJson: JSON.stringify([{ time: 0, volume: 0.2 }, { time: 2, volume: 1 }]),
            }),
            clip("rm", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 2, remotionTemplateId: "lower-third" }),
        ],
        musicUrl: media("tone.webm"),
        musicVolume: 0.3,
        duration: 8,
        samples: [],
    },
    // ── export-only checks: the preview renders none of these, so golden.test.ts reads pixels and audio directly ──
    {
        ...base,
        name: "crop-flip",
        scenes: [],
        clips: [clip("cf", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: media("quadrants.png"), mediaType: "image", cropTop: 0.5, horizontalFlip: true, positionX: 0, positionY: 0 })],
        duration: 2,
        samples: [],
    },
    {
        ...base,
        name: "chroma-key",
        scenes: [scene("r", 0, 0, 2, "red.png", { sourceVideoUrl: null, cardType: "image", startImageUrl: media("red.png"), fitMode: "fill" })],
        clips: [clip("key", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: media("keyed.png"), mediaType: "image", chromaKeyEnabled: true, chromaKeyColor: "#00ff00", positionX: 0.5, positionY: 0.5 })],
        duration: 2,
        samples: [],
    },
    {
        ...base,
        name: "mosaic",
        scenes: [],
        clips: [clip("mo", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: media("image.png"), mediaType: "image", mosaicStrength: 8, positionX: 0, positionY: 0 })],
        duration: 2,
        samples: [],
    },
    {
        ...base,
        name: "time-effects",
        scenes: [],
        clips: [
            clip("rev", { trackType: "video", trackIndex: 2, startTime: 0, endTime: 1, mediaUrl: media("counter.mkv"), mediaType: "video", reversePlayback: true }),
            clip("frz", { trackType: "video", trackIndex: 2, startTime: 1, endTime: 2, mediaUrl: media("counter.mkv"), mediaType: "video", freezeFrame: true }),
            clip("ramp", { trackType: "video", trackIndex: 2, startTime: 2, endTime: 5, mediaUrl: media("counter.mkv"), mediaType: "video", speedRamp: "hero" }),
        ],
        duration: 5,
        samples: [],
    },
    {
        ...base,
        name: "audio-filters",
        scenes: [],
        clips: [clip("pf", { trackType: "audio", trackIndex: 2, startTime: 0, endTime: 2, mediaUrl: media("tone440.mkv"), mediaType: "audio", audioNormalize: true, audioPitch: 12, audioPan: 0.5 })],
        duration: 2,
        samples: [],
    },
    {
        ...base,
        name: "motion-preset",
        scenes: [],
        clips: [clip("zoom", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 3, mediaUrl: media("sticker.png"), mediaType: "image", motionPreset: "zoom_in", scale: 2, positionX: 0.5, positionY: 0.5 })],
        duration: 3,
        samples: [],
    },
    {
        ...base,
        name: "shot-sequence",
        scenes: [scene("g", 0, 0, 3, "shot-red.webm", {
            sourceVideoUrl: null, cardType: "ai_video",
            shotBreakdown: JSON.stringify([{ duration: 2, video_url: media("shot-red.webm") }, { duration: 1, video_url: media("shot-blue.webm") }]),
        })],
        clips: [],
        duration: 3,
        samples: [],
    },
];

export function goldenFixture(name: string): GoldenFixture {
    const fixture = GOLDEN_FIXTURES.find((f) => f.name === name);
    if (!fixture) throw new Error(`unknown golden fixture ${name}`);
    return fixture;
}
