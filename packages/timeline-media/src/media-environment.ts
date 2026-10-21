// Host-provided media policy: how URLs are resolved for <img>/<video>/fetch,
// optional auth headers, and an optional precomputed waveform source. Replaces
// the app's media proxy URL rewriting (SRC/lib/preview-media-url.ts:9) and the
// Firebase-authenticated waveform endpoint (waveform-generator.ts:17-45).
import type { WaveformData } from "@opennan/timeline-core/timeline/canvas/types";

export interface MediaEnvironment {
    resolveMediaUrl(url: string): string;
    getAuthHeaders?(): Promise<Record<string, string>>;
    fetchWaveform?(url: string, signal?: AbortSignal): Promise<WaveformData | null>;
    /** False when the browser must not fetch raw bytes for this URL (WebAudio decode). */
    canFetchMediaBytes?(url: string): boolean;
    /** True when the preview may preload the URL into a blob URL. */
    shouldPreloadBlob?(url: string): boolean;
    /** Origin used for CORS decisions; defaults to location.origin in browsers. */
    origin?: string;
}

export const LOCAL_MEDIA_PROTOCOL = "opennan-local:";

export const IDENTITY_MEDIA_ENVIRONMENT: MediaEnvironment = Object.freeze({
    resolveMediaUrl: (url: string) => url,
});

export interface BrowserMediaEnvironmentOptions {
    /** Resolves opennan-local:// URLs (LocalBackend uploads) to blob: URLs. */
    resolveLocalUrl?(url: string): string | null;
    origin?: string;
    getAuthHeaders?(): Promise<Record<string, string>>;
    fetchWaveform?(url: string, signal?: AbortSignal): Promise<WaveformData | null>;
}

export function createBrowserMediaEnvironment(options: BrowserMediaEnvironmentOptions = {}): MediaEnvironment {
    const origin = options.origin ?? (typeof location !== "undefined" ? location.origin : undefined);
    const resolve = (url: string): string => (
        url.startsWith(LOCAL_MEDIA_PROTOCOL) ? options.resolveLocalUrl?.(url) ?? url : url
    );
    return {
        resolveMediaUrl: resolve,
        getAuthHeaders: options.getAuthHeaders,
        fetchWaveform: options.fetchWaveform,
        origin,
        canFetchMediaBytes(url: string): boolean {
            const resolved = resolve(url);
            return /^(https?:|blob:|data:)/.test(resolved) || resolved.startsWith("/");
        },
        shouldPreloadBlob(url: string): boolean {
            if (!origin) return false;
            try {
                const parsed = new URL(resolve(url), origin);
                return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin;
            } catch {
                return false;
            }
        },
    };
}
