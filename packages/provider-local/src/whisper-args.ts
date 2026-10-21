// whisper-cli argv. Every value is its own element and the process is spawned without a shell, so nothing
// here is ever parsed by one; values are still validated (language from whisper's list, absolute paths).
import path from "node:path";
import { isTranscribeLanguage } from "@opennan/provider-sdk";

export interface WhisperArgsInput {
    modelPath: string;
    /** 16 kHz mono PCM WAV. */
    wavPath: string;
    /** whisper writes `${outputBase}.json` (-ojf: the -oj JSON plus per-token text and offsets, for word timings). */
    outputBase: string;
    /** "auto" (default) or a WHISPER_LANGUAGES code. */
    language?: string;
    /** Default 4, clamped to 1-16. */
    threads?: number;
    /** Longest segment in characters (caption-sized lines). Default 42, at least 8. */
    maxLen?: number;
    /** False adds -ng (CPU only). */
    gpu?: boolean;
}

export function checkAbsolutePath(value: string, what: string): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) throw new Error(`${what}: invalid path`);
    if (!path.isAbsolute(value)) throw new Error(`${what} must be an absolute path`);
    return value;
}

export function buildWhisperArgs(input: WhisperArgsInput): string[] {
    const model = checkAbsolutePath(input.modelPath, "model");
    const wav = checkAbsolutePath(input.wavPath, "audio");
    const out = checkAbsolutePath(input.outputBase, "output");
    if (out.endsWith(".json")) throw new Error("output base must not end in .json (whisper adds it)");
    const language = input.language ?? "auto";
    if (!isTranscribeLanguage(language)) throw new Error(`Unsupported language: ${String(language).slice(0, 20)}`);
    const threads = Number.isFinite(input.threads) ? Math.min(16, Math.max(1, Math.round(input.threads!))) : 4;
    const maxLen = Number.isFinite(input.maxLen) ? Math.max(8, Math.round(input.maxLen!)) : 42;
    return [
        "-m", model, "-f", wav, "-l", language, "-t", String(threads),
        "-ojf", "-of", out, "-ml", String(maxLen), "-sow", "-pp", "-np", "-sns",
        ...(input.gpu === false ? ["-ng"] : []),
    ];
}
