// Public API of @opennan/provider-sdk (Apache-2.0, spec §5.4).
export const PROVIDER_SDK_VERSION = "0.5.0";

export {
    OPEN_CAPABILITIES, OPENNAN_CAPABILITIES, PROVIDER_RUNTIME_CAPABILITIES, LOCAL_ONLY_CAPABILITIES, ON_DEVICE_FIRST_CAPABILITIES,
    isToolCapability, isProviderCapability, isOpenNanCapability, isProviderRuntimeCapability, isLocalOnlyCapability, isOnDeviceFirstCapability, capabilityUnavailableMessage,
    type OpenCapability, type OpenNanCapability, type ProviderRuntimeCapability, type ProviderCapability, type ToolCapability,
} from "./capabilities";
export { CapabilityUnavailableError, ProviderRegistrationError, JobFailedError, JobCancelledError, type UnavailableReason } from "./errors";
export { createJob, CANCEL_REFUSED_MESSAGE, type Job, type JobStatus, type JobUpdate, type JobContext, type CreateJobOptions, type LocalJob, type CancelAnswer } from "./job";
export type {
    ProviderInfo, ProviderCredentials, ProviderModel, Provider, CapabilityRequest, AudioProvider, StoryProvider, VideoProvider, ImageProvider, RenderProvider,
    ProviderVoice, PriceRequest, PriceAnswer,
} from "./types";
export {
    BILLING_SAFETY, captionBilledCharacters, estimateImageCost, estimateMusicCost, estimateSoundEffectCost, estimateStemsCost, estimateToolCost,
    estimateVideoModelCost, estimateVoiceCost, estimateTextCost, promptTokenBound, formatUsdEstimate, displayedUsd, isOverLimit, startedUnits, toMicroUsd, paddedSeconds, quotedEstimate,
    type ToolPriceBlock, type PriceUnits, type CostEstimate, type OverLimit, type ImageModelPrice, type ImageTier, type VideoModelPrice, type VideoTier, type TextModelPrice, type TextTokens, type VoiceModelPrice, type StemsModelPrice,
} from "./prices";
export { parseMediaSourceRef, type MediaSourceRef, type MediaPrepareInput, type MediaPreparePurpose, type PreparedMedia, type MediaPreparer } from "./media-source";
export { isCapabilityOutput, type CapabilityOutput, type GeneratedMedia, type GeneratedMediaKind } from "./capability-output";
export type { AudioInput, TranscribeRequest, Transcript, TranscriptSegment, TranscriptWord } from "./transcribe-types";
export { ProviderRegistry, OPENNAN_PROVIDER_ID } from "./registry";
export { capabilityGate, type CapabilityGate } from "./ui";
export { WHISPER_LANGUAGES, isTranscribeLanguage, transcriptToCaptionCues, transcriptText, type CaptionCue, type CaptionCueOptions } from "./transcribe";
export {
    createAiRunner, MAX_CAPTION_CUES, MAX_RUN_INPUT_BYTES,
    type AiRunner, type AiRunnerOptions, type ImportedMedia, type AiRunRequestLike, type AiRunContextLike, type AiRunProgressLike, type AiRunOutcomeLike, type CaptionsPlacementLike,
    type AiPlacementLike, type AiTargetRefLike, type AiMediaRefLike, type AiSourceRangeLike, type CaptionCueLike,
} from "./ai-runner";
export { AiJobBook, MAX_AI_JOB_RECORDS, type AiJobRecord, type AiJobPatch } from "./job-book";
export { providerContractCases, type ProviderContractCase } from "./testing";
export { downloadMedia, checkDownloadUrl, isPrivateHost, DEFAULT_MAX_DOWNLOAD_BYTES, DEFAULT_DOWNLOAD_TIMEOUT_MS, type DownloadOptions } from "./download";
