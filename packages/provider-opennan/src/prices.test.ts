import {
    captionBilledCharacters, estimateImageCost, estimateMusicCost, estimateStemsCost, estimateToolCost, estimateVideoModelCost, estimateVoiceCost,
    type CostEstimate, type PriceAnswer, type ToolPriceBlock,
} from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { createOpenNanProvider } from "./provider";
import { OpenNanSession, memoryCredentialStore } from "./session";
import { FAKE_TOOL_PRICES, fakeToolSettle, startFakeOpenNan, type FakeOpenNan } from "./testing";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan();
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

function provider(fetch?: typeof globalThis.fetch) {
    const api = createOpenNanApi({ baseUrl: fake.url, ...(fetch ? { fetch } : {}) });
    // Signed out: prices need no key.
    return createOpenNanProvider(new OpenNanSession({ api, store: memoryCredentialStore(), deviceName: "t", client: "web" }));
}

const estimate = (value: CostEstimate | unknown): PriceAnswer => ({ kind: "estimate", estimate: value as CostEstimate });
const TRANSCRIBE: ToolPriceBlock = { unit: "source_minute", per: "minute", usd: FAKE_TOOL_PRICES.transcribe, max_minutes: 30 };

describe("OpenNan prices without quotes (an older server: the never-under estimate)", () => {
    beforeEach(async () => {
        await fetch(`${fake.url}/__test/quotes?status=404`);
    });

    it("prices the media tools from GET /v1/tools", async () => {
        const p = provider();
        expect(await p.price!({ capability: "audio.transcribe", input: {}, units: { seconds: 30 } })).toMatchObject(estimate(estimateToolCost(TRANSCRIBE, { seconds: 30 })));
        const segments = [{ start: 0, end: 1, text: "Hello 👋" }, { start: 1, end: 2, text: "Bye" }];
        const translate = await p.price!({ capability: "captions.translate", input: { segments, targetLanguage: "th" }, units: {} });
        expect(translate).toMatchObject(estimate(estimateToolCost(
            { unit: "thousand_characters", usd: FAKE_TOOL_PRICES["caption-translate"], max_characters: 30000, max_segments: 2000, segment_overhead_characters: 10 },
            { characters: captionBilledCharacters(segments), segments: 2 },
        )));
        const upscale = await p.price!({ capability: "video.upscale", input: { resolution: "4k" }, units: { seconds: 10 } });
        expect(upscale.kind === "estimate" && upscale.estimate.microUsd).toBe((estimateToolCost(
            { unit: "video_second", usd: 0.00936, max_seconds: 60, tiers: [{ resolution: "4k", usd: 0.03744 }] }, { seconds: 10, resolution: "4k" },
        ) as CostEstimate).microUsd);
        expect(await p.price!({ capability: "video.lipsync", input: {}, units: { seconds: 61 } })).toEqual({ kind: "over-limit", limit: { kind: "seconds", max: 60, actual: 61 } });
        const sfx = await p.price!({ capability: "audio.sfx", input: { durationSeconds: 3 }, units: {} });
        expect(sfx).toMatchObject({ kind: "estimate", estimate: { units: 3, microUsd: 3 * 2601 } });
        expect(await p.price!({ capability: "audio.isolate-voice", input: {}, units: { seconds: 61 } })).toMatchObject({ kind: "estimate", estimate: { units: 2 } });
        expect(await p.price!({ capability: "video.remove-background", input: {}, units: { seconds: 4 } })).toMatchObject({ kind: "estimate" });
    });

    it("prices models from GET /v1/models", async () => {
        const p = provider();
        expect(await p.price!({ capability: "image.generate", input: {}, units: { images: 1 } })).toMatchObject({ kind: "estimate", estimate: { source: "estimate" } });
        expect(await p.price!({ capability: "image.generate", input: {}, units: { images: 1 } })).toMatchObject(estimate(estimateImageCost({ from_usd: 0.039, per_input_image_usd: 0.002 }, 1)));
        expect(await p.price!({ capability: "image.edit", input: { model: "seedream-4" }, units: {} })).toMatchObject(estimate(estimateImageCost({ from_usd: 0.03 }, 0)));
        const kling = { matrix: [{ ours_usd_per_second: 0.08 }, { ours_usd_per_second: 0.14 }] };
        expect(await p.price!({ capability: "video.image-to-video", input: {}, units: { images: 1 } })).toMatchObject(estimate(estimateVideoModelCost(kling, 5)));
        expect(await p.price!({ capability: "video.text-to-video", input: { durationSeconds: 10 }, units: {} })).toMatchObject(estimate(estimateVideoModelCost(kling, 10)));
        expect(await p.price!({ capability: "video.text-to-video", input: { model: "seedance-2" }, units: { seconds: 5 } })).toMatchObject(estimate(estimateVideoModelCost({ matrix: [{ ours_usd_per_second: 0.1 }] }, 5)));
        expect(await p.price!({ capability: "audio.tts", input: { text: "héllo 👋", voice: "heart" }, units: {} })).toMatchObject(estimate(estimateVoiceCost({ billing_block_characters: 1000, minimum_usd: 0.026 }, 7)));
        expect(await p.price!({ capability: "audio.music", input: { durationSeconds: 60 }, units: {} })).toMatchObject(estimate(estimateMusicCost({ from_usd: 0.0156 }, 60)));
        expect(await p.price!({ capability: "audio.separate", input: { stems: "all" }, units: { seconds: 120 } })).toMatchObject(estimate(estimateStemsCost({ minimum_usd: 0.01, base_usd: 0.0115, per_minute_usd: 0.0023 }, 120)));
    });

    it("says when a tool is not live, and when units or a model are missing", async () => {
        const p = provider();
        await fetch(`${fake.url}/__test/tool-status?id=voice-isolation&status=unavailable`);
        await fetch(`${fake.url}/__test/tool-status?id=lipsync&status=soon`);
        expect(await p.price!({ capability: "audio.isolate-voice", input: {}, units: { seconds: 10 } })).toEqual({ kind: "unavailable", reason: "Voice isolation is unavailable on OpenNan right now." });
        expect(await p.price!({ capability: "video.lipsync", input: {}, units: { seconds: 10 } })).toEqual({ kind: "unavailable", reason: "Lip sync is coming soon on OpenNan." });
        expect((await p.price!({ capability: "audio.transcribe", input: {}, units: {} })).kind).toBe("unknown");
        expect((await p.price!({ capability: "image.generate", input: { model: "nope" }, units: {} })).kind).toBe("unknown");
        expect((await p.price!({ capability: "opennan.qc", input: {}, units: {} })).kind).toBe("unknown");
    });

    it("caches the lists for ten minutes per provider", async () => {
        const p = provider();
        await p.price!({ capability: "audio.transcribe", input: {}, units: { seconds: 1 } });
        await p.price!({ capability: "video.upscale", input: {}, units: { seconds: 1 } });
        await p.price!({ capability: "audio.tts", input: { text: "hi" }, units: {} });
        await p.price!({ capability: "audio.tts", input: { text: "hey" }, units: {} });
        const paths = fake.state().requests.map((r) => r.path);
        expect(paths.filter((path) => path === "/v1/tools")).toHaveLength(1);
        expect(paths.filter((path) => path === "/v1/models")).toHaveLength(1);
    });

    it("answers unknown when the lists cannot be read", async () => {
        const offline = provider((async () => { throw new TypeError("offline"); }) as typeof globalThis.fetch);
        expect(await offline.price!({ capability: "audio.transcribe", input: {}, units: { seconds: 1 } })).toEqual({ kind: "unknown", reason: "OpenNan prices are not available right now." });
        expect((await offline.price!({ capability: "image.generate", input: {}, units: {} })).kind).toBe("unknown");
    });

    it("lists voices and models with their price blocks", async () => {
        const p = provider();
        expect(await p.voices!()).toEqual([
            { id: "heart", name: "Heart", language: "en-US", gender: "female", model: "kokoro" },
            { id: "adam", name: "Adam", language: "en-US", gender: "male", model: "kokoro" },
            { id: "emma", name: "Emma", language: "en-GB", gender: "female", model: "kokoro" },
        ]);
        await p.voices!();
        expect(fake.state().requests.filter((r) => r.path === "/v1/audio/voices")).toHaveLength(1);
        const video = await p.models!("video.image-to-video");
        expect(video[0]).toMatchObject({ id: "kling-3", label: "Kling 3", default: true, durations: [5, 10], price: { from_usd: 0.4 } });
        expect((await p.models!("audio.music")).map((m) => m.id)).toEqual(["ace-step"]);
        expect((await p.models!("audio.separate")).map((m) => m.id)).toEqual(["demucs"]);
        expect(await p.models!("audio.transcribe")).toEqual([{ id: "cloud", label: "OpenNan cloud", default: true }]);
        expect(await p.audio!.models!("audio.transcribe")).toEqual([{ id: "cloud", label: "OpenNan cloud", default: true }]);
    });
});

