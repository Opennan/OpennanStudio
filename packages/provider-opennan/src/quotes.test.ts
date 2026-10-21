// POST /v1/quotes (phase 11.1): the body Studio asks a quote for, and the client's cache and fallbacks.
import { createOpenNanApi } from "./api";
import { QUOTE_IMAGE_PLACEHOLDER, canonicalBody, createQuoteClient, quoteBody } from "./quotes";

describe("quoteBody: the call's own body, the prompt left out", () => {
    it("per-unit tools: seconds with the decode margin, capped at the longest input", () => {
        expect(quoteBody("audio.transcribe", {}, { seconds: 10 })).toEqual({ tool: "transcribe", seconds: 10.3 });
        expect(quoteBody("audio.isolate-voice", {}, { seconds: 599.9 })).toEqual({ tool: "voice-isolation", seconds: 600 });
        expect(quoteBody("video.remove-background", { background: "green" }, { seconds: 4 })).toEqual({ tool: "remove-background", seconds: 4.27 });
        expect(quoteBody("video.lipsync", {}, { seconds: 60 })).toEqual({ tool: "lipsync", seconds: 60 });
        expect(quoteBody("video.upscale", { resolution: "4k" }, { seconds: 2 })).toEqual({ tool: "video-upscale", seconds: 2.26, resolution: "4k" });
        expect(quoteBody("video.upscale", {}, { seconds: 2, resolution: "2k" })).toEqual({ tool: "video-upscale", seconds: 2.26, resolution: "2k" });
        expect(quoteBody("video.upscale", {}, { seconds: 2 })).toEqual({ tool: "video-upscale", seconds: 2.26, resolution: "1080p" });
        // No length, no quote (the estimate decides; a quote without seconds is the hold).
        expect(quoteBody("audio.transcribe", {}, {})).toBeNull();
        // Past the tool's limit nothing is quoted (the server would refuse the run; the padding never hides it).
        expect(quoteBody("video.lipsync", {}, { seconds: 60.5 })).toBeNull();
        expect(quoteBody("audio.isolate-voice", {}, { seconds: 600 })).toEqual({ tool: "voice-isolation", seconds: 600 });
    });

    it("caption translation: its lines as sent; sound effects: the asked seconds", () => {
        const segments = [{ start: 0, end: 1, text: "Hello" }];
        expect(quoteBody("captions.translate", { segments, targetLanguage: "th", expectedMaxUsd: 1 }, {})).toEqual({ tool: "caption-translate", segments });
        expect(quoteBody("captions.translate", { segments: "x" }, {})).toBeNull();
        expect(quoteBody("audio.sfx", { description: "rain", durationSeconds: 4 }, {})).toEqual({ tool: "sound-effects", seconds: 4 });
        expect(quoteBody("audio.sfx", { description: "rain" }, {})).toEqual({ tool: "sound-effects" });
    });

    it("models: the generation body's priced fields, image inputs as a placeholder link", () => {
        expect(quoteBody("video.text-to-video", { description: "a cat", durationSeconds: 5, aspectRatio: "9:16" }, {}, "kling-3")).toEqual({ model: "kling-3", duration: 5, aspect_ratio: "9:16" });
        expect(quoteBody("video.image-to-video", { description: "a cat", durationSeconds: 10 }, {}, "kling-3")).toEqual({ model: "kling-3", duration: 10, image: QUOTE_IMAGE_PLACEHOLDER });
        // Only what the call sends: units alone do not change the body (the call would get the server's default length).
        expect(quoteBody("video.image-to-video", { description: "a cat" }, { seconds: 10 }, "kling-3")).toEqual({ model: "kling-3", image: QUOTE_IMAGE_PLACEHOLDER });
        expect(quoteBody("audio.music", { description: "x" }, { seconds: 20 }, "ace-step")).toEqual({ model: "ace-step" });
        expect(quoteBody("audio.sfx", { description: "x" }, { seconds: 2 })).toEqual({ tool: "sound-effects" });
        expect(quoteBody("video.text-to-video", { durationSeconds: 5, endImage: { mediaUrl: "opennan-local://media/a" } }, {}, "kling-3")).toEqual({ model: "kling-3", duration: 5, end_image: QUOTE_IMAGE_PLACEHOLDER });
        expect(quoteBody("video.text-to-video", { durationSeconds: 5.5 }, {}, "kling-3")).toBeNull();
        expect(quoteBody("image.generate", { description: "x", aspectRatio: "1:1" }, { images: 0 }, "nano-banana-2")).toEqual({ model: "nano-banana-2", aspect_ratio: "1:1" });
        expect(quoteBody("image.edit", { description: "x" }, {}, "nano-banana-2")).toEqual({ model: "nano-banana-2", image: QUOTE_IMAGE_PLACEHOLDER });
        expect(quoteBody("audio.tts", { text: "héllo 👋", voice: "heart" }, {}, "kokoro")).toEqual({ model: "kokoro", characters: 7 });
        expect(quoteBody("audio.tts", { text: "" }, {}, "kokoro")).toBeNull();
        // The text sent wins over a smaller count a caller passed.
        expect(quoteBody("audio.tts", { text: "x".repeat(1500) }, { characters: 10 }, "kokoro")).toEqual({ model: "kokoro", characters: 1500 });
        expect(quoteBody("audio.music", { description: "x", durationSeconds: 60 }, {}, "ace-step")).toEqual({ model: "ace-step", duration: 60 });
        expect(quoteBody("audio.music", { description: "x" }, {}, "ace-step")).toEqual({ model: "ace-step" });
        expect(quoteBody("audio.separate", { stems: "all" }, { seconds: 120 }, "demucs")).toEqual({ model: "demucs", seconds: 120.85 });
        expect(quoteBody("image.generate", {}, {})).toBeNull();
        expect(quoteBody("opennan.qc", {}, {}, "x")).toBeNull();
    });

    it("the prompt never changes the body (a typed prompt reuses the quote)", () => {
        const a = quoteBody("video.text-to-video", { description: "a", durationSeconds: 5 }, {}, "kling-3");
        const b = quoteBody("video.text-to-video", { description: "a cat on a roof", durationSeconds: 5 }, {}, "kling-3");
        expect(canonicalBody(a!)).toBe(canonicalBody(b!));
    });
});

