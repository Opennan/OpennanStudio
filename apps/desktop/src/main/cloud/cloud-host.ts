// OpenNan cloud projects in desktop main (phase 9a, track F): the renderer's cloud backend reaches the API, uploads,
// downloads and its on-disk state only through here, so the sk- key stays in this process.
// - request: the sync engine's, the catalog's and the AI director's calls (allowlisted methods, paths, headers, query
//   values, body size), sent with the signed-in account's key and a deadline; anything else is refused before any
//   network call.
// - stream: a director turn (phase 9b), the same guards, a deadline for the answer's headers and an idle limit on its
//   body (the server pings every 15 s) but no total one; the caller's abort drops the request (the server cancels).
// - upload: a media-store file hashed here (Node's SHA-256 over a read stream) and sent by uploadBlob (deduplicated,
//   one PUT or parts, single-use links) with a deadline; one upload per file and project at a time.
// - cache: an OpenNan storage file streamed to a temp file (no credentials, every redirect re-checked and kept on
//   OpenNan's storage, a byte cap, a timeout) and moved into the media store, so it plays as
//   opennan-local://media/<id>; each URL is cached once, at most 3 downloads at a time, and the cache is kept under
//   the person's limit by evicting the least recently used downloads (media-cache.ts, phase 9a.1).
// - duplicate: a copy of a media-store file for a local project (Download a local copy).
// - store: the CloudStore files (cloud-store.ts).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    CloudApiError, cloudContentType, createCloudApi, isCloudApiError, uploadBlob, type CacheUsage, type CloudApi, type MediaFileInfo, type UploadResult,
} from "@opennan/cloud-backend";
import { redactKeys } from "@opennan/provider-opennan";
import {
    MAX_CLOUD_MEDIA_BYTES, SERVER_PROJECT_ID, canonicalCloudHeader, checkCloudRequest, checkCloudStream, cloudStorageUrlRule, type CloudRequestInput, type CloudRequestMethod,
    type CloudStreamInput,
} from "../../shared/cloud-policy";
import { isUuid } from "../../shared/ids";
import type { StreamSource } from "../protocol/media-protocol";
import type { MediaStore, StoredMedia } from "../store/media-store";
import { createCloudFileStore, type CloudFileStore } from "./cloud-store";
import { createMediaCache, type CacheLimitStore } from "./media-cache";

export { DOWNLOAD_SLACK_BYTES, MAX_CONCURRENT_DOWNLOADS } from "./media-cache";

