// Generation tools over MCP against the fake OpenNan server: client -> server -> controller (ai.run) -> OpenNan
// provider -> fake API, with results imported into the project's media library.
import { OpenNanSession, createOpenNanApi, createOpenNanProvider, memoryCredentialStore, SIGN_IN_GUIDANCE } from "@opennan/provider-opennan";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { ProviderRegistry, createAiRunner } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { createHeadlessMediaImporter } from "../generated-media";
import { createControllerSession } from "../session";
import { connectInMemory } from "../testing/connect";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

async function studio(signedIn: boolean) {
    const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(signedIn ? { apiKey: fake.mintKey(), keyId: "k" } : null), deviceName: "t", client: "cli" });
    await session.restore();
    const registry = new ProviderRegistry();
    registry.register(createOpenNanProvider(session));
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), createObjectUrl: () => "" });
    const project = await backend.createProject({ name: "P", aspectRatio: "16:9" });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: project.id, onAiRun: createAiRunner(registry, { importMedia: createHeadlessMediaImporter(backend, { allowLoopback: true }) }) });
    await controller.load();
    const { client, close } = await connectInMemory(createControllerSession({ controller, store, backend }));
    return { client, close, backend, projectId: project.id, controller };
}

describe("generation tools over ai.run", () => {
    it("generate_quick_image runs OpenNan and returns the imported media and the cost", async () => {
        const { client, close, backend, projectId } = await studio(true);
        try {
            const result = await client.callTool({ name: "generate_quick_image", arguments: { prompt: "a lighthouse", aspect_ratio: "9:16" } }) as Result;
            expect(result.isError).toBe(false);
            expect(textOf(result)).toMatch(/^Added to the media library: image opennan-local:\/\/media\/[\w-]+\. Cost \$0\.039\.$/);
            const library = await backend.listLibrary(projectId);
            expect(library).toHaveLength(1);
            expect((result.structuredContent!.media as Array<{ url: string }>)[0]!.url).toBe(library[0]!.url);
            const post = fake.state().requests.find((r) => r.path === "/v1/images/generations")!;
            expect(post.body).toMatchObject({ prompt: "a lighthouse", aspect_ratio: "9:16", model: "nano-banana-2" });
        } finally {
            await close();
        }
    });

    it("maps the video, speech, music, and sound-effect tools", async () => {
        const { client, close } = await studio(true);
        try {
            expect((await client.callTool({ name: "generate_video_h3", arguments: { prompt: "waves", seconds: 5 } }) as Result).isError).toBe(false);
            expect((await client.callTool({ name: "generate_video_h3", arguments: { prompt: "waves", first_frame_url: "https://x/a.png" } }) as Result).isError).toBe(false);
            const tts = await client.callTool({ name: "generate_tts", arguments: { voice_id: "af_heart", text: "Hello", timeline_start_time: 2 } }) as Result;
            expect(tts.isError).toBe(false);
            expect(textOf(tts)).toMatch(/audio opennan-local:\/\/media\//);
            expect(textOf(tts)).toContain("Its length is unknown here, so it was not placed: use create_timeline_clip with media_url");
            expect((await client.callTool({ name: "add_music", arguments: { description: "calm piano", instrumental: true } }) as Result).isError).toBe(false);
            expect((await client.callTool({ name: "generate_sfx", arguments: { description: "door slam", duration_seconds: 2 } }) as Result).isError).toBe(false);
            const posts = fake.state().requests.filter((r) => r.method === "POST").map((r) => [r.path, r.body]);
            expect(posts).toContainEqual(["/v1/videos/generations", { model: "kling-3", prompt: "waves", duration: 5 }]);
            expect(posts).toContainEqual(["/v1/videos/generations", { model: "kling-3", prompt: "waves", image: "https://x/a.png" }]);
            expect(posts).toContainEqual(["/v1/audio/speech", { input: "Hello", voice: "af_heart", response_format: "mp3" }]);
            expect(posts).toContainEqual(["/v1/music/generations", { prompt: "calm piano", instrumental: true }]);
            expect(posts).toContainEqual(["/v1/audio/sound-effects", { text: "door slam", duration_seconds: 2, response_format: "mp3" }]);
        } finally {
            await close();
        }
    });

    it("answers signed-out calls with the sign-in guidance (unavailable), and 402 as a failure", async () => {
        const signedOut = await studio(false);
        try {
            const result = await signedOut.client.callTool({ name: "generate_quick_image", arguments: { prompt: "x" } }) as Result;
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({ unavailable: true, capability: "image.generate", reason: SIGN_IN_GUIDANCE });
        } finally {
            await signedOut.close();
        }
        const broke = await studio(true);
        try {
            fake.setBalance(0);
            const result = await broke.client.callTool({ name: "generate_quick_image", arguments: { prompt: "x" } }) as Result;
            expect(result.isError).toBe(true);
            expect(textOf(result)).toBe("generate_quick_image failed: Not enough credits. Buy credits on opennan.com to continue.");
        } finally {
            await broke.close();
        }
    });
});
