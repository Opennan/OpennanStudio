import { CapabilityUnavailableError, JobCancelledError, ProviderRegistry, providerContractCases, type MediaPreparer, type MediaPreparePurpose } from "@opennan/provider-sdk";
import { FAL_KEY_MISSING, FAL_PREPARE_UNAVAILABLE, FAL_STORAGE_INITIATE, createFalProvider } from "./fal-provider";
import * as api from "./index";

interface Call { method: string; url: string; body: unknown; auth: string | null; redirect?: RequestRedirect; contentType: string | null; credentials?: RequestCredentials }

function fakeFal(script: (call: Call, n: number) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        const isJson = typeof init.body === "string";
        const call = {
            method: init.method ?? "GET", url: String(input), body: init.body ? (isJson ? JSON.parse(String(init.body)) : init.body) : undefined, auth: headers.get("authorization"),
            redirect: init.redirect, contentType: headers.get("content-type"), credentials: init.credentials,
        };
        calls.push(call);
        return script(call, calls.length);
    }) as typeof globalThis.fetch;
    return { fetch, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const QUEUED = {
    request_id: "req-1",
    status_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/status",
    response_url: "https://queue.fal.run/fal-ai/flux/requests/req-1",
    cancel_url: "https://queue.fal.run/fal-ai/flux/requests/req-1/cancel",
};

describe("createFalProvider", () => {
    it("exports its version", () => {
        expect(api.PROVIDER_FAL_VERSION).toBe("0.2.0");
    });

    it("passes the provider contract and registers as fal", async () => {
        const { fetch } = fakeFal(() => new Promise(() => undefined));
        const provider = createFalProvider({ getKey: () => "fal-key", fetch });
        for (const c of providerContractCases(provider)) await c.run();
        const registry = new ProviderRegistry();
        registry.register(provider);
        expect(registry.route("image.generate")?.info.id).toBe("fal");
        expect((await provider.models!("image.generate"))[0]).toMatchObject({ id: "fal-ai/flux/schnell", default: true });
    });

    it("queues an image, polls the status, and returns the image links; the key goes only to queue.fal.run", async () => {
        const { fetch, calls } = fakeFal((call) => {
            if (call.method === "POST") return json(200, QUEUED);
            if (call.url.endsWith("/status")) return json(200, { status: calls.filter((c) => c.url.endsWith("/status")).length === 1 ? "IN_QUEUE" : "COMPLETED", queue_position: 2 });
            return json(200, { images: [{ url: "https://v3.fal.media/files/a.png", content_type: "image/png" }, { url: "http://insecure/b.png" }] });
        });
        const provider = createFalProvider({ getKey: async () => " fal-key ", fetch, pollMs: 1 });
        const output = await provider.run!({ capability: "image.generate", input: { description: "a cat", aspectRatio: "16:9" } }).result();
        expect(output).toEqual({ media: [{ kind: "image", url: "https://v3.fal.media/files/a.png", mimeType: "image/png" }] });
        expect(calls[0]).toMatchObject({ method: "POST", url: "https://queue.fal.run/fal-ai/flux/schnell", body: { prompt: "a cat", num_images: 1, image_size: "landscape_16_9" }, auth: "Key fal-key" });
        expect(calls.every((c) => c.url.startsWith("https://queue.fal.run/"))).toBe(true);
    });

    it("maps video requests", async () => {
        const { fetch, calls } = fakeFal((call) => {
            if (call.method === "POST") return json(200, { ...QUEUED, status_url: "https://queue.fal.run/x/requests/1/status", response_url: "https://queue.fal.run/x/requests/1" });
            if (call.url.endsWith("/status")) return json(200, { status: "COMPLETED" });
            return json(200, { video: { url: "https://v3.fal.media/files/v.mp4", content_type: "video/mp4" } });
        });
        const provider = createFalProvider({ getKey: () => "k", fetch, pollMs: 1 });
        expect(await provider.run!({ capability: "video.text-to-video", input: { description: "waves", durationSeconds: 10, aspectRatio: "9:16" } }).result())
            .toEqual({ media: [{ kind: "video", url: "https://v3.fal.media/files/v.mp4", mimeType: "video/mp4" }] });
        await provider.run!({ capability: "video.image-to-video", input: { image: "https://x/a.png" } }).result();
        const posts = calls.filter((c) => c.method === "POST");
        expect(posts[0]).toMatchObject({ url: "https://queue.fal.run/fal-ai/kling-video/v2.1/standard/text-to-video", body: { prompt: "waves", duration: "10", aspect_ratio: "9:16" } });
        expect(posts[1]).toMatchObject({ url: "https://queue.fal.run/fal-ai/kling-video/v2.1/standard/image-to-video", body: { prompt: "", duration: "5", image_url: "https://x/a.png" } });
    });

    it("asks for a key, explains a refused key, and reports fal's error detail", async () => {
        const none = createFalProvider({ getKey: () => null, fetch: fakeFal(() => json(200, {})).fetch });
        const missing = await none.run!({ capability: "image.generate", input: { description: "x" } }).result().catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(CapabilityUnavailableError);
        expect((missing as Error).message).toBe(FAL_KEY_MISSING);
        const refused = createFalProvider({ getKey: () => "bad", fetch: fakeFal(() => json(401, { detail: "Unauthorized" })).fetch });
        await expect(refused.run!({ capability: "image.generate", input: { description: "x" } }).result()).rejects.toThrow(/did not accept the key/);
        const invalid = createFalProvider({ getKey: () => "k", fetch: fakeFal(() => json(422, { detail: [{ msg: "prompt is too long" }] })).fetch });
        await expect(invalid.run!({ capability: "image.generate", input: { description: "x" } }).result()).rejects.toThrow("prompt is too long");
    });

    it("refuses queue URLs off queue.fal.run and bad input", async () => {
        const evil = createFalProvider({ getKey: () => "k", fetch: fakeFal(() => json(200, { ...QUEUED, status_url: "https://evil.example/status" })).fetch });
        await expect(evil.run!({ capability: "image.generate", input: { description: "x" } }).result()).rejects.toThrow(/did not queue/);
        const { fetch, calls } = fakeFal(() => json(200, QUEUED));
        const provider = createFalProvider({ getKey: () => "k", fetch });
        await expect(provider.run!({ capability: "image.generate", input: {} }).result()).rejects.toThrow(/description is required/);
        await expect(provider.run!({ capability: "image.generate", input: { description: "x", model: "../../admin" } }).result()).rejects.toThrow(/Unknown fal.ai model/);
        await expect(provider.run!({ capability: "video.image-to-video", input: { image: "file:///etc/passwd" } }).result()).rejects.toThrow(/https/);
        expect(calls).toEqual([]);
    });

    it("cancels the queued request", async () => {
        const { fetch, calls } = fakeFal((call) => {
            if (call.method === "POST") return json(200, QUEUED);
            if (call.method === "PUT") return json(202, {});
            return json(200, { status: "IN_PROGRESS" });
        });
        const job = createFalProvider({ getKey: () => "k", fetch, pollMs: 5 }).run!({ capability: "image.generate", input: { description: "x" } });
        await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/status"))).toBe(true));
        await job.cancel();
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === QUEUED.cancel_url)).toBe(true));
        // No request that carries the key may follow a redirect.
        expect(calls.every((c) => c.redirect === "error")).toBe(true);
    });
});

