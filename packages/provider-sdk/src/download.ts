// Downloading generated media in a host process (desktop main, headless mcp serve): https only, redirects followed
// by hand and re-checked hop by hop (no downgrade to http, no loopback or private addresses), no credentials, a
// byte cap enforced while streaming, and a timeout. Browsers keep their own fetch (CSP limits where it may go).

export const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 3;

export interface DownloadOptions {
    fetch?: typeof globalThis.fetch;
    /** Plain http to 127.0.0.1/localhost (tests and e2e runs against a fake server only). */
    allowLoopback?: boolean;
    maxBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/** IPv4/IPv6 literals of loopback, private, link-local, and unspecified ranges, and localhost names. */
export function isPrivateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (host.includes(":")) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
    return false;
}

export function checkDownloadUrl(url: string, allowLoopback = false): URL {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("Generated media has an invalid link.");
    }
    if (parsed.username || parsed.password) throw new Error("Generated media links may not carry credentials.");
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.protocol === "http:" && loopback && allowLoopback) return parsed;
    if (parsed.protocol !== "https:") throw new Error("Generated media must come over https.");
    if (isPrivateHost(parsed.hostname) && !(loopback && allowLoopback)) throw new Error("Generated media may not come from a private address.");
    return parsed;
}

export async function downloadMedia(url: string, options: DownloadOptions = {}): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let target = checkDownloadUrl(url, options.allowLoopback);
    for (let hop = 0; ; hop++) {
        const response = await doFetch(target.href, { credentials: "omit", redirect: "manual", signal });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location || hop >= MAX_REDIRECTS) throw new Error("The download redirected too often.");
            target = checkDownloadUrl(new URL(location, target).href, options.allowLoopback);
            continue;
        }
        if (!response.ok) throw new Error(`The download answered ${response.status}.`);
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxBytes) throw new Error("The generated file is too large.");
        const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > maxBytes) throw new Error("The generated file is too large.");
            return { bytes, mimeType };
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error("The generated file is too large.");
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { bytes, mimeType };
    }
}
