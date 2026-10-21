// The fake OpenNan server's phase 11.1 surface: error codes on every error, the cancel refusal codes (busy with
// Retry-After), upload codes, POST /v1/quotes with the server's body rules, and the pricing mirror tests use.
import { FAKE_TOOL_PRICES, fakeQuote, fakeToolSettle, startFakeOpenNan, type FakeOpenNan } from "./testing";

let fake: FakeOpenNan;
let key: string;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => {
    fake.reset();
    key = fake.mintKey();
});

interface Answer { status: number; headers: Headers; body: Record<string, unknown> & { error?: { type?: string; code?: string | null; message?: string } } }

async function call(method: string, path: string, body?: unknown, auth = true): Promise<Answer> {
    const response = await fetch(fake.url + path, {
        method,
        headers: { ...(auth ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : {} };
}

const knob = (path: string) => fetch(fake.url + path).then((r) => r.json());
const quote = (body: unknown) => call("POST", "/v1/quotes", body, false);
const AUDIO = () => `${fake.url}/files/generated.wav`;

async function untilRunning(id: string): Promise<void> {
    let status = "queued";
    while (status === "queued") status = String((await call("GET", `/v1/tasks/${id}`)).body.status);
}

describe("error codes (never null)", () => {
    it("gives every error a code: its own or its type's default", async () => {
        const unauthorized = await call("GET", "/v1/account", undefined, false);
        expect(unauthorized.body.error).toMatchObject({ type: "authentication_error", code: "invalid_api_key" });
        const missing = await call("GET", "/v1/tasks/task_nope");
        expect(missing.body.error).toMatchObject({ type: "not_found", code: "not_found" });
        const invalid = await call("POST", "/v1/audio/isolations", { audio_url: "http://example.com/a.wav" });
        expect(invalid.body.error).toMatchObject({ type: "invalid_request_error", code: "invalid_request" });
        fake.setBalance(0);
        const broke = await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() });
        expect(broke.body.error).toMatchObject({ type: "insufficient_balance", code: "insufficient_balance" });
        fake.setBalance(5);
        await knob("/__test/key-scopes?scopes=api:opennan,api:voice");
        key = fake.mintKey();
        const scope = await call("POST", "/v1/uploads", { filename: "a.wav", content_type: "audio/wav", size_bytes: 4 });
        expect(scope.body.error).toMatchObject({ type: "permission_error", code: "permission_denied" });
        await knob("/__test/tool-status?id=voice-isolation&status=unavailable");
        key = fake.mintKey();
        const off = await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() });
        expect(off.body.error).toMatchObject({ code: "unavailable" });
    });

    it("refuses a cancel after the paid step with task_not_cancellable (same message as before)", async () => {
        await knob("/__test/paid-started?tool=video-upscale");
        await knob("/__test/task-steps?n=3");
        const id = (await call("POST", "/v1/videos/upscales", { video_url: `${fake.url}/files/generated.webm` })).body.id as string;
        await untilRunning(id);
        const refused = await call("POST", `/v1/tasks/${id}/cancel`);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toEqual({ type: "conflict", code: "task_not_cancellable", message: "This task can't be cancelled: it has finished or already started work that is charged." });
    });

    it("refuses a cancel of a finished task with task_already_finished", async () => {
        const id = (await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).body.id as string;
        for (let i = 0; i < 5; i += 1) await call("GET", `/v1/tasks/${id}`);
        const refused = await call("POST", `/v1/tasks/${id}/cancel`);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatchObject({ type: "conflict", code: "task_already_finished" });
    });

    it("never cancels a model run or a separation (task_not_cancellable)", async () => {
        const video = (await call("POST", "/v1/videos/generations", { model: "kling-3", prompt: "a cat" })).body.id as string;
        expect((await call("POST", `/v1/tasks/${video}/cancel`)).body.error).toMatchObject({ code: "task_not_cancellable" });
        const stems = (await call("POST", "/v1/audio/separations", { audio_url: AUDIO() })).body.id as string;
        expect((await call("POST", `/v1/tasks/${stems}/cancel`)).body.error).toMatchObject({ code: "task_not_cancellable" });
    });

    it("cancel-busy answers the next n cancels task_busy_retry with Retry-After: 1, then cancels", async () => {
        await knob("/__test/cancel-busy?n=2");
        const id = (await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).body.id as string;
        for (let i = 0; i < 2; i += 1) {
            const busy = await call("POST", `/v1/tasks/${id}/cancel`);
            expect(busy.status).toBe(409);
            expect(busy.headers.get("retry-after")).toBe("1");
            expect(busy.body.error).toMatchObject({ type: "conflict", code: "task_busy_retry", message: "This task is busy and could not be cancelled right now. Try again." });
        }
        expect((await call("POST", `/v1/tasks/${id}/cancel`)).status).toBe(200);
    });

    it("answers upload refusals with their codes", async () => {
        const missing = await call("POST", "/v1/uploads/up_nope/complete");
        expect(missing.status).toBe(404);
        expect(missing.body.error).toMatchObject({ code: "upload_not_found" });
        const upload = await call("POST", "/v1/uploads", { filename: "a.wav", content_type: "audio/wav", size_bytes: 4 });
        const early = await call("POST", `/v1/uploads/${upload.body.upload_id}/complete`);
        expect(early.status).toBe(409);
        expect(early.body.error).toMatchObject({ type: "conflict", code: "upload_not_received" });
    });

    it("answers tier_not_offered for a video quality it does not sell", async () => {
        const answer = await call("POST", "/v1/videos/generations", { model: "kling-3", prompt: "a cat", quality: "4k" });
        expect(answer.status).toBe(400);
        expect(answer.body.error).toMatchObject({ code: "tier_not_offered" });
    });
});

