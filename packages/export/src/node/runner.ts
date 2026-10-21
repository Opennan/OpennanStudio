// Export runner for a native ffmpeg binary (desktop main process, CLI, golden tests). The binary path
// is injected; shipped builds use an LGPL ffmpeg, so encoder choice never requires libx264. Media access
// fails closed through a SourcePolicy (source-policy.ts); job files are written only under the job dir.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import {
    buildAudioMixArgs, buildFfmpegArgs, buildFrameArgs, buildGifArgs, buildGifPaletteArgs, buildMuxArgs, type GifPlan, filterScript, filterScriptFlag, filterThreadCap, frameFilterScript, inputThreadCap, muxAudioArgs,
} from "../args";
import { INTERMEDIATE_ENCODER, type EncoderChoice } from "../encoders";
import type { ExportOutput, ExportRunner, MuxOptions, MuxVideo, RunOptions } from "../runner";
import type { MuxPlan } from "../compile/mux";
import { parseProgressSeconds, progressRatio } from "../progress";
import { ExportError, type ExportPlan, type MediaInfo } from "../types";
import { chooseWorkingEncoder, ffmpegMajorVersion, listEncoders, runProcess } from "./ffmpeg-binary";
import { compositeGlPasses, renderGlPasses } from "./gl-passes";
import { probeFile } from "./prober";
import { createSourcePolicy, jobFilePath, type SourcePolicyOptions } from "./source-policy";

export interface NodeRunnerOptions extends SourcePolicyOptions {
    ffmpegPath: string;
    ffprobePath: string;
    /** Where the finished file goes, by container ("mp4" | "webm"). */
    outputPath(container: string): string;
    /** Parent directory for job temp files. Default os.tmpdir(). */
    tempDir?: string;
}

