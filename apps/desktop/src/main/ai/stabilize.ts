// Stabilize on this device (phase 11, Decision 7): ffmpeg's built-in deshake filter (LGPL; vid.stab is GPL and the
// bundled build has none) over a clip's used range of imported media, re-encoded with the working encoder and the
// audio kept, written to a temp folder, then imported into the media library. Progress comes from -progress pipe:1;
// cancel kills ffmpeg. One job at a time; the editor places the result with the stack-video placement.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gplFiltersIn, parseProgressSeconds, progressRatio } from "@opennan/export";
import { runProcess } from "@opennan/export/node";
import { JobCancelledError, createJob, type Job, type MediaSourceRef } from "@opennan/provider-sdk";
import type { AiJobEvent, ImportedOutputMedia, PixelSize } from "../../shared/bridge";
import { localMediaId } from "../../shared/media-policy";
import type { FfmpegPaths } from "../export/ffmpeg-paths";
import type { MediaStore } from "../store/media-store";
import { FFMPEG_MISSING_FOR_AI, MEDIA_SOURCE_REFUSED, preparedRange, videoArgs, videoFilterGraph, type DesktopMediaPreparer } from "./prepare-media";

export const STABILIZE_BUSY = "A stabilize is already running. Wait for it or cancel it first.";
/** ffmpeg's single-pass stabilizer, built in and LGPL. */
export const STABILIZE_FILTERS = ["deshake"] as const;

export interface StabilizeServiceOptions {
    ffmpeg: FfmpegPaths | null;
    mediaStore: Pick<MediaStore, "importPath"> & Partial<Pick<MediaStore, "info">>;
    preparer: Pick<DesktopMediaPreparer, "resolveSource" | "inputGuards" | "mediaDuration" | "mediaInfo" | "encoder">;
    /** Tests: replace the ffmpeg process. */
    run?: typeof runProcess;
    tempDir?: string;
}

export interface StabilizeInput {
    projectId: string;
    source: MediaSourceRef;
}

/** The imported video and the source's pixel size (deshake keeps it; the stack keeps the source's on-screen size). */
interface StabilizeResult {
    media: ImportedOutputMedia;
    sourceSize?: PixelSize;
}

export interface StabilizeService {
    status(): { available: boolean; reason: string | null };
    start(input: StabilizeInput): Promise<{ jobId: string }>;
    cancel(jobId: string): Promise<void>;
    cancelAll(): Promise<void>;
    subscribe(listener: (event: AiJobEvent) => void): () => void;
}

/** The deshake graph for `encoder`, refused if it ever names a GPL-only filter. */
export function stabilizeGraph(encoder: Parameters<typeof videoFilterGraph>[1]): string {
    const graph = videoFilterGraph([...STABILIZE_FILTERS], encoder);
    const gpl = gplFiltersIn(graph);
    if (gpl.length > 0) throw new Error(`The stabilize graph uses GPL filters (${gpl.join(", ")}).`);
    return graph;
}

