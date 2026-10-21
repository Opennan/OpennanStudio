// Uploads a file to OpenNan's storage for a cloud project (design §2.6, server S9/S10): POST /v1/uploads with the
// file's sha256, scope "account" and the project (200 = the account already has it: nothing is sent), then one PUT to
// the single-use gateway link (≤ 95 MB) or 32 MB parts with their ETags, then /complete. A used link (410) or an
// expired one (404) starts a new upload; a storage failure (502) or a rate limit (429) retries the same link. The
// PUT carries no credentials, follows no redirect, and goes only to the gateway, R2, or the API's own origin.
import { isPrivateHost } from "@opennan/provider-sdk";
import { CloudApiError, isAbortError, retryAfterSeconds, type CloudApi } from "./api";

export const DEFAULT_UPLOAD_HOSTS: readonly string[] = Object.freeze(["upload.opennan.com", "*.r2.cloudflarestorage.com"]);

export interface UploadStart {
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    /** The cloud project whose media bin gets the file (server id). */
    projectId?: string;
}

export interface UploadResult {
    assetId: string;
    mediaUrl: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    deduplicated: boolean;
}

export interface UploadBlobOptions {
    signal?: AbortSignal;
    onProgress?(sentBytes: number): void;
    allowedHosts?: readonly string[];
    /** Wait before retrying a failed PUT (tests: 0). */
    retryDelayMs?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_RESTARTS = 2;
const MAX_PUT_ATTEMPTS = 3;

function hostMatches(hostname: string, pattern: string): boolean {
    const want = pattern.trim().toLowerCase();
    if (want.startsWith("*.")) return hostname.endsWith(want.slice(1)) && hostname.length > want.length - 1;
    return hostname === want;
}

export function isAllowedUploadTarget(value: string, apiBase: string, allowedHosts: readonly string[] = DEFAULT_UPLOAD_HOSTS): boolean {
    let url: URL;
    let base: URL;
    try {
        url = new URL(value);
        base = new URL(apiBase);
    } catch {
        return false;
    }
    if (url.username || url.password) return false;
    if (url.protocol === "https:") {
        if (base.protocol === "https:" && url.origin === base.origin) return true;
        const hostname = url.hostname.toLowerCase();
        if (isPrivateHost(hostname)) return false;
        return allowedHosts.some((pattern) => hostMatches(hostname, pattern));
    }
    return url.protocol === "http:" && base.protocol === "http:" && LOOPBACK.has(base.hostname) && url.origin === base.origin;
}

interface Started {
    upload_id?: unknown;
    upload_url?: unknown;
    media_url?: unknown;
    headers?: Record<string, unknown> | null;
    multipart?: { part_size?: unknown; parts?: Array<{ number?: unknown; size?: unknown; url?: unknown }> } | null;
    deduplicated?: unknown;
    asset_id?: unknown;
    content_type?: unknown;
    size_bytes?: unknown;
}

class RestartUpload extends Error {}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException("Upload aborted", "AbortError"));
        }, { once: true });
    });
}

async function putOnce(fetch: typeof globalThis.fetch, url: string, body: Blob, contentType: string, options: UploadBlobOptions): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body, signal: options.signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
        } catch (error) {
            if (isAbortError(error) || options.signal?.aborted) throw error;
            if (attempt >= MAX_PUT_ATTEMPTS) throw new CloudApiError(0, "network", "Can't reach OpenNan's storage.", { cause: error });
            await sleep(options.retryDelayMs ?? 1000 * attempt, options.signal);
            continue;
        }
        if (response.ok) {
            const header = response.headers.get("etag");
            let etag = header ? header.replace(/^W\//, "").replace(/"/g, "") : null;
            if (!etag) {
                try {
                    const json = await response.json() as { etag?: unknown };
                    if (typeof json.etag === "string") etag = json.etag;
                } catch {
                    // no body
                }
            }
            return etag;
        }
        let code = "";
        try {
            code = String(((await response.json()) as { error?: { code?: unknown } }).error?.code ?? "");
        } catch {
            // not JSON
        }
        if (response.status === 410 || response.status === 404) throw new RestartUpload(code || String(response.status));
        if ((response.status === 502 || response.status === 503 || response.status === 429) && attempt < MAX_PUT_ATTEMPTS) {
            const wait = response.status === 429 ? (retryAfterSeconds(response.headers.get("retry-after"), Date.now()) ?? 60) * 1000 : options.retryDelayMs ?? 1000 * attempt;
            await sleep(wait, options.signal);
            continue;
        }
        throw new CloudApiError(response.status, code || "upload_failed", `The upload to OpenNan's storage failed (HTTP ${response.status}).`);
    }
}

/** Uploads `blob` (the file itself, or a disk-backed Blob) and returns the stored file. */
export async function uploadBlob(api: CloudApi, fetch: typeof globalThis.fetch, blob: Blob, start: UploadStart, options: UploadBlobOptions = {}): Promise<UploadResult> {
    for (let restart = 0; ; restart++) {
        try {
            return await attempt(api, fetch, blob, start, options);
        } catch (error) {
            if (!(error instanceof RestartUpload) || restart >= MAX_RESTARTS) {
                if (error instanceof RestartUpload) throw new CloudApiError(410, "upload_url_used", "The upload link could not be used. Try again.");
                throw error;
            }
        }
    }
}

