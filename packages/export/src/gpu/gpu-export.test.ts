// exportTimelineGpu with fakes for mediabunny, the WebGL renderer, the encoder, and the runner: fallback rules,
// context loss, cancel while an await stalls, and resource lifetimes.
import { clip, input, scene } from "../compile/test-helpers";
import type { ExportRunner } from "../runner";
import { ExportError } from "../types";
import { exportTimelineGpu, type GpuExportOptions } from "./gpu-export";

interface FakeState {
    lostAt: number | null;
    frames: number;
    stallAdd: boolean;
    closedBitmaps: string[];
    disposedInputs: number;
    canceled: boolean;
    finalized: boolean;
}

function fakeMediabunny(state: FakeState) {
    class Sample {
        constructor(readonly timestamp: number) {}
        duration = 1 / 30;
        toVideoFrame() {
            return { displayWidth: 64, displayHeight: 36, format: "I420", close: () => undefined };
        }
        close() {}
    }
    const track = {
        getRotation: async () => 0,
        getColorSpace: async () => ({ matrix: "bt709" }),
        canDecode: async () => true,
        squarePixelWidth: 64, squarePixelHeight: 36, codedWidth: 64, codedHeight: 36,
        getFirstTimestamp: async () => 0,
    };
    class Input {
        constructor(readonly options: { source: { url: string } }) {}
        async getPrimaryVideoTrack() {
            return this.options.source.url.endsWith(".mp3") ? null : track;
        }
        async getPrimaryAudioTrack() {
            return {};
        }
        async computeDuration() {
            return 10;
        }
        dispose() {
            state.disposedInputs += 1;
        }
    }
    class VideoSampleSink {
        async *samples(start: number) {
            for (let k = Math.max(0, Math.floor(start * 30)); k < 300; k += 1) yield new Sample(k / 30);
        }
    }
    class EncodedPacketSink {
        async getPacket(t: number) {
            return t < 0 ? null : { timestamp: Math.floor(t * 30) / 30, duration: 1 / 30 };
        }
    }
    class BufferTarget {
        buffer: ArrayBuffer | null = null;
    }
    let target: BufferTarget | null = null;
    class Output {
        constructor(options: { target: BufferTarget }) {
            target = options.target;
        }
        addVideoTrack() {}
        async start() {}
        async finalize() {
            state.finalized = true;
            target!.buffer = new ArrayBuffer(8);
        }
        async cancel() {
            state.canceled = true;
        }
    }
    class CanvasSource {
        add() {
            state.frames += 1;
            return state.stallAdd && state.frames >= 2 ? new Promise<void>(() => undefined) : Promise.resolve();
        }
        close() {}
    }
    return {
        Input, VideoSampleSink, EncodedPacketSink, BufferTarget, Output, CanvasSource, ALL_FORMATS: [],
        Mp4OutputFormat: class {}, WebMOutputFormat: class {}, UrlSource: class {},
        getFirstEncodableVideoCodec: async () => "avc",
    };
}

function fakeRenderer(state: FakeState) {
    let presented = 0;
    const frame = (width = 64, height = 36) => ({ width, height });
    const renderer = {
        canvas: {},
        get isLost() {
            return state.lostAt !== null && presented >= state.lostAt;
        },
        fill: (w: number, h: number) => frame(w, h),
        upload: (_s: unknown, w: number, h: number) => frame(w, h),
        uploadPixels: (_d: unknown, w: number, h: number) => frame(w, h),
        resize: (_f: unknown, w: number, h: number) => frame(w, h),
        downscale: (_f: unknown, w: number, h: number) => frame(w, h),
        crop: (f: unknown) => f,
        nearest: (_f: unknown, w: number, h: number) => frame(w, h),
        rotate90: (f: unknown) => f,
        adjustLayer: (f: unknown) => f,
        look: (f: unknown) => f,
        lutMix: (f: unknown) => f,
        transition: (a: unknown) => a,
        composite: (base: unknown) => base,
        readPixels: () => new Uint8Array(0),
        present: () => {
            presented += 1;
        },
        releaseAll: () => undefined,
        dispose: vi.fn(),
    };
    return renderer;
}

