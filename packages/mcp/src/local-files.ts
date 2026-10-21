// Local media for publish_audio_to_timeline / publish_video_to_timeline (headless host).
// The agent picks the path, so reads are confined: the extension must match the kind,
// and the real path (symlinks resolved) must sit inside the project folder or an
// --allow-dir root. Files come back lazy (fs.openAsBlob) and are streamed on import.
import { openAsBlob, promises as fs } from "node:fs";
import path from "node:path";

export const LOCAL_MEDIA_TYPES = {
    audio: { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac", ".opus": "audio/opus" },
    video: { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" },
} as const satisfies Record<string, Record<string, string>>;

export type LocalMediaKind = keyof typeof LOCAL_MEDIA_TYPES;

export function mimeTypeFor(file: string, kind: LocalMediaKind): string | null {
    return (LOCAL_MEDIA_TYPES[kind] as Record<string, string>)[path.extname(file).toLowerCase()] ?? null;
}

export interface LocalFileReaderOptions {
    /** Relative paths resolve here (the project folder). It is always an allowed root. */
    baseDir: string;
    /** More folders files may come from (`mcp serve --allow-dir`). */
    allowDirs?: readonly string[];
    /** Default 4 GiB. */
    maxBytes?: number;
}

export type LocalFileReader = (file: string, kind: LocalMediaKind) => Promise<File>;

/** UNC, device, and network-share paths: touching them (even realpath) can reach another machine. */
export function isRemotePath(file: string): boolean {
    return /^(\\\\|\/\/)/.test(file) || /^\\\\[?.]\\/.test(file);
}

const isInside = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

export async function createLocalFileReader(options: LocalFileReaderOptions): Promise<LocalFileReader> {
    const maxBytes = options.maxBytes ?? 4 * 1024 ** 3;
    const lexicalRoots = [options.baseDir, ...(options.allowDirs ?? [])].map((dir) => path.resolve(options.baseDir, dir));
    const roots = await Promise.all([options.baseDir, ...(options.allowDirs ?? [])].map(async (dir) => {
        const resolved = path.resolve(options.baseDir, dir);
        const real = await fs.realpath(resolved).catch(() => null);
        if (!real) throw new Error(`--allow-dir folder not found: ${resolved}`);
        return real;
    }));
    const notKind = (name: string, kind: LocalMediaKind) => new Error(`${name} is not ${kind === "audio" ? "an audio" : "a video"} file (${Object.keys(LOCAL_MEDIA_TYPES[kind]).join(", ")})`);
    return async (file, kind) => {
        if (isRemotePath(file)) throw new Error(`Network paths are not read: ${file}`);
        const requested = path.resolve(options.baseDir, file);
        // Containment is checked on the path as written before the filesystem is touched (realpath of a UNC or
        // automount path already reaches another machine), then again on the real path.
        if (!lexicalRoots.some((root) => isInside(requested, root)) && !roots.some((root) => isInside(requested, root))) {
            throw new Error(`${requested} is outside the project folder and the --allow-dir folders`);
        }
        const name = path.basename(requested);
        const type = mimeTypeFor(requested, kind);
        if (!type) throw notKind(name, kind);
        const real = await fs.realpath(requested).catch(() => null);
        if (!real) throw new Error(`Not a file: ${requested}`);
        if (!roots.some((root) => isInside(real, root))) {
            throw new Error(`${requested} is outside the project folder and the --allow-dir folders`);
        }
        if (mimeTypeFor(real, kind) === null) throw notKind(name, kind);
        const stat = await fs.stat(real);
        if (!stat.isFile()) throw new Error(`Not a file: ${requested}`);
        if (stat.size > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes: ${requested}`);
        return new File([await openAsBlob(real, { type })], name, { type });
    };
}
