// The whisper.cpp binary folder: <dir>/whisper-cli[.exe], its libraries (Linux), and checksums.json
// ({ "version": "1.9.5", "files": { "<name>": "<sha256>" } }, written when the binaries were fetched or built).
// Every listed file is hashed and compared before the binary first runs, and again whenever its size or
// modification time changes.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./model-store";
import { checkAbsolutePath } from "./whisper-args";

export interface WhisperBinary {
    dir: string;
    /** Absolute path of whisper-cli[.exe]. */
    path: string;
    /** File name -> SHA-256, from checksums.json. */
    files: Record<string, string>;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
const verified = new Map<string, string>();

export const WHISPER_CHECKSUM_MISMATCH = "whisper-cli does not match its checksum; reinstall OpenNan Studio";

export function whisperExecutableName(platform: NodeJS.Platform = process.platform): string {
    return platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
}

async function regular(file: string, what: string) {
    const info = await lstat(file).catch(() => null);
    if (!info) throw new Error(`${what} is missing`);
    if (!info.isFile()) throw new Error(`${what} is not a regular file`);
    return info;
}

/** Hashes every listed file whose size or mtime changed since the last check in this process. */
export async function verifyWhisperBinary(binary: WhisperBinary): Promise<void> {
    for (const [name, expected] of Object.entries(binary.files)) {
        const file = path.join(binary.dir, name);
        const info = await regular(file, name);
        const key = `${file}\0${info.size}\0${info.mtimeMs}`;
        if (verified.get(file) === key) continue;
        const actual = await sha256File(file);
        if (actual !== expected) {
            verified.delete(file);
            throw new Error(name === path.basename(binary.path) ? WHISPER_CHECKSUM_MISMATCH : `${name} does not match its checksum; reinstall OpenNan Studio`);
        }
        verified.set(file, key);
    }
}

export async function loadWhisperBinary(dir: string, options: { platform?: NodeJS.Platform } = {}): Promise<WhisperBinary> {
    const root = checkAbsolutePath(dir, "whisper folder");
    const checksumsFile = path.join(root, "checksums.json");
    const info = await regular(checksumsFile, "checksums.json");
    if (info.size > MAX_CHECKSUMS_BYTES) throw new Error("checksums.json is too large");
    let parsed: { files?: unknown };
    try {
        parsed = JSON.parse(await readFile(checksumsFile, "utf8")) as { files?: unknown };
    } catch {
        throw new Error("checksums.json is not valid JSON");
    }
    if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) throw new Error("checksums.json lists no files");
    const files: Record<string, string> = {};
    for (const [name, sha] of Object.entries(parsed.files as Record<string, unknown>)) {
        if (!FILE_NAME.test(name) || name.includes("..")) throw new Error(`checksums.json names an invalid file: ${name.slice(0, 64)}`);
        if (typeof sha !== "string" || !SHA256.test(sha)) throw new Error(`checksums.json has an invalid SHA-256 for ${name}`);
        files[name] = sha;
    }
    const exe = whisperExecutableName(options.platform);
    if (!files[exe]) throw new Error(`checksums.json does not list ${exe}`);
    const binary = { dir: root, path: path.join(root, exe), files };
    await verifyWhisperBinary(binary);
    return binary;
}
