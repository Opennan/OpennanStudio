// Property tests (phase 11.1): the label is never below what the server settles at, on the quote path (POST
// /v1/quotes asked with the decode margin) and on the fallback path (the local estimate when there is no quote), at
// the fake server's rates (which mirror the server's pricing functions, sub-micro unit costs included).
import {
    BILLING_SAFETY, displayedUsd, estimateImageCost, estimateMusicCost, estimateStemsCost, estimateToolCost, estimateVideoModelCost, estimateVoiceCost,
    isOverLimit, quotedEstimate, type CostEstimate, type ProviderCapability, type ToolPriceBlock,
} from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { createOpenNanProvider } from "./provider";
import { quoteBody } from "./quotes";
import { OpenNanSession, memoryCredentialStore } from "./session";
import { FAKE_TOOL_PRICES, FAKE_TOOL_UNITS, fakeQuote, fakeToolSettle, startFakeOpenNan, type FakeOpenNan, type FakePricedTool } from "./testing";

/** A small seeded generator, so a failure names a case that can be replayed. */
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

const MICRO = 1_000_000;
const labelMicro = (estimate: CostEstimate) => Math.round(displayedUsd(estimate.microUsd) * MICRO);
const settleMicro = (usd: number) => Math.round(usd * MICRO);
/** The most the server may decode past the length Studio sends (the margin the estimate and quotes add). */
const margin = (seconds: number) => BILLING_SAFETY.seconds + seconds * BILLING_SAFETY.ratio;

const TOOLS: Array<{ capability: ProviderCapability; tool: FakePricedTool; block: ToolPriceBlock; resolution?: string }> = [
    { capability: "audio.transcribe", tool: "transcribe", block: { unit: "source_minute", usd: FAKE_TOOL_PRICES.transcribe, max_minutes: 30 } },
    { capability: "audio.isolate-voice", tool: "voice-isolation", block: { unit: "source_minute", usd: FAKE_TOOL_PRICES["voice-isolation"], max_minutes: 10 } },
    { capability: "video.remove-background", tool: "remove-background", block: { unit: "video_second", usd: FAKE_TOOL_PRICES["remove-background"], max_seconds: 120 } },
    { capability: "video.lipsync", tool: "lipsync", block: { unit: "audio_second", usd: FAKE_TOOL_PRICES.lipsync, max_seconds: 60 } },
    ...(["1080p", "2k", "4k"] as const).map((resolution) => ({
        capability: "video.upscale" as ProviderCapability, tool: "video-upscale" as FakePricedTool, resolution,
        block: { unit: "video_second", usd: 0.00936, max_seconds: 60, tiers: [{ resolution, usd: FAKE_TOOL_PRICES["video-upscale"][resolution] }] } as ToolPriceBlock,
    })),
];

