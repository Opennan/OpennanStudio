// The OpenNan media tools and cloud captions against the fake server, with a fake MediaPreparer.
import {
    CANCEL_REFUSED_MESSAGE, CapabilityUnavailableError, JobCancelledError, JobFailedError, ProviderRegistry,
    type JobUpdate, type MediaPrepareInput, type MediaPreparePurpose, type MediaPreparer, type Provider,
} from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { INSUFFICIENT_CREDITS_MESSAGE, createOpenNanProvider } from "./provider";
import { OpenNanSession, memoryCredentialStore } from "./session";
import { FAKE_TOOL_PRICES, startFakeOpenNan, type FakeOpenNan } from "./testing";
import { PREPARE_MEDIA_UNAVAILABLE, PriceChangedError, transcriptOf } from "./tools";
import { UPLOAD_SCOPE_MESSAGE } from "./uploads";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

interface Prepared { input: MediaPrepareInput; purpose: MediaPreparePurpose }

function preparer(durationSeconds = 30) {
    const calls: Prepared[] = [];
    let n = 0;
    const prepare: MediaPreparer = async (input, purpose) => {
        calls.push({ input, purpose });
        n += 1;
        const contentType = purpose.contentTypes[0]!;
        const source = input.kind === "media" ? input.source.mediaUrl : "timeline";
        const size = purpose.output === "video" ? { width: 1280, height: 720 } : {};
        return { data: new TextEncoder().encode(`${source}:${contentType}`), contentType, filename: `clip-${n}.${contentType.split("/")[1]}`, sizeBytes: 0, durationSeconds, ...size };
    };
    return { prepare, calls };
}

async function provider(options: { prepareMedia?: MediaPreparer; key?: string } = {}): Promise<Provider> {
    const session = new OpenNanSession({
        api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore({ apiKey: options.key ?? fake.mintKey(), keyId: "key_1" }), deviceName: "t", client: "desktop",
    });
    await session.restore();
    return createOpenNanProvider(session, { pollIntervalMs: 5, ...(options.prepareMedia ? { prepareMedia: options.prepareMedia } : {}) });
}

const posts = (path: string) => fake.state().requests.filter((r) => r.method === "POST" && r.path === path);
const SOURCE = { mediaUrl: "opennan-local://media/clip-a", startSeconds: 2, endSeconds: 32 };

