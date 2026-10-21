import type { ExportSessionState } from "@opennan/export";
import { EXPORT_WORKER_STORAGE_KEY, UPLOAD_SLICE_BYTES, exportWorkerEnabled, createDesktopExportPlatform } from "./export-platform";
import { copyingPort, serveExportBridgePorts } from "./export-bridge-ports";
import { createTestBridge } from "./test-bridge";

describe("desktop export platform", () => {
    it("describes native export", () => {
        const platform = createDesktopExportPlatform(createTestBridge().bridge);
        expect(platform.resolutions).toEqual(["720p", "1080p", "4k"]);
        expect(platform.gl).toBe(true);
        expect(platform.resolutionNote).toBeNull();
    });

    it("mirrors main's session state and forwards cancel and reset", async () => {
        let push: (state: ExportSessionState) => void = () => undefined;
        const { bridge } = createTestBridge();
        bridge.exports.onState = vi.fn((listener) => {
            push = listener;
            return () => undefined;
        });
        const exporter = createDesktopExportPlatform(bridge).createExporter({ resolveMediaUrl: (u) => u });
        const seen = vi.fn();
        exporter.session.subscribe(seen);
        push({ status: "running", progress: { phase: "encode", ratio: 0.5 } });
        expect(exporter.session.getState()).toEqual({ status: "running", progress: { phase: "encode", ratio: 0.5 } });
        expect(seen).toHaveBeenCalled();
        exporter.session.cancel();
        exporter.session.reset();
        expect(bridge.exports.cancel).toHaveBeenCalled();
        expect(bridge.exports.reset).toHaveBeenCalled();
    });

    it("starts through export.start and reports failures", async () => {
        const exporter = createDesktopExportPlatform(createTestBridge().bridge).createExporter({ resolveMediaUrl: (u) => u });
        const execute = vi.fn(async () => ({ ok: true, changed: {} }));
        await exporter.start({ controller: { execute } as never, backend: {} as never, resolution: "4k" });
        expect(execute).toHaveBeenCalledWith({ type: "export.start", options: { resolution: "4k" } });
        const failing = vi.fn(async () => ({ ok: false, changed: {}, error: "An export is already running." }));
        await expect(exporter.start({ controller: { execute: failing } as never, backend: {} as never, resolution: "720p" })).rejects.toThrow("already running");
    });

    it("the command handler opens the dialog and asks main; delivery reads the file size", async () => {
        const { bridge } = createTestBridge();
        const exporter = createDesktopExportPlatform(bridge).createExporter({ resolveMediaUrl: (u) => u });
        const show = vi.fn();
        await expect(exporter.commandHandler({} as never, show)({ resolution: "1080p" }, { tracks: [] } as never)).resolves.toEqual({ jobId: "export-1" });
        expect(show).toHaveBeenCalled();
        expect(bridge.exports.start).toHaveBeenCalledWith({ resolution: "1080p" }, { tracks: [] });
        const delivery = await exporter.deliver({ output: { kind: "file", path: "/v/OpenNan Studio/trip.mp4" } } as never, "Trip");
        expect(delivery).toEqual({ fileName: "trip.mp4", path: "/v/OpenNan Studio/trip.mp4", size: 2048 });
        exporter.reveal?.(delivery);
        expect(bridge.exports.reveal).toHaveBeenCalledWith("/v/OpenNan Studio/trip.mp4");
    });
});

