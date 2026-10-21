// Unit coverage for preview timeline clip filtering before playback/compositing.
import { describe, expect, it } from "vitest";
import { filterPreviewTimelineClips, mediaUrlsReferToSameAsset, shouldMuteDetachedSourceVideoAtTime, shouldMuteEmbeddedVideoForTimelineVoiceover, timelineAudioHandlesUrlAtTime, timelineOwnsSceneAudioAtTime, timelineOwnsSceneVoiceoverPlayback } from "./preview-timeline-clips";
import type { TimelineClip, TimelineTrack } from "../model/timeline";

function clip(overrides: Partial<TimelineClip>): TimelineClip {
  return {
    id: "clip",
    projectId: "project",
    trackType: "text",
    trackIndex: 1,
    startTime: 0,
    endTime: 5,
    mediaUrl: null,
    mediaType: "uploaded",
    sceneId: null,
    label: null,
    thumbnailUrl: null,
    locked: false,
    volume: 1,
    audioPan: 0,
    audioPitch: 0,
    audioEq: "none",
    audioDenoise: false,
    audioNormalize: false,
    playbackSpeed: 1,
    speedRamp: "none",
    reversePlayback: false,
    freezeFrame: false,
    fadeInDuration: 0,
    fadeOutDuration: 0,
    transitionType: "none",
    transitionDuration: 0,
    opacity: 1,
    scale: 1,
    positionX: 0.5,
    positionY: 0.5,
    horizontalFlip: false,
    verticalFlip: false,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    visualFilter: "none",
    motionPreset: "none",
    blurStrength: 0,
    chromaKeyEnabled: false,
    chromaKeyColor: "0x00FF00",
    chromaKeySimilarity: 0.1,
    chromaKeyBlend: 0,
    blendMode: "normal",
    mosaicStrength: 0,
    rotationDegrees: 0,
    keyframesJson: null,
    textContent: null,
    textStyle: null,
    trimStart: null,
    trimEnd: null,
    ...overrides,
  };
}

function track(overrides: Partial<TimelineTrack>): TimelineTrack {
  return {
    type: "text",
    index: 1,
    label: "T1",
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
    ...overrides,
  };
}

describe("filterPreviewTimelineClips", () => {
  it("removes muted audio tracks before clips reach ScenePreview playback", () => {
    const clips = [
      clip({ id: "muted-audio", trackType: "audio", trackIndex: 1, mediaUrl: "https://cdn.example.com/muted.mp3" }),
      clip({ id: "live-audio", trackType: "audio", trackIndex: 2, mediaUrl: "https://cdn.example.com/live.mp3" }),
      clip({ id: "hidden-text", trackType: "text", trackIndex: 1, textContent: "hidden" }),
      clip({ id: "visible-text", trackType: "text", trackIndex: 2, textContent: "visible" }),
    ];
    const tracks = [
      track({ type: "audio", index: 1, label: "A1", muted: true }),
      track({ type: "audio", index: 2, label: "A2", muted: false }),
      track({ type: "text", index: 1, label: "T1", visible: false }),
      track({ type: "text", index: 2, label: "T2", visible: true }),
    ];

    expect(filterPreviewTimelineClips(clips, tracks).map((item) => item.id)).toEqual([
      "live-audio",
      "visible-text",
    ]);
  });

  it("removes silent audio clips without hiding muted video visuals", () => {
    const clips = [
      clip({ id: "silent-audio-clip", trackType: "audio", trackIndex: 1, mediaUrl: "https://cdn.example.com/silent.mp3", volume: 0 }),
      clip({ id: "silent-audio-track", trackType: "audio", trackIndex: 2, mediaUrl: "https://cdn.example.com/track-silent.mp3" }),
      clip({ id: "live-audio", trackType: "audio", trackIndex: 3, mediaUrl: "https://cdn.example.com/live.mp3", volume: 0.5 }),
      clip({ id: "muted-video", trackType: "video", trackIndex: 1, mediaUrl: "https://cdn.example.com/visual.mp4", volume: 0 }),
    ];
    const tracks = [
      track({ type: "audio", index: 1, label: "A1", volume: 1 }),
      track({ type: "audio", index: 2, label: "A2", volume: 0 }),
      track({ type: "audio", index: 3, label: "A3", volume: 0.5 }),
      track({ type: "video", index: 1, label: "V1", volume: 0 }),
    ];

    expect(filterPreviewTimelineClips(clips, tracks).map((item) => item.id)).toEqual([
      "live-audio",
      "muted-video",
    ]);
  });
});

