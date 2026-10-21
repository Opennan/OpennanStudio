// readMedia for createWasmRunner. Auth headers go only to the media environment's own origin or an
// explicit allowlist: a project's mediaUrl can name any host, and the user's token must not leak there.
// Structurally a timeline-media MediaEnvironment (media-environment.ts), without importing the optional peer.
export interface FetchMediaEnvironment {
    resolveMediaUrl(url: string): string;
    getAuthHeaders?(): Promise<Record<string, string>>;
    /** False when the browser must not fetch raw bytes for this URL. */
    canFetchMediaBytes?(url: string): boolean;
    /** Origin that may receive auth headers. Default: location.origin in browsers. */
    origin?: string;
}

export interface FetchMediaReaderOptions {
    /** More origins that may receive auth headers (for example the OpenNan API in phase 8). */
    authOrigins?: string[];
    fetch?: typeof fetch;
}

export function createFetchMediaReader(media: FetchMediaEnvironment, options: FetchMediaReaderOptions = {}) {
    const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
    const home = media.origin ?? (typeof location !== "undefined" ? location.origin : undefined);
    const trusted = new Set([home, ...(options.authOrigins ?? [])].filter((origin): origin is string => Boolean(origin)));
    return async (url: string, signal?: AbortSignal): Promise<Uint8Array> => {
        if (media.canFetchMediaBytes && !media.canFetchMediaBytes(url)) throw new Error(`This media cannot be fetched by the browser: ${url}`);
        const resolved = media.resolveMediaUrl(url);
        let target: URL;
        try {
            target = new URL(resolved, home);
        } catch {
            throw new Error(`Unreadable media URL: ${url}`);
        }
        // blob: and data: URLs need no auth; http(s) gets the token only on a trusted origin.
        const sendAuth = (target.protocol === "https:" || target.protocol === "http:") && trusted.has(target.origin);
        const headers = sendAuth && media.getAuthHeaders ? await media.getAuthHeaders() : undefined;
        const response = await fetchImpl(resolved, { signal, headers, credentials: sendAuth ? "same-origin" : "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return new Uint8Array(await response.arrayBuffer());
    };
}
