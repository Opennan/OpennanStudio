// Two-pass GL export: decode the composited intermediate for each pass range as raw RGBA, run every
// frame through the GlFrameProcessor, store the result losslessly, then overlay it on the composite.
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { untilAborted } from "../abort";
import { buildFfmpegArgs, filterScript, type FilterScriptFlag } from "../args";
import { LOCAL_PROTOCOLS, MEDIA_DEMUXERS } from "./source-policy";
import type { EncoderChoice } from "../encoders";
import { fmt, sec } from "../format";
import type { GlFrameProcessor } from "../gl";
import { parseProgressSeconds, progressRatio } from "../progress";
import { ExportError, type ExportPlan, type GlPass, type OutputFormat } from "../types";
import { runProcess } from "./ffmpeg-binary";

export interface RenderGlPassesOptions {
    ffmpegPath: string;
    basePath: string;
    passes: GlPass[];
    format: OutputFormat;
    processor: GlFrameProcessor;
    dir: string;
    signal?: AbortSignal;
    onProgress?(ratio: number): void;
}

const cancelled = () => new ExportError("cancelled", "Export cancelled.");

/** Keeps the last few kB of a child's stderr (and keeps the pipe flowing so the child never blocks on it). */
function stderrTail(child: ChildProcess): () => string {
    let tail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-8000);
    });
    return () => tail;
}

/**
 * Resolves on 'drain'; rejects as soon as the encoder exits, its stdin errors (EPIPE) or the export is
 * cancelled, so a dead encoder can never leave the pass waiting.
 */
