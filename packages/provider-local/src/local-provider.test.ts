import { JobCancelledError, JobFailedError, ProviderRegistry, providerContractCases, type JobUpdate, type Transcript } from "@opennan/provider-sdk";
import type { WhisperBinary } from "./binary";
import { createLocalProvider, whisperTimeoutMs, type LocalProviderOptions } from "./local-provider";
import type { ModelStore } from "./model-store";
import { WHISPER_MODELS } from "./models";

const TRANSCRIPT: Transcript = { language: "en", segments: [{ start: 0, end: 1, text: "hello" }] };
const BINARY: WhisperBinary = { dir: "/w", path: "/w/whisper-cli", files: {} };

function setup(overrides: Partial<LocalProviderOptions> = {}, behavior: { download?: boolean; hangIn?: "model" | "audio" | "run" } = {}) {
    const calls: string[] = [];
    const cleanup = vi.fn(async () => undefined);
    const hang = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new JobCancelledError()), { once: true }));
    const models: ModelStore = {
        dir: "/models",
        list: async () => WHISPER_MODELS.map((m) => ({ ...m, installed: m.id === "tiny", default: m.id === "base" })),
        ensure: async (id, options) => {
            calls.push(`ensure:${id}`);
            if (behavior.hangIn === "model") return hang(options!.signal!);
            if (behavior.download) options?.onDownload?.({ received: 50, total: 100 });
            return `/models/ggml-${id}.bin`;
        },
    };
    const options: LocalProviderOptions = {
        whisperDir: "/w",
        models,
        threads: 3,
        loadBinary: async () => BINARY,
        prepareAudio: async (audio, { signal, onProgress }) => {
            calls.push(`prepare:${audio.kind}`);
            if (behavior.hangIn === "audio") return hang(signal);
            onProgress(1);
            return { wavPath: "/tmp/mix.wav", durationSeconds: 10.5, cleanup };
        },
        run: async (runOptions) => {
            calls.push(`run:${runOptions.modelPath}:${runOptions.language}:${runOptions.threads}`);
            calls.push(`timeout:${runOptions.timeoutMs}`);
            if (behavior.hangIn === "run") return hang(runOptions.signal!);
            runOptions.onProgress?.(0.5);
            return TRANSCRIPT;
        },
        ...overrides,
    };
    return { provider: createLocalProvider(options), calls, cleanup };
}

const AUDIO = { kind: "timeline", snapshot: {} } as const;
const updates = (job: { subscribe?(l: (u: JobUpdate) => void): () => void }) => {
    const seen: JobUpdate[] = [];
    job.subscribe?.((u) => seen.push(u));
    return seen;
};

