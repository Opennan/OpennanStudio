// The editor's AI tools over MCP against the fake OpenNan server, on a headless project: client -> server -> handler
// (planAiTool + the session's estimate) -> controller (ai.run) -> OpenNan provider (stand-in MediaPreparer, uploads,
// tool tasks) -> placement, one undo step each. Also estimate_cost, check_generation_status, and list_voices.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenNanSession, SIGN_IN_GUIDANCE, createOpenNanApi, createOpenNanProvider, memoryCredentialStore } from "@opennan/provider-opennan";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { ProviderRegistry, type MediaPreparer } from "@opennan/provider-sdk";
import { openHeadlessProject, type HeadlessStudio } from "../headless";
import type { StudioSession } from "../session";
import { planAndPrice } from "./ai-tools";
import { MEDIA_TOOLS_NEED_FFMPEG, createHeadlessMediaPreparer } from "../headless-media";
import { mediaDirFor, writeProjectFile } from "../project-file";
import { connectInMemory } from "../testing/connect";
import { fixtureProject } from "../testing/fixture";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests index into structured results
type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean };
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

let fake: FakeOpenNan;
let dir: string;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(async () => {
    fake.reset();
    dir = await mkdtemp(path.join(os.tmpdir(), "opennan-ai-tools-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const knob = (what: string) => fetch(`${fake.url}/__test/${what}`, { method: "POST" });

/** Prepared files as the host would make them: the asked range (plus `extraSeconds`), a 1280×720 picture for video. */
function stubPreparer(prepared: Array<{ mediaUrl: string; startSeconds?: number; endSeconds?: number; output: string }>, extraSeconds = 0): MediaPreparer {
    return async (input, purpose) => {
        if (input.kind !== "media") throw new Error("timeline input");
        prepared.push({ ...input.source, output: purpose.output });
        const seconds = (input.source.endSeconds ?? 1) - (input.source.startSeconds ?? 0) + extraSeconds;
        return {
            data: new Uint8Array(64), contentType: purpose.contentTypes[0]!, filename: purpose.output === "video" ? "clip.mp4" : "clip.wav", sizeBytes: 64,
            durationSeconds: seconds, ...(purpose.output === "video" ? { width: 1280, height: 720 } : {}),
        };
    };
}

async function studio(options: { signedIn?: boolean; prepareMedia?: MediaPreparer | "headless" } = {}) {
    const file = path.join(dir, "p.opennan.json");
    const project = fixtureProject();
    // A 90 s video clip on V2, past upscale's 60 s limit.
    project.clips.push({ ...project.clips[1]!, id: "long", trackType: "video", trackIndex: 2, startTime: 0, endTime: 90, mediaUrl: "https://media.test/long.mp4", mediaType: "video", label: "Long" });
    await writeProjectFile(file, project);
    const session = new OpenNanSession({
        api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(options.signedIn === false ? null : { apiKey: fake.mintKey(), keyId: "k" }), deviceName: "t", client: "cli",
    });
    await session.restore();
    const prepared: Array<{ mediaUrl: string; startSeconds?: number; endSeconds?: number; output: string }> = [];
    const prepareMedia = options.prepareMedia === "headless" ? createHeadlessMediaPreparer({ mediaDir: mediaDirFor(file) }) : options.prepareMedia ?? stubPreparer(prepared);
    const registry = new ProviderRegistry();
    registry.register(createOpenNanProvider(session, { prepareMedia, pollIntervalMs: 5 }));
    const headless: HeadlessStudio = await openHeadlessProject({ projectFile: file, providers: registry, allowLoopbackDownloads: true });
    const { client, close } = await connectInMemory(headless.session);
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
    return {
        call, prepared, headless,
        clips: () => headless.controller.snapshot().clips,
        posts: (p: string) => fake.state().requests.filter((r) => r.method === "POST" && r.path === p),
        async close() {
            await close();
            await headless.close();
        },
    };
}

describe("paid AI tools", () => {
    it("isolate_voice prices the clip, runs voice isolation on its used range, and lands one undo step", async () => {
        const s = await studio();
        try {
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.isError).toBe(false);
            const created = result.structuredContent!.createdClipIds as string[];
            expect(created).toHaveLength(1);
            expect(result.structuredContent).toMatchObject({ costUsd: 0.13, estimate: { label: "≈ $0.130", usd: 0.13, quoted: true }, jobId: expect.stringMatching(/^job-/) });
            expect(textOf(result)).toBe("Isolated the voice onto a new audio track (A2); the original sound is muted (charged $0.13; quoted ≈ $0.130). undo_last_edit takes it back in one step.");
            expect(s.prepared).toEqual([{ mediaUrl: "https://media.test/music.mp3", startSeconds: 0, endSeconds: 15, output: "audio" }]);
            expect(s.posts("/v1/audio/isolations")).toHaveLength(1);
            expect(s.clips().find((c) => c.id === created[0])).toMatchObject({ trackType: "audio", trackIndex: 2, startTime: 0, endTime: 15 });
            expect(s.clips().find((c) => c.id === "music")?.volume).toBe(0);
            expect((await s.call("undo_last_edit")).isError).toBe(false);
            expect(s.clips().find((c) => c.id === created[0])).toBeUndefined();
            expect(s.clips().find((c) => c.id === "music")?.volume).toBe(1);
        } finally {
            await s.close();
        }
    });

    it("each media tool calls its capability with the editor's placement", async () => {
        const s = await studio();
        try {
            const upscale = await s.call("upscale_video", { scene_id: "s1", resolution: "4k" });
            expect(upscale.structuredContent).toMatchObject({ ok: true, costUsd: 0.03744, estimate: { label: "≈ $0.188" } });
            expect(textOf(upscale)).toMatch(/^Upscaled to 4K on a new video track \(V2\) above the original, which is hidden \(charged \$0\.03744; quoted ≈ \$0\.188\)\./);
            expect(s.posts("/v1/videos/upscales")[0]!.body).toMatchObject({ resolution: "4k" });
            const matting = await s.call("remove_video_background", { scene_id: "s1", background: "green" });
            expect(matting.structuredContent).toMatchObject({ ok: true, costUsd: 0.0026 });
            expect(s.posts("/v1/videos/background-removals")[0]!.body).toMatchObject({ background: "green" });
            const stems = await s.call("split_vocals", { clip_id: "music", stems: "all" });
            expect(stems.structuredContent!.createdClipIds).toHaveLength(4);
            expect(s.posts("/v1/audio/separations")[0]!.body).toMatchObject({ stems: "all" });
            const translated = await s.call("translate_captions", { track_index: 1, language: "th" });
            expect(textOf(translated)).toBe("Translated 1 caption into th on a new captions track (T2) (charged $0.00591; quoted ≈ $0.006). undo_last_edit takes it back in one step.");
            expect(s.posts("/v1/captions/translations")[0]!.body).toMatchObject({ target_language: "th", segments: [{ start: 0, end: 3, text: "Hello" }] });
            const created = translated.structuredContent!.createdClipIds as string[];
            expect(s.clips().find((c) => c.id === created[0])).toMatchObject({ trackType: "text", trackIndex: 2, textContent: "[th] Hello" });
            const lipsync = await s.call("lipsync_clip", { scene_id: "s1", audio_clip_id: "music", first_seconds: 4 });
            expect(lipsync.structuredContent).toMatchObject({ ok: true, costUsd: 0.013, estimate: { label: "≈ $0.065", quoted: true } });
            // Prepared: the scene's 4 s of video for every video tool, the clip's audio for the audio tools.
            expect(s.prepared.map((p) => [p.output, p.mediaUrl, p.startSeconds, p.endSeconds])).toEqual([
                ["video", "https://media.test/a.mp4", 0, 4], ["video", "https://media.test/a.mp4", 0, 4], ["audio", "https://media.test/music.mp3", 0, 15],
                ["video", "https://media.test/a.mp4", 0, 4], ["audio", "https://media.test/music.mp3", 0, 4],
            ]);
        } finally {
            await s.close();
        }
    });

    it("refuses a clip past the tool's limit with the hint, then sends only the first seconds", async () => {
        const s = await studio();
        try {
            const over = await s.call("upscale_video", { clip_id: "long", resolution: "1080p" });
            expect(over.isError).toBe(true);
            expect(textOf(over)).toBe("The used range is 90 s; upscale_video takes at most 60 s. Pass first_seconds (at most 60) to send only the beginning. Nothing was sent.");
            expect(over.structuredContent).toMatchObject({ overLimit: { kind: "seconds", max: 60, actual: 90 } });
            expect(s.prepared).toEqual([]);
            const first = await s.call("upscale_video", { clip_id: "long", resolution: "1080p", first_seconds: 30 });
            expect(first.structuredContent).toMatchObject({ ok: true, estimate: { label: "≈ $0.291" } });
            expect(s.prepared).toEqual([{ mediaUrl: "https://media.test/long.mp4", startSeconds: 0, endSeconds: 30, output: "video" }]);
            const estimate = await s.call("estimate_cost", { tool: "upscale_video", clip_id: "long" });
            expect(estimate.isError).toBe(true);
            expect(estimate.structuredContent).toMatchObject({ overLimit: { max: 60 }, limit: { maxSeconds: 60 } });
        } finally {
            await s.close();
        }
    });

    it("signed out: answers with the sign-in guidance and sends no task", async () => {
        const s = await studio({ signedIn: false });
        try {
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({ unavailable: true, capability: "audio.isolate-voice", reason: SIGN_IN_GUIDANCE });
            expect(s.posts("/v1/audio/isolations")).toEqual([]);
        } finally {
            await s.close();
        }
    });

    it("402: Not enough credits, nothing placed", async () => {
        const s = await studio();
        try {
            fake.setBalance(0);
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.isError).toBe(true);
            expect(textOf(result)).toBe("isolate_voice did not run: Not enough credits. Buy credits on opennan.com to continue.");
            expect(result.structuredContent).toMatchObject({ insufficientCredits: true, estimate: { label: "≈ $0.130" } });
            expect(s.clips().filter((c) => c.trackType === "audio")).toHaveLength(1);
        } finally {
            await s.close();
        }
    });

    it("a failed task is refunded and not retried; check_generation_status shows it", async () => {
        const s = await studio();
        try {
            await knob("fail-next?tool=voice-isolation");
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.isError).toBe(true);
            // The server's text already says nothing was charged (refunded: true in the data); no second "refunded".
            expect(textOf(result)).toMatch(/^isolate_voice failed: .+ You were not charged\. It was not retried; call the tool again to retry\.$/);
            expect(result.structuredContent).toMatchObject({ refunded: true, jobId: expect.stringMatching(/^job-/) });
            expect(s.posts("/v1/audio/isolations")).toHaveLength(1);
            const status = await s.call("check_generation_status", { job_id: result.structuredContent!.jobId });
            expect(status.structuredContent!.job).toMatchObject({ capability: "audio.isolate-voice", status: "failed", refunded: true, costUsd: null });
            expect(textOf(status)).toMatch(/audio\.isolate-voice: failed.*\(refunded\)/);
        } finally {
            await s.close();
        }
    });

    it("stops before sending when the prepared file would cost more than the estimate", async () => {
        const prepared: Array<{ mediaUrl: string; output: string }> = [];
        const s = await studio({ prepareMedia: stubPreparer(prepared, 61) });
        try {
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.isError).toBe(true);
            expect(textOf(result)).toBe("isolate_voice did not run: the prepared file costs ≈ $0.260, more than the estimate. Nothing was sent. Call it again with accept_max_usd: 0.260 to run at that price.");
            expect(result.structuredContent).toMatchObject({ newMaxUsd: 0.26 });
            expect(s.posts("/v1/audio/isolations")).toEqual([]);
            // The agent accepts the new amount: the run goes through.
            const accepted = await s.call("isolate_voice", { clip_id: "music", accept_max_usd: 0.26 });
            expect(accepted.isError, textOf(accepted)).toBeFalsy();
            expect(s.posts("/v1/audio/isolations")).toHaveLength(1);
        } finally {
            await s.close();
        }
    });

    it("refuses a paid tool whose provider cannot give a price; nothing is prepared or sent", async () => {
        const s = await studio();
        try {
            const snapshot = s.headless.controller.snapshot();
            const session = { estimate: async () => ({ kind: "unknown" as const, reason: "OpenNan prices are not available right now.", providerName: "OpenNan", priced: true }) } as unknown as StudioSession;
            const priced = await planAndPrice("isolate_voice", "voice-isolation", { clipId: "music" }, session, snapshot);
            expect(priced.ok).toBe(false);
            const outcome = (priced as { ok: false; outcome: { ok: boolean; text: string } }).outcome;
            expect(outcome.text).toBe("isolate_voice: the price could not be checked (OpenNan prices are not available right now.). Nothing was sent; try again.");
            // A provider without prices (billed elsewhere, or no price list) still runs.
            const unpriced = { estimate: async () => ({ kind: "unknown" as const, providerName: "Other" }) } as unknown as StudioSession;
            expect((await planAndPrice("isolate_voice", "voice-isolation", { clipId: "music" }, unpriced, snapshot)).ok).toBe(true);
        } finally {
            await s.close();
        }
    });

    it("a tool the provider lists as not live is refused before anything is prepared", async () => {
        await knob("tool-status?id=voice-isolation&status=soon");
        const s = await studio();
        try {
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.structuredContent).toMatchObject({ unavailable: true, reason: "Voice isolation is coming soon on OpenNan." });
            expect(s.prepared).toEqual([]);
        } finally {
            await s.close();
        }
    });

    it("headless without ffmpeg: media tools say what they need", async () => {
        const s = await studio({ prepareMedia: "headless" });
        try {
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.structuredContent).toMatchObject({ unavailable: true, reason: MEDIA_TOOLS_NEED_FFMPEG });
            const stabilize = await s.call("stabilize_clip", { scene_id: "s1" });
            expect(stabilize.structuredContent).toMatchObject({ unavailable: true, capability: "media.stabilize" });
        } finally {
            await s.close();
        }
    });

    it("refuses calls without exactly one item", async () => {
        const s = await studio();
        try {
            expect(textOf(await s.call("isolate_voice", {}))).toBe("isolate_voice needs clip_id or scene_id (one of them).");
            expect(textOf(await s.call("upscale_video", { clip_id: "long", scene_id: "s1", resolution: "2k" }))).toBe("upscale_video needs clip_id or scene_id (one of them).");
            expect(textOf(await s.call("translate_captions", { language: "th" }))).toBe("translate_captions needs track_index or clip_id (a caption clip of the track).");
            expect(textOf(await s.call("isolate_voice", { clip_id: "title" }))).toBe("isolate_voice: Select a video, audio, or image clip.");
        } finally {
            await s.close();
        }
    });
});