describe("media tools", () => {
    it("isolates a voice: prepare, upload, task with an Idempotency-Key, staged progress, the cost", async () => {
        const { prepare, calls } = preparer();
        const p = await provider({ prepareMedia: prepare });
        const job = p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE } });
        const updates: JobUpdate[] = [];
        job.subscribe?.((u) => updates.push(u));
        const output = await job.result();
        expect(calls).toEqual([{ input: { kind: "media", source: SOURCE }, purpose: { output: "audio", sampleRate: 44100, maxBytes: 200 * 1024 * 1024, maxSeconds: 600, contentTypes: ["audio/wav"] } }]);
        expect(output).toEqual({ media: [{ kind: "audio", url: `${fake.url}/files/generated.wav`, durationSeconds: 0.5 }], costUsd: FAKE_TOOL_PRICES["voice-isolation"] });
        const [task] = posts("/v1/audio/isolations");
        // A tool input is a temp upload (no project_id, no scope): the server keys it under uploads/temp/.
        expect(task!.body).toEqual({ audio_url: expect.stringMatching(new RegExp(`^${fake.url}/files/uploads/temp/[0-9a-f]{24}/[a-z2-7]{24}\\.wav$`)) });
        expect(task!.idempotencyKey).toMatch(/^studio-[0-9a-f]{32}$/);
        const messages = updates.map((u) => u.message);
        for (const label of ["Preparing", "Uploading", "Queued", "Reading", "Isolating"]) expect(messages).toContain(label);
        expect(messages.indexOf("Uploading")).toBeLessThan(messages.indexOf("Reading"));
    });

    it("uploads the same prepared file again for a second task (a temp upload never outlives its task) with a fresh Idempotency-Key", async () => {
        const { prepare } = preparer();
        const p = await provider({ prepareMedia: prepare });
        await p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE } }).result();
        await p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE } }).result();
        expect(posts("/v1/uploads")).toHaveLength(2);
        expect(fake.state().uploads.map((u) => u.completed)).toEqual([true, true]);
        const [first, second] = posts("/v1/audio/isolations").map((r) => (r.body as { audio_url: string }).audio_url);
        expect(first).not.toBe(second);
        const keys = posts("/v1/audio/isolations").map((r) => r.idempotencyKey);
        expect(new Set(keys).size).toBe(2);
    });

    it("uploads one file once within a task (image and end image from the same media)", async () => {
        const { prepare, calls } = preparer();
        const p = await provider({ prepareMedia: prepare });
        const still = { mediaUrl: "opennan-local://media/still" };
        await p.run!({ capability: "video.image-to-video", input: { image: still, endImage: still, model: "kling-3" } }).result();
        expect(calls).toHaveLength(2);
        expect(posts("/v1/uploads")).toHaveLength(1);
        const body = posts("/v1/videos/generations")[0]!.body as { image: string; end_image: string };
        expect(body.end_image).toBe(body.image);
        await p.run!({ capability: "video.image-to-video", input: { image: still, endImage: still, model: "kling-3" } }).result();
        expect(posts("/v1/uploads")).toHaveLength(2);
    });

    it("upscales and removes backgrounds from links passed straight through", async () => {
        const p = await provider();
        const video = `${fake.url}/files/generated.webm`;
        expect(await p.run!({ capability: "video.upscale", input: { videoUrl: video, resolution: "2k" } }).result())
            .toEqual({ media: [{ kind: "video", url: video }], costUsd: FAKE_TOOL_PRICES["video-upscale"]["2k"] });
        await p.run!({ capability: "video.remove-background", input: { videoUrl: video } }).result();
        expect(posts("/v1/videos/upscales")[0]!.body).toEqual({ video_url: video, resolution: "2k" });
        expect(posts("/v1/videos/background-removals")[0]!.body).toEqual({ video_url: video, background: "transparent" });
        expect(fake.state().uploads).toEqual([]);
    });

    it("syncs lips from a video source and an audio source", async () => {
        const { prepare, calls } = preparer(8);
        const p = await provider({ prepareMedia: prepare });
        const output = await p.run!({ capability: "video.lipsync", input: { videoSource: { mediaUrl: "opennan-local://media/face" }, audioSource: { mediaUrl: "opennan-local://media/speech" } } }).result();
        expect(output.media).toEqual([{ kind: "video", url: `${fake.url}/files/generated.webm` }]);
        expect(calls.map((c) => [c.purpose.output, c.purpose.maxSeconds])).toEqual([["video", 120], ["audio", 60]]);
        // The prepared video's size (the source's) comes back, so the stacked result keeps its on-screen size.
        expect(output.sourceSize).toEqual({ width: 1280, height: 720 });
        const body = posts("/v1/videos/lipsync")[0]!.body as Record<string, string>;
        expect(body.video_url).not.toBe(body.audio_url);
    });

    it("separates stems with their roles", async () => {
        const { prepare, calls } = preparer();
        const p = await provider({ prepareMedia: prepare });
        const output = await p.run!({ capability: "audio.separate", input: { source: SOURCE, stems: "all" } }).result();
        expect(calls[0]!.purpose).toEqual({ output: "audio", sampleRate: 44100, maxBytes: 50 * 1024 * 1024, maxSeconds: 900, contentTypes: ["audio/mp4", "audio/wav"] });
        expect(output.media.map((m) => [m.role, m.name, m.mimeType])).toEqual([
            ["vocals", "vocals.mp3", "audio/mpeg"], ["drums", "drums.mp3", "audio/mpeg"], ["bass", "bass.mp3", "audio/mpeg"], ["other", "other.mp3", "audio/mpeg"],
        ]);
        expect(posts("/v1/audio/separations")[0]!.body).toMatchObject({ model: "demucs", stems: "all" });
        expect(output.costUsd).toBe(FAKE_TOOL_PRICES.separation);
    });

    it("translates captions and passes the result through", async () => {
        const p = await provider();
        const segments = [{ start: 0, end: 1, text: "Hi" }, { start: 1, end: 2, text: "Bye" }];
        const output = await p.run!({ capability: "captions.translate", input: { segments, targetLanguage: "pt-BR", sourceLanguage: "en" } }).result();
        expect(output).toEqual({
            media: [], costUsd: FAKE_TOOL_PRICES["caption-translate"],
            result: { language: "pt-BR", segments: [{ start: 0, end: 1, text: "[pt-BR] Hi" }, { start: 1, end: 2, text: "[pt-BR] Bye" }], untranslated: [] },
        });
        expect(posts("/v1/captions/translations")[0]!.body).toEqual({ segments, target_language: "pt-BR", source_language: "en" });
    });

    it("counts a caption line's length in code points, like the server", async () => {
        const p = await provider();
        // 300 emoji are 600 UTF-16 units but 300 characters.
        await p.run!({ capability: "captions.translate", input: { segments: [{ start: 0, end: 1, text: "😀".repeat(300) }], targetLanguage: "th" } }).result();
        expect(posts("/v1/captions/translations")).toHaveLength(1);
        await expect(p.run!({ capability: "captions.translate", input: { segments: [{ start: 0, end: 1, text: "😀".repeat(501) }], targetLanguage: "th" } }).result()).rejects.toThrow(/1 to 500 characters/);
        expect(posts("/v1/captions/translations")).toHaveLength(1);
    });

    it("turns image-to-video's project image into an upload", async () => {
        const { prepare, calls } = preparer();
        const p = await provider({ prepareMedia: prepare });
        await p.run!({ capability: "video.image-to-video", input: { image: { mediaUrl: "opennan-local://media/still" }, model: "kling-3" } }).result();
        expect(calls[0]!.purpose).toEqual({ output: "image", maxBytes: 20 * 1024 * 1024, contentTypes: ["image/png", "image/jpeg", "image/webp"] });
        expect(posts("/v1/videos/generations")[0]!.body).toMatchObject({ model: "kling-3", image: expect.stringMatching(/\/files\/uploads\/temp\//) });
        expect(posts("/v1/videos/generations")[0]!.idempotencyKey).toMatch(/^studio-/);
    });

    it("explains that a project media input needs a preparer, without a request", async () => {
        const p = await provider();
        const error = await p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE } }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CapabilityUnavailableError);
        expect((error as Error).message).toBe(PREPARE_MEDIA_UNAVAILABLE);
        expect(posts("/v1/uploads")).toEqual([]);
    });

    it.each([
        ["video.upscale", { videoUrl: "https://cdn.example/a.mp4", resolution: "8k" }, /resolution/],
        ["audio.isolate-voice", { audioUrl: "http://evil.example/a.wav" }, /https/],
        ["audio.isolate-voice", {}, /source/],
        ["audio.isolate-voice", { source: { mediaUrl: "file:///etc/passwd" } }, /source/],
        ["captions.translate", { segments: [], targetLanguage: "th" }, /segments/],
        ["captions.translate", { segments: [{ start: 0, end: 1, text: "x" }], targetLanguage: "thai!" }, /targetLanguage/],
        ["audio.separate", { audioUrl: "https://cdn.example/a.mp3", stems: "drums" }, /stems/],
    ])("refuses %s %j before any request", async (capability, input, message) => {
        const p = await provider({ prepareMedia: preparer().prepare });
        await expect(p.run!({ capability: capability as "video.upscale", input }).result()).rejects.toThrow(message);
        expect(fake.state().requests.filter((r) => r.method === "POST")).toEqual([]);
    });
});

