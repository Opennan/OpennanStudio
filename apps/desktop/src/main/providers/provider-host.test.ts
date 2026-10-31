// The main-process provider host against the fake OpenNan server: jobs, imported media, typed failures.
import { OpenNanSession, createOpenNanApi, memoryCredentialStore } from "@opennan/provider-opennan";
import { CANCEL_REFUSED_MESSAGE, createJob, type MediaPrepareInput, type MediaPreparePurpose, type MediaPreparer } from "@opennan/provider-sdk";
import { startFakeOpenNan, type FakeOpenNan } from "@opennan/provider-opennan/testing";
import { EVENTS } from "../../shared/channels";
import { createProviderHost, type ProviderJobEvent } from "./provider-host";

let fake: FakeOpenNan;
beforeAll(async () => {
    fake = await startFakeOpenNan({ intervalSeconds: 1 });
});
afterAll(() => fake.close());
beforeEach(() => fake.reset());

const MEDIA = "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
/** 1 s of 44.1 kHz mono silence as WAV bytes (what main's ffmpeg would make). */
function wavBytes(seconds = 1, rate = 44_100): Uint8Array {
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
    return new Uint8Array(buffer);
}

function fakePreparer() {
    const calls: Array<{ input: MediaPrepareInput; purpose: MediaPreparePurpose }> = [];
    const prepareMedia: MediaPreparer = async (input, purpose) => {
        calls.push({ input, purpose });
        const data = wavBytes(2, purpose.sampleRate ?? 16_000);
        return { data, contentType: "audio/wav", filename: "audio.wav", sizeBytes: data.byteLength, durationSeconds: 2 };
    };
    return { calls, prepareMedia };
}

const control = (path: string) => fetch(`${fake.url}/__test/${path}`, { method: "POST" });

async function setup(signedIn = true, extra: { prepareMedia?: MediaPreparer } = {}) {
    const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(signedIn ? { apiKey: fake.mintKey(), keyId: "key_1" } : null), deviceName: "Mac", client: "desktop" });
    await session.restore();
    const events: ProviderJobEvent[] = [];
    const imports: Array<{ projectId: string; name: string; mimeType: string; kind: string; size: number }> = [];
    const host = createProviderHost({
        session,
        ...extra,
        allowLoopbackDownloads: true,
        now: () => Date.parse("2026-10-19T12:00:00Z"),
        mediaStore: {
            importBytes: async ({ projectId, name, mimeType, kind, bytes }) => {
                imports.push({ projectId, name, mimeType, kind, size: bytes.byteLength });
                return { id: "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name, size: bytes.byteLength, mimeType };
            },
        },
        send: (channel, payload) => {
            expect(channel).toBe(EVENTS.providersJob);
            events.push(payload as ProviderJobEvent);
        },
    });
    return { host, events, imports, session };
}
const PROJECT = "11111111-2222-4333-8444-555555555555";
const last = (events: ProviderJobEvent[], jobId: string) => events.filter((e) => e.jobId === jobId).at(-1);