export function createNodeRunner(options: NodeRunnerOptions): ExportRunner {
    const policy = createSourcePolicy(options);
    // URL → path accepted by the policy at probe time; nothing else ever reaches ffmpeg.
    const accepted = new Map<string, string>();
    let version: Promise<number> | null = null;
    const major = () => (version ??= ffmpegMajorVersion(options.ffmpegPath));
    let encoders: Promise<Set<string>> | null = null;
    const encoderList = () => (encoders ??= listEncoders(options.ffmpegPath).catch(() => new Set<string>()));

    async function mediaPath(url: string): Promise<string> {
        const resolved = accepted.get(url) ?? (await policy.resolve(url));
        if (!resolved) throw new ExportError("media-read-failed", `This media is outside the allowed sources: ${url}`);
        return resolved;
    }
    const inputPaths = (plan: ExportPlan, dir: string) =>
        Promise.all(plan.inputs.map((input) => (input.kind === "file" ? jobFilePath(dir, input.source) : mediaPath(input.source))));
    async function writeJobFiles(plan: ExportPlan, dir: string): Promise<void> {
        for (const file of plan.files) await writeFile(jobFilePath(dir, file.name), file.data);
    }

    async function encode(plan: ExportPlan, encoder: EncoderChoice, dir: string, output: string, signal: AbortSignal | undefined, onRatio: (r: number) => void): Promise<void> {
        const { script } = filterScript(plan, encoder);
        const scriptPath = path.join(dir, "graph.txt");
        await writeFile(scriptPath, script);
        const args = buildFfmpegArgs({
            plan, encoder, inputPaths: await inputPaths(plan, dir), filterScriptPath: scriptPath, scriptFlag: filterScriptFlag(await major()),
            outputPath: output, progressPipe: true, inputGuards: policy.inputGuards,
            filterThreads: filterThreadCap(script, plan.inputs.length, cpus().length),
            inputThreads: inputThreadCap(plan.inputs.length, cpus().length),
        });
        const result = await runProcess(options.ffmpegPath, args, {
            signal,
            onStdoutLine: (line) => {
                const seconds = parseProgressSeconds(line);
                if (seconds !== null) onRatio(progressRatio(seconds, plan.durationSeconds));
            },
        });
        if (result.code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg could not render the export.", result.stderr);
    }

    return {
        kind: "node",
        supportsGl: true,
        maxResolution: "4k",

        async probe(urls, signal) {
            const out = new Map<string, MediaInfo>();
            for (const url of urls) {
                const source = await policy.resolve(url);
                if (!source) continue; // rejected: compileExport reports it as media-unreadable
                accepted.set(url, source);
                const info = await probeFile(options.ffprobePath, source, signal, policy.inputGuards).catch((error) => {
                    if (error instanceof ExportError) throw error;
                    return null;
                });
                if (info) out.set(url, info);
            }
            return out;
        },

        chooseEncoder(encoderOptions) {
            return chooseWorkingEncoder(options.ffmpegPath, encoderOptions);
        },

        async renderFrame(plan, seconds, frame = {}) {
            const dir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-frame-"));
            try {
                await writeJobFiles(plan, dir);
                const { script, videoPad } = frameFilterScript(plan, frame.size);
                const scriptPath = path.join(dir, "graph.txt");
                await writeFile(scriptPath, script);
                const output = path.join(dir, "frame.png");
                const result = await runProcess(options.ffmpegPath, buildFrameArgs({
                    plan, videoPad, inputPaths: await inputPaths(plan, dir), filterScriptPath: scriptPath, scriptFlag: filterScriptFlag(await major()),
                    outputPath: output, seconds, inputGuards: policy.inputGuards,
                }), { signal: frame.signal });
                if (result.code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg could not render the frame.", result.stderr);
                return new Uint8Array(await readFile(output));
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },

        async renderAudio(plan, outputPath, audio = {}) {
            const dir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-audio-"));
            try {
                const scriptPath = path.join(dir, "graph.txt");
                await writeFile(scriptPath, plan.filterGraph);
                const args = buildAudioMixArgs({
                    plan, inputPaths: await Promise.all(plan.inputs.map((input) => mediaPath(input.source))), filterScriptPath: scriptPath,
                    scriptFlag: filterScriptFlag(await major()), outputPath, sampleRate: audio.sampleRate, inputGuards: policy.inputGuards, progressPipe: true,
                });
                const result = await runProcess(options.ffmpegPath, args, {
                    signal: audio.signal,
                    onStdoutLine: (line) => {
                        const seconds = parseProgressSeconds(line);
                        if (seconds !== null) audio.onProgress?.(progressRatio(seconds, plan.durationSeconds));
                    },
                });
                if (result.code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg could not render the timeline audio.", result.stderr);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },

        async mux(plan: MuxPlan, video: MuxVideo, mux: MuxOptions): Promise<ExportOutput> {
            const dir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-mux-"));
            const output = options.outputPath(mux.container);
            try {
                let videoPath: string;
                if (video.kind === "bytes" || video.kind === "blob") {
                    videoPath = jobFilePath(dir, `video.${mux.container}`);
                    await writeFile(videoPath, video.kind === "bytes" ? video.data : new Uint8Array(await video.blob.arrayBuffer()));
                } else {
                    videoPath = video.path;
                }
                const scriptPath = path.join(dir, "graph.txt");
                await writeFile(scriptPath, plan.filterGraph);
                const media = await Promise.all(plan.inputs.slice(1).map((input) => mediaPath(input.source)));
                const args = buildMuxArgs({
                    plan, container: mux.container, audioArgs: muxAudioArgs(mux.container, plan.audioBitrateKbps, await encoderList()),
                    inputPaths: [videoPath, ...media], filterScriptPath: scriptPath, scriptFlag: filterScriptFlag(await major()),
                    outputPath: output, progressPipe: true, inputGuards: policy.inputGuards,
                });
                const result = await runProcess(options.ffmpegPath, args, {
                    signal: mux.signal,
                    onStdoutLine: (line) => {
                        const seconds = parseProgressSeconds(line);
                        if (seconds !== null) mux.onProgress?.(progressRatio(seconds, plan.durationSeconds));
                    },
                });
                if (result.code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg could not add the audio to the export.", result.stderr);
                return { kind: "file", path: output };
            } catch (error) {
                // A failed or cancelled mux leaves no partial file in the exports folder.
                await rm(output, { force: true }).catch(() => undefined);
                throw error;
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },

        async gif(plan: GifPlan, video: MuxVideo, gif: MuxOptions): Promise<ExportOutput> {
            const dir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-gif-"));
            const output = options.outputPath("gif");
            const step = async (args: string[], from: number, to: number, message: string) => {
                const result = await runProcess(options.ffmpegPath, args, {
                    signal: gif.signal,
                    onStdoutLine: (line) => {
                        const seconds = parseProgressSeconds(line);
                        if (seconds !== null) gif.onProgress?.(from + (to - from) * progressRatio(seconds, plan.durationSeconds));
                    },
                });
                if (result.code !== 0) throw new ExportError("ffmpeg-failed", message, result.stderr);
            };
            try {
                let videoPath: string;
                if (video.kind === "bytes" || video.kind === "blob") {
                    videoPath = jobFilePath(dir, `video.${gif.container}`);
                    await writeFile(videoPath, video.kind === "bytes" ? video.data : new Uint8Array(await video.blob.arrayBuffer()));
                } else {
                    videoPath = video.path;
                }
                const palette = jobFilePath(dir, "palette.png");
                await step(buildGifPaletteArgs({ plan, inputPath: videoPath, outputPath: palette, progressPipe: true, inputGuards: policy.inputGuards }), 0, 0.4, "ffmpeg could not build the GIF palette.");
                await step(buildGifArgs({ plan, inputPath: videoPath, palettePath: palette, outputPath: output, progressPipe: true, inputGuards: policy.inputGuards }), 0.4, 1, "ffmpeg could not write the GIF.");
                return { kind: "file", path: output };
            } catch (error) {
                // A failed or cancelled GIF step leaves no partial file in the exports folder.
                await rm(output, { force: true }).catch(() => undefined);
                throw error;
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },

        async run(plan, encoder, run: RunOptions = {}): Promise<ExportOutput> {
            const dir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-export-"));
            const output = options.outputPath(encoder.container);
            const report = (ratio: number) => run.onProgress?.(ratio);
            try {
                await writeJobFiles(plan, dir);
                if (plan.glPasses.length === 0 || !run.glProcessor) {
                    await encode(plan, encoder, dir, output, run.signal, report);
                    return { kind: "file", path: output };
                }
                const base = path.join(dir, "pass1.mkv");
                await encode(plan, INTERMEDIATE_ENCODER, dir, base, run.signal, (r) => report(r * 0.5));
                const fx = await renderGlPasses({
                    ffmpegPath: options.ffmpegPath, basePath: base, passes: plan.glPasses, format: plan.format, processor: run.glProcessor,
                    dir, signal: run.signal, onProgress: (r) => report(0.5 + r * 0.4),
                });
                await compositeGlPasses({
                    ffmpegPath: options.ffmpegPath, basePath: base, fxPaths: fx, plan, encoder, dir, outputPath: output,
                    scriptFlag: filterScriptFlag(await major()), signal: run.signal, onProgress: (r) => report(0.9 + r * 0.1),
                });
                return { kind: "file", path: output };
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    };
}
