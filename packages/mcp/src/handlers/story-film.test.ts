// Story film tools over MCP against the fake OpenNan server: client -> server -> controller (ai.run) -> OpenNan
// provider -> fake API, the story stored on the project between calls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenNanSession, createOpenNanApi, createOpenNanProvider, memoryCredentialStore } from "@opennan/provider-opennan";
import { fakeMp4, startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
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

/** Images as PNG; a video range as an MP4 of that length at 1280x720 (a remake's reference). */
const MEDIA: MediaPreparer = async (input, purpose) => {
    if (purpose.output !== "video" || input.kind !== "media") return PNG(input, purpose, new AbortController().signal);
    // A cut-out clip is its shot's 4.6 s.
    const seconds = input.source.endSeconds !== undefined ? input.source.endSeconds - (input.source.startSeconds ?? 0) : 4.6;
    const data = fakeMp4(seconds, 1280, 720);
    return { data, contentType: "video/mp4", filename: "shot.mp4", sizeBytes: data.byteLength, durationSeconds: seconds, width: 1280, height: 720 };
};

async function studio(host: StudioHost = {}) {
    const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore({ apiKey: fake.mintKey(), keyId: "k" }), deviceName: "t", client: "cli" });
    await session.restore();
    const registry = new ProviderRegistry();
    registry.register(createOpenNanProvider(session, { prepareMedia: MEDIA, pollIntervalMs: 1 }));
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

            // Copying needs the person's word that they have the rights to the video: nothing is sent without it.
            const sheetArgs = { sheet_image_url: "https://cdn.example.com/sheet.jpg", frames: 16, duration_seconds: 48 };
            const refused = await call("story_film_copy", sheetArgs);
            expect(refused.isError).toBe(true);
            expect(textOf(refused)).toMatch(/needs rights_confirmed: true: the person must own the video or have the rights to remake it/);
            expect(posts("/v1/chat/completions")).toHaveLength(1);
            expect((await call("story_film_copy", { ...sheetArgs, rights_confirmed: "yes" })).isError).toBe(true);

            // A close copy by default: the video's characters and title, the style the person chose.
            fake.queueChatReply(JSON.stringify({ ...STORY, title: "Umbrella Day" }));
            const copied = await call("story_film_copy", { ...sheetArgs, rights_confirmed: true, title: "Romance of an Umbrella", style: "warm gouache, soft light" });
            expect(copied.isError).toBe(false);
            const chat = posts("/v1/chat/completions")[1]!;
            expect(chat.model).toBe("text-vision");
            expect(JSON.stringify(chat.messages)).toMatch(/Copy it closely[\s\S]*Keep the video's characters[\s\S]*Keep the video's title: \\"Romance of an Umbrella\\"[\s\S]*warm gouache[\s\S]*image_url/);
            const story = (await call("story_film_get")).structuredContent!.story as { title: string; style: string; source: unknown };
            expect(story).toMatchObject({ title: "Romance of an Umbrella", style: "warm gouache, soft light", source: { kind: "copy", cast: "keep" } });

            // New characters and a new title only when asked.
            fake.queueChatReply(JSON.stringify({ ...STORY, title: "Umbrella Day" }));
            expect((await call("story_film_copy", { ...sheetArgs, rights_confirmed: true, cast: "original" })).isError).toBe(false);
            expect(JSON.stringify(posts("/v1/chat/completions")[2]!.messages)).toMatch(/Make NEW characters/);
            expect((await call("story_film_get")).structuredContent!.story).toMatchObject({ title: "Umbrella Day", source: { kind: "copy", cast: "original" } });

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
            const copied = await call("story_film_copy", { video_url: "https://www.instagram.com/reel/abc/", cast: "keep", rights_confirmed: true });
            expect(copied.isError).toBe(false);
            expect(sampled[0]).toMatch(/^opennan-local:\/\/media\//);
            expect(JSON.stringify(posts("/v1/chat/completions")[0]!.messages)).toMatch(/Keep the video's characters/);
        } finally {
            await close();
        }
        const bare = await studio();
        try {
            const result = await bare.call("story_film_copy", { media_url: "opennan-local://media/v", rights_confirmed: true });
            expect(result.structuredContent).toMatchObject({ unavailable: true });
            expect(textOf(result)).toMatch(/sheet_image_url/);
        } finally {
            await bare.close();
        }
    });

    it("remakes a copied video shot by shot: keep_motion places each story shot on a real shot, animate sends it as the reference", async () => {
        const asked: Array<{ cut: boolean; times?: readonly number[] }> = [];
        const host: StudioHost = {
            storyShots: async (_mediaUrl, cut) => ({
                durationSeconds: 9.6, truncated: false,
                shots: [{ start: 0, end: 4.6, frame: "opennan-local://media/frame-1", ...(cut ? { clip: "opennan-local://media/shot-1" } : {}) }, { start: 4.6, end: 9.6, frame: "opennan-local://media/frame-2" }],
            }),
            storySheet: async (_mediaUrl, frames, _signal, times) => {
                asked.push({ cut: false, ...(times ? { times } : {}) });
                return { url: "https://cdn.example.com/sheet.jpg", frames: times?.length ?? frames, everySeconds: 1, durationSeconds: 9.6 };
            },
        };
        const { call, close } = await studio(host);
        try {
            fake.queueChatReply(JSON.stringify(STORY));
            const copied = await call("story_film_copy", { media_url: "opennan-local://media/source", rights_confirmed: true });
            expect(copied.isError).toBe(false);
            expect(textOf(copied)).toMatch(/placed on one of the video's 2 real shots and is remade from it at story_film_animate/);
            // The sheet shows frames of each shot, and the story writer is told the real shots.
            expect(asked[0]!.times).toHaveLength(6);
            expect(JSON.stringify(posts("/v1/chat/completions")[0]!.messages)).toMatch(/exactly 2 shots \(cut to cut\)/);
            const story = (await call("story_film_get")).structuredContent!.story as { source: unknown; shots: Array<{ seconds: number; source?: unknown }>; settings: Record<string, unknown> };
            expect(story.source).toMatchObject({ kind: "copy", cast: "keep", keepMotion: true, mediaUrl: "opennan-local://media/source" });
            expect(story.shots.map((s) => [s.seconds, s.source])).toEqual([
                [5, { start: 0, end: 4.6, clip: "opennan-local://media/shot-1", frame: "opennan-local://media/frame-1" }], [5, { start: 4.6, end: 9.6, frame: "opennan-local://media/frame-2" }],
            ]);
            expect(story.settings).toMatchObject({ videoModel: "seedance-2-5", videoReference: { minSeconds: 2, maxSeconds: 30 } });

            await call("story_film_cast");
            const imagesBefore = posts("/v1/images/generations").length;
            await call("story_film_frames", { cast_check: 0 });
            // Each keyframe is redrawn from its shot's first frame (an image edit: the frame, then the cast's sheets).
            const keyframes = posts("/v1/images/generations").slice(imagesBefore);
            expect(keyframes).toHaveLength(2);
            for (const body of keyframes) {
                expect(body.image).toEqual(expect.stringMatching(/\/files\/uploads\/temp\//));
                expect(String(body.prompt)).toMatch(/^Redraw reference image 1 exactly: the same composition, camera angle, framing, poses/);
            }
            const priced = await call("story_film_animate", { estimate_only: true });
            expect(textOf(priced)).toMatch(/2 shots \(s01, s02\) are remade from the original shot/);
            const animated = await call("story_film_animate");
            expect(animated.isError).toBe(false);
            const videos = posts("/v1/videos/generations");
            expect(videos).toHaveLength(2);
            for (const body of videos) {
                // Both shots are long enough to edit: restyled as they are, framing kept.
                expect(body).toMatchObject({ model: "seedance-2-5", reference_mode: "editing", quality: "720p", generate_audio: false });
                expect(body.reference_videos).toEqual([expect.stringMatching(/\/files\/uploads\/temp\/.*\.mp4$/)]);
                expect(body).not.toHaveProperty("image");
                expect(body.reference_images).toHaveLength(3);
                expect(String(body.prompt)).toMatch(/^Turn @Video1 into a hand-drawn animated short film/);
            }
            // An edit is billed as long as its video: (5 + 5) × $0.36894 for each (4.6 s and 5 s, rounded up).
            expect((animated.structuredContent as { costUsd: number }).costUsd).toBeCloseTo(2 * 3.6894, 6);
            // keep_motion false animates from the keyframes instead (a new request: the clips are changed since made).
            const keyframed = await call("story_film_animate", { keep_motion: false, estimate_only: true });
            expect(textOf(keyframed)).toMatch(/every clip is made already|would make/);
        } finally {
            await close();
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
