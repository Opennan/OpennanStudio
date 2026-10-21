// A 10d/11-era project for tests: every Studio-only field (masks, speed curves up to 100×, adjustments, effects,
// beats, caption words, keyframes, animation, stickers, remotion and AI clip fields, scene looks, motion and speed,
// shot breakdowns), null and absent optional fields, and values no server column can hold as they are.
import type { ClipEffect, LocalProjectState, SceneData, TimelineClip, TimelineTrack } from "@opennan/timeline-core";

export const FIXTURE_IDS = {
    clipVideo: "0b7a3d52-6d1f-4d8e-9a33-2a8b9c1d0e11",
    clipText: "1c8b4e63-7e20-4e9f-8b44-3b9cad2e1f22",
    clipSticker: "2d9c5f74-8f31-4fa0-9c55-4cadbe3f2033",
    clipAudio: "3eadf085-9042-4b01-8d66-5dbecf403144",
    clipRemotion: "4fbe0196-a153-4c12-9e77-6ecfd0514255",
    sceneA: "5acf12a7-b264-4d23-8f88-7fd0e1625366",
    sceneB: "6bd023b8-c375-4e34-9099-80e1f2736477",
    effect1: "7ce134c9-d486-4f45-a1aa-91f203847588",
    effect2: "8df245da-e597-4056-b2bb-a20314958699",
    effect3: "9e0356eb-f6a8-4167-83cc-b3142506979a",
};

const I = FIXTURE_IDS;

export function baseClip(id: string, overrides: Partial<TimelineClip> = {}): TimelineClip {
    return {
        id, projectId: "local-project", trackType: "video", trackIndex: 2, startTime: 0, endTime: 4, mediaUrl: null, mediaType: "video", sceneId: null,
        label: null, thumbnailUrl: null, locked: false, volume: 1, audioPan: 0, audioPitch: 0, audioEq: "none", audioDenoise: false, audioNormalize: false,
        playbackSpeed: 1, speedRamp: "none", reversePlayback: false, freezeFrame: false, fadeInDuration: 0, fadeOutDuration: 0, transitionType: "none",
        transitionDuration: 0, opacity: 1, scale: 1, positionX: 0.5, positionY: 0.5, horizontalFlip: false, verticalFlip: false, cropLeft: 0, cropRight: 0,
        cropTop: 0, cropBottom: 0, brightness: 0, contrast: 1, saturation: 1, visualFilter: "none", motionPreset: "none", blurStrength: 0, chromaKeyEnabled: false,
        chromaKeyColor: "0x00FF00", chromaKeySimilarity: 0.1, chromaKeyBlend: 0, blendMode: "normal", mosaicStrength: 0, rotationDegrees: 0, keyframesJson: null,
        textContent: null, textStyle: null, trimStart: null, trimEnd: null,
        ...overrides,
    };
}

function effect(id: string, owner: { clipId?: string; sceneId?: string }, effectId: string, order: number, paramsJson: string | null, enabled = true): ClipEffect {
    return { id, clipId: owner.clipId ?? null, sceneId: owner.clipId ? null : owner.sceneId ?? null, effectId, order, paramsJson, enabled, ownerScope: "project" };
}

