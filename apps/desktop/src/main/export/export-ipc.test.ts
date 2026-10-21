import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC, EVENTS } from "../../shared/ipc";
import type { IpcEventLike, IpcMainLike } from "../ipc/handle";
import { createDesktopExporter } from "./desktop-exporter";
import { createDesktopExportJobs } from "./export-jobs";
import { exportFile, registerExportIpc, NOT_AN_EXPORT } from "./export-ipc";
import { createGpuJobs } from "./gpu-jobs";

describe("export IPC", () => {
    let dir: string;
    let exportsDir: string;
    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opennan-eipc-")));
        exportsDir = path.join(dir, "exports");
        fs.mkdirSync(exportsDir);
        fs.writeFileSync(path.join(exportsDir, "trip.mp4"), "1234");
        fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("accepts only files inside the exports folder", () => {
        expect(exportFile(exportsDir, path.join(exportsDir, "trip.mp4"))).toBe(path.join(exportsDir, "trip.mp4"));
        for (const file of [path.join(dir, "secret.txt"), path.join(exportsDir, "..", "secret.txt"), exportsDir, path.join(exportsDir, "missing.mp4"), "relative.mp4", "//host/share/x.mp4", "\\\\host\\share\\x.mp4"]) {
            expect(() => exportFile(exportsDir, file)).toThrow(NOT_AN_EXPORT);
        }
        if (process.platform !== "win32") {
            fs.symlinkSync(path.join(dir, "secret.txt"), path.join(exportsDir, "link.mp4"));
            expect(() => exportFile(exportsDir, path.join(exportsDir, "link.mp4"))).toThrow(NOT_AN_EXPORT);
        }
    });

    it("wires start, state, file info, reveal, and state events", async () => {
        const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        const invoke = async (channel: string, payload: unknown = {}) => handlers.get(channel)!({ senderFrame: top }, payload);
        const desktop = createDesktopExporter({ ffmpeg: null, mediaStore: { pathOf: () => null, root: dir }, exportsDir });
        const send = vi.fn();
        const showItemInFolder = vi.fn();
        registerExportIpc(ipc, { desktop, exportsDir, send, showItemInFolder });
        await expect(invoke(IPC.exportStart, { options: {}, snapshot: { tracks: [], clips: [], scenes: [], project: { name: "Trip" } } })).resolves.toEqual({ error: expect.stringContaining("ffmpeg") });
        await expect(invoke(IPC.exportState)).resolves.toEqual({ status: "idle" });
        await expect(invoke(IPC.exportFileInfo, { path: path.join(exportsDir, "trip.mp4") })).resolves.toEqual({ size: 4 });
        await invoke(IPC.exportReveal, { path: path.join(exportsDir, "trip.mp4") });
        expect(showItemInFolder).toHaveBeenCalledWith(path.join(exportsDir, "trip.mp4"));
        await expect(invoke(IPC.exportReveal, { path: path.join(dir, "secret.txt") })).rejects.toThrow(NOT_AN_EXPORT);
        expect(EVENTS.exportState).toBe("opennan:export:state-changed");
    });

    it("wires the window's GPU job channels: validated progress, abort with an error, fallback, cancel, and state events", async () => {
        const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
        const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
        const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
        top.top = top;
        const invoke = async (channel: string, payload: unknown = {}) => handlers.get(channel)!({ senderFrame: top }, payload);
        const desktop = createDesktopExporter({ ffmpeg: null, mediaStore: { pathOf: () => null, root: dir }, exportsDir });
        const runner = { kind: "node", supportsGl: false, maxResolution: "4k", probe: vi.fn(async () => new Map()), chooseEncoder: vi.fn(), run: vi.fn(), mux: vi.fn() } as never;
        const gpuJobs = createGpuJobs({ runner, mainBusy: () => desktop.exporter.isBusy(), setTarget: (name) => desktop.setTarget(name), tempDir: dir });
        const send = vi.fn();
        const jobs = createDesktopExportJobs({ main: desktop.exporter, gpu: gpuJobs, cancelWindowJob: (jobId) => send(EVENTS.exportGpuCancel, { jobId }), setTarget: desktop.setTarget });
        registerExportIpc(ipc, { desktop, gpuJobs, jobs, exportsDir, send, showItemInFolder: vi.fn() });
        const snapshot = { tracks: [], clips: [], scenes: [], project: { name: "Trip" } };
        const begin = async () => ((await invoke(IPC.exportGpuBegin, { options: {}, snapshot, container: "mp4", codec: "avc" })) as { jobId: string }).jobId;

        const first = await begin();
        await invoke(IPC.exportGpuProgress, { jobId: first, phase: "render", ratio: 0.5, etaSeconds: 4 });
        expect(jobs.status(`gpu-${first}`)).toEqual({ jobId: `gpu-${first}`, status: "running", phase: "render", ratio: 0.5, etaSeconds: 4, engine: "gpu" });
        await expect(invoke(IPC.exportState)).resolves.toEqual({ status: "running", progress: { phase: "render", ratio: 0.5, etaSeconds: 4, engine: "gpu" } });
        expect(send).toHaveBeenCalledWith(EVENTS.exportState, { status: "running", progress: { phase: "render", ratio: 0.5, etaSeconds: 4, engine: "gpu" } });
        for (const bad of [
            { jobId: first, phase: "render", ratio: Number.NaN },
            { jobId: first, phase: "render", ratio: 0.5, path: "/etc/passwd" },
            { jobId: "gpu-x", phase: "render", ratio: 0.5 },
        ]) await expect(invoke(IPC.exportGpuProgress, bad)).rejects.toThrow(/Invalid opennan:export:gpu-progress payload/);
        // Another id (not main's open job) changes nothing.
        await invoke(IPC.exportGpuProgress, { jobId: "00000000-0000-4000-8000-000000000000", phase: "mux", ratio: 1 });
        expect(jobs.status(`gpu-${first}`)).toMatchObject({ ratio: 0.5 });
        await expect(invoke(IPC.exportGpuAbort, { jobId: first, error: { code: "media-read-failed", message: "unreadable" }, path: "/x" })).rejects.toThrow(/Invalid/);
        await invoke(IPC.exportGpuAbort, { jobId: first, error: { code: "media-read-failed", message: "unreadable" } });
        expect(jobs.status(`gpu-${first}`)).toEqual({ jobId: `gpu-${first}`, status: "error", code: "media-read-failed", message: "unreadable" });

        // Cancel (the dialog's route into main, or an agent host's) asks the window to stop and ends main's side.
        const second = await begin();
        await invoke(IPC.exportCancel);
        expect(send).toHaveBeenCalledWith(EVENTS.exportGpuCancel, { jobId: second });
        await vi.waitFor(() => expect(jobs.status(`gpu-${second}`)).toEqual({ jobId: `gpu-${second}`, status: "cancelled" }));

        // A fallback runs main's export from the job's snapshot (this build has no ffmpeg: the job fails with that).
        const third = await begin();
        await expect(invoke(IPC.exportGpuFallback, { jobId: third, snapshot })).rejects.toThrow(/Invalid/);
        await expect(invoke(IPC.exportGpuFallback, { jobId: third })).resolves.toEqual({ error: expect.stringContaining("ffmpeg") });
        expect(jobs.status(`gpu-${third}`)).toMatchObject({ status: "error", message: expect.stringContaining("ffmpeg") });
    });
});
