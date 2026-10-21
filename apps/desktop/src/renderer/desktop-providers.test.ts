import { JobCancelledError, JobFailedError, type JobUpdate } from "@opennan/provider-sdk";
import type { AiJobEvent } from "../shared/bridge";
import { createDesktopProviders, createLocalMediaProvider, createRemoteLocalProvider } from "./desktop-providers";
import { createTestBridge } from "./test-bridge";

const SNAPSHOT = { projectId: "p", project: null, tracks: [], clips: [], scenes: [] };
const TRANSCRIPT = { language: "en", segments: [{ start: 0, end: 1, text: "hi" }] };

function bridgeWithJobs(firstEvents: AiJobEvent[] = []) {
    const listeners = new Set<(event: AiJobEvent) => void>();
    const emit = (event: AiJobEvent) => listeners.forEach((l) => l(event));
    const { bridge } = createTestBridge();
    bridge.ai.onJob = vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    });
    bridge.ai.transcribe = vi.fn(async () => {
        // Main can send events before the invoke answers.
        firstEvents.forEach(emit);
        return { jobId: "job-main" };
    });
    return { bridge, emit, listeners };
}

describe("createRemoteLocalProvider", () => {
    it("mirrors main's job: progress, early events, and the transcript", async () => {
        const { bridge, emit, listeners } = bridgeWithJobs([{ jobId: "job-main", status: "running", progress: 0.1, message: "Checking the Base model" }]);
        const provider = createRemoteLocalProvider(bridge);
        expect(provider.info).toEqual({ id: "local", name: "On this device", capabilities: ["audio.transcribe"], onDevice: true });
        const job = provider.audio!.transcribe!({ audio: { kind: "timeline", snapshot: SNAPSHOT }, language: "th", model: "tiny" });
        const seen: JobUpdate[] = [];
        job.subscribe!((u) => seen.push(u));
        await vi.waitFor(() => expect(bridge.ai.transcribe).toHaveBeenCalledWith({ language: "th", model: "tiny", snapshot: SNAPSHOT }));
        emit({ jobId: "job-other", status: "running", progress: 0.9 });
        emit({ jobId: "job-main", status: "running", progress: 0.5, message: "Transcribing" });
        emit({ jobId: "job-main", status: "succeeded", progress: 1, transcript: TRANSCRIPT });
        await expect(job.result()).resolves.toEqual(TRANSCRIPT);
        expect(seen).toContainEqual({ status: "running", progress: 0.1, message: "Checking the Base model" });
        expect(seen).toContainEqual({ status: "running", progress: 0.5, message: "Transcribing" });
        expect(seen.some((u) => u.progress === 0.9)).toBe(false);
        expect(listeners.size).toBe(0);
    });

    it("fails with main's message and cancels main's job", async () => {
        const { bridge, emit } = bridgeWithJobs();
        const provider = createRemoteLocalProvider(bridge);
        const failing = provider.audio!.transcribe!({ audio: { kind: "timeline", snapshot: SNAPSHOT } });
        await vi.waitFor(() => expect(bridge.ai.transcribe).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        emit({ jobId: "job-main", status: "failed", error: "The timeline has no audio to transcribe." });
        await expect(failing.result()).rejects.toBeInstanceOf(JobFailedError);
        await expect(failing.result()).rejects.toThrow("The timeline has no audio to transcribe.");

        const cancelled = provider.audio!.transcribe!({ audio: { kind: "timeline", snapshot: SNAPSHOT } });
        await new Promise((r) => setTimeout(r, 0));
        await cancelled.cancel();
        await expect(cancelled.result()).rejects.toBeInstanceOf(JobCancelledError);
        await vi.waitFor(() => expect(bridge.ai.cancel).toHaveBeenCalledWith("job-main"));
    });

    it("sends a media range to main as a media source", async () => {
        const { bridge, emit } = bridgeWithJobs();
        const mediaUrl = "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
        const job = createRemoteLocalProvider(bridge).audio!.transcribe!({ audio: { kind: "media", url: mediaUrl, startSeconds: 1, endSeconds: 4 }, language: "en" });
        await vi.waitFor(() => expect(bridge.ai.transcribe).toHaveBeenCalledWith({ language: "en", source: { mediaUrl, startSeconds: 1, endSeconds: 4 } }));
        await new Promise((r) => setTimeout(r, 0));
        emit({ jobId: "job-main", status: "succeeded", progress: 1, transcript: TRANSCRIPT });
        await expect(job.result()).resolves.toEqual(TRANSCRIPT);
    });
});

describe("main cancelling a job", () => {
    it("ends the local job as cancelled, not failed", async () => {
        const { bridge, emit } = bridgeWithJobs();
        const job = createRemoteLocalProvider(bridge).audio!.transcribe!({ audio: { kind: "timeline", snapshot: SNAPSHOT } });
        await vi.waitFor(() => expect(bridge.ai.transcribe).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        emit({ jobId: "job-main", status: "cancelled" });
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        expect(await job.status()).toBe("cancelled");
    });
});

describe("createDesktopProviders", () => {
    it("registers the on-device provider only when main says it is available", async () => {
        const { bridge } = createTestBridge();
        const off = createDesktopProviders(bridge);
        await off.ready;
        expect(off.registry.providerFor("audio.transcribe", { onDevice: true })).toBeNull();
        expect(off.unavailableReason()).toBe("No whisper.cpp in tests");

        bridge.ai.status = vi.fn(async () => ({ available: true, reason: null }));
        const on = createDesktopProviders(bridge);
        await on.ready;
        expect(on.registry.route("audio.transcribe")?.info.id).toBe("local");
        expect(on.unavailableReason()).toBeNull();
    });
});

describe("stabilize on this device", () => {
    const PROJECT = "11111111-2222-4333-8444-555555555555";
    const source = { mediaUrl: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", startSeconds: 1, endSeconds: 3 };

    it("is registered whenever main has ffmpeg, whisper or not", async () => {
        const { bridge } = createTestBridge();
        const on = createDesktopProviders(bridge);
        await on.ready;
        expect(on.registry.route("media.stabilize")?.info).toEqual({ id: "local-media", name: "On this device", capabilities: ["media.stabilize"], onDevice: true });
        bridge.app.info = vi.fn(async () => ({ version: "0.1.0", platform: "darwin", arch: "arm64", ffmpeg: { available: false }, whisper: { available: false } }));
        const off = createDesktopProviders(bridge);
        await off.ready;
        expect(off.registry.route("media.stabilize")).toBeNull();
        // Re-reading main's cloud providers keeps it.
        await on.refreshCloud();
        expect(on.registry.get("local-media")).toBeDefined();
    });

    it("runs one stabilize job in main and resolves its imported video", async () => {
        const listeners = new Set<(event: AiJobEvent) => void>();
        const emit = (event: AiJobEvent) => listeners.forEach((l) => l(event));
        const { bridge } = createTestBridge();
        bridge.ai.onJob = vi.fn((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        });
        bridge.ai.stabilize = vi.fn(async () => {
            emit({ jobId: "job-s", status: "running", progress: 0.2, message: "Stabilizing" });
            return { jobId: "job-s" };
        });
        const provider = createLocalMediaProvider(bridge);
        const job = provider.run!({ capability: "media.stabilize", input: { source }, projectId: PROJECT });
        const updates: JobUpdate[] = [];
        job.subscribe!((u) => updates.push(u));
        await vi.waitFor(() => expect(bridge.ai.stabilize).toHaveBeenCalledWith({ projectId: PROJECT, source }));
        await new Promise((r) => setTimeout(r, 0));
        const media = [{ kind: "video" as const, url: "opennan-local://media/9f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: "Walk (stabilized).mp4", mimeType: "video/mp4", sizeBytes: 9, durationSeconds: 2, width: 1280, height: 720 }];
        emit({ jobId: "job-s", status: "succeeded", progress: 1, output: { media, sourceSize: { width: 1280, height: 720 } } });
        await expect(job.result()).resolves.toEqual({ media, sourceSize: { width: 1280, height: 720 } });
        expect(updates).toContainEqual({ status: "running", progress: 0.2, message: "Stabilizing" });
        expect(listeners.size).toBe(0);
    });

    it("cancels in main, and refuses other capabilities and bad sources", async () => {
        const { bridge } = createTestBridge();
        const provider = createLocalMediaProvider(bridge);
        const job = provider.run!({ capability: "media.stabilize", input: { source }, projectId: PROJECT });
        await vi.waitFor(() => expect(bridge.ai.stabilize).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        await job.cancel();
        await vi.waitFor(() => expect(bridge.ai.cancel).toHaveBeenCalledWith("job-stabilize"));
        await expect(job.result()).rejects.toBeInstanceOf(JobCancelledError);
        await expect(provider.run!({ capability: "video.upscale", input: { source }, projectId: PROJECT }).result()).rejects.toThrow(/does not run on this device/);
        await expect(provider.run!({ capability: "media.stabilize", input: { source: "x" }, projectId: PROJECT }).result()).rejects.toThrow(/source/);
        await expect(provider.run!({ capability: "media.stabilize", input: { source } }).result()).rejects.toThrow(/No project/);
        expect(bridge.ai.stabilize).toHaveBeenCalledTimes(1);
    });
});

describe("remote cloud providers", () => {
    const PROJECT = "11111111-2222-4333-8444-555555555555";
    function cloudBridge() {
        const listeners = new Set<(event: import("../shared/bridge").ProviderJobEvent) => void>();
        const emit = (event: import("../shared/bridge").ProviderJobEvent) => listeners.forEach((l) => l(event));
        const { bridge } = createTestBridge();
        bridge.providers.onJob = vi.fn((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        });
        bridge.providers.run = vi.fn(async () => {
            emit({ jobId: "job-main1", status: "running", progress: 0.2, message: "Queued" });
            return { jobId: "job-main1" };
        });
        return { bridge, emit };
    }

    it("registers OpenNan at once and main's other providers after list()", async () => {
        const { bridge } = createTestBridge();
        bridge.providers.list = vi.fn(async () => [{ id: "opennan", name: "OpenNan", capabilities: ["image.generate" as const] }, { id: "fal", name: "fal.ai", capabilities: ["image.generate" as const] }]);
        const providers = createDesktopProviders(bridge);
        expect(providers.registry.route("opennan.story.storyboard")?.info.id).toBe("opennan");
        expect(providers.registry.route("image.generate")?.info.id).toBe("opennan");
        await providers.ready;
        expect(providers.registry.providers().map((p) => p.info.id).sort()).toEqual(["fal", "local-media", "opennan"]);
    });

    it("runs a job in main and resolves its imported media", async () => {
        const { bridge, emit } = cloudBridge();
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const provider = createRemoteCloudProvider(bridge, OPENNAN_INFO);
        const job = provider.run!({ capability: "image.generate", input: { description: "a cat" }, projectId: PROJECT });
        const updates: JobUpdate[] = [];
        job.subscribe!((u) => updates.push(u));
        await vi.waitFor(() => expect(bridge.providers.run).toHaveBeenCalledWith({ providerId: "opennan", capability: "image.generate", input: { description: "a cat" }, projectId: PROJECT }));
        const media = [{ kind: "image" as const, url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", name: "a.png", mimeType: "image/png", sizeBytes: 4, width: 2, height: 2 }];
        emit({ jobId: "job-main1", status: "succeeded", progress: 1, output: { media, costUsd: 0.04, sourceSize: { width: 2, height: 2 } } });
        await expect(job.result()).resolves.toEqual({ media, costUsd: 0.04, sourceSize: { width: 2, height: 2 } });
        expect(updates).toContainEqual({ status: "running", progress: 0.2, message: "Queued" });
    });

    it("maps main's failure kinds to typed errors, and cancels in main", async () => {
        const { CapabilityUnavailableError } = await import("@opennan/provider-sdk");
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const a = cloudBridge();
        const unavailable = createRemoteCloudProvider(a.bridge, OPENNAN_INFO).run!({ capability: "image.generate", input: {}, projectId: PROJECT });
        await vi.waitFor(() => expect(a.bridge.providers.run).toHaveBeenCalled());
        a.emit({ jobId: "job-main1", status: "failed", errorKind: "unavailable", error: "Connect OpenNan: run `opennan-studio login` or sign in from Studio's account chip." });
        const error = await unavailable.result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CapabilityUnavailableError);
        expect((error as Error).message).toMatch(/^Connect OpenNan/);
        const b = cloudBridge();
        const credits = createRemoteCloudProvider(b.bridge, OPENNAN_INFO).run!({ capability: "image.generate", input: {}, projectId: PROJECT });
        await vi.waitFor(() => expect(b.bridge.providers.run).toHaveBeenCalled());
        b.emit({ jobId: "job-main1", status: "failed", errorKind: "insufficient-credits", error: "Not enough credits. Buy credits on opennan.com to continue." });
        await expect(credits.result()).rejects.toBeInstanceOf(JobFailedError);
        const c = cloudBridge();
        const cancelled = createRemoteCloudProvider(c.bridge, OPENNAN_INFO).run!({ capability: "image.generate", input: {}, projectId: PROJECT });
        await vi.waitFor(() => expect(c.bridge.providers.run).toHaveBeenCalled());
        await cancelled.cancel();
        expect(c.bridge.providers.cancel).toHaveBeenCalledWith("job-main1");
        await expect(cancelled.result()).rejects.toBeInstanceOf(JobCancelledError);
        const none = createRemoteCloudProvider(c.bridge, OPENNAN_INFO).run!({ capability: "image.generate", input: {} });
        await expect(none.result()).rejects.toThrow("No project is open.");
    });

    it("asks main for prices and voices", async () => {
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const { bridge } = createTestBridge();
        bridge.providers.price = vi.fn(async () => ({ kind: "estimate" as const, estimate: { microUsd: 130_001, usd: 0.130001, label: "≈ $0.131", units: 1, capped: false } }));
        bridge.providers.voices = vi.fn(async () => [{ id: "af_heart", name: "Heart", language: "en" }]);
        const provider = createRemoteCloudProvider(bridge, OPENNAN_INFO);
        const request = { capability: "audio.isolate-voice" as const, input: {}, units: { seconds: 10 } };
        expect(await provider.price!(request)).toMatchObject({ kind: "estimate", estimate: { label: "≈ $0.131" } });
        expect(bridge.providers.price).toHaveBeenCalledWith("opennan", request);
        expect(await provider.voices!()).toEqual([{ id: "af_heart", name: "Heart", language: "en" }]);
        bridge.providers.price = vi.fn(async () => { throw new Error("Error invoking remote method 'opennan:providers:price': Error: offline"); });
        expect(await provider.price!(request)).toEqual({ kind: "unknown", reason: "offline" });
    });

    it("makes cloud captions through main and resolves the transcript", async () => {
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const { bridge, emit } = cloudBridge();
        bridge.providers.transcribe = vi.fn(async () => ({ jobId: "job-main1" }));
        const provider = createRemoteCloudProvider(bridge, OPENNAN_INFO);
        const audio = { kind: "media" as const, url: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", startSeconds: 2, endSeconds: 4 };
        const job = provider.audio!.transcribe!({ audio, language: "en", expectedMaxUsd: 0.01 });
        await vi.waitFor(() => expect(bridge.providers.transcribe).toHaveBeenCalledWith({ providerId: "opennan", audio, language: "en", expectedMaxUsd: 0.01 }));
        await new Promise((r) => setTimeout(r, 0));
        emit({ jobId: "job-main1", status: "succeeded", progress: 1, transcript: { ...TRANSCRIPT, costUsd: 0.005 } });
        await expect(job.result()).resolves.toEqual({ ...TRANSCRIPT, costUsd: 0.005 });
        // A provider without audio.transcribe has no transcribe method.
        expect(createRemoteCloudProvider(bridge, { id: "fal", name: "fal.ai", capabilities: ["image.generate"] }).audio).toBeUndefined();
    });

    it("keeps running when main's provider refuses the cancel, and says so", async () => {
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const { bridge, emit } = cloudBridge();
        bridge.providers.cancel = vi.fn(async () => ({ cancelled: false }));
        const job = createRemoteCloudProvider(bridge, OPENNAN_INFO).run!({ capability: "audio.isolate-voice", input: {}, projectId: PROJECT });
        const updates: JobUpdate[] = [];
        job.subscribe!((u) => updates.push(u));
        await vi.waitFor(() => expect(bridge.providers.run).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        await job.cancel();
        expect(bridge.providers.cancel).toHaveBeenCalledWith("job-main1");
        expect(await job.status()).toBe("running");
        expect(updates.at(-1)).toMatchObject({ status: "running", cancellable: false });
        emit({ jobId: "job-main1", status: "succeeded", progress: 1, output: { media: [], costUsd: 0.13 } });
        await expect(job.result()).resolves.toEqual({ media: [], costUsd: 0.13 });
    });

    it("a cancel before main names the job waits for the id and returns main's answer", async () => {
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const { bridge, emit } = cloudBridge();
        let answer!: (value: { jobId: string }) => void;
        bridge.providers.run = vi.fn(() => new Promise<{ jobId: string }>((resolve) => {
            answer = resolve;
        }));
        bridge.providers.cancel = vi.fn(async () => ({ cancelled: false }));
        const job = createRemoteCloudProvider(bridge, OPENNAN_INFO).run!({ capability: "audio.separate", input: {}, projectId: PROJECT });
        const updates: JobUpdate[] = [];
        job.subscribe!((u) => updates.push(u));
        await vi.waitFor(() => expect(bridge.providers.run).toHaveBeenCalled());
        const cancelling = job.cancel();
        await new Promise((r) => setTimeout(r, 5));
        expect(await job.status()).toBe("running");
        answer({ jobId: "job-main1" });
        await cancelling;
        expect(bridge.providers.cancel).toHaveBeenCalledWith("job-main1");
        // Main refused (the paid step started): the job runs on and says so, it is not shown as cancelled.
        expect(await job.status()).toBe("running");
        expect(updates.at(-1)).toMatchObject({ status: "running", cancellable: false });
        emit({ jobId: "job-main1", status: "succeeded", progress: 1, output: { media: [], costUsd: 0.01 } });
        await expect(job.result()).resolves.toEqual({ media: [], costUsd: 0.01 });
    });

    it("a cancel before main answers is accepted when main never started the job", async () => {
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const { bridge } = cloudBridge();
        let fail!: (error: Error) => void;
        bridge.providers.run = vi.fn(() => new Promise<{ jobId: string }>((_resolve, reject) => {
            fail = reject;
        }));
        const job = createRemoteCloudProvider(bridge, OPENNAN_INFO).run!({ capability: "audio.separate", input: {}, projectId: PROJECT });
        await vi.waitFor(() => expect(bridge.providers.run).toHaveBeenCalled());
        const cancelling = job.cancel();
        fail(new Error("No project is open."));
        await cancelling;
        expect(bridge.providers.cancel).not.toHaveBeenCalled();
        await expect(job.result()).rejects.toThrow();
    });

    it("passes a failure's code and refund on", async () => {
        const { createRemoteCloudProvider, OPENNAN_INFO } = await import("./desktop-providers");
        const { bridge, emit } = cloudBridge();
        const job = createRemoteCloudProvider(bridge, OPENNAN_INFO).run!({ capability: "audio.isolate-voice", input: {}, projectId: PROJECT });
        await vi.waitFor(() => expect(bridge.providers.run).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        emit({ jobId: "job-main1", status: "failed", errorKind: "failed", error: "The run failed. You were not charged.", code: "pipeline_failed", refunded: true });
        const error = await job.result().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(JobFailedError);
        expect(error).toMatchObject({ code: "pipeline_failed", refunded: true });
    });

    it("saves the fal key in main, then re-reads main's providers", async () => {
        const { createDesktopProviderSettings } = await import("./desktop-providers");
        const { bridge } = createTestBridge();
        let stored = false;
        bridge.secrets.list = vi.fn(async () => [{ name: "FAL_KEY" as const, set: stored }]);
        bridge.secrets.set = vi.fn(async () => { stored = true; });
        bridge.secrets.remove = vi.fn(async () => { stored = false; });
        bridge.providers.list = vi.fn(async () => (stored ? [{ id: "fal", name: "fal.ai", capabilities: ["image.generate" as const] }] : []));
        const providers = createDesktopProviders(bridge);
        const settings = createDesktopProviderSettings(bridge, { onKeysChanged: () => providers.refreshCloud() });
        await settings.ready;
        expect(settings.keys()).toEqual([{ id: "fal", name: "fal.ai", set: false }]);
        await settings.setKey("fal", " fal-key-123 ");
        expect(bridge.secrets.set).toHaveBeenCalledWith("FAL_KEY", "fal-key-123");
        expect(settings.keys()[0]!.set).toBe(true);
        expect(providers.registry.get("fal")).toBeDefined();
        await settings.removeKey("fal");
        expect(providers.registry.get("fal")).toBeUndefined();
    });

    it("keeps routing in desktop settings", async () => {
        const { createDesktopProviderSettings } = await import("./desktop-providers");
        const { bridge } = createTestBridge();
        const settings = createDesktopProviderSettings(bridge);
        await settings.ready;
        expect(settings.routing()).toEqual({ overrides: {}, opennanDefault: true });
        await settings.setRouting({ overrides: { "image.generate": "fal" }, opennanDefault: false });
        expect(bridge.settings.update).toHaveBeenCalledWith({ providerRouting: { overrides: { "image.generate": "fal" }, opennanDefault: false } });
        expect(settings.routing().opennanDefault).toBe(false);
    });
});
