// The web download cache of cloud media: each file once, in the origin private file system (OPFS
// "media-cache/<id>"), streamed to disk (never all in memory), and handed to the working copy as a local blob
// ("opennan-local://media/c-…") so playback, thumbnails and export read it like any imported file. Downloads take
// only OpenNan's storage (https; the e2e build's loopback fake too), no credentials, no redirects, at most the listed
// size. Where OPFS is missing the file goes to IndexedDB instead.
//
// Phase 9a.1: the cache keeps under a size limit (default min(5 GB, half the browser's quota), set in Settings) by
// evicting the least recently used files it downloaded, listed in "media-cache/index.json" (cloud-backend's
// MediaCacheIndex; every change is read-modify-write under the Web Lock "opennan-media-cache", so tabs never overwrite
// each other's entries). Never evicted: a file an open cloud project uses in any tab (each tab holds a shared Web Lock
// "opennan-media-pin:<id>" per pinned file), a file a local project names, a download in progress, or a file used in
// the last minute. Only "c-…" files the index lists are candidates; a local project's own files are uuids in the shared
// blob store and never touched. A re-download takes a new id, so the working copy's URL changes and its media are
// hydrated again.
import {
    CACHE_GRACE_MS, MIN_CACHE_LIMIT_BYTES, MediaCacheIndex, cacheBytes, planEviction, urlKey,
    type CacheEntry, type CacheIndexStorage, type CacheUsage, type MediaCacheControl,
} from "@opennan/cloud-backend";
import { LOCAL_MEDIA_URL_PREFIX, type LocalPersistence } from "@opennan/timeline-core";

export const CACHE_DIR = "media-cache";
export const CACHE_ID_PREFIX = "c-";
export const INDEX_FILE = "index.json";
/** The fallback (no OPFS) keeps the index as a blob in the shared blob store under this id. */
export const FALLBACK_INDEX_ID = "media-cache-index.json";
export const LIMIT_PREFERENCE = "opennan-studio:media-cache-limit";
export const INDEX_LOCK = "opennan-media-cache";
export const PIN_LOCK_PREFIX = "opennan-media-pin:";
const DEFAULT_CAP = 1024 ** 3 + 1024 ** 2;
const GB = 1024 ** 3;
/** A download left "partial" this long is a crash's leftover (no tab is still downloading it). */
const STALE_PARTIAL_MS = 24 * 3_600_000;

/** min(5 GB, half the browser's quota); 2 GB when the browser gives no estimate. */
export function defaultWebLimit(quota: number | null): number {
    if (quota === null || !Number.isFinite(quota) || quota <= 0) return 2 * GB;
    return Math.min(5 * GB, Math.floor(quota / 2));
}

type LockManagerLike = Pick<LockManager, "request"> & Partial<Pick<LockManager, "query">>;

export interface MediaCacheOptions {
    /** OpenNan's storage (and, in the e2e build only, the fake server's files). */
    isAllowed(url: string): boolean;
    fallback: Pick<LocalPersistence, "putBlob" | "getBlob" | "deleteBlob">;
    fetch?: typeof globalThis.fetch;
    storage?: StorageManager | null;
    /** navigator.locks by default; null for none (one tab's own pins and index chain only). */
    locks?: LockManagerLike | null;
    /** Where the person's limit is kept (localStorage by default). */
    preferences?: { get(key: string): string | null; set(key: string, value: string | null): void };
    /** Ids of "c-…" files local projects name (never evicted). */
    localReferences?(): Promise<Set<string>>;
    now?(): number;
    /** The random part of a new file id (tests). */
    newSuffix?(): string;
    /** The smallest limit setLimit takes (tests lower it). */
    minLimitBytes?: number;
}

export interface WebMediaCache extends MediaCacheControl {
    cache(remoteUrl: string, sizeBytes: number | null, signal: AbortSignal): Promise<string>;
    getBlob(id: string): Promise<Blob | null>;
    isCacheId(id: string): boolean;
    /** The cache files open cloud projects in this tab use (replaces the previous set). */
    setPinned(ids: string[]): void;
}