async function attempt(api: CloudApi, fetch: typeof globalThis.fetch, blob: Blob, start: UploadStart, options: UploadBlobOptions): Promise<UploadResult> {
    const body = {
        filename: (start.filename || "media").slice(0, 255), content_type: start.contentType, size_bytes: start.sizeBytes, sha256: start.sha256, scope: "account",
        ...(start.projectId ? { project_id: start.projectId } : {}), multipart: true,
    };
    const answer = await api.request<Started>("POST", "/v1/uploads", { body, ...(options.signal ? { signal: options.signal } : {}) });
    const started = answer.body;
    if (answer.status === 200 && started.deduplicated === true && typeof started.asset_id === "string" && typeof started.media_url === "string") {
        options.onProgress?.(start.sizeBytes);
        return { assetId: started.asset_id, mediaUrl: started.media_url, contentType: start.contentType, sizeBytes: start.sizeBytes, sha256: start.sha256, deduplicated: true };
    }
    const id = typeof started.upload_id === "string" ? started.upload_id : null;
    if (!id) throw new CloudApiError(0, "invalid_response", "OpenNan did not say where to upload.");
    const allowed = (url: unknown): url is string => typeof url === "string" && isAllowedUploadTarget(url, api.baseUrl, options.allowedHosts);
    const given = started.headers?.["Content-Type"];
    const contentType = typeof given === "string" ? given : start.contentType;
    let completeBody: { parts: Array<{ number: number; etag: string }> } | undefined;
    if (started.multipart && Array.isArray(started.multipart.parts)) {
        // Checked before any byte is sent: OpenNan storage links, and parts numbered 1..n that make up the file, sliced
        // by their numbers whatever order they are listed in.
        const listed = started.multipart.parts.map((part) => ({ number: Number(part.number), size: Number(part.size), url: part.url }));
        if (listed.some((part) => !allowed(part.url))) throw new CloudApiError(0, "invalid_upload_url", "OpenNan sent an upload address Studio will not use.");
        listed.sort((a, b) => a.number - b.number);
        const total = listed.reduce((sum, part) => sum + part.size, 0);
        if (listed.length === 0 || listed.some((part, i) => part.number !== i + 1 || !Number.isInteger(part.size) || part.size < 1) || total !== start.sizeBytes) {
            throw new CloudApiError(0, "invalid_response", "OpenNan listed upload parts that don't make up the file.");
        }
        const parts: Array<{ number: number; etag: string }> = [];
        let offset = 0;
        for (const part of listed) {
            const { number, size } = part;
            const etag = await putOnce(fetch, part.url as string, blob.slice(offset, offset + size, contentType), contentType, options);
            if (!etag) throw new CloudApiError(0, "invalid_response", "OpenNan's storage did not confirm a part.");
            parts.push({ number, etag });
            offset += size;
            options.onProgress?.(offset);
        }
        completeBody = { parts };
    } else {
        if (!allowed(started.upload_url)) throw new CloudApiError(0, "invalid_upload_url", "OpenNan sent an upload address Studio will not use.");
        await putOnce(fetch, started.upload_url, blob, contentType, options);
        options.onProgress?.(start.sizeBytes);
    }
    const complete = async () => (await api.request<Record<string, unknown>>("POST", `/v1/uploads/${encodeURIComponent(id)}/complete`, {
        ...(completeBody ? { body: completeBody } : {}), ...(options.signal ? { signal: options.signal } : {}),
    })).body;
    let done: Record<string, unknown>;
    try {
        done = await complete();
    } catch (error) {
        if (error instanceof CloudApiError && error.code === "upload_parts_invalid") throw new RestartUpload(error.code);
        if (error instanceof CloudApiError && error.code === "upload_not_received" && !completeBody) {
            await putOnce(fetch, started.upload_url as string, blob, contentType, options).catch((e) => {
                if (e instanceof RestartUpload) throw e;
                throw e;
            });
            done = await complete();
        } else {
            throw error;
        }
    }
    const mediaUrl = typeof done.media_url === "string" ? done.media_url : typeof started.media_url === "string" ? started.media_url : null;
    const assetId = typeof done.asset_id === "string" ? done.asset_id : null;
    if (!mediaUrl || !assetId) throw new CloudApiError(0, "invalid_response", "OpenNan did not say where the upload is.");
    return { assetId, mediaUrl, contentType: start.contentType, sizeBytes: start.sizeBytes, sha256: start.sha256, deduplicated: false };
}

/** The server's upload content types (content type → most bytes) and the extension a file name gets. */
export const CLOUD_MEDIA_TYPES: Readonly<Record<string, number>> = {
    "image/png": 20 * 1024 * 1024, "image/jpeg": 20 * 1024 * 1024, "image/webp": 20 * 1024 * 1024, "image/gif": 20 * 1024 * 1024,
    "video/mp4": 1024 * 1024 * 1024, "video/quicktime": 1024 * 1024 * 1024, "video/webm": 1024 * 1024 * 1024,
    "audio/mpeg": 200 * 1024 * 1024, "audio/wav": 200 * 1024 * 1024, "audio/mp4": 200 * 1024 * 1024, "audio/ogg": 200 * 1024 * 1024, "audio/flac": 200 * 1024 * 1024,
};

const ALIASES: Record<string, string> = { "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/mp3": "audio/mpeg", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "image/jpg": "image/jpeg", "audio/x-flac": "audio/flac" };

/** The content type OpenNan takes for a file, or null with a reason. */
export function cloudContentType(mimeType: string, sizeBytes: number): { contentType: string } | { refused: string } {
    const type = ALIASES[mimeType.toLowerCase()] ?? mimeType.toLowerCase();
    const cap = CLOUD_MEDIA_TYPES[type];
    if (cap === undefined) return { refused: `OpenNan cloud projects can't hold ${mimeType || "this kind of"} files. Convert it to MP4, MOV or WebM (video), MP3, WAV, M4A, OGG or FLAC (audio), or PNG, JPEG, WebP or GIF (image) first.` };
    if (sizeBytes > cap) return { refused: `This file is larger than the ${Math.round(cap / (1024 * 1024))} MB OpenNan takes for ${type}.` };
    return { contentType: type };
}
