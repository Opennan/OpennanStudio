// GPU export options for browser hosts (phase 10c): mediabunny loaded on demand, media read through ranged
// requests (blob: URLs as Blobs), auth headers only for the media environment's own origin (as the ffmpeg.wasm
// media reader does), and the preview's WebGL2 LookRenderer on a canvas of its own.
import { LookRenderer, isWebGl2Available } from "@opennan/timeline-media/looks/look-renderer";
import type { GlFrameProcessor } from "../gl";
import type { GpuExportOptions } from "../gpu/gpu-export";
import type { WorkerMediaRequest } from "../gpu/worker/protocol";
import { createFetchMediaReader, type FetchMediaEnvironment, type FetchMediaReaderOptions } from "./fetch-media-reader";
import { createOpfsVideoSink, opfsAvailable } from "./opfs";

type VideoCodec = import("mediabunny").VideoCodec;

export interface BrowserGpuExportOptions extends FetchMediaReaderOptions {
    glProcessor?: GlFrameProcessor;
    codecs?: VideoCodec[];
    /** Bytes a media demuxer caches (default 16 MiB per open file). */
    cacheBytes?: number;
    /**
     * Run the export in a worker (phase 10d): `create` makes a `@opennan/export/gpu-worker` module worker. With
     * `opfs`, the encoded video streams into the origin private file system (pair it with the wasm runner's
     * streamMux so the final file is written there too).
     */
    worker?: { create(): Worker; opfs?: boolean };
    /** Without a worker: stream the encoded video into the origin private file system. */
    opfs?: boolean;
}

export function createBrowserGpuExport(media: FetchMediaEnvironment, options: BrowserGpuExportOptions = {}): GpuExportOptions {
    const readMedia = createFetchMediaReader(media, options);
    const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
    const home = media.origin ?? (typeof location !== "undefined" ? location.origin : undefined);
    const trusted = new Set([home, ...(options.authOrigins ?? [])].filter((origin): origin is string => Boolean(origin)));
    /** How a worker fetches `url`: the resolved URL and, for the host's own origins only, its auth headers. */
    const request = async (url: string): Promise<WorkerMediaRequest | null> => {
        if (media.canFetchMediaBytes && !media.canFetchMediaBytes(url)) return null;
        const resolved = media.resolveMediaUrl(url);
        const target = new URL(resolved, home);
        if (target.protocol === "blob:" || target.protocol === "data:") return { url: target.href };
        if (target.protocol === "javascript:" || target.protocol === "file:") return null;
        // A host scheme (the desktop app's media protocol): fetched as is, never with auth headers.
        if (target.protocol !== "https:" && target.protocol !== "http:") return { url: target.href, credentials: "omit" };
        const sendAuth = trusted.has(target.origin);
        const headers = sendAuth && media.getAuthHeaders ? await media.getAuthHeaders() : undefined;
        return { url: target.href, ...(headers ? { headers: { ...headers } } : {}), credentials: sendAuth ? "same-origin" : "omit" };
    };
    const opfs = (options.worker?.opfs ?? options.opfs ?? false) && opfsAvailable();
    return {
        loadMediabunny: () => import("mediabunny"),
        async createSource(url, mb) {
            if (media.canFetchMediaBytes && !media.canFetchMediaBytes(url)) throw new Error(`This media cannot be fetched by the browser: ${url}`); // i18n-ignore
            const resolved = media.resolveMediaUrl(url);
            const target = new URL(resolved, home);
            if (target.protocol === "blob:" || target.protocol === "data:") return new mb.BlobSource(await (await fetchImpl(resolved)).blob());
            const sendAuth = (target.protocol === "https:" || target.protocol === "http:") && trusted.has(target.origin);
            const headers = sendAuth && media.getAuthHeaders ? await media.getAuthHeaders() : undefined;
            return new mb.UrlSource(resolved, {
                requestInit: { headers, credentials: sendAuth ? "same-origin" : "omit" },
                maxCacheSize: options.cacheBytes ?? 16 * 2 ** 20,
                fetchFn: fetchImpl,
            });
        },
        async fetchBlob(url, signal) {
            return new Blob([new Uint8Array(await readMedia(url, signal))]);
        },
        createRenderer: () => (isWebGl2Available() ? new LookRenderer() : null),
        isAvailable: isWebGl2Available,
        glProcessor: options.glProcessor,
        codecs: options.codecs,
        ...(opfs && !options.worker ? { createVideoSink: (container: "mp4" | "webm") => createOpfsVideoSink(container) } : {}),
        ...(options.worker ? { worker: { create: options.worker.create, request, opfs } } : {}),
    };
}