describe("desktop GPU export (phase 10c)", () => {
    const readyGpu = () => ({
        loadMediabunny: async () => ({ getFirstEncodableVideoCodec: async () => "avc" }) as never,
        createSource: () => { throw new Error("unused"); },
        fetchBlob: async () => new Blob(),
        // No WebGL2 renderer in jsdom: the run falls back to main after the job was opened.
        createRenderer: () => null,
        isAvailable: () => true,
    });
    beforeAll(() => {
        (globalThis as { VideoEncoder?: unknown }).VideoEncoder ??= class {};
    });

    it("offers GIF and passes the format to the GPU job and to main's fallback (phase 10d)", async () => {
        const { bridge } = createTestBridge();
        const platform = createDesktopExportPlatform(bridge, { gpu: () => readyGpu() });
        expect(platform.formats).toEqual(["video", "gif"]);
        const exporter = platform.createExporter({ resolveMediaUrl: (u) => u });
        const snapshot = { project: { name: "Trip", aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] } as never;
        await expect(exporter.engine!({ project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 }, tracks: [], clips: [], scenes: [] }, "1080p", "gif"))
            .resolves.toMatchObject({ engine: "gpu", formatLabel: "GIF (no audio, loops)" });
        expect(await exporter.commandHandler({} as never, vi.fn())({ format: "mov" }, snapshot)).toEqual({ error: "format must be video or gif." });
        await exporter.commandHandler({} as never, vi.fn())({ resolution: "720p", format: "gif" }, snapshot);
        expect(bridge.exports.gpuBegin).toHaveBeenCalledWith({ resolution: "720p", format: "gif" }, snapshot, "mp4", "avc");
        // Main reruns the job from the request it stored at gpuBegin (format included), under the same gpu- id.
        await vi.waitFor(() => expect(bridge.exports.gpuFallback).toHaveBeenCalledWith("3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"));
        exporter.dispose();
    });

    it("previews the GPU engine and opens a GPU job; a run that cannot render falls back to main's export", async () => {
        const { bridge } = createTestBridge();
        const exporter = createDesktopExportPlatform(bridge, { gpu: () => readyGpu() }).createExporter({ resolveMediaUrl: (u) => u });
        const snapshot = { project: { name: "Trip", aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] } as never;
        await expect(exporter.engine!({ project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 }, tracks: [], clips: [], scenes: [] }, "1080p"))
            .resolves.toEqual({ engine: "gpu", formatLabel: "MP4 (H.264, AAC)", nativeSpeed: true, gl: false });
        const outcome = await exporter.commandHandler({} as never, vi.fn())({ resolution: "1080p" }, snapshot);
        expect(outcome).toEqual({ jobId: "gpu-3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f" });
        expect(bridge.exports.gpuBegin).toHaveBeenCalledWith({ resolution: "1080p" }, snapshot, "mp4", "avc");
        // Main runs its native export from the job's own snapshot, under the same gpu- id for agents.
        await vi.waitFor(() => expect(bridge.exports.gpuFallback).toHaveBeenCalledWith("3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"));
        expect(bridge.exports.start).not.toHaveBeenCalled();
        expect(bridge.exports.gpuAbort).not.toHaveBeenCalled();
        expect(exporter.session.getState()).toEqual({ status: "idle" });
    });

    it("export.cancel stops main's running export, and says when nothing runs (phase 10d)", async () => {
        const { bridge } = createTestBridge();
        let push: (state: unknown) => void = () => undefined;
        (bridge.exports.onState as unknown as { mockImplementation(f: (l: (s: unknown) => void) => () => void): void }).mockImplementation((listener) => {
            push = listener;
            return () => undefined;
        });
        const exporter = createDesktopExportPlatform(bridge, { gpu: null }).createExporter({ resolveMediaUrl: (u) => u });
        const handler = exporter.commandHandler({} as never, vi.fn()) as unknown as { cancel(jobId?: string): Promise<unknown> };
        await expect(handler.cancel()).resolves.toEqual({ error: "No export is running." });
        // An agent's export.start here: main's native export, job export-1.
        await exporter.commandHandler({} as never, vi.fn())({ resolution: "720p" }, { project: { name: "Trip" }, tracks: [], clips: [], scenes: [] } as never);
        push({ status: "running", progress: { phase: "encode", ratio: 0.3, engine: "ffmpeg" } });
        // A stale or foreign id does not stop the running export.
        await expect(handler.cancel("export-stale")).resolves.toMatchObject({ error: expect.stringContaining("is not the running export") });
        expect(bridge.exports.cancel).not.toHaveBeenCalled();
        await expect(handler.cancel("export-1")).resolves.toEqual({ jobId: "export-1" });
        expect(bridge.exports.cancel).toHaveBeenCalledTimes(1);
        exporter.dispose();
    });

    it("starts one export when the command arrives twice at once", async () => {
        const { bridge } = createTestBridge();
        const exporter = createDesktopExportPlatform(bridge, { gpu: () => readyGpu() }).createExporter({ resolveMediaUrl: (u) => u });
        const handler = exporter.commandHandler({} as never, vi.fn());
        const snapshot = { project: { name: "Trip" }, tracks: [], clips: [], scenes: [] } as never;
        const [a, b] = await Promise.all([handler({ resolution: "720p" }, snapshot), handler({ resolution: "720p" }, snapshot)]);
        expect([a, b].filter((r) => "jobId" in r)).toHaveLength(1);
        expect([a, b].filter((r) => "error" in r)).toEqual([{ error: "An export is already running." }]);
        expect(bridge.exports.gpuBegin).toHaveBeenCalledTimes(1);
    });

    it("reports a refused GPU job and uses main's export when the GPU path is off", async () => {
        const { bridge } = createTestBridge();
        bridge.exports.gpuBegin = vi.fn(async () => ({ error: "An export is already running." }));
        const exporter = createDesktopExportPlatform(bridge, { gpu: () => readyGpu() }).createExporter({ resolveMediaUrl: (u) => u });
        await expect(exporter.commandHandler({} as never, vi.fn())({}, { tracks: [], clips: [], scenes: [] } as never)).resolves.toEqual({ error: "An export is already running." });
        const off = createDesktopExportPlatform(bridge, { gpu: null }).createExporter({ resolveMediaUrl: (u) => u });
        await expect(off.engine!({ project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 }, tracks: [], clips: [], scenes: [] }, "4k")).resolves.toMatchObject({ engine: "ffmpeg" });
        await off.commandHandler({} as never, vi.fn())({ resolution: "4k" }, { tracks: [] } as never);
        expect(bridge.exports.start).toHaveBeenCalledWith({ resolution: "4k" }, { tracks: [] });
    });
});

