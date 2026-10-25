// opennan-media://blob/<uuid>: one stored media file for the preview (spec §7.2 "local media library with
// file-path URLs"). Byte ranges for seeking and frame decoding, CORS for the app origin only (preview media
// use crossOrigin="anonymous"), and nothing else: unknown hosts, ids, and refused URLs answer 403.
import fs from "node:fs";
import { Readable } from "node:stream";
import { isUuid } from "../../shared/ids";
import type { MediaStore } from "../store/media-store";
import { APP_ORIGIN } from "./csp";

export type ByteRange = { start: number; end: number };

/** A single `bytes=` range against `size`: the range, "unsatisfiable", or null (serve the whole file). */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (match[1] === "" && match[2] === "")) return null;
    if (match[1] === "") {
        const suffix = Number(match[2]);
        if (suffix === 0) return "unsatisfiable";
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(match[1]);
    const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size || end < start) return "unsatisfiable";
    return { start, end };
}

const refuse = () => new Response(null, { status: 403 });

function baseHeaders(mimeType: string): Record<string, string> {
    return {
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": APP_ORIGIN,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
    };
}

export function createMediaProtocolHandler(media: Pick<MediaStore, "pathOf" | "info">): (request: Request) => Promise<Response> {
    return async (request) => {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            return refuse();
        }
        const id = url.pathname.replace(/^\//, "");
        if (url.host !== "blob" || !isUuid(id) || url.search || url.hash) return refuse();
        const file = media.pathOf(id);
        const info = media.info(id);
        if (!file || !info) return refuse();
        let size: number;
        try {
            size = (await fs.promises.stat(file)).size;
        } catch {
            return new Response(null, { status: 404 });
        }
        const headers = baseHeaders(info.mimeType);
        const range = parseRange(request.headers.get("range"), size);
        if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
        const start = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        const length = size === 0 ? 0 : end - start + 1;
        const status = range ? 206 : 200;
        Object.assign(headers, { "Content-Length": String(length) }, range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {});
        if (request.method === "HEAD" || length === 0) return new Response(null, { status, headers });
        const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>;
        return new Response(body, { status, headers });
    };
}
