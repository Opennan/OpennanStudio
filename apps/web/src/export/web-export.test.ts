import type { ControllerSnapshot } from "@opennan/timeline-core";
import { LocalBackend, createMemoryPersistence } from "@opennan/timeline-core";
import type { ExportSessionState } from "@opennan/export";
import { DEFAULT_FFMPEG_CORE_BASE } from "@opennan/export/web";

const removed = vi.hoisted(() => [] as string[]);
vi.mock("@opennan/export/web", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@opennan/export/web")>()),
    removeOpfsExport: vi.fn(async (name: string) => {
        removed.push(name);
    }),
}));
import {
    EXPORT_ENGINE_STORAGE_KEY, EXPORT_WORKER_STORAGE_KEY, FFMPEG_CORE_BASE, exportWorkerEnabled, WEB_EXPORT_ALLOW_GPL, WEB_EXPORT_RESOLUTIONS, createExportCommandHandler, createWebExportPlatform, createWebExporter, exportBlob, DELIVERED_FILE_GRACE_MS, disposeExporter,
    exportEngineOverride, gpuFormatLabel, webExportFormatLabel, type WebExporter,
} from "./web-export";

function fakeExporter() {
    let state: ExportSessionState = { status: "idle" };
    const listeners = new Set<() => void>();
    const start = vi.fn(async () => state);
    const exporter: WebExporter = {
        session: {
            getState: () => state,
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            start, cancel: vi.fn(), reset: vi.fn(),
        },
        dispose: vi.fn(),
    };
    return { exporter, start, set: (next: ExportSessionState) => { state = next; listeners.forEach((l) => l()); } };
}

const snapshot = {
    projectId: "p", project: { id: "p", name: "Trip", musicUrl: "/m.mp3", musicVolume: 0.4, aspectRatio: "9:16" }, tracks: [], clips: [], scenes: [],
} as unknown as ControllerSnapshot;
const backend = () => new LocalBackend({ persistence: createMemoryPersistence() });

