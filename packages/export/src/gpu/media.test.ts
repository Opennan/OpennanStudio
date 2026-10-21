import { unspecifiedColorSpace } from "./media";

describe("unspecifiedColorSpace", () => {
    it("reads a YUV stream without a matrix as BT.601 (ffmpeg's default), keeping its range", () => {
        expect(unspecifiedColorSpace({ fullRange: false })).toEqual({ matrix: "smpte170m", primaries: "bt709", transfer: "bt709", fullRange: false });
        expect(unspecifiedColorSpace({})).toMatchObject({ matrix: "smpte170m", fullRange: false });
        expect(unspecifiedColorSpace({ fullRange: true })).toMatchObject({ fullRange: true });
    });

    it("leaves streams that name their matrix alone", () => {
        expect(unspecifiedColorSpace({ matrix: "bt709", fullRange: false })).toBeNull();
        expect(unspecifiedColorSpace({ matrix: "rgb" })).toBeNull();
    });
});

// ── reverse reads (phase 10d) ────────────────────────────

import { GpuMedia } from "./media";
import type { VideoRead } from "./plan";

/** A fake mediabunny with one 25 fps track (key frame every 12 frames) that counts decoded samples still open. */
function reverseFixture(colorSpace: Record<string, unknown> = { matrix: "bt709" }, trackColorSpace: Record<string, unknown> = { matrix: "bt709" }, frames = 100) {
    const state = { live: 0, peak: 0, decodes: [] as Array<[number, number]>, decoded: 0 };
    const copies: Array<{ init: Record<string, unknown> | undefined }> = [];
    const fps = 25;
    const times = Array.from({ length: frames }, (_, k) => k / fps);
    /** A native frame stand-in: decoded frames are coded with padding rows below the visible 64×36 picture. */
    class FakeFrame {
        closed = false;
        format = "I420";
        visibleRect = { x: 0, y: 0, width: 64, height: 36 };
        displayWidth = 64;
        displayHeight = 36;
        duration = 40_000;
        colorSpace = { toJSON: () => colorSpace };
        constructor(readonly timestamp: number, readonly init?: Record<string, unknown>) {
            state.live += 1;
            state.peak = Math.max(state.peak, state.live);
            if (init) copies.push({ init });
        }
        allocationSize() {
            return 8;
        }
        async copyTo(dest: Uint8Array) {
            dest.fill(1);
            return [{ offset: 0, stride: 64 }];
        }
        close() {
            if (this.closed) return;
            this.closed = true;
            state.live -= 1;
        }
    }
    vi.stubGlobal("VideoFrame", class extends FakeFrame {
        constructor(_data: Uint8Array, init: Record<string, unknown>) {
            super(init.timestamp as number, init);
        }
    });
    class VideoSample {
        format = "I420";
        constructor(readonly frame: FakeFrame) {}
        get timestamp() {
            return this.frame.timestamp / 1e6;
        }
        toVideoFrame() {
            // A second handle on the same picture (closing it does not close the sample).
            return { ...this.frame, timestamp: this.frame.timestamp, allocationSize: () => 8, copyTo: this.frame.copyTo, close: () => undefined };
        }
        close() {
            this.frame.close();
        }
    }
    const packet = (k: number) => (k >= 0 && k < frames ? { timestamp: times[k], duration: 1 / fps, type: k % 12 === 0 ? "key" : "delta", k } : null);
    const track = {
        getRotation: async () => 0, getColorSpace: async () => trackColorSpace, canDecode: async () => true,
        codedWidth: 64, codedHeight: 36, getFirstTimestamp: async () => 0,
    };
    const mediabunny = {
        ALL_FORMATS: [],
        VideoSample,
        Input: class {
            async getPrimaryVideoTrack() { return track; }
            dispose() {}
        },
        EncodedPacketSink: class {
            async getPacket(t: number) { return t < 0 ? null : packet(Math.min(frames - 1, Math.floor(t * fps + 1e-9))); }
            async getFirstPacket() { return packet(0); }
            async getKeyPacket(t: number) { return t < 0 ? null : packet(Math.floor(Math.min(frames - 1, Math.floor(t * fps + 1e-9)) / 12) * 12); }
            async getNextPacket(p: { k: number }) { return packet(p.k + 1); }
        },
        VideoSampleSink: class {
            async *samples(start = 0, end = Infinity) {
                state.decodes.push([start, end]);
                // Decoding starts at the key frame before `start`; frames before it are decoded and dropped.
                const first = Math.floor(Math.max(0, Math.floor(start * fps + 1e-9)) / 12) * 12;
                for (let k = first; k < frames && times[k] < end; k += 1) {
                    state.decoded += 1;
                    const sample = new VideoSample(new FakeFrame(times[k] * 1e6));
                    if (times[k] < start - 1e-9) {
                        sample.close();
                        continue;
                    }
                    yield sample;
                }
            }
        },
    };
    const media = new GpuMedia({ mediabunny: mediabunny as never, createSource: () => ({}) as never, fetchBlob: async () => new Blob(), reverseChunkFrames: 8 });
    return { media, state, times, copies };
}