describe("createLocalProvider", () => {
    it("declares audio.transcribe as provider id local", () => {
        const { provider } = setup();
        expect(provider.info).toEqual({ id: "local", name: "On this device", capabilities: ["audio.transcribe"], onDevice: true });
        const registry = new ProviderRegistry();
        registry.register(provider);
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
    });

    it("runs model, audio, and whisper phases on one progress scale", async () => {
        const { provider, calls, cleanup } = setup({}, { download: true });
        const job = provider.audio!.transcribe!({ audio: AUDIO, language: "en", model: "tiny" });
        const seen = updates(job);
        expect(await job.result()).toEqual({ ...TRANSCRIPT, model: "tiny", durationSeconds: 10.5 });
        expect(calls).toEqual(["ensure:tiny", "prepare:timeline", "run:/models/ggml-tiny.bin:en:3", `timeout:${15 * 60_000}`]);
        expect(cleanup).toHaveBeenCalledTimes(1);
        const running = seen.filter((u) => u.status === "running");
        expect(new Set(running.map((u) => u.message))).toEqual(new Set([undefined, "Checking the Tiny model", "Downloading the Tiny model (74 MB)", "Preparing audio", "Transcribing"]));
        const progress = running.map((u) => u.progress ?? 0);
        expect(progress).toEqual([...progress].sort((a, b) => a - b));
        expect(progress).toContain(0.15);
        expect(progress).toContain(0.7);
    });

    it("uses the default model and auto language", async () => {
        const { provider, calls } = setup();
        await provider.audio!.transcribe!({ audio: AUDIO }).result();
        expect(calls).toContain("run:/models/ggml-base.bin:auto:3");
    });

    it.each(["model", "audio", "run"] as const)("cancels during the %s phase and cleans up", async (phase) => {
        const { provider, cleanup } = setup({}, { hangIn: phase });
        const job = provider.audio!.transcribe!({ audio: AUDIO });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await job.cancel();
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(cleanup).toHaveBeenCalledTimes(phase === "run" ? 1 : 0);
    });

    it("fails with the cause for bad audio, an unknown model, or a missing binary", async () => {
        const audio = setup({ prepareAudio: async () => { throw new Error("The timeline has no audio to transcribe."); } });
        await expect(audio.provider.audio!.transcribe!({ audio: AUDIO }).result()).rejects.toThrow("The timeline has no audio to transcribe.");
        const unknown = setup();
        await expect(unknown.provider.audio!.transcribe!({ audio: AUDIO, model: "huge" }).result()).rejects.toThrow(/Unknown model/);
        const broken = setup({ loadBinary: async () => { throw new Error("whisper-cli does not match its checksum"); } });
        await expect(broken.provider.audio!.transcribe!({ audio: AUDIO }).result()).rejects.toBeInstanceOf(JobFailedError);
    });

    it("declares nothing without a whisper folder and explains why", async () => {
        const { provider } = setup({ whisperDir: null, whisperUnavailableReason: "No whisper.cpp for win32-arm64" });
        expect(provider.info.capabilities).toEqual([]);
        await expect(provider.audio!.transcribe!({ audio: AUDIO }).result()).rejects.toThrow("No whisper.cpp for win32-arm64");
    });

    it("lists models with installed and default marks", async () => {
        const { provider } = setup();
        expect(await provider.audio!.models!("audio.transcribe")).toEqual([
            { id: "tiny", label: "Tiny (fastest)", sizeBytes: 77_691_713, installed: true, default: false },
            { id: "base", label: "Base", sizeBytes: 147_951_465, installed: false, default: true },
            { id: "small", label: "Small (most accurate)", sizeBytes: 487_601_967, installed: false, default: false },
        ]);
    });

    it("passes the shared Provider contract", async () => {
        const { provider } = setup({}, { hangIn: "run" });
        for (const c of providerContractCases(provider)) await c.run();
    });

    it("bounds a whisper run by the audio length", () => {
        expect(whisperTimeoutMs(undefined)).toBe(15 * 60_000);
        expect(whisperTimeoutMs(60)).toBe(15 * 60_000);
        expect(whisperTimeoutMs(3600)).toBe(6 * 3600 * 1000);
    });
});

describe("createLocalProvider phase 11", () => {
    it("hands a media range to the host's prepareAudio as is", async () => {
        const seen: unknown[] = [];
        const { provider } = setup({
            prepareAudio: async (audio) => {
                seen.push(audio);
                return { wavPath: "/tmp/range.wav", durationSeconds: 3 };
            },
        });
        await provider.audio!.transcribe!({ audio: { kind: "media", url: "opennan-local://media/a", startSeconds: 4, endSeconds: 7 } }).result();
        expect(seen).toEqual([{ kind: "media", url: "opennan-local://media/a", startSeconds: 4, endSeconds: 7 }]);
    });

    it("wins the default transcription route over OpenNan as an on-device provider", () => {
        const { provider } = setup();
        const registry = new ProviderRegistry();
        registry.register({ info: { id: "opennan", name: "OpenNan", capabilities: ["audio.transcribe"] } });
        registry.register(provider);
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
        expect(registry.providerFor("audio.transcribe", { onDevice: true })?.info.id).toBe("local");
    });
});
