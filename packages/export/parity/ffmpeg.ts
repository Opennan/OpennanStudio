// Parity harness (test-only): runs real ffmpeg filter graphs on raw RGB frames, on the native LGPL
// ffmpeg the desktop app bundles (else ffmpeg on PATH) and on the ffmpeg.wasm core the web app uses,
// loaded in Node. Both return raw bytes so no YUV conversion is involved.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface FfmpegJob {
    /** Files available to the graph (raw frames, PNGs), by name. */
    files: Record<string, Uint8Array>;
    /** Arguments after `ffmpeg -hide_banner -loglevel error -y`; the output must be the file `outputName`. */
    args: string[];
    outputName: string;
}

export interface FfmpegHost {
    name: string;
    version: string;
    run(job: FfmpegJob): Promise<Uint8Array>;
    /** ffmpeg.wasm only: bytes of the wasm heap (it only grows, so after a run this is the run's peak). */
    heapBytes?(): number;
}

function nativePath(): string | null {
    const candidates = [
        process.env.OPENNAN_PARITY_FFMPEG,
        path.join(ROOT, "apps/desktop/resources/ffmpeg", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
        "ffmpeg",
    ].filter((p): p is string => Boolean(p));
    for (const candidate of candidates) {
        if (candidate !== "ffmpeg" && !existsSync(candidate)) continue;
        const probe = spawnSync(candidate, ["-hide_banner", "-version"], { encoding: "utf8" });
        if (probe.status === 0) return candidate;
    }
    return null;
}

let native: FfmpegHost | null | undefined;

export function nativeFfmpeg(): FfmpegHost | null {
    if (native !== undefined) return native;
    const bin = nativePath();
    if (!bin) return (native = null);
    const version = execFileSync(bin, ["-hide_banner", "-version"], { encoding: "utf8" }).match(/ffmpeg version n?(\S+)/)?.[1] ?? "unknown";
    native = {
        name: `native ${version}`,
        version,
        async run(job) {
            const dir = mkdtempSync(path.join(os.tmpdir(), "opennan-parity-"));
            try {
                for (const [name, data] of Object.entries(job.files)) writeFileSync(path.join(dir, name), data);
                const result = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...job.args], { cwd: dir, encoding: "buffer", maxBuffer: 1 << 28 });
                if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
                return new Uint8Array(readFileSync(path.join(dir, job.outputName)));
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
    };
    return native;
}

interface WasmCore {
    FS: { writeFile(name: string, data: Uint8Array): void; readFile(name: string): Uint8Array; unlink(name: string): void };
    exec(...args: string[]): number;
    setLogger(logger: (log: { type: string; message: string }) => void): void;
    reset(): void;
    HEAPU8: Uint8Array;
}

function corePath(): string | null {
    const require = createRequire(import.meta.url);
    try {
        return require.resolve("@ffmpeg/core");
    } catch {
        return null;
    }
}

let wasm: Promise<FfmpegHost | null> | undefined;

/** The ffmpeg.wasm core (FFmpeg 5.1.4) in Node: the UMD build with `self`/`location` shims and the wasm bytes passed in. */
export function wasmFfmpeg(): Promise<FfmpegHost | null> {
    if (wasm) return wasm;
    wasm = (async () => {
        const core = corePath();
        if (!core) return null;
        const g = globalThis as Record<string, unknown>;
        g.self ??= globalThis;
        g.location ??= { href: `file://${core}` };
        const require = createRequire(import.meta.url);
        const factory = require(core) as (options: Record<string, unknown>) => Promise<WasmCore>;
        const module = await factory({ wasmBinary: readFileSync(core.replace(/\.js$/, ".wasm")) });
        let log: string[] = [];
        module.setLogger((entry) => log.push(entry.message));
        const version = await (async () => {
            log = [];
            module.exec("-hide_banner", "-version");
            module.reset();
            return log.join("\n").match(/ffmpeg version n?(\S+)/)?.[1] ?? "unknown";
        })();
        let queue: Promise<unknown> = Promise.resolve();
        const host: FfmpegHost = {
            name: `wasm ${version}`,
            version,
            heapBytes: () => module.HEAPU8.length,
            run(job) {
                const next = queue.then(() => {
                    log = [];
                    const names = Object.keys(job.files);
                    for (const name of names) module.FS.writeFile(name, job.files[name]);
                    try {
                        const code = module.exec("-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...job.args);
                        module.reset();
                        if (code !== 0) throw new Error(`ffmpeg.wasm failed (${code}): ${log.join("\n")}`);
                        const out = module.FS.readFile(job.outputName);
                        module.FS.unlink(job.outputName);
                        return new Uint8Array(out);
                    } finally {
                        for (const name of names) {
                            try {
                                module.FS.unlink(name);
                            } catch {
                                /* already gone */
                            }
                        }
                    }
                });
                queue = next.catch(() => undefined);
                return next;
            },
        };
        return host;
    })();
    return wasm;
}

/** Every available host, native first. */
export async function ffmpegHosts(): Promise<FfmpegHost[]> {
    const hosts: FfmpegHost[] = [];
    const n = nativeFfmpeg();
    if (n) hosts.push(n);
    const w = await wasmFfmpeg();
    if (w) hosts.push(w);
    return hosts;
}
