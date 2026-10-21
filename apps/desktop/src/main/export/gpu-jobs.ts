// GPU export jobs (phase 10c): the editor window renders and encodes the video with WebGL2 + WebCodecs and streams
// the encoded file here in chunks; main then adds the timeline's audio with the bundled LGPL ffmpeg (runner.mux,
// video stream-copied) and writes the export into the exports folder. Main never takes a filter graph or a path
// from the renderer: it compiles the audio graph itself from the job's snapshot (media resolved by the runner's
// source policy) and the video file is one it created.
//
// Every job also has a state here (phase 10d), so agents can follow GPU exports like main's own: running (the
// window's validated progress: phase, ratio, ETA), done (the result main built from its own mux, so the path is
// always main's), error (the window's code and short message, or main's own failure), or cancelled; a fallback
// links the job to the native export that took over. The last MAX_GPU_JOB_RECORDS jobs are kept.
// A GIF job ends with the runner's GIF step instead (palette in two passes, no audio), sized from the job's own
// snapshot.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    collectMediaUrls, compileMux, containerMimeType, staticExportWarnings,
    type ExportFormatKind, type ExportInput, type ExportProgress, type ExportResult, type ExportRunner, type ExportSessionState, type ExportWarning,
} from "@opennan/export";
import type { ControllerSnapshot, EffectDef, ExportCommandOutcome } from "@opennan/timeline-core";
import { EXPORT_ERROR_CODES, MAX_GPU_ERROR_MESSAGE, MAX_GPU_ETA_SECONDS, type GPU_PHASES, type GPU_VIDEO_CODECS } from "../../shared/ipc";

export const EXPORT_BUSY = "An export is already running.";
/** Largest encoded video a GPU job may stream (a 4K hour at 35 Mbit/s is about 16 GB). */
export const MAX_GPU_VIDEO_BYTES = 32 * 2 ** 30;
/** Finished jobs whose state is kept for get_export_status. */
export const MAX_GPU_JOB_RECORDS = 20;

export interface GpuJobsOptions {
    /** The desktop exporter's node runner (null without ffmpeg). */
    runner: ExportRunner | null;
    /** True while the main-process export runs. */
    mainBusy(): boolean;
    /** Names the next export file after the project. */
    setTarget(projectName: string | null | undefined): void;
    effects?(): Promise<EffectDef[]>;
    /** Parent of job temp folders. Default os.tmpdir(). */
    tempDir?: string;
}

export interface GpuJobBegin {
    /** `format` "gif" (phase 10d): main turns the video into the GIF instead of adding audio. */
    options: { resolution?: "720p" | "1080p" | "4k"; format?: ExportFormatKind };
    snapshot: ControllerSnapshot;
    container: "mp4" | "webm";
    /** The window's WebCodecs codec (names the encoder in the result). */
    codec?: (typeof GPU_VIDEO_CODECS)[number];
}

/** What the window may report while it renders (validated by shared/ipc.ts; clamped here). */
export interface GpuJobProgress {
    phase: (typeof GPU_PHASES)[number];
    ratio: number;
    etaSeconds?: number;
}

export interface GpuJobError {
    code: (typeof EXPORT_ERROR_CODES)[number];
    message: string;
}

/** A job's state; `fallback` is main's export job that took over (its state is the job's from then on). */
export interface GpuJobStatus {
    state: Exclude<ExportSessionState, { status: "idle" }>;
    fallback: string | null;
}

interface JobRecord extends GpuJobStatus {
    settled: Promise<void>;
    resolve(): void;
    /** The begin request while the job may still fall back to main's export. */
    request: { options: GpuJobBegin["options"]; snapshot: ControllerSnapshot } | null;
}

interface Job {
    /** Chunk writes in order; closing the file waits for them (a write never lands on a reused descriptor). */
    writes: Promise<void>;
    id: string;
    dir: string;
    file: string;
    fd: number | null;
    bytes: number;
    input: ExportInput;
    resolution: "720p" | "1080p" | "4k";
    format: ExportFormatKind;
    container: "mp4" | "webm";
    codec: GpuJobBegin["codec"];
    abort: AbortController;
    muxing: boolean;
}