export const DEFAULT_CLOUD_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_CLOUD_API_TIMEOUT_MS = 60_000;
/** An upload's deadline: 10 minutes plus 4 s per MiB (about 256 KiB/s). */
export function uploadDeadlineMs(sizeBytes: number): number {
    return 10 * 60_000 + Math.ceil(sizeBytes / 1024 ** 2) * 4000;
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface CloudStreamAnswer {
    status: number;
    /** The answer's bytes as they arrive; errors with a network CloudApiError after apiTimeoutMs without a byte. */
    body: ReadableStream<Uint8Array>;
}

export interface CloudAnswer {
    status: number;
    body: unknown;
    etag: string | null;
}

export type DuplicatedMedia = Omit<StoredMedia, "id">;

export interface CloudHostOptions {
    /** The same API base the account uses. */
    apiBase: string;
    /** The account's session: its key is read on every call (null = signed out). */
    session: { apiKey(): string | null };
    mediaStore: Pick<MediaStore, "pathOf" | "info" | "adoptFile" | "copy" | "delete">;
    /** <userData>/cloud: the store, the download temp folder and the cache index. */
    root: string;
    fetch?: typeof globalThis.fetch;
    downloadTimeoutMs?: number;
    apiTimeoutMs?: number;
    /** Overrides uploadDeadlineMs (tests). */
    uploadTimeoutMs?: number;
    /** The cloud media cache limit (desktop settings); default: kept in memory, starting at the default. */
    limit?: CacheLimitStore;
    /** Whether a local project's saved document names a media URL: such a file is never evicted (default: none does). */
    /** The ids among `ids` a local project names (never evicted); default none. */
    localReferences?(ids: string[]): Set<string>;
    now?(): number;
    warn?(...args: unknown[]): void;
}

export interface CloudHost {
    /** OpenNan storage files the cache takes (the CDN; the fake's /files/ when the API base is loopback). */
    isCloudUrl(url: string): boolean;
    request(method: CloudRequestMethod, path: string, request: CloudRequestInput): Promise<CloudAnswer>;
    /** A director turn's event stream; `signal` aborts the request at any point. */
    stream(method: CloudRequestMethod, path: string, request: CloudStreamInput, signal: AbortSignal): Promise<CloudStreamAnswer>;
    describe(mediaId: string): MediaFileInfo | null;
    upload(mediaId: string, serverProjectId: string | null): Promise<UploadResult>;
    /** Uploads an export file (a path main already checked is one of its exports) for a cloud project (phase 9c). */
    uploadExport(file: string, serverProjectId: string): Promise<UploadResult>;
    /** The local URL of the cached file. */
    cache(remoteUrl: string, sizeBytes: number | null): Promise<string>;
    duplicate(mediaId: string, projectId: string): Promise<DuplicatedMedia>;
    /** The media ids open cloud projects use now (replaces the previous set): never evicted. */
    pin(ids: readonly string[]): void;
    usage(): Promise<CacheUsage>;
    /** A new limit (null: the default), the cache trimmed to it before answering. */
    setLimit(bytes: number | null): Promise<CacheUsage>;
    /** Evicts every cached file open projects don't use. */
    clear(): Promise<{ freedBytes: number; keptBytes: number }>;
    /** The media protocol's source for a cached file still downloading (served before it is in the media store). */
    streamSource(mediaId: string): Promise<StreamSource | null>;
    store: CloudFileStore;
}

const timedOut = (what: string) => new CloudApiError(0, "network", `OpenNan did not answer in time (${what}).`);

const refused = (what: string) => new CloudApiError(400, "desktop_refused", `Studio's desktop app does not send this ${what}.`);

/** An error as a CloudApiError whose text never carries a key. */
export function asCloudError(error: unknown, code = "desktop_failed", status = 0): CloudApiError {
    if (isCloudApiError(error)) {
        const json = (error as CloudApiError).toJSON();
        return CloudApiError.fromJSON({ ...json, message: redactKeys(json.message) });
    }
    return new CloudApiError(status, code, redactKeys(error instanceof Error ? error.message : String(error)).slice(0, 500));
}

/** `body` that errors with a network CloudApiError (and calls `stop`) when no byte came for `idleMs`. */
function withIdleLimit(body: ReadableStream<Uint8Array>, idleMs: number, stop: () => void): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(timedOut("stream")), idleMs);
            });
            try {
                const { value, done } = await Promise.race([reader.read(), idle]);
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (error) {
                stop();
                controller.error(isCloudApiError(error) ? error : asCloudError(error, "network"));
                reader.cancel().catch(() => undefined);
            } finally {
                clearTimeout(timer);
            }
        },
        cancel(reason) {
            stop();
            return reader.cancel(reason).catch(() => undefined);
        },
    });
}

