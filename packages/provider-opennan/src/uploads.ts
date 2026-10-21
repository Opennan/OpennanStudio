// Uploads to OpenNan's storage (phase 11, gateway since 9a): POST /v1/uploads (201: an upload URL bound to the content
// type and exact size: the single-use gateway https://upload.opennan.com/u/<token>, or a presigned R2 PUT) → PUT the
// bytes to upload_url → POST /v1/uploads/{id}/complete. Tool inputs send no project_id and no scope, so the server
// keeps them as temporary uploads (scope "temp", deleted after the task). Over 95 MiB (or when the server answers
// multipart_required) the start asks for parts: each listed part is PUT on its own single-use link and the ETags go to
// /complete (phase 9a.1). A gateway URL takes one PUT: a 410
// upload_url_used (or a second PUT after complete's upload_not_received) starts a new upload, once. The key goes only to
// the API; the PUT carries no Authorization, no cookies, no referrer, follows no redirect, and goes only to https on
// OpenNan's storage (the gateway, R2 presigned hosts, or hosts a self-hosted setup allows explicitly) or the API's own
// origin, never to a private or loopback address literal (plain http only to the loopback origin of a loopback API: the
// fake server). Results are cached by the SHA-256 of the bytes and the content type in the cache the caller passes: the
// provider passes one per task, so a temporary upload is never reused after its task ends.
import { isPrivateHost, type PreparedMedia } from "@opennan/provider-sdk";
import type { OpenNanApi } from "./api";
import { OPENNAN_ERROR_COPY, OpenNanApiError, UPLOAD_SCOPE_MESSAGE, openNanErrorMessage } from "./errors";

export { UPLOAD_SCOPE_MESSAGE };

/** The server's upload types (content type → most bytes). */
export const UPLOAD_CONTENT_TYPES: Readonly<Record<string, number>> = {
    "image/png": 20 * 1024 * 1024, "image/jpeg": 20 * 1024 * 1024, "image/webp": 20 * 1024 * 1024, "image/gif": 20 * 1024 * 1024,
    "video/mp4": 1024 * 1024 * 1024, "video/quicktime": 1024 * 1024 * 1024, "video/webm": 1024 * 1024 * 1024,
    "audio/mpeg": 200 * 1024 * 1024, "audio/wav": 200 * 1024 * 1024, "audio/mp4": 200 * 1024 * 1024, "audio/ogg": 200 * 1024 * 1024, "audio/flac": 200 * 1024 * 1024,
};

export interface UploadedMedia {
    /** Use in tool bodies (audio_url, video_url, image). */
    mediaUrl: string;
    assetId?: string;
    contentType: string;
    sizeBytes: number;
    /** How the server keeps it ("temp" for a tool input), when it says. */
    scope?: string;
    /** When a temporary upload is deleted at the latest, when the server says. */
    expiresAt?: string;
}

export type UploadCache = Map<string, UploadedMedia>;

/**
 * Hosts an upload URL may name besides the API's own origin: R2 presigned PUTs and the upload gateway. "*.x" matches any
 * subdomain of x.
 */
export const DEFAULT_UPLOAD_HOSTS: readonly string[] = Object.freeze(["*.r2.cloudflarestorage.com", "upload.opennan.com"]);

/** Files over this go in parts (the server's single-PUT limit, 95 MiB). */
export const SINGLE_PUT_MAX_BYTES = 95 * 1024 * 1024;

export interface UploadOptions {
    signal: AbortSignal;
    cache?: UploadCache;
    /** Hosts the PUT may go to besides the API's own origin (default DEFAULT_UPLOAD_HOSTS); widen only on purpose. */
    allowedHosts?: readonly string[];
    /** Files larger than this ask for parts up front (default SINGLE_PUT_MAX_BYTES; tests lower it). */
    singlePutMaxBytes?: number;
}

interface Presigned {
    upload_id?: unknown;
    upload_url?: unknown;
    headers?: Record<string, unknown> | null;
    media_url?: unknown;
    multipart?: { part_size?: unknown; parts?: Array<{ number?: unknown; size?: unknown; url?: unknown }> } | null;
}

interface Completed {
    asset_id?: unknown;
    media_url?: unknown;
    scope?: unknown;
    expires_at?: unknown;
}

/** A PUT whose single-use URL was already used (the gateway's 410 upload_url_used). */
class UploadUrlUsed extends Error {}
/** The server wants this file in parts (multipart_required): ask again with multipart: true. */
class PartsWanted extends Error {}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostMatches(hostname: string, pattern: string): boolean {
    const want = pattern.trim().toLowerCase();
    if (want.startsWith("*.")) return hostname.endsWith(want.slice(1)) && hostname.length > want.length - 1;
    return hostname === want;
}

