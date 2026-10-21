"use client";
// Phase 4 (optional / opt-in): in-browser trim + concat + export via ffmpeg.wasm.
//
// Preview is already instant from local clip state (Phases 1-2 give cut/trim
// without any render), so this is ONLY for producing a real downloadable file
// without the server. It is heavy (memory-bound, slow for HD) so it is fully
// lazy — the ~30MB wasm core loads on first use, never at page load — and the
// server `assemble_video` path remains the default for final export.
//
// The ffmpeg argument builders are pure and unit-tested; the FFmpeg runtime is
// loaded lazily so the bundle stays light and SSR is unaffected.

export interface TrimRange {
    // Seconds into the source.
    start: number;
    // Clip duration in seconds.
    duration: number;
}

// ffmpeg args to losslessly (stream-copy) trim a source to [start, start+duration].
export function buildTrimArgs(input: string, range: TrimRange, output: string): string[] {
    return [
        "-ss",
        range.start.toFixed(3),
        "-t",
        Math.max(0, range.duration).toFixed(3),
        "-i",
        input,
        "-c",
        "copy",
        output,
    ];
}

// Contents of the concat-demuxer list file referencing the given (already
// written) virtual filenames, in order.
export function buildConcatListFile(filenames: string[]): string {
    return filenames.map((name) => `file '${name}'`).join("\n") + "\n";
}

// ffmpeg args to concat a list file produced by buildConcatListFile.
export function buildConcatArgs(listFile: string, output: string): string[] {
    return ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output];
}

// Default CDN host for the single-threaded core; overridable for self-hosting.
const FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

export interface LocalExporterOptions {
    coreBaseUrl?: string;
    onProgress?: (ratio: number) => void;
    onLog?: (message: string) => void;
}

// Thin wrapper around @ffmpeg/ffmpeg with lazy loading and a small trim/concat
// API tailored to timeline clips.
export class LocalExporter {
    private ffmpeg: import("@ffmpeg/ffmpeg").FFmpeg | null = null;
    private loadPromise: Promise<void> | null = null;
    private opts: LocalExporterOptions;

    constructor(opts: LocalExporterOptions = {}) {
        this.opts = opts;
    }

    static isSupported(): boolean {
        return (
            typeof window !== "undefined" &&
            typeof WebAssembly !== "undefined" &&
            typeof SharedArrayBuffer !== "undefined"
        );
    }

    // Lazily import the wrapper + fetch the wasm core (idempotent).
    async load(): Promise<void> {
        if (this.ffmpeg) return;
        if (!this.loadPromise) {
            this.loadPromise = (async () => {
                const { FFmpeg } = await import("@ffmpeg/ffmpeg");
                const { toBlobURL } = await import("@ffmpeg/util");
                const base = this.opts.coreBaseUrl ?? FFMPEG_CORE_BASE;
                const ffmpeg = new FFmpeg();
                if (this.opts.onLog) {
                    ffmpeg.on("log", ({ message }) => this.opts.onLog?.(message));
                }
                if (this.opts.onProgress) {
                    ffmpeg.on("progress", ({ progress }) => this.opts.onProgress?.(progress));
                }
                await ffmpeg.load({
                    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
                    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
                });
                this.ffmpeg = ffmpeg;
            })();
        }
        await this.loadPromise;
    }

    private get instance(): import("@ffmpeg/ffmpeg").FFmpeg {
        if (!this.ffmpeg) throw new Error("LocalExporter not loaded — call load() first"); // i18n-ignore — internal log
        return this.ffmpeg;
    }

    // Trim a fetched source blob/URL to a range; returns the output bytes.
    async trim(source: Blob | string, range: TrimRange, ext = "mp4"): Promise<Uint8Array> {
        await this.load();
        const { fetchFile } = await import("@ffmpeg/util");
        const input = `in.${ext}`;
        const output = `out.${ext}`;
        await this.instance.writeFile(input, await fetchFile(source));
        await this.instance.exec(buildTrimArgs(input, range, output));
        const data = await this.instance.readFile(output);
        return data as Uint8Array;
    }

    // Concatenate multiple fetched sources (same codec/params) into one file.
    async concat(sources: (Blob | string)[], ext = "mp4"): Promise<Uint8Array> {
        await this.load();
        const { fetchFile } = await import("@ffmpeg/util");
        const names: string[] = [];
        for (let i = 0; i < sources.length; i += 1) {
            const name = `seg${i}.${ext}`;
            await this.instance.writeFile(name, await fetchFile(sources[i]));
            names.push(name);
        }
        const listFile = "concat.txt";
        await this.instance.writeFile(listFile, buildConcatListFile(names));
        const output = `out.${ext}`;
        await this.instance.exec(buildConcatArgs(listFile, output));
        const data = await this.instance.readFile(output);
        return data as Uint8Array;
    }

    // Release the wasm instance + its memory.
    terminate(): void {
        this.ffmpeg?.terminate();
        this.ffmpeg = null;
        this.loadPromise = null;
    }
}