describe("uploads before any task say nothing was charged (review round 2)", () => {
    it("a file OpenNan cannot take is refused before the task with refunded: true", async () => {
        const huge: MediaPreparer = async () => ({ data: new Uint8Array(4), contentType: "audio/x-unknown", filename: "a.bin", sizeBytes: 4, durationSeconds: 1 });
        const p = await provider({ prepareMedia: huge });
        await expect(p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE } }).result()).rejects.toMatchObject({ refunded: true, message: expect.stringMatching(/You were not charged\.$/) });
        expect(posts("/v1/audio/isolations")).toEqual([]);
    });
});

describe("price re-check before sending", () => {
    it("stops with price_changed when the prepared file costs more than the shown estimate; nothing is sent", async () => {
        const { prepare } = preparer(130);
        const p = await provider({ prepareMedia: prepare });
        const error = await p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE, expectedMaxUsd: 0.131 } }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(JobFailedError);
        // The prepared file's quote (130 s with the decode margin: 3 started minutes at $0.13).
        expect(error).toMatchObject({ code: "price_changed", message: "The price changed: ≈ $0.390. Run again to accept." });
        // The new amount rides along, so a host can accept it on Retry without reading the message.
        expect(error).toBeInstanceOf(PriceChangedError);
        expect((error as PriceChangedError).newMaxUsd).toBe(0.39);
        expect(posts("/v1/uploads")).toEqual([]);
        expect(posts("/v1/audio/isolations")).toEqual([]);
    });

    it("without quotes (an older server) the re-check uses the never-under estimate", async () => {
        await fetch(`${fake.url}/__test/quotes?status=404`);
        const p = await provider({ prepareMedia: preparer(130).prepare });
        const error = await p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE, expectedMaxUsd: 0.131 } }).result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "price_changed", message: "The price changed: ≈ $0.391. Run again to accept." });
        expect(posts("/v1/uploads")).toEqual([]);
    });

    it("re-checks with the prepared length plus the decode margin (the server settles on what it decodes)", async () => {
        // 59.8 s prepared: the server may decode a few ms more, so the quote asks for 60.349 s (two minutes) and a
        // label for one minute is refused before anything is uploaded.
        const p = await provider({ prepareMedia: preparer(59.8).prepare });
        const error = await p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE, expectedMaxUsd: 0.13 } }).result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "price_changed", message: "The price changed: ≈ $0.260. Run again to accept." });
        expect(fake.state().requests.find((r) => r.path === "/v1/quotes" && (r.body as { seconds?: number }).seconds === 60.349)).toBeDefined();
        expect(posts("/v1/uploads")).toEqual([]);
    });

    it("runs when the prepared file costs what was shown", async () => {
        const { prepare } = preparer(30);
        const p = await provider({ prepareMedia: prepare });
        await p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE, expectedMaxUsd: 0.131 } }).result();
        expect(posts("/v1/audio/isolations")).toHaveLength(1);
    });

    const PRICE_UNKNOWN = { code: "price_unknown", message: "The price could not be checked: nothing was sent. Try again." };

    it("stops with price_unknown when the prepared file has no length to price; nothing is sent", async () => {
        const { prepare } = preparer();
        const lengthless: MediaPreparer = async (...args) => {
            const { durationSeconds: _d, ...rest } = await prepare(...args);
            return rest;
        };
        const p = await provider({ prepareMedia: lengthless });
        await expect(p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE, expectedMaxUsd: 0.131 } }).result()).rejects.toMatchObject(PRICE_UNKNOWN);
        await expect(p.audio!.transcribe!({ audio: { kind: "media", url: "opennan-local://media/a" }, expectedMaxUsd: 0.005 }).result()).rejects.toMatchObject(PRICE_UNKNOWN);
        expect(fake.state().requests.filter((r) => r.method === "POST")).toEqual([]);
    });

    it("stops with price_unknown when the price list does not give an estimate", async () => {
        await fetch(`${fake.url}/__test/tool-status?id=voice-isolation&status=unavailable`);
        const p = await provider({ prepareMedia: preparer(30).prepare });
        await expect(p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE, expectedMaxUsd: 0.131 } }).result()).rejects.toMatchObject(PRICE_UNKNOWN);
        expect(fake.state().requests.filter((r) => r.method === "POST")).toEqual([]);
    });

    it("stops with price_unknown for a link when a price was shown (its length is unknown)", async () => {
        const p = await provider();
        await expect(p.run!({ capability: "video.upscale", input: { videoUrl: `${fake.url}/files/generated.webm`, expectedMaxUsd: 1 } }).result()).rejects.toMatchObject(PRICE_UNKNOWN);
        expect(posts("/v1/videos/upscales")).toEqual([]);
    });

    it("prices caption translation from its exact characters", async () => {
        const p = await provider();
        await p.run!({ capability: "captions.translate", input: { segments: [{ start: 0, end: 1, text: "Hi" }], targetLanguage: "th", expectedMaxUsd: 0.006 } }).result();
        expect(posts("/v1/captions/translations")).toHaveLength(1);
    });

    it("checks cloud captions too", async () => {
        const { prepare } = preparer(61);
        const p = await provider({ prepareMedia: prepare });
        const error = await p.audio!.transcribe!({ audio: { kind: "media", url: "opennan-local://media/a" }, expectedMaxUsd: 0.005 }).result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "price_changed" });
        expect(posts("/v1/audio/transcriptions")).toEqual([]);
    });
});