export interface GpuJobs {
    begin(request: GpuJobBegin): Promise<{ jobId: string } | { error: string }>;
    chunk(jobId: string, position: number, bytes: Uint8Array): Promise<void>;
    /** Adds the audio and writes the export; resolves with its path. The job ends either way. */
    mux(jobId: string): Promise<{ path: string }>;
    /** Ends the open job: cancelled, or failed with the given error. No-op for a job that already ended. */
    abort(jobId: string, error?: GpuJobError): Promise<void>;
    /** The window's progress for the open job (ignored for other ids, after the end, and while main muxes). */
    progress(jobId: string, progress: GpuJobProgress): void;
    /** Ends the open job for a fallback and returns its begin request (main's native export runs it). */
    release(jobId: string): Promise<{ options: GpuJobBegin["options"]; snapshot: ControllerSnapshot }>;
    /** The fallback's outcome: the job follows main's export job, or fails with its refusal. */
    link(jobId: string, outcome: ExportCommandOutcome): void;
    /** A GPU job is open (main refuses its own exports meanwhile). */
    active(): boolean;
    /** The open job's id, or null. */
    current(): string | null;
    /** A job's state; null for ids this registry does not know (or no longer keeps). */
    status(jobId: string): GpuJobStatus | null;
    /** Resolves once the job finished or a native export took over. */
    settled(jobId: string): Promise<GpuJobStatus | null>;
    /** The last job and its state (the export view), until reset(). */
    latest(): { jobId: string; state: GpuJobStatus["state"] } | null;
    /** Forgets the last job for the export view (no-op while it runs). */
    reset(): void;
    /** Every state change, with the job's id (null after reset). Returns unsubscribe. */
    subscribe(listener: (state: ExportSessionState, jobId: string | null) => void): () => void;
    /** Ends every job (window closed, reloaded, crashed, app quit); `reason` becomes the job's error. */
    abortAll(reason?: string): Promise<void>;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const errorCode = (error: unknown): GpuJobError["code"] => {
    const code = (error as { code?: unknown } | null)?.code;
    return (EXPORT_ERROR_CODES as readonly unknown[]).includes(code) ? (code as GpuJobError["code"]) : "unknown";
};
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_GPU_ERROR_MESSAGE);