describe("estimate_cost without quotes (an older server)", () => {
    it("answers the never-under estimate and says so", async () => {
        await knob("quotes?status=404");
        const s = await studio();
        try {
            const voice = await s.call("estimate_cost", { tool: "isolate_voice", clip_id: "music" });
            expect(textOf(voice)).toBe("≈ $0.131 (1 started minute of voice isolation). Charged when it finishes, never above this. It holds up to $1.31 of credits while it runs.");
            expect(voice.structuredContent).toMatchObject({ estimate: { label: "≈ $0.131", usd: 0.131, quoted: false } });
            const run = await s.call("isolate_voice", { clip_id: "music" });
            expect(textOf(run)).toContain("(charged $0.13; estimated ≈ $0.131)");
        } finally {
            await s.close();
        }
    });
});

describe("estimate_cost prices the call the generator makes (phase 11.1)", () => {
    it("add_music makes the default length whatever duration_seconds says; generate_video_h3 with a first frame is image-to-video", async () => {
        const s = await studio();
        try {
            const music = await s.call("estimate_cost", { tool: "add_music", duration_seconds: 10 });
            const ranMusic = await s.call("add_music", { description: "calm piano" });
            expect(ranMusic.isError, textOf(ranMusic)).toBeFalsy();
            expect(music.structuredContent!.estimate.usd).toBeGreaterThanOrEqual(ranMusic.structuredContent!.costUsd);
            const video = await s.call("estimate_cost", { tool: "generate_video_h3", duration_seconds: 10, first_frame_url: "https://media.test/frame.png" });
            const quote = fake.state().requests.filter((r) => r.path === "/v1/quotes").at(-1)!;
            expect(quote.body).toMatchObject({ model: "kling-3", duration: 10, image: expect.stringMatching(/^https:/) });
            const ranVideo = await s.call("generate_video_h3", { prompt: "waves", seconds: 10, first_frame_url: "https://media.test/frame.png" });
            expect(ranVideo.isError, textOf(ranVideo)).toBeFalsy();
            expect(video.structuredContent!.estimate.usd).toBeGreaterThanOrEqual(ranVideo.structuredContent!.costUsd);
            expect(s.posts("/v1/videos/generations").at(-1)!.body).toMatchObject({ duration: 10, image: "https://media.test/frame.png" });
        } finally {
            await s.close();
        }
    });
});