/** "Beach walk.mov" → "Beach walk (stabilized).mp4": a plain file name, at most 80 characters before the extension. */
export function stabilizedName(original: string | null | undefined, ext: string): string {
    const base = (original ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\\/:*?"<>|\0-\x1f]+/g, "-").trim().slice(0, 80).trim();
    return `${base || "clip"} (stabilized)${ext}`;
}

export function createStabilizeService(options: StabilizeServiceOptions): StabilizeService {
    const run = options.run ?? runProcess;
    const listeners = new Set<(event: AiJobEvent) => void>();
    let current: { job: Job<StabilizeResult>; finished: Promise<void>; cancelling: boolean } | null = null;
    const emit = (event: AiJobEvent) => {
        for (const listener of [...listeners]) listener(event);
    };
    const reason = options.ffmpeg ? null : FFMPEG_MISSING_FOR_AI;

    async function stabilize(input: StabilizeInput, signal: AbortSignal, report: (progress: number | null, message?: string) => void): Promise<StabilizeResult> {
        const ffmpeg = options.ffmpeg!;
        const id = localMediaId(input.source.mediaUrl);
        if (!id) throw new Error(MEDIA_SOURCE_REFUSED);
        const file = await options.preparer.resolveSource(input.source.mediaUrl);
        report(0, "Stabilizing");
        const info = await options.preparer.mediaInfo(file, signal);
        const range = preparedRange(input.source, input.source.endSeconds === undefined && info && info.durationSeconds > 0 ? info.durationSeconds : null);
        const sourceSize = info && info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null;
        const encoder = await options.preparer.encoder();
        const graph = stabilizeGraph(encoder);
        const ext = encoder.container === "webm" ? ".webm" : ".mp4";
        const dir = await mkdtemp(path.join(options.tempDir ?? tmpdir(), "opennan-stabilize-"));
        try {
            const output = path.join(dir, stabilizedName(options.mediaStore.info?.(id)?.originalName, ext));
            const args = videoArgs({ input: file, inputGuards: options.preparer.inputGuards, range, encoder, keepAudio: true, output, filters: [...STABILIZE_FILTERS], progress: true });
            if (args[args.indexOf("-vf") + 1] !== graph) throw new Error("The stabilize graph changed.");
            const total = range.durationSeconds ?? 0;
            const result = await run(ffmpeg.ffmpegPath, args, {
                signal,
                onStdoutLine: (line) => {
                    const done = parseProgressSeconds(line);
                    if (done !== null && total > 0) report(progressRatio(done, total) * 0.95, "Stabilizing");
                },
            }).catch((error: unknown) => {
                if (signal.aborted) throw new JobCancelledError();
                throw error;
            });
            if (signal.aborted) throw new JobCancelledError();
            if (result.code !== 0) throw new Error("ffmpeg could not stabilize this clip.");
            report(0.97, "Adding to Media");
            const measured = await options.preparer.mediaDuration(output, signal);
            const stored = await options.mediaStore.importPath({ projectId: input.projectId, path: output, kind: "video" });
            const durationSeconds = Math.max(measured ?? 0, stored.durationSeconds ?? 0, range.durationSeconds ?? 0);
            const media: ImportedOutputMedia = {
                kind: "video", url: stored.url, name: stored.name, mimeType: stored.mimeType, sizeBytes: stored.size,
                ...(durationSeconds > 0 ? { durationSeconds } : {}),
                ...(stored.width && stored.height ? { width: stored.width, height: stored.height } : {}),
            };
            return sourceSize ? { media, sourceSize } : { media };
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    return {
        status: () => ({ available: reason === null, reason }),
        async start(input) {
            if (reason) throw new Error(reason);
            if (!localMediaId(input.source.mediaUrl)) throw new Error(MEDIA_SOURCE_REFUSED);
            if (current) {
                if (!current.cancelling) throw new Error(STABILIZE_BUSY);
                await current.finished;
                if (current) throw new Error(STABILIZE_BUSY);
            }
            const job = createJob<StabilizeResult>(({ signal, report }) => stabilize(input, signal, report));
            const entry = { job, finished: job.finished(), cancelling: false };
            current = entry;
            const stop = job.subscribe((update) => {
                if (update.status === "succeeded" || update.status === "failed" || update.status === "cancelled") return;
                emit({ jobId: job.id, ...update });
            });
            void job.result().then(
                (result) => emit({ jobId: job.id, status: "succeeded", progress: 1, output: { media: [result.media], ...(result.sourceSize ? { sourceSize: result.sourceSize } : {}) } }),
                (error: unknown) => emit(error instanceof JobCancelledError
                    ? { jobId: job.id, status: "cancelled" }
                    : { jobId: job.id, status: "failed", error: error instanceof Error ? error.message : String(error) }),
            ).finally(() => stop());
            void entry.finished.then(() => {
                if (current === entry) current = null;
            });
            return { jobId: job.id };
        },
        async cancel(jobId) {
            if (current?.job.id !== jobId) return;
            current.cancelling = true;
            await current.job.cancel();
        },
        /** Cancels the running job and waits until ffmpeg exited and its temp folder is gone (app quit, tests). */
        async cancelAll() {
            if (!current) return;
            const entry = current;
            entry.cancelling = true;
            await entry.job.cancel();
            await entry.finished;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