function dedupe(warnings: ExportWarning[]): ExportWarning[] {
    const seen = new Set<string>();
    return warnings.filter((warning) => {
        const key = JSON.stringify(warning);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function createGpuJobs(options: GpuJobsOptions): GpuJobs {
    let job: Job | null = null;
    // Claimed synchronously by begin() before its first await, so two quick begins cannot both open a job.
    let claiming = false;
    const records = new Map<string, JobRecord>();
    let latest: string | null = null;
    const listeners = new Set<(state: ExportSessionState, jobId: string | null) => void>();
    const emit = (state: ExportSessionState, jobId: string | null) => {
        for (const listener of [...listeners]) {
            try {
                listener(state, jobId);
            } catch {
                // a listener's failure never stops the export
            }
        }
    };
    const record = (id: string, request: JobRecord["request"]) => {
        let resolve: () => void = () => undefined;
        const settled = new Promise<void>((done) => {
            resolve = done;
        });
        // Only the newest job keeps its snapshot (for a fallback); older ones have ended.
        for (const other of records.values()) other.request = null;
        records.set(id, { state: { status: "running", progress: { phase: "probe", ratio: 0, engine: "gpu" } }, fallback: null, settled, resolve, request });
        while (records.size > MAX_GPU_JOB_RECORDS) records.delete(records.keys().next().value!);
        latest = id;
        emit(records.get(id)!.state, id);
    };
    /** Moves a running job to `state`; returns false when it had already settled. */
    const setState = (id: string, state: GpuJobStatus["state"]) => {
        const entry = records.get(id);
        if (!entry || entry.state.status !== "running" || entry.fallback) return false;
        entry.state = state;
        if (state.status !== "running") {
            entry.request = null;
            entry.resolve();
        }
        if (latest === id) emit(state, id);
        return true;
    };
    const snapshotOf = (entry: JobRecord): GpuJobStatus => ({ state: entry.state, fallback: entry.fallback });

    const end = async (current: Job) => {
        if (job === current) job = null;
        current.abort.abort();
        await current.writes.catch(() => undefined);
        if (current.fd !== null) {
            const fd = current.fd;
            current.fd = null;
            await new Promise<void>((resolve) => fs.close(fd, () => resolve()));
        }
        await fs.promises.rm(current.dir, { recursive: true, force: true }).catch(() => undefined);
    };
    const find = (jobId: string): Job => {
        if (!job || job.id !== jobId) throw new Error("No such export job");
        return job;
    };

    async function open(request: GpuJobBegin): Promise<{ jobId: string }> {
        const resolution = request.options.resolution ?? "1080p";
        const dir = await fs.promises.mkdtemp(path.join(options.tempDir ?? os.tmpdir(), "opennan-gpu-"));
        const file = path.join(dir, `video.${request.container}`);
        const fd = fs.openSync(file, "w+");
        const snapshot = request.snapshot;
        const input: ExportInput = {
            project: {
                aspectRatio: snapshot.project?.aspectRatio ?? "16:9",
                musicUrl: snapshot.project?.musicUrl ?? null,
                musicVolume: snapshot.project?.musicVolume ?? 1,
            },
            tracks: snapshot.tracks,
            clips: snapshot.clips,
            scenes: snapshot.scenes,
            effects: options.effects ? await options.effects().catch(() => []) : [],
        };
        options.setTarget(snapshot.project?.name);
        const id = randomUUID();
        job = {
            writes: Promise.resolve(), id, dir, file, fd, bytes: 0, input, resolution, format: request.options.format === "gif" ? "gif" : "video",
            container: request.container, codec: request.codec, abort: new AbortController(), muxing: false,
        };
        record(id, { options: request.options, snapshot });
        return { jobId: id };
    }

    return {
        async begin(request) {
            if (!options.runner?.mux) return { error: "Export needs the bundled ffmpeg, which is missing from this build." };
            if (request.options.format === "gif" && !options.runner.gif) return { error: "This build's export cannot make GIFs." };
            if (job || claiming || options.mainBusy()) return { error: EXPORT_BUSY };
            claiming = true;
            try {
                return await open(request);
            } finally {
                claiming = false;
            }
        },

        async chunk(jobId, position, bytes) {
            const current = find(jobId);
            if (current.fd === null || current.muxing) throw new Error("This export job takes no more video");
            const last = position + bytes.byteLength;
            if (!Number.isSafeInteger(position) || position < 0 || last > MAX_GPU_VIDEO_BYTES) throw new Error("The video is too large");
            const write = current.writes.then(() => new Promise<void>((resolve, reject) => {
                // Checked again in order: the job may have ended (and its descriptor closed) while this write waited.
                if (current.fd === null || current.abort.signal.aborted) return reject(new Error("This export job takes no more video"));
                fs.write(current.fd, bytes, 0, bytes.byteLength, position, (error) => (error ? reject(error) : resolve()));
            }));
            current.writes = write.catch(() => undefined);
            await write;
            current.bytes = Math.max(current.bytes, last);
        },

        async mux(jobId) {
            const current = find(jobId);
            if (current.muxing) throw new Error("This export job is already finishing");
            current.muxing = true;
            try {
                await current.writes;
                if (current.fd !== null) {
                    const fd = current.fd;
                    current.fd = null;
                    await new Promise<void>((resolve) => fs.close(fd, () => resolve()));
                }
                if (current.bytes === 0) throw new Error("The editor sent no video");
                const runner = options.runner!;
                setState(current.id, { status: "running", progress: { phase: current.format === "gif" ? "gif" : "mux", ratio: 0, engine: "gpu" } });
                const video = { kind: "file" as const, path: current.file };
                const onProgress = (ratio: number) => {
                    if (!current.abort.signal.aborted) setState(current.id, { status: "running", progress: { phase: current.format === "gif" ? "gif" : "mux", ratio: clamp(ratio, 0, 1), engine: "gpu" } });
                };
                const gif = current.format === "gif";
                // A GIF has no audio: the frame size, rate, and length come from the job's own snapshot (no media read).
                const media = gif ? new Map() : await runner.probe(collectMediaUrls(current.input), current.abort.signal);
                const plan = compileMux(current.input, gif ? { resolution: current.resolution, format: "gif" } : { resolution: current.resolution }, { media });
                const output = gif
                    ? await runner.gif!({ format: plan.format, durationSeconds: plan.durationSeconds }, video, { container: current.container, signal: current.abort.signal, onProgress })
                    : await runner.mux!(plan, video, { container: current.container, signal: current.abort.signal, onProgress });
                if (output.kind !== "file") throw new Error("The desktop export writes files");
                // The result agents read: main's own path and facts (the codec name is the window's enum).
                const codecName = current.codec ? `webcodecs-${current.codec}` : "webcodecs";
                const result: ExportResult = {
                    output: { kind: "file", path: output.path },
                    container: gif ? "gif" : current.container,
                    mimeType: containerMimeType(gif ? "gif" : current.container),
                    encoder: gif ? `gif (${codecName})` : codecName,
                    durationSeconds: plan.durationSeconds,
                    width: plan.format.width,
                    height: plan.format.height,
                    // A GIF has no audio: its plan's audio warnings (media it never read) do not apply.
                    warnings: dedupe([...staticExportWarnings(current.input, { gl: true, nativeSpeed: true }), ...(gif ? [] : plan.warnings)]),
                    engine: "gpu",
                };
                setState(current.id, { status: "done", result });
                return { path: output.path };
            } catch (error) {
                // A cancel already settled the job as cancelled.
                setState(current.id, { status: "error", code: errorCode(error), message: errorMessage(error) });
                throw error;
            } finally {
                await end(current);
            }
        },

        async abort(jobId, error) {
            if (!job || job.id !== jobId) return;
            const current = job;
            setState(jobId, error ? { status: "error", code: error.code, message: error.message.slice(0, MAX_GPU_ERROR_MESSAGE) } : { status: "cancelled" });
            await end(current);
        },

        progress(jobId, progress) {
            if (!job || job.id !== jobId || job.muxing) return;
            const eta = progress.etaSeconds === undefined || !Number.isFinite(progress.etaSeconds) ? undefined : clamp(progress.etaSeconds, 0, MAX_GPU_ETA_SECONDS);
            const next: ExportProgress = {
                phase: progress.phase,
                ratio: Number.isFinite(progress.ratio) ? clamp(progress.ratio, 0, 1) : 0,
                ...(eta === undefined ? {} : { etaSeconds: eta }),
                engine: "gpu",
            };
            setState(jobId, { status: "running", progress: next });
        },

        async release(jobId) {
            const current = find(jobId);
            const entry = records.get(jobId);
            if (current.muxing || !entry?.request) throw new Error("This export job is already finishing");
            const request = entry.request;
            entry.request = null;
            await end(current);
            return request;
        },

        link(jobId, outcome) {
            const entry = records.get(jobId);
            if (!entry || entry.state.status !== "running" || entry.fallback) return;
            if ("jobId" in outcome && outcome.jobId) {
                entry.fallback = outcome.jobId;
                entry.resolve();
                return;
            }
            setState(jobId, { status: "error", code: "unknown", message: errorMessage("error" in outcome ? outcome.error : "The export did not start.") });
        },

        active: () => job !== null,
        current: () => job?.id ?? null,

        status(jobId) {
            const entry = records.get(jobId);
            return entry ? snapshotOf(entry) : null;
        },

        async settled(jobId) {
            const entry = records.get(jobId);
            if (!entry) return null;
            await entry.settled;
            return snapshotOf(entry);
        },

        latest() {
            const entry = latest ? records.get(latest) : undefined;
            return latest && entry && !entry.fallback ? { jobId: latest, state: entry.state } : null;
        },

        reset() {
            const entry = latest ? records.get(latest) : undefined;
            if (entry && entry.state.status === "running" && !entry.fallback) return;
            latest = null;
            emit({ status: "idle" }, null);
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        async abortAll(reason = "The editor window closed during the export.") {
            if (!job) return;
            const current = job;
            setState(current.id, { status: "error", code: "unknown", message: reason });
            await end(current);
        },
    };
}

/** Removes job folders (opennan-gpu-*) that a crash or a quit during an export left in `tempDir`. */
export async function sweepGpuTemp(tempDir: string = os.tmpdir(), olderThanMs = 60 * 60 * 1000, now = Date.now()): Promise<number> {
    let removed = 0;
    const names = await fs.promises.readdir(tempDir).catch(() => [] as string[]);
    for (const name of names) {
        if (!name.startsWith("opennan-gpu-")) continue;
        const dir = path.join(tempDir, name);
        const stat = await fs.promises.stat(dir).catch(() => null);
        if (!stat?.isDirectory() || now - stat.mtimeMs < olderThanMs) continue;
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        removed += 1;
    }
    return removed;
}