function drained(encoder: ChildProcessByStdio<Writable, null, Readable>, signal: AbortSignal | undefined, tail: () => string): Promise<void> {
    return new Promise((resolve, reject) => {
        const settle = (error?: ExportError) => {
            encoder.stdin.off("drain", onDrain);
            encoder.stdin.off("error", onError);
            encoder.off("close", onClose);
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve();
        };
        const onDrain = () => settle();
        const onError = (error: Error) => settle(new ExportError("ffmpeg-failed", "The GL effect pass encoder stopped early.", `${error.message}\n${tail()}`));
        const onClose = () => settle(new ExportError("ffmpeg-failed", "The GL effect pass encoder stopped early.", tail()));
        const onAbort = () => settle(cancelled());
        if (signal?.aborted) return onAbort();
        if (encoder.exitCode !== null || encoder.signalCode !== null) return onClose();
        encoder.stdin.on("drain", onDrain);
        encoder.stdin.on("error", onError);
        encoder.on("close", onClose);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Returns one FFV1 file per pass, each covering [pass.start, pass.end). */
export async function renderGlPasses(options: RenderGlPassesOptions): Promise<string[]> {
    const { width, height, fps } = options.format;
    const { signal } = options;
    const frameBytes = width * height * 4;
    const totalFrames = options.passes.reduce((sum, p) => sum + Math.max(1, Math.round((p.end - p.start) * fps)), 0);
    let doneFrames = 0;
    const outputs: string[] = [];
    for (const [index, pass] of options.passes.entries()) {
        if (signal?.aborted) throw cancelled();
        const out = path.join(options.dir, `fx${index}.mkv`);
        const decoder = spawn(options.ffmpegPath, [
            "-hide_banner", "-loglevel", "error", "-ss", sec(pass.start), "-t", sec(pass.end - pass.start), "-i", options.basePath,
            "-f", "rawvideo", "-pix_fmt", "rgba", "-",
        ], { stdio: ["ignore", "pipe", "pipe"] });
        const encoder = spawn(options.ffmpegPath, [
            "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps),
            "-i", "-", "-c:v", "ffv1", "-level", "3", "-pix_fmt", "yuv420p", out,
        ], { stdio: ["pipe", "ignore", "pipe"] });
        const decoderTail = stderrTail(decoder);
        const encoderTail = stderrTail(encoder);
        // An EPIPE after the encoder exits must not become an uncaught exception; the write path checks for it.
        let stdinError: Error | null = null;
        encoder.stdin.on("error", (error) => {
            stdinError ??= error;
        });
        const encoderFailed = () =>
            new ExportError("ffmpeg-failed", "The GL effect pass encoder stopped early.", `${stdinError?.message ?? ""}\n${encoderTail()}`.trim());
        const kill = () => {
            decoder.kill("SIGKILL");
            encoder.kill("SIGKILL");
        };
        signal?.addEventListener("abort", kill, { once: true });
        const encoderExit = once(encoder, "close");
        const decoderExit = once(decoder, "close");
        // Observed below on every path; these handlers only keep a spawn error from being an unhandled rejection.
        encoderExit.catch(() => {});
        decoderExit.catch(() => {});
        let finished = false;
        try {
            let buffer: Buffer = Buffer.alloc(0);
            let frame = 0;
            for await (const chunk of decoder.stdout) {
                buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);
                while (buffer.length >= frameBytes) {
                    if (signal?.aborted) throw cancelled();
                    const data = new Uint8Array(buffer.subarray(0, frameBytes));
                    buffer = buffer.subarray(frameBytes);
                    const processed = await untilAborted(options.processor.process({ data, width, height, time: pass.start + frame / fps }, pass.effects), signal);
                    if (!(processed instanceof Uint8Array) || processed.length !== frameBytes) {
                        throw new ExportError("ffmpeg-failed", `The GL effect processor returned a frame of the wrong size (expected ${frameBytes} RGBA bytes).`);
                    }
                    if (stdinError || encoder.exitCode !== null || encoder.signalCode !== null) throw encoderFailed();
                    frame += 1;
                    doneFrames += 1;
                    options.onProgress?.(Math.min(1, doneFrames / totalFrames));
                    if (!encoder.stdin.write(processed)) await drained(encoder, signal, encoderTail);
                }
            }
            if (signal?.aborted) throw cancelled();
            encoder.stdin.end();
            const [[decodeCode], [encodeCode]] = await Promise.all([decoderExit, encoderExit]);
            if (signal?.aborted) throw cancelled();
            if (decodeCode !== 0) throw new ExportError("ffmpeg-failed", "GL effect pass failed.", decoderTail());
            if (encodeCode !== 0 || stdinError) throw encoderFailed();
            finished = true;
        } finally {
            signal?.removeEventListener("abort", kill);
            if (!finished) {
                // Cancelled, the processor threw, or a child failed: never leave an ffmpeg blocked on its pipe.
                kill();
                await Promise.allSettled([decoderExit, encoderExit]);
            }
        }
        outputs.push(out);
    }
    return outputs;
}

export interface CompositeGlPassesOptions {
    ffmpegPath: string;
    basePath: string;
    fxPaths: string[];
    plan: ExportPlan;
    encoder: EncoderChoice;
    dir: string;
    outputPath: string;
    scriptFlag: FilterScriptFlag;
    signal?: AbortSignal;
    onProgress?(ratio: number): void;
}

/** Final encode: the intermediate with each processed range laid over it, audio re-encoded. */
export async function compositeGlPasses(options: CompositeGlPassesOptions): Promise<void> {
    const { plan } = options;
    const chains: string[] = [];
    let current = "0:v";
    options.plan.glPasses.forEach((pass, i) => {
        chains.push(`[${i + 1}:v]setpts=PTS-STARTPTS+${fmt(pass.start)}/TB[fx${i}]`);
        chains.push(`[${current}][fx${i}]overlay=0:0:eof_action=pass:enable='between(t,${fmt(pass.start)},${fmt(pass.end)})'[gl${i}]`);
        current = `gl${i}`;
    });
    chains.push(`[${current}]format=yuv420p[vout]`, "[0:a]anull[aout]");
    const composite: ExportPlan = {
        ...plan,
        inputs: [
            { kind: "media", source: options.basePath, options: [] },
            ...options.fxPaths.map((fx) => ({ kind: "media" as const, source: fx, options: [] })),
        ],
        filterGraph: chains.join(";\n"),
        videoLabel: "vout",
        audioLabel: "aout",
    };
    const scriptPath = path.join(options.dir, "gl-graph.txt");
    await writeFile(scriptPath, filterScript(composite, options.encoder).script);
    const result = await runProcess(options.ffmpegPath, buildFfmpegArgs({
        plan: composite, encoder: options.encoder, inputPaths: composite.inputs.map((i) => i.source),
        filterScriptPath: scriptPath, scriptFlag: options.scriptFlag, outputPath: options.outputPath, progressPipe: true,
        inputGuards: ["-protocol_whitelist", LOCAL_PROTOCOLS, "-format_whitelist", MEDIA_DEMUXERS],
    }), {
        signal: options.signal,
        onStdoutLine: (line) => {
            const seconds = parseProgressSeconds(line);
            if (seconds !== null) options.onProgress?.(progressRatio(seconds, plan.durationSeconds));
        },
    });
    if (result.code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg could not composite the GL effect passes.", result.stderr);
}
