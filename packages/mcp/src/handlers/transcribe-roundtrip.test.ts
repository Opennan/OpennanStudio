// MCP round trip with a fake provider: client -> createStudioMcpServer -> createControllerSession ->
// TimelineController (ai.run through createAiRunner) -> ProviderRegistry -> fake audio.transcribe job.
import { ProviderRegistry, createAiRunner, createJob, type Provider, type TranscribeRequest, type Transcript } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { createControllerSession } from "../session";
import { connectInMemory } from "../testing/connect";

const TRANSCRIPT: Transcript = {
    language: "en",
    segments: [
        { start: 0, end: 5.41, text: " And so, my fellow Americans, ask not what" },
        { start: 5.41, end: 9.04, text: " your country can do for you, ask what you" },
        { start: 9.04, end: 10.5, text: " can do for your country." },
    ],
};

async function studio(withProvider: boolean, options: { hang?: boolean; callTimeoutMs?: number } = {}) {
    const requests: TranscribeRequest[] = [];
    const aborted: boolean[] = [];
    const registry = new ProviderRegistry();
    if (withProvider) {
        const provider: Provider = {
            info: { id: "local", name: "Fake", capabilities: ["audio.transcribe"] },
            audio: {
                transcribe: (request) => {
                    requests.push(request);
                    return createJob(({ signal }) => (options.hang
                        ? new Promise<Transcript>((resolve) => signal.addEventListener("abort", () => { aborted.push(true); setTimeout(() => resolve(TRANSCRIPT), 20); }, { once: true }))
                        : Promise.resolve(TRANSCRIPT)));
                },
            },
        };
        registry.register(provider);
    }
    const backend = new LocalBackend({ persistence: createMemoryPersistence() });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: "p1", onAiRun: createAiRunner(registry) });
    await controller.load();
    const session = createControllerSession({ controller, store, backend });
    const { client, close } = await connectInMemory(session, options.callTimeoutMs ? { callTimeoutMs: options.callTimeoutMs } : undefined);
    return { client, close, controller, requests, aborted };
}

type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

describe("transcription tools over ai.run", () => {
    it("auto_captions places captions on a new track; undo_last_edit removes them in one step", async () => {
        const { client, close, controller, requests } = await studio(true);
        try {
            const names = (await client.listTools()).tools.map((t) => t.name);
            expect(names).toEqual(expect.arrayContaining(["transcribe_audio", "auto_captions"]));
            const result = await client.callTool({ name: "auto_captions", arguments: { language: "en", model: "tiny", style: "subtitle" } }) as Result;
            expect(result.isError).toBe(false);
            expect(textOf(result)).toBe("Added 3 captions on text track 1 (language en). undo_last_edit removes them and the track.");
            expect(result.structuredContent).toMatchObject({ ok: true, trackIndex: 1, language: "en" });
            expect(requests[0]).toMatchObject({ language: "en", model: "tiny", audio: { kind: "timeline" } });
            const snap = controller.snapshot();
            expect(snap.tracks.find((t) => t.type === "text")?.label).toBe("Captions");
            expect(snap.clips.filter((c) => c.trackType === "text").map((c) => c.textContent)).toEqual(TRANSCRIPT.segments.map((s) => s.text.trim()));
            expect(snap.clips.find((c) => c.trackType === "text")?.positionY).toBe(0.88);

            const undo = await client.callTool({ name: "undo_last_edit", arguments: {} }) as Result;
            expect(undo.isError).toBe(false);
            expect(controller.snapshot().clips.filter((c) => c.trackType === "text")).toEqual([]);
            expect(controller.snapshot().tracks.some((t) => t.type === "text")).toBe(false);
        } finally {
            await close();
        }
    });

    it("transcribe_audio returns timed lines and edits nothing", async () => {
        const { client, close, controller } = await studio(true);
        try {
            const result = await client.callTool({ name: "transcribe_audio", arguments: {} }) as Result;
            expect(result.isError).toBe(false);
            expect(textOf(result)).toBe([
                "[0:00.0-0:05.4] And so, my fellow Americans, ask not what",
                "[0:05.4-0:09.0] your country can do for you, ask what you",
                "[0:09.0-0:10.5] can do for your country.",
            ].join("\n"));
            expect((result.structuredContent!.segments as unknown[]).length).toBe(3);
            expect(controller.snapshot().clips).toEqual([]);
            expect(controller.historyDepth().recorded).toBe(0);
        } finally {
            await close();
        }
    });

    it("answers unavailable with the guidance when no provider offers audio.transcribe", async () => {
        const { client, close } = await studio(false);
        try {
            for (const name of ["transcribe_audio", "auto_captions"]) {
                const result = await client.callTool({ name, arguments: {} }) as Result;
                expect(result.isError).toBe(true);
                expect(result.structuredContent).toMatchObject({ unavailable: true, capability: "audio.transcribe" });
                expect(textOf(result)).toBe(`${name} requires a provider with the audio.transcribe capability. Connect OpenNan or another provider that offers it.`);
            }
        } finally {
            await close();
        }
    });

    it("a timed-out auto_captions call cancels its job and places nothing later", async () => {
        const { client, close, controller, aborted } = await studio(true, { hang: true, callTimeoutMs: 100 });
        try {
            const result = await client.callTool({ name: "auto_captions", arguments: {} }) as Result;
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({ timedOut: true });
            await vi.waitFor(() => expect(aborted).toEqual([true]));
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(controller.snapshot().clips).toEqual([]);
            expect(controller.snapshot().tracks.some((t) => t.type === "text")).toBe(false);
        } finally {
            await close();
        }
    });
});
