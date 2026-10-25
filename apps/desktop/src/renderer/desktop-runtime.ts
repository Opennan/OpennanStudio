// The desktop StudioRuntime for the @opennan/web editor shell: SQLite-backed LocalBackend over IPC, the
// desktop media policy, main-process export, and the desktop UI add-ons. Projects stay on this computer.
import { createLocalStorageMarkerStorage } from "@opennan/timeline-react";
import {
    MARKER_STORAGE_PREFIX, connectRouting, createProjectHolds, createStorageGuard, memoryProviderSettings, signedOutAccount,
    type AccountPlatform, type ExportPlatform, type ProviderPlatform, type StudioRuntime, type StudioUi,
} from "@opennan/web/studio";
import type { ProviderCapability, ProviderRegistry } from "@opennan/provider-sdk";
import type { DesktopBridge } from "../shared/bridge";
import { DesktopBackend } from "./desktop-backend";
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
}

export function createDesktopRuntime(bridge: DesktopBridge, options: DesktopRuntimeOptions): StudioRuntime {
    const backend = new DesktopBackend({ persistence: createIpcPersistence(bridge) }, bridge);
    const account = options.account ?? signedOutAccount();
    const markerStorage = createLocalStorageMarkerStorage(MARKER_STORAGE_PREFIX);
    const providerSettings = options.providerSettings ?? memoryProviderSettings();
    connectRouting(options.providers, providerSettings);
    return {
        platform: "desktop",
        backend,
        media: createDesktopMediaEnvironment(options.appOrigin),
        markerStorage,
        // Projects live in a database on disk: nothing for the browser to evict.
        storage: createStorageGuard({ persisted: async () => true, persist: async () => true }),
        exportPlatform: options.exportPlatform,
        providers: options.providers,
        account,
        providerSettings,
        ...(options.capabilityNote ? { capabilityNote: options.capabilityNote } : {}),
        ui: options.ui,
        maxMediaBytes: DESKTOP_MAX_MEDIA_BYTES,
        debug: bridge.e2e,
        forgetProject: (projectId) => markerStorage.save(projectId, []),
        retainProject: createProjectHolds((projectId) => backend.closeProject(projectId)),
    };
}