describe("MCP wording after review round 2", () => {
    it("a refusal that charged nothing is not also called refunded; estimate_cost generate_tts without text asks for the text", async () => {
        // A storage refusal before the task (the stand-in preparer's file type is not one OpenNan takes).
        const odd: MediaPreparer = async () => ({ data: new Uint8Array(4), contentType: "audio/x-unknown", filename: "a.bin", sizeBytes: 4, durationSeconds: 15 });
        const s = await studio({ prepareMedia: odd });
        try {
            const tts = await s.call("estimate_cost", { tool: "generate_tts" });
            expect(textOf(tts)).toMatch(/Speech needs its text/);
            const result = await s.call("isolate_voice", { clip_id: "music" });
            expect(result.isError).toBe(true);
            expect(textOf(result)).toMatch(/You were not charged\. It was not retried/);
            expect(textOf(result)).not.toMatch(/refunded/);
            expect(s.posts("/v1/audio/isolations")).toEqual([]);
        } finally {
            await s.close();
        }
    });
});

describe("captions engines", () => {
    it("cloud captions of one clip are priced, placed at the clip, and transcribe_audio answers in timeline seconds", async () => {
        const s = await studio();
        try {
            const captions = await s.call("auto_captions", { clip_id: "music", engine: "cloud" });
            expect(captions.structuredContent).toMatchObject({ ok: true, costUsd: 0.004768, estimate: { label: "≈ $0.005" }, language: "en" });
            expect(textOf(captions)).toMatch(/^Added 2 captions on text track 2 \(language en\) \(charged \$0\.004768; quoted ≈ \$0\.005\)\./);
            const transcript = await s.call("transcribe_audio", { scene_id: "s1", engine: "cloud", language: "en" });
            expect(transcript.structuredContent).toMatchObject({ segments: [{ start: 0.1, end: 1, text: "Hello there." }, { start: 1.2, end: 2.3, text: "How are you?" }], costUsd: 0.004768 });
            expect(s.posts("/v1/audio/transcriptions")).toHaveLength(2);
            const local = await s.call("transcribe_audio", { engine: "local" });
            expect(local.structuredContent).toMatchObject({ unavailable: true, capability: "audio.transcribe" });
        } finally {
            await s.close();
        }
    });
});