async function sha256File(file: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

function isLoopbackHttp(base: string): boolean {
    try {
        const url = new URL(base);
        return url.protocol === "http:" && LOOPBACK.has(url.hostname);
    } catch {
        return false;
    }
}

export function createCloudHost(options: CloudHostOptions): CloudHost {
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const api: CloudApi = createCloudApi({ baseUrl: options.apiBase, apiKey: () => options.session.apiKey(), fetch: doFetch });
    const loopback = isLoopbackHttp(options.apiBase);
    const isCloudUrl = cloudStorageUrlRule(loopback ? options.apiBase : null);
    const store = createCloudFileStore({ root: options.root });
    const uploads = new Map<string, Promise<UploadResult>>();
    let limitValue: number | null = null;
    const mediaCache = createMediaCache({
        root: options.root, mediaStore: options.mediaStore, isCloudUrl, loopback, fetch: doFetch,
        limit: options.limit ?? { get: () => limitValue, set: (bytes) => void (limitValue = bytes) },
        localReferences: options.localReferences ?? (() => new Set()),
        now: options.now ?? Date.now,
        downloadTimeoutMs: options.downloadTimeoutMs ?? DEFAULT_CLOUD_DOWNLOAD_TIMEOUT_MS,
        warn: (...args) => options.warn?.(...args.map((arg) => (typeof arg === "string" ? redactKeys(arg) : arg))),
    });

    function describe(mediaId: string): MediaFileInfo | null {
        if (!isUuid(mediaId) || !options.mediaStore.pathOf(mediaId)) return null;
        const info = options.mediaStore.info(mediaId);
        return info ? { filename: info.originalName, contentType: info.mimeType, sizeBytes: info.size } : null;
    }

    async function runUpload(mediaId: string, serverProjectId: string | null): Promise<UploadResult> {
        const file = isUuid(mediaId) ? options.mediaStore.pathOf(mediaId) : null;
        const info = file ? describe(mediaId) : null;
        if (!file || !info) throw new CloudApiError(0, "missing_file", "This media file is no longer on this device.");
        const type = cloudContentType(info.contentType, info.sizeBytes);
        if ("refused" in type) throw new CloudApiError(0, "unsupported_type", type.refused);
        const sha256 = await sha256File(file);
        const blob = await fs.openAsBlob(file, { type: type.contentType });
        const signal = AbortSignal.timeout(options.uploadTimeoutMs ?? uploadDeadlineMs(blob.size));
        try {
            return await uploadBlob(api, doFetch, blob, {
                filename: info.filename, contentType: type.contentType, sizeBytes: blob.size, sha256, ...(serverProjectId ? { projectId: serverProjectId } : {}),
            }, { signal });
        } catch (error) {
            if (signal.aborted) throw timedOut("upload");
            throw error;
        }
    }

    /** What this app's exports are (MP4, or WebM without an H.264 encoder). */
    const EXPORT_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm" };

    async function runExportUpload(file: string, serverProjectId: string): Promise<UploadResult> {
        const contentType = EXPORT_TYPES[path.extname(file).toLowerCase()];
        if (!contentType) throw new CloudApiError(0, "unsupported_type", "Only a video export can be shared.");
        const stat = await fs.promises.stat(file).catch(() => null);
        if (!stat || !stat.isFile()) throw new CloudApiError(0, "missing_file", "This export is no longer on this device.");
        const type = cloudContentType(contentType, stat.size);
        if ("refused" in type) throw new CloudApiError(0, "unsupported_type", type.refused);
        const sha256 = await sha256File(file);
        const blob = await fs.openAsBlob(file, { type: type.contentType });
        const signal = AbortSignal.timeout(options.uploadTimeoutMs ?? uploadDeadlineMs(blob.size));
        try {
            return await uploadBlob(api, doFetch, blob, { filename: path.basename(file), contentType: type.contentType, sizeBytes: blob.size, sha256, projectId: serverProjectId }, { signal });
        } catch (error) {
            if (signal.aborted) throw timedOut("upload");
            throw error;
        }
    }

    return {
        isCloudUrl,
        async request(method, apiPath, request) {
            if (checkCloudRequest(method, apiPath, request) !== null) throw refused("request");
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(request.headers ?? {})) headers[canonicalCloudHeader(name)!] = value as string;
            const query = request.query as Record<string, string | number | boolean> | undefined;
            const signal = AbortSignal.timeout(options.apiTimeoutMs ?? DEFAULT_CLOUD_API_TIMEOUT_MS);
            try {
                const answer = await api.request(method, apiPath, {
                    ...(request.body !== undefined ? { body: request.body } : {}), ...(query ? { query } : {}), headers, signal,
                });
                return { status: answer.status, body: answer.body ?? null, etag: answer.etag };
            } catch (error) {
                if (signal.aborted) throw timedOut("request");
                throw asCloudError(error);
            }
        },
        async stream(method, apiPath, request, signal) {
            if (checkCloudStream(method, apiPath, request) !== null) throw refused("stream");
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(request.headers ?? {})) headers[canonicalCloudHeader(name)!] = value as string;
            const timeoutMs = options.apiTimeoutMs ?? DEFAULT_CLOUD_API_TIMEOUT_MS;
            const controller = new AbortController();
            const stop = () => controller.abort();
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
            let late = false;
            const deadline = setTimeout(() => {
                late = true;
                stop();
            }, timeoutMs);
            try {
                const answer = await api.stream!(method, apiPath, { ...(request.body !== undefined ? { body: request.body } : {}), headers, signal: controller.signal });
                return { status: answer.status, body: withIdleLimit(answer.body, timeoutMs, stop) };
            } catch (error) {
                if (late) throw timedOut("stream");
                if (signal.aborted) throw error;
                throw asCloudError(error);
            } finally {
                clearTimeout(deadline);
            }
        },
        describe,
        upload(mediaId, serverProjectId) {
            if (serverProjectId !== null && !SERVER_PROJECT_ID.test(serverProjectId)) return Promise.reject(refused("upload"));
            const key = `${mediaId}:${serverProjectId ?? ""}`;
            const running = uploads.get(key);
            if (running) return running;
            const run = runUpload(mediaId, serverProjectId).catch((error: unknown) => {
                throw asCloudError(error);
            }).finally(() => uploads.delete(key));
            uploads.set(key, run);
            return run;
        },
        uploadExport(file, serverProjectId) {
            if (!SERVER_PROJECT_ID.test(serverProjectId)) return Promise.reject(refused("upload"));
            const key = `export:${file}:${serverProjectId}`;
            const running = uploads.get(key);
            if (running) return running;
            const run = runExportUpload(file, serverProjectId).catch((error: unknown) => {
                throw asCloudError(error);
            }).finally(() => uploads.delete(key));
            uploads.set(key, run);
            return run;
        },
        cache(remoteUrl, sizeBytes) {
            if (!isCloudUrl(remoteUrl)) return Promise.reject(new CloudApiError(400, "download_refused", "Studio only downloads media from OpenNan's storage."));
            if (sizeBytes !== null && !(Number.isInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= MAX_CLOUD_MEDIA_BYTES)) return Promise.reject(refused("download"));
            return mediaCache.cache(remoteUrl, sizeBytes).catch((error: unknown) => {
                throw asCloudError(error, "download_failed");
            });
        },
        async duplicate(mediaId, projectId) {
            if (!isUuid(projectId)) throw refused("copy");
            if (!isUuid(mediaId)) throw new CloudApiError(0, "missing_file", "This media file is no longer on this device.");
            return mediaCache.hold(mediaId, async () => {
                // A cached file still downloading is copied once it is in.
                await mediaCache.settle(mediaId).catch((error: unknown) => {
                    throw asCloudError(error, "download_failed");
                });
                if (!options.mediaStore.pathOf(mediaId)) throw new CloudApiError(0, "missing_file", "This media file is no longer on this device.");
                try {
                    const { id: _id, ...copy } = await options.mediaStore.copy(mediaId, projectId);
                    return copy;
                } catch (error) {
                    throw asCloudError(error, "missing_file");
                }
            });
        },
        pin: (ids) => mediaCache.pin(ids),
        usage: () => mediaCache.usage().catch((error: unknown) => {
            throw asCloudError(error);
        }),
        setLimit: (bytes) => mediaCache.setLimit(bytes).catch((error: unknown) => {
            throw asCloudError(error);
        }),
        clear: () => mediaCache.clear().catch((error: unknown) => {
            throw asCloudError(error);
        }),
        streamSource: (mediaId) => mediaCache.streamSource(mediaId).catch(() => null),
        store,
    };
}
