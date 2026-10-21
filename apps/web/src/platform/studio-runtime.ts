// One backend per tab, persisted to IndexedDB (spec §7.1 "Default LocalBackend with
// IndexedDB"). Uploaded blobs come back as opennan-local:// URLs that the
// MediaEnvironment resolves to object URLs (spec §6). Screens see the backend only as
// TimelineBackend + ProjectCatalog + MediaLibraryBackend and the platform seams of
// StudioRuntime (runtime-types.ts), so the desktop app (phase 6) and a project connected
// to OpenNan (phase 8) supply their own.
import { ProviderRegistry } from "@opennan/provider-sdk";
import { DEFAULT_API_BASE, DEFAULT_CONSOLE_BASE, createOpenNanProvider } from "@opennan/provider-opennan";
import { FAL_PROVIDER_ID, createFalProvider } from "@opennan/provider-fal";
import { LocalBackend, createIndexedDbPersistence, type LocalPersistence } from "@opennan/timeline-core";
import { BackendRouter, createCloudApi, type OpenNanCloudBackend } from "@opennan/cloud-backend";
import { createCloudPlatform } from "../cloud/cloud-platform";
import { cloudUrlCheck, createWebCloudBackend, localCacheReferences } from "../cloud/web-cloud";
import { createWebMediaCache } from "../cloud/media-cache";
import { createTabLocks } from "../cloud/tab-lock";
import { hashInWorker } from "../cloud/hash";
import { createExportUpload } from "../share/share-upload";
import { removeOpfsExport } from "@opennan/export/web";
import { createBrowserMediaEnvironment } from "@opennan/timeline-media";
import { createLocalStorageMarkerStorage } from "@opennan/timeline-react";
import { connectRouting } from "../settings/routing-groups";
import { createWebProviderSettings } from "./provider-settings-web";
import { createWebAccountStorage, indexedDbKeyValue, sessionKeyValue, memoryKeyValue } from "./account-storage";
import { createWebAccount, type BrowserLike, type WebAccount } from "./account-web";
import { createWebExportPlatform } from "../export/web-export";
import { exportInputFromSnapshot } from "../export/export-input";
import { createWebMediaPreparer } from "../ai/prepare-media-web";
import { timelineAudioSources } from "@opennan/export";
import type { ControllerSnapshot } from "@opennan/timeline-core";
import { MAX_MEDIA_BYTES } from "../media/media-kind";
import { MARKER_STORAGE_PREFIX, createProjectHolds, type StudioRuntime } from "./runtime-types";
import { createStorageGuard, type StorageManagerLike } from "./storage";

export { MARKER_STORAGE_PREFIX, createProjectHolds } from "./runtime-types";
export type { StudioBackend, StudioRuntime, StudioUi } from "./runtime-types";

export const STUDIO_DB_NAME = "opennan-studio";

/**
 * The e2e build (`vite build --mode e2e`, package.json build:e2e) turns on the timeline
 * debug hooks and window.__studio for Playwright. Production builds never do, and no URL
 * parameter can switch them on.
 */
export const E2E = import.meta.env.MODE === "e2e";

/** opennan.com addresses: production everywhere but the e2e build (its fake OpenNan server, vite.config.ts). */
export const OPENNAN_API_BASE = E2E && import.meta.env.VITE_OPENNAN_API_BASE ? import.meta.env.VITE_OPENNAN_API_BASE : DEFAULT_API_BASE;
export const OPENNAN_CONSOLE_BASE = E2E && import.meta.env.VITE_OPENNAN_CONSOLE_BASE ? import.meta.env.VITE_OPENNAN_CONSOLE_BASE : DEFAULT_CONSOLE_BASE;

function safeStorage(name: "localStorage" | "sessionStorage"): Storage | null {
    try {
        return globalThis[name] ?? null;
    } catch {
        return null;
    }
}

/** The browser account over this page's window, IndexedDB, and storage. */
export function createBrowserAccount(options: { browser?: BrowserLike; fetch?: typeof globalThis.fetch } = {}): WebAccount {
    const session = safeStorage("sessionStorage");
    const storage = createWebAccountStorage({
        persistent: globalThis.indexedDB ? indexedDbKeyValue(globalThis.indexedDB) : null,
        session: session ? sessionKeyValue(session) : memoryKeyValue(),
        preferences: safeStorage("localStorage"),
    });
    return createWebAccount({
        apiBase: OPENNAN_API_BASE, consoleBase: OPENNAN_CONSOLE_BASE, storage, preferences: safeStorage("localStorage"), e2e: E2E,
        browser: options.browser ?? (window as unknown as BrowserLike),
        ...(options.fetch ? { fetch: options.fetch } : {}),
    });
}