/**
 * https without credentials to the API's own origin or a host in `allowedHosts`, never a private or loopback address
 * literal; plain http only on the API's own origin when the API is on loopback (the fake server).
 */
export function isAllowedUploadUrl(value: string, apiBase: string, allowedHosts: readonly string[] = DEFAULT_UPLOAD_HOSTS): boolean {
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

async function bytesOf(data: Blob | Uint8Array): Promise<Uint8Array> {
    return data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
}

async function contentKey(bytes: Uint8Array, contentType: string): Promise<string> {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
    let hex = "";
    for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
    return `${hex}:${contentType}`;
}

function isAbort(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

export async function uploadMedia(api: OpenNanApi, key: string, prepared: PreparedMedia, options: UploadOptions): Promise<UploadedMedia> {
    const { signal, cache, allowedHosts } = options;
    const contentType = prepared.contentType;
    const cap = UPLOAD_CONTENT_TYPES[contentType];
    if (cap === undefined) throw new OpenNanApiError(0, "unsupported_type", `OpenNan cannot take ${contentType} files.`);
    const bytes = await bytesOf(prepared.data);
    if (bytes.byteLength > cap) throw new OpenNanApiError(0, "too_large", `The file is larger than the ${Math.round(cap / (1024 * 1024))} MB OpenNan takes for ${contentType}.`);
    const cacheKey = await contentKey(bytes, contentType);
    const cached = cache?.get(cacheKey);
    if (cached) return cached;

    // A refused complete as a typed error in Studio's words (the server's text names sizes and keys of its storage).
    const typed = (error: unknown): unknown => {
        if (!(error instanceof OpenNanApiError) || !error.fromServer) return error;
        return new OpenNanApiError(error.status, error.code, openNanErrorMessage(error, { upload: true }), { cause: error, ...(error.type ? { type: error.type } : {}) });
    };

    // Over the single-PUT limit (or when the server says so) the file goes in the parts the server lists (phase 9a.1).
    let multipart = bytes.byteLength > (options.singlePutMaxBytes ?? SINGLE_PUT_MAX_BYTES);
    const invalidUrl = () => new OpenNanApiError(0, "invalid_upload_url", "OpenNan sent an upload address Studio will not use.");

    /** One PUT of `body` to a single-use link; its ETag (header or JSON). Throws UploadUrlUsed on a 410 or 404. */
    const putTo = async (target: string, putType: string, body: Uint8Array): Promise<string | null> => {
        let response: Response;
        try {
            response = await api.fetch(target, {
                method: "PUT", headers: { "Content-Type": putType }, body: body as Uint8Array<ArrayBuffer>, signal,
                credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
            });
        } catch (error) {
            if (isAbort(error) || signal.aborted) throw error;
            throw new OpenNanApiError(0, "network", "Can't reach OpenNan's storage.", { cause: error });
        }
        // A used link (410) or an expired or unknown one (the gateway's 404 upload_not_found): start a new upload.
        if (response.status === 410 || response.status === 404) throw new UploadUrlUsed();
        if (!response.ok) throw new OpenNanApiError(response.status, "upload_failed", `The upload to OpenNan's storage failed (HTTP ${response.status}).`);
        const header = response.headers.get("etag");
        if (header) return header.replace(/^W\//, "").replace(/"/g, "");
        try {
            const answer = await response.json() as { etag?: unknown };
            return typeof answer.etag === "string" ? answer.etag : null;
        } catch {
            return null;
        }
    };

    /** One upload: start, PUT (or parts), complete (a not-received complete PUTs once more). Throws UploadUrlUsed on a 410. */
    async function attempt(): Promise<{ presigned: Presigned; done: Completed }> {
        let presigned: Presigned;
        try {
            presigned = await api.request<Presigned>("POST", "/v1/uploads", {
                apiKey: key, signal, body: { filename: (prepared.filename || "media").slice(0, 255), content_type: contentType, size_bytes: bytes.byteLength, ...(multipart ? { multipart: true } : {}) },
            });
        } catch (error) {
            if (error instanceof OpenNanApiError && error.status === 403 && (error.code === "permission_denied" || error.code === "forbidden")) {
                throw new OpenNanApiError(403, error.code, UPLOAD_SCOPE_MESSAGE, { cause: error });
            }
            if (error instanceof OpenNanApiError && error.code === "multipart_required" && !multipart) throw new PartsWanted();
            throw typed(error);
        }
        const id = typeof presigned.upload_id === "string" ? presigned.upload_id : null;
        if (!id) throw invalidUrl();
        const given = presigned.headers?.["Content-Type"];
        const putType = typeof given === "string" ? given : contentType;
        const complete = (body?: { parts: Array<{ number: number; etag: string }> }) => api.request<Completed>("POST", `/v1/uploads/${encodeURIComponent(id)}/complete`, { apiKey: key, signal, ...(body ? { body } : {}) });

        if (presigned.multipart && Array.isArray(presigned.multipart.parts)) {
            // Every part is checked before any byte is sent: numbers, sizes adding up to the file, OpenNan storage links.
            const parts = presigned.multipart.parts.map((part) => ({ number: Number(part.number), size: Number(part.size), url: part.url }));
            if (parts.some((part) => typeof part.url !== "string" || !isAllowedUploadUrl(part.url, api.baseUrl, allowedHosts))) throw invalidUrl();
            // Sliced by number, whatever order they are listed in; the numbers must be exactly 1..n.
            parts.sort((a, b) => a.number - b.number);
            const total = parts.reduce((sum, part) => sum + part.size, 0);
            if (parts.length === 0 || parts.some((part, i) => part.number !== i + 1 || !Number.isInteger(part.size) || part.size < 1) || total !== bytes.byteLength) {
                throw new OpenNanApiError(0, "invalid_response", "OpenNan listed upload parts that don't make up the file.");
            }
            const sent: Array<{ number: number; etag: string }> = [];
            let offset = 0;
            for (const part of parts) {
                const etag = await putTo(part.url as string, putType, bytes.subarray(offset, offset + part.size));
                if (!etag) throw new OpenNanApiError(0, "invalid_response", "OpenNan's storage did not confirm a part.");
                sent.push({ number: part.number, etag });
                offset += part.size;
            }
            try {
                return { presigned, done: await complete({ parts: sent.sort((a, b) => a.number - b.number) }) };
            } catch (error) {
                // Parts the storage doesn't have as sent: the whole upload once more.
                if (error instanceof OpenNanApiError && error.code === "upload_parts_invalid") throw new UploadUrlUsed();
                throw typed(error);
            }
        }

        const target = typeof presigned.upload_url === "string" ? presigned.upload_url : null;
        if (!target || !isAllowedUploadUrl(target, api.baseUrl, allowedHosts)) throw invalidUrl();
        const put = () => putTo(target, putType, bytes);
        await put();
        try {
            return { presigned, done: await complete() };
        } catch (error) {
            // The storage did not have the file yet (upload_not_received; an older server: any 409): send it once more.
            const notReceived = error instanceof OpenNanApiError && (error.code === "upload_not_received" || (error.status === 409 && !error.code.startsWith("upload_")));
            if (!notReceived) throw typed(error);
            await put();
            try {
                return { presigned, done: await complete() };
            } catch (again) {
                throw typed(again);
            }
        }
    }

    /** attempt(), asking again with parts when the server wants them (that is not a restart). */
    const attemptWithParts = async () => {
        try {
            return await attempt();
        } catch (error) {
            if (!(error instanceof PartsWanted)) throw error;
            multipart = true;
            return attempt();
        }
    };

    let result: { presigned: Presigned; done: Completed };
    try {
        result = await attemptWithParts();
    } catch (error) {
        if (!(error instanceof UploadUrlUsed)) throw error;
        // The single-use URL was used already (a retried PUT): a new upload, once.
        try {
            result = await attemptWithParts();
        } catch (again) {
            if (again instanceof UploadUrlUsed) throw new OpenNanApiError(410, "upload_url_used", OPENNAN_ERROR_COPY.upload_url_used, { type: "conflict" });
            throw again;
        }
    }
    const { presigned, done } = result;
    const mediaUrl = typeof done.media_url === "string" ? done.media_url : typeof presigned.media_url === "string" ? presigned.media_url : null;
    if (!mediaUrl) throw new OpenNanApiError(0, "invalid_response", "OpenNan did not say where the upload is.");
    const uploaded: UploadedMedia = { mediaUrl, contentType, sizeBytes: bytes.byteLength };
    if (typeof done.asset_id === "string") uploaded.assetId = done.asset_id;
    if (typeof done.scope === "string") uploaded.scope = done.scope;
    if (typeof done.expires_at === "string") uploaded.expiresAt = done.expires_at;
    cache?.set(cacheKey, uploaded);
    return uploaded;
}
