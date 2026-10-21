// Exports and preview frames through @opennan/export (spec §5.1.1 export.start and
// previewFrame, §5.8): the same createExportSession pipeline as the editor's Export
// button. Hosts bring the runner: headless mode the native ffmpeg runner
// (@opennan/export/node, headless.ts), desktop its own. Part of @opennan/mcp/server:
// only @opennan/export's runner-agnostic main entry is imported here.
import {
    EXPORT_RESOLUTIONS, createExportFrameRenderer, createExportSession, resolutionWithin,
    type ExportEngine, type ExportProgress, type ExportResolution, type ExportRunner, type ExportSessionState, type ExportTimelineOptions, type ExportWarning,
} from "@opennan/export";
import type { ControllerSnapshot, EffectDef, ExportCommandOutcome, FrameRenderer } from "@opennan/timeline-core";

/** An export job as agents see it: JSON-safe, never the file bytes. */
export type ExportJobStatus =
    | { jobId: string; status: "running"; phase: ExportProgress["phase"]; ratio: number; etaSeconds?: number; engine?: ExportEngine }
    | {
        jobId: string;
        status: "done";
        output: { kind: "file"; path: string } | { kind: "bytes"; size: number };
        container: string;
        mimeType: string;
        encoder: string;
        durationSeconds: number;
        width: number;
        height: number;
        warnings: ExportWarning[];
    }
    | { jobId: string; status: "error"; code: string; message: string }
    | { jobId: string; status: "cancelled" };

export interface StudioExporterOptions {
    runner: ExportRunner;
    /** Draws text and emoji; without one they are left out with text-unsupported warnings. */
    rasterizer?: ExportTimelineOptions["rasterizer"];
    glProcessor?: ExportTimelineOptions["glProcessor"];
    /** Allow GPL encoders (libx264). Default false. */
    allowGpl?: boolean;
    /** GL effect catalog, e.g. () => backend.listEffects("effect"). */
    effects?: () => Promise<EffectDef[]>;
    /** Default 1080p, or the runner's maximum when it renders less. */
    defaultResolution?: ExportResolution;
    /** True while another export of the host runs (the desktop editor's GPU export): onExport refuses then. */
    busy?(): boolean;
}

export interface StudioExporter {
    /** TimelineControllerOptions.onExport: export.start lands here. */
    onExport(options: Record<string, unknown>, snapshot: ControllerSnapshot): Promise<ExportCommandOutcome>;
    /** TimelineControllerOptions.frameRenderer over the same runner (previewFrame). */
    frameRenderer: FrameRenderer;
    /** The job's state; null for ids this exporter did not start. */
    status(jobId: string): ExportJobStatus | null;
    /** Resolves once the job has finished (done, error, or cancelled). */
    settled(jobId: string): Promise<ExportJobStatus | null>;
    /** Cancels the running export, if any. */
    cancel(): void;
    /** TimelineControllerOptions.onExportCancel: export.cancel (phase 10d) — the running job, or `jobId` if it is the running one. */
    onExportCancel?(jobId: string | undefined): Promise<ExportCommandOutcome>;
    /** The export session's state (the Export dialog's view): idle, running, done, error, or cancelled. */
    getState(): ExportSessionState;
    /** True while an export runs or is starting (claimed before its first await). */
    isBusy(): boolean;
    /** Called on every state change with the job id it belongs to (null after reset). Returns unsubscribe. */
    subscribe(listener: (state: ExportSessionState, jobId: string | null) => void): () => void;
    /** Back to idle after a finished run (no-op while one runs). */
    reset(): void;
}

/** An export session state as agents see it (hosts with their own job sources, e.g. the desktop's GPU jobs, use it too). */
export function exportJobStatus(jobId: string, state: ExportSessionState): ExportJobStatus {
    switch (state.status) {
        case "idle":
            return { jobId, status: "running", phase: "probe", ratio: 0 };
        case "running":
            return {
                jobId, status: "running", phase: state.progress.phase, ratio: state.progress.ratio,
                ...(state.progress.etaSeconds !== undefined ? { etaSeconds: state.progress.etaSeconds } : {}),
                ...(state.progress.engine ? { engine: state.progress.engine } : {}),
            };
        case "done": {
            const { result } = state;
            return {
                jobId,
                status: "done",
                output: result.output.kind === "file" ? { kind: "file", path: result.output.path } : { kind: "bytes", size: result.output.kind === "bytes" ? result.output.data.byteLength : result.output.blob.size },
                container: result.container,
                mimeType: result.mimeType,
                encoder: result.encoder,
                durationSeconds: result.durationSeconds,
                width: result.width,
                height: result.height,
                warnings: result.warnings,
            };
        }
        case "error":
            return { jobId, status: "error", code: state.code, message: state.message };
        case "cancelled":
            return { jobId, status: "cancelled" };
    }
}

