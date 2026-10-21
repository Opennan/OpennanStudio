// Media of cloud projects, per account: local files go up (hashed, deduplicated, uploaded by the host — in the page
// on the web, in main on desktop), cloud files come down into the host's cache, and the URL map between the two is
// kept on disk so a retry, a restart, or another project never uploads a file twice. Upload refusals become states:
// storage full and the free pool full pause uploads (edits keep syncing), the daily limit waits for its Retry-After,
// a gateway or network failure retries with backoff.
import { CloudApiError, isAbortError, isCloudApiError, type CloudApi } from "./api";
import type { Clock } from "./clock";
import { LOCAL_URL_PREFIX, type UrlMap } from "./codec";
import { hashBlob } from "./sha256";
import type { CloudStore } from "./store";
import { cloudContentType, uploadBlob, type UploadResult } from "./upload";

export interface MediaFileInfo {
    filename: string;
    contentType: string;
    sizeBytes: number;
}

export interface MediaHost {
    /** Name, type and size of the file behind a local media URL (null: no such file on this device). */
    describe(localUrl: string): Promise<MediaFileInfo | null>;
    /** Hashes and uploads the file behind a local media URL (with the project's server id, or none). */
    upload(localUrl: string, serverProjectId: string | null, signal: AbortSignal, onProgress?: (sent: number) => void): Promise<UploadResult>;
    /**
     * Downloads a cloud media file into the cache. Returns the local URL to use in the working copy when the host
     * rewrites URLs (desktop: a media-store file), or null when it resolves cloud URLs itself (web: OPFS).
     */
    cache?(remoteUrl: string, sizeBytes: number | null, signal: AbortSignal): Promise<string | null>;
    /**
     * The local cache URLs open cloud projects use now (replaces the previous set): the host never evicts them
     * (phase 9a.1). Hosts without a cache limit leave this out.
     */
    pin?(localUrls: string[]): void;
    /** Copies the media behind a URL (local or cloud) into a local project; returns its new local URL. */
    copyToLocal?(url: string, target: { uploadFile(projectId: string, file: Blob, kind: "video" | "image" | "audio"): Promise<{ url: string }> }, projectId: string, signal?: AbortSignal): Promise<string>;
}

export interface MediaProgress {
    uploading: number;
    uploaded: number;
    blocked: null | "storage" | "pool-full";
    /** Studio's words for what holds uploads back (daily limit, a refused file), or null. */
    message: string | null;
}

interface UrlRecord {
    local: string;
    remote: string;
    assetId?: string;
    sha256?: string;
    sizeBytes?: number;
    contentType?: string;
    /** A downloaded copy of the remote file (the host's cache may evict it), not this device's original. */
    cache?: true;
    /** An evicted copy: its local URL still encodes to the remote (an old working copy names it), never decodes to it. */
    stale?: true;
}

/** Cache records, and 9a's (which had no flag but never an asset id: only uploads know theirs). */
function isCacheRecord(record: UrlRecord): boolean {
    return record.cache === true || !record.assetId;
}

export interface MediaSyncOptions {
    host: MediaHost;
    store: CloudStore;
    clock: Clock;
    isCloudUrl(url: string): boolean;
    /** Uploads at once (default 2). */
    concurrency?: number;
    logger?: { warn(...args: unknown[]): void };
}

export const UPLOAD_BLOCKED_STORAGE = "Your OpenNan cloud storage is full. Edits still sync; new media can't upload. More storage is coming soon.";
export const UPLOAD_BLOCKED_POOL = "OpenNan cloud storage is busy right now. Edits still sync; new media will upload later.";
export const UPLOAD_DAILY_LIMIT = "You reached today's upload limit. New media will upload tomorrow.";

/** A short stable key for a URL (store keys can't hold URLs). */
export function urlKey(url: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < url.length; i++) {
        const c = url.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return `u-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}-${url.length}`;
}

export function serverIdOf(projectId: string): string {
    return projectId.startsWith("cloud-") ? projectId.slice("cloud-".length) : projectId;
}

type Listener = (mapping: Array<{ local: string; remote: string }>) => void;

export class MediaSync {
    readonly urls: UrlMap;
    private readonly toRemote = new Map<string, UrlRecord>();
    private readonly toLocal = new Map<string, UrlRecord>();
    private readonly queue: Array<{ local: string; projectId: string }> = [];
    private readonly active = new Map<string, AbortController>();
    private readonly downloads = new Map<string, Promise<void>>();
    private readonly failed = new Map<string, string>();
    private readonly listeners = new Set<Listener>();
    private readonly progressListeners = new Set<() => void>();
    private uploadedCount = 0;
    private blocked: MediaProgress["blocked"] = null;
    private message: string | null = null;
    private pausedUntil = 0;
    /** Uploads wait for a sign-in (a 401): retry() goes on. */
    private signedOut = false;
    private retryTimer: unknown = null;
    private unblockTimer: unknown = null;
    private failures = 0;
    private loaded: Promise<void> | null = null;

