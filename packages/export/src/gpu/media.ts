// Media for the GPU export path (phase 10c): streaming WebCodecs decode through mediabunny (demux from ranged reads,
// hardware decode where the browser has it), still images and raster bitmaps as ImageBitmaps, and media facts
// probed without ever loading whole files. Memory stays bounded: a stream keeps the sample it shows and one
// lookahead sample, and the export loop closes every stream and image after the last frame that uses it (the
// ffmpeg.wasm path kept every input and every scene decoder alive until the end).
import type { MediaInfo } from "../types";
import { gifEnd, gifFrameDurations, gifPick, parseGif, type GifInfo } from "./gif";
import type { VideoRead } from "./plan";

type Mediabunny = typeof import("mediabunny");
type Input = import("mediabunny").Input;
type InputVideoTrack = import("mediabunny").InputVideoTrack;
type VideoSample = import("mediabunny").VideoSample;
type VideoSampleSink = import("mediabunny").VideoSampleSink;

export interface ProbedMedia extends MediaInfo {
    /** WebCodecs can decode the video track (false: the GPU path cannot render this file). */
    decodable: boolean;
    /** Display rotation in degrees clockwise (applied by the compositor; width/height are already rotated). */
    rotation: number;
    still: boolean;
}

export interface GpuMediaOptions {
    mediabunny: Mediabunny;
    /** A mediabunny Source for a media URL (ranged reads; the host adds auth for its own origin). */
    createSource(url: string): import("mediabunny").Source | Promise<import("mediabunny").Source>;
    /** Bytes of a still image. */
    fetchBlob(url: string, signal?: AbortSignal): Promise<Blob>;
    /** Default globalThis.createImageBitmap. */
    createImageBitmap?(blob: Blob): Promise<ImageBitmap>;
    /** Frames a reverse read decodes and holds at once (default: what fits in REVERSE_BUDGET_BYTES, 8–60). */
    reverseChunkFrames?: number;
    /** Default `new ImageDecoder(init)` (WebCodecs): animated GIF frames. */
    createImageDecoder?(init: ImageDecoderInit): GifDecoder;
}

/** The part of WebCodecs' ImageDecoder the GIF reader uses. */
export interface GifDecoder {
    tracks: { ready: Promise<void> };
    decode(options: { frameIndex: number; completeFramesOnly?: boolean }): Promise<{ image: VideoFrame }>;
    close(): void;
}