const reverseRead = (span: number, frames: number): VideoRead => ({
    key: "r0", stream: "clip:o", url: "/m/a.mp4", seek: 0, anchor: "first", frames, offsetAt: (i) => (i + 0.5) / 30 - 1e-6, reverse: { span },
});

describe("GpuMedia reverse reads", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("shows the read's frames backwards on the forward timing (ffmpeg's reverse)", async () => {
        const { media, times } = reverseFixture();
        const read = reverseRead(2, 60);
        // 50 frames in [0, 2): the forward pick j shows frame 49 − j.
        for (let i = 0; i < 60; i += 1) {
            const t = (i + 0.5) / 30 - 1e-6;
            const j = Math.min(49, Math.floor(t * 25 + 1e-9));
            const shown = await media.frame(read, i);
            expect([i, shown?.sample.timestamp]).toEqual([i, times[49 - j]]);
        }
        await media.dispose();
    });

    it("holds at most one chunk of frames and closes them as they leave", async () => {
        const { media, state } = reverseFixture();
        const read = reverseRead(3.2, 96);
        for (let i = 0; i < 96; i += 1) await media.frame(read, i);
        // Chunks of 8 (the option) plus the sample being decoded.
        expect(state.peak).toBeLessThanOrEqual(9);
        // 80 frames in 10 chunks, each decoded from its key frame: never the whole clip per frame.
        expect(state.decodes.length).toBe(10);
        expect(state.decoded).toBeLessThan(80 * 3);
        await media.closeStream("clip:o");
        expect(state.live).toBe(0);
    });

    it("copies the decoded frame's visible rectangle with the layout copyTo reports", async () => {
        const { media, copies } = reverseFixture();
        await media.frame(reverseRead(2, 60), 0);
        const copy = copies.find((c) => c.init)!;
        // The track names its matrix: the browser converts to RGBA with the frame's own colour space.
        expect(copy.init).toMatchObject({ format: "RGBA", codedWidth: 64, codedHeight: 36, layout: [{ offset: 0, stride: 64 }], displayWidth: 64, displayHeight: 36, colorSpace: { matrix: "rgb" } });
        await media.dispose();
    });

    it("keeps the planes of a file without a colour matrix (the export applies the track's reading)", async () => {
        const { media, copies } = reverseFixture({}, { matrix: undefined });
        await media.frame(reverseRead(2, 60), 0);
        expect(copies[0].init).toMatchObject({ format: "I420", codedWidth: 64, codedHeight: 36 });
        expect(copies[0].init).not.toHaveProperty("colorSpace");
        await media.dispose();
    });

    it("re-decodes a chunk when a request jumps forward again", async () => {
        const { media, state, times } = reverseFixture();
        const read = reverseRead(2, 60);
        await media.frame(read, 59);
        const again = await media.frame(read, 0);
        expect(again?.sample.timestamp).toBe(times[49]);
        expect(state.decodes.length).toBe(2);
        await media.dispose();
        expect(state.live).toBe(0);
    });
});