describe("OpenNan prices from POST /v1/quotes (phase 11.1)", () => {
    const quotes = () => fake.state().requests.filter((r) => r.path === "/v1/quotes");

    it("shows the quote's settle for a video model, not the worst row × length", async () => {
        const p = provider();
        const answer = await p.price!({ capability: "video.text-to-video", input: { description: "a cat", durationSeconds: 10 }, units: {} });
        expect(answer).toEqual({ kind: "estimate", estimate: { microUsd: 800_000, usd: 0.8, label: "≈ $0.800", units: 10, capped: false, source: "quote", holdUsd: 0.8 } });
        expect(quotes()[0]).toMatchObject({ method: "POST", authorized: false, body: { model: "kling-3", duration: 10 } });
        // The worst-row estimate would have said $1.41.
        expect(estimateVideoModelCost({ matrix: [{ ours_usd_per_second: 0.08 }, { ours_usd_per_second: 0.14 }] }, 10)!.label).toBe("≈ $1.41");
    });

    it("quotes per-unit tools with the decode margin and keeps the hold for the balance check", async () => {
        const p = provider();
        const answer = await p.price!({ capability: "audio.transcribe", input: {}, units: { seconds: 30 } });
        expect(answer).toMatchObject({ kind: "estimate", estimate: { microUsd: 4_768, label: "≈ $0.005", source: "quote", holdUsd: fakeToolSettle("transcribe", { seconds: 1800 }) } });
        expect(quotes()[0]!.body).toEqual({ tool: "transcribe", seconds: 30.4 });
        const upscale = await p.price!({ capability: "video.upscale", input: { resolution: "4k" }, units: { seconds: 10 } });
        expect(upscale).toMatchObject({ kind: "estimate", estimate: { usd: fakeToolSettle("video-upscale", { seconds: 10.3, resolution: "4k" }), source: "quote" } });
        const segments = [{ start: 0, end: 1, text: "Hello 👋" }];
        expect(await p.price!({ capability: "captions.translate", input: { segments, targetLanguage: "th" }, units: {} })).toMatchObject({ kind: "estimate", estimate: { usd: FAKE_TOOL_PRICES["caption-translate"], source: "quote" } });
    });

    it("quotes models with their own body: speech characters, music length, stems with the margin", async () => {
        const p = provider();
        expect(await p.price!({ capability: "audio.tts", input: { text: "x".repeat(1001), voice: "heart" }, units: {} })).toMatchObject({ estimate: { usd: 0.052, source: "quote" } });
        expect(await p.price!({ capability: "audio.music", input: { description: "x" }, units: {} })).toMatchObject({ estimate: { usd: 0.0078, source: "quote" } });
        expect(await p.price!({ capability: "image.edit", input: { description: "x" }, units: {} })).toMatchObject({ estimate: { usd: 0.041, source: "quote" } });
        const stems = await p.price!({ capability: "audio.separate", input: { stems: "all" }, units: { seconds: 120 } });
        expect(stems).toMatchObject({ estimate: { source: "quote" } });
        expect(quotes().at(-1)!.body).toEqual({ model: "demucs", seconds: 120.85 });
    });

    it("a typed prompt asks no new quote", async () => {
        const p = provider();
        await p.price!({ capability: "video.text-to-video", input: { description: "a", durationSeconds: 5 }, units: {} });
        await p.price!({ capability: "video.text-to-video", input: { description: "a cat on a roof", durationSeconds: 5 }, units: {} });
        expect(quotes()).toHaveLength(1);
    });

    it("never quotes past a tool's limit or a tool that is not live", async () => {
        const p = provider();
        expect(await p.price!({ capability: "video.lipsync", input: {}, units: { seconds: 61 } })).toEqual({ kind: "over-limit", limit: { kind: "seconds", max: 60, actual: 61 } });
        await fetch(`${fake.url}/__test/tool-status?id=voice-isolation&status=unavailable`);
        expect((await provider().price!({ capability: "audio.isolate-voice", input: {}, units: { seconds: 10 } })).kind).toBe("unavailable");
        expect(quotes()).toEqual([]);
    });

    it.each(["404", "429", "503"])("falls back to the never-under estimate on %s", async (status) => {
        await fetch(`${fake.url}/__test/quotes?status=${status}`);
        const p = provider();
        const answer = await p.price!({ capability: "audio.transcribe", input: {}, units: { seconds: 30 } });
        expect(answer).toMatchObject({ kind: "estimate", estimate: { ...(estimateToolCost(TRANSCRIBE, { seconds: 30 }) as CostEstimate), source: "estimate" } });
        expect((answer as { estimate: CostEstimate }).estimate.holdUsd).toBe((estimateToolCost(TRANSCRIBE, { seconds: 1800 }) as CostEstimate).usd);
        const video = await p.price!({ capability: "video.text-to-video", input: { durationSeconds: 10 }, units: {} });
        expect(video).toMatchObject({ kind: "estimate", estimate: { label: "≈ $1.41", source: "estimate", holdUsd: 1.40001 } });
    });
});