const GIF = /\.gif(?:[?#]|$)/i;

/**
 * An animated GIF read (phase 10d): frame timing from the file's blocks as ffmpeg's demuxer times them (gpu/gif.ts),
 * pixels from ImageDecoder, one decoded frame held (the one shown), closed when the next one shows.
 */
interface GifStream {
    url: string;
    info: GifInfo;
    decoder: GifDecoder;
    current: { image: number; sample: VideoSample } | null;
}

const STILL = /\.(png|jpe?g|webp|bmp|avif)(?:[?#]|$)/i;

/** The decoded frame a read shows; the compositor uploads `sample` and never closes it (the stream does). */
export interface StreamFrame {
    sample: VideoSample;
    rotation: number;
    /**
     * The colour space to convert the frame with, when the file does not say (null: the frame's own). Browsers
     * assume BT.709 for such frames; ffmpeg (the compatible export) and the preview's SD video assume BT.601.
     */
    colorSpace: VideoColorSpaceInit | null;
}

/** ffmpeg's reading of a YUV stream without a colour matrix: BT.601, no gamut or transfer conversion. */
export function unspecifiedColorSpace(track: VideoColorSpaceInit): VideoColorSpaceInit | null {
    if (track.matrix) return null;
    return { matrix: "smpte170m", primaries: "bt709", transfer: "bt709", fullRange: track.fullRange ?? false };
}

interface Stream {
    url: string;
    sink: VideoSampleSink;
    iterator: AsyncGenerator<VideoSample, void, unknown> | null;
    current: VideoSample | null;
    next: VideoSample | null;
    done: boolean;
    last: number;
}

interface Source {
    input: Input;
    track: InputVideoTrack | null;
    rotation: number;
    colorSpace: VideoColorSpaceInit | null;
    users: number;
}

/** Seconds a stream may jump forward and still decode through (beyond that it reseeks from a key frame). */
const MAX_DECODE_AHEAD = 3;

/** CPU memory a reverse read's chunk of frame copies may take (RGBA copies: about 16 frames at 1080p). */
const REVERSE_BUDGET_BYTES = 128 * 1024 * 1024;
const MIN_REVERSE_CHUNK = 8;
const MAX_REVERSE_CHUNK = 60;

/**
 * A reverse read's stream (phase 10d, ffmpeg's `reverse`): the read's frame times (packet metadata only) and one
 * chunk of decoded frames at a time — at most `size` frames, decoded forward from the key frame before the chunk,
 * served backwards, and closed as soon as requests pass below them. The whole clip is never held.
 */
interface ReverseStream {
    url: string;
    sink: VideoSampleSink;
    track: InputVideoTrack;
    times: Map<string, Promise<number[]>>;
    /** Frame index (in `times`) → a CPU copy of the decoded frame. */
    chunk: Map<number, VideoSample>;
    size: number;
}

export class GpuMedia {
    private readonly options: GpuMediaOptions;
    private readonly sources = new Map<string, Promise<Source | null>>();
    private readonly streams = new Map<string, Promise<Stream | null>>();
    private readonly reverseStreams = new Map<string, Promise<ReverseStream | null>>();
    private readonly gifStreams = new Map<string, Promise<GifStream | null>>();
    /** GIF bytes and blocks by URL, kept while a GIF stream or a probe uses them. */
    private readonly gifData = new Map<string, Promise<{ bytes: Uint8Array; info: GifInfo } | null>>();
    private readonly anchors = new Map<string, Promise<number>>();
    private readonly images = new Map<string, Promise<ImageBitmap | null>>();
    private readonly probed = new Map<string, ProbedMedia>();
    private disposed = false;

    constructor(options: GpuMediaOptions) {
        this.options = options;
    }

    private bitmap(blob: Blob): Promise<ImageBitmap> {
        if (this.options.createImageBitmap) return this.options.createImageBitmap(blob);
        // Straight alpha and the file's own colours, as the preview's <img> and ffmpeg read them.
        return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "from-image" });
    }

    private source(url: string): Promise<Source | null> {
        let entry = this.sources.get(url);
        if (!entry) {
            entry = (async () => {
                const mb = this.options.mediabunny;
                const created = await Promise.resolve(this.options.createSource(url)).catch(() => null);
                if (!created) return null;
                const input = new mb.Input({ source: created, formats: mb.ALL_FORMATS });
                try {
                    const track = await input.getPrimaryVideoTrack();
                    const rotation = track ? Number(await track.getRotation()) || 0 : 0;
                    const colorSpace = track ? unspecifiedColorSpace(await track.getColorSpace().catch(() => ({}))) : null;
                    return { input, track, rotation, colorSpace, users: 0 };
                } catch {
                    input.dispose();
                    return null;
                }
            })();
            this.sources.set(url, entry);
        }
        return entry;
    }

    /** Media facts by URL (unreadable media is left out of the map, as the ffmpeg runners do). */
    async probe(urls: readonly string[], signal?: AbortSignal): Promise<Map<string, ProbedMedia>> {
        const out = new Map<string, ProbedMedia>();
        for (const url of urls) {
            if (signal?.aborted) break;
            const cached = this.probed.get(url);
            if (cached) {
                out.set(url, cached);
                continue;
            }
            const info = await this.probeOne(url, signal).catch(() => null);
            // Probing opens a demuxer per file; streams reopen theirs when their first frame comes.
            await this.releaseSource(url);
            if (info) {
                this.probed.set(url, info);
                out.set(url, info);
            }
        }
        return out;
    }

    private gif(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; info: GifInfo } | null> {
        let entry = this.gifData.get(url);
        if (!entry) {
            entry = (async () => {
                try {
                    const bytes = new Uint8Array(await (await this.options.fetchBlob(url, signal)).arrayBuffer());
                    return { bytes, info: parseGif(bytes) };
                } catch {
                    return null;
                }
            })();
            this.gifData.set(url, entry);
        }
        return entry;
    }

    private canDecodeGif(): boolean {
        return Boolean(this.options.createImageDecoder) || typeof ImageDecoder !== "undefined";
    }

    private async probeOne(url: string, signal?: AbortSignal): Promise<ProbedMedia | null> {
        if (GIF.test(url)) {
            const gif = await this.gif(url, signal);
            if (![...this.gifStreams.values()].length) this.gifData.delete(url);
            if (!gif || gif.info.delays.length === 0) return null;
            const end = gifEnd(gif.info);
            const duration = Number.isFinite(end) ? end : gifFrameDurations(gif.info).reduce((a, b) => a + b, 0);
            return { durationSeconds: duration, hasVideo: true, hasAudio: false, width: gif.info.width, height: gif.info.height, decodable: this.canDecodeGif(), rotation: 0, still: false };
        }
        if (STILL.test(url)) {
            const image = await this.image(url, signal);
            if (!image) return null;
            return { durationSeconds: 0, hasVideo: true, hasAudio: false, width: image.width, height: image.height, decodable: true, rotation: 0, still: true };
        }
        const source = await this.source(url);
        if (!source) return null;
        const audio = await source.input.getPrimaryAudioTrack().catch(() => null);
        const duration = await source.input.computeDuration().catch(() => 0);
        const track = source.track;
        if (!track) {
            return { durationSeconds: duration, hasVideo: false, hasAudio: Boolean(audio), width: 0, height: 0, decodable: false, rotation: 0, still: false };
        }
        const decodable = await track.canDecode().catch(() => false);
        const w = track.squarePixelWidth || track.codedWidth;
        const h = track.squarePixelHeight || track.codedHeight;
        const turned = source.rotation % 180 !== 0;
        return {
            durationSeconds: duration, hasVideo: true, hasAudio: Boolean(audio),
            width: turned ? h : w, height: turned ? w : h, decodable, rotation: source.rotation, still: false,
        };
    }

    /** The first frame time at or after `seek` (what `-ss` keeps), from packet metadata only. */
    private anchor(read: VideoRead): Promise<number> {
        if (read.anchor === "absolute") return Promise.resolve(read.seek);
        const key = `${read.url}|${read.seek}`;
        let entry = this.anchors.get(key);
        if (!entry) {
            entry = (async () => {
                const source = await this.source(read.url);
                if (!source?.track) return read.seek;
                const packets = new this.options.mediabunny.EncodedPacketSink(source.track);
                const before = await packets.getPacket(read.seek - 1e-6, { metadataOnly: true }).catch(() => null);
                if (!before) return source.track.getFirstTimestamp().catch(() => read.seek);
                return before.timestamp + before.duration;
            })();
            this.anchors.set(key, entry);
        }
        return entry;
    }

    private stream(read: VideoRead): Promise<Stream | null> {
        let entry = this.streams.get(read.stream);
        if (!entry) {
            entry = (async () => {
                const source = await this.source(read.url);
                if (!source?.track) return null;
                source.users += 1;
                return { url: read.url, sink: new this.options.mediabunny.VideoSampleSink(source.track), iterator: null, current: null, next: null, done: false, last: -Infinity };
            })();
            this.streams.set(read.stream, entry);
        }
        return entry;
    }

    /**
     * The frame read `read` shows at its piece frame `index`: the last frame at or before anchor + offsetAt(index),
     * or null past the media's end. Requests within a stream should move forward; a backward request reseeks.
     */
    async frame(read: VideoRead, index: number): Promise<StreamFrame | null> {
        if (this.disposed) return null;
        if (GIF.test(read.url)) return this.gifFrame(read, index);
        if (read.reverse) return this.reverseFrame(read, read.reverse.span, index);
        const stream = await this.stream(read);
        if (!stream) return null;
        const source = await this.source(read.url);
        const time = (await this.anchor(read)) + read.offsetAt(index);
        const sample = await this.advance(stream, time);
        if (!sample) return null;
        // Past the last frame's end: the ffmpeg read has ended (its overlay passes the background through).
        if (stream.done && time >= sample.timestamp + Math.max(sample.duration, 1e-3) + 1e-6) return null;
        return { sample, rotation: source?.rotation ?? 0, colorSpace: source?.colorSpace ?? null };
    }

    private gifStream(read: VideoRead): Promise<GifStream | null> {
        let entry = this.gifStreams.get(read.stream);
        if (!entry) {
            entry = (async () => {
                const gif = await this.gif(read.url);
                if (!gif) return null;
                const init: ImageDecoderInit = { data: gif.bytes, type: "image/gif", premultiplyAlpha: "none", colorSpaceConversion: "none" };
                const decoder = this.options.createImageDecoder ? this.options.createImageDecoder(init) : (new ImageDecoder(init) as unknown as GifDecoder);
                await decoder.tracks.ready;
                return { url: read.url, info: gif.info, decoder, current: null };
            })().catch(() => null);
            this.gifStreams.set(read.stream, entry);
        }
        return entry;
    }

    /** The GIF frame a read shows at its piece frame (GIF reads start at the file's first frame: anchor 0). */
    private async gifFrame(read: VideoRead, index: number): Promise<StreamFrame | null> {
        const stream = await this.gifStream(read);
        if (!stream || this.disposed) return null;
        const image = gifPick(stream.info, read.offsetAt(index), read.reverse);
        if (image === null) return null;
        if (stream.current?.image !== image) {
            stream.current?.sample.close();
            stream.current = null;
            const { image: frame } = await stream.decoder.decode({ frameIndex: image, completeFramesOnly: true });
            stream.current = { image, sample: new this.options.mediabunny.VideoSample(frame) };
        }
        return { sample: stream.current.sample, rotation: 0, colorSpace: null };
    }

    private reverseStream(read: VideoRead): Promise<ReverseStream | null> {
        let entry = this.reverseStreams.get(read.stream);
        if (!entry) {
            entry = (async () => {
                const source = await this.source(read.url);
                if (!source?.track) return null;
                source.users += 1;
                const bytes = Math.max(1, source.track.codedWidth * source.track.codedHeight * 4);
                const size = this.options.reverseChunkFrames ?? Math.min(MAX_REVERSE_CHUNK, Math.max(MIN_REVERSE_CHUNK, Math.floor(REVERSE_BUDGET_BYTES / bytes)));
                return { url: read.url, sink: new this.options.mediabunny.VideoSampleSink(source.track), track: source.track, times: new Map(), chunk: new Map(), size };
            })();
            this.reverseStreams.set(read.stream, entry);
        }
        return entry;
    }

    /** Presentation times of the frames in [from, to), from packet metadata (decode order sorted). */
    private frameTimes(stream: ReverseStream, from: number, to: number): Promise<number[]> {
        const key = `${from}|${to}`;
        let entry = stream.times.get(key);
        if (!entry) {
            entry = (async () => {
                const packets = new this.options.mediabunny.EncodedPacketSink(stream.track);
                const options = { metadataOnly: true };
                let packet = (await packets.getKeyPacket(from, options).catch(() => null)) ?? (await packets.getFirstPacket(options).catch(() => null));
                const times = new Set<number>();
                // Past `to`, a key packet ends the reordering window: every frame before `to` has been seen.
                while (packet && !(packet.type === "key" && packet.timestamp >= to)) {
                    if (packet.timestamp >= from - 1e-9 && packet.timestamp < to - 1e-9) times.add(packet.timestamp);
                    packet = await packets.getNextPacket(packet, options).catch(() => null);
                }
                return [...times].sort((a, b) => a - b);
            })();
            stream.times.set(key, entry);
        }
        return entry;
    }

    private async reverseFrame(read: VideoRead, span: number, index: number): Promise<StreamFrame | null> {
        const stream = await this.reverseStream(read);
        if (!stream) return null;
        const source = await this.source(read.url);
        const anchor = await this.anchor(read);
        const times = await this.frameTimes(stream, anchor, anchor + span);
        if (times.length === 0) return null;
        const t = anchor + read.offsetAt(index);
        let j = 0;
        while (j + 1 < times.length && times[j + 1] <= t + 1e-9) j += 1;
        const sample = await this.reverseSample(stream, times, times.length - 1 - j, Boolean(source?.colorSpace));
        if (!sample || this.disposed) return null;
        return { sample, rotation: source?.rotation ?? 0, colorSpace: source?.colorSpace ?? null };
    }

    /** Frame `m` of `times` from the current chunk, decoding the chunk that ends at it when needed. */
    private async reverseSample(stream: ReverseStream, times: number[], m: number, unspecified: boolean): Promise<VideoSample | null> {
        if (!stream.chunk.has(m)) {
            this.closeChunk(stream);
            const lo = Math.max(0, m - stream.size + 1);
            const iterator = stream.sink.samples(times[lo], times[m] + 1e-6);
            try {
                for await (const sample of iterator) {
                    const k = nearestIndex(times, sample.timestamp);
                    if (k < lo || k > m || stream.chunk.has(k) || this.disposed) {
                        sample.close();
                        continue;
                    }
                    stream.chunk.set(k, await this.copySample(sample, unspecified));
                }
            } finally {
                await iterator.return(undefined).catch(() => undefined);
            }
        }
        // Requests move backwards: frames above the one shown are done.
        for (const [k, sample] of stream.chunk) {
            if (k > m) {
                sample.close();
                stream.chunk.delete(k);
            }
        }
        let k = m;
        while (k >= 0 && !stream.chunk.has(k)) k -= 1;
        return stream.chunk.get(k) ?? null;
    }

    /**
     * A CPU copy of a decoded frame (the decoder's own frame closes at once: hardware decoders stall while their frames
     * are held); the frame itself when it cannot be copied. A file without a colour matrix keeps its YUV planes and no
     * colour space, so the export applies the track's reading afterwards exactly as for forward reads (withColorSpace);
     * any other frame is converted to RGBA by the browser with its own colour space (a buffer frame rebuilt from
     * planes would lose it: Chromium drew a GBR VP9 frame rebuilt that way green).
     */
    private async copySample(sample: VideoSample, unspecified: boolean): Promise<VideoSample> {
        const mb = this.options.mediabunny;
        if (!sample.format || typeof VideoFrame === "undefined") return sample;
        let frame: VideoFrame | null = null;
        try {
            frame = sample.toVideoFrame();
            const rect = frame.visibleRect!;
            const size = { codedWidth: rect.width, codedHeight: rect.height, displayWidth: frame.displayWidth, displayHeight: frame.displayHeight, timestamp: frame.timestamp, duration: frame.duration ?? undefined };
            let copy: VideoFrame;
            if (unspecified) {
                const data = new Uint8Array(frame.allocationSize());
                const layout = await frame.copyTo(data);
                copy = new VideoFrame(data, { format: frame.format!, ...size, layout });
            } else {
                const options = { format: "RGBA" as VideoPixelFormat, colorSpace: "srgb" as PredefinedColorSpace };
                const data = new Uint8Array(frame.allocationSize(options));
                const layout = await frame.copyTo(data, options);
                copy = new VideoFrame(data, { format: "RGBA", ...size, layout, colorSpace: { matrix: "rgb", primaries: "bt709", transfer: "iec61966-2-1", fullRange: true } });
            }
            frame.close();
            sample.close();
            return new mb.VideoSample(copy);
        } catch {
            frame?.close();
            return sample;
        }
    }

    private closeChunk(stream: ReverseStream): void {
        for (const sample of stream.chunk.values()) sample.close();
        stream.chunk.clear();
    }

    private async advance(stream: Stream, time: number): Promise<VideoSample | null> {
        const current = stream.current;
        const restart = !stream.iterator
            || (current && time < current.timestamp - 1e-9)
            || (!current && time < stream.last - 1e-9)
            || time - stream.last > MAX_DECODE_AHEAD;
        if (restart) {
            await this.reset(stream);
            stream.iterator = stream.sink.samples(Math.max(0, time - 0.1));
        }
        stream.last = time;
        while (!stream.done) {
            if (!stream.next) {
                const result = await stream.iterator!.next();
                if (result.done) {
                    stream.done = true;
                    break;
                }
                stream.next = result.value;
            }
            if (stream.next.timestamp <= time + 1e-9) {
                stream.current?.close();
                stream.current = stream.next;
                stream.next = null;
            } else {
                break;
            }
        }
        return stream.current;
    }

    private async reset(stream: Stream): Promise<void> {
        stream.current?.close();
        stream.next?.close();
        stream.current = null;
        stream.next = null;
        stream.done = false;
        const iterator = stream.iterator;
        stream.iterator = null;
        await iterator?.return(undefined).catch(() => undefined);
    }

    /** Closes a stream's decoder and samples (after the last frame that uses it). */
    async closeStream(key: string): Promise<void> {
        const gif = this.gifStreams.get(key);
        if (gif) {
            this.gifStreams.delete(key);
            const stream = await gif.catch(() => null);
            if (stream) {
                stream.current?.sample.close();
                stream.current = null;
                stream.decoder.close();
                if (![...this.gifStreams.keys()].length) this.gifData.clear();
            }
        }
        const reverse = this.reverseStreams.get(key);
        if (reverse) {
            this.reverseStreams.delete(key);
            const stream = await reverse.catch(() => null);
            if (stream) {
                this.closeChunk(stream);
                const source = await this.sources.get(stream.url)?.catch(() => null);
                if (source) source.users -= 1;
                await this.releaseSource(stream.url);
            }
        }
        const entry = this.streams.get(key);
        if (!entry) return;
        this.streams.delete(key);
        const stream = await entry.catch(() => null);
        if (!stream) return;
        await this.reset(stream);
        const source = await this.sources.get(stream.url)?.catch(() => null);
        if (source) source.users -= 1;
        await this.releaseSource(stream.url);
    }

    /** Disposes a URL's demuxer when no stream uses it. */
    private async releaseSource(url: string): Promise<void> {
        const entry = this.sources.get(url);
        if (!entry) return;
        const source = await entry.catch(() => null);
        if (source && source.users > 0) return;
        if (this.sources.get(url) !== entry) return;
        this.sources.delete(url);
        source?.input.dispose();
    }

    /** A still image (decoded once; close it with closeImage after its last use). */
    image(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
        let entry = this.images.get(url);
        if (!entry) {
            entry = (async () => {
                try {
                    return await this.bitmap(await this.options.fetchBlob(url, signal));
                } catch {
                    return null;
                }
            })();
            this.images.set(url, entry);
        }
        return entry;
    }

    async closeImage(url: string): Promise<void> {
        const entry = this.images.get(url);
        if (!entry) return;
        this.images.delete(url);
        (await entry.catch(() => null))?.close();
    }

    /** A raster PNG (text, emoji, sticker) as a bitmap. */
    async raster(png: Uint8Array): Promise<ImageBitmap> {
        return this.bitmap(new Blob([new Uint8Array(png)], { type: "image/png" }));
    }

    /** Closes every stream, input, and image. Safe to call twice. */
    async dispose(): Promise<void> {
        this.disposed = true;
        for (const key of new Set([...this.streams.keys(), ...this.reverseStreams.keys(), ...this.gifStreams.keys()])) await this.closeStream(key);
        this.gifData.clear();
        for (const url of [...this.images.keys()]) await this.closeImage(url);
        for (const entry of this.sources.values()) (await entry.catch(() => null))?.input.dispose();
        this.sources.clear();
    }
}

/** The index of the time in `times` nearest to `t` (sorted times). */
function nearestIndex(times: readonly number[], t: number): number {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < t) lo = mid + 1;
        else hi = mid;
    }
    return lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t) ? lo - 1 : lo;
}
