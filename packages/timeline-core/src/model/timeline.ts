// Timeline data model. Copied from opennan frontend hooks/use-timeline.ts; keep field names in sync with the GraphQL schema.

export interface TimelineTrack {
  type: "video" | "audio" | "text" | "sticker" | "effect" | "remotion";
  index: number;
  label: string;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  volume: number;
}

export interface TimelineClip {
  id: string;
  projectId: string;
  trackType: string;
  trackIndex: number;
  startTime: number;
  endTime: number;
  mediaUrl: string | null;
  mediaType: string;
  sceneId: string | null;
  label: string | null;
  thumbnailUrl: string | null;
  locked: boolean;
  volume: number;
  audioPan: number;
  audioPitch: number;
  audioEq: string;
  audioDenoise: boolean;
  audioNormalize: boolean;
  playbackSpeed: number;
  speedRamp: string;
  reversePlayback: boolean;
  freezeFrame: boolean;
  fadeInDuration: number;
  fadeOutDuration: number;
  transitionType: string;
  transitionDuration: number;
  // Optional so existing clip fixtures/payloads without the column stay valid.
  transitionParamsJson?: string | null;
  opacity: number;
  scale: number;
  positionX: number;
  positionY: number;
  horizontalFlip: boolean;
  verticalFlip: boolean;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  brightness: number;
  contrast: number;
  saturation: number;
  visualFilter: string;
  /** Filter strength 0..1 (phase 10a). Absent: full strength (pre-10a presets). */
  filterIntensity?: number | null;
  /** Adjust controls other than brightness/contrast/saturation, JSON (looks/adjust.ts). */
  adjustmentsJson?: string | null;
  motionPreset: string;
  blurStrength: number;
  chromaKeyEnabled: boolean;
  chromaKeyColor: string;
  chromaKeySimilarity: number;
  chromaKeyBlend: number;
  blendMode: string;
  mosaicStrength: number;
  rotationDegrees: number;
  keyframesJson: string | null;
  textContent: string | null;
  textStyle: string | null;
  trimStart: number | null;
  trimEnd: number | null;
  // Raw AI-generate clip fields (only populated when mediaType === "ai_generate")
  aiPrompt?: string | null;
  aiReferenceUrls?: string | null;  // JSON array of URLs
  aiGenerationStatus?: string | null;  // idle | generating | ready | error
  aiGenerationError?: string | null;
  aiModelId?: string | null;
  // Remotion graphics clip (trackType="remotion")
  remotionTemplateId?: string | null;
  remotionPropsJson?: string | null;
  remotionCode?: string | null;
  remotionStatus?: string | null;  // idle | generating | ready | error (server-managed)
  remotionError?: string | null;  // server-managed
  // Set when the clip renders a graphic from the user's library. The code
  // stays server-side and is resolved at export.
  customGraphicId?: string | null;
  // Stacked GL-shader effects applied to this clip (ordered by `order`).
  effects?: ClipEffect[];
  /** In / out / combo / loop animation (phase 10b, motion/animation-spec.ts). */
  animationJson?: string | null;
  /** Speed curve (phase 10b, motion/speed.ts); wins over the legacy `speedRamp`. */
  speedCurveJson?: string | null;
  /** Keep the audio pitch when the speed changes (default true). */
  preservePitch?: boolean | null;
  /** Bundled sticker id (phase 10b, stickers/catalog.ts); `mediaUrl` stays null. */
  stickerId?: string | null;
  /** Caption word timings, clip-local seconds: JSON [{ start, end, text }] (phase 10b, text/captions.ts). */
  captionWordsJson?: string | null;
  /** Mask (phase 10c, looks/masks.ts MaskSpec as JSON) for video and image clips; absent or null = no mask. */
  maskJson?: string | null;
  /** Beat times of an audio clip, source-media seconds: JSON number[] (phase 11, analysis/beats.ts). */
  beatsJson?: string | null;
}

/** One applied GL effect on a clip or scene (a row of the effect stack). */
export interface ClipEffect {
  id: string;
  clipId: string | null;
  sceneId: string | null;
  effectId: string;  // registry entry id
  order: number;
  paramsJson: string | null;  // JSON of param key→value
  enabled: boolean;
  ownerScope: string;
}

export interface TimelineData {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  canUndo: boolean;
  canRedo: boolean;
}

// Audio AI job result shapes. Copied from opennan frontend hooks/use-timeline.ts:205-223.
export interface AudioSpeakerSegment {
  speakerId: string;
  start: number;
  end: number;
  text: string;
  characterId?: string | null;
}

export interface AudioAiResult {
  operation: string;
  queued?: boolean | null;
  outputAudioUrl?: string | null;
  speechAudioUrl?: string | null;
  musicAudioUrl?: string | null;
  transcriptText?: string | null;
  speakerSegments: AudioSpeakerSegment[];
  createdClips: TimelineClip[];
  message?: string | null;
}