describe("fal 0.2.0: storage uploads, voice isolation, upscale, prices", () => {
    const UPLOAD = { upload_url: "https://v3.fal.media/files/upload/abc?sig=1", file_url: "https://v3.fal.media/files/abc/clip.wav" };
    function preparer() {
        const purposes: MediaPreparePurpose[] = [];
        const prepare: MediaPreparer = async (_input, purpose) => {
            purposes.push(purpose);
            return { data: new Uint8Array([1, 2, 3]), contentType: purpose.contentTypes[0]!, filename: "clip.wav", sizeBytes: 3, durationSeconds: 4 };
        };
        return { prepare, purposes };
    }
    function script(output: Record<string, unknown>, upload: Record<string, unknown> = UPLOAD) {
        return fakeFal((call) => {
            if (call.url.startsWith(FAL_STORAGE_INITIATE)) return json(200, upload);
            if (call.method === "PUT") return new Response(null, { status: 200 });
            if (call.method === "POST") return json(200, QUEUED);
            if (call.url.endsWith("/status")) return json(200, { status: "COMPLETED" });
            return json(200, output);
        });
    }

    it("declares the new capabilities and answers billed by fal.ai", async () => {
        const provider = createFalProvider({ getKey: () => "k", fetch: fakeFal(() => json(200, {})).fetch });
        expect(provider.info.capabilities).toEqual(["image.generate", "video.text-to-video", "video.image-to-video", "audio.isolate-voice", "video.upscale"]);
        expect(await provider.price!({ capability: "video.upscale", input: {}, units: { seconds: 5 } })).toEqual({ kind: "billed-elsewhere", by: "fal.ai" });
    });

    it("isolates a voice from a project media: fal storage upload, then the queue; the key stays on fal's API hosts", async () => {
        const { prepare, purposes } = preparer();
        const { fetch, calls } = script({ audio: { url: "https://v3.fal.media/files/out/voice.mp3", content_type: "audio/mpeg" } });
        const provider = createFalProvider({ getKey: () => "fal-key", fetch, pollMs: 1, prepareMedia: prepare });
        const output = await provider.run!({ capability: "audio.isolate-voice", input: { source: { mediaUrl: "opennan-local://media/a", startSeconds: 1, endSeconds: 5 } } }).result();
        expect(output).toEqual({ media: [{ kind: "audio", url: "https://v3.fal.media/files/out/voice.mp3", mimeType: "audio/mpeg" }] });
        expect(purposes[0]).toMatchObject({ output: "audio", contentTypes: ["audio/wav"] });
        expect(calls[0]).toMatchObject({ method: "POST", url: `${FAL_STORAGE_INITIATE}?storage_type=fal-cdn-v3`, auth: "Key fal-key", body: { content_type: "audio/wav", file_name: "clip.wav" } });
        expect(calls[1]).toMatchObject({ method: "PUT", url: UPLOAD.upload_url, auth: null, contentType: "audio/wav", redirect: "error", credentials: "omit" });
        expect(calls[2]).toMatchObject({ method: "POST", url: "https://queue.fal.run/fal-ai/elevenlabs/audio-isolation", body: { audio_url: UPLOAD.file_url } });
        for (const call of calls.filter((c) => c.auth !== null)) expect(call.url).toMatch(/^https:\/\/(rest\.alpha\.fal\.ai|queue\.fal\.run)\//);
        expect(calls.every((c) => c.redirect === "error")).toBe(true);
    });

    it("upscales an https video to the asked size", async () => {
        const { fetch, calls } = script({ video: { url: "https://v3.fal.media/files/out/up.mp4" } });
        const provider = createFalProvider({ getKey: () => "k", fetch, pollMs: 1 });
        const output = await provider.run!({ capability: "video.upscale", input: { videoUrl: "https://cdn.example/a.mp4", resolution: "2k" } }).result();
        expect(output).toEqual({ media: [{ kind: "video", url: "https://v3.fal.media/files/out/up.mp4" }] });
        expect(calls[0]).toMatchObject({ url: "https://queue.fal.run/fal-ai/bytedance-upscaler/upscale/video", body: { video_url: "https://cdn.example/a.mp4", target_resolution: "2k" } });
        await expect(provider.run!({ capability: "video.upscale", input: { videoUrl: "https://cdn.example/a.mp4", resolution: "8k" } }).result()).rejects.toThrow(/resolution/);
    });

    it("animates a project image: uploaded to fal storage first", async () => {
        const { prepare, purposes } = preparer();
        const { fetch, calls } = script({ video: { url: "https://v3.fal.media/files/v.mp4" } }, { upload_url: "https://v3.fal.media/up/1", file_url: "https://v3.fal.media/files/still.png" });
        const provider = createFalProvider({ getKey: () => "k", fetch, pollMs: 1, prepareMedia: prepare });
        await provider.run!({ capability: "video.image-to-video", input: { image: { mediaUrl: "opennan-local://media/still" } } }).result();
        expect(purposes[0]).toMatchObject({ output: "image", contentTypes: ["image/png", "image/jpeg", "image/webp"] });
        expect(calls.find((c) => c.url.includes("image-to-video"))!.body).toMatchObject({ image_url: "https://v3.fal.media/files/still.png" });
    });

    it("refuses fal storage answers that are not https, without sending the file", async () => {
        const { prepare } = preparer();
        const bad = script({}, { upload_url: "http://v3.fal.media/up", file_url: "https://v3.fal.media/f" });
        await expect(createFalProvider({ getKey: () => "k", fetch: bad.fetch, prepareMedia: prepare }).run!({ capability: "audio.isolate-voice", input: { source: { mediaUrl: "opennan-local://media/a" } } }).result())
            .rejects.toThrow(/upload/);
        expect(bad.calls.filter((c) => c.method === "PUT")).toEqual([]);
        const badFile = script({}, { upload_url: "https://v3.fal.media/up", file_url: "http://v3.fal.media/f" });
        await expect(createFalProvider({ getKey: () => "k", fetch: badFile.fetch, prepareMedia: prepare }).run!({ capability: "audio.isolate-voice", input: { source: { mediaUrl: "opennan-local://media/a" } } }).result())
            .rejects.toThrow(/upload/);
    });

    it("explains that a project media needs a preparer", async () => {
        const { fetch, calls } = script({});
        const error = await createFalProvider({ getKey: () => "k", fetch }).run!({ capability: "audio.isolate-voice", input: { source: { mediaUrl: "opennan-local://media/a" } } }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CapabilityUnavailableError);
        expect((error as Error).message).toBe(FAL_PREPARE_UNAVAILABLE);
        expect(calls).toEqual([]);
    });
});