    constructor(private readonly options: MediaSyncOptions) {
        const ignoredHosts = new Set<string>();
        this.urls = {
            isCloudUrl: (url) => options.isCloudUrl(url),
            toRemote: (url) => this.toRemote.get(url)?.remote,
            toLocal: (url) => this.toLocal.get(url)?.local,
            // A storyboard file from another host is never shown or downloaded (9c.1): one quiet line per host, never the URL.
            ignored: (url) => {
                let host = "(not a URL)";
                try {
                    host = new URL(url).host || host;
                } catch {
                    // not a URL
                }
                if (ignoredHosts.has(host) || ignoredHosts.size >= 50) return;
                ignoredHosts.add(host);
                options.logger?.warn(`[cloud] ignored a storyboard file that is not on OpenNan's storage: ${host}`);
            },
        };
    }

    load(): Promise<void> {
        this.loaded ??= this.readAll();
        return this.loaded;
    }

    /**
     * Reads the URL map again (a project opening): another tab sharing this store may have uploaded or downloaded files
     * since, and a working copy it saved names them.
     */
    async refresh(): Promise<void> {
        await this.load();
        await this.readAll();
    }

    private async readAll(): Promise<void> {
        for (const key of await this.options.store.keys("urls")) {
            const record = await this.options.store.get<UrlRecord>("urls", key);
            if (record) this.remember(record);
        }
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onProgress(listener: () => void): () => void {
        this.progressListeners.add(listener);
        return () => this.progressListeners.delete(listener);
    }

    progress(): MediaProgress {
        return { uploading: this.queue.length + this.active.size, uploaded: this.uploadedCount, blocked: this.blocked, message: this.message };
    }

    /** Local media URLs a project uses: any without an upload yet is queued. */
    want(projectId: string, urls: Iterable<string>): void {
        let added = false;
        for (const url of urls) {
            if (!url.startsWith(LOCAL_URL_PREFIX) || this.toRemote.has(url) || this.active.has(url) || this.failed.has(url)) continue;
            if (this.queue.some((job) => job.local === url)) continue;
            this.queue.push({ local: url, projectId });
            added = true;
        }
        if (added) {
            this.emitProgress();
            this.pump();
        }
    }

    /** An upload recorded elsewhere (Save to OpenNan uploads before the project exists). */
    async record(local: string, result: UploadResult): Promise<void> {
        const record: UrlRecord = { local, remote: result.mediaUrl, assetId: result.assetId, sha256: result.sha256, sizeBytes: result.sizeBytes, contentType: result.contentType };
        this.remember(record);
        await this.options.store.put("urls", urlKey(local), record);
        this.emit([{ local, remote: result.mediaUrl }]);
    }

    /** Uploading a file now (Save to OpenNan), outside the queue, with its own progress. */
    async uploadNow(local: string, serverProjectId: string | null, signal: AbortSignal, onProgress?: (sent: number) => void): Promise<UploadResult> {
        await this.load();
        const known = this.toRemote.get(local);
        if (known?.assetId) return { assetId: known.assetId, mediaUrl: known.remote, contentType: known.contentType ?? "", sizeBytes: known.sizeBytes ?? 0, sha256: known.sha256 ?? "", deduplicated: true };
        const result = await this.options.host.upload(local, serverProjectId, signal, onProgress);
        await this.record(local, result);
        return result;
    }

    /**
     * Cloud files a project uses: the host's cache answers each from its index (refreshing its use) or downloads it.
     * A file this device uploaded plays from its original. An answer other than the recorded one (the old copy was
     * evicted and downloaded again) is recorded and the projects re-decode their working copies.
     */
    cacheAll(urls: Iterable<{ url: string; sizeBytes?: number | null }>): Promise<void> {
        const cache = this.options.host.cache;
        if (!cache) return Promise.resolve();
        const runs: Promise<void>[] = [];
        for (const { url, sizeBytes } of urls) {
            if (!this.options.isCloudUrl(url)) continue;
            const known = this.toLocal.get(url);
            if (known && !isCacheRecord(known)) continue;
            const running = this.downloads.get(url);
            if (running) {
                runs.push(running);
                continue;
            }
            const run = (async () => {
                try {
                    const local = await cache.call(this.options.host, url, sizeBytes ?? null, new AbortController().signal);
                    const current = this.toLocal.get(url);
                    if (!local || current?.local === local) return;
                    if (current) {
                        const stale: UrlRecord = { ...current, stale: true };
                        this.remember(stale);
                        await this.options.store.put("urls", urlKey(current.local), stale);
                    }
                    const record: UrlRecord = { local, remote: url, ...(sizeBytes ? { sizeBytes } : {}), cache: true };
                    this.remember(record);
                    await this.options.store.put("urls", urlKey(local), record);
                    this.emit([]);
                } catch (error) {
                    this.options.logger?.warn("[cloud] media download failed", error);
                } finally {
                    this.downloads.delete(url);
                }
            })();
            this.downloads.set(url, run);
            runs.push(run);
        }
        return Promise.all(runs).then(() => undefined);
    }

    /** The OpenNan URL a downloaded copy came from (stale copies too), or null for anything else. */
    cachedRemote(localUrl: string): string | null {
        const record = this.toRemote.get(localUrl);
        return record && isCacheRecord(record) ? record.remote : null;
    }

    /** The cache URLs open projects use now (the host keeps them). */
    pin(localUrls: Iterable<string>): void {
        this.options.host.pin?.([...new Set(localUrls)]);
    }

    /** Storage changed (or the person asked to retry): try paused uploads again. */
    retry(): void {
        this.signedOut = false;
        this.blocked = null;
        this.message = null;
        this.pausedUntil = 0;
        this.failed.clear();
        this.emitProgress();
        this.pump();
    }

    dispose(): void {
        for (const controller of this.active.values()) controller.abort();
        if (this.retryTimer !== null) this.options.clock.clearTimeout(this.retryTimer);
        if (this.unblockTimer !== null) this.options.clock.clearTimeout(this.unblockTimer);
    }

    private remember(record: UrlRecord): void {
        this.toRemote.set(record.local, record);
        if (record.stale) {
            if (this.toLocal.get(record.remote)?.local === record.local) this.toLocal.delete(record.remote);
            return;
        }
        this.toLocal.set(record.remote, record);
    }

    private emit(mapping: Array<{ local: string; remote: string }>): void {
        for (const listener of this.listeners) listener(mapping);
        this.emitProgress();
    }

    private emitProgress(): void {
        for (const listener of this.progressListeners) listener();
    }

    private pump(): void {
        if (this.blocked || this.signedOut || this.options.clock.now() < this.pausedUntil) return;
        const concurrency = this.options.concurrency ?? 2;
        while (this.active.size < concurrency && this.queue.length > 0) {
            const job = this.queue.shift()!;
            const controller = new AbortController();
            this.active.set(job.local, controller);
            void this.run(job, controller);
        }
    }

    private async run(job: { local: string; projectId: string }, controller: AbortController): Promise<void> {
        try {
            await this.load();
            // Another tab may have recorded this file since (its upload, or a cached copy): never upload it twice.
            if (!this.toRemote.has(job.local)) {
                const stored = await this.options.store.get<UrlRecord>("urls", urlKey(job.local)).catch(() => null);
                if (stored?.local === job.local) {
                    this.remember(stored);
                    this.emit(stored.stale ? [] : [{ local: stored.local, remote: stored.remote }]);
                }
            }
            if (!this.toRemote.has(job.local)) {
                const result = await this.options.host.upload(job.local, serverIdOf(job.projectId), controller.signal);
                this.uploadedCount += 1;
                this.failures = 0;
                await this.record(job.local, result);
            }
        } catch (error) {
            if (!isAbortError(error)) this.onError(job, error);
        } finally {
            this.active.delete(job.local);
            this.emitProgress();
            this.pump();
        }
    }

    private onError(job: { local: string; projectId: string }, error: unknown): void {
        const code = isCloudApiError(error) ? (error as CloudApiError).code : "";
        const status = isCloudApiError(error) ? (error as CloudApiError).status : 0;
        if (status === 401) {
            this.signedOut = true;
            this.message = "Sign in with OpenNan to upload new media.";
            this.queue.unshift(job);
            this.emitProgress();
            return;
        }
        if (status === 404 && (code === "not_found" || code === "project_not_found")) {
            this.failed.set(job.local, "The cloud project is gone.");
            return;
        }
        if (code === "storage_quota_exceeded") {
            this.blocked = "storage";
            this.message = UPLOAD_BLOCKED_STORAGE;
            this.queue.unshift(job);
            this.later(5 * 60_000, true);
            return;
        }
        if (code === "free_storage_pool_full") {
            this.blocked = "pool-full";
            this.message = UPLOAD_BLOCKED_POOL;
            this.queue.unshift(job);
            this.later(10 * 60_000, true);
            return;
        }
        if (code === "upload_daily_limit" || code === "temp_storage_exceeded" || status === 429) {
            this.message = code === "upload_daily_limit" ? UPLOAD_DAILY_LIMIT : "Too many uploads right now. They will continue shortly.";
            this.queue.unshift(job);
            const wait = ((error as CloudApiError).retryAfterSeconds ?? 60) * 1000;
            this.pausedUntil = this.options.clock.now() + wait;
            this.later(wait, false);
            return;
        }
        if (code === "multipart_required" || code === "upload_gateway_unavailable" || code === "upload_url_used") {
            // Transient on our side (uploads always offer parts; links are single use): retry with backoff below.
        } else if (code === "unsupported_type" || code === "too_large" || code === "missing_file" || (status >= 400 && status < 500 && status !== 401 && status !== 404 && status !== 409 && status !== 410)) {
            // This file can't go up as it is: its items stay on this device until it is replaced.
            this.failed.set(job.local, error instanceof Error ? error.message : String(error));
            this.message = error instanceof Error ? error.message : "A file couldn't be uploaded.";
            this.options.logger?.warn("[cloud] upload refused", error);
            return;
        }
        // The network, the gateway, the server, a used link: back off and retry.
        this.failures += 1;
        this.queue.push(job);
        const wait = Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures - 1)) * (0.75 + this.options.clock.random() * 0.5);
        this.pausedUntil = this.options.clock.now() + wait;
        this.later(wait, false);
    }

    /** `unblock`: the wait of a blocked state (storage full); otherwise a pause (backoff, Retry-After). Each keeps its own timer. */
    private later(ms: number, unblock: boolean): void {
        const name = unblock ? "unblockTimer" : "retryTimer";
        if (this[name] !== null) this.options.clock.clearTimeout(this[name]);
        this[name] = this.options.clock.setTimeout(() => {
            this[name] = null;
            if (unblock) this.blocked = null;
            else this.pausedUntil = 0;
            this.emitProgress();
            this.pump();
        }, ms);
        this.emitProgress();
    }
}

