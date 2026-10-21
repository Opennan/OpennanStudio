// Public API of @opennan/cloud-backend (OpenNan Community License, as timeline-core): OpenNan cloud projects for OpenNan Studio.
export const CLOUD_BACKEND_VERSION = "0.5.0";

export { createCloudApi, CloudApiError, isCloudApiError, isAbortError, isAllowedCloudBase, type CloudApi, type CloudApiOptions, type CloudMethod, type CloudRequest, type CloudResponse, type CloudStreamResponse } from "./api";
export { createSha256, hashBlob, toHex, type Sha256 } from "./sha256";
export { REAL_CLOCK, FakeClock, settle, type Clock } from "./clock";
export { createMemoryStore, STORE_NAMESPACES, type CloudStore, type StoreNamespace } from "./store";
export { migrateStore, migratingStore } from "./store-migration";
export {
    MediaCacheIndex, parseCacheIndex, planEviction, cacheBytes, CACHE_GRACE_MS, TOUCH_DELAY_MS, type CacheEntry, type CacheIndexFile, type CacheIndexStorage, type EvictionOptions,
} from "./cache-index";
export {
    encodeDoc, decodeDoc, ingestDocument, normalizedProject, localUrlsIn, isLocalUrl, IDENTITY_URLS, LOCAL_URL_PREFIX, CLIP_COLUMNS, SCENE_COLUMNS, PROJECT_COLUMNS, TRACK_COLUMNS,
    type ServerDoc, type LocalDoc, type Fields, type UrlMap, type DocumentJson,
} from "./codec";
export { diffDocs, mergeDeltas, rebase, applyDelta, invertDelta, undoDelta, type Delta, type EntityDelta, type FieldChange } from "./delta";
export { buildChangesets, refusedKeys, MAX_ITEMS, MAX_BODY_BYTES, type ChangesetBody } from "./changeset";
export { DeltaHistory } from "./history";
export {
    CloudProjectSession, ALWAYS_ONLINE, EDITED_ELSEWHERE, FLUSH_DELAY_MS, FLUSH_MAX_DELAY_MS, POLL_VISIBLE_MS, POLL_HIDDEN_MS, POLL_FLOOR_MS, STORM_LIMIT,
    REMOTE_STEP_TIMEOUT_MS, REMOTE_STEP_LOST, SHOTS_RETRY_MS, SHOTS_BUSY_MAX_MS, SHOTS_BUSY, SHOTS_BUSY_GAVE_UP, SHOTS_VERSION_LOST, SHOTS_REFUSED, FINAL_VIDEO_CLOSED,
    type NetworkStatus, type SessionDeps, type SessionMedia, type SyncRecord, type RemoteGroup, type RemoteStep,
} from "./session";
export { uploadBlob, isAllowedUploadTarget, cloudContentType, CLOUD_MEDIA_TYPES, DEFAULT_UPLOAD_HOSTS, type UploadResult, type UploadStart } from "./upload";
export { MediaSync, createBlobMediaHost, urlKey, serverIdOf, UPLOAD_BLOCKED_STORAGE, UPLOAD_BLOCKED_POOL, UPLOAD_DAILY_LIMIT, type MediaHost, type MediaFileInfo, type MediaProgress, type BlobMediaHostOptions } from "./media";
export {
    OpenNanCloudBackend, isCloudProjectId, cloudProjectId, summaryOf, withFreshIds, formatBytes, CloudStorageFullError, CLOUD_PREFIX, SHOT_EDITS_REFUSED, SHOT_MOVES_LATER, PIN_DELAY_MS, NEW_MEDIA_CHECK_MS,
    type OpenNanCloudBackendOptions, type SaveProgress,
} from "./cloud-backend";
export { BackendRouter, CLOUD_SIGN_IN_NEEDED } from "./router";
export {
    createShare, listShares, revokeShare, stopSharing, parseShare, shareUrlOf, SHARE_DEFAULT_DAYS, SHARE_MIN_DAYS, SHARE_MAX_DAYS, SHARE_DAY_CHOICES, OPENNAN_SITE, SHARE_FALLBACK_BASE, checkShareBase,
    type ShareLink, type ShareStatus, type ShareSite, type ShareOptions,
} from "./shares";
export {
    storageFromJson, CACHE_LIMIT_CHOICES, MIN_CACHE_LIMIT_BYTES, GB, type SyncState, type ConflictItem, type StorageInfo, type CacheUsage, type MediaCacheControl,
} from "./types";
