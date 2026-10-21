// The cache of downloaded OpenNan storage files in desktop main (phase 9a.1, decisions 1-7). A download streams into
// <root>/downloads/<id>.part under an id reserved up front and is adopted into the media store under that same id, so
// it plays as opennan-local://media/<id>. The index <root>/media-cache.json (temp file, fsync, rename) lists every file
// the cache itself downloaded with its size and last use; only those can ever be evicted (a released Save to OpenNan
// file also has no project, but it is never in the index). Eviction runs least recently used first under the person's
// limit, before a download (room for its listed size), after one, on a new limit and on Clear cache, and never takes a
// pinned file (open cloud projects use it), a download still running, or a file used in the last minute (except Clear
// cache). Each victim is re-checked when it is deleted: its media row must still belong to no project and no local
// project may name it, else it only leaves the index and its file stays.
// Streaming (decision 7): cache() records a "partial" entry and answers as soon as the download's headers gave its size
// and type; until the file is adopted the media protocol serves the id through streamSource(): bytes already in the
// part file from disk, others with a ranged request of the entry's own URL (never one the renderer sent), re-checked
// like the download and refused unless the storage answers exactly that range of a file of that size.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
    CloudApiError, MediaCacheIndex, cacheBytes, parseCacheIndex, planEviction, type CacheEntry, type CacheIndexStorage, type CacheUsage,
} from "@opennan/cloud-backend";
import { checkDownloadUrl } from "@opennan/provider-sdk";
import { MAX_CLOUD_MEDIA_BYTES } from "../../shared/cloud-policy";
import { isUuid } from "../../shared/ids";
import { LOCAL_MEDIA_PREFIX } from "../../shared/media-policy";
import { MEDIA_EXTENSIONS, extensionForMime } from "../../shared/media-types";
import { DEFAULT_CACHE_LIMIT_BYTES, MAX_CACHE_LIMIT_BYTES, MIN_CACHE_LIMIT_BYTES } from "../../shared/settings";
import type { StreamSource } from "../protocol/media-protocol";
import type { MediaStore } from "../store/media-store";

export const MAX_CONCURRENT_DOWNLOADS = 3;
export const DOWNLOAD_SLACK_BYTES = 1024 ** 2;
/** A download that never finished is forgotten after this long without use. */
export const PARTIAL_MAX_AGE_MS = 30 * 24 * 3600_000;
const MAX_REDIRECTS = 3;
/** A ranged read of a download in progress must have its headers within this time. */
export const RANGE_HEADERS_TIMEOUT_MS = 30_000;

export interface CacheLimitStore {
    /** The person's limit in bytes, or null for the default. */
    get(): number | null;
    set(bytes: number | null): void;
}

export interface MediaCacheOptions {
    /** <userData>/cloud: downloads/ and media-cache.json. */
    root: string;
    mediaStore: Pick<MediaStore, "pathOf" | "info" | "adoptFile" | "delete">;
    /** OpenNan storage (the fake's files when the API base is loopback). */
    isCloudUrl(url: string): boolean;
    /** The API base is the loopback fake: plain http to it passes the downloader's check. */
    loopback: boolean;
    fetch: typeof globalThis.fetch;
    limit: CacheLimitStore;
    /** Whether a local project's saved document names this opennan-local URL (SQLite in the app). */
    /** The ids among `ids` a local project's saved document names (one pass over the projects). */
    localReferences(ids: string[]): Set<string>;
    now(): number;
    downloadTimeoutMs: number;
    warn(...args: unknown[]): void;
}