describe("desktop GPU export jobs for main and agents (phase 10d)", () => {
    const JOB = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    const readyGpu = () => ({
        loadMediabunny: async () => ({ getFirstEncodableVideoCodec: async () => "avc" }) as never,
        createSource: () => { throw new Error("unused"); },
        fetchBlob: async () => new Blob(),
        createRenderer: () => null,
        isAvailable: () => true,
    });
    const snapshot = { project: { name: "Trip", aspectRatio: "16:9" }, tracks: [], clips: [], scenes: [] } as never;
    type Run = (input: unknown, settings: unknown, options: {
        signal: AbortSignal; onProgress(progress: { phase: string; ratio: number; etaSeconds?: number }): void;
        runner: { mux(plan: unknown, video: unknown, options: { container: string; signal?: AbortSignal }): Promise<unknown> };
        gpu: { createVideoSink(): { writable: WritableStream } };
    }) => Promise<unknown>;
    beforeAll(() => {
        (globalThis as { VideoEncoder?: unknown }).VideoEncoder ??= class {};
    });
    const platform = (run: Run, extra: Record<string, unknown> = {}) => {
        const { bridge } = createTestBridge();
        let cancel: (jobId: string) => void = () => undefined;
        bridge.exports.onGpuCancel = vi.fn((listener) => {
            cancel = listener;
            return () => undefined;
        });
        const exporter = createDesktopExportPlatform(bridge, { gpu: () => readyGpu(), exportGpu: run as never, ...extra }).createExporter({ resolveMediaUrl: (u) => u });
        return { bridge, exporter, cancel: (jobId: string) => cancel(jobId) };
    };

    it("reports progress to main: every phase change, at most one report per interval, numbers cleaned", async () => {
        let finish: () => void = () => undefined;
        const { bridge, exporter } = platform(async (_input, _settings, { onProgress }) => {
            onProgress({ phase: "probe", ratio: 0 });
            for (let i = 0; i < 5; i += 1) onProgress({ phase: "raster", ratio: i / 5 });
            onProgress({ phase: "render", ratio: 0.1, etaSeconds: Number.NaN });
            onProgress({ phase: "render", ratio: 0.2, etaSeconds: 9 });
            onProgress({ phase: "mux", ratio: 7, etaSeconds: -2 });
            await new Promise<void>((resolve) => {
                finish = resolve;
            });
            return { kind: "done", result: { output: { kind: "file", path: "/exports/trip.mp4" } } };
        }, { progressIntervalMs: 60_000 });
        await expect(exporter.commandHandler({} as never, vi.fn())({ resolution: "720p" }, snapshot)).resolves.toEqual({ jobId: `gpu-${JOB}` });
        await vi.waitFor(() => expect(bridge.exports.gpuProgress).toHaveBeenCalledTimes(4));
        expect(vi.mocked(bridge.exports.gpuProgress).mock.calls).toEqual([
            [JOB, { phase: "probe", ratio: 0 }],
            [JOB, { phase: "raster", ratio: 0 }],
            [JOB, { phase: "render", ratio: 0.1 }],
            [JOB, { phase: "mux", ratio: 1 }],
        ]);
        expect(exporter.session.getState()).toMatchObject({ status: "running", progress: { phase: "mux", engine: "gpu" } });
        finish();
        await vi.waitFor(() => expect(exporter.session.getState()).toMatchObject({ status: "done" }));
    });

    it("uploads a worker-encoded video to main in slices before main finishes the job (phase 10d)", async () => {
        const size = UPLOAD_SLICE_BYTES * 2 + 5;
        const data = new Uint8Array(size).map((_v, i) => i % 251);
        const { bridge, exporter } = platform(async (_input, _settings, { runner, signal }) => {
            const output = await runner.mux({}, { kind: "blob", blob: new Blob([data]) }, { container: "mp4", signal });
            return { kind: "done", result: { output } };
        });
        await exporter.commandHandler({} as never, vi.fn())({ resolution: "720p" }, snapshot);
        await vi.waitFor(() => expect(bridge.exports.gpuMux).toHaveBeenCalledWith(JOB));
        const calls = vi.mocked(bridge.exports.gpuChunk).mock.calls;
        expect(calls.map(([job, position, bytes]) => [job, position, (bytes as Uint8Array).byteLength])).toEqual([
            [JOB, 0, UPLOAD_SLICE_BYTES], [JOB, UPLOAD_SLICE_BYTES, UPLOAD_SLICE_BYTES], [JOB, UPLOAD_SLICE_BYTES * 2, 5],
        ]);
        expect([...(calls[2][2] as Uint8Array)]).toEqual([...data.subarray(UPLOAD_SLICE_BYTES * 2)]);
        // Uploaded first, muxed after.
        expect(vi.mocked(bridge.exports.gpuChunk).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(bridge.exports.gpuMux).mock.invocationCallOrder[0]);
    });

    it("runs the GPU export in a worker unless the developer override turns it off", () => {
        expect(exportWorkerEnabled({ getItem: () => null })).toBe(typeof Worker !== "undefined");
        expect(exportWorkerEnabled({ getItem: (key) => (key === EXPORT_WORKER_STORAGE_KEY ? "off" : null) })).toBe(false);
    });

    it("stops its own GPU job when main asks (a cancel that reached main), and only that job", async () => {
        const { bridge, exporter, cancel } = platform((_input, _settings, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("Export cancelled."), { code: "cancelled" })), { once: true });
        }));
        await exporter.commandHandler({} as never, vi.fn())({}, snapshot);
        expect(bridge.exports.onGpuCancel).toHaveBeenCalled();
        cancel("00000000-0000-4000-8000-000000000000");
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(exporter.session.getState()).toMatchObject({ status: "running" });
        cancel(JOB);
        await vi.waitFor(() => expect(exporter.session.getState()).toEqual({ status: "cancelled" }));
        expect(bridge.exports.gpuAbort).toHaveBeenCalledWith(JOB);
    });

    it("tells main why the GPU job failed: a known code or unknown, and a bounded message", async () => {
        const failing = (error: unknown) => platform(async () => {
            throw error;
        });
        const a = failing(Object.assign(new Error("a file could not be read"), { code: "media-read-failed" }));
        await a.exporter.commandHandler({} as never, vi.fn())({}, snapshot);
        await vi.waitFor(() => expect(a.bridge.exports.gpuAbort).toHaveBeenCalledWith(JOB, { code: "media-read-failed", message: "a file could not be read" }));
        expect(a.exporter.session.getState()).toEqual({ status: "error", code: "media-read-failed", message: "a file could not be read" });
        const b = failing(Object.assign(new Error("x".repeat(5000)), { code: "rm -rf /" }));
        await b.exporter.commandHandler({} as never, vi.fn())({}, snapshot);
        await vi.waitFor(() => expect(b.bridge.exports.gpuAbort).toHaveBeenCalledWith(JOB, { code: "unknown", message: "x".repeat(2000) }));
    });

    it("finishes through main's mux and shows the result; a refused fallback shows main's refusal", async () => {
        const done = platform(async (_input, _settings, { runner, gpu }) => {
            const writer = gpu.createVideoSink().writable.getWriter();
            await writer.write({ type: "write", data: new Uint8Array([1, 2]), position: 0 });
            const output = await runner.mux({}, { kind: "file", path: "main" }, { container: "mp4" });
            return { kind: "done", result: { output, engine: "gpu" } };
        });
        await done.exporter.commandHandler({} as never, vi.fn())({}, snapshot);
        await vi.waitFor(() => expect(done.exporter.session.getState()).toEqual({ status: "done", result: { output: { kind: "file", path: "/exports/trip.mp4" }, engine: "gpu" } }));
        expect(done.bridge.exports.gpuChunk).toHaveBeenCalledWith(JOB, 0, new Uint8Array([1, 2]));
        expect(done.bridge.exports.gpuMux).toHaveBeenCalledWith(JOB);

        const refused = platform(async () => ({ kind: "fallback", reason: "WebGL2 is not available" }));
        refused.bridge.exports.gpuFallback = vi.fn(async () => ({ error: "An export is already running." }));
        await refused.exporter.commandHandler({} as never, vi.fn())({}, snapshot);
        await vi.waitFor(() => expect(refused.exporter.session.getState()).toEqual({ status: "error", code: "unknown", message: "An export is already running." }));
    });
});

