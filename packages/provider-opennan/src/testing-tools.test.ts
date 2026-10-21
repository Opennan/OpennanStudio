// The fake OpenNan server's phase 11 surface: uploads, the media tool tasks, price blocks, and failure knobs.
import { FAKE_STUDIO_SCOPES, FAKE_TOOL_PRICES, startFakeOpenNan, type FakeOpenNan } from "./testing";

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

interface Answer { status: number; body: Record<string, unknown> & { error?: { type?: string; code?: string | null; message?: string } } }

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const response = await fetch(fake.url + path, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const knob = (path: string) => fetch(fake.url + path).then((r) => r.json());

async function runToEnd(id: string, max = 20): Promise<Answer[]> {
    const seen: Answer[] = [];
    for (let i = 0; i < max; i += 1) {
        const answer = await call("GET", `/v1/tasks/${id}`);
        seen.push(answer);
        if (!["queued", "running"].includes(String(answer.body.status))) break;
    }
    return seen;
}

const AUDIO = () => `${fake.url}/files/generated.wav`;

describe("scopes", () => {
    it("gives device-flow keys and /v1/account the Studio scopes", async () => {
        expect(FAKE_STUDIO_SCOPES).toEqual(["api:opennan", "api:project", "api:video", "api:image", "api:text", "api:voice", "api:music", "api:3d"]);
        const start = await call("POST", "/v1/auth/device", { device_name: "x" });
        fake.approve();
        const token = await call("POST", "/v1/auth/device/token", { device_code: start.body.device_code });
        expect(token.body.scopes).toEqual(FAKE_STUDIO_SCOPES);
        const account = await call("GET", "/v1/account");
        expect((account.body.key as { scopes: string[] }).scopes).toEqual(FAKE_STUDIO_SCOPES);
    });

    it("mints keys without api:project on request, and those keys cannot upload", async () => {
        await knob("/__test/key-scopes?scopes=api:opennan,api:voice");
        key = fake.mintKey();
        const answer = await call("POST", "/v1/uploads", { filename: "a.wav", content_type: "audio/wav", size_bytes: 4 });
        expect(answer.status).toBe(403);
        expect(answer.body.error?.type).toBe("permission_error");
    });
});

describe("uploads", () => {
    it("starts a temp upload (201) through the gateway, takes the exact PUT, completes, and serves the file", async () => {
        const start = await call("POST", "/v1/uploads", { filename: "clip.wav", content_type: "audio/wav", size_bytes: 4 });
        expect(start.status).toBe(201);
        const { upload_id: id, upload_url: url, headers, media_url: mediaUrl, expires_at: expires } = start.body as Record<string, string> & { headers: Record<string, string> };
        expect(url).toMatch(new RegExp(`^${fake.url}/u/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
        expect(headers).toEqual({ "Content-Type": "audio/wav", "Content-Length": "4" });
        expect(mediaUrl).toMatch(new RegExp(`^${fake.url}/files/uploads/temp/[0-9a-f]{24}/[a-z2-7]{24}\\.wav$`));
        expect(start.body.scope).toBe("temp");
        expect(typeof expires).toBe("string");
        expect((await call("POST", `/v1/uploads/${id}/complete`)).status).toBe(409);
        const put = await fetch(url, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3, 4]) });
        expect(put.status).toBe(200);
        const done = await call("POST", `/v1/uploads/${id}/complete`);
        expect(done.status).toBe(200);
        expect(done.body).toMatchObject({ media_url: mediaUrl, content_type: "audio/wav", size_bytes: 4, asset_id: expect.any(String) });
        const file = await fetch(mediaUrl);
        expect(file.headers.get("content-type")).toBe("audio/wav");
        expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
        const state = fake.state();
        expect(state.uploads).toEqual([{ id, contentType: "audio/wav", sizeBytes: 4, filename: "clip.wav", put: true, completed: true }]);
        expect(JSON.stringify(state)).not.toContain("1,2,3,4");
        expect(state.requests.some((r) => r.method === "PUT" && r.path === new URL(url).pathname && !r.authorized)).toBe(true);
    });

    it("refuses a PUT with a different type, a different size, or an Authorization header", async () => {
        const start = await call("POST", "/v1/uploads", { filename: "a.wav", content_type: "audio/wav", size_bytes: 4 });
        const url = start.body.upload_url as string;
        expect((await fetch(url, { method: "PUT", headers: { "content-type": "audio/mpeg" }, body: new Uint8Array(4) })).status).toBe(400);
        expect((await fetch(url, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array(5) })).status).toBe(400);
        expect((await fetch(url, { method: "PUT", headers: { "content-type": "audio/wav", authorization: `Bearer ${key}` }, body: new Uint8Array(4) })).status).toBe(403);
        expect((await fetch(`${fake.url}/u/missing.token`, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array(4) })).status).toBe(404);
        expect(fake.state().uploads[0]).toMatchObject({ put: false });
    });

    it.each([
        [{ filename: "", content_type: "audio/wav", size_bytes: 4 }],
        [{ filename: "x".repeat(256), content_type: "audio/wav", size_bytes: 4 }],
        [{ filename: "a.exe", content_type: "application/x-msdownload", size_bytes: 4 }],
        [{ filename: "a.wav", content_type: "audio/wav", size_bytes: 0 }],
        [{ filename: "a.wav", content_type: "audio/wav", size_bytes: 200 * 1024 * 1024 + 1 }],
        [{ filename: "a.png", content_type: "image/png", size_bytes: 20 * 1024 * 1024 + 1 }],
        [{ filename: "a.wav", content_type: "audio/wav", size_bytes: 4, extra: true }],
    ])("refuses the upload body %j", async (body) => {
        const answer = await call("POST", "/v1/uploads", body);
        expect(answer.status).toBe(400);
        expect(answer.body.error?.type).toBe("invalid_request_error");
    });

    it("takes a 1 GB video in parts (multipart), and asks for parts over 95 MB", async () => {
        expect((await call("POST", "/v1/uploads", { filename: "a.mp4", content_type: "video/mp4", size_bytes: 1024 * 1024 * 1024, multipart: true })).status).toBe(201);
        const single = await call("POST", "/v1/uploads", { filename: "a.mp4", content_type: "video/mp4", size_bytes: 1024 * 1024 * 1024 });
        expect(single.status).toBe(400);
        expect(single.body.error?.code).toBe("multipart_required");
    });

    it("answers CORS preflights for PUT with content-type and idempotency-key", async () => {
        const answer = await fetch(`${fake.url}/__uploads/x`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5173" } });
        expect(answer.headers.get("access-control-allow-methods")).toContain("PUT");
        expect(answer.headers.get("access-control-allow-headers")).toContain("idempotency-key");
        expect(answer.headers.get("access-control-allow-headers")).toContain("content-type");
    });
});

describe("tool tasks", () => {
    it("transcribes: stages, word timings, the price at success, the Idempotency-Key logged", async () => {
        const created = await call("POST", "/v1/audio/transcriptions", { audio_url: AUDIO(), language: "en" }, { "idempotency-key": "run-1" });
        expect(created.status).toBe(202);
        expect(created.body).toMatchObject({ object: "task", model: "transcribe", status: "queued", price_usd: 0, error: null });
        const steps = await runToEnd(created.body.id as string);
        expect(steps.filter((s) => s.body.status === "running").map((s) => s.body.stage)).toEqual(["reading", "transcribing"]);
        const done = steps.at(-1)!.body;
        expect(done.status).toBe("succeeded");
        expect(done.price_usd).toBe(FAKE_TOOL_PRICES.transcribe);
        const result = done.result as { text: string; language: string; segments: unknown[]; words: Array<{ text: string; start: number; end: number }> };
        expect(result.text).toBe("Hello there. How are you?");
        expect(result.language).toBe("en");
        expect(result.segments).toHaveLength(2);
        expect(result.words[0]).toEqual({ text: "Hello", start: 0.1, end: 0.4 });
        expect(fake.state().requests.find((r) => r.path === "/v1/audio/transcriptions")).toMatchObject({ idempotencyKey: "run-1", body: { audio_url: AUDIO(), language: "en" } });
    });

    it("translates captions with the language prefix and the same timings", async () => {
        const created = await call("POST", "/v1/captions/translations", { segments: [{ start: 0, end: 1, text: "Hi" }, { start: 1, end: 2.5, text: "Bye" }], target_language: "th" });
        const done = (await runToEnd(created.body.id as string)).at(-1)!.body;
        expect(done.result).toEqual({ language: "th", segments: [{ start: 0, end: 1, text: "[th] Hi" }, { start: 1, end: 2.5, text: "[th] Bye" }], untranslated: [] });
        expect(done.price_usd).toBe(FAKE_TOOL_PRICES["caption-translate"]);
    });

    it("drop-translated-line keeps one line untranslated", async () => {
        await knob("/__test/drop-translated-line");
        const created = await call("POST", "/v1/captions/translations", { segments: [{ start: 0, end: 1, text: "Hi" }, { start: 1, end: 2, text: "Bye" }], target_language: "ja" });
        const done = (await runToEnd(created.body.id as string)).at(-1)!.body;
        expect(done.result).toEqual({ language: "ja", segments: [{ start: 0, end: 1, text: "[ja] Hi" }, { start: 1, end: 2, text: "Bye" }], untranslated: [1] });
    });

    it("isolates a voice, upscales, removes a background, syncs lips, and separates stems", async () => {
        const isolation = (await runToEnd((await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).body.id as string));
        expect(isolation.filter((s) => s.body.status === "running").map((s) => s.body.stage)).toEqual(["reading", "isolating"]);
        expect(isolation.at(-1)!.body.result).toEqual({ audio_url: AUDIO(), duration_s: 0.5 });

        const video = `${fake.url}/files/generated.webm`;
        const upscale = await runToEnd((await call("POST", "/v1/videos/upscales", { video_url: video, resolution: "4k" })).body.id as string);
        expect(upscale.at(-1)!.body).toMatchObject({ result: { video_url: video }, price_usd: FAKE_TOOL_PRICES["video-upscale"]["4k"] });
        expect(upscale.filter((s) => s.body.status === "running").map((s) => s.body.stage)).toEqual(["reading", "upscaling"]);
        const matting = await runToEnd((await call("POST", "/v1/videos/background-removals", { video_url: video, background: "green" })).body.id as string);
        expect(matting.filter((s) => s.body.status === "running").map((s) => s.body.stage)).toEqual(["reading", "matting"]);
        const lipsync = await runToEnd((await call("POST", "/v1/videos/lipsync", { video_url: video, audio_url: AUDIO() })).body.id as string);
        expect(lipsync.filter((s) => s.body.status === "running").map((s) => s.body.stage)).toEqual(["reading", "syncing"]);
        expect(lipsync.at(-1)!.body.price_usd).toBe(FAKE_TOOL_PRICES.lipsync);

        const vocals = await runToEnd((await call("POST", "/v1/audio/separations", { model: "demucs", audio_url: AUDIO(), stems: "vocals" })).body.id as string);
        expect(vocals.at(-1)!.body).toMatchObject({ model: "demucs", status: "succeeded" });
        expect(vocals.at(-1)!.body.outputs).toEqual([
            { type: "audio", format: "mp3", url: AUDIO(), stem: "vocals" },
            { type: "audio", format: "mp3", url: AUDIO(), stem: "instrumental" },
        ]);
        const all = await runToEnd((await call("POST", "/v1/audio/separations", { audio_url: AUDIO(), stems: "all" })).body.id as string);
        expect((all.at(-1)!.body.outputs as Array<{ stem: string }>).map((o) => o.stem)).toEqual(["vocals", "drums", "bass", "other"]);
    });

    it("serves a real WebM for video results", async () => {
        const answer = await fetch(`${fake.url}/files/generated.webm`);
        expect(answer.headers.get("content-type")).toBe("video/webm");
        const bytes = new Uint8Array(await answer.arrayBuffer());
        expect([...bytes.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
        expect(bytes.length).toBeGreaterThan(1000);
    });

    it.each([
        ["/v1/audio/transcriptions", { audio_url: "http://evil.example/a.wav" }],
        ["/v1/audio/transcriptions", { audio_url: "https://cdn.example/a.wav", language: "english" }],
        ["/v1/audio/transcriptions", { audio_url: "https://cdn.example/a.wav", extra: 1 }],
        ["/v1/audio/isolations", {}],
        ["/v1/videos/upscales", { video_url: "https://cdn.example/a.mp4", resolution: "8k" }],
        ["/v1/videos/background-removals", { video_url: "https://cdn.example/a.mp4", background: "pink" }],
        ["/v1/videos/lipsync", { video_url: "https://cdn.example/a.mp4" }],
        ["/v1/audio/separations", { audio_url: "https://cdn.example/a.mp3", stems: "drums" }],
        ["/v1/captions/translations", { segments: [], target_language: "th" }],
        ["/v1/captions/translations", { segments: [{ start: 0, end: 1, text: "x" }], target_language: "thai!" }],
        ["/v1/captions/translations", { segments: [{ start: 2, end: 1, text: "x" }], target_language: "th" }],
        ["/v1/captions/translations", { segments: [{ start: 0, end: 1, text: "x".repeat(501) }], target_language: "th" }],
        ["/v1/captions/translations", { segments: Array.from({ length: 2001 }, () => ({ start: 0, end: 1, text: "x" })), target_language: "th" }],
        ["/v1/captions/translations", { segments: Array.from({ length: 61 }, () => ({ start: 0, end: 1, text: "x".repeat(500) })), target_language: "th" }],
        ["/v1/captions/translations", { segments: [{ start: 0, end: 1, text: "x", speaker: "A" }], target_language: "th" }],
    ])("refuses %s %j", async (path, body) => {
        const answer = await call("POST", path, body);
        expect(answer.status).toBe(400);
        expect(answer.body.error?.type).toBe("invalid_request_error");
    });

    it("accepts region language codes and https URLs elsewhere", async () => {
        expect((await call("POST", "/v1/captions/translations", { segments: [{ start: 0, end: 1, text: "x" }], target_language: "zh-TW", source_language: "en" })).status).toBe(202);
        expect((await call("POST", "/v1/audio/transcriptions", { audio_url: "https://cdn.example/a.wav" })).status).toBe(202);
    });

    it("answers 402 with zero balance and 401 without a key", async () => {
        fake.setBalance(0);
        expect((await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).status).toBe(402);
        key = "sk-nope";
        expect((await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).status).toBe(401);
    });
});

describe("cancel and failure knobs", () => {
    it("cancels a queued task with a refund", async () => {
        const created = await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() });
        const cancelled = await call("POST", `/v1/tasks/${created.body.id}/cancel`);
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ status: "cancelled", error: { message: "Cancelled. You were not charged.", refunded: true } });
    });

    it("refuses to cancel once the paid step started and lets the task finish", async () => {
        await knob("/__test/paid-started?tool=video-upscale");
        await knob("/__test/task-steps?n=3");
        const created = await call("POST", "/v1/videos/upscales", { video_url: `${fake.url}/files/generated.webm` });
        const id = created.body.id as string;
        let status = "queued";
        while (status === "queued") status = String((await call("GET", `/v1/tasks/${id}`)).body.status);
        expect(status).toBe("running");
        const refused = await call("POST", `/v1/tasks/${id}/cancel`);
        expect(refused.status).toBe(409);
        expect(refused.body.error).toEqual({ type: "conflict", code: "task_not_cancellable", message: "This task can't be cancelled: it has finished or already started work that is charged." });
        expect((await runToEnd(id)).at(-1)!.body.status).toBe("succeeded");
    });

    it("cancels a running task whose paid step has not started", async () => {
        await knob("/__test/task-steps?n=2");
        const id = (await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).body.id as string;
        let status = "queued";
        while (status === "queued") status = String((await call("GET", `/v1/tasks/${id}`)).body.status);
        expect((await call("POST", `/v1/tasks/${id}/cancel`)).status).toBe(200);
    });

    it("never cancels a separation (like the server's audio tasks)", async () => {
        const id = (await call("POST", "/v1/audio/separations", { audio_url: AUDIO() })).body.id as string;
        expect((await call("POST", `/v1/tasks/${id}/cancel`)).status).toBe(409);
    });

    it("fail-next fails the next task of a tool with the public text and a refund", async () => {
        await knob("/__test/fail-next?tool=video-upscale&kind=input_already_large");
        const id = (await call("POST", "/v1/videos/upscales", { video_url: `${fake.url}/files/generated.webm` })).body.id as string;
        const done = (await runToEnd(id)).at(-1)!.body;
        expect(done).toMatchObject({
            status: "failed", price_usd: 0,
            error: { message: "The video is already at or above the size asked for: ask for a larger size. You were not charged.", refunded: true },
        });
        const next = (await runToEnd((await call("POST", "/v1/videos/upscales", { video_url: `${fake.url}/files/generated.webm` })).body.id as string)).at(-1)!.body;
        expect(next.status).toBe("succeeded");
        await knob("/__test/fail-next?tool=transcribe&kind=input_too_long_media");
        const long = (await runToEnd((await call("POST", "/v1/audio/transcriptions", { audio_url: AUDIO() })).body.id as string)).at(-1)!.body;
        expect((long.error as { message: string }).message).toMatch(/longer than this tool takes/);
    });

    it("tool-status makes a tool unavailable: no price, the POST answers 503", async () => {
        await knob("/__test/tool-status?id=voice-isolation&status=unavailable");
        const tools = (await call("GET", "/v1/tools")).body.data as Array<{ id: string; status: string; price: unknown }>;
        expect(tools.find((t) => t.id === "voice-isolation")).toMatchObject({ status: "unavailable", price: null });
        expect((await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).status).toBe(503);
        await knob("/__test/tool-status?id=voice-isolation&status=live");
        expect((await call("POST", "/v1/audio/isolations", { audio_url: AUDIO() })).status).toBe(202);
    });

    it("reset() clears every knob", async () => {
        await knob("/__test/fail-next?tool=transcribe&kind=pipeline_failed");
        await knob("/__test/tool-status?id=transcribe&status=soon");
        await knob("/__test/task-steps?n=5");
        fake.reset();
        key = fake.mintKey();
        const tools = (await call("GET", "/v1/tools")).body.data as Array<{ id: string; status: string }>;
        expect(tools.find((t) => t.id === "transcribe")?.status).toBe("live");
        const steps = await runToEnd((await call("POST", "/v1/audio/transcriptions", { audio_url: AUDIO() })).body.id as string);
        expect(steps.at(-1)!.body.status).toBe("succeeded");
        expect(steps).toHaveLength(3);
    });
});

describe("prices", () => {
    it("lists the tools with the server's row and price block shapes, without a key", async () => {
        const answer = await fetch(`${fake.url}/v1/tools`).then((r) => r.json()) as { object: string; data: Array<Record<string, unknown>> };
        expect(answer.object).toBe("list");
        const byId = Object.fromEntries(answer.data.map((row) => [row.id, row]));
        expect(Object.keys(byId).sort()).toEqual([
            "caption-translate", "copy-video-detect", "copy-video-edit", "copy-video-recreate", "director-turn", "lipsync", "remove-background", "smart-scene-video",
            "sound-effects", "story-scenes", "storyboard", "transcribe", "video-upscale", "voice-isolation",
        ]);
        expect(byId.transcribe).toEqual({
            id: "transcribe", object: "tool", kind: "pipeline", category: "voice", method: "POST", path: "/v1/audio/transcriptions", status: "live",
            mcp_tool: "transcribe_audio", free: false, limits: null, summary: expect.any(String),
            price: { unit: "source_minute", per: "minute", usd: 0.004768, max_minutes: 30 },
        });
        expect(byId["caption-translate"]!.price).toEqual({ unit: "thousand_characters", per: "1000 characters", usd: 0.00591, max_characters: 30000, max_segments: 2000, segment_overhead_characters: 10 });
        expect(byId["voice-isolation"]!.price).toEqual({ unit: "source_minute", per: "minute", usd: 0.13, max_minutes: 10 });
        expect(byId["video-upscale"]!.price).toEqual({
            unit: "video_second", per: "second", usd: 0.00936, max_seconds: 60,
            tiers: [{ resolution: "1080p", usd: 0.00936 }, { resolution: "2k", usd: 0.01872 }, { resolution: "4k", usd: 0.03744 }],
        });
        expect(byId["remove-background"]!.price).toEqual({ unit: "video_second", per: "second", usd: 0.0026, max_seconds: 120 });
        expect(byId.lipsync!.price).toEqual({ unit: "audio_second", per: "second", usd: 0.013, max_seconds: 60 });
        expect(byId["sound-effects"]!.price).toEqual({ unit: "sound_second", per: "second", usd: 0.0026, max_seconds: 22, max_usd: 0.0572 });
    });

    it("adds price blocks to the models and lists demucs and the voices", async () => {
        const models = async (category: string) => (await fetch(`${fake.url}/v1/models?category=${category}`).then((r) => r.json()) as { data: Array<Record<string, unknown>> }).data;
        expect((await models("image"))[0]).toMatchObject({ id: "nano-banana-2", price: { from_usd: 0.039, per_input_image_usd: 0.002, unit: "image" } });
        const video = await models("video");
        expect(video).toHaveLength(2);
        expect(video[0]).toMatchObject({
            id: "kling-3", durations: [5, 10],
            price: { matrix: [{ quality: "720p", duration: 5, ours_usd: 0.4, ours_usd_per_second: 0.08, audio: false }, { quality: "1080p", duration: 5, ours_usd: 0.7, ours_usd_per_second: 0.14, audio: false }] },
        });
        expect((await models("voice"))[0]).toMatchObject({ id: "kokoro", price: { billing_block_characters: 1000, minimum_usd: 0.026 } });
        const music = await models("music");
        expect(music.map((m) => m.id)).toEqual(["ace-step", "demucs"]);
        expect(music[0]).toMatchObject({ price: { from_usd: 0.0156 } });
        expect(music[1]).toMatchObject({ endpoint: "/v1/audio/separations", price: { minimum_usd: 0.01, base_usd: 0.0115, per_minute_usd: 0.0023 } });
        const voices = await fetch(`${fake.url}/v1/audio/voices`).then((r) => r.json()) as { data: Array<Record<string, unknown>> };
        expect(voices.data).toHaveLength(3);
        expect(voices.data[0]).toEqual({ id: "heart", object: "voice", model: "kokoro", name: "Heart", language: "en-US", gender: "female", preview_url: null });
    });
});