export interface MediaCache {
    /** The local URL of an OpenNan storage file (checked by the caller), downloading it when it is not cached. */
    cache(remoteUrl: string, sizeBytes: number | null): Promise<string>;
    /** Resolves when the file of a cache id is in the media store (a download is started if it is not running). */
    settle(id: string): Promise<void>;
    /** Runs `run` with the id kept from eviction (a copy reading the file). */
    hold<T>(id: string, run: () => Promise<T>): Promise<T>;
    /** The ids open cloud projects use (replaces the previous set). */
    pin(ids: readonly string[]): void;
    usage(): Promise<CacheUsage>;
    setLimit(bytes: number | null): Promise<CacheUsage>;
    clear(): Promise<{ freedBytes: number; keptBytes: number }>;
    /** The protocol's source for a cache id still downloading, or null (a stored file, or not a download). */
    streamSource(id: string): Promise<StreamSource | null>;
}

interface Job {
    id: string;
    url: string;
    part: string;
    /** Bytes of the part file on disk so far. */
    written(): number;
    /** Resolves once the entry is recorded with its size and type (or the file is in, when the size is unknown). */
    headers: Promise<void>;
    /** Resolves once the file is adopted into the media store. */
    done: Promise<void>;
}

const refusedLimit = () => new CloudApiError(400, "desktop_refused", "Studio's desktop app does not take this cache limit.");

/** The media type of a download: a supported Content-Type, else the URL's extension; null when neither is media. */
export function downloadMediaType(contentType: string | null, url: string): string | null {
    const ext = extensionForMime(contentType ?? "");
    if (ext) return MEDIA_EXTENSIONS[ext]!.mimeType;
    try {
        const fromUrl = path.posix.extname(new URL(url).pathname).toLowerCase();
        return MEDIA_EXTENSIONS[fromUrl]?.mimeType ?? null;
    } catch {
        return null;
    }
}

function contentLength(headers: Headers): number | null {
    const value = headers.get("content-length");
    if (value === null || !/^\d{1,16}$/.test(value.trim())) return null;
    return Number(value.trim());
}

function fileNameOf(url: string): string {
    try {
        return (decodeURIComponent(path.posix.basename(new URL(url).pathname)) || "media").slice(0, 200);
    } catch {
        return "media";
    }
}