describe("prices follow the call, not a caller's units (phase 11.1 review)", () => {
    it("speech is priced on the text sent; video, music and sound effects on the length sent", async () => {
        await fetch(`${fake.url}/__test/quotes?status=404`);
        const p = provider();
        expect(await p.price!({ capability: "audio.tts", input: { text: "x".repeat(1500) }, units: { characters: 10 } })).toMatchObject({ estimate: { units: 2 } });
        const kling = { matrix: [{ ours_usd_per_second: 0.08 }, { ours_usd_per_second: 0.14 }] };
        expect(await p.price!({ capability: "video.text-to-video", input: { durationSeconds: 10 }, units: { seconds: 5 } })).toMatchObject(estimate(estimateVideoModelCost(kling, 10)));
        expect(await p.price!({ capability: "audio.music", input: { durationSeconds: 60 }, units: { seconds: 10 } })).toMatchObject(estimate(estimateMusicCost({ from_usd: 0.0156 }, 60)));
        expect(await p.price!({ capability: "audio.sfx", input: { durationSeconds: 5 }, units: { seconds: 2 } })).toMatchObject({ estimate: { units: 5 } });
    });
});

describe("catalog reads are bounded (review round 2)", () => {
    it("a stalled GET /v1/tools answers unknown after its timeout instead of hanging", async () => {
        const { createOpenNanCatalog } = await import("./prices");
        const fetch = ((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as typeof globalThis.fetch;
        const catalog = createOpenNanCatalog(createOpenNanApi({ baseUrl: fake.url, fetch }), { timeoutMs: 50 });
        const started = Date.now();
        await expect(catalog.tools()).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});