interface Call { path: string; body: unknown; auth: string | null }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const QUOTE = { object: "quote", model: null, tool: "transcribe", currency: "usd", price_usd: 0.004768, hold_usd: 0.143049, priced: { seconds: 10.3 } };

function scripted(answer: (call: Call, n: number) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = { path: new URL(String(input)).pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init.headers).get("authorization") };
        calls.push(call);
        return answer(call, calls.length);
    }) as typeof globalThis.fetch;
    return { api: createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }), calls };
}

describe("createQuoteClient", () => {
    it("posts without a key and reads price_usd, hold_usd and priced", async () => {
        const { api, calls } = scripted(() => json(200, QUOTE));
        const client = createQuoteClient(api);
        expect(await client.quote({ tool: "transcribe", seconds: 10.3 })).toEqual({ kind: "quote", priceUsd: 0.004768, holdUsd: 0.143049, priced: { seconds: 10.3 } });
        expect(calls).toEqual([{ path: "/v1/quotes", body: { tool: "transcribe", seconds: 10.3 }, auth: null }]);
    });

    it("caches per canonical body for a minute and shares a request in flight", async () => {
        let now = 0;
        const { api, calls } = scripted(() => json(200, QUOTE));
        const client = createQuoteClient(api, { now: () => now });
        await Promise.all([client.quote({ tool: "transcribe", seconds: 10.3 }), client.quote({ seconds: 10.3, tool: "transcribe" })]);
        await client.quote({ seconds: 10.3, tool: "transcribe" });
        expect(calls).toHaveLength(1);
        await client.quote({ tool: "transcribe", seconds: 20 });
        expect(calls).toHaveLength(2);
        now += 61_000;
        await client.quote({ tool: "transcribe", seconds: 10.3 });
        expect(calls).toHaveLength(3);
    });

    it("an older server (404) is not asked again for ten minutes: the estimate answers", async () => {
        let now = 0;
        const { api, calls } = scripted(() => json(404, { detail: "Not Found" }));
        const client = createQuoteClient(api, { now: () => now });
        expect(await client.quote({ tool: "transcribe", seconds: 1 })).toEqual({ kind: "fallback", reason: "unsupported" });
        expect(await client.quote({ tool: "transcribe", seconds: 2 })).toEqual({ kind: "fallback", reason: "unsupported" });
        expect(calls).toHaveLength(1);
        now += 10 * 60_000 + 1;
        await client.quote({ tool: "transcribe", seconds: 2 });
        expect(calls).toHaveLength(2);
    });

    it("a rate limit (429) waits Retry-After (60 s without it); 503 and bad answers fall back without a pause", async () => {
        let now = 0;
        let answer: () => Response = () => json(429, { error: { type: "rate_limit_error", message: "slow", code: "rate_limit_exceeded" } }, { "retry-after": "30" });
        const { api, calls } = scripted(() => answer());
        const client = createQuoteClient(api, { now: () => now });
        expect(await client.quote({ tool: "transcribe", seconds: 1 })).toEqual({ kind: "fallback", reason: "rate-limited" });
        now += 29_000;
        expect((await client.quote({ tool: "transcribe", seconds: 1 })).kind).toBe("fallback");
        expect(calls).toHaveLength(1);
        now += 1_001;
        answer = () => json(503, { error: { type: "unavailable", message: "x", code: "unavailable" } });
        expect(await client.quote({ tool: "transcribe", seconds: 1 })).toEqual({ kind: "fallback", reason: "unavailable" });
        expect(calls).toHaveLength(2);
        answer = () => json(200, { ...QUOTE, price_usd: "free" });
        expect((await client.quote({ tool: "transcribe", seconds: 1 })).kind).toBe("fallback");
        answer = () => json(200, { ...QUOTE, price_usd: 0 });
        expect((await client.quote({ tool: "transcribe", seconds: 1 })).kind).toBe("fallback");
        expect(calls).toHaveLength(4);
    });

    it("a refusal (400) is told with its code and cached like an answer", async () => {
        const { api, calls } = scripted(() => json(400, { error: { type: "invalid_request_error", message: "kling-3 does not offer 4k", code: "tier_not_offered" } }));
        const client = createQuoteClient(api);
        expect(await client.quote({ model: "kling-3", quality: "4k" })).toEqual({ kind: "refused", code: "tier_not_offered" });
        await client.quote({ model: "kling-3", quality: "4k" });
        expect(calls).toHaveLength(1);
    });

    it("a stalled quote gives up after its timeout and falls back (a run never hangs on a price)", async () => {
        const fetch = ((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as typeof globalThis.fetch;
        const api = createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch });
        const started = Date.now();
        expect(await createQuoteClient(api, { timeoutMs: 50 }).quote({ tool: "transcribe", seconds: 1 })).toEqual({ kind: "fallback", reason: "unavailable" });
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("a network failure falls back", async () => {
        const { api } = scripted(() => {
            throw new TypeError("offline");
        });
        expect(await createQuoteClient(api).quote({ tool: "transcribe", seconds: 1 })).toEqual({ kind: "fallback", reason: "unavailable" });
    });
});
