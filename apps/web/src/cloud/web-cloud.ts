// The web app's cloud backend for one account: IndexedDB for the queue and working copies, the existing
// "opennan-studio" blob store for media (local projects and cloud working copies share it, so Save to OpenNan moves
// nothing on disk), OPFS for downloaded cloud media, a Worker for hashing, and the page's OpenNan key.
import {
    OpenNanCloudBackend, createBlobMediaHost, createCloudApi, migratingStore, type CloudStore, type MediaHost, type NetworkStatus,
} from "@opennan/cloud-backend";
import { webDeviceName } from "@opennan/provider-opennan";
import { LocalBackend, type LocalPersistence, type LocalProjectState } from "@opennan/timeline-core";
import { hashInWorker } from "./hash";
import { createIdbCloudStore } from "./idb-store";
import { CACHE_ID_PREFIX, createWebMediaCache, type WebMediaCache } from "./media-cache";
import type { CloudMigration } from "./cloud-platform";

export const PRODUCTION_CDN = "https://cdn.opennan.com/";

/** OpenNan's storage, never a temporary upload; the e2e build adds its fake server's files. */
export function cloudUrlCheck(apiBase: string, e2e: boolean): (url: string) => boolean {
    const fake = e2e ? `${apiBase.replace(/\/+$/, "")}/files/` : null;
    return (url) => (url.startsWith(PRODUCTION_CDN) || (fake !== null && url.startsWith(fake))) && !url.includes("/uploads/temp/");
}

/** navigator.onLine with its events, and page visibility. */
export function browserNetwork(): NetworkStatus {
    return {
        online: () => globalThis.navigator?.onLine !== false,
        visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
        subscribe(listener) {
            if (typeof window === "undefined") return () => undefined;
            window.addEventListener("online", listener);
            window.addEventListener("offline", listener);
            document.addEventListener("visibilitychange", listener);
            return () => {
                window.removeEventListener("online", listener);
                window.removeEventListener("offline", listener);
                document.removeEventListener("visibilitychange", listener);
            };
        },
    };
}

/** The working copies' persistence: documents in the cloud store, media in the shared blob store (or the cache). */
export function mirrorPersistence(store: CloudStore, blobs: LocalPersistence, cache: { isCacheId(id: string): boolean; getBlob(id: string): Promise<Blob | null> }): LocalPersistence {
    return {
        loadProject: (projectId) => store.get<LocalProjectState>("mirror", projectId),
        saveProject: (projectId, state) => store.put("mirror", projectId, state),
        async listProjects() {
            const out: LocalProjectState[] = [];
            for (const key of await store.keys("mirror")) {
                const state = await store.get<LocalProjectState>("mirror", key);
                if (state) out.push(state);
            }
            return out;
        },
        deleteProject: (projectId) => store.delete("mirror", projectId),
        putBlob: (id, blob) => blobs.putBlob(id, blob),
        getBlob: (id) => (cache.isCacheId(id) ? cache.getBlob(id) : blobs.getBlob(id)),
        // Media of a working copy may be a local project's too: it is removed with the project that owns it.
        deleteBlob: async () => undefined,
    };
}

export interface WebCloudOptions {
    accountId: string;
    apiBase: string;
    apiKey(): string | null;
    /** The local projects' persistence (its blob store is shared). */
    blobs: LocalPersistence;
    e2e: boolean;
    indexedDB?: IDBFactory;
    fetch?: typeof globalThis.fetch;
    store?: CloudStore;
    network?: NetworkStatus;
    storage?: StorageManager | null;
    deviceName?: string;
    /** The origin's download cache (one for every account; studio-runtime.ts makes it). */
    cache?: WebMediaCache;
    /** Move this account's records from its email store first (9a.1). */
    migration?: CloudMigration;
    /** A cloud project another tab has open (its records stay in the email store until it is free). */
    inUseElsewhere?(projectId: string): Promise<boolean>;
}

/** The "c-…" cache ids local projects name (the cache never evicts them). */
export async function localCacheReferences(persistence: Pick<LocalPersistence, "listProjects">): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!persistence.listProjects) return ids;
    for (const state of await persistence.listProjects()) {
        for (const match of JSON.stringify(state).matchAll(/opennan-local:\/\/media\/(c-[A-Za-z0-9._-]+)/g)) ids.add(match[1]!);
    }
    return ids;
}

/** The local URLs a project pins → the cache ids among them. */
export function pinnedCacheIds(urls: string[]): string[] {
    const prefix = `opennan-local://media/${CACHE_ID_PREFIX}`;
    return urls.filter((url) => url.startsWith(prefix)).map((url) => url.slice("opennan-local://media/".length));
}

export function createWebCloudBackend(options: WebCloudOptions): OpenNanCloudBackend {
    const idb = options.indexedDB ?? globalThis.indexedDB;
    const logger = { warn: (...args: unknown[]) => console.warn(...args) };
    const inUse = options.inUseElsewhere;
    const store = options.store ?? migratingStore(createIdbCloudStore(options.accountId, idb), options.migration ? createIdbCloudStore(options.migration.from, idb) : null, {
        ...(options.migration ? { waitFor: options.migration.waitFor } : {}), logger,
        // A tab still on the email key keeps its open project's queue and working copy until it lets go of them.
        ...(inUse ? { skip: async (namespace: string, key: string) => (namespace === "sync" || namespace === "mirror" || namespace === "snapshots") && key.startsWith("cloud-") && inUse(key) } : {}),
    });
    const isCloudUrl = cloudUrlCheck(options.apiBase, options.e2e);
    const api = createCloudApi({ baseUrl: options.apiBase, apiKey: options.apiKey, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const cache = options.cache ?? createWebMediaCache({
        isAllowed: isCloudUrl, fallback: options.blobs, localReferences: () => localCacheReferences(options.blobs),
        ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.storage !== undefined ? { storage: options.storage } : {}),
    });
    const mirror = new LocalBackend({ persistence: mirrorPersistence(store, options.blobs, cache) });
    const kind = (type: string): "video" | "image" | "audio" => (type.startsWith("video/") ? "video" : type.startsWith("image/") ? "image" : "audio");
    const media: MediaHost = createBlobMediaHost({
        api,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        readBlob: (url) => mirror.readMedia(url) as Promise<(Blob & { name?: string }) | null>,
        hash: (blob, signal) => hashInWorker(blob, signal),
        cache: (url, size, signal) => cache.cache(url, size, signal),
        pin: (urls) => cache.setPinned(pinnedCacheIds(urls)),
        async copyToLocal(url, target, projectId, signal) {
            const local = isCloudUrl(url) ? await cache.cache(url, null, signal ?? new AbortController().signal) : url;
            const blob = await mirror.readMedia(local);
            if (!blob) throw new Error("This media file is not on this device.");
            return (await target.uploadFile(projectId, blob, kind(blob.type))).url;
        },
        ...(options.e2e ? { allowedHosts: ["upload.opennan.com", "*.r2.cloudflarestorage.com"] } : {}),
    });
    return new OpenNanCloudBackend({
        api, store, mirror, media, isCloudUrl,
        deviceName: options.deviceName ?? webDeviceName(globalThis.navigator?.userAgent ?? ""),
        network: options.network ?? browserNetwork(),
        logger,
    });
}