export function createStudioExporter(options: StudioExporterOptions): StudioExporter {
    const { runner } = options;
    const effects = options.effects;
    const session = createExportSession({ runner, rasterizer: options.rasterizer, glProcessor: options.glProcessor, allowGpl: options.allowGpl });
    const jobs = new Map<string, { state: ExportSessionState; done: Promise<unknown> }>();
    const fallback: ExportResolution = resolutionWithin("1080p", runner.maxResolution) ? "1080p" : runner.maxResolution;
    let current: string | null = null;
    // The job the session state belongs to, for UIs: set when a job starts, cleared by reset().
    let lastJob: string | null = null;
    let starting = false;
    let counter = 0;
    session.subscribe(() => {
        const job = current ? jobs.get(current) : undefined;
        if (!job) return;
        job.state = session.getState();
        if (job.state.status !== "running") current = null;
    });

    return {
        async onExport(commandOptions, snapshot) {
            // Checked and claimed before the first await, so two quick calls cannot both start an export.
            if (starting || session.getState().status === "running" || options.busy?.()) return { error: "An export is already running." };
            const resolution = (commandOptions.resolution ?? options.defaultResolution ?? fallback) as ExportResolution;
            if (!EXPORT_RESOLUTIONS.includes(resolution)) return { error: `resolution must be one of ${EXPORT_RESOLUTIONS.join(", ")}.` };
            if (!resolutionWithin(resolution, runner.maxResolution)) return { error: `This exporter renders up to ${runner.maxResolution}.` };
            // Phase 10d: an animated GIF instead of a video file.
            const format = commandOptions.format ?? "video";
            if (format !== "video" && format !== "gif") return { error: "format must be video or gif." };
            starting = true;
            try {
                const catalog = effects ? await effects() : [];
                counter += 1;
                const jobId = `export-${Date.now()}-${counter}`;
                const job: { state: ExportSessionState; done: Promise<unknown> } = { state: session.getState(), done: Promise.resolve() };
                jobs.set(jobId, job);
                current = jobId;
                lastJob = jobId;
                // start() never rejects (ExportSession contract): progress, result, and errors land in the state.
                job.done = session.start({
                    project: {
                        aspectRatio: snapshot.project?.aspectRatio ?? "16:9",
                        musicUrl: snapshot.project?.musicUrl ?? null,
                        musicVolume: snapshot.project?.musicVolume ?? 1,
                    },
                    tracks: snapshot.tracks,
                    clips: snapshot.clips,
                    scenes: snapshot.scenes,
                    effects: catalog,
                }, format === "gif" ? { resolution, format } : { resolution });
                job.state = session.getState();
                return { jobId };
            } finally {
                starting = false;
            }
        },
        frameRenderer: createExportFrameRenderer({ runner, rasterizer: options.rasterizer, effects: effects ? () => effects() : undefined }),
        status(jobId) {
            const job = jobs.get(jobId);
            return job ? exportJobStatus(jobId, job.state) : null;
        },
        async settled(jobId) {
            const job = jobs.get(jobId);
            if (!job) return null;
            await job.done;
            return exportJobStatus(jobId, job.state);
        },
        cancel() {
            session.cancel();
        },
        async onExportCancel(jobId) {
            const running = current && session.getState().status === "running" ? current : null;
            if (!running) return { error: "No export is running." };
            if (jobId && jobId !== running) return { error: `Export ${jobId} is not the running export (${running}).` };
            session.cancel();
            return { jobId: running };
        },
        getState: () => session.getState(),
        isBusy: () => starting || session.getState().status === "running",
        subscribe(listener) {
            return session.subscribe(() => {
                const state = session.getState();
                listener(state, state.status === "idle" ? null : lastJob);
            });
        },
        reset() {
            session.reset();
            if (session.getState().status === "idle") lastJob = null;
        },
    };
}
