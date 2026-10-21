// Loads the ffmpeg.wasm core (GPL-2.0-or-later, never bundled) and checks its SHA-256 before it runs:
// the core executes in a worker of the app's origin, so unchecked bytes could read the app's storage.
// Pinned to @ffmpeg/core 0.12.10 dist/esm (the ESM build: bundlers start @ffmpeg/ffmpeg's worker as a
// module worker, which cannot importScripts the UMD build).
import { ExportError } from "../types";

export const FFMPEG_CORE_VERSION = "0.12.10";
export const FFMPEG_CORE_SHA256 = {
    "ffmpeg-core.js": "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3",
    "ffmpeg-core.wasm": "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
} as const;
export type FfmpegCoreFile = keyof typeof FFMPEG_CORE_SHA256;

/** Same-origin path the host serves the core from (apps/web copies it next to the app, outside dist/). */
export const DEFAULT_FFMPEG_CORE_BASE = "/ffmpeg-core";
/** Opt-in fallback for hosts that cannot self-host; still hash-checked. Needs network. */
export const UNPKG_FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";

export interface VerifiedCore {
    coreURL: string;
    wasmURL: string;
    revoke(): void;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fetches both core files, rejects on a hash mismatch, and returns blob: URLs of the checked bytes. */
export async function loadVerifiedFfmpegCore(
    base: string,
    fetchImpl: typeof fetch = fetch,
    hashes: Record<FfmpegCoreFile, string> = FFMPEG_CORE_SHA256,
): Promise<VerifiedCore> {
    const urls: string[] = [];
    const load = async (file: FfmpegCoreFile, type: string) => {
        let response: Response;
        try {
            response = await fetchImpl(`${base.replace(/\/$/, "")}/${file}`);
        } catch (error) {
            throw new ExportError("core-unavailable", `Could not load the ffmpeg core (${file}).`, String(error));
        }
        if (!response.ok) throw new ExportError("core-unavailable", `Could not load the ffmpeg core (${file}: HTTP ${response.status}).`);
        const bytes = await response.arrayBuffer();
        if ((await sha256Hex(bytes)) !== hashes[file]) {
            throw new ExportError("core-unavailable", `The ffmpeg core file ${file} does not match its pinned SHA-256; it was not run.`);
        }
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        urls.push(url);
        return url;
    };
    try {
        const coreURL = await load("ffmpeg-core.js", "text/javascript");
        const wasmURL = await load("ffmpeg-core.wasm", "application/wasm");
        return { coreURL, wasmURL, revoke: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
    } catch (error) {
        urls.forEach((url) => URL.revokeObjectURL(url));
        throw error;
    }
}
