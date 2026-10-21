// Synthetic timelines and media facts shared by the compile tests (no ffmpeg, no probing).
import type { SceneData, TimelineTrack } from "@opennan/timeline-core";
import { optimisticTimelineClipFromInput } from "@opennan/timeline-core/lib/timeline-optimistic";
import type { ExportInput, MediaInfo, RasterResult } from "../types";
import type { CompileOptions } from "./index";

export const track = (type: TimelineTrack["type"], index: number, patch: Partial<TimelineTrack> = {}): TimelineTrack =>
    ({ type, index, label: "", muted: false, locked: false, visible: true, volume: 1, ...patch });
export const TRACKS = [
    track("video", 1), track("video", 2), track("audio", 1), track("audio", 2), track("text", 1), track("sticker", 1), track("effect", 1), track("remotion", 1),
];

export function scene(id: string, start: number, duration: number, patch: Partial<SceneData> = {}): SceneData {
    return {
        id, order: 0, caption: "", startTime: "0", endTime: "0", startImageUrl: null, endImageUrl: null, videoUrl: null,
        sourceVideoUrl: `/m/${id}.webm`, status: "ready", transition: "cut", cardType: "source_clip", duration,
        frameConsistencyScore: null, audioUrl: null, audioText: null, cardConfig: null, timelinePositionSeconds: start || 0.001, ...patch,
    };
}
export const clip = (id: string, input: Record<string, unknown>) => optimisticTimelineClipFromInput(input, "p", id);
export const info = (patch: Partial<MediaInfo> = {}): MediaInfo => ({ durationSeconds: 10, hasVideo: true, hasAudio: true, width: 640, height: 360, ...patch });

export function input(patch: Partial<ExportInput>): ExportInput {
    return { project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 }, tracks: TRACKS, scenes: [], clips: [], ...patch };
}

export const raster: RasterResult = { id: "text-t", png: new Uint8Array([1]), width: 120, height: 60, boxWidth: 100, boxHeight: 40, pad: 10, scale: 1 };

/** Media facts for every URL the feature timelines use. */
export const FEATURE_MEDIA: ReadonlyMap<string, MediaInfo> = new Map([
    ["/m/a.webm", info()],
    ["/m/b.webm", info({ hasAudio: false })],
    ["/m/v.webm", info()],
    ["/m/s.png", info({ durationSeconds: 0, hasAudio: false, width: 100, height: 100 })],
    ["/m/sfx.wav", info({ hasVideo: false, width: 0, height: 0 })],
    ["/m/music.mp3", info({ hasVideo: false, width: 0, height: 0 })],
]);

export const COMPILE_OPTIONS: CompileOptions = { media: FEATURE_MEDIA, rasters: new Map([["text-t", raster]]), gl: false };

const BASE_SCENES = [scene("a", 0, 2), scene("b", 2, 2)];
const overlay = (patch: Record<string, unknown>) =>
    clip("o", { trackType: "video", trackIndex: 2, startTime: 0.5, endTime: 3, mediaUrl: "/m/v.webm", mediaType: "video", scale: 0.5, ...patch });
const sticker = (patch: Record<string, unknown>) =>
    clip("s", { trackType: "sticker", trackIndex: 1, startTime: 0, endTime: 3, mediaUrl: "/m/s.png", mediaType: "image", ...patch });
const keyframes = (points: Array<Record<string, number>>) => JSON.stringify(points);
const withOverlay = (patch: Record<string, unknown>) => input({ scenes: BASE_SCENES, clips: [overlay(patch)] });

