// ai.run for every capability besides audio.transcribe (phase 8): Provider.run, media imported through the host.
import { createAiRunner, type AiRunProgressLike } from "./ai-runner";
import type { CapabilityOutput, GeneratedMedia } from "./capability-output";
import { CapabilityUnavailableError } from "./errors";
import { createJob, type JobContext } from "./job";
import { ProviderRegistry } from "./registry";
import type { CapabilityRequest, Provider } from "./types";

const SNAPSHOT = { projectId: "p1", tracks: [], clips: [], scenes: [] };

function generator(run: (request: CapabilityRequest, context: JobContext) => Promise<CapabilityOutput>) {
    const requests: CapabilityRequest[] = [];
    const provider: Provider = {
        info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate", "audio.tts", "opennan.qc"] },
        run(request) {
            requests.push(request);
            return createJob((context) => run(request, context), { id: "job-gen" });
        },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    return { registry, requests };
}

describe("createAiRunner: generation through Provider.run", () => {
    it("runs the routed provider, forwards progress, imports media, and returns local URLs with the cost", async () => {
        const { registry, requests } = generator(async (_request, { report }) => {
            report(0.5, "Rendering");
            return { media: [{ kind: "image", url: "https://cdn.example/out.png", mimeType: "image/png" }], costUsd: 0.04 };
        });
        const imported: Array<{ media: GeneratedMedia; projectId: string | null }> = [];
        const run = createAiRunner(registry, {
            importMedia: async (media, { projectId }) => {
                imported.push({ media, projectId });
                return { url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: "out.png", mimeType: "image/png" };
            },
        });
        const progress: AiRunProgressLike[] = [];
        const outcome = await run(
            { capability: "image.generate", input: { description: "a cat", aspectRatio: "16:9" } },
            { snapshot: SNAPSHOT, onProgress: (p) => progress.push(p) },
        );
        expect(requests).toEqual([{ capability: "image.generate", input: { description: "a cat", aspectRatio: "16:9" }, projectId: "p1" }]);
        expect(imported).toEqual([{ media: { kind: "image", url: "https://cdn.example/out.png", mimeType: "image/png" }, projectId: "p1" }]);
        expect(outcome).toEqual({
            jobId: "job-gen",
            output: { media: [{ kind: "image", url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: "out.png", mimeType: "image/png" }], costUsd: 0.04 },
        });
        expect(progress).toContainEqual({ jobId: "job-gen", status: "running", progress: 0.5, message: "Rendering" });
    });

    it("keeps URLs and drops bytes without importMedia; passes a tool result through", async () => {
        const { registry } = generator(async () => ({
            media: [{ kind: "audio", bytes: new Uint8Array([1, 2]), mimeType: "audio/mpeg" }, { kind: "video", url: "https://cdn.example/v.mp4" }],
            result: { issues: [] },
        }));
        const outcome = await createAiRunner(registry)({ capability: "audio.tts", input: { text: "hi" } }, { snapshot: SNAPSHOT });
        expect(outcome.output).toEqual({ media: [{ kind: "audio", mimeType: "audio/mpeg" }, { kind: "video", url: "https://cdn.example/v.mp4" }], result: { issues: [] } });
    });

    it("refuses input that is not a plain object or is too large", async () => {
        const { registry, requests } = generator(async () => ({ media: [] }));
        const run = createAiRunner(registry);
        expect(await run({ capability: "image.generate", input: "a cat" }, { snapshot: SNAPSHOT })).toEqual({ error: "ai.run image.generate: input must be an object" });
        expect(await run({ capability: "image.generate", input: [1] }, { snapshot: SNAPSHOT })).toEqual({ error: "ai.run image.generate: input must be an object" });
        expect(await run({ capability: "image.generate", input: { description: "x".repeat(70_000) } }, { snapshot: SNAPSHOT }))
            .toEqual({ error: "ai.run image.generate: input is larger than 65536 bytes" });
        expect(requests).toEqual([]);
    });

    it("answers unavailable when the provider or its job says the capability needs something (sign-in)", async () => {
        const thrown = new ProviderRegistry();
        thrown.register({
            info: { id: "opennan", name: "OpenNan", capabilities: ["image.generate"] },
            run: () => {
                throw new CapabilityUnavailableError("image.generate", "Generate image");
            },
        });
        expect(await createAiRunner(thrown)({ capability: "image.generate", input: {} }, { snapshot: SNAPSHOT })).toMatchObject({ unavailable: true, error: expect.stringMatching(/Generate image requires/) });
        const { registry } = generator(async () => {
            throw new CapabilityUnavailableError("opennan.qc", "qc_check");
        });
        expect(await createAiRunner(registry)({ capability: "opennan.qc", input: {} }, { snapshot: SNAPSHOT })).toEqual({ jobId: "job-gen", unavailable: true, error: "Connect OpenNan to use qc_check." });
    });

    it("cancels through the signal", async () => {
        const { registry } = generator(({}, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
        const abort = new AbortController();
        const pending = createAiRunner(registry)({ capability: "image.generate", input: {} }, { snapshot: SNAPSHOT, signal: abort.signal });
        abort.abort();
        expect(await pending).toEqual({ jobId: "job-gen", cancelled: true });
    });

    it("reports a failed import as an error", async () => {
        const { registry } = generator(async () => ({ media: [{ kind: "image", url: "https://cdn.example/a.png" }] }));
        const run = createAiRunner(registry, { importMedia: async () => { throw new Error("disk full"); } });
        expect(await run({ capability: "image.generate", input: {} }, { snapshot: SNAPSHOT })).toEqual({ jobId: "job-gen", error: "The result could not be added to the media library: disk full" });
    });

    it("refuses a provider output that is not a CapabilityOutput", async () => {
        const { registry } = generator(async () => ({ nope: true }) as unknown as CapabilityOutput);
        expect(await createAiRunner(registry)({ capability: "image.generate", input: {} }, { snapshot: SNAPSHOT })).toEqual({ jobId: "job-gen", error: 'Provider "opennan" returned no media list.' });
    });
});
