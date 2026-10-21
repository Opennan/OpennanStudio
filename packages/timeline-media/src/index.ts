// Public API of @opennan/timeline-media.
export const TIMELINE_MEDIA_VERSION = "0.4.0";

export {
    IDENTITY_MEDIA_ENVIRONMENT,
    LOCAL_MEDIA_PROTOCOL,
    createBrowserMediaEnvironment,
    type BrowserMediaEnvironmentOptions,
    type MediaEnvironment,
} from "./media-environment";

export { loadAudioDuration } from "./audio-duration";
export { createThumbnailCache, shouldUseAnonymousVideoFrameCors } from "./thumbnail-generator";
export { decodeFramesAtTimes, isWebCodecsFrameDecodeSupported, planFrameTimes, releaseUnusedInputs } from "./webcodecs-frame-source";
export { createWaveformCache } from "./waveform-generator";
