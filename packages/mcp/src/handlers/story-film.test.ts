// Story film tools over MCP against the fake OpenNan server: client -> server -> controller (ai.run) -> OpenNan
// provider -> fake API, the story stored on the project between calls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenNanSession, createOpenNanApi, createOpenNanProvider, memoryCredentialStore } from "@opennan/provider-opennan";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { ProviderRegistry, createAiRunner, type MediaPreparer } from "@opennan/provider-sdk";
import { LocalBackend, TimelineController, createEditorStore, createMemoryPersistence } from "@opennan/timeline-core";
import { createHeadlessMediaImporter } from "../generated-media";
import { createControllerSession, type StudioHost } from "../session";
import { connectInMemory } from "../testing/connect";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/story-film/rain-check.json");
/** The prototype's story cut to its first two shots. */
const STORY = (() => {
    const story = JSON.parse(fs.readFileSync(EXAMPLE, "utf8")) as { shots: unknown[] };
    return { ...story, shots: story.shots.slice(0, 2) };
})();

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
const PNG: MediaPreparer = async () => ({ data: new Uint8Array([137, 80, 78, 71]), contentType: "image/png", filename: "image.png", sizeBytes: 4 });

async function studio(host: StudioHost = {}) {
    const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore({ apiKey: fake.mintKey(), keyId: "k" }), deviceName: "t", client: "cli" });
    await session.restore();
    const registry = new ProviderRegistry();
    registry.register(createOpenNanProvider(session, { prepareMedia: PNG, pollIntervalMs: 1 }));
    const backend = new LocalBackend({ persistence: createMemoryPersistence(), createObjectUrl: () => "" });
    const project = await backend.createProject({ name: "P", aspectRatio: "16:9" });
    const store = createEditorStore();
    const controller = new TimelineController({ backend, store, projectId: project.id, onAiRun: createAiRunner(registry, { importMedia: createHeadlessMediaImporter(backend, { allowLoopback: true }) }) });
    await controller.load();
    const { client, close } = await connectInMemory(createControllerSession({ controller, store, backend, host, providers: registry }));
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<Result>;
    return { call, close, controller };
}

const posts = (path: string) => fake.state().requests.filter((r) => r.method === "POST" && r.path === path).map((r) => r.body as Record<string, unknown>);

