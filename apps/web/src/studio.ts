// @opennan/web/studio: the editor shell for other hosts (apps/desktop). Nothing reachable from here imports
// the ffmpeg.wasm export or the IndexedDB runtime (studio.test.ts); hosts bring a StudioRuntime.
export { App as StudioApp } from "./app";
export { MARKER_STORAGE_PREFIX, createProjectHolds } from "./platform/runtime-types";
export type { StudioBackend, StudioRuntime, StudioUi } from "./platform/runtime-types";
export type { ExportCommandHandler, ExportDelivery, ExportEnginePreview, ExportPlatform, ExportSessionView, PlatformExporter } from "./platform/export-platform";
export { createStorageGuard, type PersistState, type StorageGuard, type StorageManagerLike } from "./platform/storage";
export { exportFileNameFor, exportFormatLabel, exportInputFromSnapshot, loadEffectCatalog } from "./export/export-input";
export { useStudioRuntime } from "./platform/runtime-context";
export {
    DEFAULT_ROUTING, memoryProviderSettings, signedOutAccount,
    type AccountPlatform, type ConsolePage, type ProviderKeyId, type ProviderPlatform, type ProviderRouting,
} from "./account/account-types";
export { applyRouting, connectRouting, parseRouting, ROUTING_GROUPS, CAPABILITY_LABELS } from "./settings/routing-groups";
export { Dialog } from "./ui/dialog";
