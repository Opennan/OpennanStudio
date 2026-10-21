// Verified downloads: HTTPS only, redirects followed by hand and only to Hugging Face hosts, the body streamed
// through SHA-256 into a private temporary file that is renamed into place only when size and hash match.
import { createHash, randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { JobCancelledError } from "@opennan/provider-sdk";
import { checkAbsolutePath } from "./whisper-args";

/** huggingface.co and hf.co, with their subdomains (the /resolve/ URL redirects to a CDN host under hf.co). */
export function isAllowedDownloadHost(host: string): boolean {
    const h = host.toLowerCase();
    return h === "huggingface.co" || h.endsWith(".huggingface.co") || h === "hf.co" || h.endsWith(".hf.co");
}

export interface DownloadOptions {
    url: string;
    sha256: string;
    sizeBytes: number;
    /** Absolute path of the final file. */
    dest: string;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    onProgress?(received: number, total: number): void;
    /** Default 5. */
    maxRedirects?: number;
    /** Abort when no data arrives for this long (a stalled connection). Default 60 s. */
    idleTimeoutMs?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

function checkUrl(raw: string, base?: string): URL {
    let url: URL;
    try {
        url = new URL(raw, base);
    } catch {
        throw new Error("Download refused: not a URL");
    }
    if (url.protocol !== "https:") throw new Error(`Download refused: ${url.protocol} is not https`);
    if (!isAllowedDownloadHost(url.hostname)) throw new Error(`Download refused: ${url.hostname} is not an allowed host`);
    return url;
}

export async function downloadVerified(options: DownloadOptions): Promise<void> {
    const dest = checkAbsolutePath(options.dest, "download destination");
    const doFetch = options.fetch ?? fetch;
    const maxRedirects = options.maxRedirects ?? 5;
    const cancelled = () => options.signal?.aborted;
    // A connection that stops sending is aborted after idleTimeoutMs without data (re-armed on every chunk).
    const idle = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const stall = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stall.abort(), idle);
    };
    const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
    const stalled = () => new Error(`Download stalled: no data for ${Math.round(idle / 1000)} s`);
    arm();
    try {
        await download();
    } finally {
        clearTimeout(stallTimer);
    }

    async function download(): Promise<void> {
        let url = checkUrl(options.url);
        let response: Response | null = null;
        for (let hop = 0; ; hop += 1) {
            if (cancelled()) throw new JobCancelledError();
            let next: Response;
            try {
                next = await doFetch(url, { redirect: "manual", signal });
            } catch (error) {
                if (cancelled()) throw new JobCancelledError();
                if (stall.signal.aborted) throw stalled();
                throw error;
            }
            if (next.status >= 300 && next.status < 400) {
                const location = next.headers.get("location");
                void next.body?.cancel().catch(() => undefined);
                if (!location) throw new Error("Download refused: a redirect without a location");
                if (hop >= maxRedirects) throw new Error("Download refused: too many redirects");
                url = checkUrl(location, url.href);
                continue;
            }
            response = next;
            break;
        }
        if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
        const length = response.headers.get("content-length");
        if (length !== null && Number(length) !== options.sizeBytes) {
            void response.body.cancel().catch(() => undefined);
            throw new Error(`Download refused: ${path.basename(dest)} is ${length} bytes, expected ${options.sizeBytes}`);
        }
        const part = `${dest}.part-${randomBytes(6).toString("hex")}`;
        const handle = await open(part, "wx", 0o600);
        const hash = createHash("sha256");
        let received = 0;
        let done = false;
        try {
            try {
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                    arm();
                    received += chunk.byteLength;
                    if (received > options.sizeBytes) throw new Error(`Download refused: ${path.basename(dest)} is larger than ${options.sizeBytes} bytes`);
                    hash.update(chunk);
                    await handle.write(chunk);
                    options.onProgress?.(received, options.sizeBytes);
                }
            } catch (error) {
                if (cancelled()) throw new JobCancelledError();
                if (stall.signal.aborted) throw stalled();
                throw error;
            } finally {
                await handle.close();
            }
            if (cancelled()) throw new JobCancelledError();
            const actual = hash.digest("hex");
            if (received !== options.sizeBytes) throw new Error(`Download incomplete: ${received} of ${options.sizeBytes} bytes`);
            if (actual !== options.sha256) throw new Error(`SHA-256 mismatch for ${path.basename(dest)}: expected ${options.sha256}, got ${actual}`);
            await rename(part, dest);
            done = true;
        } finally {
            if (!done) await rm(part, { force: true });
        }
    }
}