describe("serveExportBridgePorts", () => {
    it("serves only the app's own port message", () => {
        const rasterizer = vi.fn(() => ({ rasterize: vi.fn() }));
        const glProcessor = vi.fn(() => ({ process: vi.fn() }) as never);
        const stop = serveExportBridgePorts({ rasterizer, glProcessor });
        const ports = () => [new MessageChannel().port1, new MessageChannel().port1];
        window.dispatchEvent(new MessageEvent("message", { data: "opennan:export-ports", origin: "https://evil.test", source: window, ports: ports() }));
        window.dispatchEvent(new MessageEvent("message", { data: "other", origin: window.location.origin, source: window, ports: ports() }));
        expect(rasterizer).not.toHaveBeenCalled();
        window.dispatchEvent(new MessageEvent("message", { data: "opennan:export-ports", origin: window.location.origin, source: window, ports: ports() }));
        expect(rasterizer).toHaveBeenCalledTimes(1);
        expect(glProcessor).toHaveBeenCalledTimes(1);
        stop();
    });
});

describe("copyingPort", () => {
    it("never transfers buffers (MessagePortMain receives transferred ArrayBuffers as null)", () => {
        const { port1 } = new MessageChannel();
        const post = vi.spyOn(port1, "postMessage");
        const png = new Uint8Array(8);
        copyingPort(port1).postMessage({ id: 0, ok: true, value: { png } }, [png.buffer]);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]).toHaveLength(1);
        expect(png.byteLength).toBe(8);
        port1.close();
    });
});
