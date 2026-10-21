import { createAiRunner, type AiRunProgressLike } from "./ai-runner";
import { CapabilityUnavailableError, JobFailedError } from "./errors";
import { createJob } from "./job";
import { ProviderRegistry } from "./registry";
import type { TranscribeRequest, Transcript } from "./transcribe-types";
import type { Provider } from "./types";

const TRANSCRIPT: Transcript = {
    language: "en",
    segments: [
        { start: 0, end: 2, text: " Hello there" },
        { start: 2, end: 4, text: " general Kenobi" },
    ],
};

function fakeProvider(run: (request: TranscribeRequest, context: { signal: AbortSignal; report(p: number | null, m?: string): void }) => Promise<Transcript>) {
    const requests: TranscribeRequest[] = [];
    const provider: Provider = {
        info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"] },
        audio: {
            transcribe(request) {
                requests.push(request);
                return createJob((context) => run(request, context), { id: "job-test" });
            },
        },
    };
    return { provider, requests };
}

const SNAPSHOT = { projectId: "p1", tracks: [], clips: [], scenes: [] };

describe("createAiRunner (ai.run through the ProviderRegistry)", () => {
    it("answers unavailable with the §5.4 guidance when nothing is routed", async () => {
        const run = createAiRunner(new ProviderRegistry());
        expect(await run({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT })).toEqual({
            unavailable: true,
            error: "ai.run requires a provider with the audio.transcribe capability. Connect OpenNan or another provider that offers it.",
        });
        expect(await run({ capability: "opennan.qc", input: {} }, { snapshot: SNAPSHOT })).toMatchObject({ unavailable: true, error: "Connect OpenNan to use ai.run." });
    });

    it("refuses unknown capabilities and providers without run()", async () => {
        const registry = new ProviderRegistry();
        registry.register({ info: { id: "fal", name: "fal", capabilities: ["image.generate"] } });
        const run = createAiRunner(registry);
        expect(await run({ capability: "audio.anything", input: {} }, { snapshot: SNAPSHOT })).toEqual({ error: "Unknown capability: audio.anything" });
        expect(await run({ capability: "image.generate", input: {} }, { snapshot: SNAPSHOT })).toEqual({ error: 'Provider "fal" declares image.generate but has no run method.' });
    });

    it("runs audio.transcribe on the timeline, forwards progress, and returns the transcript", async () => {
        const { provider, requests } = fakeProvider(async (_request, { report }) => {
            report(0.5, "Transcribing");
            return TRANSCRIPT;
        });
        const registry = new ProviderRegistry();
        registry.register(provider);
        const progress: AiRunProgressLike[] = [];
        const outcome = await createAiRunner(registry)(
            { capability: "audio.transcribe", input: { language: "en", model: "tiny" } },
            { snapshot: SNAPSHOT, onProgress: (p) => progress.push(p) },
        );
        expect(requests).toEqual([{ audio: { kind: "timeline", snapshot: SNAPSHOT }, language: "en", model: "tiny" }]);
        expect(outcome).toEqual({ jobId: "job-test", output: TRANSCRIPT });
        expect(progress).toContainEqual({ jobId: "job-test", status: "running", progress: 0.5, message: "Transcribing" });
        expect(progress.at(-1)).toMatchObject({ jobId: "job-test", status: "succeeded" });
    });

    it("places caption cues when placeAt asks for a captions track", async () => {
        const { provider } = fakeProvider(async () => TRANSCRIPT);
        const registry = new ProviderRegistry();
        registry.register(provider);
        const outcome = await createAiRunner(registry)(
            { capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track", style: "subtitle" } },
            { snapshot: SNAPSHOT },
        );
        expect(outcome.placement).toEqual({
            kind: "captions-track",
            style: "subtitle",
            cues: [{ startTime: 0, endTime: 2, text: "Hello there" }, { startTime: 2, endTime: 4, text: "general Kenobi" }],
        });
        const defaulted = await createAiRunner(registry)({ capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track" } }, { snapshot: SNAPSHOT });
        expect(defaulted.placement).toMatchObject({ kind: "captions-track", style: "caption" });
    });

    it("keeps word timings on the placed caption cues", async () => {
        const words = [{ start: 0.1, end: 0.6, text: "Hello" }, { start: 0.7, end: 1.4, text: "there" }];
        const { provider } = fakeProvider(async () => ({ language: "en", segments: [{ start: 0, end: 1.5, text: " Hello there", words }] }));
        const registry = new ProviderRegistry();
        registry.register(provider);
        const outcome = await createAiRunner(registry)({ capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track" } }, { snapshot: SNAPSHOT });
        expect(outcome.placement).toEqual({ kind: "captions-track", style: "caption", cues: [{ startTime: 0, endTime: 1.5, text: "Hello there", words }] });
    });

    it("transcribes an imported media URL when the input names one", async () => {
        const { provider, requests } = fakeProvider(async () => TRANSCRIPT);
        const registry = new ProviderRegistry();
        registry.register(provider);
        await createAiRunner(registry)({ capability: "audio.transcribe", input: { source: { mediaUrl: "opennan-local://media/x" } } }, { snapshot: SNAPSHOT });
        expect(requests[0].audio).toEqual({ kind: "media", url: "opennan-local://media/x" });
    });

    it.each([
        [null, "input must be an object"],
        [{ language: "klingon" }, "language"],
        [{ language: 5 }, "language"],
        [{ model: "../../etc" }, "model"],
        [{ model: "x".repeat(65) }, "model"],
        [{ source: "elsewhere" }, "source"],
        [{ source: { mediaUrl: 3 } }, "source"],
        [{ extra: true }, "extra"],
    ])("refuses bad input %j", async (input, field) => {
        const { provider, requests } = fakeProvider(async () => TRANSCRIPT);
        const registry = new ProviderRegistry();
        registry.register(provider);
        const outcome = await createAiRunner(registry)({ capability: "audio.transcribe", input }, { snapshot: SNAPSHOT });
        expect(outcome.error).toMatch(new RegExp(`^ai\\.run audio\\.transcribe: .*${field}`));
        expect(requests).toEqual([]);
    });

    it("cancels the job when the signal aborts, also before start", async () => {
        let seen: AbortSignal | null = null;
        const { provider } = fakeProvider((_request, { signal }) => {
            seen = signal;
            return new Promise(() => undefined);
        });
        const registry = new ProviderRegistry();
        registry.register(provider);
        const abort = new AbortController();
        const pending = createAiRunner(registry)({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT, signal: abort.signal });
        await new Promise((resolve) => setTimeout(resolve, 0));
        abort.abort();
        expect(await pending).toEqual({ jobId: "job-test", cancelled: true });
        expect(seen!.aborted).toBe(true);

        const early = new AbortController();
        early.abort();
        expect(await createAiRunner(registry)({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT, signal: early.signal }))
            .toEqual({ jobId: "job-test", cancelled: true });
    });

    it("maps a failed job to its error and a provider's CapabilityUnavailableError to unavailable", async () => {
        const failing = fakeProvider(async () => {
            throw new JobFailedError("whisper.cpp failed (exit 1)");
        });
        const registry = new ProviderRegistry();
        registry.register(failing.provider);
        expect(await createAiRunner(registry)({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT }))
            .toEqual({ jobId: "job-test", error: "whisper.cpp failed (exit 1)" });

        const missing: Provider = {
            info: { id: "local", name: "x", capabilities: ["audio.transcribe"] },
            audio: { transcribe: () => { throw new CapabilityUnavailableError("audio.transcribe"); } },
        };
        const other = new ProviderRegistry();
        other.register(missing);
        expect(await createAiRunner(other)({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT })).toMatchObject({ unavailable: true });

        const noMethod = new ProviderRegistry();
        noMethod.register({ info: { id: "local", name: "x", capabilities: ["audio.transcribe"] } });
        expect(await createAiRunner(noMethod)({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT })).toMatchObject({ error: expect.stringMatching(/no transcribe method/) });
    });

    it("refuses to place more caption lines than the timeline takes", async () => {
        const many: Transcript = { language: "en", segments: Array.from({ length: 10_001 }, (_, i) => ({ start: i, end: i + 0.5, text: `line ${i}` })) };
        const { provider } = fakeProvider(async () => many);
        const registry = new ProviderRegistry();
        registry.register(provider);
        const outcome = await createAiRunner(registry)({ capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track" } }, { snapshot: SNAPSHOT });
        expect(outcome).toEqual({ jobId: "job-test", error: "The transcript has 10001 caption lines, more than the 10000 the timeline takes at once." });
    });
});