function setup(patch: Partial<FakeState> = {}, options: Partial<GpuExportOptions> = {}) {
    const state: FakeState = { lostAt: null, frames: 0, stallAdd: false, closedBitmaps: [], disposedInputs: 0, canceled: false, finalized: false, ...patch };
    const mb = fakeMediabunny(state);
    const renderer = fakeRenderer(state);
    const gpu: GpuExportOptions = {
        loadMediabunny: async () => mb as never,
        createSource: (url) => ({ url }) as never,
        fetchBlob: async () => new Blob(),
        createRenderer: () => renderer as never,
        ...options,
    };
    const mux = vi.fn(async () => ({ kind: "bytes" as const, data: new Uint8Array([1]) }));
    const gif = vi.fn(async () => ({ kind: "bytes" as const, data: new Uint8Array([7]) }));
    const runner = { kind: "wasm", supportsGl: false, maxResolution: "1080p", probe: vi.fn(), chooseEncoder: vi.fn(), run: vi.fn(), mux, gif } as unknown as ExportRunner;
    return { state, gpu, runner, mux, gif, renderer };
}

const timeline = (patch: Record<string, unknown> = {}) => input({
    project: { aspectRatio: "16:9", musicUrl: "/m/music.mp3", musicVolume: 1 },
    scenes: [scene("a", 0, 1, { sourceVideoUrl: "/m/a.webm" })],
    ...patch,
});