// ── animated GIFs (phase 10d) ────────────────────────────

function gifFixture() {
    // Two frames, 10 and 20 cs, looping forever (gif.test.ts gifBytes layout).
    const bytes: number[] = [...new TextEncoder().encode("GIF89a"), 4, 0, 3, 0, 0, 0, 0];
    bytes.push(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
    for (const delay of [10, 20]) bytes.push(0x21, 0xf9, 4, 0, delay, 0, 0, 0, 0x2c, 0, 0, 0, 0, 4, 0, 3, 0, 0, 2, 2, 0x4c, 0x01, 0);
    bytes.push(0x3b);
    const state = { open: 0, decodes: [] as number[], decoders: 0, closedDecoders: 0 };
    class VideoSample {
        constructor(readonly frame: { index: number; close(): void }) {}
        get timestamp() { return this.frame.index; }
        close() { this.frame.close(); }
    }
    const createImageDecoder = (init: { type: string }) => {
        expect(init.type).toBe("image/gif");
        state.decoders += 1;
        return {
            tracks: { ready: Promise.resolve() },
            async decode({ frameIndex }: { frameIndex: number }) {
                state.decodes.push(frameIndex);
                state.open += 1;
                let closed = false;
                return { image: { index: frameIndex, displayWidth: 4, displayHeight: 3, close: () => { if (!closed) { closed = true; state.open -= 1; } } } };
            },
            close() { state.closedDecoders += 1; },
        };
    };
    const media = new GpuMedia({
        mediabunny: { VideoSample } as never, createSource: () => ({}) as never,
        fetchBlob: async () => new Blob([new Uint8Array(bytes)]), createImageDecoder: createImageDecoder as never,
    });
    return { media, state };
}

const gifRead = (patch: Partial<VideoRead> = {}): VideoRead => ({
    key: "g", stream: "clip:g", url: "/m/party.gif?v=2", seek: 0, anchor: "first", frames: 30, offsetAt: (i) => (i + 0.5) / 30 - 1e-6, ...patch,
});

describe("GpuMedia animated GIFs", () => {
    it("probes a GIF from its own blocks", async () => {
        const { media } = gifFixture();
        const probed = await media.probe(["/m/party.gif?v=2"]);
        expect(probed.get("/m/party.gif?v=2")).toMatchObject({ width: 4, height: 3, hasVideo: true, hasAudio: false, decodable: true, still: false });
    });

    it("decodes each shown GIF frame once with ffmpeg's timing and closes it when the next one shows", async () => {
        const { media, state } = gifFixture();
        const shown: number[] = [];
        for (let i = 0; i < 12; i += 1) shown.push((await media.frame(gifRead(), i))!.sample.timestamp);
        // 30 fps over 0.1 s + 0.2 s frames: three output frames of 0, six of 1, then 0 again.
        expect(shown).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
        expect(state.decodes).toEqual([0, 1, 0]);
        expect(state.open).toBe(1);
        await media.closeStream("clip:g");
        expect(state.open).toBe(0);
        expect(state.closedDecoders).toBe(1);
    });

    it("plays a reversed GIF read backwards", async () => {
        const { media } = gifFixture();
        // 0.65 s read: frames 0 (0), 1 (0.1), 0 (0.3), 1 (0.4), 0 (0.6) backwards.
        const read = gifRead({ reverse: { span: 0.65 } });
        expect((await media.frame(read, 0))!.sample.timestamp).toBe(0);
        expect((await media.frame(read, 4))!.sample.timestamp).toBe(1);
        await media.dispose();
    });
});