describe("never under the settle: per-unit tools", () => {
    it.each(TOOLS)("$tool $resolution: quote path and fallback path, over every length and decode drift", ({ capability, tool, block, resolution }) => {
        const next = random(tool.length * 7919 + (resolution?.length ?? 0));
        const max = FAKE_TOOL_UNITS[tool]!.maxSeconds;
        let cases = 0;
        for (let seconds = 0.001; seconds <= max; seconds += 0.0371 + next() * 0.05) {
            // What the server decodes: up to the margin past what Studio planned (and never past the tool's limit).
            const decoded = Math.min(max, seconds + next() * margin(seconds));
            const settle = settleMicro(fakeToolSettle(tool, { seconds: decoded, ...(resolution ? { resolution } : {}) }));
            const body = quoteBody(capability, resolution ? { resolution } : {}, { seconds })!;
            const answer = fakeQuote(body);
            expect(answer.status).toBe(200);
            const quoted = quotedEstimate({ priceUsd: answer.body.price_usd as number, holdUsd: answer.body.hold_usd as number, units: 1 });
            if (labelMicro(quoted) < settle) throw new Error(`quote under the settle: ${tool} ${resolution ?? ""} ${seconds}s decoded ${decoded}s: label ${labelMicro(quoted)} < ${settle}`);
            if (settleMicro(quoted.holdUsd!) < settle) throw new Error(`hold under the settle: ${tool} ${seconds}s`);
            const local = estimateToolCost(block, { seconds, ...(resolution ? { resolution } : {}) });
            if (local === null || isOverLimit(local)) throw new Error(`no estimate for ${tool} ${seconds}s`);
            if (labelMicro(local) < settle) throw new Error(`estimate under the settle: ${tool} ${resolution ?? ""} ${seconds}s decoded ${decoded}s: label ${labelMicro(local)} < ${settle}`);
            cases += 1;
        }
        expect(cases).toBeGreaterThan(500);
    });

    it("caption translation: the quote is the settle and the estimate is never below it", () => {
        const next = random(42);
        const block: ToolPriceBlock = { unit: "thousand_characters", usd: FAKE_TOOL_PRICES["caption-translate"], max_characters: 30000, max_segments: 2000, segment_overhead_characters: 10 };
        for (let n = 0; n < 400; n += 1) {
            const lines = Array.from({ length: 1 + Math.floor(next() * 60) }, (_, i) => ({ start: i, end: i + 1, text: "ab😀ç ".repeat(1 + Math.floor(next() * 20)).trim() }));
            const settle = settleMicro(fakeToolSettle("caption-translate", { segments: lines }));
            const answer = fakeQuote(quoteBody("captions.translate", { segments: lines }, {})!);
            expect(settleMicro(answer.body.price_usd as number)).toBe(settle);
            const characters = lines.reduce((sum, l) => sum + [...l.text].length + 10, 0);
            const local = estimateToolCost(block, { characters, segments: lines.length });
            if (local === null || isOverLimit(local)) throw new Error("no estimate");
            expect(labelMicro(local)).toBeGreaterThanOrEqual(settle);
        }
    });
});

describe("never under the settle: models", () => {
    it("video, image, speech, music and stems: quote = settle, fallback estimate ≥ settle", () => {
        const next = random(7);
        for (const duration of [5, 10]) {
            const settle = settleMicro(fakeQuote({ model: "kling-3", duration }).body.price_usd as number);
            const local = estimateVideoModelCost({ matrix: [{ ours_usd: 0.4, duration: 5, ours_usd_per_second: 0.08 }, { ours_usd: 0.7, duration: 5, ours_usd_per_second: 0.14 }] }, duration)!;
            expect(labelMicro(local)).toBeGreaterThanOrEqual(settle);
        }
        for (const images of [0, 1]) {
            const settle = settleMicro(fakeQuote({ model: "nano-banana-2", ...(images ? { image: "https://x/a.png" } : {}) }).body.price_usd as number);
            expect(labelMicro(estimateImageCost({ from_usd: 0.039, per_input_image_usd: 0.002 }, images)!)).toBeGreaterThanOrEqual(settle);
        }
        for (let n = 0; n < 2000; n += 1) {
            const characters = 1 + Math.floor(next() * 20_000);
            const settle = settleMicro(fakeQuote({ model: "kokoro", characters }).body.price_usd as number);
            expect(labelMicro(estimateVoiceCost({ billing_block_characters: 1000, minimum_usd: 0.026 }, characters)!)).toBeGreaterThanOrEqual(settle);
            const music = 10 + Math.floor(next() * 230);
            const musicSettle = settleMicro(fakeQuote({ model: "ace-step", duration: music }).body.price_usd as number);
            expect(labelMicro(estimateMusicCost({ from_usd: 0.0156 }, music)!)).toBeGreaterThanOrEqual(musicSettle);
            const song = 0.5 + next() * 890;
            const decoded = Math.min(900, song + next() * margin(song));
            const stemsSettle = settleMicro(fakeQuote({ model: "demucs", seconds: decoded }).body.price_usd as number);
            const stemsQuote = fakeQuote(quoteBody("audio.separate", {}, { seconds: song }, "demucs")!);
            expect(labelMicro(quotedEstimate({ priceUsd: stemsQuote.body.price_usd as number, holdUsd: stemsQuote.body.hold_usd as number, units: 1 }))).toBeGreaterThanOrEqual(stemsSettle);
            expect(labelMicro(estimateStemsCost({ minimum_usd: 0.01, base_usd: 0.0115, per_minute_usd: 0.0023 }, song)!)).toBeGreaterThanOrEqual(stemsSettle);
        }
    });
});

