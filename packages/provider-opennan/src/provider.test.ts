import { CapabilityUnavailableError, JobCancelledError, JobFailedError, OPENNAN_CAPABILITIES, ProviderRegistry, providerContractCases, type JobUpdate, type MediaPreparer } from "@opennan/provider-sdk";
import { createOpenNanApi } from "./api";
import { INSUFFICIENT_CREDITS_MESSAGE, OPENNAN_PROVIDER_CAPABILITIES, createOpenNanProvider, type OpenNanProviderOptions } from "./provider";
import { OpenNanSession, memoryCredentialStore, type SessionNotice } from "./session";
import { OpenNanSignInRequiredError, SIGN_IN_GUIDANCE } from "./errors";

const KEY = "sk-test_abcdefghijklmnopqrstuvwxyz0123";

interface Call { method: string; path: string; query: string; body: unknown; auth: string | null }

function server(routes: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        let body: unknown;
        try {
            body = init.body ? JSON.parse(String(init.body)) : undefined;
        } catch {
            body = "(bytes)";
        }
        const call: Call = { method: init.method ?? "GET", path: url.host === "api.opennan.com" ? url.pathname : url.href, query: url.search, body, auth: new Headers(init.headers).get("authorization") };
        calls.push(call);
        return routes(call);
    }) as typeof globalThis.fetch;
    return { api: createOpenNanApi({ baseUrl: "https://api.opennan.com", fetch }), calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const task = (status: string, extra: Record<string, unknown> = {}) => ({ id: "task_1", object: "task", model: "m", status, progress: 0, outputs: [], price_usd: 0, error: null, ...extra });

async function signedIn(routes: (call: Call) => Response | Promise<Response>, options: OpenNanProviderOptions = {}) {
    const { api, calls } = server((call) => {
        if (call.path === "/v1/account") return json(200, { email: "ada@example.com", balance_usd: 5, key: { id: "key_1" } });
        return routes(call);
    });
    const session = new OpenNanSession({ api, store: memoryCredentialStore({ apiKey: KEY, keyId: "key_1" }), deviceName: "Mac", client: "desktop" });
    await session.restore();
    const notices: SessionNotice[] = [];
    session.onNotice((n) => notices.push(n));
    return { session, calls, notices, provider: createOpenNanProvider(session, options) };
}

describe("createOpenNanProvider", () => {
    it("is the opennan provider for every open capability it can run and every opennan.* capability", async () => {
        const { provider } = await signedIn(() => json(404, {}));
        expect(provider.info.id).toBe("opennan");
        expect(provider.info.name).toBe("OpenNan");
        expect(provider.info.capabilities).toEqual(OPENNAN_PROVIDER_CAPABILITIES);
        for (const capability of OPENNAN_CAPABILITIES) expect(provider.info.capabilities).toContain(capability);
        expect(provider.info.capabilities).toContain("image.generate");
        expect(provider.info.capabilities).toContain("audio.transcribe");
        expect(provider.info.capabilities).toContain("audio.isolate-voice");
        expect(provider.info.capabilities).not.toContain("render.export");
        expect(provider.info.capabilities).not.toContain("media.stabilize");
        const registry = new ProviderRegistry();
        registry.register(provider);
        expect(registry.route("opennan.story.storyboard")?.info.id).toBe("opennan");
    });

    it("passes the provider contract", async () => {
        // Lists answer (prices never hang the contract); jobs never finish.
        const { provider } = await signedIn((call) => (call.method === "GET" && call.path !== "/v1/tasks" ? json(404, {}) : new Promise<Response>(() => undefined)));
        for (const c of providerContractCases(provider)) await c.run();
    });

    it("answers signed-out calls with the sign-in guidance and a notice", async () => {
        const { api, calls } = server(() => json(404, {}));
        const session = new OpenNanSession({ api, store: memoryCredentialStore(), deviceName: "Mac", client: "desktop" });
        await session.restore();
        const notices: SessionNotice[] = [];
        session.onNotice((n) => notices.push(n));
        const job = createOpenNanProvider(session).run!({ capability: "image.generate", input: { description: "a cat" } });
        const error = await job.result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanSignInRequiredError);
        expect(error).toBeInstanceOf(CapabilityUnavailableError);
        expect((error as Error).message).toBe(SIGN_IN_GUIDANCE);
        expect(notices).toEqual([{ kind: "sign-in-needed", feature: "image.generate" }]);
        expect(calls).toEqual([]);
    });

    it("generates an image: model from the catalog, task polled until it succeeds, progress reported", async () => {
        let polls = 0;
        const { provider, calls } = await signedIn((call) => {
            if (call.path === "/v1/models") return json(200, { object: "list", data: [{ id: "nano-banana-2", name: "Nano Banana 2" }, { id: "other" }] });
            if (call.path === "/v1/images/generations") return json(202, task("queued"));
            if (call.path === "/v1/tasks/task_1") {
                polls += 1;
                return json(200, polls === 1 ? task("running", { progress: 40, stage: "rendering" }) : task("succeeded", { progress: 100, outputs: [{ type: "image", url: "https://cdn.opennan.com/out.png" }], price_usd: 0.04 }));
            }
            return json(404, {});
        });
        const job = provider.run!({ capability: "image.generate", input: { description: "a cat", aspectRatio: "16:9" } });
        const updates: JobUpdate[] = [];
        job.subscribe?.((u) => updates.push(u));
        expect(await job.result()).toEqual({ media: [{ kind: "image", url: "https://cdn.opennan.com/out.png" }], costUsd: 0.04 });
        const create = calls.find((c) => c.path === "/v1/images/generations")!;
        expect(create.body).toEqual({ model: "nano-banana-2", prompt: "a cat", aspect_ratio: "16:9" });
        expect(create.auth).toBe(`Bearer ${KEY}`);
        expect(calls.filter((c) => c.path === "/v1/tasks/task_1").map((c) => c.query)).toEqual(["?wait=50", "?wait=50"]);
        expect(updates).toContainEqual({ status: "running", progress: 0.4, message: "Rendering" });
        expect(calls.find((c) => c.path === "/v1/models")!.query).toBe("?category=image");
    });

    it("maps the other generation capabilities to their endpoints", async () => {
        const { provider, calls } = await signedIn((call) => {
            if (call.path === "/v1/audio/speech" || call.path === "/v1/audio/sound-effects") return new Response(new Uint8Array([7, 8]), { status: 200, headers: { "content-type": "audio/mpeg" } });
            if (call.path.endsWith("/generations")) return json(202, task("succeeded", { outputs: [{ type: call.path.includes("music") ? "audio" : "video", url: "https://cdn.opennan.com/o" }] }));
            return json(404, {});
        });
        await provider.run!({ capability: "video.text-to-video", input: { description: "waves", model: "kling-3", durationSeconds: 5, aspectRatio: "9:16" } }).result();
        await provider.run!({ capability: "video.image-to-video", input: { image: "https://x/a.png", model: "kling-3" } }).result();
        expect(await provider.run!({ capability: "audio.music", input: { description: "calm piano", durationSeconds: 30, instrumental: true } }).result()).toEqual({ media: [{ kind: "audio", url: "https://cdn.opennan.com/o" }] });
        const speech = await provider.run!({ capability: "audio.tts", input: { text: "Hello", voice: "af_heart" } }).result();
        expect(speech.media[0]).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
        expect([...(speech.media[0]!.bytes ?? [])]).toEqual([7, 8]);
        await provider.run!({ capability: "audio.sfx", input: { description: "door slam", durationSeconds: 2 } }).result();
        const bodies = Object.fromEntries(calls.filter((c) => c.method === "POST").map((c) => [c.path + (c.body && (c.body as { image?: string }).image ? "#i2v" : ""), c.body]));
        expect(bodies["/v1/videos/generations"]).toEqual({ model: "kling-3", prompt: "waves", duration: 5, aspect_ratio: "9:16" });
        expect(bodies["/v1/videos/generations#i2v"]).toEqual({ model: "kling-3", prompt: "", image: "https://x/a.png" });
        expect(bodies["/v1/music/generations"]).toEqual({ prompt: "calm piano", duration: 30, instrumental: true });
        expect(bodies["/v1/audio/speech"]).toEqual({ input: "Hello", voice: "af_heart", response_format: "mp3" });
        expect(bodies["/v1/audio/sound-effects"]).toEqual({ text: "door slam", duration_seconds: 2, response_format: "mp3" });
    });

    it("refuses bad input without a request", async () => {
        const { provider, calls } = await signedIn(() => json(404, {}));
        await expect(provider.run!({ capability: "image.generate", input: {} }).result()).rejects.toThrow(/description/);
        await expect(provider.run!({ capability: "video.image-to-video", input: { image: "file:///etc/passwd" } }).result()).rejects.toThrow(/https/);
        expect(calls.filter((c) => c.path !== "/v1/account")).toEqual([]);
    });

    it("explains capabilities that need OpenNan cloud projects", async () => {
        const { provider } = await signedIn(() => json(404, {}));
        const error = await provider.run!({ capability: "opennan.story.storyboard", input: {} }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CapabilityUnavailableError);
        expect((error as Error).message).toMatch(/OpenNan cloud projects/);
    });

    it("turns a 402 into the credits message and a notice", async () => {
        const { provider, notices } = await signedIn(() => json(402, { error: { type: "billing_error", message: "Balance too low", code: "insufficient_balance" } }));
        const error = await provider.run!({ capability: "image.generate", input: { description: "a cat", model: "m" } }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(JobFailedError);
        expect((error as Error).message).toBe(INSUFFICIENT_CREDITS_MESSAGE);
        expect(notices).toEqual([{ kind: "insufficient-credits", billingUrl: "https://opennan.com/console/billing" }]);
    });

    it("signs out on 401 and answers with the guidance", async () => {
        const { provider, session } = await signedIn((call) => (call.path === "/v1/images/generations" ? json(401, { error: { type: "authentication_error", message: "revoked", code: "invalid_api_key" } }) : json(404, {})));
        const error = await provider.run!({ capability: "image.generate", input: { description: "a cat", model: "m" } }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OpenNanSignInRequiredError);
        await vi.waitFor(() => expect(session.status()).toEqual({ state: "signed-out" }));
    });

    it("reports a failed task with its message", async () => {
        const { provider } = await signedIn((call) => (call.path === "/v1/images/generations" ? json(202, task("failed", { error: { message: "The model refused this description.", refunded: true } })) : json(404, {})));
        await expect(provider.run!({ capability: "image.generate", input: { description: "x", model: "m" } }).result()).rejects.toThrow("The model refused this description.");
    });

    it("shows Studio's words for an error code, never the server's text (phase 11.1)", async () => {
        const { provider } = await signedIn((call) => (call.path === "/v1/videos/generations"
            ? json(400, { error: { type: "invalid_request_error", message: "kling-3 via supplier-x does not offer 4k: try 1080p.", code: "tier_not_offered" } })
            : json(404, {})));
        const error = await provider.run!({ capability: "video.text-to-video", input: { description: "a cat", model: "kling-3" } }).result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(JobFailedError);
        expect(error).toMatchObject({ message: "This quality isn't available, pick another. You were not charged.", code: "tier_not_offered", refunded: true });
        const { provider: down } = await signedIn((call) => (call.path === "/v1/images/generations"
            ? json(503, { error: { type: "unavailable", message: "upstream fal queue timeout (internal)", code: "unavailable" } })
            : json(404, {})));
        await expect(down.run!({ capability: "image.generate", input: { description: "a cat", model: "m" } }).result()).rejects.toMatchObject({ message: "OpenNan can't run this right now. Try again later. You were not charged.", code: "unavailable" });
    });

    it("keeps a failed task's text off screen when it carries internals", async () => {
        const { provider } = await signedIn((call) => (call.path === "/v1/images/generations" ? json(202, task("failed", { error: { message: "Traceback (most recent call last): KeyError", refunded: true } })) : json(404, {})));
        await expect(provider.run!({ capability: "image.generate", input: { description: "x", model: "m" } }).result()).rejects.toThrow("The OpenNan task failed. You were not charged.");
    });

    it("a refusal before anything ran says nothing was charged (refunded), unlike a failed poll", async () => {
        const { provider } = await signedIn((call) => (call.path === "/v1/images/generations"
            ? json(503, { error: { type: "unavailable", message: "This model couldn't start the generation right now. You were not charged.", code: "unavailable" } })
            : json(404, {})));
        const error = await provider.run!({ capability: "image.generate", input: { description: "a cat", model: "m" } }).result().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "unavailable", refunded: true, message: "OpenNan can't run this right now. Try again later. You were not charged." });
        const { provider: speech } = await signedIn((call) => (call.path === "/v1/audio/speech"
            ? json(400, { error: { type: "invalid_request_error", message: "voice: unknown voice", code: "invalid_request" } })
            : json(404, {})));
        await expect(speech.run!({ capability: "audio.tts", input: { text: "hi", voice: "nope" } }).result()).rejects.toMatchObject({ refunded: true, message: "voice: unknown voice. You were not charged." });
    });

    it("checks music and sound effect lengths against the server's limits before sending", async () => {
        const { provider, calls } = await signedIn(() => json(404, {}));
        await expect(provider.run!({ capability: "audio.sfx", input: { description: "rain", durationSeconds: 25 } }).result()).rejects.toThrow(/durationSeconds must be a number from 0.5 to 22/);
        await expect(provider.run!({ capability: "audio.music", input: { description: "piano", durationSeconds: 5 } }).result()).rejects.toThrow(/durationSeconds must be a number from 10 to 240/);
        expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    });

    it("cancels: asks the server to cancel the task", async () => {
        let release!: () => void;
        const { provider, calls } = await signedIn((call) => {
            if (call.path === "/v1/images/generations") return json(202, task("queued"));
            if (call.path === "/v1/tasks/task_1/cancel") return json(200, task("cancelled"));
            if (call.path === "/v1/tasks/task_1") return new Promise<Response>((resolve) => { release = () => resolve(json(200, task("running"))); });
            return json(404, {});
        });
        const job = provider.run!({ capability: "image.generate", input: { description: "x", model: "m" } });
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1")).toBe(true));
        await job.cancel();
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/tasks/task_1/cancel")).toBe(true));
        release();
    });

    it("refreshes the balance after a job settles", async () => {
        const { provider, session } = await signedIn((call) => (call.path === "/v1/images/generations" ? json(202, task("succeeded", { outputs: [{ type: "image", url: "https://cdn.opennan.com/a.png" }] })) : json(404, {})));
        const spy = vi.spyOn(session, "refreshSoon");
        await provider.run!({ capability: "image.generate", input: { description: "x", model: "m" } }).result();
        expect(spy).toHaveBeenCalled();
    });

    it("lists and caches models per category", async () => {
        const { provider, calls } = await signedIn((call) => (call.path === "/v1/models" ? json(200, { data: [{ id: "kling-3", name: "Kling 3" }, { id: 5 }] }) : json(404, {})));
        expect(await provider.models!("video.text-to-video")).toEqual([{ id: "kling-3", label: "Kling 3", default: true }]);
        await provider.models!("video.image-to-video");
        expect(calls.filter((c) => c.path === "/v1/models")).toHaveLength(1);
        expect(await provider.models!("opennan.qc")).toEqual([]);
    });
});

