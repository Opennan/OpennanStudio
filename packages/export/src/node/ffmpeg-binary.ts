// Native ffmpeg/ffprobe processes: spawn helpers, version, encoder list and encoder self-test.
import { spawn } from "node:child_process";
import { encoderCandidates, parseEncoderList, type EncoderChoice, type EncoderOptions } from "../encoders";
import { ExportError } from "../types";

export interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface RunProcessOptions {
    signal?: AbortSignal;
    onStdoutLine?(line: string): void;
}

/** Runs a process to completion. Aborting kills it and rejects with ExportError("cancelled"). */
export function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new ExportError("cancelled", "Export cancelled."));
            return;
        }
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let pending = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            if (!options.onStdoutLine) return;
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? "";
            for (const line of lines) options.onStdoutLine(line);
        });
        child.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-8000);
        });
        const onAbort = () => child.kill("SIGKILL");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
            options.signal?.removeEventListener("abort", onAbort);
            reject(error);
        });
        child.on("close", (code) => {
            options.signal?.removeEventListener("abort", onAbort);
            if (options.signal?.aborted) reject(new ExportError("cancelled", "Export cancelled."));
            else resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}

/** Major version from `ffmpeg -version` ("ffmpeg version 7.1.1", "n6.0", git builds count as new). */
export function parseFfmpegMajorVersion(text: string): number {
    const match = text.match(/ffmpeg version n?(\d+)\./);
    if (match) return Number(match[1]);
    return /ffmpeg version N-/.test(text) ? 99 : 0;
}

export async function ffmpegMajorVersion(ffmpegPath: string): Promise<number> {
    const result = await runProcess(ffmpegPath, ["-hide_banner", "-version"]);
    return parseFfmpegMajorVersion(result.stdout);
}

export async function listEncoders(ffmpegPath: string): Promise<Set<string>> {
    const result = await runProcess(ffmpegPath, ["-hide_banner", "-encoders"]);
    return parseEncoderList(result.stdout);
}

/** Encodes a few black frames to /dev/null-equivalent; false when the encoder is listed but unusable here. */
export async function encoderWorks(ffmpegPath: string, choice: EncoderChoice): Promise<boolean> {
    const result = await runProcess(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", ...choice.globalArgs,
        "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.2",
        ...(choice.videoFilters.length ? ["-vf", choice.videoFilters.join(",")] : []),
        "-frames:v", "3", ...choice.videoArgs, "-f", "null", "-",
    ]).catch(() => ({ code: -1, stdout: "", stderr: "" }));
    return result.code === 0;
}

/** First candidate that both appears in `ffmpeg -encoders` and passes the self-test. */
export async function chooseWorkingEncoder(ffmpegPath: string, options: EncoderOptions): Promise<EncoderChoice> {
    for (const candidate of encoderCandidates(await listEncoders(ffmpegPath), options)) {
        if (await encoderWorks(ffmpegPath, candidate)) return candidate;
    }
    throw new ExportError("no-encoder", "No working video encoder in this ffmpeg build.");
}
