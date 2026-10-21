// On-device transcription in main (spec §5.9): provider-local's whisper.cpp provider over the timeline's audio
// mix, rendered by the bundled LGPL ffmpeg from imported media only (the export runner's source policy), or over
// one imported media's range (phase 11: a clip's used range, trimmed by the media preparer). One job at a time;
// listeners get every job update and the final transcript or error.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mixTimelineAudio, type ExportRunner } from "@opennan/export";
import { createNodeRunner, type NodeRunnerOptions } from "@opennan/export/node";
import { createLocalProvider, createModelStore, type LocalProviderOptions } from "@opennan/provider-local";
import type { AudioInput, Job, MediaSourceRef, ProviderModel, Transcript } from "@opennan/provider-sdk";
import type { ControllerSnapshot } from "@opennan/timeline-core";
import type { AiJobEvent } from "../../shared/bridge";
import { SnapshotSchema } from "../../shared/ipc";
import { localMediaId } from "../../shared/media-policy";
import type { FfmpegPaths } from "../export/ffmpeg-paths";
import type { MediaStore } from "../store/media-store";
import { audioInputFromSnapshot, createDesktopMediaPreparer, type DesktopMediaPreparer } from "./prepare-media";

export { audioInputFromSnapshot } from "./prepare-media";

export const TRANSCRIPTION_BUSY = "A transcription is already running. Wait for it or cancel it first.";
export const FFMPEG_MISSING_FOR_CAPTIONS = "Auto captions need the bundled ffmpeg, which is missing from this build.";
export const MEDIA_INPUT_REFUSED = "Desktop transcribes the timeline audio or media imported into the project only.";
/** whisper reads the WAV from disk: no destination cap beyond what a WAV file can hold. */
const WHISPER_MAX_WAV_BYTES = 4 * 1024 ** 3 - 1;

export interface TranscriptionServiceOptions {
    whisperDir: string | null;
    /** Why whisper is unavailable (resolveWhisper). */
    reason: string | null;
    ffmpeg: FfmpegPaths | null;
    mediaStore: Pick<MediaStore, "pathOf" | "root">;
    modelsDir: string;
    fetch?: typeof fetch;
    /** Tests: replace the whisper run and the export runner. */
    run?: LocalProviderOptions["run"];
    loadBinary?: LocalProviderOptions["loadBinary"];
    createRunner?(options: NodeRunnerOptions): ExportRunner;
    /** Trims a media range (default: one over `ffmpeg` and `mediaStore`). */
    preparer?: Pick<DesktopMediaPreparer, "prepareFile">;
}

/** The timeline's audio (`snapshot`) or one imported media's range (`source`). */
export type TranscribeInput = { language?: string; model?: string } & ({ snapshot: ControllerSnapshot; source?: undefined } | { source: MediaSourceRef; snapshot?: undefined });

export interface TranscriptionService {
    status(): { available: boolean; reason: string | null };
    models(): Promise<ProviderModel[]>;
    /** Refuses while a job runs; right after a cancel it waits for the old job's processes to stop. */
    start(input: TranscribeInput): Promise<{ jobId: string }>;
    cancel(jobId: string): Promise<void>;
    cancelAll(): Promise<void>;
    subscribe(listener: (event: AiJobEvent) => void): () => void;
}