describe("provider host", () => {
    it("lists OpenNan, runs a job, and imports its media into the media store", async () => {
        const { host, events, imports } = await setup();
        expect(host.list().map((p) => p.id)).toEqual(["opennan"]);
        expect((await host.models("opennan", "image.generate")).map((m) => m.id)).toEqual(["nano-banana-2", "seedream-4", "nano-banana-pro"]);
        const { jobId } = host.run({ providerId: "opennan", capability: "image.generate", input: { description: "a cat" }, projectId: PROJECT });
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("succeeded"), { timeout: 5000 });
        expect(imports).toEqual([{ projectId: PROJECT, name: "image-20261019-120000.png", mimeType: "image/png", kind: "image", size: 68 }]);
        expect(last(events, jobId)!.output).toEqual({
            media: [{ kind: "image", url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: "image-20261019-120000.png", mimeType: "image/png", sizeBytes: 68 }],
            costUsd: 0.039,
        });
        expect(events.some((e) => e.jobId === jobId && e.status === "running")).toBe(true);
        for (const event of events) expect(JSON.stringify(event)).not.toMatch(/sk-/);
    });

    it("writes speech bytes", async () => {
        const { host, events, imports } = await setup();
        const { jobId } = host.run({ providerId: "opennan", capability: "audio.tts", input: { text: "Hello" }, projectId: PROJECT });
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("succeeded"), { timeout: 5000 });
        expect(imports[0]).toMatchObject({ mimeType: "audio/wav", name: "audio-20261019-120000.wav", kind: "audio" });
    });

    it("types failures: signed out → unavailable, 402 → insufficient-credits", async () => {
        const signedOut = await setup(false);
        const a = signedOut.host.run({ providerId: "opennan", capability: "image.generate", input: { description: "x" }, projectId: PROJECT });
        await vi.waitFor(() => expect(last(signedOut.events, a.jobId)).toMatchObject({ status: "failed", errorKind: "unavailable", error: expect.stringMatching(/Connect OpenNan/) }));
        const broke = await setup();
        fake.setBalance(0);
        const b = broke.host.run({ providerId: "opennan", capability: "image.generate", input: { description: "x", model: "m" }, projectId: PROJECT });
        await vi.waitFor(() => expect(last(broke.events, b.jobId)).toMatchObject({ status: "failed", errorKind: "insufficient-credits" }));
    });

    it("refuses unknown providers and capabilities, and more than 4 jobs at once", async () => {
        const { host } = await setup();
        expect(() => host.run({ providerId: "fal", capability: "image.generate", input: {}, projectId: PROJECT })).toThrow(/does not run/);
        // audio.transcribe has its own call (transcribe()).
        expect(() => host.run({ providerId: "opennan", capability: "audio.transcribe", input: {}, projectId: PROJECT })).toThrow(/does not run/);
        expect(() => host.transcribe({ providerId: "fal", audio: { kind: "media", url: MEDIA } })).toThrow(/does not run/);
        for (let i = 0; i < 4; i++) host.run({ providerId: "opennan", capability: "image.generate", input: { description: "x", model: "m" }, projectId: PROJECT });
        expect(() => host.run({ providerId: "opennan", capability: "image.generate", input: { description: "x", model: "m" }, projectId: PROJECT })).toThrow(/At most 4/);
        host.cancelAll();
    });

    it("cancels a job", async () => {
        const { host, events } = await setup();
        const { jobId } = host.run({ providerId: "opennan", capability: "image.generate", input: { description: "x", model: "m" }, projectId: PROJECT });
        await host.cancel(jobId);
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("cancelled"));
    });

    it("adds fal while its key is stored", async () => {
        const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(), deviceName: "Mac", client: "desktop" });
        let key: string | null = null;
        const host = createProviderHost({ session, mediaStore: { importBytes: async () => { throw new Error("unused"); } }, send: () => undefined, falKey: () => key });
        expect(host.list().map((p) => p.id)).toEqual(["opennan"]);
        key = "fal-key-123";
        host.syncKeys();
        expect(host.list().map((p) => p.id)).toEqual(["opennan", "fal"]);
        expect((await host.models("fal", "image.generate"))[0]!.id).toBe("fal-ai/flux/schnell");
        key = null;
        host.syncKeys();
        expect(host.list().map((p) => p.id)).toEqual(["opennan"]);
    });

    it("refuses a download that redirects to plain http or a private address", async () => {
        const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(), deviceName: "Mac", client: "desktop" });
        for (const location of ["http://cdn.example/a.png", "https://169.254.169.254/latest/meta-data"]) {
            const events: ProviderJobEvent[] = [];
            const fetched: string[] = [];
            const host = createProviderHost({
                session, send: (_c, payload) => void events.push(payload as ProviderJobEvent), mediaStore: { importBytes: async () => { throw new Error("must not import"); } },
                providers: [{ info: { id: "test", name: "Test", capabilities: ["image.generate"] }, run: () => createJob(async () => ({ media: [{ kind: "image" as const, url: "https://cdn.example/a.png" }] })) }],
                fetch: (async (url: RequestInfo | URL) => {
                    fetched.push(String(url));
                    return new Response(null, { status: 302, headers: { location } });
                }) as typeof globalThis.fetch,
            });
            const { jobId } = host.run({ providerId: "test", capability: "image.generate", input: {}, projectId: PROJECT });
            await vi.waitFor(() => expect(last(events, jobId)).toMatchObject({ status: "failed", error: expect.stringMatching(/https|private/) }));
            expect(fetched).toEqual(["https://cdn.example/a.png"]);
        }
    });

    it("brings back the source's pixel size and the imported result's", async () => {
        const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(), deviceName: "Mac", client: "desktop" });
        const events: ProviderJobEvent[] = [];
        const host = createProviderHost({
            session, send: (_c, payload) => void events.push(payload as ProviderJobEvent),
            mediaStore: { importBytes: async ({ name, mimeType, bytes }) => ({ id: "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", url: MEDIA, name, size: bytes.byteLength, mimeType, width: 3840, height: 2160 }) },
            providers: [{ info: { id: "test", name: "Test", capabilities: ["video.upscale"] }, run: () => createJob(async () => ({
                media: [{ kind: "video" as const, bytes: new Uint8Array(8), mimeType: "video/mp4" }], sourceSize: { width: 1920, height: 1080 },
            })) }],
        });
        const { jobId } = host.run({ providerId: "test", capability: "video.upscale", input: { source: { mediaUrl: MEDIA } }, projectId: PROJECT });
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("succeeded"));
        expect(last(events, jobId)!.output).toMatchObject({ media: [{ kind: "video", width: 3840, height: 2160 }], sourceSize: { width: 1920, height: 1080 } });
    });

    it("redacts key-shaped text from failures before they reach the renderer", async () => {
        const session = new OpenNanSession({ api: createOpenNanApi({ baseUrl: fake.url }), store: memoryCredentialStore(), deviceName: "Mac", client: "desktop" });
        const events: ProviderJobEvent[] = [];
        const host = createProviderHost({
            session, send: (_c, payload) => void events.push(payload as ProviderJobEvent), mediaStore: { importBytes: async () => { throw new Error("unused"); } },
            providers: [{ info: { id: "test", name: "Test", capabilities: ["image.generate"] }, run: () => createJob(async ({ report }) => {
                report(0.5, "using sk-live_abcdefghijklmnop");
                throw new Error("bad key sk-live_abcdefghijklmnop");
            }) }],
        });
        const { jobId } = host.run({ providerId: "test", capability: "image.generate", input: {}, projectId: PROJECT });
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("failed"));
        expect(JSON.stringify(events)).not.toContain("sk-live_abcdefghijklmnop");
    });

    it("refuses media references that are not imported media, before anything runs", async () => {
        const { host, events } = await setup(true, fakePreparer());
        for (const input of [
            { source: { mediaUrl: "https://cdn.example/a.wav" } }, { source: { mediaUrl: "file:///etc/passwd" } }, { videoSource: { mediaUrl: "blob:x" } },
            { audioSource: { mediaUrl: "opennan-local://media/../x" } }, { image: { mediaUrl: "https://cdn.example/a.png" } }, { endImage: { mediaUrl: "/etc/passwd" } },
            { source: { mediaUrl: MEDIA, extra: true } },
        ]) {
            expect(() => host.run({ providerId: "opennan", capability: "audio.isolate-voice", input, projectId: PROJECT })).toThrow(/imported into this project/);
        }
        expect(() => host.transcribe({ providerId: "opennan", audio: { kind: "media", url: "https://cdn.example/a.wav" } })).toThrow(/imported into this project/);
        expect(events).toEqual([]);
        expect(fake.state().requests.filter((r) => r.method !== "GET")).toEqual([]);
    });

    it("isolates a clip's voice: main prepares the range, the upload goes from main, the result is imported", async () => {
        const preparer = fakePreparer();
        const { host, events, imports } = await setup(true, preparer);
        const source = { mediaUrl: MEDIA, startSeconds: 1, endSeconds: 3 };
        const { jobId } = host.run({ providerId: "opennan", capability: "audio.isolate-voice", input: { source }, projectId: PROJECT });
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("succeeded"), { timeout: 5000 });
        expect(preparer.calls).toEqual([{ input: { kind: "media", source }, purpose: expect.objectContaining({ output: "audio", sampleRate: 44_100 }) }]);
        const state = fake.state();
        expect(state.uploads).toEqual([expect.objectContaining({ contentType: "audio/wav", put: true, completed: true })]);
        // A tool input is a temporary upload: one PUT to a single-use gateway link, no key, a temp media URL.
        const puts = state.requests.filter((r) => r.method === "PUT");
        expect(puts).toEqual([expect.objectContaining({ path: expect.stringMatching(/^\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), authorized: false })]);
        const isolation = state.requests.find((r) => r.method === "POST" && r.path === "/v1/audio/isolations");
        expect((isolation!.body as { audio_url: string }).audio_url).toMatch(new RegExp(`^${fake.url.replace(/[.]/g, "\\.")}/files/uploads/temp/[0-9a-f]{24}/[a-z0-9]+\\.wav$`));
        expect(imports).toEqual([expect.objectContaining({ kind: "audio", projectId: PROJECT })]);
        expect(last(events, jobId)!.output).toMatchObject({ media: [expect.objectContaining({ kind: "audio", url: expect.stringMatching(/^opennan-local:/) })], costUsd: expect.any(Number) });
        for (const event of events) expect(JSON.stringify(event)).not.toMatch(/sk-|__uploads|files\/uploads|\/u\/[A-Za-z0-9_-]+\./);
    });

    it("reports a refused cancel: the job runs on, cancellable false, and finishes", async () => {
        const { host, events } = await setup(true, fakePreparer());
        await control("paid-started?tool=voice-isolation");
        // Several running polls (1 s apart): room for the cancel to land while the paid step runs, even on a busy machine.
        await control("task-steps?n=3");
        const { jobId } = host.run({ providerId: "opennan", capability: "audio.isolate-voice", input: { source: { mediaUrl: MEDIA } }, projectId: PROJECT });
        // A stage means the task runs with its paid step started.
        const early = ["Preparing", "Uploading", "Queued"];
        await vi.waitFor(() => expect(events.some((e) => e.jobId === jobId && e.message !== undefined && !early.includes(e.message))).toBe(true), { timeout: 10_000 });
        expect(await host.cancel(jobId)).toEqual({ cancelled: false, message: CANCEL_REFUSED_MESSAGE });
        expect(events.some((e) => e.jobId === jobId && e.cancellable === false && e.message === CANCEL_REFUSED_MESSAGE)).toBe(true);
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("succeeded"), { timeout: 15_000 });
        expect(await host.cancel(jobId)).toEqual({ cancelled: false, message: "It had already finished." });
        // An id main never ran: nothing to say about it.
        expect(await host.cancel("job-main999")).toEqual({ cancelled: false });
    }, 30_000);

    it("passes a failure's refund on", async () => {
        const { host, events } = await setup(true, fakePreparer());
        await control("fail-next?tool=voice-isolation&kind=pipeline_failed");
        const { jobId } = host.run({ providerId: "opennan", capability: "audio.isolate-voice", input: { source: { mediaUrl: MEDIA } }, projectId: PROJECT });
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("failed"), { timeout: 5000 });
        expect(last(events, jobId)).toMatchObject({ errorKind: "failed", refunded: true, error: expect.stringMatching(/not charged/) });
    });

    it("makes cloud captions of a clip's range and answers the transcript", async () => {
        const preparer = fakePreparer();
        const { host, events } = await setup(true, preparer);
        const { jobId } = host.transcribe({ providerId: "opennan", audio: { kind: "media", url: MEDIA, startSeconds: 0, endSeconds: 2 }, language: "en" });
        await vi.waitFor(() => expect(last(events, jobId)?.status).toBe("succeeded"), { timeout: 5000 });
        expect(preparer.calls[0]).toMatchObject({ input: { kind: "media", source: { mediaUrl: MEDIA, startSeconds: 0, endSeconds: 2 } }, purpose: { sampleRate: 16_000 } });
        expect(last(events, jobId)!.transcript).toMatchObject({ model: "cloud", segments: expect.any(Array) });
        expect(fake.state().requests.some((r) => r.method === "POST" && r.path === "/v1/audio/transcriptions")).toBe(true);
    });

    it("answers prices and voices from the provider, unknown when it has none", async () => {
        const { host } = await setup();
        expect(await host.price("opennan", { capability: "audio.isolate-voice", input: {}, units: { seconds: 10 } })).toMatchObject({ kind: "estimate", estimate: { label: expect.stringMatching(/^≈ \$/) } });
        expect(await host.price("fal", { capability: "image.generate", input: {}, units: {} })).toEqual({ kind: "unknown" });
        expect((await host.voices("opennan")).length).toBeGreaterThan(0);
        expect(await host.voices("fal")).toEqual([]);
    });
});