describe("POST /v1/quotes", () => {
    it("quotes tools from seconds without a key: price_usd is the settle, hold_usd the longest input", async () => {
        const answer = await quote({ tool: "voice-isolation", seconds: 61 });
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({
            object: "quote", model: null, tool: "voice-isolation", currency: "usd",
            price_usd: fakeToolSettle("voice-isolation", { seconds: 61 }), hold_usd: fakeToolSettle("voice-isolation", { seconds: 600 }), priced: { seconds: 61 },
        });
        expect(answer.body.price_usd).toBe(0.26);
        expect(fake.state().requests.at(-1)).toMatchObject({ method: "POST", path: "/v1/quotes", authorized: false });
    });

    it("prices per-unit tools on started units of the length rounded to the millisecond", () => {
        expect(fakeToolSettle("transcribe", { seconds: 60 })).toBe(FAKE_TOOL_PRICES.transcribe);
        expect(fakeToolSettle("transcribe", { seconds: 60.0004 })).toBe(FAKE_TOOL_PRICES.transcribe);
        expect(fakeToolSettle("transcribe", { seconds: 60.001 })).toBeCloseTo(2 * FAKE_TOOL_PRICES.transcribe, 5);
        expect(fakeToolSettle("video-upscale", { seconds: 2.2, resolution: "4k" })).toBeCloseTo(3 * 0.03744, 5);
        expect(fakeToolSettle("lipsync", { seconds: 61 })).toBe(fakeToolSettle("lipsync", { seconds: 60 }));
    });

    it("quotes upscale by resolution, captions by billed characters, and sound effects by seconds", async () => {
        expect((await quote({ tool: "video-upscale", seconds: 10, resolution: "2k" })).body).toMatchObject({ price_usd: fakeToolSettle("video-upscale", { seconds: 10, resolution: "2k" }), priced: { seconds: 10, resolution: "2k" } });
        const segments = [{ start: 0, end: 1, text: "Hello there." }, { start: 1, end: 2, text: "How are you?" }];
        expect((await quote({ tool: "caption-translate", segments })).body).toMatchObject({ price_usd: FAKE_TOOL_PRICES["caption-translate"], priced: { segments: 2, billed_characters: 44 } });
        expect((await quote({ tool: "sound-effects", seconds: 4.2 })).body).toMatchObject({ price_usd: 0.013, hold_usd: 0.013 });
    });

    it("without seconds a per-unit tool's quote is its hold", async () => {
        const answer = await quote({ tool: "remove-background" });
        expect(answer.body.price_usd).toBe(answer.body.hold_usd);
        expect(answer.body.price_usd).toBe(fakeToolSettle("remove-background", { seconds: 120 }));
    });

    it("quotes models from their POST body fields, the prompt optional", async () => {
        expect((await quote({ model: "kling-3", duration: 5 })).body).toMatchObject({ model: "kling-3", tool: null, price_usd: 0.4, hold_usd: 0.4, priced: { quality: "720p", duration: 5, generate_audio: false } });
        expect((await quote({ model: "kling-3", duration: 10, quality: "1080p", image: "https://example.com/a.png" })).body).toMatchObject({ price_usd: 1.4 });
        expect((await quote({ model: "nano-banana-2", image: "https://example.com/a.png" })).body).toMatchObject({ price_usd: 0.041, priced: { input_images: 1 } });
        expect((await quote({ model: "kokoro", characters: 1001 })).body).toMatchObject({ price_usd: 0.052, priced: { characters: 1001 } });
        expect((await quote({ model: "kokoro", input: "héllo" })).body).toMatchObject({ price_usd: 0.026, priced: { characters: 5 } });
        expect((await quote({ model: "ace-step" })).body).toMatchObject({ price_usd: 0.0078, priced: { duration: 30 } });
        expect((await quote({ model: "demucs", seconds: 600 })).body).toMatchObject({ price_usd: 0.0345 });
        expect(fakeQuote({ model: "demucs", seconds: 10 })).toMatchObject({ status: 200, body: { price_usd: 0.011883 } });
    });

    it("refuses what the server refuses", async () => {
        expect((await quote({})).status).toBe(400);
        expect((await quote({ model: "kling-3", tool: "transcribe" })).status).toBe(400);
        const extra = await quote({ tool: "transcribe", seconds: 5, resolution: "4k" });
        expect(extra.status).toBe(400);
        expect(extra.body.error).toMatchObject({ code: "invalid_request", message: expect.stringContaining("resolution: not a field of transcribe") });
        expect((await quote({ tool: "lipsync", seconds: 61 })).status).toBe(400);
        expect((await quote({ tool: "lipsync", seconds: 0 })).status).toBe(400);
        expect((await quote({ model: "kling-3", seconds: 5 })).status).toBe(400);
        expect((await quote({ model: "kokoro", input: "x", characters: 1 })).status).toBe(400);
        const tier = await quote({ model: "kling-3", quality: "4k" });
        expect(tier.status).toBe(400);
        expect(tier.body.error).toMatchObject({ code: "tier_not_offered" });
        expect((await quote({ tool: "storyboard" })).status).toBe(400);
        expect((await quote({ model: "nope" })).status).toBe(404);
    });

    it("the quotes knob answers 404 (an older server), 429 with Retry-After, or 503, until set live", async () => {
        await knob("/__test/quotes?status=404");
        expect((await quote({ tool: "transcribe", seconds: 5 })).status).toBe(404);
        await knob("/__test/quotes?status=429");
        const limited = await quote({ tool: "transcribe", seconds: 5 });
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBe("30");
        expect(limited.body.error).toMatchObject({ type: "rate_limit_error", code: "rate_limit_exceeded" });
        await knob("/__test/quotes?status=503");
        expect((await quote({ tool: "transcribe", seconds: 5 })).body.error).toMatchObject({ code: "unavailable" });
        await knob("/__test/quotes?status=live");
        expect((await quote({ tool: "transcribe", seconds: 5 })).status).toBe(200);
        await knob("/__test/quotes?status=503");
        fake.reset();
        expect((await quote({ tool: "transcribe", seconds: 5 })).status).toBe(200);
    });

    it("settles a generation at its quote and a tool task on the WAV it reads", async () => {
        const created = await call("POST", "/v1/images/generations", { model: "nano-banana-2", prompt: "a cat" });
        let task = created.body;
        for (let i = 0; i < 5 && task.status !== "succeeded"; i += 1) task = (await call("GET", `/v1/tasks/${created.body.id}`)).body;
        expect(task.price_usd).toBe(0.039);
        // A 90-second WAV upload: voice isolation settles on 2 started minutes.
        const bytes = wavBytes(90, 8000);
        const upload = await call("POST", "/v1/uploads", { filename: "a.wav", content_type: "audio/wav", size_bytes: bytes.length });
        await fetch(upload.body.upload_url as string, { method: "PUT", headers: { "content-type": "audio/wav" }, body: bytes });
        await call("POST", `/v1/uploads/${upload.body.upload_id}/complete`);
        const tool = await call("POST", "/v1/audio/isolations", { audio_url: upload.body.media_url });
        let done = tool.body;
        for (let i = 0; i < 6 && done.status !== "succeeded"; i += 1) done = (await call("GET", `/v1/tasks/${tool.body.id}`)).body;
        expect(done.price_usd).toBe(fakeToolSettle("voice-isolation", { seconds: 90 }));
    });
});

function wavBytes(seconds: number, rate: number): Uint8Array<ArrayBuffer> {
    const samples = Math.round(seconds * rate);
    const buffer = Buffer.alloc(44 + samples * 2);
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + samples * 2, 4);
    buffer.write("WAVEfmt ", 8);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(rate, 24);
    buffer.writeUInt32LE(rate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(samples * 2, 40);
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
}
