// Messages between the page and the GPU export worker (phase 10d). The worker renders and encodes; the page keeps
// what needs the document (text bitmaps drawn with its fonts, served over `rasterPort`) and the ffmpeg.wasm runner
// (the audio and the final mux). Everything here is structured-clone data.
import type { ExportErrorCode, ExportInput, ExportSettings } from "../../types";
import type { ExportProgress, ExportResult } from "../../export-timeline";
import type { MuxPlan } from "../../compile/mux";
import type { GifPlan } from "../../args";
import type { ExportOutput, MuxVideo } from "../../runner";

/** How the worker fetches one media URL: the URL to request and its request options (auth only for the host's origin). */
export interface WorkerMediaRequest {
    url: string;
    headers?: Record<string, string>;
    credentials?: RequestCredentials;
}

/** A bundled font face for the worker's FontFaceSet (graphics draw text there). */
export interface WorkerFontSource {
    family: string;
    weight: string;
    style: string;
    /** CSS `src` value, e.g. `url(/assets/inter-latin-700.woff2) format("woff2")`. */
    src: string;
    unicodeRange?: string;
}

export type PageToWorker =
    | {
        type: "start";
        input: ExportInput;
        settings: ExportSettings;
        /** Media URL (as in the project) → how to fetch it. URLs missing here are unreadable. */
        media: Record<string, WorkerMediaRequest>;
        fonts: WorkerFontSource[];
        codecs?: string[];
        /** Stream the encoded video into the origin private file system. */
        opfs: boolean;
        /** Answers createRemoteRasterizer (the page's browser rasterizer). */
        rasterPort: MessagePort;
    }
    | { type: "cancel" }
    | { type: "mux-done"; id: number; output: ExportOutput }
    | { type: "mux-error"; id: number; code: ExportErrorCode | "unknown"; message: string; detail?: string };

export type WorkerToPage =
    | { type: "progress"; progress: ExportProgress }
    /** The last step on the page's runner: the audio mux, or the GIF step (phase 10d). */
    | { type: "mux"; id: number; step: "mux"; plan: MuxPlan; video: MuxVideo; container: "mp4" | "webm" | "mkv" }
    | { type: "mux"; id: number; step: "gif"; plan: GifPlan; video: MuxVideo; container: "mp4" | "webm" | "mkv" }
    | { type: "done"; result: ExportResult }
    | { type: "fallback"; reason: string }
    /** The worker cannot run the GPU path at all (no WebGL2 on OffscreenCanvas, no WebCodecs in workers). */
    | { type: "unavailable"; reason: string }
    | { type: "error"; code: ExportErrorCode | "unknown"; message: string; detail?: string };

/**
 * The buffer to transfer (not copy) with a message carrying in-memory video or file bytes: without OPFS the encoded
 * video and the finished file cross between worker and page, and a structured clone would copy each of them.
 */
export function bytesTransfer(value: { kind: string; data?: Uint8Array } | null | undefined): ArrayBuffer[] {
    const data = value?.kind === "bytes" ? value.data : undefined;
    if (!data || !(data.buffer instanceof ArrayBuffer)) return [];
    // Only a view over its whole buffer: transferring would otherwise detach bytes someone else still reads.
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? [data.buffer] : [];
}
