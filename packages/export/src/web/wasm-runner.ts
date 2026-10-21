// Export runner on ffmpeg.wasm (@ffmpeg/ffmpeg 0.12). Slower and memory-bound (all inputs live in
// the wasm filesystem), so it stops at 1080p and has no GL passes (effects become warnings).
import { buildAudioTrackArgs, buildFfmpegArgs, buildGifArgs, buildGifPaletteArgs, buildMuxArgs, filterScript, muxAudioArgs, type GifPlan } from "../args";
import { encoderCandidates, parseEncoderList } from "../encoders";
import { FFPROBE_ARGS, parseFfprobeJson } from "../probe-json";
import { parseProgressSeconds, progressRatio } from "../progress";
import type { ExportOutput, ExportRunner, MuxOptions, MuxVideo } from "../runner";
import { audioOnlyPlan, type MuxPlan } from "../compile/mux";
import { streamMux } from "./stream-mux";
import { ExportError, type ExportPlan, type ExportResolution, type MediaInfo } from "../types";
import { DEFAULT_FFMPEG_CORE_BASE, loadVerifiedFfmpegCore } from "./core-loader";

/** The part of @ffmpeg/ffmpeg's FFmpeg class this runner uses. */
export interface FFmpegLike {
    load(config: { coreURL: string; wasmURL: string }): Promise<unknown>;
    exec(args: string[], timeout?: number, options?: { signal?: AbortSignal }): Promise<number>;
    ffprobe(args: string[], timeout?: number, options?: { signal?: AbortSignal }): Promise<number>;
    writeFile(path: string, data: Uint8Array | string): Promise<unknown>;
    readFile(path: string, encoding?: string): Promise<Uint8Array | string>;
    deleteFile(path: string): Promise<unknown>;
    on(event: "log", callback: (event: { type: string; message: string }) => void): void;
    off(event: "log", callback: (event: { type: string; message: string }) => void): void;
    terminate(): void;
}

/**
 * Probe size for looped still inputs (`-loop 1`). The default probe (5 MB) reads the looping image again and
 * again and keeps those packets until they are decoded: several copies of a full-size image per still read
 * (about 290 MB of a 40-scene project's 1.2 GB peak heap). One packet is enough to know an image.
 */
export const STILL_PROBE_BYTES = 65536;

/** The plan as the wasm runner runs it (looped stills with STILL_PROBE_BYTES). */
export function withStillProbe(plan: ExportPlan): ExportPlan {
    return {
        ...plan,
        inputs: plan.inputs.map((input) => (input.options.includes("-loop") ? { ...input, options: [...input.options, "-probesize", String(STILL_PROBE_BYTES)] } : input)),
    };
}

/** Media bytes the runner keeps in the wasm filesystem at once (MEMFS shares the wasm32 heap with decoding). */
export const DEFAULT_WASM_MEDIA_BUDGET_BYTES = 1024 * 1024 * 1024;

export interface WasmRunnerOptions {
    /** Bytes of a timeline media URL (createFetchMediaReader, fetch-media-reader.ts). */
    readMedia(url: string, signal?: AbortSignal): Promise<Uint8Array>;
    /** Where the core is served. Default DEFAULT_FFMPEG_CORE_BASE ("/ffmpeg-core", same origin). */
    coreBaseUrl?: string;
    /** Creates and loads an FFmpeg instance. Default: @ffmpeg/ffmpeg with a SHA-256-checked core (core-loader.ts). */
    createFFmpeg?(coreBaseUrl: string): Promise<FFmpegLike>;
    /** Default "1080p". */
    maxResolution?: ExportResolution;
    /** Default DEFAULT_WASM_MEDIA_BUDGET_BYTES; above it the export fails with ExportError("too-large"). */
    maxMediaBytes?: number;
    /**
     * Streaming mux for a GPU-encoded video that arrives as a disk-backed Blob (phase 10d): ffmpeg.wasm renders only
     * the audio track, mediabunny copies the video and audio packets into `createOutput`'s stream. Without it, a Blob
     * video is read into memory and muxed by ffmpeg.wasm as before.
     */
    streamMux?: StreamMuxHost;
}