export function createMediaCache(options: MediaCacheOptions): MediaCache {
    const media = options.mediaStore;
    const downloadsDir = path.join(options.root, "downloads");
    const indexFile = path.join(options.root, "media-cache.json");

    // The index as last read or written: main is its only writer, so this copy is the file's content.
    let raw: unknown | null | undefined;
    const view = new Map<string, CacheEntry>();
    const byUrl = new Map<string, CacheEntry[]>();
    const setView = (value: unknown) => {
        view.clear();
        byUrl.clear();
        for (const entry of parseCacheIndex(value)) {
            view.set(entry.id, entry);
            byUrl.set(entry.url, [...(byUrl.get(entry.url) ?? []), entry]);
        }
    };
    const storage: CacheIndexStorage = {
        async read() {
            if (raw === undefined) {
                try {
                    raw = JSON.parse(await fs.promises.readFile(indexFile, "utf8")) as unknown;
                } catch {
                    raw = null;
                }
                setView(raw);
            }
            return raw;
        },
        async write(file) {
            const temp = `${indexFile}.${randomUUID()}.tmp`;
            try {
                const handle = await fs.promises.open(temp, "wx", 0o600);
                try {
                    await handle.writeFile(JSON.stringify(file));
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                await fs.promises.rename(temp, indexFile);
            } catch (error) {
                await fs.promises.rm(temp, { force: true }).catch(() => undefined);
                throw error;
            }
            raw = JSON.parse(JSON.stringify(file)) as unknown;
            setView(raw);
        },
    };
    const index = new MediaCacheIndex(storage, { now: options.now });

    const jobs = new Map<string, Job>();
    let pinned = new Set<string>();
    const holds = new Map<string, number>();
    // A running download's entry is "partial", which planEviction never takes.
    const isPinned = (id: string) => pinned.has(id) || holds.has(id);

    let activeDownloads = 0;
    const waitingDownloads: Array<() => void> = [];
    async function downloadSlot<T>(run: () => Promise<T>): Promise<T> {
        if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) await new Promise<void>((resolve) => waitingDownloads.push(resolve));
        activeDownloads += 1;
        try {
            return await run();
        } finally {
            activeDownloads -= 1;
            waitingDownloads.shift()?.();
        }
    }

    // Before the first use: temp files a crash left behind, then the index checked against the media store.
    let started: Promise<void> | null = null;
    const ready = () => (started ??= (async () => {
        await fs.promises.mkdir(options.root, { recursive: true, mode: 0o700 }).catch(() => undefined);
        const list = (dir: string) => fs.promises.readdir(dir).catch(() => [] as string[]);
        for (const name of await list(downloadsDir)) if (name.endsWith(".part")) await fs.promises.rm(path.join(downloadsDir, name), { force: true }).catch(() => undefined);
        for (const name of await list(options.root)) if (name.startsWith("media-cache.json.") && name.endsWith(".tmp")) await fs.promises.rm(path.join(options.root, name), { force: true }).catch(() => undefined);
        await index.update((entries) => {
            const now = options.now();
            for (const [id, entry] of entries) {
                const row = isUuid(id) ? media.info(id) : null;
                // A project's own file now: never the cache's to delete.
                if (!isUuid(id) || (row && row.projectId !== null)) {
                    entries.delete(id);
                    continue;
                }
                if (row && media.pathOf(id)) {
                    // Finished (a "partial" one was adopted just before a crash); 9a's entries learn their size.
                    if (entry.state !== "ready" || entry.sizeBytes !== row.size) entries.set(id, { ...entry, state: "ready", sizeBytes: row.size });
                    continue;
                }
                // A finished file that is gone, or a download nobody asked for in a month (its part file was swept).
                if (entry.state === "ready" || now - entry.lastUsed > PARTIAL_MAX_AGE_MS || !options.isCloudUrl(entry.url)) entries.delete(id);
            }
        });
    })().catch((error: unknown) => options.warn("[cloud] media cache index not checked", error)));

    function limitBytes(): number {
        try {
            return options.limit.get() ?? DEFAULT_CACHE_LIMIT_BYTES;
        } catch {
            return DEFAULT_CACHE_LIMIT_BYTES;
        }
    }

    function referencedLocally(ids: string[]): Set<string> {
        try {
            return options.localReferences(ids);
        } catch {
            return new Set(ids);
        }
    }

    async function enforce(request: { incomingBytes?: number; all?: boolean } = {}): Promise<{ freedBytes: number; keptBytes: number }> {
        await ready();
        await index.flushTouches().catch((error: unknown) => options.warn("[cloud] media cache use not saved", error));
        return index.update(async (entries) => {
            let incoming = request.incomingBytes ?? 0;
            for (const entry of entries.values()) if (entry.state === "partial" && jobs.has(entry.id)) incoming += entry.sizeBytes;
            const victims = planEviction([...entries.values()], {
                limitBytes: limitBytes(), incomingBytes: incoming, isPinned: (entry) => isPinned(entry.id), now: options.now(), ...(request.all ? { all: true } : {}),
            });
            let freedBytes = 0;
            const named = referencedLocally(victims.map((victim) => victim.id));
            for (const victim of victims) {
                const row = media.info(victim.id);
                if (!row) {
                    entries.delete(victim.id);
                    continue;
                }
                if (row.projectId !== null || named.has(victim.id)) {
                    options.warn("[cloud] a cached file a project uses left the cache; its file stays", victim.id);
                    entries.delete(victim.id);
                    continue;
                }
                try {
                    // The file first, the entry second: a crash in between leaves an entry the next start drops.
                    await media.delete(victim.id);
                } catch (error) {
                    options.warn("[cloud] cached file not deleted", error);
                    continue;
                }
                freedBytes += victim.sizeBytes;
                entries.delete(victim.id);
            }
            return { freedBytes, keptBytes: cacheBytes(entries.values()) };
        });
    }

    /** The answer of an OpenNan storage URL, every redirect re-checked and kept on OpenNan's storage. */
    async function fetchChecked(url: string, init: { headers?: Record<string, string> }, signal: AbortSignal): Promise<Response> {
        const hopTo = (href: string) => {
            const checked = checkDownloadUrl(href, options.loopback);
            if (!options.isCloudUrl(checked.href)) throw new Error("The download left OpenNan's storage.");
            return checked;
        };
        let target = hopTo(url);
        for (let hop = 0; ; hop++) {
            const response = await options.fetch(target.href, {
                credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer", signal, ...(init.headers ? { headers: init.headers } : {}),
            });
            if (response.status < 300 || response.status >= 400) return response;
            await response.body?.cancel().catch(() => undefined);
            const location = response.headers.get("location");
            if (!location || hop >= MAX_REDIRECTS) throw new Error("The download redirected too often.");
            target = hopTo(new URL(location, target).href);
        }
    }

    function startDownload(id: string, url: string, listedBytes: number | null): Job {
        const part = path.join(downloadsDir, `${id}.part`);
        let out: fs.WriteStream | null = null;
        let headersDone = false;
        let resolveHeaders!: () => void;
        let rejectHeaders!: (error: unknown) => void;
        const headers = new Promise<void>((resolve, reject) => {
            resolveHeaders = () => {
                headersDone = true;
                resolve();
            };
            rejectHeaders = reject;
        });
        const record = (fields: Pick<CacheEntry, "sizeBytes" | "state"> & { mimeType: string }) => index.update((entries) => {
            entries.set(id, { id, url, sizeBytes: fields.sizeBytes, lastUsed: options.now(), state: fields.state, mimeType: fields.mimeType });
        });
        const run = async () => {
            const signal = AbortSignal.timeout(options.downloadTimeoutMs);
            const cap = (listedBytes ?? MAX_CLOUD_MEDIA_BYTES) + DOWNLOAD_SLACK_BYTES;
            const response = await fetchChecked(url, {}, signal);
            if (response.status !== 200 || !response.body) {
                await response.body?.cancel().catch(() => undefined);
                throw new Error(`The download answered ${response.status}.`);
            }
            const declared = contentLength(response.headers);
            if (declared !== null && declared > cap) {
                await response.body.cancel().catch(() => undefined);
                throw new Error("The download is larger than the file OpenNan listed.");
            }
            const mimeType = downloadMediaType(response.headers.get("content-type"), url);
            if (!mimeType) {
                await response.body.cancel().catch(() => undefined);
                throw new Error("The download is not a media file Studio plays.");
            }
            const total = declared ?? listedBytes;
            // Recorded before the body: an interrupted download is known at the next start.
            try {
                await record({ sizeBytes: total ?? 0, state: "partial", mimeType });
            } catch (error) {
                await response.body.cancel().catch(() => undefined);
                throw error;
            }
            if (total !== null && total > 0) resolveHeaders();
            await fs.promises.mkdir(downloadsDir, { recursive: true, mode: 0o700 });
            await fs.promises.rm(part, { force: true });
            let received = 0;
            const counter = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    received += chunk.length;
                    if (received > cap) callback(new Error("The download is larger than the file OpenNan listed."));
                    else callback(null, chunk);
                },
            });
            out = fs.createWriteStream(part, { flags: "wx", mode: 0o600 });
            await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), counter, out, { signal });
            if (declared !== null && received !== declared) throw new Error("The download ended early.");
            const stored = await media.adoptFile({ id, projectId: null, path: part, name: fileNameOf(url), mimeType });
            await record({ sizeBytes: stored.size, state: "ready", mimeType: stored.mimeType });
        };
        const done = (async () => {
            try {
                await downloadSlot(run);
            } catch (error) {
                await fs.promises.rm(part, { force: true }).catch(() => undefined);
                rejectHeaders(error);
                // The entry (if recorded) stays "partial": the next cache() of the URL downloads it again.
                options.warn("[cloud] download failed", error instanceof Error ? error.message : String(error));
                throw error;
            } finally {
                jobs.delete(id);
            }
            if (!headersDone) resolveHeaders();
            void enforce().catch((error: unknown) => options.warn("[cloud] media cache not trimmed", error));
        })();
        done.catch(() => undefined);
        headers.catch(() => undefined);
        const job: Job = { id, url, part, written: () => out?.bytesWritten ?? 0, headers, done };
        jobs.set(id, job);
        return job;
    }

    /** The entry of a URL: a finished one first, else a download in progress. */
    function lookup(url: string): CacheEntry | null {
        const entries = byUrl.get(url) ?? [];
        return entries.find((entry) => entry.state === "ready") ?? entries[0] ?? null;
    }

    async function answer(url: string, sizeBytes: number | null): Promise<string> {
        await ready();
        const entry = lookup(url);
        if (entry && media.pathOf(entry.id)) {
            index.touch(entry.id);
            return `${LOCAL_MEDIA_PREFIX}${entry.id}`;
        }
        if (entry?.state === "partial") {
            // Streamed meanwhile; a download that failed or stopped with the app starts again.
            index.touch(entry.id);
            const job = jobs.get(entry.id) ?? startDownload(entry.id, url, sizeBytes ?? (entry.sizeBytes || null));
            if (!(entry.sizeBytes > 0 && entry.mimeType)) await job.headers;
            return `${LOCAL_MEDIA_PREFIX}${entry.id}`;
        }
        if (entry) {
            // A finished file that left the media store behind the cache's back: downloaded again under a new id.
            await index.update((entries) => void entries.delete(entry.id));
        }
        await enforce({ incomingBytes: sizeBytes ?? 0 });
        const id = randomUUID();
        await startDownload(id, url, sizeBytes).headers;
        return `${LOCAL_MEDIA_PREFIX}${id}`;
    }

    /** Bytes start..end of the entry's URL with a ranged request, checked hop by hop and against the entry's size. */
    async function fetchRange(url: string, size: number, start: number, end: number, signal: AbortSignal | undefined): Promise<ReadableStream<Uint8Array>> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort, { once: true });
        const headersTimer = setTimeout(abort, RANGE_HEADERS_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetchChecked(url, { headers: { Range: `bytes=${start}-${end}` } }, AbortSignal.any([controller.signal, AbortSignal.timeout(options.downloadTimeoutMs)]));
        } catch (error) {
            signal?.removeEventListener("abort", abort);
            throw error;
        } finally {
            clearTimeout(headersTimer);
        }
        const refuse = async (why: string): Promise<never> => {
            signal?.removeEventListener("abort", abort);
            await response.body?.cancel().catch(() => undefined);
            throw new Error(why);
        };
        let skip = 0;
        if (response.status === 206) {
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range")?.trim() ?? "");
            if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== size) await refuse("OpenNan's storage answered another range.");
        } else if (response.status === 200) {
            const declared = contentLength(response.headers);
            if (declared !== null && declared !== size) await refuse("OpenNan's storage answered another file.");
            skip = start;
        } else {
            await refuse(`OpenNan's storage answered ${response.status}.`);
        }
        if (!response.body) return refuse("OpenNan's storage answered no bytes.");
        return sliceStream(response.body, skip, end - start + 1, () => {
            signal?.removeEventListener("abort", abort);
            controller.abort();
        });
    }

    async function openRange(id: string, url: string, size: number, start: number, end: number, signal: AbortSignal | undefined): Promise<ReadableStream<Uint8Array>> {
        const job = jobs.get(id);
        if (job && end < job.written()) {
            // Opened first: the part file may be adopted (renamed) while it is read.
            const handle = await fs.promises.open(job.part, "r").catch(() => null);
            if (handle) return Readable.toWeb(handle.createReadStream({ start, end })) as unknown as ReadableStream<Uint8Array>;
        }
        const file = media.pathOf(id);
        if (file) return Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>;
        return fetchRange(url, size, start, end, signal);
    }

    const answering = new Map<string, Promise<string>>();

    async function usage(): Promise<CacheUsage> {
        await ready();
        const entries = [...view.values()];
        let custom = false;
        try {
            custom = options.limit.get() !== null;
        } catch {
            custom = false;
        }
        return {
            usedBytes: cacheBytes(entries),
            entries: entries.filter((entry) => entry.state === "ready").length,
            limitBytes: limitBytes(),
            defaultLimitBytes: DEFAULT_CACHE_LIMIT_BYTES,
            maxLimitBytes: MAX_CACHE_LIMIT_BYTES,
            pinnedBytes: cacheBytes(entries.filter((entry) => pinned.has(entry.id))),
            custom,
        };
    }

    return {
        cache(remoteUrl, sizeBytes) {
            const running = answering.get(remoteUrl);
            if (running) return running;
            const run = answer(remoteUrl, sizeBytes).finally(() => answering.delete(remoteUrl));
            answering.set(remoteUrl, run);
            return run;
        },
        async settle(id) {
            await ready();
            if (!isUuid(id) || media.pathOf(id)) return;
            const entry = view.get(id);
            if (!entry || entry.state !== "partial") return;
            await (jobs.get(id) ?? startDownload(id, entry.url, entry.sizeBytes || null)).done;
        },
        async hold(id, run) {
            holds.set(id, (holds.get(id) ?? 0) + 1);
            try {
                return await run();
            } finally {
                const left = (holds.get(id) ?? 1) - 1;
                if (left > 0) holds.set(id, left);
                else holds.delete(id);
            }
        },
        pin(ids) {
            pinned = new Set(ids.filter((id) => isUuid(id)));
        },
        usage,
        async setLimit(bytes) {
            if (bytes !== null && !(Number.isInteger(bytes) && bytes >= MIN_CACHE_LIMIT_BYTES && bytes <= MAX_CACHE_LIMIT_BYTES)) throw refusedLimit();
            options.limit.set(bytes);
            await enforce();
            return usage();
        },
        clear: () => enforce({ all: true }),
        async streamSource(id) {
            if (!isUuid(id)) return null;
            await ready();
            const entry = view.get(id);
            if (!entry || entry.state !== "partial" || !(entry.sizeBytes > 0) || !entry.mimeType || media.info(id)) return null;
            const { url, sizeBytes: size, mimeType } = entry;
            if (!options.isCloudUrl(url)) return null;
            return { size, mimeType, open: (start, end, signal) => openRange(id, url, size, start, end, signal) };
        },
    };
}

/** `body` without its first `skip` bytes, ending after `length` bytes (the rest is cancelled); short is an error. */
function sliceStream(body: ReadableStream<Uint8Array>, skip: number, length: number, onEnd: () => void): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let toSkip = skip;
    let left = length;
    const finish = () => {
        onEnd();
        void reader.cancel().catch(() => undefined);
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    onEnd();
                    controller.error(new Error("OpenNan's storage ended the range early."));
                    return;
                }
                let chunk = value;
                if (toSkip > 0) {
                    if (chunk.byteLength <= toSkip) {
                        toSkip -= chunk.byteLength;
                        continue;
                    }
                    chunk = chunk.subarray(toSkip);
                    toSkip = 0;
                }
                if (chunk.byteLength > left) chunk = chunk.subarray(0, left);
                left -= chunk.byteLength;
                if (chunk.byteLength > 0) controller.enqueue(chunk);
                if (left <= 0) {
                    controller.close();
                    finish();
                }
                return;
            }
        },
        cancel() {
            finish();
        },
    });
}
