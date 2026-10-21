// mixTimelineAudio: probe → compileAudioMix → runner.renderAudio. The timeline's audio as a WAV file for
// transcription (provider-local's whisper.cpp reads 16 kHz mono PCM).
import { checkAborted } from "./abort";
import { collectMediaUrls } from "./compile";
import { compileAudioMix } from "./compile/audio-mix";
import type { ExportRunner } from "./runner";
import { ExportError, type ExportInput, type ExportWarning } from "./types";

export interface MixTimelineAudioOptions {
    runner: ExportRunner;
    outputPath: string;
    /** Default 16000. */
    sampleRate?: number;
    signal?: AbortSignal;
    /** 0..1 */
    onProgress?(ratio: number): void;
}

export interface MixTimelineAudioResult {
    durationSeconds: number;
    sourceCount: number;
    warnings: ExportWarning[];
}

export async function mixTimelineAudio(input: ExportInput, options: MixTimelineAudioOptions): Promise<MixTimelineAudioResult> {
    const { runner, signal } = options;
    if (!runner.renderAudio) throw new ExportError("runner-unsupported", "This export runner cannot render the timeline audio on its own.");
    const media = await runner.probe(collectMediaUrls(input), signal);
    checkAborted(signal);
    const plan = compileAudioMix(input, { media });
    await runner.renderAudio(plan, options.outputPath, { sampleRate: options.sampleRate, signal, onProgress: options.onProgress });
    checkAborted(signal);
    return { durationSeconds: plan.durationSeconds, sourceCount: plan.sourceCount, warnings: plan.warnings };
}