export interface BlobMediaHostOptions {
    api: CloudApi;
    /** The fetch for PUTs to storage (never carries the key). */
    fetch?: typeof globalThis.fetch;
    /** The Blob behind a local media URL (web: LocalBackend.readMedia). */
    readBlob(localUrl: string): Promise<(Blob & { name?: string }) | null>;
    /** Library entries know a file's name and type better than the Blob. */
    describeLocal?(localUrl: string): Promise<Partial<MediaFileInfo> | null>;
    /** SHA-256 of a Blob (web: in a Worker); default hashBlob in this thread. */
    hash?(blob: Blob, signal: AbortSignal): Promise<string>;
    cache?: MediaHost["cache"];
    copyToLocal?: MediaHost["copyToLocal"];
    pin?: MediaHost["pin"];
    allowedHosts?: readonly string[];
}

/** A MediaHost over Blobs: reads the file, hashes it streaming, and uploads it (web, tests). */
export function createBlobMediaHost(options: BlobMediaHostOptions): MediaHost {
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const describe = async (localUrl: string): Promise<MediaFileInfo | null> => {
        const blob = await options.readBlob(localUrl);
        if (!blob) return null;
        const extra = (await options.describeLocal?.(localUrl)) ?? {};
        return { filename: extra.filename ?? blob.name ?? "media", contentType: extra.contentType ?? blob.type ?? "", sizeBytes: blob.size };
    };
    return {
        describe,
        async upload(localUrl, serverProjectId, signal, onProgress) {
            const blob = await options.readBlob(localUrl);
            if (!blob) throw new CloudApiError(0, "missing_file", "This media file is no longer on this device.");
            const info = (await describe(localUrl))!;
            const type = cloudContentType(info.contentType, blob.size);
            if ("refused" in type) throw new CloudApiError(0, "unsupported_type", type.refused);
            const sha256 = await (options.hash ?? ((b, s) => hashBlob(b, s)))(blob, signal);
            return uploadBlob(options.api, doFetch, blob, { filename: info.filename, contentType: type.contentType, sizeBytes: blob.size, sha256, ...(serverProjectId ? { projectId: serverProjectId } : {}) }, {
                signal, ...(onProgress ? { onProgress } : {}), ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
            });
        },
        ...(options.cache ? { cache: options.cache } : {}),
        ...(options.copyToLocal ? { copyToLocal: options.copyToLocal } : {}),
        ...(options.pin ? { pin: options.pin } : {}),
    };
}