export interface StreamMuxHost {
    loadMediabunny(): Promise<typeof import("mediabunny")>;
    /** Where the final file is written; `finish` hands it over, `abort` deletes it. */
    createOutput(container: "mp4" | "webm"): Promise<{
        writable: WritableStream<{ type: "write"; data: Uint8Array; position: number }>;
        finish(): Promise<ExportOutput>;
        abort(): Promise<void>;
    }>;
}

export interface WasmRunner extends ExportRunner {
    /** Frees the wasm instance and its files. */
    dispose(): void;
}

async function defaultCreateFFmpeg(base: string): Promise<FFmpegLike> {
    const [{ FFmpeg }, core] = await Promise.all([import("@ffmpeg/ffmpeg"), loadVerifiedFfmpegCore(base)]);
    const ffmpeg = new FFmpeg();
    try {
        await ffmpeg.load({ coreURL: core.coreURL, wasmURL: core.wasmURL });
    } finally {
        core.revoke();
    }
    return ffmpeg as unknown as FFmpegLike;
}

const EXTENSION = /\.(mp4|m4v|mov|webm|mkv|m4a|mp3|wav|ogg|opus|aac|flac|png|jpe?g|webp|gif)(?:[?#]|$)/i;

export function wasmMediaName(index: number, url: string): string {
    return `m${index}.${url.match(EXTENSION)?.[1]?.toLowerCase() ?? "bin"}`;
}

export function createWasmRunner(options: WasmRunnerOptions): WasmRunner {
    const base = options.coreBaseUrl ?? DEFAULT_FFMPEG_CORE_BASE;
    const budget = options.maxMediaBytes ?? DEFAULT_WASM_MEDIA_BUDGET_BYTES;
    let instance: Promise<FFmpegLike> | null = null;
    const written = new Map<string, string>();
    let writtenBytes = 0;
    let counter = 0;
    let encoders: Set<string> | null = null;

    const ffmpeg = () => (instance ??= (options.createFFmpeg ?? defaultCreateFFmpeg)(base));
    const reset = () => {
        void instance?.then((f) => f.terminate()).catch(() => undefined);
        instance = null;
        written.clear();
        writtenBytes = 0;
    };

    /** Deletes every media file this runner wrote (after a run, a failed probe, or a cancel before run). */
    async function freeWritten(): Promise<void> {
        const names = [...written.values()];
        written.clear();
        writtenBytes = 0;
        const f = instance ? await instance.catch(() => null) : null;
        if (f) for (const name of names) await f.deleteFile(name).catch(() => undefined);
    }

    async function ensureWritten(url: string, signal?: AbortSignal): Promise<string> {
        const existing = written.get(url);
        if (existing) return existing;
        let bytes: Uint8Array;
        try {
            bytes = await options.readMedia(url, signal);
        } catch (error) {
            if (signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
            throw new ExportError("media-read-failed", `Could not read ${url}.`, String(error));
        }
        // Fail before the wasm heap fills up and the tab crashes mid-export.
        if (writtenBytes + bytes.byteLength > budget) {
            throw new ExportError("too-large", `This project's media (over ${Math.round(budget / 2 ** 20)} MB) is too large to export in the browser. Export from the desktop app.`);
        }
        const name = wasmMediaName(counter++, url);
        await (await ffmpeg()).writeFile(name, bytes);
        written.set(url, name);
        writtenBytes += bytes.byteLength;
        return name;
    }

    async function captureLogs<T>(task: (f: FFmpegLike) => Promise<T>, onLine?: (line: string) => void): Promise<{ value: T; log: string[] }> {
        const f = await ffmpeg();
        const log: string[] = [];
        const listener = ({ message }: { message: string }) => {
            log.push(message);
            if (log.length > 200) log.shift();
            onLine?.(message);
        };
        f.on("log", listener);
        try {
            return { value: await task(f), log };
        } finally {
            f.off("log", listener);
        }
    }

    /** The audio track alone (ffmpeg.wasm), then video + audio packets copied by mediabunny into the host's stream. */
    async function streamingMux(plan: MuxPlan, video: Blob, mux: MuxOptions, host: StreamMuxHost): Promise<ExportOutput> {
        const container = mux.container as "mp4" | "webm";
        const f = await ffmpeg();
        const files: string[] = [];
        let audio: Uint8Array;
        try {
            if (!encoders) {
                const { log } = await captureLogs((ff) => ff.exec(["-hide_banner", "-encoders"]));
                encoders = parseEncoderList(log.join("\n"));
            }
            const audioPlan = audioOnlyPlan(plan);
            const inputPaths: string[] = [];
            for (const input of audioPlan.inputs) inputPaths.push(await ensureWritten(input.source, mux.signal));
            await f.writeFile("audio-graph.txt", audioPlan.filterGraph);
            files.push("audio-graph.txt");
            const output = container === "mp4" ? "audio-out.m4a" : "audio-out.webm";
            files.push(output);
            const args = buildAudioTrackArgs({
                plan: audioPlan, audioArgs: muxAudioArgs(container, plan.audioBitrateKbps, encoders), inputPaths,
                filterScriptPath: "audio-graph.txt", scriptFlag: "-filter_complex_script", outputPath: output,
            });
            const onAbort = () => reset();
            mux.signal?.addEventListener("abort", onAbort, { once: true });
            let code: number;
            let log: string[];
            try {
                ({ value: code, log } = await captureLogs((ff) => ff.exec(args, -1, { signal: mux.signal }), (line) => {
                    const seconds = parseProgressSeconds(line);
                    if (seconds !== null) mux.onProgress?.(0.5 * progressRatio(seconds, plan.durationSeconds));
                }));
            } catch (error) {
                if (mux.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                throw error;
            } finally {
                mux.signal?.removeEventListener("abort", onAbort);
            }
            if (mux.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
            if (code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg.wasm could not render the export's audio.", log.slice(-20).join("\n"));
            const data = await f.readFile(output);
            audio = typeof data === "string" ? new TextEncoder().encode(data) : data;
        } finally {
            if (instance) for (const name of files) await f.deleteFile(name).catch(() => undefined);
            await freeWritten();
        }
        const mediabunny = await host.loadMediabunny();
        const out = await host.createOutput(container);
        try {
            await streamMux({ mediabunny, video, audio, container, writable: out.writable, signal: mux.signal, onProgress: (ratio) => mux.onProgress?.(0.5 + ratio / 2) });
            if (mux.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
            return await out.finish();
        } catch (error) {
            await out.abort().catch(() => undefined);
            if (mux.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
            // A stream mediabunny cannot copy: the caller may fall back like for an ffmpeg mux failure.
            if (error instanceof ExportError) throw error;
            throw new ExportError("ffmpeg-failed", "The export's video and audio could not be combined.", error instanceof Error ? error.message : String(error));
        }
    }

    return {
        kind: "wasm",
        supportsGl: false,
        maxResolution: options.maxResolution ?? "1080p",

        async probe(urls, signal) {
            const out = new Map<string, MediaInfo>();
            // A cancel between probe and run would otherwise leave every probed file in memory.
            signal?.addEventListener("abort", () => void freeWritten(), { once: true });
            for (const url of urls) {
                let name: string;
                try {
                    name = await ensureWritten(url, signal);
                } catch (error) {
                    if (error instanceof ExportError && (error.code === "cancelled" || error.code === "too-large")) {
                        await freeWritten();
                        throw error;
                    }
                    continue;
                }
                const f = await ffmpeg();
                const json = `${name}.probe.json`;
                // ffmpeg.wasm 0.12 ffprobe returns -1 even on success: trust the JSON, not the exit code.
                await f.ffprobe([...FFPROBE_ARGS, name, "-o", json]).catch(() => -1);
                const text = await f.readFile(json, "utf8").catch(() => "");
                await f.deleteFile(json).catch(() => undefined);
                const info = parseFfprobeJson(typeof text === "string" ? text : new TextDecoder().decode(text));
                if (info) out.set(url, info);
            }
            return out;
        },

        async chooseEncoder(encoderOptions) {
            const { log } = await captureLogs((f) => f.exec(["-hide_banner", "-encoders"]));
            encoders = parseEncoderList(log.join("\n"));
            // libvpx-vp9 in @ffmpeg/core 0.12.10 crashes ("memory access out of bounds") on 720p frames.
            const [first] = encoderCandidates(parseEncoderList(log.join("\n")), encoderOptions).filter((c) => c.name !== "libvpx-vp9");
            return first;
        },

        async run(plan, encoder, run = {}) {
            const f = await ffmpeg();
            const files: string[] = [];
            try {
                // Job files (text bitmaps, graphics image sequences) share the wasm heap with the media: count them too.
                const fileBytes = plan.files.reduce((sum, file) => sum + file.data.byteLength, 0);
                if (writtenBytes + fileBytes > budget) {
                    throw new ExportError("too-large", `This project's graphics and media (over ${Math.round(budget / 2 ** 20)} MB) are too large to export in the browser. Export from the desktop app.`);
                }
                writtenBytes += fileBytes;
                for (const file of plan.files) {
                    await f.writeFile(file.name, new Uint8Array(file.data));
                    files.push(file.name);
                }
                const inputPaths: string[] = [];
                for (const input of plan.inputs) {
                    inputPaths.push(input.kind === "file" ? input.source : await ensureWritten(input.source, run.signal));
                }
                await f.writeFile("graph.txt", filterScript(plan, encoder).script);
                files.push("graph.txt");
                const output = `out.${encoder.container}`;
                const args = buildFfmpegArgs({
                    plan: withStillProbe(plan), encoder, inputPaths, filterScriptPath: "graph.txt", scriptFlag: "-filter_complex_script", outputPath: output,
                });
                const onAbort = () => reset();
                run.signal?.addEventListener("abort", onAbort, { once: true });
                let code: number;
                let log: string[];
                try {
                    ({ value: code, log } = await captureLogs((ff) => ff.exec(args, -1, { signal: run.signal }), (line) => {
                        const seconds = parseProgressSeconds(line);
                        if (seconds !== null) run.onProgress?.(progressRatio(seconds, plan.durationSeconds));
                    }));
                } catch (error) {
                    if (run.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                    throw error;
                } finally {
                    run.signal?.removeEventListener("abort", onAbort);
                }
                if (code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg.wasm could not render the export.", log.slice(-20).join("\n"));
                const data = await f.readFile(output);
                files.push(output);
                return { kind: "bytes", data: typeof data === "string" ? new TextEncoder().encode(data) : data };
            } finally {
                if (instance) for (const name of files) await f.deleteFile(name).catch(() => undefined);
                await freeWritten();
            }
        },

        async mux(plan: MuxPlan, video: MuxVideo, mux: MuxOptions): Promise<ExportOutput> {
            if (video.kind === "file") throw new ExportError("runner-unsupported", "ffmpeg.wasm muxes video bytes only.");
            if (video.kind === "blob") {
                if (options.streamMux && (mux.container === "mp4" || mux.container === "webm")) return streamingMux(plan, video.blob, mux, options.streamMux);
                video = { kind: "bytes", data: new Uint8Array(await video.blob.arrayBuffer()) };
            }
            const f = await ffmpeg();
            const files: string[] = [];
            try {
                if (!encoders) {
                    const { log } = await captureLogs((ff) => ff.exec(["-hide_banner", "-encoders"]));
                    encoders = parseEncoderList(log.join("\n"));
                }
                const videoName = `gpu-video.${mux.container}`;
                await f.writeFile(videoName, video.data);
                files.push(videoName);
                // Only the audio media reach MEMFS (the GPU path decoded the pictures itself).
                const inputPaths = [videoName];
                for (const input of plan.inputs.slice(1)) inputPaths.push(await ensureWritten(input.source, mux.signal));
                await f.writeFile("mux-graph.txt", plan.filterGraph);
                files.push("mux-graph.txt");
                const output = `mux-out.${mux.container}`;
                // Listed before the run: a failed or cancelled mux must not leave its partial output in wasm memory.
                files.push(output);
                const args = buildMuxArgs({
                    plan, container: mux.container, audioArgs: muxAudioArgs(mux.container, plan.audioBitrateKbps, encoders), inputPaths,
                    filterScriptPath: "mux-graph.txt", scriptFlag: "-filter_complex_script", outputPath: output,
                });
                const onAbort = () => reset();
                mux.signal?.addEventListener("abort", onAbort, { once: true });
                let code: number;
                let log: string[];
                try {
                    ({ value: code, log } = await captureLogs((ff) => ff.exec(args, -1, { signal: mux.signal }), (line) => {
                        const seconds = parseProgressSeconds(line);
                        if (seconds !== null) mux.onProgress?.(progressRatio(seconds, plan.durationSeconds));
                    }));
                } catch (error) {
                    if (mux.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                    throw error;
                } finally {
                    mux.signal?.removeEventListener("abort", onAbort);
                }
                if (mux.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                if (code !== 0) throw new ExportError("ffmpeg-failed", "ffmpeg.wasm could not add the audio to the export.", log.slice(-20).join("\n"));
                const data = await f.readFile(output);
                return { kind: "bytes" as const, data: typeof data === "string" ? new TextEncoder().encode(data) : data };
            } finally {
                if (instance) for (const name of files) await f.deleteFile(name).catch(() => undefined);
                await freeWritten();
            }
        },

        async gif(plan: GifPlan, video: MuxVideo, gif: MuxOptions) {
            if (video.kind === "file") throw new ExportError("runner-unsupported", "ffmpeg.wasm makes GIFs from video bytes only.");
            // A streamed intermediate (OPFS) is small at GIF size: read it in.
            if (video.kind === "blob") video = { kind: "bytes", data: new Uint8Array(await video.blob.arrayBuffer()) };
            const f = await ffmpeg();
            const videoName = `gif-video.${gif.container}`;
            const palette = "gif-palette.png";
            const output = "gif-out.gif";
            // Every name is listed before its step: a failed or cancelled step leaves nothing in wasm memory.
            const files = [videoName, palette, output];
            const step = async (args: string[], from: number, to: number, message: string) => {
                const onAbort = () => reset();
                gif.signal?.addEventListener("abort", onAbort, { once: true });
                let code: number;
                let log: string[];
                try {
                    ({ value: code, log } = await captureLogs((ff) => ff.exec(args, -1, { signal: gif.signal }), (line) => {
                        const seconds = parseProgressSeconds(line);
                        if (seconds !== null) gif.onProgress?.(from + (to - from) * progressRatio(seconds, plan.durationSeconds));
                    }));
                } catch (error) {
                    if (gif.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                    throw error;
                } finally {
                    gif.signal?.removeEventListener("abort", onAbort);
                }
                if (gif.signal?.aborted) throw new ExportError("cancelled", "Export cancelled.");
                if (code !== 0) throw new ExportError("ffmpeg-failed", message, log.slice(-20).join("\n"));
            };
            try {
                await f.writeFile(videoName, video.data);
                await step(buildGifPaletteArgs({ plan, inputPath: videoName, outputPath: palette }), 0, 0.4, "ffmpeg.wasm could not build the GIF palette.");
                await step(buildGifArgs({ plan, inputPath: videoName, palettePath: palette, outputPath: output }), 0.4, 1, "ffmpeg.wasm could not write the GIF.");
                const data = await f.readFile(output);
                return { kind: "bytes" as const, data: typeof data === "string" ? new TextEncoder().encode(data) : data };
            } finally {
                if (instance) for (const name of files) await f.deleteFile(name).catch(() => undefined);
            }
        },

        dispose: reset,
    };
}