/** One synthetic timeline per feature group the compiler emits filters for. */
export const FEATURE_TIMELINES: Array<[string, ExportInput]> = [
    ["color", withOverlay({ brightness: 0.1, contrast: 1.2, saturation: 0.8 })],
    ["warm preset", withOverlay({ visualFilter: "warm" })],
    ["cool preset", withOverlay({ visualFilter: "cool" })],
    ["cinematic preset", withOverlay({ visualFilter: "cinematic" })],
    ["blur", withOverlay({ blurStrength: 3 })],
    ["multiply blend", withOverlay({ blendMode: "multiply" })],
    ["screen blend", withOverlay({ blendMode: "screen" })],
    ["overlay blend", withOverlay({ blendMode: "overlay" })],
    ["chroma key", withOverlay({ chromaKeyEnabled: true, chromaKeyColor: "#00ff00" })],
    ["mosaic", withOverlay({ mosaicStrength: 4 })],
    ["crop, flip, rotate", withOverlay({ cropLeft: 0.1, cropTop: 0.05, horizontalFlip: true, verticalFlip: true, rotationDegrees: 30 })],
    ["speed, reverse, freeze", input({ scenes: BASE_SCENES, clips: [overlay({ playbackSpeed: 1.5, reversePlayback: true }), clip("f", { trackType: "video", trackIndex: 2, startTime: 3, endTime: 4, mediaUrl: "/m/v.webm", mediaType: "video", freezeFrame: true })] })],
    ["speed ramp", withOverlay({ speedRamp: "hero" })],
    ["keyframed scale", input({ scenes: BASE_SCENES, clips: [sticker({ keyframesJson: keyframes([{ time: 0, scale: 0.5 }, { time: 2, scale: 1.2 }]) })] })],
    ["keyframed position", input({ scenes: BASE_SCENES, clips: [sticker({ keyframesJson: keyframes([{ time: 0, position_x: 0, position_y: 0 }, { time: 2, position_x: 1, position_y: 1 }]) })] })],
    ["keyframed rotation", input({ scenes: BASE_SCENES, clips: [sticker({ keyframesJson: keyframes([{ time: 0, rotation_degrees: 0 }, { time: 2, rotation_degrees: 180 }]) })] })],
    ["keyframed opacity", input({ scenes: BASE_SCENES, clips: [sticker({ keyframesJson: keyframes([{ time: 0, opacity: 0 }, { time: 1, opacity: 1 }]) })] })],
    ["zoom_in motion", withOverlay({ motionPreset: "zoom_in" })],
    ["zoom_out motion", withOverlay({ motionPreset: "zoom_out" })],
    ["pulse motion", withOverlay({ motionPreset: "pulse", rotationDegrees: 15 })],
    ["text with keyframes", input({ scenes: BASE_SCENES, clips: [clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 3, textContent: "Hi", keyframesJson: keyframes([{ time: 0, opacity: 0, scale: 0.6 }, { time: 1, opacity: 1, scale: 1 }]) })] })],
    ["scene transitions", input({ scenes: [scene("a", 0, 2, { visualTransition: "cross_dissolve", visualTransitionDuration: 1 }), scene("b", 2, 2, { visualTransition: "wipe_left", visualTransitionDuration: 0.5 }), scene("v", 4, 2, { sourceVideoUrl: "/m/v.webm", visualTransition: "slide_left", visualTransitionDuration: 0.5 })] })],
    ["static mask", input({ scenes: [scene("a", 0, 2, { maskJson: '{"shape":"heart","feather":0.2}' }), scene("b", 2, 2)], clips: [overlay({ maskJson: '{"shape":"rectangle","roundness":0.5}' })] })],
    ["keyframed mask", input({ scenes: BASE_SCENES, clips: [overlay({ maskJson: '{"shape":"star"}', keyframesJson: keyframes([{ time: 0, mask_rotation: 0 }, { time: 2, mask_rotation: 90 }]) })] })],
    ["clip transitions", input({ scenes: BASE_SCENES, clips: [overlay({ fadeInDuration: 0.3, fadeOutDuration: 0.3, transitionType: "dip_white" }), sticker({ transitionType: "cross_dissolve", fadeInDuration: 0.5 })] })],
    ["audio", input({
        project: { aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 0.3 },
        scenes: BASE_SCENES,
        clips: [clip("au", {
            trackType: "audio", trackIndex: 2, startTime: 0, endTime: 3, mediaUrl: "/m/sfx.wav", mediaType: "audio", audioPitch: 3, audioEq: "vocal",
            audioDenoise: true, audioNormalize: true, audioPan: -0.5, playbackSpeed: 1.25, fadeOutDuration: 1, keyframesJson: keyframes([{ time: 0, volume: 0.2 }, { time: 2, volume: 1 }]),
        })],
    })],
];