describe("estimate_cost, check_generation_status, list_voices", () => {
    it("estimate_cost answers the editor's figure for tools and generators", async () => {
        const s = await studio();
        try {
            const voice = await s.call("estimate_cost", { tool: "isolate_voice", clip_id: "music" });
            expect(textOf(voice)).toBe("≈ $0.130 (OpenNan's quote; 1 started minute of voice isolation). Charged when it finishes, never above this. It holds up to $1.30 of credits while it runs.");
            expect(voice.structuredContent).toMatchObject({ tool: "isolate_voice", provider: "OpenNan", estimate: { label: "≈ $0.130", usd: 0.13, units: 1, quoted: true, holdUsd: 1.3 }, units: { seconds: 15 } });
            expect((await s.call("estimate_cost", { tool: "upscale_video", scene_id: "s1", resolution: "4k" })).structuredContent).toMatchObject({ estimate: { label: "≈ $0.188", units: 5 } });
            expect((await s.call("estimate_cost", { tool: "translate_captions", track_index: 1, language: "ja" })).structuredContent).toMatchObject({ estimate: { label: "≈ $0.006", units: 1 } });
            expect((await s.call("estimate_cost", { tool: "generate_video_h3", duration_seconds: 5 })).structuredContent).toMatchObject({ estimate: { units: 5 } });
            expect((await s.call("estimate_cost", { tool: "generate_tts", text: "Hello there" })).structuredContent).toMatchObject({ estimate: { units: 1 } });
            expect((await s.call("estimate_cost", { tool: "remove_silences", clip_id: "music" })).structuredContent).toMatchObject({ free: true, estimate: null });
            expect((await s.call("estimate_cost", { tool: "auto_captions", engine: "local" })).structuredContent).toMatchObject({ free: true, estimate: null });
            expect(textOf(await s.call("estimate_cost", { tool: "isolate_voice", clip_id: "title" }))).toBe("estimate_cost: Select a video, audio, or image clip.");
            // Pricing runs nothing: only keyless quotes (POST /v1/quotes).
            const posts = fake.state().requests.filter((r) => r.method === "POST");
            expect(posts.filter((r) => r.path !== "/v1/quotes")).toEqual([]);
            expect(posts.length).toBeGreaterThan(0);
            expect(posts.every((r) => !r.authorized)).toBe(true);
        } finally {
            await s.close();
        }
    });

    it("check_generation_status lists the session's jobs, newest first", async () => {
        const s = await studio();
        try {
            expect(textOf(await s.call("check_generation_status"))).toBe("No AI jobs have run in this editor session.");
            const ran = await s.call("isolate_voice", { clip_id: "music" });
            await s.call("translate_captions", { track_index: 1, language: "th" });
            const all = await s.call("check_generation_status");
            expect((all.structuredContent!.jobs as Array<{ capability: string }>).map((j) => j.capability)).toEqual(["captions.translate", "audio.isolate-voice"]);
            const one = await s.call("check_generation_status", { job_id: ran.structuredContent!.jobId });
            expect(one.structuredContent!.job).toMatchObject({ status: "succeeded", costUsd: 0.13, progress: 1 });
            expect(textOf(one)).toMatch(/audio\.isolate-voice: succeeded .*charged \$0\.13$/);
            expect((await s.call("check_generation_status", { job_id: "nope" })).isError).toBe(true);
        } finally {
            await s.close();
        }
    });

    it("list_voices returns the provider's voices, by language", async () => {
        const s = await studio();
        try {
            const all = await s.call("list_voices");
            expect(all.structuredContent!.voices).toHaveLength(3);
            expect(textOf(all)).toContain("heart: Heart (en-US, female)");
            const gb = await s.call("list_voices", { language: "en-GB" });
            expect((gb.structuredContent!.voices as Array<{ id: string }>).map((v) => v.id)).toEqual(["emma"]);
            expect((await s.call("list_voices", { language: "en" })).structuredContent!.voices).toHaveLength(3);
        } finally {
            await s.close();
        }
    });
});
