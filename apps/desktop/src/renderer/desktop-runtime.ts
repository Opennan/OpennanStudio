// The desktop StudioRuntime for the @opennan/web editor shell: SQLite-backed LocalBackend over IPC, the
// desktop media policy, main-process export, and the desktop UI add-ons. OpenNan cloud projects (phase 9a): the
// backend is a BackendRouter that sends "cloud-" project ids to the signed-in account's cloud backend (built on first
// use over the bridge, desktop-cloud.ts) and every other id to the local backend, which never touches the network.
// Phase 9a.1: the storage meter reads through main's proxy without a backend, a backend keyed by the account id moves
// the email store's records first, and Settings controls main's cloud media cache (runtime.mediaCache).
import { BackendRouter, type MediaCacheControl, type OpenNanCloudBackend } from "@opennan/cloud-backend";
import { createLocalStorageMarkerStorage } from "@opennan/timeline-react";
import {
    MARKER_STORAGE_PREFIX, connectRouting, createCloudPlatform, createProjectHolds, createStorageGuard, memoryProviderSettings, signedOutAccount,
    type AccountPlatform, type ExportPlatform, type ProviderPlatform, type StudioRuntime, type StudioUi,
} from "@opennan/web/studio";
import type { ProviderCapability, ProviderRegistry } from "@opennan/provider-sdk";
import type { DesktopBridge } from "../shared/bridge";
import { DesktopBackend } from "./desktop-backend";
import { createDesktopCloudBackend, createDesktopExportUpload, createProxyCloudApi, unwrap } from "./desktop-cloud";
import { createIpcPersistence } from "./ipc-persistence";
import { createDesktopMediaEnvironment } from "./media-environment";

/** Desktop imports have no browser limit; this only guards against absurd sizes. */
export const DESKTOP_MAX_MEDIA_BYTES = 64 * 1024 ** 3;

export interface DesktopRuntimeOptions {
    appOrigin: string;
    ui: StudioUi;
    exportPlatform: ExportPlatform;
    providers: ProviderRegistry;
    account?: AccountPlatform;
    providerSettings?: ProviderPlatform;
    capabilityNote?(capability: ProviderCapability): string | null;
    /** Builds the cloud backend for an account (tests); default over the bridge. */
    buildCloud?(accountId: string): OpenNanCloudBackend;
}

/** Main's cloud media cache (Settings → Cloud media on this device). */
export function desktopMediaCache(bridge: Pick<DesktopBridge, "cloud">): MediaCacheControl {
    return {
        usage: () => unwrap(() => bridge.cloud.cacheUsage()),
        setLimit: (bytes) => unwrap(() => bridge.cloud.cacheSetLimit(bytes)),
        clear: () => unwrap(() => bridge.cloud.cacheClear()),
    };
}

export function createDesktopRuntime(bridge: DesktopBridge, options: DesktopRuntimeOptions): StudioRuntime {
    const local = new DesktopBackend({ persistence: createIpcPersistence(bridge) }, bridge);
    const account = options.account ?? signedOutAccount();
    // Nothing about the cloud runs until someone opens the Cloud tab or a cloud project.
    const cloud = createCloudPlatform({
        account, local,
        build: (accountId, migration) => options.buildCloud?.(accountId) ?? createDesktopCloudBackend(bridge, accountId, migration ? { migration } : {}),
        api: () => createProxyCloudApi(bridge),
        // Export and share (phase 9c): main uploads the video it exported.
        uploadExport: createDesktopExportUpload(bridge),
        // Its API is a proxy through main: share links on the e2e fake's loopback are accepted in e2e runs only (9c.1).
        ...(bridge.e2e ? { loopbackShares: true } : {}),
    });
    const backend = new BackendRouter(local, () => cloud.backend());
    // The e2e build's handle on the cloud seam (as the web e2e build's), for Playwright specs only.
    if (bridge.e2e && typeof window !== "undefined") Object.assign(window, { __studioCloud: cloud });
    const markerStorage = createLocalStorageMarkerStorage(MARKER_STORAGE_PREFIX);
    const providerSettings = options.providerSettings ?? memoryProviderSettings();
    connectRouting(options.providers, providerSettings);
    return {
        platform: "desktop",
        backend,
        cloud,
        media: createDesktopMediaEnvironment(options.appOrigin),
        markerStorage,
        // Projects live in a database on disk: nothing for the browser to evict.
        storage: createStorageGuard({ persisted: async () => true, persist: async () => true }),
        exportPlatform: options.exportPlatform,
        providers: options.providers,
        account,
        providerSettings,
        mediaCache: desktopMediaCache(bridge),
        ...(options.capabilityNote ? { capabilityNote: options.capabilityNote } : {}),
        ui: options.ui,
        maxMediaBytes: DESKTOP_MAX_MEDIA_BYTES,
        debug: bridge.e2e,
        forgetProject: (projectId) => markerStorage.save(projectId, []),
        retainProject: createProjectHolds((projectId) => backend.closeProject(projectId)),
    };
}