export function createTranscriptionService(options: TranscriptionServiceOptions): TranscriptionService {
    const listeners = new Set<(event: AiJobEvent) => void>();
    let current: { job: Job<Transcript>; finished: Promise<void>; cancelling: boolean } | null = null;
    const emit = (event: AiJobEvent) => {
        for (const listener of [...listeners]) listener(event);
    };
    const models = createModelStore({ dir: options.modelsDir, fetch: options.fetch });
    const reason = !options.whisperDir ? options.reason ?? "whisper.cpp is not available" : !options.ffmpeg ? FFMPEG_MISSING_FOR_CAPTIONS : null;

    const preparer = options.preparer ?? createDesktopMediaPreparer({ ffmpeg: options.ffmpeg, mediaStore: options.mediaStore });

    async function prepareAudio(audio: AudioInput, { signal, onProgress }: { signal: AbortSignal; onProgress(ratio: number): void }) {
        if (!options.ffmpeg) throw new Error(FFMPEG_MISSING_FOR_CAPTIONS);
        if (audio.kind === "media") {
            if (!localMediaId(audio.url)) throw new Error(MEDIA_INPUT_REFUSED);
            const source: MediaSourceRef = { mediaUrl: audio.url };
            if (audio.startSeconds !== undefined) source.startSeconds = audio.startSeconds;
            if (audio.endSeconds !== undefined) source.endSeconds = audio.endSeconds;
            const prepared = await preparer.prepareFile({ kind: "media", source }, { output: "audio", sampleRate: 16_000, maxBytes: WHISPER_MAX_WAV_BYTES, contentTypes: ["audio/wav"] }, signal);
            onProgress(1);
            return { wavPath: prepared.path, ...(prepared.durationSeconds === undefined ? {} : { durationSeconds: prepared.durationSeconds }), cleanup: prepared.cleanup };
        }
        const parsed = SnapshotSchema.safeParse(audio.snapshot);
        if (!parsed.success) throw new Error("The timeline snapshot is not valid");
        const runnerOptions: NodeRunnerOptions = {
            ffmpegPath: options.ffmpeg.ffmpegPath,
            ffprobePath: options.ffmpeg.ffprobePath,
            mediaRoots: [options.mediaStore.root],
            resolveSource: (url) => {
                const id = localMediaId(url);
                return id ? options.mediaStore.pathOf(id) : null;
            },
            outputPath: () => {
                throw new Error("transcription renders audio only");
            },
        };
        const runner = (options.createRunner ?? createNodeRunner)(runnerOptions);
        const dir = await mkdtemp(path.join(tmpdir(), "opennan-captions-"));
        const cleanup = () => rm(dir, { recursive: true, force: true });
        try {
            const wavPath = path.join(dir, "mix.wav");
            const mixed = await mixTimelineAudio(audioInputFromSnapshot(parsed.data as unknown as ControllerSnapshot), { runner, outputPath: wavPath, signal, onProgress });
            return { wavPath, durationSeconds: mixed.durationSeconds, cleanup };
        } catch (error) {
            await cleanup();
            throw error;
        }
    }

    const provider = createLocalProvider({
        whisperDir: reason ? null : options.whisperDir,
        whisperUnavailableReason: reason ?? undefined,
        models,
        prepareAudio,
        run: options.run,
        loadBinary: options.loadBinary,
    });

    return {
        status: () => ({ available: reason === null, reason }),
        models: () => provider.audio!.models!("audio.transcribe"),
        async start(input) {
            if (reason) throw new Error(reason);
            if (current) {
                // "Cancelled" is reported at once, but whisper or ffmpeg may need a moment to exit: one job at a time
                // means waiting for that, not failing the next start.
                if (!current.cancelling) throw new Error(TRANSCRIPTION_BUSY);
                await current.finished;
                if (current) throw new Error(TRANSCRIPTION_BUSY);
            }
            const audio: AudioInput = input.source
                ? {
                    kind: "media", url: input.source.mediaUrl,
                    ...(input.source.startSeconds === undefined ? {} : { startSeconds: input.source.startSeconds }),
                    ...(input.source.endSeconds === undefined ? {} : { endSeconds: input.source.endSeconds }),
                }
                : { kind: "timeline", snapshot: input.snapshot };
            const job = provider.audio!.transcribe!({
                audio,
                ...(input.language === undefined ? {} : { language: input.language }),
                ...(input.model === undefined ? {} : { model: input.model }),
            });
            const finished = job.finished?.() ?? job.result().then(() => undefined, () => undefined);
            const entry = { job, finished, cancelling: false };
            current = entry;
            const stop = job.subscribe?.((update) => {
                if (update.status === "succeeded" || update.status === "failed" || update.status === "cancelled") return;
                emit({ jobId: job.id, ...update });
            });
            void job.result().then(
                (transcript) => emit({ jobId: job.id, status: "succeeded", progress: 1, transcript }),
                (error: unknown) => emit(error instanceof Error && error.name === "JobCancelledError"
                    ? { jobId: job.id, status: "cancelled" }
                    : { jobId: job.id, status: "failed", error: error instanceof Error ? error.message : String(error) }),
            ).finally(() => stop?.());
            void finished.then(() => {
                if (current === entry) current = null;
            });
            return { jobId: job.id };
        },
        async cancel(jobId) {
            if (current?.job.id !== jobId) return;
            current.cancelling = true;
            await current.job.cancel();
        },
        async cancelAll() {
            if (!current) return;
            const entry = current;
            entry.cancelling = true;
            await entry.job.cancel();
            // Quit runs this: wait for whisper/ffmpeg to exit and the temp folder to go, not just for the request.
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