describe("never under the settle: end to end against the fake server", () => {
    let fake: FakeOpenNan;
    beforeAll(async () => {
        fake = await startFakeOpenNan();
    });
    afterAll(() => fake.close());
    beforeEach(() => fake.reset());

    const provider = () => createOpenNanProvider(new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(), deviceName: "t", client: "web" }));

    it.each(["live", "404"])("models (quotes %s): the label shown before a run covers what that very run is charged", async (status) => {
        await fetch(`${fake.url}/__test/quotes?status=${status}`);
        const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore({ apiKey: fake.mintKey(), keyId: "k" }), deviceName: "t", client: "cli" });
        await session.restore();
        const p = createOpenNanProvider(session, { pollIntervalMs: 5 });
        const runs: Array<{ capability: ProviderCapability; input: Record<string, unknown>; units?: Record<string, number> }> = [
            { capability: "image.generate", input: { description: "a cat", aspectRatio: "1:1" } },
            { capability: "image.edit", input: { description: "a cat", image: "https://media.test/a.png" } },
            { capability: "video.text-to-video", input: { description: "waves" } },
            { capability: "video.text-to-video", input: { description: "waves", durationSeconds: 10, aspectRatio: "9:16" } },
            { capability: "video.image-to-video", input: { description: "waves", image: "https://media.test/a.png", durationSeconds: 5 } },
            { capability: "audio.music", input: { description: "piano" } },
            { capability: "audio.music", input: { description: "piano", durationSeconds: 75 } },
        ];
        for (const run of runs) {
            const answer = await p.price!({ capability: run.capability, input: run.input, units: run.units ?? {} });
            if (answer.kind !== "estimate") throw new Error(`no estimate for ${run.capability}: ${JSON.stringify(answer)}`);
            const output = await p.run!({ capability: run.capability, input: run.input }).result();
            expect(output.costUsd, `${run.capability} ${JSON.stringify(run.input)}`).toBeDefined();
            if (labelMicro(answer.estimate) < settleMicro(output.costUsd!)) throw new Error(`label under the charge: ${run.capability} ${JSON.stringify(run.input)}: ${answer.estimate.label} < $${output.costUsd}`);
            // A quote is the charge itself (the label only rounds it up to the next tenth of a cent).
            if (status === "live") expect(answer.estimate.microUsd, `${run.capability} ${JSON.stringify(run.input)}`).toBe(settleMicro(output.costUsd!));
        }
    });

    it.each(["live", "404", "429", "503"])("the provider's label (quotes %s) covers the settle of what the server decodes", async (status) => {
        await fetch(`${fake.url}/__test/quotes?status=${status}`);
        const p = provider();
        const next = random(status.length * 31);
        for (let n = 0; n < 60; n += 1) {
            const { capability, tool, resolution } = TOOLS[n % TOOLS.length]!;
            const max = FAKE_TOOL_UNITS[tool]!.maxSeconds;
            const seconds = Math.min(max, 0.1 + next() * max);
            const answer = await p.price!({ capability, input: resolution ? { resolution } : {}, units: { seconds } });
            if (answer.kind !== "estimate") throw new Error(`no estimate: ${JSON.stringify(answer)}`);
            expect(answer.estimate.source).toBe(status === "live" ? "quote" : "estimate");
            const decoded = Math.min(max, seconds + margin(seconds) - 0.001);
            expect(labelMicro(answer.estimate)).toBeGreaterThanOrEqual(settleMicro(fakeToolSettle(tool, { seconds: decoded, ...(resolution ? { resolution } : {}) })));
        }
    });
});