describe("shouldMuteDetachedSourceVideoAtTime", () => {
  const sourceUrl = "https://cdn.example.com/source.mp4";

  it("mutes embedded source playback when detached audio overlaps the playhead", () => {
    const clips = [
      clip({ id: "detached-audio", trackType: "audio", trackIndex: 1, mediaUrl: sourceUrl, startTime: 0, endTime: 10 }),
      clip({ id: "silent-video", trackType: "video", trackIndex: 1, mediaUrl: sourceUrl, startTime: 0, endTime: 10, volume: 0 }),
    ];
    expect(shouldMuteDetachedSourceVideoAtTime(sourceUrl, clips, 2)).toBe(true);
    expect(shouldMuteDetachedSourceVideoAtTime(sourceUrl, clips, 11)).toBe(false);
  });

  it("mutes embedded source playback when only the video clip was silenced", () => {
    const clips = [
      clip({ id: "silent-video", trackType: "video", trackIndex: 1, mediaUrl: sourceUrl, startTime: 1, endTime: 4, volume: 0 }),
    ];
    expect(shouldMuteDetachedSourceVideoAtTime(sourceUrl, clips, 2)).toBe(true);
  });

  it("matches detached clips across proxy and CDN URL forms", () => {
    const clips = [
      clip({
        id: "detached-audio",
        trackType: "audio",
        trackIndex: 1,
        mediaUrl: "https://cdn.opennan.com/generated/video/clip.mp4",
        startTime: 0,
        endTime: 10,
      }),
    ];
    expect(mediaUrlsReferToSameAsset(
      "/generated/video/clip.mp4",
      "https://cdn.opennan.com/generated/video/clip.mp4",
    )).toBe(true);
    expect(shouldMuteDetachedSourceVideoAtTime("/generated/video/clip.mp4", clips, 1)).toBe(true);
  });
});

describe("shouldMuteEmbeddedVideoForTimelineVoiceover", () => {
  const voiceUrl = "https://cdn.opennan.com/generated/audio/voice.mp3";

  it("mutes embedded scene video when voiceover lives on the timeline and scene binding is cleared", () => {
    const clips = [
      clip({ id: "voice-a1", trackType: "audio", trackIndex: 1, mediaUrl: voiceUrl, mediaType: "audio", startTime: 0, endTime: 8 }),
    ];
    expect(shouldMuteEmbeddedVideoForTimelineVoiceover(false, clips, 2)).toBe(true);
    expect(shouldMuteEmbeddedVideoForTimelineVoiceover(true, clips, 2)).toBe(false);
    expect(shouldMuteEmbeddedVideoForTimelineVoiceover(false, clips, 9)).toBe(false);
  });
});

describe("timelineOwnsSceneVoiceoverPlayback", () => {
  const voiceUrl = "https://cdn.opennan.com/generated/audio/voice.mp3";

  it("returns true when timeline voiceover clip overlaps the playhead", () => {
    const clips = [
      clip({ id: "voice-a1", trackType: "audio", trackIndex: 1, mediaUrl: voiceUrl, mediaType: "audio", startTime: 0, endTime: 8 }),
    ];
    expect(timelineOwnsSceneVoiceoverPlayback(voiceUrl, clips, 2)).toBe(true);
    expect(timelineOwnsSceneVoiceoverPlayback(null, clips, 2)).toBe(true);
    expect(timelineOwnsSceneVoiceoverPlayback(voiceUrl, clips, 9)).toBe(false);
  });
});

describe("timelineAudioHandlesUrlAtTime", () => {
  it("returns true when an audible timeline audio clip owns the scene voiceover URL", () => {
    const voiceUrl = "https://cdn.opennan.com/generated/audio/voice.mp3";
    const clips = [
      clip({ id: "voice-a1", trackType: "audio", trackIndex: 1, mediaUrl: voiceUrl, startTime: 0, endTime: 8 }),
    ];
    expect(timelineAudioHandlesUrlAtTime(clips, voiceUrl, 2)).toBe(true);
    expect(timelineAudioHandlesUrlAtTime(clips, voiceUrl, 9)).toBe(false);
  });
});

describe("timelineOwnsSceneAudioAtTime", () => {
  it("mutes embedded scene audio once that scene's audio lives on the timeline", () => {
    // The extracted file has its own URL, so URL matching never caught this:
    // the scene video kept talking under a muted lane and doubled the dialogue.
    const clips = [
      clip({
        id: "detached", trackType: "audio", trackIndex: 1, sceneId: "scene-1",
        mediaUrl: "https://cdn.example.com/extracted.m4a", volume: 0,
        startTime: 0, endTime: 24,
      }),
    ];

    expect(timelineOwnsSceneAudioAtTime("scene-1", clips, 5)).toBe(true);
  });

  it("leaves other scenes and other times alone", () => {
    const clips = [
      clip({
        id: "detached", trackType: "audio", trackIndex: 1, sceneId: "scene-1",
        mediaUrl: "https://cdn.example.com/extracted.m4a", startTime: 0, endTime: 10,
      }),
    ];

    expect(timelineOwnsSceneAudioAtTime("scene-2", clips, 5)).toBe(false);
    expect(timelineOwnsSceneAudioAtTime("scene-1", clips, 20)).toBe(false);
    expect(timelineOwnsSceneAudioAtTime(null, clips, 5)).toBe(false);
  });
});