describe("exportTimelineGpu", () => {
    beforeAll(() => {
        (globalThis as { VideoEncoder?: unknown }).VideoEncoder ??= class {};
        (globalThis as { createImageBitmap?: unknown }).createImageBitmap ??= async () => ({ width: 4, height: 4, close() {} });
    });

    it("renders every frame, finalizes, and muxes", async () => {
        const { gpu, runner, mux, state, renderer } = setup();
        const outcome = await exportTimelineGpu(timeline(), { resolution: "720p" }, { runner, gpu });
        expect(outcome.kind).toBe("done");
        expect(state.frames).toBe(30);
        expect(state.finalized).toBe(true);
        expect(mux).toHaveBeenCalledTimes(1);
        expect(renderer.dispose).toHaveBeenCalled();
    });

    it("falls back when a file the export needs cannot be opened (the audio would go missing)", async () => {
        const { gpu, runner, mux } = setup({}, { createSource: (url) => (url.endsWith(".mp3") ? Promise.reject(new Error("no ranged reads")) : ({ url }) as never) });
        const outcome = await exportTimelineGpu(timeline(), { resolution: "720p" }, { runner, gpu });
        expect(outcome).toEqual({ kind: "fallback", reason: expect.stringContaining("could not be read") });
        expect(mux).not.toHaveBeenCalled();
    });

    it("falls back instead of encoding black frames when the WebGL context is lost", async () => {
        const { gpu, runner, mux, state } = setup({ lostAt: 3 });
        const outcome = await exportTimelineGpu(timeline(), { resolution: "720p" }, { runner, gpu });
        expect(outcome).toEqual({ kind: "fallback", reason: expect.stringContaining("WebGL context") });
        expect(state.frames).toBeLessThanOrEqual(3);
        expect(mux).not.toHaveBeenCalled();
    });

    it("cancels promptly while the encoder holds the frame loop, and releases everything", async () => {
        const { gpu, runner, state, renderer } = setup({ stallAdd: true });
        const controller = new AbortController();
        const pending = exportTimelineGpu(timeline(), { resolution: "720p" }, { runner, gpu, signal: controller.signal });
        await vi.waitFor(() => expect(state.frames).toBe(2));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: "cancelled" });
        expect(state.canceled).toBe(true);
        expect(renderer.dispose).toHaveBeenCalled();
    });

    it("falls back when the mux fails in ffmpeg (a stream the WebCodecs encoder wrote that ffmpeg cannot copy)", async () => {
        const { gpu, runner, mux } = setup();
        mux.mockRejectedValueOnce(new ExportError("ffmpeg-failed", "mux failed"));
        const outcome = await exportTimelineGpu(timeline(), { resolution: "720p" }, { runner, gpu });
        expect(outcome.kind).toBe("fallback");
    });

    it("closes each text bitmap after its last frame, not at the end", async () => {
        const closed: number[] = [];
        let frame = 0;
        const { gpu, runner, state } = setup();
        const raster = { id: "text-t", png: new Uint8Array([1]), width: 20, height: 10, boxWidth: 16, boxHeight: 8, pad: 2, scale: 1 };
        (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ width: 20, height: 10, close: () => closed.push(state.frames) });
        void frame;
        const text = clip("t", { trackType: "text", trackIndex: 1, startTime: 0, endTime: 0.2, textContent: "Hi" });
        const outcome = await exportTimelineGpu(timeline({ clips: [text] }), { resolution: "720p" }, {
            runner, gpu, rasterizer: { rasterize: async () => raster },
        });
        expect(outcome.kind).toBe("done");
        expect(closed).toHaveLength(1);
        // Text ends at 0.2 s (frame 6); its bitmap is gone long before the last of the 30 frames.
        expect(closed[0]).toBeLessThan(10);
    });

    it("draws each graphics clip on its own canvas only when its picture changes, and frees it after its last frame", async () => {
        const { gpu, runner, state } = setup();
        const draws: Array<{ frame: number; at: number }> = [];
        const freed: number[] = [];
        let canvases = 0;
        const fakeCanvas = (w: number, h: number) => {
            canvases += 1;
            const ctx = new Proxy({}, { get: (_t, key) => (key === "measureText" ? () => ({ width: 10 }) : key === "fillRect" || key === "fill" ? () => draws.push({ frame: state.frames, at: 0 }) : () => undefined), set: () => true });
            const canvas = {
                _w: w, get width() { return this._w; }, set width(v: number) { this._w = v; if (v === 0) freed.push(state.frames); }, height: h, getContext: () => ctx,
            };
            return canvas as unknown as OffscreenCanvas;
        };
        const fonts = vi.fn(async () => undefined);
        const graphic = clip("g", { trackType: "remotion", trackIndex: 1, startTime: 0, endTime: 0.5, remotionTemplateId: "lower-third" });
        const outcome = await exportTimelineGpu(timeline({ clips: [graphic] }), { resolution: "720p" }, { runner, gpu: { ...gpu, createCanvas: fakeCanvas, loadFonts: fonts } });
        expect(outcome.kind).toBe("done");
        expect(fonts).toHaveBeenCalledTimes(1);
        expect(canvases).toBe(2);
        // The clip shows on frames 0..14; both canvases are freed right after frame 14, not at the end.
        expect(freed).toHaveLength(2);
        expect(Math.max(...freed)).toBeLessThan(20);
        expect(draws.length).toBeGreaterThan(0);
    });

    it("makes a GIF: frames at the GIF's size and 15 fps, a high-bitrate intermediate, the runner's GIF step, no audio mux (phase 10d)", async () => {
        const { gpu, runner, mux, gif, state } = setup();
        const codecs: Array<{ width: number; height: number; bitrate: number }> = [];
        const mb = await gpu.loadMediabunny();
        (mb as unknown as { getFirstEncodableVideoCodec: unknown }).getFirstEncodableVideoCodec = async (_c: unknown, o: { width: number; height: number; bitrate: number }) => {
            codecs.push(o);
            return "avc";
        };
        const outcome = await exportTimelineGpu(timeline(), { resolution: "1080p", format: "gif" }, { runner, gpu });
        expect(outcome.kind).toBe("done");
        if (outcome.kind !== "done") return;
        expect(outcome.result).toMatchObject({ container: "gif", mimeType: "image/gif", width: 640, height: 360, engine: "gpu", encoder: "gif (webcodecs-avc)" });
        expect(state.frames).toBe(15);
        expect(codecs[0]).toEqual({ width: 640, height: 360, bitrate: 12_000_000 });
        expect(mux).not.toHaveBeenCalled();
        expect(gif).toHaveBeenCalledWith({ format: expect.objectContaining({ width: 640, height: 360, fps: 15 }), durationSeconds: 1 }, expect.anything(), expect.objectContaining({ container: "mp4" }));
    });

    it("falls back for a GIF when the runner has no GIF step", async () => {
        const { gpu, runner } = setup();
        delete (runner as { gif?: unknown }).gif;
        const outcome = await exportTimelineGpu(timeline(), { resolution: "720p", format: "gif" }, { runner, gpu });
        expect(outcome).toEqual({ kind: "fallback", reason: expect.stringContaining("GIF") });
    });
});
