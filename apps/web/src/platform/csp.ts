// The web app's Content Security Policy (phase 8), written into index.html at build time (vite.config.ts). The page
// runs only its own scripts (plus blob: for the SHA-256-checked ffmpeg.wasm core and WebAssembly), and connects
// only to itself, the OpenNan API (and opennan.com downloads), fal.ai's queue and files, and the ffmpeg core's host.
// 'unsafe-eval' is for regl (GL effects compile draw commands with Function), as on desktop.

/** Hosts generated media may be downloaded from (the import needs fetch, so connect-src). */
export const MEDIA_CONNECT_SOURCES = ["https://*.opennan.com", "https://queue.fal.run", "https://*.fal.media", "https://fal.media"];
/**
 * Hosts AI tools upload the user's media to (phase 11): OpenNan's presigned PUT URLs on its R2 bucket, and fal.ai's
 * storage API (bring-your-own key). The PUTs carry no credentials (provider-opennan uploads.ts, provider-fal).
 */
export const UPLOAD_CONNECT_SOURCES = ["https://*.r2.cloudflarestorage.com", "https://rest.alpha.fal.ai"];

export interface CspOptions {
    apiBase: string;
    /** VITE_FFMPEG_CORE_BASE when it points at another origin. */
    ffmpegCoreBase?: string;
}

function originOf(value: string | undefined): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
    } catch {
        return null;
    }
}

export function studioCsp(options: CspOptions): string {
    const api = originOf(options.apiBase);
    const core = originOf(options.ffmpegCoreBase);
    const connect = ["'self'", "blob:", "data:", ...(api ? [api] : []), ...MEDIA_CONNECT_SOURCES, ...UPLOAD_CONNECT_SOURCES, ...(core ? [core] : [])];
    const directives: Array<[string, string[]]> = [
        ["default-src", ["'self'"]],
        ["script-src", ["'self'", "blob:", "'unsafe-eval'", "'wasm-unsafe-eval'"]],
        ["style-src", ["'self'", "'unsafe-inline'"]],
        ["img-src", ["'self'", "data:", "blob:", "https:"]],
        ["media-src", ["'self'", "data:", "blob:"]],
        ["connect-src", [...new Set(connect)]],
        ["worker-src", ["'self'", "blob:"]],
        ["font-src", ["'self'", "data:"]],
        ["object-src", ["'none'"]],
        ["base-uri", ["'none'"]],
        ["form-action", ["'none'"]],
        ["frame-src", ["'none'"]],
    ];
    return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** The <meta> tag for index.html. */
export function cspMetaTag(policy: string): string {
    return `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}" />`;
}
