// Runs whisper-cli on a WAV file: checked binary, argv only (no shell), a private temp folder for the JSON
// output, progress from stderr, cancel by signal (SIGTERM, then SIGKILL), and the temp folder always removed.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobCancelledError, type Transcript } from "@opennan/provider-sdk";
import { verifyWhisperBinary, type WhisperBinary } from "./binary";
import { buildWhisperArgs, checkAbsolutePath } from "./whisper-args";
import { parseProgressLine, parseWhisperJson } from "./whisper-output";

export interface RunWhisperOptions {
    binary: WhisperBinary;
    modelPath: string;
    wavPath: string;
    language?: string;
    threads?: number;
    signal?: AbortSignal;
    onProgress?(ratio: number): void;
    timeoutMs?: number;
    spawn?: typeof nodeSpawn;
    /** Replaces the minimal environment whisper-cli gets (tests). */
    env?: NodeJS.ProcessEnv;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const STDERR_LINES = 50;
/** Windows STATUS_DLL_NOT_FOUND as an exit code. */
const DLL_NOT_FOUND = 0xc0000135;

/** PATH, temp, and home only: whisper-cli needs no other variable (Linux libraries load through RPATH $ORIGIN). */
export function whisperEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"];
    return Object.fromEntries(keep.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

async function inputFile(file: string, what: string, extension?: string): Promise<string> {
    checkAbsolutePath(file, what);
    if (extension && !file.toLowerCase().endsWith(extension)) throw new Error(`${what} must be a ${extension} file`);
    const info = await lstat(file).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`${what} is not a regular file`);
    return file;
}

/** Replaces each known absolute path (and its folder) in a log text with its last segment. */
export function redactPaths(text: string, paths: string[]): string {
    let out = text;
    for (const file of [...paths].sort((a, b) => b.length - a.length)) {
        if (file) out = out.split(file).join(path.basename(file));
    }
    return out;
}

export async function runWhisper(options: RunWhisperOptions): Promise<Transcript> {
    if (options.signal?.aborted) throw new JobCancelledError();
    await verifyWhisperBinary(options.binary);
    const modelPath = await inputFile(options.modelPath, "model");
    const wavPath = await inputFile(options.wavPath, "audio", ".wav");
    const dir = await mkdtemp(path.join(tmpdir(), "opennan-whisper-"));
    const outputBase = path.join(dir, "out");
    try {
        const args = buildWhisperArgs({ modelPath, wavPath, outputBase, language: options.language, threads: options.threads });
        const spawn = options.spawn ?? nodeSpawn;
        const child: ChildProcess = spawn(options.binary.path, args, {
            shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], cwd: dir, env: options.env ?? whisperEnv(),
        });
        const stderr: string[] = [];
        let pending = "";
        child.stdout?.resume();
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (data: string) => {
            pending += data;
            // A line without an end must not grow without bound.
            if (pending.length > 64 * 1024) pending = pending.slice(-4096);
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? "";
            for (const line of lines) {
                const ratio = parseProgressLine(line);
                if (ratio !== null) options.onProgress?.(ratio);
                else if (line.trim()) {
                    stderr.push(line);
                    if (stderr.length > STDERR_LINES) stderr.shift();
                }
            }
        });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let cancelled = false;
        let timedOut = false;
        const stop = () => {
            if (killTimer) return;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        };
        const onAbort = () => {
            cancelled = true;
            stop();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timeout = options.timeoutMs ? setTimeout(() => {
            timedOut = true;
            stop();
        }, options.timeoutMs) : undefined;
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (exitCode) => resolve(exitCode));
        }).finally(() => {
            options.signal?.removeEventListener("abort", onAbort);
            clearTimeout(killTimer);
            clearTimeout(timeout);
        });
        if (cancelled) throw new JobCancelledError();
        if (timedOut) throw new Error(`whisper.cpp did not finish within ${Math.round(options.timeoutMs! / 1000)} s`);
        if (code !== 0) {
            if (code === DLL_NOT_FOUND || code === DLL_NOT_FOUND - 2 ** 32) throw new Error("whisper.cpp could not start: a library whisper-cli needs is missing");
            // Local paths in whisper's log become file names: the message reaches the editor and MCP agents.
            const log = redactPaths(stderr.slice(-5).join(" | "), [modelPath, wavPath, dir, options.binary.dir]);
            throw new Error(`whisper.cpp failed (exit ${code}): ${log.slice(0, 2000)}`);
        }
        const json = `${outputBase}.json`;
        const info = await stat(json).catch(() => null);
        if (!info?.isFile()) throw new Error("whisper.cpp wrote no transcript");
        if (info.size > MAX_OUTPUT_BYTES) throw new Error("whisper.cpp wrote a transcript that is too large");
        return parseWhisperJson(await readFile(json, "utf8"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