export function richProject(mediaUrl = "opennan-local://media/aaaaaaaa-1111-4222-8333-444444444444"): LocalProjectState {
    const tracks: TimelineTrack[] = [
        { type: "video", index: 1, label: "V1", muted: false, locked: false, visible: true, volume: 1 },
        { type: "audio", index: 1, label: "A1", muted: false, locked: false, visible: true, volume: 1 },
        { type: "video", index: 2, label: "Overlay with a label far longer than forty characters", muted: false, locked: false, visible: true, volume: 1 },
        { type: "text", index: 1, label: "Captions", muted: false, locked: false, visible: true, volume: 1 },
        { type: "sticker", index: 1, label: "Stickers", muted: false, locked: false, visible: false, volume: 1 },
        { type: "audio", index: 2, label: "Music", muted: true, locked: false, visible: true, volume: 6.5 },
        { type: "remotion", index: 1, label: "Graphics", muted: false, locked: false, visible: true, volume: 1 },
    ];
    const clips: TimelineClip[] = [
        baseClip(I.clipVideo, {
            mediaUrl, thumbnailUrl: null, label: "Intro.mp4", playbackSpeed: 100, volume: 5, scale: 2.5, positionX: -0.25, rotationDegrees: 12.5,
            keyframesJson: JSON.stringify({ scale: [{ t: 0, v: 1 }, { t: 2, v: 1.4, ease: "inOut" }], position_x: [{ t: 0, v: 0.5 }] }),
            speedCurveJson: JSON.stringify({ preset: "montage", points: [{ t: 0, v: 1 }, { t: 0.5, v: 100 }, { t: 1, v: 1 }] }),
            preservePitch: false, filterIntensity: 0.65, adjustmentsJson: JSON.stringify({ temperature: 12, tint: -4, highlights: 0.2, vignette: 0.3 }),
            animationJson: JSON.stringify({ in: { kind: "fade", duration: 0.4 }, out: { kind: "zoom", duration: 0.3 } }),
            maskJson: JSON.stringify({ kind: "circle", x: 0.5, y: 0.5, width: 0.4, height: 0.4, feather: 0.1, invert: false }),
            transitionType: "dissolve", transitionDuration: 0.5, transitionParamsJson: JSON.stringify({ direction: "left" }),
            trimStart: 1.25, trimEnd: 5.5, visualFilter: "teal_orange",
            effects: [
                effect(I.effect1, { clipId: I.clipVideo }, "fx_blur", 0, JSON.stringify({ radius: 4 })),
                effect(I.effect2, { clipId: I.clipVideo }, "glitch", 1, null, false),
            ],
        }),
        baseClip(I.clipText, {
            trackType: "text", trackIndex: 1, mediaType: "text", startTime: 0.5, endTime: 3.25, textContent: "Hello world, this is a caption",
            textStyle: JSON.stringify({ font: "Inter", size: 48, color: "#ffffff", karaoke: { active: "#ffd400" } }),
            captionWordsJson: JSON.stringify([{ start: 0, end: 0.4, text: "Hello" }, { start: 0.4, end: 0.9, text: "world," }]),
            animationJson: JSON.stringify({ loop: { kind: "pulse", period: 1 } }),
        }),
        baseClip(I.clipSticker, { trackType: "sticker", trackIndex: 1, mediaType: "sticker", startTime: 1, endTime: 2, stickerId: "party-popper", opacity: 0.8 }),
        baseClip(I.clipAudio, {
            trackType: "audio", trackIndex: 2, mediaType: "audio", mediaUrl, startTime: 0, endTime: 30, volume: 0.7, audioPan: -0.3, audioEq: "voice",
            beatsJson: JSON.stringify([0.5, 1, 1.5, 2, 2.5]), fadeOutDuration: 2.5,
        }),
        baseClip(I.clipRemotion, {
            trackType: "remotion", trackIndex: 1, mediaType: "remotion", startTime: 2, endTime: 6, remotionTemplateId: "lower-third",
            remotionPropsJson: JSON.stringify({ title: "OpenNan", subtitle: "Studio" }), remotionCode: null, remotionStatus: "ready", remotionError: null,
            customGraphicId: "graphic-local-123", aiPrompt: "a lower third", aiReferenceUrls: JSON.stringify(["https://example.com/ref.png"]),
            aiGenerationStatus: "ready", aiGenerationError: null, aiModelId: "model-x",
        }),
    ];
    const sceneA: SceneData = {
        id: I.sceneA, order: 0, caption: "Opening shot", startTime: "00:00:00.000", endTime: "00:00:06.000", timelinePositionSeconds: 0.001, trackIndex: 1,
        startImageUrl: null, endImageUrl: null, videoUrl: mediaUrl, sourceVideoUrl: mediaUrl, status: "planned", transition: "cut",
        visualTransition: "crossfade", visualTransitionDuration: 0.5, visualFilter: "noir", filterIntensity: 0.4,
        adjustmentsJson: JSON.stringify({ exposure: 0.1 }), effects: [effect(I.effect3, { sceneId: I.sceneA }, "fx_vhs", 0, JSON.stringify({ amount: 0.6 }))],
        cardType: "source_clip", duration: 6, overlayText: null, frameConsistencyScore: null, audioUrl: null, audioText: null,
        cardConfig: JSON.stringify({ timelineTrimStart: 0.5, timelineTrimEnd: 6.5 }), shotBreakdown: "[]", fitMode: "cover", transformScale: 1.2,
        transformOffsetX: 0.1, transformOffsetY: -0.05, sourceWidth: 1920, sourceHeight: 1080,
        keyframesJson: JSON.stringify({ scale: [{ t: 0, v: 1 }, { t: 6, v: 1.3 }] }), animationJson: null, rotationDegrees: 3, opacity: 0.9,
        playbackSpeed: 2, speedCurveJson: null, preservePitch: true, maskJson: JSON.stringify({ kind: "linear", angle: 45, feather: 0.2 }),
    };
    const sceneB: SceneData = {
        id: I.sceneB, order: 1, caption: "", startTime: "00:00:00.000", endTime: "00:00:04.000", startImageUrl: null, endImageUrl: null, videoUrl: null,
        status: "pending", transition: "cut", cardType: null, duration: 4, frameConsistencyScore: 0.82, audioUrl: null, audioText: "Narration text",
        cardConfig: null, shotBreakdown: JSON.stringify([{ duration: 2, prompt: "wide" }, { duration: 2, prompt: "close" }]), playbackSpeed: 0.25,
    };
    return {
        meta: { id: "local-project", name: "Trip edit", musicUrl: null, musicVolume: 1, aspectRatio: "9:16" },
        tracks,
        clips,
        scenes: [sceneA, sceneB],
        library: [{ url: mediaUrl, name: "Intro.mp4", size: 1234, mimeType: "video/mp4", durationSeconds: 6.5 }],
    };
}