describe("output links", () => {
    it("keeps only https outputs from the production API", async () => {
        const { provider } = await signedIn((call) => (call.path === "/v1/images/generations"
            ? json(202, task("succeeded", { outputs: [{ type: "image", url: "http://127.0.0.1/a.png" }, { type: "image", url: "https://u:p@cdn.opennan.com/b.png" }, { type: "image", url: "https://cdn.opennan.com/c.png" }] }))
            : json(404, {})));
        expect(await provider.run!({ capability: "image.generate", input: { description: "x", model: "m" } }).result()).toEqual({ media: [{ kind: "image", url: "https://cdn.opennan.com/c.png" }] });
    });
});

describe("upload hosts", () => {
    const still: MediaPreparer = async () => ({ data: new Uint8Array([1, 2, 3]), contentType: "image/png", filename: "still.png", sizeBytes: 3 });
    const routes = (call: Call) => {
        if (call.path === "/v1/uploads") return json(201, { upload_id: "up_1", upload_url: "https://storage.example.org/k?sig=1", media_url: "https://media.example.org/k" });
        if (call.path.startsWith("https://storage.example.org/")) return new Response(null, { status: 200 });
        if (call.path === "/v1/uploads/up_1/complete") return json(200, { media_url: "https://media.example.org/k" });
        if (call.path === "/v1/images/generations") return json(202, task("succeeded", { outputs: [{ type: "image", url: "https://cdn.opennan.com/c.png" }] }));
        return json(404, {});
    };
    const run = (provider: ReturnType<typeof createOpenNanProvider>) => provider.run!({ capability: "image.edit", input: { description: "x", model: "m", image: { mediaUrl: "opennan-local://media/still" } } }).result();

    it("PUTs only to OpenNan's storage by default, and to another host when the provider allows it", async () => {
        const refused = await signedIn(routes, { prepareMedia: still });
        await expect(run(refused.provider)).rejects.toThrow("OpenNan sent an upload address Studio will not use.");
        expect(refused.calls.some((c) => c.method === "PUT")).toBe(false);
        const widened = await signedIn(routes, { prepareMedia: still, uploadHosts: ["*.r2.cloudflarestorage.com", "storage.example.org"] });
        await run(widened.provider);
        expect(widened.calls.filter((c) => c.method === "PUT").map((c) => c.path)).toEqual(["https://storage.example.org/k?sig=1"]);
    });
});