describe("web export", () => {
    it("self-hosts the core, keeps GPL off by default, and stops at 1080p", () => {
        expect(DEFAULT_FFMPEG_CORE_BASE).toBe("/ffmpeg-core");
        expect(FFMPEG_CORE_BASE).toBe("./ffmpeg-core");
        expect(WEB_EXPORT_ALLOW_GPL).toBe(false);
        expect(webExportFormatLabel()).toBe("MP4 (MPEG-4 Part 2, AAC)");
        expect(webExportFormatLabel(true)).toBe("MP4 (H.264, AAC)");
        expect(WEB_EXPORT_RESOLUTIONS).toEqual(["720p", "1080p"]);
        const exporter = createWebExporter({ resolveMediaUrl: (u) => u });
        expect(exporter.session.getState()).toEqual({ status: "idle" });
        exporter.dispose();
    });

    it("hands a streamed (disk-backed) result over as is, typed", () => {
        const file = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
        const result = { output: { kind: "blob" as const, blob: file, opfsName: "export-1.mp4" }, container: "mp4" as const, mimeType: "video/mp4", encoder: "webcodecs-avc", durationSeconds: 1, width: 2, height: 2, warnings: [], engine: "gpu" as const };
        expect(exportBlob(result)).toBe(file);
        const untyped = exportBlob({ ...result, output: { kind: "blob", blob: new Blob([new Uint8Array([1])]) } });
        expect(untyped.type).toBe("video/mp4");
    });

    it("runs the GPU export in a worker unless the developer override turns it off", () => {
        expect(exportWorkerEnabled({ getItem: () => null })).toBe(true);
        expect(exportWorkerEnabled({ getItem: (key) => (key === EXPORT_WORKER_STORAGE_KEY ? "off" : null) })).toBe(false);
        expect(exportWorkerEnabled({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
    });

    it("export.cancel stops the running job, checks the id, and says when nothing runs (phase 10d)", async () => {
        const fake = fakeExporter();
        const handler = createExportCommandHandler(fake.exporter, backend(), vi.fn());
        await expect(handler.cancel!(undefined)).resolves.toEqual({ error: "No export is running." });
        const { jobId } = await handler({ resolution: "720p" }, snapshot) as { jobId: string };
        fake.set({ status: "running", progress: { phase: "render", ratio: 0.2 } });
        await expect(handler.cancel!("local-export-other")).resolves.toMatchObject({ error: expect.stringContaining("is not the running export") });
        await expect(handler.cancel!(jobId)).resolves.toEqual({ jobId });
        expect(fake.exporter.session.cancel).toHaveBeenCalledTimes(1);
    });

    it("export.cancel refuses a job id when the running export was started from the dialog (it has none)", async () => {
        const fake = fakeExporter();
        const handler = createExportCommandHandler(fake.exporter, backend(), vi.fn());
        fake.set({ status: "running", progress: { phase: "render", ratio: 0.2 } });
        await expect(handler.cancel!("local-export-stale")).resolves.toMatchObject({ error: expect.stringContaining("is not the running export") });
        expect(fake.exporter.session.cancel).not.toHaveBeenCalled();
        await expect(handler.cancel!(undefined)).resolves.toEqual({});
        expect(fake.exporter.session.cancel).toHaveBeenCalledTimes(1);
    });

    it("disposing the exporter mid-export cancels it before freeing ffmpeg.wasm", () => {
        const runner = { dispose: vi.fn() };
        const running = { getState: () => ({ status: "running" }) as ExportSessionState, cancel: vi.fn() };
        disposeExporter(running, runner);
        expect(running.cancel).toHaveBeenCalledTimes(1);
        expect(runner.dispose).toHaveBeenCalledTimes(1);
        const idle = { getState: () => ({ status: "idle" }) as ExportSessionState, cancel: vi.fn() };
        disposeExporter(idle, runner);
        expect(idle.cancel).not.toHaveBeenCalled();
    });

    it("keeps a delivered OPFS file for a while after the dialog lets go of it (a download may still read it)", async () => {
        vi.useFakeTimers();
        try {
            const platform = createWebExportPlatform({ createObjectUrl: () => "blob:x", revokeObjectUrl: vi.fn(), click: vi.fn() });
            const exporter = platform.createExporter({ resolveMediaUrl: (u) => u });
            const blob = new Blob([new Uint8Array([1])], { type: "video/mp4" });
            const delivery = await exporter.deliver({ output: { kind: "blob", blob, opfsName: "export-1.mp4" }, container: "mp4", mimeType: "video/mp4", encoder: "webcodecs-avc", durationSeconds: 1, width: 2, height: 2, warnings: [], engine: "gpu" }, "Trip");
            expect(delivery.opfsName).toBe("export-1.mp4");
            exporter.release!(delivery);
            expect(removed).toEqual([]);
            vi.advanceTimersByTime(DELIVERED_FILE_GRACE_MS + 1);
            expect(removed).toEqual(["export-1.mp4"]);
            exporter.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("turns byte results into a blob", () => {
        const blob = exportBlob({ output: { kind: "bytes", data: new Uint8Array([1, 2]) }, container: "mp4", mimeType: "video/mp4", encoder: "mpeg4", durationSeconds: 1, width: 2, height: 2, warnings: [], engine: "ffmpeg" });
        expect([blob.size, blob.type]).toEqual([2, "video/mp4"]);
    });

    it("export.start opens the dialog, runs the export, tracks the job, and refuses a second one", async () => {
        const fake = fakeExporter();
        const show = vi.fn();
        const handler = createExportCommandHandler(fake.exporter, backend(), show);
        const { jobId } = await handler({ resolution: "1080p" }, snapshot);
        expect(jobId).toMatch(/^local-export-/);
        expect(show).toHaveBeenCalled();
        expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ project: expect.objectContaining({ aspectRatio: "9:16" }) }), { resolution: "1080p" });
        fake.set({ status: "running", progress: { phase: "encode", ratio: 0.1 } });
        expect(handler.status(jobId!)).toEqual({ status: "running", progress: { phase: "encode", ratio: 0.1 } });
        expect(await handler({}, snapshot)).toEqual({ error: "An export is already running." });
        fake.set({ status: "cancelled" });
        expect(handler.status(jobId!)).toEqual({ status: "cancelled" });
        expect(handler.status("nope")).toBeNull();
    });

    it("export.start passes the GIF format on (phase 10d) and refuses unknown formats", async () => {
        const fake = fakeExporter();
        const handler = createExportCommandHandler(fake.exporter, backend(), vi.fn());
        expect(await handler({ format: "mov" }, snapshot)).toEqual({ error: "format must be video or gif." });
        await handler({ format: "gif" }, snapshot);
        expect(fake.start).toHaveBeenCalledWith(expect.anything(), { resolution: "720p", format: "gif" });
    });

    it("two quick export.start calls start one export", async () => {
        const fake = fakeExporter();
        const handler = createExportCommandHandler(fake.exporter, backend(), vi.fn());
        const outcomes = await Promise.all([handler({}, snapshot), handler({}, snapshot)]);
        expect(fake.start).toHaveBeenCalledTimes(1);
        expect(outcomes.filter((outcome) => outcome.error)).toEqual([{ error: "An export is already running." }]);
    });

    it("describes the web platform", () => {
        const platform = createWebExportPlatform();
        expect(platform.resolutions).toEqual(["720p", "1080p"]);
        expect(platform.resolutionNote).toBe("4K needs the desktop app");
        expect(platform.gl).toBe(false);
        // ffmpeg.wasm: long animated effects get the slow-web-effect warning.
        expect(platform.nativeSpeed).toBe(false);
        expect(platform.formatLabel).toBe(webExportFormatLabel());
        expect(platform.formats).toEqual(["video", "gif"]);
    });

    it("delivers a GIF as a .gif download", async () => {
        const click = vi.fn();
        const exporter = createWebExportPlatform({ createObjectUrl: () => "blob:g", revokeObjectUrl: vi.fn(), click }).createExporter({ resolveMediaUrl: (u) => u });
        const delivery = await exporter.deliver({
            output: { kind: "bytes", data: new Uint8Array([71, 73, 70]) }, container: "gif", mimeType: "image/gif", encoder: "gif",
            durationSeconds: 1, width: 640, height: 360, warnings: [], engine: "gpu",
        }, "Beach trip");
        expect(delivery.fileName).toBe("beach-trip.gif");
        expect(click).toHaveBeenCalledWith("blob:g", "beach-trip.gif");
        exporter.dispose();
    });

    it("delivers bytes as a one-time download and releases the URL", async () => {
        const click = vi.fn();
        const revoke = vi.fn();
        const exporter = createWebExportPlatform({ createObjectUrl: () => "blob:x", revokeObjectUrl: revoke, click }).createExporter({ resolveMediaUrl: (u) => u });
        const delivery = await exporter.deliver({
            output: { kind: "bytes", data: new Uint8Array([1, 2, 3]) }, container: "mp4", mimeType: "video/mp4", encoder: "mpeg4",
            durationSeconds: 1, width: 2, height: 2, warnings: [], engine: "ffmpeg",
        }, "Beach trip");
        expect(delivery).toEqual({ fileName: "beach-trip.mp4", size: 3, url: "blob:x" });
        expect(click).toHaveBeenCalledWith("blob:x", "beach-trip.mp4");
        exporter.release?.(delivery);
        expect(revoke).toHaveBeenCalledWith("blob:x");
        exporter.dispose();
    });

    it("the platform exporter's command handler is the web export.start handler", async () => {
        const exporter = createWebExportPlatform().createExporter({ resolveMediaUrl: (u) => u });
        const show = vi.fn();
        const handler = exporter.commandHandler(backend(), show);
        expect(typeof handler).toBe("function");
        exporter.dispose();
    });

    describe("engine choice (phase 10c)", () => {
        const input = { project: { aspectRatio: "16:9", musicUrl: null, musicVolume: 1 }, tracks: [], clips: [], scenes: [] };

        it("reads the developer override from localStorage, ignoring junk and storage errors", () => {
            expect(exportEngineOverride({ getItem: (key) => (key === EXPORT_ENGINE_STORAGE_KEY ? "ffmpeg" : null) })).toBe("ffmpeg");
            expect(exportEngineOverride({ getItem: () => "fast" })).toBeNull();
            expect(exportEngineOverride({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
            expect(exportEngineOverride(null)).toBeNull();
        });

        it("labels GPU formats by codec", () => {
            expect(gpuFormatLabel("avc")).toBe("MP4 (H.264, AAC)");
            expect(gpuFormatLabel("vp9")).toBe("WebM (VP9, Opus)");
        });

        it("previews the compatible engine when the GPU path is off or overridden", async () => {
            const off = createWebExporter({ resolveMediaUrl: (u) => u }, undefined, { gpu: null, engineOverride: null });
            await expect(off.engine!(input, "720p")).resolves.toMatchObject({ engine: "ffmpeg", nativeSpeed: false });
            off.dispose();
            const forced = createWebExporter({ resolveMediaUrl: (u) => u }, undefined, { engineOverride: "ffmpeg" });
            await expect(forced.engine!(input, "720p")).resolves.toMatchObject({ engine: "ffmpeg", reason: "the compatible export is selected" });
            forced.dispose();
        });

        it("previews the GPU engine when it is ready, and the reason when it is not", async () => {
            const gpu = {
                loadMediabunny: async () => ({ getFirstEncodableVideoCodec: async () => "vp9" }) as never,
                createSource: () => { throw new Error("unused"); },
                fetchBlob: async () => new Blob(),
                createRenderer: () => null,
                isAvailable: () => true,
            };
            (globalThis as { VideoEncoder?: unknown }).VideoEncoder ??= class {};
            const ready = createWebExporter({ resolveMediaUrl: (u) => u }, undefined, { gpu, engineOverride: null });
            await expect(ready.engine!(input, "1080p")).resolves.toEqual({ engine: "gpu", formatLabel: "WebM (VP9, Opus)", nativeSpeed: true, gl: false });
            const noGl = createWebExporter({ resolveMediaUrl: (u) => u }, undefined, { gpu: { ...gpu, isAvailable: () => false }, engineOverride: null });
            await expect(noGl.engine!(input, "1080p")).resolves.toMatchObject({ engine: "ffmpeg", reason: "WebGL2 is not available" });
            ready.dispose();
            noGl.dispose();
        });
    });
});
