// The "local" provider (spec §5.9): audio.transcribe on this computer with whisper.cpp. Three phases on one
// progress scale: the model (downloaded and verified on first use), the audio (prepared by the host, e.g. the
// desktop app's timeline mix), and the transcription.
import os from "node:os";
import {
    JobCancelledError, createJob, type AudioInput, type Provider, type ProviderModel, type TranscribeRequest, type Transcript,
} from "@opennan/provider-sdk";
import { loadWhisperBinary, type WhisperBinary } from "./binary";
import type { ModelStore } from "./model-store";
import { DEFAULT_WHISPER_MODEL, findWhisperModel } from "./models";
import { runWhisper } from "./whisper-runner";

export const LOCAL_PROVIDER_ID = "local";
export const LOCAL_PROVIDER_NAME = "On this device";

export interface PreparedAudio {
    /** Absolute path of a 16 kHz mono PCM WAV file. */
    wavPath: string;
    durationSeconds?: number;
    cleanup?(): Promise<void>;
}

export interface LocalProviderOptions {
    /** The whisper binary folder; null leaves audio.transcribe out (whisperUnavailableReason says why). */
    whisperDir: string | null;
    whisperUnavailableReason?: string;
    models: ModelStore;
    /**
     * Makes the 16 kHz mono WAV: the timeline mix, or a media file's source range (AudioInput media with
     * startSeconds / endSeconds, phase 11; the desktop app trims it in main).
     */
    prepareAudio(audio: AudioInput, options: { signal: AbortSignal; onProgress(ratio: number): void }): Promise<PreparedAudio>;
    /** Default: available cores - 1, between 1 and 8. */
    threads?: number;
    run?: typeof runWhisper;
    loadBinary?: typeof loadWhisperBinary;
}

const MB = 1024 * 1024;

/** A stuck whisper run ends: 15 minutes, or 6 s per second of audio for long timelines (CPU-only machines). */
export function whisperTimeoutMs(durationSeconds: number | undefined): number {
    return Math.max(15 * 60_000, Math.ceil((durationSeconds ?? 0) * 6000));
}

export function defaultThreads(): number {
    const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(8, cores - 1));
}

export function createLocalProvider(options: LocalProviderOptions): Provider {
    const run = options.run ?? runWhisper;
    const loadBinary = options.loadBinary ?? loadWhisperBinary;
    let binary: Promise<WhisperBinary> | null = null;
    const whisper = () => {
        if (!options.whisperDir) throw new Error(options.whisperUnavailableReason ?? "whisper.cpp is not available in this build");
        binary ??= loadBinary(options.whisperDir).catch((error) => {
            binary = null;
            throw error;
        });
        return binary;
    };

    function transcribe(request: TranscribeRequest) {
        return createJob<Transcript>(async ({ signal, report }) => {
            const modelId = request.model ?? DEFAULT_WHISPER_MODEL;
            const model = findWhisperModel(modelId);
            if (!model) throw new Error(`Unknown model: ${String(modelId).slice(0, 64)}`);
            const cancelled = () => {
                if (signal.aborted) throw new JobCancelledError();
            };
            report(0, `Checking the ${model.label.split(" ")[0]} model`);
            const modelPath = await options.models.ensure(model.id, {
                signal,
                onDownload: ({ received, total }) => report((received / total) * 0.3, `Downloading the ${model.label.split(" ")[0]} model (${Math.round(model.sizeBytes / MB)} MB)`),
            });
            cancelled();
            const exe = await whisper();
            cancelled();
            report(0.3, "Preparing audio");
            const audio = await options.prepareAudio(request.audio, { signal, onProgress: (ratio) => report(0.3 + ratio * 0.1, "Preparing audio") });
            try {
                cancelled();
                report(0.4, "Transcribing");
                const transcript = await run({
                    binary: exe, modelPath, wavPath: audio.wavPath, language: request.language ?? "auto", threads: options.threads ?? defaultThreads(),
                    signal, onProgress: (ratio) => report(0.4 + ratio * 0.6, "Transcribing"), timeoutMs: whisperTimeoutMs(audio.durationSeconds),
                });
                return { ...transcript, model: model.id, ...(audio.durationSeconds === undefined ? {} : { durationSeconds: audio.durationSeconds }) };
            } finally {
                await audio.cleanup?.().catch(() => undefined);
            }
        });
    }

    const capabilities: Provider["info"]["capabilities"] = options.whisperDir ? ["audio.transcribe"] : [];
    return {
        // On this device: wins the default route of on-device-first capabilities (audio.transcribe) over OpenNan cloud.
        info: { id: LOCAL_PROVIDER_ID, name: LOCAL_PROVIDER_NAME, capabilities, onDevice: true },
        audio: {
            transcribe,
            async models(): Promise<ProviderModel[]> {
                return (await options.models.list()).map((m) => ({ id: m.id, label: m.label, sizeBytes: m.sizeBytes, installed: m.installed, default: m.default }));
            },
        },
    };
}
