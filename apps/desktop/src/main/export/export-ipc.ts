// Export channels: start (export.start from the renderer's controller), cancel, reset, state, and the two
// file helpers, which accept only files inside the exports folder.
import fs from "node:fs";
import path from "node:path";
import { isRemotePath } from "@opennan/mcp";
import type { ControllerSnapshot } from "@opennan/timeline-core";
import { EVENTS, IPC } from "../../shared/ipc";
import { handle, type IpcMainLike } from "../ipc/handle";
import type { DesktopExporter } from "./desktop-exporter";
import type { DesktopExportJobs } from "./export-jobs";
import { EXPORT_BUSY, type GpuJobs } from "./gpu-jobs";

export const NOT_AN_EXPORT = "Not an export of this app";

/** The real path of `file` when it is a file inside `exportsDir`; otherwise throws. */
export function exportFile(exportsDir: string, file: string): string {
    // As written first (no filesystem call for paths elsewhere, network shares included), then the real path.
    const lexical = path.resolve(exportsDir, file);
    if (isRemotePath(file) || !lexical.startsWith(path.resolve(exportsDir) + path.sep)) throw new Error(NOT_AN_EXPORT);
    let real: string;
    let root: string;
    try {
        real = fs.realpathSync(file);
        root = fs.realpathSync(exportsDir);
    } catch {
        throw new Error(NOT_AN_EXPORT);
    }
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error(NOT_AN_EXPORT);
    return real;
}

export interface ExportIpcOptions {
    desktop: DesktopExporter;
    /** The editor window's GPU export jobs (phase 10c); absent: the GPU channels refuse. */
    gpuJobs?: GpuJobs;
    /** Main's and the window's exports as one exporter (export-jobs.ts); default: main's exporter alone. */
    jobs?: DesktopExportJobs;
    exportsDir: string;
    send(channel: string, payload: unknown): void;
    showItemInFolder(file: string): void;
}

export function registerExportIpc(ipc: IpcMainLike, { desktop, gpuJobs, jobs, exportsDir, send, showItemInFolder }: ExportIpcOptions): () => void {
    const exporter = jobs ?? desktop.exporter;
    handle(ipc, IPC.exportStart, ({ options, snapshot }) => {
        if (gpuJobs?.active()) return { error: EXPORT_BUSY };
        const typed = snapshot as unknown as ControllerSnapshot;
        desktop.setTarget(typed.project?.name);
        return exporter.onExport(options, typed);
    });
    handle(ipc, IPC.exportCancel, () => exporter.cancel());
    handle(ipc, IPC.exportReset, () => exporter.reset());
    handle(ipc, IPC.exportState, () => exporter.getState());
    handle(ipc, IPC.exportFileInfo, ({ path: file }) => ({ size: fs.statSync(exportFile(exportsDir, file)).size }));
    handle(ipc, IPC.exportReveal, ({ path: file }) => showItemInFolder(exportFile(exportsDir, file)));
    const noGpu = async () => {
        throw new Error("GPU export is not available");
    };
    handle(ipc, IPC.exportGpuBegin, (payload) => (gpuJobs ? gpuJobs.begin({ ...payload, snapshot: payload.snapshot as unknown as ControllerSnapshot }) : noGpu()));
    handle(ipc, IPC.exportGpuChunk, ({ jobId, position, bytes }) => (gpuJobs ? gpuJobs.chunk(jobId, position, bytes) : noGpu()));
    handle(ipc, IPC.exportGpuMux, ({ jobId }) => (gpuJobs ? gpuJobs.mux(jobId) : noGpu()));
    // The window reports only its own job's numbers, enums, and a short error text; the result's path is main's.
    handle(ipc, IPC.exportGpuAbort, ({ jobId, error }) => (gpuJobs ? gpuJobs.abort(jobId, error) : noGpu()));
    handle(ipc, IPC.exportGpuProgress, ({ jobId, phase, ratio, etaSeconds }) => (gpuJobs ? gpuJobs.progress(jobId, { phase, ratio, etaSeconds }) : noGpu()));
    handle(ipc, IPC.exportGpuFallback, ({ jobId }) => (jobs ? jobs.fallback(jobId) : noGpu()));
    return exporter.subscribe((state) => send(EVENTS.exportState, state));
}