describe("task polling pace", () => {
    it("waits at least a second between task polls even when the server answers at once, and gives up after the deadline", async () => {
        vi.useFakeTimers();
        try {
            const { provider, calls } = await signedIn((call) => {
                if (call.path === "/v1/images/generations") return json(202, task("queued"));
                if (call.path === "/v1/tasks/task_1") return json(200, task("running"));
                return json(404, {});
            });
            const job = provider.run!({ capability: "image.generate", input: { description: "x", model: "m" } });
            const outcome = job.result().catch((e: unknown) => e);
            await vi.advanceTimersByTimeAsync(5_000);
            const polls = calls.filter((c) => c.path === "/v1/tasks/task_1").length;
            expect(polls).toBeGreaterThanOrEqual(4);
            expect(polls).toBeLessThanOrEqual(6);
            await vi.advanceTimersByTimeAsync(61 * 60_000);
            expect(String(await outcome)).toMatch(/did not finish/);
        } finally {
            vi.useRealTimers();
        }
    // An hour of fake time is ~3,600 poll loops; under full parallel load that exceeds the 5 s default.
    }, 30_000);
});

describe("@opennan/provider-opennan index", () => {
    it("exports version 0.6.0 and the phase 11 API", async () => {
        const index = await import("./index");
        expect(index.PROVIDER_OPENNAN_VERSION).toBe("0.8.0");
        expect(typeof index.uploadMedia).toBe("function");
        expect(typeof index.priceRun).toBe("function");
        expect(index.MEDIA_TOOL_CAPABILITIES).toContain("video.upscale");
    });
});