describe("failures and cancel", () => {
    it("fails with the server's refund wording", async () => {
        await fetch(`${fake.url}/__test/fail-next?tool=video-upscale&kind=input_already_large`);
        const p = await provider();
        const error = await p.run!({ capability: "video.upscale", input: { videoUrl: `${fake.url}/files/generated.webm` } }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(JobFailedError);
        expect(error).toMatchObject({ refunded: true, message: "The video is already at or above the size asked for: ask for a larger size. You were not charged." });
    });

    it("explains a key that cannot upload", async () => {
        await fetch(`${fake.url}/__test/key-scopes?scopes=api:voice,api:video`);
        const p = await provider({ prepareMedia: preparer().prepare, key: fake.mintKey() });
        await expect(p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE } }).result()).rejects.toThrow(UPLOAD_SCOPE_MESSAGE);
    });

    it("answers 402 with the credits message", async () => {
        fake.setBalance(0);
        const p = await provider();
        await expect(p.run!({ capability: "video.upscale", input: { videoUrl: `${fake.url}/files/generated.webm` } }).result()).rejects.toThrow(INSUFFICIENT_CREDITS_MESSAGE);
    });

    it("cancels a queued task on the server (refunded)", async () => {
        await fetch(`${fake.url}/__test/task-steps?n=50`);
        const p = await provider();
        const job = p.run!({ capability: "video.upscale", input: { videoUrl: `${fake.url}/files/generated.webm` } });
        await vi.waitFor(() => expect(fake.state().requests.some((r) => r.path.startsWith("/v1/tasks/"))).toBe(true));
        await job.cancel();
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        expect(await job.status()).toBe("cancelled");
        expect(fake.state().requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
    });

    it("keeps running when the paid step started: cancellable false, then it succeeds and is charged", async () => {
        await fetch(`${fake.url}/__test/paid-started?tool=video-upscale`);
        // Long enough running for the cancel to land while it runs (polls are 5 ms apart here).
        await fetch(`${fake.url}/__test/task-steps?n=100`);
        const p = await provider();
        const job = p.run!({ capability: "video.upscale", input: { videoUrl: `${fake.url}/files/generated.webm` } });
        const updates: JobUpdate[] = [];
        job.subscribe?.((u) => updates.push(u));
        // A server stage means the task exists (the paid-started knob refuses cancels from then on); a loaded machine
        // may already be past "Reading".
        await vi.waitFor(() => expect(updates.some((u) => u.message === "Reading" || u.message === "Upscaling")).toBe(true), { timeout: 10_000 });
        await job.cancel();
        expect(updates.some((u) => u.cancellable === false && u.message === CANCEL_REFUSED_MESSAGE)).toBe(true);
        const output = await job.result();
        expect(output.costUsd).toBe(FAKE_TOOL_PRICES["video-upscale"]["1080p"]);
        expect(await job.status()).toBe("succeeded");
    });

    it("cancels locally before the task exists", async () => {
        let release!: () => void;
        const slow: MediaPreparer = (input, purpose, signal) => new Promise((resolve, reject) => {
            release = () => resolve({ data: new Uint8Array([1]), contentType: "audio/wav", filename: "a.wav", sizeBytes: 1, durationSeconds: 1 });
            signal.addEventListener("abort", () => reject(new JobCancelledError()), { once: true });
            void input;
            void purpose;
        });
        const p = await provider({ prepareMedia: slow });
        const job = p.run!({ capability: "audio.isolate-voice", input: { source: SOURCE } });
        await vi.waitFor(() => expect(release).toBeDefined());
        await job.cancel();
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        expect(fake.state().requests.filter((r) => r.method === "POST")).toEqual([]);
    });
});

