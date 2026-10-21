// Which media a native ffmpeg may open. Fails closed: a timeline URL becomes a path only when its real
// path is under a configured media root (http(s) only when the host opts in). Everything else (other
// absolute paths, ffmpeg protocols such as concat: or subfile:, data:, relative paths) is rejected and
// exports as unreadable media. Agent-triggered renders (phase 5 previewFrame) must keep the defaults.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Protocols for local media inputs and job files. */
export const LOCAL_PROTOCOLS = "file,pipe";
/** Only with allowNetworkMedia. */
export const NETWORK_PROTOCOLS = "file,pipe,http,https,tcp,tls";
/** Plain media demuxers: no playlists (hls, concat, ffconcat), no lavfi, no capture devices. */
export const MEDIA_DEMUXERS = "mov,matroska,mp3,wav,ogg,flac,aac,image2,png_pipe,jpeg_pipe,webp_pipe,gif";

export interface SourcePolicyOptions {
    /** Directories media may be read from. Real paths are compared, so symlinks and .. cannot escape. */
    mediaRoots: string[];
    /** Host mapping for its own schemes (opennan-local: → a file under a root). Return null to reject. */
    resolveSource?(url: string): string | null | Promise<string | null>;
    /** Allow http(s) media. Default false; never enable it for agent-triggered renders. */
    allowNetworkMedia?: boolean;
}

export interface SourcePolicy {
    /** The path or URL ffmpeg may open, or null (treat the media as unreadable). */
    resolve(url: string): Promise<string | null>;
    /** Options placed before every ffmpeg input and on every ffprobe call. */
    inputGuards: string[];
}

/** Two or more characters before ":", so a Windows drive letter (C:\) is not a scheme. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export function createSourcePolicy(options: SourcePolicyOptions): SourcePolicy {
    let roots: Promise<string[]> | null = null;
    const realRoots = () => (roots ??= Promise.all(options.mediaRoots.map((root) => realpath(path.resolve(root)).catch(() => null)))
        .then((list) => list.filter((root): root is string => Boolean(root))));
    return {
        inputGuards: [
            "-protocol_whitelist", options.allowNetworkMedia ? NETWORK_PROTOCOLS : LOCAL_PROTOCOLS,
            "-format_whitelist", MEDIA_DEMUXERS,
        ],
        async resolve(url) {
            const mapped = options.resolveSource ? await options.resolveSource(url) : url;
            if (!mapped) return null;
            if (/^https?:\/\//i.test(mapped)) return options.allowNetworkMedia ? mapped : null;
            let file: string;
            try {
                if (/^file:\/\//i.test(mapped)) file = fileURLToPath(mapped);
                else if (!SCHEME.test(mapped) && path.isAbsolute(mapped)) file = mapped;
                else return null;
            } catch {
                return null;
            }
            const real = await realpath(file).catch(() => null);
            if (!real) return null;
            const inside = (await realRoots()).some((root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
            return inside ? real : null;
        },
    };
}

/** A job file inside `dir`. Names come from compileExport (raster-<n>.png); anything with a separator or .. throws. */
export function jobFilePath(dir: string, name: string): string {
    // An image-sequence input (compile/graphics.ts) names its frames with one `%05d`, which only ffmpeg expands.
    if (!/^[A-Za-z0-9._-]+(%05d[A-Za-z0-9._-]*)?$/.test(name) || name.includes("..")) throw new Error(`unsafe job file name ${JSON.stringify(name)}`);
    const resolved = path.resolve(dir, name);
    if (path.dirname(resolved) !== path.resolve(dir)) throw new Error(`job file escapes its directory: ${name}`);
    return resolved;
}
