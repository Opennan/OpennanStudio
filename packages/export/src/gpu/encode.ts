// WebCodecs encoding for the GPU export path (phase 10c), through mediabunny's encoder and muxers: H.264 in MP4
// when the browser has an H.264 encoder (Chrome, Edge, Safari, Electron; usually in hardware), else VP9 (or AV1 /
// VP8) in WebM. Frames are captured from the compositor's canvas with encoder backpressure.
import type { ExportContainer } from "../encoders";
import type { MuxVideo } from "../runner";

type Mediabunny = typeof import("mediabunny");
type VideoCodec = import("mediabunny").VideoCodec;

export const GPU_CODECS: readonly VideoCodec[] = ["avc", "vp9", "av1", "vp8"];

export interface GpuCodecChoice {
    codec: VideoCodec;
    container: Extract<ExportContainer, "mp4" | "webm">;
    /** ExportResult.encoder, e.g. "webcodecs-avc". */
    name: string;
}

/** The first codec this browser encodes at the output size and bitrate, or null (no WebCodecs encoder). */
export async function chooseGpuCodec(mb: Mediabunny, size: { width: number; height: number }, bitrateKbps: number, codecs: readonly VideoCodec[] = GPU_CODECS): Promise<GpuCodecChoice | null> {
    if (typeof VideoEncoder === "undefined") return null;
    const codec = await mb.getFirstEncodableVideoCodec([...codecs], { width: size.width, height: size.height, bitrate: bitrateKbps * 1000 }).catch(() => null);
    if (!codec) return null;
    return { codec, container: codec === "avc" ? "mp4" : "webm", name: `webcodecs-${codec}` };
}

/** Where encoded bytes go: memory (web; the mux runs on ffmpeg.wasm) or a host stream (desktop: chunks to main). */
export interface GpuVideoSink {
    writable: WritableStream<{ type: "write"; data: Uint8Array; position: number }>;
    /** After finalize: the video as the runner's mux reads it. */
    done(): Promise<MuxVideo>;
    abort(): Promise<void>;
    /** After the mux: frees the intermediate (e.g. deletes its file). */
    release?(): Promise<void>;
}

export interface GpuEncoder {
    readonly choice: GpuCodecChoice;
    /** Captures the canvas as output frame k. */
    add(k: number): Promise<void>;
    finish(): Promise<MuxVideo>;
    cancel(): Promise<void>;
}

export interface GpuEncoderOptions {
    canvas: HTMLCanvasElement | OffscreenCanvas;
    choice: GpuCodecChoice;
    fps: number;
    bitrateKbps: number;
    /** Default: in memory. */
    sink?: GpuVideoSink;
}

export async function createGpuEncoder(mb: Mediabunny, options: GpuEncoderOptions): Promise<GpuEncoder> {
    const { choice, fps } = options;
    const target = options.sink ? new mb.StreamTarget(options.sink.writable as never, { chunked: true }) : new mb.BufferTarget();
    // fastStart off: the mux step rewrites the file with +faststart anyway, and a stream target cannot hold it all.
    const format = choice.container === "mp4" ? new mb.Mp4OutputFormat({ fastStart: false }) : new mb.WebMOutputFormat();
    const output = new mb.Output({ format, target });
    const source = new mb.CanvasSource(options.canvas as HTMLCanvasElement, {
        codec: choice.codec,
        bitrate: options.bitrateKbps * 1000,
        keyFrameInterval: 2,
        // Quality mode for every codec: in realtime mode an encoder may drop frames to hold its bitrate.
        latencyMode: "quality",
    });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    let finished = false;
    return {
        choice,
        add: (k) => source.add(k / fps, 1 / fps),
        async finish() {
            source.close();
            await output.finalize();
            // Finished only once finalized: a failed finalize still lets cancel() close the output and abort the sink.
            finished = true;
            if (options.sink) return options.sink.done();
            const buffer = (target as InstanceType<Mediabunny["BufferTarget"]>).buffer;
            if (!buffer) throw new Error("the encoder produced no output"); // i18n-ignore
            return { kind: "bytes", data: new Uint8Array(buffer) };
        },
        async cancel() {
            if (finished) return;
            finished = true;
            await output.cancel().catch(() => undefined);
            await options.sink?.abort().catch(() => undefined);
        },
    };
}