export interface StudioRuntimeOptions {
    dbName?: string;
    /** Tests pass createMemoryPersistence(). */
    persistence?: LocalPersistence;
    /** navigator.storage by default; null for none. */
    storage?: StorageManagerLike | null;
    /** The browser account by default (tests pass one over a fake server). */
    account?: WebAccount;
    /** Builds the cloud backend for an account (tests pass one over memory stores). */
    buildCloud?(accountId: string, blobs: LocalPersistence): OpenNanCloudBackend;
}

export function createStudioRuntime(options: StudioRuntimeOptions = {}): StudioRuntime {
    const persistence = options.persistence ?? createIndexedDbPersistence({ dbName: options.dbName ?? STUDIO_DB_NAME });
    const local = new LocalBackend({ persistence });
    // OpenNan is on by default for every AI capability it offers (Settings → AI providers can change that);
    // signed out, its features stay visible and open Sign in with OpenNan.
    const account = options.account ?? createBrowserAccount();
    // Cloud projects (phase 9a): nothing is built until someone opens the Cloud tab or a cloud project.
    // Downloaded cloud media (phase 9a.1): one cache per origin under a size limit, shared by every account's backend.
    const mediaCache = createWebMediaCache({
        isAllowed: cloudUrlCheck(OPENNAN_API_BASE, E2E), fallback: persistence, localReferences: () => localCacheReferences(persistence),
        ...(options.storage === null ? { storage: null } : {}),
    });
    const tabLocks = createTabLocks();
    const cloud = createCloudPlatform({
        account, local, locks: tabLocks,
        build: (accountId, migration) => options.buildCloud?.(accountId, persistence) ?? createWebCloudBackend({
            accountId, apiBase: OPENNAN_API_BASE, apiKey: () => account.session.apiKey(), blobs: persistence, e2e: E2E, cache: mediaCache,
            ...(migration ? { migration } : {}), inUseElsewhere: (projectId) => tabLocks.inUseElsewhere(projectId),
        }),
        api: () => createCloudApi({ baseUrl: OPENNAN_API_BASE, apiKey: () => account.session.apiKey() }),
        // Export and share (phase 9c): the export's file goes up from the page with the project's id.
        uploadExport: createExportUpload({
            api: () => (account.session.apiKey() ? createCloudApi({ baseUrl: OPENNAN_API_BASE, apiKey: () => account.session.apiKey() }) : null),
            hash: (blob, signal) => hashInWorker(blob, signal), removeFile: (name) => removeOpfsExport(name),
        }),
    });
    const backend = new BackendRouter(local, () => cloud.backend());
    // e2e builds only: specs read sync states and flush through the same backend the screens use.
    if (E2E && typeof window !== "undefined") Object.assign(window, { __studioCloud: cloud });
    const media = createBrowserMediaEnvironment({ resolveLocalUrl: (url) => local.resolveLocalUrl(url) ?? cloud.resolveLocalUrl(url) });
    const markerStorage = createLocalStorageMarkerStorage(MARKER_STORAGE_PREFIX);
    const providers = new ProviderRegistry();
    // AI tools upload the clip's used range, prepared in the page (phase 11): the key and the upload stay here.
    const prepareMedia = createWebMediaPreparer({
        media,
        timelineSources: (snapshot) => timelineAudioSources(exportInputFromSnapshot(snapshot as ControllerSnapshot, [])),
    });
    providers.register(createOpenNanProvider(account.session, { prepareMedia }));
    const providerSettings = createWebProviderSettings({ preferences: safeStorage("localStorage"), storage: account.storage, keyProviders: [{ id: FAL_PROVIDER_ID, name: "fal.ai" }] });
    connectRouting(providers, providerSettings);
    // fal.ai (bring your own key) is a provider only while its key is stored.
    const syncFal = () => {
        const stored = providerSettings.keys().some((k) => k.id === FAL_PROVIDER_ID && k.set);
        if (stored && !providers.get(FAL_PROVIDER_ID)) providers.register(createFalProvider({ getKey: () => account.storage.getSecret(`provider:${FAL_PROVIDER_ID}`), prepareMedia }));
        else if (!stored && providers.get(FAL_PROVIDER_ID)) providers.unregister(FAL_PROVIDER_ID);
    };
    providerSettings.subscribe(syncFal);
    void providerSettings.ready.then(syncFal);
    return {
        platform: "web",
        backend,
        cloud,
        mediaCache,
        media,
        markerStorage,
        storage: createStorageGuard(options.storage === undefined ? globalThis.navigator?.storage : options.storage),
        exportPlatform: createWebExportPlatform(),
        providers,
        account,
        providerSettings,
        ui: {},
        maxMediaBytes: MAX_MEDIA_BYTES,
        debug: E2E || import.meta.env.DEV,
        forgetProject: (projectId) => markerStorage.save(projectId, []),
        retainProject: createProjectHolds((projectId) => backend.closeProject(projectId)),
    };
}
