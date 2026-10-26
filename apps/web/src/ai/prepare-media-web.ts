// The web app's MediaPreparer (phase 11): the file an AI tool uploads, made in the page from the project's media.
// - audio tools: the used range as mono WAV at the asked rate (AAC in MP4 when WAV would pass the destination's cap
//   and it takes audio/mp4), re-encoded so the file's length is exactly the range Studio priced;
// - video tools: the used range re-encoded (never packet-copied: a copy starts at the previous key frame and would
//   send, and bill, more than the range) as H.264 MP4, or VP9 WebM where H.264 cannot be encoded;
// - images: the file as is when the destination takes its type, else a PNG;
// - the timeline: its audible sources (the export's audio model) mixed with an OfflineAudioContext, mono.
// Media is read through the media environment (auth headers only for its own origin, as the export reads it).
import type { MediaPrepareInput, MediaPreparePurpose, MediaPreparer, PreparedMedia } from "@opennan/provider-sdk";
import type { AudioSource } from "@opennan/export";

type Mediabunny = typeof import("mediabunny");

export interface WebMediaEnvironment {
    resolveMediaUrl(url: string): string;
    getAuthHeaders?(): Promise<Record<string, string>> | Record<string, string>;
    origin?: string;
}

export interface WebPreparerOptions {
    media: WebMediaEnvironment;
    loadMediabunny?(): Promise<Mediabunny>;
    /** The timeline's audible sources and length (the export's audio model), for timeline inputs. */
    timelineSources?(snapshot: unknown): { durationSeconds: number; sources: AudioSource[] };
    fetch?: typeof globalThis.fetch;
}

export class MediaPrepareError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MediaPrepareError";
    }
}

/** The range to send: the reference's, inside the file, cut to the destination's length cap. */
export function rangeToSend(duration: number, start: number | undefined, end: number | undefined, maxSeconds: number | undefined): { start: number; end: number } {
    const from = Math.max(0, Math.min(start ?? 0, duration));
    let to = Math.min(end ?? duration, duration);
    if (maxSeconds !== undefined && to - from > maxSeconds) to = from + maxSeconds;
    if (!(to > from)) throw new MediaPrepareError("The clip's range is empty.");
    return { start: from, end: to };
}

/** Respect the preferred format and size cap; use accepted WAV when this browser cannot encode AAC. */
export function audioContainer(purpose: MediaPreparePurpose, seconds: number, sampleRate: number, aacAvailable = true): "wav" | "mp4" {
    const wavBytes = 44 + Math.ceil(seconds * sampleRate) * 2;
    const takesMp4 = purpose.contentTypes.includes("audio/mp4");
    const takesWav = purpose.contentTypes.includes("audio/wav");
    if (!aacAvailable) {
        if (!takesWav) throw new MediaPrepareError("This browser cannot encode AAC audio. Use the desktop app.");
        checkSize(wavBytes, purpose);
        return "wav";
    }
    if (!takesWav) return "mp4";
    if (takesMp4 && (purpose.contentTypes[0] === "audio/mp4" || wavBytes > purpose.maxBytes)) return "mp4";
    return "wav";
}

function checkSize(size: number, purpose: MediaPreparePurpose): void {
    if (size > purpose.maxBytes) {
        throw new MediaPrepareError(`The prepared file is ${(size / 1048576).toFixed(1)} MB, more than the ${Math.floor(purpose.maxBytes / 1048576)} MB this tool takes. Use a shorter range.`);
    }
}