describe("cloud captions", () => {
    it("transcribes a media range: 16 kHz WAV, the language when it is a code, words grouped into segments", async () => {
        const { prepare, calls } = preparer(2.4);
        const p = await provider({ prepareMedia: prepare });
        const transcript = await p.audio!.transcribe!({ audio: { kind: "media", url: "opennan-local://media/a", startSeconds: 1, endSeconds: 3.4 }, language: "en" }).result();
        expect(calls[0]).toEqual({
            input: { kind: "media", source: { mediaUrl: "opennan-local://media/a", startSeconds: 1, endSeconds: 3.4 } },
            purpose: { output: "audio", sampleRate: 16000, maxBytes: 200 * 1024 * 1024, maxSeconds: 1800, contentTypes: ["audio/wav"] },
        });
        expect(posts("/v1/audio/transcriptions")[0]!.body).toEqual({ audio_url: expect.any(String), language: "en" });
        expect(transcript).toEqual({
            language: "en", durationSeconds: 2.4, model: "cloud", costUsd: FAKE_TOOL_PRICES.transcribe,
            segments: [
                { start: 0.1, end: 1.0, text: "Hello there.", words: [{ text: "Hello", start: 0.1, end: 0.4 }, { text: "there.", start: 0.5, end: 1.0 }] },
                { start: 1.2, end: 2.3, text: "How are you?", words: [{ text: "How", start: 1.2, end: 1.5 }, { text: "are", start: 1.6, end: 1.8 }, { text: "you?", start: 1.9, end: 2.3 }] },
            ],
        });
    });

    it("prepares the timeline mix and omits auto language", async () => {
        const { prepare, calls } = preparer(2);
        const p = await provider({ prepareMedia: prepare });
        await p.audio!.transcribe!({ audio: { kind: "timeline", snapshot: { tracks: [] } }, language: "auto" }).result();
        expect(calls[0]!.input).toEqual({ kind: "timeline", snapshot: { tracks: [] } });
        expect(posts("/v1/audio/transcriptions")[0]!.body).toEqual({ audio_url: expect.any(String) });
    });

    it("loses to an on-device provider in routing, and runs as the cloud engine", async () => {
        const p = await provider();
        const registry = new ProviderRegistry();
        registry.register(p);
        expect(registry.route("audio.transcribe")?.info.id).toBe("opennan");
        registry.register({ info: { id: "local", name: "On this device", capabilities: ["audio.transcribe"], onDevice: true } });
        expect(registry.route("audio.transcribe")?.info.id).toBe("local");
        expect(registry.providerFor("audio.transcribe", { onDevice: false })?.info.id).toBe("opennan");
    });

    it("puts a word outside every segment in the nearest one", () => {
        const transcript = transcriptOf({ language: "en", segments: [{ start: 0, end: 1, text: "a" }, { start: 2, end: 3, text: "b" }], words: [{ text: "x", start: 1.6, end: 1.8 }] }, undefined);
        expect(transcript.segments[1]!.words).toEqual([{ text: "x", start: 1.6, end: 1.8 }]);
        expect(transcript.segments[0]!.words).toBeUndefined();
    });
});