describe("story film tools", () => {
    it("makes a story film end to end: story, cast, keyframes, clips, music, reel; a re-run pays nothing", async () => {
        const { call, close, controller } = await studio();
        try {
            expect(textOf(await call("story_film_get"))).toMatch(/no story film yet/);
            const created = await call("story_film_create", { story: STORY });
            expect(created.isError).toBe(false);
            expect(textOf(created)).toMatch(/"Rain Check": 2 characters, 2 shots/);

            const priced = await call("story_film_cast", { estimate_only: true });
            expect(textOf(priced)).toMatch(/would make 2 character sheets, estimated ≈ \$0\.1\d\d\. Nothing was sent\./);
            expect(posts("/v1/images/generations")).toHaveLength(0);

            expect((await call("story_film_cast")).isError).toBe(false);
            const sheets = posts("/v1/images/generations");
            expect(sheets).toHaveLength(2);
            expect(sheets[0]).toMatchObject({ model: "nano-banana-pro", size: "2K", aspect_ratio: "16:9", prompt: expect.stringMatching(/^Character design model sheet/) });

            expect((await call("story_film_frames")).isError).toBe(false);
            const frames = posts("/v1/images/generations").slice(2);
            expect(frames).toHaveLength(2);
            // Shot 2: Theo's and Mae's sheets, then shot 1's keyframe.
            expect((frames[1]!.images as unknown[]).length).toBe(2);

            const refused = await call("story_film_animate", { accept_max_usd: 0.1 });
            expect(refused.isError).toBe(true);
            expect(textOf(refused)).toMatch(/estimated at ≈ \$6\.1\d+, more than accept_max_usd \$0\.1\. Nothing was sent\./);
            const animated = await call("story_film_animate");
            expect(animated.isError).toBe(false);
            expect(posts("/v1/videos/generations")).toEqual([
                // No model asked for: the best one the provider sells.
                expect.objectContaining({ model: "seedance-2-5", quality: "720p", duration: 5, generate_audio: false, aspect_ratio: "16:9" }),
                expect.objectContaining({ model: "seedance-2-5" }),
            ]);
            expect((await call("story_film_music")).isError).toBe(false);
            expect(posts("/v1/music/generations")[0]).toMatchObject({ duration: 10, instrumental: true });

            const assembled = await call("story_film_assemble");
            expect(assembled.isError).toBe(false);
            const snap = controller.snapshot();
            expect(snap.project?.aspectRatio).toBe("9:16");
            expect(snap.scenes.map((s) => s.fitMode)).toEqual(["contain", "contain"]);
            expect(snap.clips.map((c) => c.trackType).sort()).toEqual(["audio", "text"]);

            const before = fake.state().requests.length;
            for (const tool of ["story_film_cast", "story_film_frames", "story_film_animate", "story_film_music"]) {
                expect(textOf(await call(tool))).toMatch(/is made already/);
            }
            expect(fake.state().requests.filter((r, i) => i >= before && r.method === "POST")).toHaveLength(0);

            const got = await call("story_film_get");
            expect(textOf(got)).toMatch(/Made: cast 2\/2; frames 2\/2; animate 2\/2; music 1\/1\. Spent \$/);
            expect((got.structuredContent!.story as { assembled?: unknown }).assembled).toBeTruthy();

            // Redo one keyframe: one new image, and its clip shows as changed since it was made.
            expect((await call("story_film_frames", { ids: ["s02"], redo: true })).isError).toBe(false);
            expect(posts("/v1/images/generations")).toHaveLength(5);
            expect(textOf(await call("story_film_get"))).toMatch(/animate 2\/2 \(1 changed since made: s02\)/);
        } finally {
            await close();
        }
    });

    it("checks each keyframe's cast: a miss is redrawn once, a shot still off is listed, cast_check 0 turns it off", async () => {
        const { call, close } = await studio();
        try {
            await call("story_film_create", { story: STORY });
            await call("story_film_cast");
            const bare = await call("story_film_frames", { estimate_only: true, cast_check: 0 });
            const checked = await call("story_film_frames", { estimate_only: true });
            const usd = (r: Result) => r.structuredContent!.estimateUsd as number;
            // The check's looks and a possible redraw of each shot are in the price.
            expect(usd(checked)).toBeGreaterThan(usd(bare) * 2);
            const miss = JSON.stringify({ characters: [{ id: "theo", match: true }, { id: "mae", match: false, reason: "no ponytail" }] });
            // Shot 1: off, redrawn, off again (flagged). Shot 2: the fake's default answer (every character matches).
            fake.queueChatReply(miss);
            fake.queueChatReply(miss);
            const frames = await call("story_film_frames");
            expect(frames.isError).toBe(false);
            expect(posts("/v1/images/generations").slice(2)).toHaveLength(3);
            expect(posts("/v1/chat/completions")).toHaveLength(3);
            expect(String(posts("/v1/images/generations")[3]!.prompt)).toMatch(/Most important: Mae must look exactly like reference image 2: .* The last drawing got this wrong: no ponytail$/);
            expect(textOf(frames)).toMatch(/Redrawn after the cast check: s01\. Check these shots \(a character still looks off their sheet\): s01 \(mae: no ponytail\)\./);
            expect(frames.structuredContent).toMatchObject({ redrawn: ["s01"], flagged: [{ id: "s01", misses: [{ id: "mae", reason: "no ponytail" }] }] });
            expect(usd(checked)).toBeGreaterThanOrEqual(frames.structuredContent!.costUsd as number);
            const progress = (await call("story_film_get")).structuredContent!.progress as Array<{ step: string; flagged: string[] }>;
            expect(progress.find((p) => p.step === "frames")!.flagged).toEqual(["s01"]);
            // Redo the flagged shot with the check off: one image, no look.
            const chats = posts("/v1/chat/completions").length;
            expect((await call("story_film_frames", { ids: ["s01"], redo: true, cast_check: 0 })).isError).toBe(false);
            expect(posts("/v1/chat/completions")).toHaveLength(chats);
        } finally {
            await close();
        }
    });

    it("drafts from a written story and from a contact sheet, keeping the draft editable", async () => {
        const { call, close } = await studio();
        try {
            fake.queueChatReply(`\`\`\`json\n${JSON.stringify(STORY)}\n\`\`\``);
            const drafted = await call("story_film_create", { text: "A shy man courts a woman across London.", shots: 2 });
            expect(drafted.isError).toBe(false);
            expect(textOf(drafted)).toMatch(/drafted the story film .* Review and edit it/);
            expect(posts("/v1/chat/completions")[0]).toMatchObject({ model: "text-fast" });

            fake.queueChatReply(JSON.stringify({ ...STORY, title: "Umbrella Day" }));
            const copied = await call("story_film_copy", { sheet_image_url: "https://cdn.example.com/sheet.jpg", frames: 16, duration_seconds: 48 });
            expect(copied.isError).toBe(false);
            const chat = posts("/v1/chat/completions")[1]!;
            expect(chat.model).toBe("text-vision");
            expect(JSON.stringify(chat.messages)).toMatch(/ORIGINAL cast[\s\S]*image_url/);
            const story = (await call("story_film_get")).structuredContent!.story as { title: string; source: unknown };
            expect(story).toMatchObject({ title: "Umbrella Day", source: { kind: "copy", cast: "original" } });

            fake.queueChatReply("I cannot help with that.");
            const bad = await call("story_film_create", { text: "x" });
            expect(bad.isError).toBe(true);
            expect(textOf(bad)).toMatch(/did not read as a story film/);
        } finally {
            await close();
        }
    });

    it("copies from a video link: downloaded into the project, sampled by the host", async () => {
        const sampled: string[] = [];
        const host: StudioHost = {
            storySheet: async (mediaUrl, frames) => {
                sampled.push(mediaUrl);
                return { url: "https://cdn.example.com/sheet.jpg", frames, everySeconds: 3, durationSeconds: frames * 3 };
            },
        };
        const { call, close } = await studio(host);
        try {
            fake.queueChatReply(JSON.stringify(STORY));
            const copied = await call("story_film_copy", { video_url: "https://www.instagram.com/reel/abc/", cast: "keep" });
            expect(copied.isError).toBe(false);
            expect(sampled[0]).toMatch(/^opennan-local:\/\/media\//);
            expect(JSON.stringify(posts("/v1/chat/completions")[0]!.messages)).toMatch(/person's own video/);
        } finally {
            await close();
        }
        const bare = await studio();
        try {
            const result = await bare.call("story_film_copy", { media_url: "opennan-local://media/v" });
            expect(result.structuredContent).toMatchObject({ unavailable: true });
            expect(textOf(result)).toMatch(/sheet_image_url/);
        } finally {
            await bare.close();
        }
    });

    it("refuses a story with problems and lays out any clips as a reel", async () => {
        const { call, close, controller } = await studio();
        try {
            const bad = await call("story_film_create", { story: { title: "T", style: "S", characters: [], shots: [] } });
            expect(textOf(bad)).toMatch(/shots must list at least one shot/);
            const reel = await call("apply_reel_layout", { title: "Reel", clips: [{ media_url: "opennan-local://media/a", duration_seconds: 5 }], music_url: "opennan-local://media/m" });
            expect(reel.isError).toBe(false);
            expect(controller.snapshot().clips.find((c) => c.trackType === "audio")).toMatchObject({ fadeInDuration: 0.5, endTime: 5 });
        } finally {
            await close();
        }
    });
});
