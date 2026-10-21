// Every export the desktop runs, as one StudioExporter (phase 10d): main's native ffmpeg exports (job ids
// export-…) and the editor window's GPU exports (gpu-<uuid>, gpu-jobs.ts). MCP (get_export_status), the export
// IPC, and the Export dialog's mirror of main read this facade, so an agent's assemble_video on the GPU path is a
// job like any other: status and settled follow it to the file main wrote, cancel stops the window's render, and
// a GPU job that falls back keeps its id while main's export runs it.
import type { ExportSessionState } from "@opennan/export";
import { exportJobStatus, type ExportJobStatus, type StudioExporter } from "@opennan/mcp";
import type { ExportCommandOutcome } from "@opennan/timeline-core";
import type { GpuJobs, GpuJobStatus } from "./gpu-jobs";

/** Job ids the editor hands out for GPU exports: gpu-<main's job uuid>. */
export const GPU_JOB_PREFIX = "gpu-";

export interface DesktopExportJobsOptions {
    main: StudioExporter;
    gpu: GpuJobs;
    /** Asks the editor window to stop its GPU export (EVENTS.exportGpuCancel). */
    cancelWindowJob(jobId: string): void;
    /** Names the fallback export's file after the project. */
    setTarget?(projectName: string | null | undefined): void;
}

export interface DesktopExportJobs extends StudioExporter {
    /** The window's GPU job cannot run after all: main's native export takes over from the job's own snapshot. */
    fallback(jobId: string): Promise<ExportCommandOutcome>;
}

export function createDesktopExportJobs({ main, gpu, cancelWindowJob, setTarget }: DesktopExportJobsOptions): DesktopExportJobs {
    // Which source the export view shows: the one that changed last.
    let source: "main" | "gpu" = "main";
    gpu.subscribe((state) => {
        if (state.status !== "idle") source = "gpu";
    });
    main.subscribe((state) => {
        if (state.status !== "idle") source = "main";
    });

    const gpuStatus = (jobId: string, status: GpuJobStatus): ExportJobStatus | null => {
        if (!status.fallback) return exportJobStatus(jobId, status.state);
        const taken = main.status(status.fallback);
        return taken ? { ...taken, jobId } : null;
    };

    return {
        onExport: (options, snapshot) => main.onExport(options, snapshot),
        frameRenderer: main.frameRenderer,

        status(jobId) {
            if (!jobId.startsWith(GPU_JOB_PREFIX)) return main.status(jobId);
            const status = gpu.status(jobId.slice(GPU_JOB_PREFIX.length));
            return status ? gpuStatus(jobId, status) : null;
        },

        async settled(jobId) {
            if (!jobId.startsWith(GPU_JOB_PREFIX)) return main.settled(jobId);
            const status = await gpu.settled(jobId.slice(GPU_JOB_PREFIX.length));
            if (!status) return null;
            if (status.fallback) {
                const taken = await main.settled(status.fallback);
                return taken ? { ...taken, jobId } : null;
            }
            return exportJobStatus(jobId, status.state);
        },

        cancel() {
            const current = gpu.current();
            if (!current) {
                main.cancel();
                return;
            }
            // The window first (its render stops within a frame), then main's side: the chunk stream and the mux end.
            cancelWindowJob(current);
            void gpu.abort(current);
        },

        getState(): ExportSessionState {
            const latest = gpu.latest();
            if (gpu.active() || (source === "gpu" && latest)) return latest?.state ?? { status: "idle" };
            return main.getState();
        },

        isBusy: () => main.isBusy() || gpu.active(),

        subscribe(listener) {
            const stopMain = main.subscribe(listener);
            const stopGpu = gpu.subscribe((state, jobId) => listener(state, jobId ? `${GPU_JOB_PREFIX}${jobId}` : null));
            return () => {
                stopMain();
                stopGpu();
            };
        },

        reset() {
            main.reset();
            gpu.reset();
        },

        async fallback(jobId) {
            const request = await gpu.release(jobId);
            setTarget?.(request.snapshot.project?.name);
            // Whatever happens, the job must settle: a start that throws (the window's catalog RPC detaching) is its error.
            let outcome: ExportCommandOutcome;
            try {
                outcome = await main.onExport(request.options, request.snapshot);
            } catch (error) {
                outcome = { error: error instanceof Error ? error.message : String(error) };
            }
            gpu.link(jobId, outcome);
            return outcome;
        },
    };
}