function baseName(url: string): string {
    const tail = url.split(/[?#]/)[0]!.split("/").pop() ?? "media";
    return tail.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "media";
}

export function createWebMediaPreparer(options: WebPreparerOptions): MediaPreparer {
    const load = options.loadMediabunny ?? (() => import("mediabunny"));
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

    async function requestInit(url: string): Promise<RequestInit> {
        const home = options.media.origin ?? (typeof location !== "undefined" ? location.origin : undefined);
        let own = false;
        try {
            own = Boolean(home) && new URL(url, home).origin === home;
        } catch {
            own = false;
        }
        const headers = own && options.media.getAuthHeaders ? await options.media.getAuthHeaders() : undefined;
        return { credentials: own ? "same-origin" : "omit", ...(headers ? { headers } : {}) };
    }

    async function convert(input: MediaPrepareInput & { kind: "media" }, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedMedia> {
        const mb = await load();
        const url = options.media.resolveMediaUrl(input.source.mediaUrl);
        const source = new mb.Input({ source: new mb.UrlSource(url, { requestInit: await requestInit(url) }), formats: mb.ALL_FORMATS });
        try {
            const duration = await source.computeDuration();
            const range = rangeToSend(duration, input.source.startSeconds, input.source.endSeconds, purpose.maxSeconds);
            const seconds = range.end - range.start;
            const target = new mb.BufferTarget();
            let format: InstanceType<Mediabunny["OutputFormat"]>;
            let contentType: string;
            let extension: string;
            const conversionOptions: Record<string, unknown> = { trim: range, copy: false, showWarnings: false };
            let size: { width: number; height: number } | null = null;
            if (purpose.output === "audio") {
                const rate = purpose.sampleRate ?? 44_100;
                let container = audioContainer(purpose, seconds, rate);
                if (container === "mp4" && !(await mb.canEncodeAudio("aac", { numberOfChannels: 1, sampleRate: rate, bitrate: 128_000 }))) {
                    container = audioContainer(purpose, seconds, rate, false);
                }
                if (!(await source.getPrimaryAudioTrack())) throw new MediaPrepareError("This clip has no audio.");
                format = container === "wav" ? new mb.WavOutputFormat() : new mb.Mp4OutputFormat();
                contentType = container === "wav" ? "audio/wav" : "audio/mp4";
                extension = container === "wav" ? "wav" : "m4a";
                conversionOptions.video = { discard: true };
                conversionOptions.audio = container === "wav"
                    ? { numberOfChannels: 1, sampleRate: rate, codec: "pcm-s16", forceTranscode: true }
                    : { numberOfChannels: 1, sampleRate: rate, codec: "aac", bitrate: 128_000, forceTranscode: true };
            } else {
                const track = await source.getPrimaryVideoTrack();
                if (!track) throw new MediaPrepareError("This clip has no video.");
                // Never resized: the result's size is the source's, which a stacked result (an upscale) needs.
                size = { width: track.displayWidth, height: track.displayHeight };
                const mp4 = purpose.contentTypes.includes("video/mp4") && (await mb.canEncodeVideo("avc"));
                if (!mp4 && !purpose.contentTypes.includes("video/webm")) throw new MediaPrepareError("This browser cannot encode a video this tool takes.");
                format = mp4 ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat();
                contentType = mp4 ? "video/mp4" : "video/webm";
                extension = mp4 ? "mp4" : "webm";
                conversionOptions.video = { codec: mp4 ? "avc" : "vp9", bitrate: mb.QUALITY_HIGH, forceTranscode: true };
                conversionOptions.audio = purpose.keepAudio ? { codec: mp4 ? "aac" : "opus", forceTranscode: true } : { discard: true };
            }
            const output = new mb.Output({ format, target });
            const conversion = await mb.Conversion.init({ input: source, output, ...conversionOptions } as Parameters<Mediabunny["Conversion"]["init"]>[0]);
            if (!conversion.isValid) throw new MediaPrepareError("This browser cannot read this clip's media to prepare it.");
            const stop = () => void conversion.cancel();
            signal.addEventListener("abort", stop, { once: true });
            try {
                await conversion.execute();
            } finally {
                signal.removeEventListener("abort", stop);
            }
            if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
            const buffer = target.buffer;
            if (!buffer) throw new MediaPrepareError("The prepared file is empty.");
            checkSize(buffer.byteLength, purpose);
            // The prepared file's own length: what the server will measure (the provider re-checks its price on it).
            const check = new mb.Input({ source: new mb.BufferSource(buffer), formats: mb.ALL_FORMATS });
            const measured = await check.computeDuration().catch(() => seconds);
            return {
                data: new Blob([buffer], { type: contentType }), contentType, filename: `${baseName(input.source.mediaUrl)}.${extension}`,
                sizeBytes: buffer.byteLength, durationSeconds: Math.max(measured, seconds), ...(size ? size : {}),
            };
        } finally {
            source.dispose?.();
        }
    }

    async function image(input: MediaPrepareInput & { kind: "media" }, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedMedia> {
        const url = options.media.resolveMediaUrl(input.source.mediaUrl);
        const response = await doFetch(url, { ...(await requestInit(url)), signal });
        if (!response.ok) throw new MediaPrepareError(`The image could not be read (${response.status}).`);
        let blob = await response.blob();
        let type = blob.type.split(";")[0]!.trim().toLowerCase();
        if (!purpose.contentTypes.includes(type)) {
            const bitmap = await createImageBitmap(blob);
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
            bitmap.close();
            blob = await canvas.convertToBlob({ type: "image/png" });
            type = "image/png";
        }
        checkSize(blob.size, purpose);
        return { data: blob, contentType: type, filename: `${baseName(input.source.mediaUrl)}.${type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1]}`, sizeBytes: blob.size };
    }

    async function timeline(snapshot: unknown, purpose: MediaPreparePurpose, signal: AbortSignal): Promise<PreparedMedia> {
        if (!options.timelineSources) throw new MediaPrepareError("This app cannot mix the timeline's audio.");
        const { durationSeconds, sources } = options.timelineSources(snapshot);
        const seconds = purpose.maxSeconds !== undefined ? Math.min(durationSeconds, purpose.maxSeconds) : durationSeconds;
        const rate = purpose.sampleRate ?? 16_000;
        const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * rate)), rate);
        const decoded = new Map<string, AudioBuffer | null>();
        let audible = 0;
        for (const source of sources) {
            if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
            if (source.start >= seconds) continue;
            let buffer = decoded.get(source.url);
            if (buffer === undefined) {
                try {
                    const url = options.media.resolveMediaUrl(source.url);
                    const response = await doFetch(url, { ...(await requestInit(url)), signal });
                    buffer = response.ok ? await context.decodeAudioData(await response.arrayBuffer()) : null;
                } catch {
                    buffer = null;
                }
                decoded.set(source.url, buffer);
            }
            if (!buffer) continue;
            const node = context.createBufferSource();
            node.buffer = buffer;
            // Speed curves are approximated by their mean rate (enough for words; the export mixes them exactly).
            const segments = source.stretch?.segments ?? [];
            const first = segments[0];
            const last = segments[segments.length - 1];
            const media = first && last ? Math.max(0.01, last.sourceEnd - first.sourceStart) : source.duration;
            const offset = source.sourceOffset + (first ? first.sourceStart : 0);
            node.playbackRate.value = source.duration > 0 ? Math.max(0.1, Math.min(16, media / source.duration)) : 1;
            const gain = context.createGain();
            gain.gain.value = source.volume * source.trackVolume;
            for (const [from, to] of source.muted) {
                gain.gain.setValueAtTime(0, Math.max(0, from));
                gain.gain.setValueAtTime(source.volume * source.trackVolume, Math.max(0, to));
            }
            node.connect(gain).connect(context.destination);
            node.start(source.start, offset, media);
            audible += 1;
        }
        if (audible === 0) throw new MediaPrepareError("The timeline has no audio to transcribe.");
        const rendered = await context.startRendering();
        const wav = encodeWav(rendered.getChannelData(0), rate);
        checkSize(wav.byteLength, purpose);
        return { data: new Blob([wav], { type: "audio/wav" }), contentType: "audio/wav", filename: "timeline.wav", sizeBytes: wav.byteLength, durationSeconds: seconds };
    }

    return async (input, purpose, signal) => {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        if (input.kind === "timeline") return timeline(input.snapshot, purpose, signal);
        if (purpose.output === "image") return image(input, purpose, signal);
        return convert(input, purpose, signal);
    };
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
}
