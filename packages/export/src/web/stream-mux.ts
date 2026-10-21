// Streaming mux for web GPU exports (phase 10d): the encoded video (a file on disk, e.g. in the origin private
// file system) and the export's audio track (rendered alone by ffmpeg.wasm with the export's own audio graph and
// encoder) are combined packet by packet by mediabunny into a stream target, so neither the video nor the result
// is ever held whole in memory. Packets are copied, never re-encoded; MP4 files get Fast Start by reserving the
// header space up front (the packet counts are known).
type Mediabunny = typeof import("mediabunny");
type EncodedPacket = import("mediabunny").EncodedPacket;

export interface StreamMuxOptions {
    mediabunny: Mediabunny;
    /** The encoded video (MP4 or WebM) as a Blob or File; read in ranges. */
    video: Blob;
    /** The audio-only file (M4A for MP4, WebM/Opus for WebM). */
    audio: Uint8Array;
    container: "mp4" | "webm";
    /** Where the result goes: chunks `{ type: "write", data, position }` (a FileSystemWritableFileStream fits as is). */
    writable: WritableStream<{ type: "write"; data: Uint8Array; position: number }>;
    signal?: AbortSignal;
    /** 0..1 */
    onProgress?(ratio: number): void;
}

/** Packets of two tracks merged in timestamp order (decode order within each track). */
async function* interleave(a: AsyncGenerator<EncodedPacket>, b: AsyncGenerator<EncodedPacket>): AsyncGenerator<{ track: 0 | 1; packet: EncodedPacket }> {
    let na = await a.next();
    let nb = await b.next();
    while (!na.done || !nb.done) {
        if (!na.done && (nb.done || na.value.timestamp <= nb.value.timestamp)) {
            yield { track: 0, packet: na.value };
            na = await a.next();
        } else if (!nb.done) {
            yield { track: 1, packet: nb.value };
            nb = await b.next();
        }
    }
}

export async function streamMux(options: StreamMuxOptions): Promise<void> {
    const mb = options.mediabunny;
    const videoInput = new mb.Input({ source: new mb.BlobSource(options.video), formats: mb.ALL_FORMATS });
    const audioInput = new mb.Input({ source: new mb.BufferSource(options.audio), formats: mb.ALL_FORMATS });
    let output: InstanceType<Mediabunny["Output"]> | null = null;
    try {
        const videoTrack = await videoInput.getPrimaryVideoTrack();
        const audioTrack = await audioInput.getPrimaryAudioTrack();
        if (!videoTrack) throw new Error("the encoded video has no video track"); // i18n-ignore
        const videoCodec = videoTrack.codec;
        if (!videoCodec) throw new Error("the encoded video's codec is unknown"); // i18n-ignore
        const videoConfig = await videoTrack.getDecoderConfig();
        const videoStats = await videoTrack.computePacketStats();
        const audioCodec = audioTrack?.codec ?? null;
        const audioConfig = audioTrack ? await audioTrack.getDecoderConfig() : null;
        const audioStats = audioTrack ? await audioTrack.computePacketStats() : null;
        const reserve = options.container === "mp4";
        output = new mb.Output({
            format: options.container === "mp4" ? new mb.Mp4OutputFormat({ fastStart: "reserve" }) : new mb.WebMOutputFormat(),
            target: new mb.StreamTarget(options.writable as never, { chunked: true }),
        });
        const videoSource = new mb.EncodedVideoPacketSource(videoCodec);
        output.addVideoTrack(videoSource, {
            rotation: videoTrack.rotation as 0 | 90 | 180 | 270,
            ...(reserve ? { maximumPacketCount: videoStats.packetCount + 1 } : {}),
        });
        const audioSource = audioTrack && audioCodec ? new mb.EncodedAudioPacketSource(audioCodec) : null;
        if (audioSource) output.addAudioTrack(audioSource, reserve && audioStats ? { maximumPacketCount: audioStats.packetCount + 1 } : {});
        await output.start();

        const total = videoStats.packetCount + (audioStats?.packetCount ?? 0);
        let done = 0;
        let firstVideo = true;
        let firstAudio = true;
        const videoPackets = new mb.EncodedPacketSink(videoTrack).packets();
        const audioPackets = audioTrack ? new mb.EncodedPacketSink(audioTrack).packets() : (async function* () {})();
        for await (const { track, packet } of interleave(videoPackets, audioPackets)) {
            if (options.signal?.aborted) throw new DOMException("The export was cancelled.", "AbortError"); // i18n-ignore
            if (track === 0) {
                await videoSource.add(packet, firstVideo && videoConfig ? { decoderConfig: videoConfig } : undefined);
                firstVideo = false;
            } else if (audioSource) {
                await audioSource.add(packet, firstAudio && audioConfig ? { decoderConfig: audioConfig } : undefined);
                firstAudio = false;
            }
            done += 1;
            if (done % 64 === 0) options.onProgress?.(Math.min(1, done / Math.max(1, total)));
        }
        await output.finalize();
        output = null;
        options.onProgress?.(1);
    } finally {
        if (output) await output.cancel().catch(() => undefined);
        videoInput.dispose?.();
        audioInput.dispose?.();
    }
}