function localStoragePreferences(): NonNullable<MediaCacheOptions["preferences"]> {
    return {
        get(key) {
            try {
                return globalThis.localStorage?.getItem(key) ?? null;
            } catch {
                return null;
            }
        },
        set(key, value) {
            try {
                if (value === null) globalThis.localStorage?.removeItem(key);
                else globalThis.localStorage?.setItem(key, value);
            } catch {
                // private mode: the default applies next time
            }
        },
    };
}

async function directory(storage: StorageManager | null | undefined): Promise<FileSystemDirectoryHandle | null> {
    try {
        if (!storage?.getDirectory) return null;
        return await (await storage.getDirectory()).getDirectoryHandle(CACHE_DIR, { create: true });
    } catch {
        return null;
    }
}

function randomSuffix(): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createWebMediaCache(options: MediaCacheOptions): WebMediaCache {
    const storage = options.storage === undefined ? globalThis.navigator?.storage ?? null : options.storage;
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const locks = options.locks === undefined ? (globalThis.navigator?.locks ?? null) : options.locks;
    const preferences = options.preferences ?? localStoragePreferences();
    const now = options.now ?? Date.now;
    const newSuffix = options.newSuffix ?? randomSuffix;
    const minLimit = options.minLimitBytes ?? MIN_CACHE_LIMIT_BYTES;
    let dir: Promise<FileSystemDirectoryHandle | null> | null = null;
    const cacheDir = () => (dir ??= directory(storage));
    let persistAsked = false;
    const inFlight = new Map<string, Promise<string>>();
    const pinned = new Set<string>();
    /** Pin locks asked for and not given back yet (granted or not), and how to give a granted one back. */
    const pinRequested = new Set<string>();
    const pinReleases = new Map<string, () => void>();
    function requestPin(id: string): void {
        if (!locks || pinRequested.has(id)) return;
        pinRequested.add(id);
        // Held while this tab uses the file: other tabs' evictions see it, and it dies with the tab. A pin dropped
        // before the lock is granted gives it back at once.
        void locks.request(`${PIN_LOCK_PREFIX}${id}`, { mode: "shared" }, () => {
            if (!pinned.has(id)) return Promise.resolve();
            return new Promise<void>((resolve) => pinReleases.set(id, resolve));
        }).catch(() => undefined).finally(() => {
            pinRequested.delete(id);
            pinReleases.delete(id);
            // Pinned again while the lock was being given back.
            if (pinned.has(id)) requestPin(id);
        });
    }

    // ── the index (OPFS file, or a blob in the fallback store) ──

    const indexStorage: CacheIndexStorage = {
        async read() {
            try {
                const d = await cacheDir();
                const file = d ? await (await d.getFileHandle(INDEX_FILE)).getFile() : await options.fallback.getBlob(FALLBACK_INDEX_ID);
                return file ? JSON.parse(await file.text()) : null;
            } catch {
                return null;
            }
        },
        async write(file) {
            const text = JSON.stringify(file);
            const d = await cacheDir();
            if (!d) {
                await options.fallback.putBlob(FALLBACK_INDEX_ID, new Blob([text], { type: "application/json" }));
                return;
            }
            // createWritable commits on close only: a crash leaves the old index.
            const writable = await (await d.getFileHandle(INDEX_FILE, { create: true })).createWritable();
            try {
                await writable.write(text);
                await writable.close();
            } catch (error) {
                await writable.abort().catch(() => undefined);
                throw error;
            }
        },
        ...(locks ? { lock: <T>(run: () => Promise<T>) => locks.request(INDEX_LOCK, () => run()) as Promise<T> } : {}),
    };
    const index = new MediaCacheIndex(indexStorage, { now });
    // Every change this tab makes drops the shared read of the index (lookup below).
    let dropSnapshot = () => undefined as void;
    const update = <T>(fn: (entries: Map<string, CacheEntry>) => T | Promise<T>): Promise<T> => index.update(fn).finally(() => dropSnapshot());

    async function fileOf(id: string): Promise<Blob | null> {
        const d = await cacheDir();
        if (d) {
            try {
                return await (await d.getFileHandle(id)).getFile();
            } catch {
                return null;
            }
        }
        return options.fallback.getBlob(id);
    }

    async function removeFile(id: string): Promise<void> {
        const d = await cacheDir();
        if (d) await d.removeEntry(id).catch(() => undefined);
        else await options.fallback.deleteBlob?.(id);
    }

    // Reconciles the index with the files once per page: entries whose file is gone are dropped, stale half downloads
    // are removed, 9a files (no index then) are adopted as the oldest entries.
    let reconciled: Promise<void> | null = null;
    const ready = () => (reconciled ??= (async () => {
        const d = await cacheDir();
        const names = new Set<string>();
        if (d) for await (const name of (d as unknown as { keys(): AsyncIterable<string> }).keys()) names.add(name);
        await update(async (entries) => {
            for (const entry of [...entries.values()]) {
                if (entry.state === "partial") {
                    if (now() - entry.lastUsed > STALE_PARTIAL_MS) {
                        await removeFile(entry.id);
                        entries.delete(entry.id);
                    }
                    continue;
                }
                if (!(await fileOf(entry.id))) entries.delete(entry.id);
            }
            for (const name of names) {
                if (name === INDEX_FILE || entries.has(name)) continue;
                const file = await fileOf(name);
                if (!file) continue;
                // A 9a file (no index then): adopted as the oldest entry.
                if (/^c-[0-9a-f]{16}-\d+$/.test(name)) {
                    if (file.size > 0) entries.set(name, { id: name, url: "", sizeBytes: file.size, lastUsed: 0, state: "ready" });
                    continue;
                }
                // A file of ours left without its entry (a clean-up that failed) for a day: removed. Recent ones are left
                // alone (another tab's download records its entry first, so this is only a safety margin).
                if (/^c-[0-9a-f]{16}-\d+-[0-9a-f]{8}$/.test(name) && Date.now() - ((file as File).lastModified ?? Date.now()) > STALE_PARTIAL_MS) await removeFile(name);
            }
        });
    })().catch(() => {
        reconciled = null;
    }));

    // ── limits ──

    async function quota(): Promise<number | null> {
        try {
            const estimate = await storage?.estimate?.();
            return typeof estimate?.quota === "number" ? estimate.quota : null;
        } catch {
            return null;
        }
    }

    async function limits(): Promise<{ limit: number; defaultLimit: number; max: number | null; custom: boolean }> {
        const q = await quota();
        const defaultLimit = defaultWebLimit(q);
        const max = q !== null && q > 0 ? Math.floor(q * 0.8) : null;
        const stored = Number(preferences.get(LIMIT_PREFERENCE));
        const custom = Number.isFinite(stored) && stored >= minLimit && (max === null || stored <= max);
        return { limit: custom ? stored : defaultLimit, defaultLimit, max, custom };
    }

    // ── pins ──

    /** Files open cloud projects use in any tab (this tab's pins and every tab's pin locks). */
    async function pinnedEverywhere(): Promise<Set<string>> {
        const all = new Set(pinned);
        try {
            const state = await locks?.query?.();
            for (const lock of state?.held ?? []) if (lock.name?.startsWith(PIN_LOCK_PREFIX)) all.add(lock.name.slice(PIN_LOCK_PREFIX.length));
        } catch {
            // only this tab's pins
        }
        return all;
    }

    /** Pins plus files local projects name; null when local projects can't be read (then nothing is evicted). */
    async function keptFiles(): Promise<Set<string> | null> {
        const all = await pinnedEverywhere();
        try {
            for (const id of (await options.localReferences?.()) ?? []) all.add(id);
        } catch {
            return null;
        }
        return all;
    }

    /** Evicts least recently used files until the cache (plus a coming download) fits; returns the bytes freed. */
    async function enforce(request: { incomingBytes?: number; all?: boolean; keep?: string } = {}): Promise<number> {
        await ready();
        await index.flushTouches().catch(() => undefined);
        const { limit } = await limits();
        // Under the limit nothing goes: no need to read every local project for its references.
        if (!request.all && cacheBytes(await index.entries()) + (request.incomingBytes ?? 0) <= limit) return 0;
        const keep = await keptFiles();
        if (!keep) return 0;
        return update(async (entries) => {
            const victims = planEviction([...entries.values()], {
                limitBytes: request.all ? 0 : limit, incomingBytes: request.incomingBytes ?? 0, now: now(), graceMs: CACHE_GRACE_MS, all: request.all ?? false,
                isPinned: (entry) => keep.has(entry.id) || entry.id === request.keep,
            });
            let freed = 0;
            for (const victim of victims) {
                // Only the cache's own files: "c-…" ids the index lists (a local project's files are never here).
                if (!victim.id.startsWith(CACHE_ID_PREFIX)) {
                    entries.delete(victim.id);
                    continue;
                }
                await removeFile(victim.id);
                entries.delete(victim.id);
                freed += victim.sizeBytes;
            }
            return freed;
        });
    }

    // ── downloads ──

    async function download(remoteUrl: string, id: string, sizeBytes: number | null, signal: AbortSignal): Promise<number> {
        const cap = sizeBytes ? sizeBytes + 1024 ** 2 : DEFAULT_CAP;
        const response = await doFetch(remoteUrl, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal });
        if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}.`);
        const declared = Number(response.headers.get("content-length") ?? NaN);
        if (Number.isFinite(declared) && declared > cap) {
            await response.body.cancel().catch(() => undefined);
            throw new Error("The download is larger than the file OpenNan listed.");
        }
        const d = await cacheDir();
        const reader = response.body.getReader();
        let total = 0;
        if (d) {
            // Written straight to its final name: createWritable commits on close, so a half download never shows.
            const writable = await (await d.getFileHandle(id, { create: true })).createWritable();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > cap) throw new Error("The download is larger than the file OpenNan listed.");
                    await writable.write(value);
                }
                await writable.close();
            } catch (error) {
                await writable.abort().catch(() => undefined);
                await d.removeEntry(id).catch(() => undefined);
                throw error;
            }
            return total;
        }
        const chunks: Uint8Array[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > cap) throw new Error("The download is larger than the file OpenNan listed.");
            chunks.push(value);
        }
        const type = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
        await options.fallback.putBlob(id, new Blob(chunks as BlobPart[], { type }));
        return total;
    }

    // A project opening asks for each of its files at once: they share one read of the index (dropped after a moment
    // and whenever this tab changes the index).
    let snapshot: { at: number; entries: Promise<CacheEntry[]> } | null = null;
    const SNAPSHOT_MS = 1_000;
    dropSnapshot = () => {
        snapshot = null;
    };
    const entriesSoon = () => {
        const at = Date.now();
        if (!snapshot || at - snapshot.at > SNAPSHOT_MS) snapshot = { at, entries: index.entries() };
        return snapshot.entries;
    };

    async function lookup(remoteUrl: string): Promise<CacheEntry | null> {
        const entries = await entriesSoon();
        const found = entries.filter((e) => e.url === remoteUrl && e.state === "ready").sort((a, b) => b.lastUsed - a.lastUsed);
        for (const entry of found) if (await fileOf(entry.id)) return entry;
        // A 9a file (named by its URL's key) the index does not list with its URL yet.
        const legacy = `${CACHE_ID_PREFIX}${urlKey(remoteUrl).slice(2)}`;
        const file = await fileOf(legacy);
        if (!file || file.size === 0) return null;
        return update((all) => {
            const entry: CacheEntry = { ...(all.get(legacy) ?? { id: legacy, sizeBytes: file.size, state: "ready" as const }), url: remoteUrl, lastUsed: now() };
            all.set(legacy, entry);
            return entry;
        });
    }

    async function fetchInto(remoteUrl: string, sizeBytes: number | null, signal: AbortSignal): Promise<string> {
        await ready();
        const known = await lookup(remoteUrl);
        if (known) {
            index.touch(known.id);
            return `${LOCAL_MEDIA_URL_PREFIX}${known.id}`;
        }
        if (!options.isAllowed(remoteUrl)) throw new Error("Studio only downloads media from OpenNan's storage.");
        if (!persistAsked) {
            persistAsked = true;
            void storage?.persist?.().catch(() => false);
        }
        await enforce({ incomingBytes: sizeBytes ?? 0 }).catch(() => 0);
        const id = `${CACHE_ID_PREFIX}${urlKey(remoteUrl).slice(2)}-${newSuffix()}`;
        // Reserved first: another tab's reconcile sees a download in progress, a crash leaves a stale entry to remove.
        await update((entries) => {
            entries.set(id, { id, url: remoteUrl, sizeBytes: sizeBytes ?? 0, lastUsed: now(), state: "partial" });
        });
        let size: number;
        try {
            size = await download(remoteUrl, id, sizeBytes, signal);
        } catch (error) {
            await update((entries) => {
                entries.delete(id);
            }).catch(() => undefined);
            throw error;
        }
        await update((entries) => {
            entries.set(id, { id, url: remoteUrl, sizeBytes: size, lastUsed: now(), state: "ready" });
        });
        await enforce({ keep: id }).catch(() => 0);
        return `${LOCAL_MEDIA_URL_PREFIX}${id}`;
    }

    async function usage(): Promise<CacheUsage> {
        await ready();
        await index.flushTouches().catch(() => undefined);
        const entries = (await index.entries()).filter((e) => e.state === "ready");
        const pins = await pinnedEverywhere();
        const { limit, defaultLimit, max, custom } = await limits();
        return {
            usedBytes: cacheBytes(entries), entries: entries.length, limitBytes: limit, defaultLimitBytes: defaultLimit, maxLimitBytes: max,
            pinnedBytes: cacheBytes(entries.filter((e) => pins.has(e.id))), custom,
        };
    }

    return {
        isCacheId: (id) => id.startsWith(CACHE_ID_PREFIX),
        getBlob: (id) => fileOf(id),
        cache(remoteUrl, sizeBytes, signal) {
            let pending = inFlight.get(remoteUrl);
            if (!pending) {
                pending = fetchInto(remoteUrl, sizeBytes, signal).finally(() => inFlight.delete(remoteUrl));
                inFlight.set(remoteUrl, pending);
            }
            return pending;
        },
        setPinned(ids) {
            const next = new Set(ids.filter((id) => id.startsWith(CACHE_ID_PREFIX)));
            for (const id of [...pinned]) {
                if (next.has(id)) continue;
                pinned.delete(id);
                pinReleases.get(id)?.();
            }
            for (const id of next) {
                if (pinned.has(id)) continue;
                pinned.add(id);
                requestPin(id);
            }
        },
        usage,
        async setLimit(bytes) {
            if (bytes !== null) {
                const { max } = await limits();
                if (!Number.isInteger(bytes) || bytes < minLimit || (max !== null && bytes > max)) throw new Error("This cache size isn't available on this device.");
            }
            preferences.set(LIMIT_PREFERENCE, bytes === null ? null : String(bytes));
            await enforce();
            return usage();
        },
        async clear() {
            const freedBytes = await enforce({ all: true });
            return { freedBytes, keptBytes: (await usage()).usedBytes };
        },
    };
}
