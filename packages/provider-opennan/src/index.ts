// Public API of @opennan/provider-opennan (OpenNan Community License): Sign in with OpenNan, the account, and the
// OpenNan provider over the opennan.com public API. Browser-safe: no Node imports (the fake server is ./testing).
export const PROVIDER_OPENNAN_VERSION = "0.8.0";

export { createOpenNanApi, isAllowedApiBase, DEFAULT_API_BASE, DEFAULT_CONSOLE_BASE, type OpenNanApi, type OpenNanApiOptions, type RequestOptions, type HttpMethod } from "./api";
export {
    OpenNanApiError, InsufficientCreditsError, OpenNanSignInRequiredError, DeviceFlowError, SIGN_IN_GUIDANCE, redactKeys, type DeviceFlowErrorKind,
    OPENNAN_ERROR_COPY, TIER_NOT_OFFERED_MESSAGE, UPLOAD_AGAIN, openNanErrorMessage, safeServerText, type OpenNanErrorCode,
} from "./errors";
export {
    startDeviceSignIn, createDevicePoller, DEVICE_GRANT_TYPE, MAX_NETWORK_FAILURES,
    type DeviceStart, type DeviceToken, type DevicePoller, type DeviceClient, type PollerOptions,
} from "./device-flow";
export { cleanDeviceName, webDeviceName } from "./device-name";
export { getAccount, revokeKey, parseAccount, type AccountInfo } from "./account";
export {
    OpenNanSession, memoryCredentialStore, isConsoleDeviceUrl, API_KEY_PATTERN, UNTRUSTED_PAGE_MESSAGE,
    type SessionStatus, type SessionNotice, type SessionErrorKind, type CredentialStore, type CredentialPersistence, type StoredCredential, type OpenNanSessionOptions,
} from "./session";
export {
    createOpenNanProvider, OPENNAN_PROVIDER_CAPABILITIES, INSUFFICIENT_CREDITS_MESSAGE, TASK_WAIT_SECONDS, MIN_TASK_POLL_MS, MAX_IMAGE_REFERENCES, MAX_VIDEO_REFERENCES, OpenNanProjectPipelineError, type OpenNanProviderOptions,
} from "./provider";
export { uploadMedia, isAllowedUploadUrl, DEFAULT_UPLOAD_HOSTS, SINGLE_PUT_MAX_BYTES, UPLOAD_SCOPE_MESSAGE, UPLOAD_CONTENT_TYPES, type UploadedMedia, type UploadCache, type UploadOptions } from "./uploads";
export {
    createQuoteClient, quoteBody, canonicalBody, QUOTE_PATH, QUOTE_CACHE_MS, QUOTE_UNSUPPORTED_MS, QUOTE_IMAGE_PLACEHOLDER, QUOTE_VIDEO_PLACEHOLDER, type QuoteClient, type QuoteResult, type QuoteClientOptions,
} from "./quotes";
export { createOpenNanCatalog, priceRun, textTokens, OPENNAN_TOOLS, CATALOG_CACHE_MS, PRICES_UNAVAILABLE, DEFAULT_TEXT_MAX_TOKENS, type OpenNanCatalog, type ToolRow } from "./prices";
export { MAX_TEXT_IMAGES, MAX_TEXT_MAX_TOKENS, MAX_TEXT_PROMPT } from "./text";
export { MEDIA_PURPOSES, MEDIA_TOOL_CAPABILITIES, PREPARE_MEDIA_UNAVAILABLE, PRICE_UNKNOWN_MESSAGE, PriceChangedError, transcriptOf, transcribeLanguage } from "./tools";
export {
    REFERENCE_ASPECT, longerThanPriced, parseReferenceLimits, parseReferenceVideos, preparedReferenceProblem, referenceLengthProblem, referencePurpose, referenceSecondsOf,
    type ReferenceVideoInput,
} from "./references";
export { stageLabel, STAGE_LABELS, CANCEL_TOO_LATE_MESSAGE, cancelRetryDelayMs } from "./tasks";
