// ai.run phase 11: transcribe sources and engines, placements for media tools, the job book, refusable cancel.
import { createAiRunner, type AiRunProgressLike } from "./ai-runner";
import type { CapabilityOutput, GeneratedMedia } from "./capability-output";
import { JobFailedError } from "./errors";
import { AiJobBook } from "./job-book";
import { createJob, type JobContext } from "./job";
import { ProviderRegistry } from "./registry";
import type { TranscribeRequest, Transcript } from "./transcribe-types";
import type { CapabilityRequest, Provider } from "./types";

const SNAPSHOT = { projectId: "p1", tracks: [], clips: [], scenes: [] };
const TRANSCRIPT: Transcript = {
    language: "en",
    segments: [{ start: 1, end: 3, text: "Hello there", words: [{ start: 1, end: 1.5, text: "Hello" }, { start: 2, end: 3, text: "there" }] }],
};

function transcriber(id: string, onDevice: boolean, result: Transcript = TRANSCRIPT) {
    const requests: TranscribeRequest[] = [];
    const provider: Provider = {
        info: { id, name: id, capabilities: ["audio.transcribe"], onDevice },
        audio: {
            transcribe(request) {
                requests.push(request);
                return createJob(async () => result, { id: `job-${id}` });
            },
        },
    };
    return { provider, requests };
}

function tool(capabilities: CapabilityRequest["capability"][], run: (request: CapabilityRequest, context: JobContext) => Promise<CapabilityOutput>) {
    const requests: CapabilityRequest[] = [];
    const provider: Provider = {
        info: { id: "opennan", name: "OpenNan", capabilities },
        run(request) {
            requests.push(request);
            return createJob((context) => run(request, context), { id: "job-tool" });
        },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    return { registry, requests };
}

const importer = (prefix = "opennan-local://media/") => async (media: GeneratedMedia) => ({
    url: `${prefix}${media.role ?? media.kind}`, name: media.name ?? `${media.kind}.bin`, mimeType: media.mimeType ?? "application/octet-stream", durationSeconds: 4,
});

describe("audio.transcribe sources and engines", () => {
    it("maps a MediaSourceRef to a media input with its range", async () => {
        const { provider, requests } = transcriber("local", true);
        const registry = new ProviderRegistry();
        registry.register(provider);
        await createAiRunner(registry)({ capability: "audio.transcribe", input: { source: { mediaUrl: "opennan-local://media/a", startSeconds: 2, endSeconds: 9.5 } } }, { snapshot: SNAPSHOT });
        expect(requests[0]!.audio).toEqual({ kind: "media", url: "opennan-local://media/a", startSeconds: 2, endSeconds: 9.5 });
        await createAiRunner(registry)({ capability: "audio.transcribe", input: { source: "timeline" } }, { snapshot: SNAPSHOT });
        expect(requests[1]!.audio).toEqual({ kind: "timeline", snapshot: SNAPSHOT });
    });

    it.each([
        [{ source: { mediaUrl: "file:///etc/passwd" } }, "source"],
        [{ source: { mediaUrl: "opennan-local://m", startSeconds: 5, endSeconds: 2 } }, "source"],
        [{ source: { mediaUrl: "opennan-local://m", extra: 1 } }, "source"],
        [{ engine: "gpu" }, "engine"],
        [{ expectedMaxUsd: -1 }, "expectedMaxUsd"],
        [{ expectedMaxUsd: "0.1" }, "expectedMaxUsd"],
    ])("refuses %j", async (input, field) => {
        const { provider, requests } = transcriber("local", true);
        const registry = new ProviderRegistry();
        registry.register(provider);
        const outcome = await createAiRunner(registry)({ capability: "audio.transcribe", input }, { snapshot: SNAPSHOT });
        expect(outcome.error).toMatch(new RegExp(`^ai\\.run audio\\.transcribe: ${field}`));
        expect(requests).toEqual([]);
    });

    it("passes the shown estimate through for a paid engine's price re-check", async () => {
        const { provider, requests } = transcriber("opennan", false);
        const registry = new ProviderRegistry();
        registry.register(provider);
        await createAiRunner(registry)({ capability: "audio.transcribe", input: { expectedMaxUsd: 0.005 } }, { snapshot: SNAPSHOT });
        expect(requests[0]).toMatchObject({ expectedMaxUsd: 0.005 });
    });

    it("picks the engine per run: local = an on-device provider, cloud = another, absent = the route", async () => {
        const local = transcriber("local", true);
        const cloud = transcriber("opennan", false);
        const registry = new ProviderRegistry();
        registry.register(cloud.provider);
        registry.register(local.provider);
        const run = createAiRunner(registry);
        expect((await run({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT })).jobId).toBe("job-local");
        expect((await run({ capability: "audio.transcribe", input: { engine: "cloud" } }, { snapshot: SNAPSHOT })).jobId).toBe("job-opennan");
        expect((await run({ capability: "audio.transcribe", input: { engine: "local" } }, { snapshot: SNAPSHOT })).jobId).toBe("job-local");
    });

    it("answers unavailable when the asked engine is not there", async () => {
        const cloud = transcriber("opennan", false);
        const registry = new ProviderRegistry();
        registry.register(cloud.provider);
        const outcome = await createAiRunner(registry)({ capability: "audio.transcribe", input: { engine: "local" } }, { snapshot: SNAPSHOT });
        expect(outcome).toMatchObject({ unavailable: true, error: expect.stringMatching(/this device/) });
        const none = new ProviderRegistry();
        none.register(transcriber("local", true).provider);
        expect(await createAiRunner(none)({ capability: "audio.transcribe", input: { engine: "cloud" } }, { snapshot: SNAPSHOT })).toMatchObject({ unavailable: true, error: expect.stringMatching(/cloud/) });
    });
});

describe("captions-track placement", () => {
    const registry = () => {
        const r = new ProviderRegistry();
        r.register(transcriber("local", true).provider);
        return r;
    };

    it("moves cues and words by timeOffset and timeScale and keeps the label", async () => {
        const outcome = await createAiRunner(registry())(
            { capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track", style: "subtitle", timeOffset: 10, timeScale: 2, label: "Clip captions" } },
            { snapshot: SNAPSHOT },
        );
        expect(outcome.placement).toEqual({
            kind: "captions-track", style: "subtitle", label: "Clip captions",
            cues: [{ startTime: 10.5, endTime: 11.5, text: "Hello there", words: [{ start: 10.5, end: 10.75, text: "Hello" }, { start: 11, end: 11.5, text: "there" }] }],
        });
    });

    it.each([
        [{ timeOffset: Number.NaN }, "timeOffset"],
        [{ timeOffset: "1" }, "timeOffset"],
        [{ timeScale: 0 }, "timeScale"],
        [{ timeScale: -1 }, "timeScale"],
        [{ label: 5 }, "label"],
    ])("refuses %j before running anything", async (extra, field) => {
        const local = transcriber("local", true);
        const r = new ProviderRegistry();
        r.register(local.provider);
        const outcome = await createAiRunner(r)({ capability: "audio.transcribe", input: {}, placeAt: { kind: "captions-track", ...extra } }, { snapshot: SNAPSHOT });
        expect(outcome.error).toMatch(new RegExp(`placeAt.*${field}`));
        expect(local.requests).toEqual([]);
    });

    it("refuses a placement that does not fit transcription", async () => {
        const outcome = await createAiRunner(registry())({ capability: "audio.transcribe", input: {}, placeAt: { kind: "insert-media", at: 0 } }, { snapshot: SNAPSHOT });
        expect(outcome.error).toMatch(/placeAt/);
    });
});

describe("media tool placements", () => {
    const translation = { language: "th", segments: [{ start: 0, end: 1, text: "[th] Hi" }, { start: 1, end: 2, text: "Bye" }], untranslated: [1] };

    it("captions-track-translated from a captions.translate result", async () => {
        const { registry, requests } = tool(["captions.translate"], async () => ({ media: [], result: translation, costUsd: 0.006 }));
        const outcome = await createAiRunner(registry)(
            { capability: "captions.translate", input: { segments: [{ start: 0, end: 1, text: "Hi" }], targetLanguage: "th" }, placeAt: { kind: "captions-track-translated", sourceTrackIndex: 2, language: "th", keepSource: true, style: "subtitle" } },
            { snapshot: SNAPSHOT },
        );
        expect(requests).toHaveLength(1);
        expect(outcome.output).toEqual({ media: [], result: translation, costUsd: 0.006 });
        expect(outcome.placement).toEqual({
            kind: "captions-track-translated", sourceTrackIndex: 2, language: "th", keepSource: true, style: "subtitle",
            cues: [{ startTime: 0, endTime: 1, text: "[th] Hi" }, { startTime: 1, endTime: 2, text: "Bye" }], untranslated: [1],
        });
    });

    it("refuses a translation result of the wrong shape", async () => {
        const { registry } = tool(["captions.translate"], async () => ({ media: [], result: { segments: "no" } }));
        const outcome = await createAiRunner(registry)(
            { capability: "captions.translate", input: {}, placeAt: { kind: "captions-track-translated", sourceTrackIndex: 0, language: "th", keepSource: false } },
            { snapshot: SNAPSHOT },
        );
        expect(outcome).toMatchObject({ jobId: "job-tool", error: expect.stringMatching(/translation/) });
    });

    it("replace-audio places every imported audio file with its role", async () => {
        const { registry } = tool(["audio.separate"], async () => ({
            media: [{ kind: "audio", url: "https://cdn/v.mp3", role: "vocals", name: "vocals.mp3", mimeType: "audio/mpeg" }, { kind: "audio", url: "https://cdn/i.mp3", role: "instrumental", name: "instrumental.mp3", mimeType: "audio/mpeg" }],
            costUsd: 0.012,
        }));
        const outcome = await createAiRunner(registry, { importMedia: importer() })(
            { capability: "audio.separate", input: { stems: "vocals" }, placeAt: { kind: "replace-audio", source: { clipId: "c1" }, range: { startSeconds: 1, endSeconds: 5 } } },
            { snapshot: SNAPSHOT },
        );
        expect(outcome.placement).toEqual({
            kind: "replace-audio", source: { clipId: "c1" }, range: { startSeconds: 1, endSeconds: 5 },
            media: [
                { url: "opennan-local://media/vocals", name: "vocals.mp3", mimeType: "audio/mpeg", durationSeconds: 4, role: "vocals" },
                { url: "opennan-local://media/instrumental", name: "instrumental.mp3", mimeType: "audio/mpeg", durationSeconds: 4, role: "instrumental" },
            ],
        });
        expect(outcome.output).toMatchObject({ costUsd: 0.012, media: [{ kind: "audio", role: "vocals" }, { kind: "audio", role: "instrumental" }] });
    });

    it("stack-video places the first video with the asked flags", async () => {
        const { registry } = tool(["video.lipsync"], async () => ({ media: [{ kind: "video", url: "https://cdn/out.webm", mimeType: "video/webm" }] }));
        const outcome = await createAiRunner(registry, { importMedia: importer() })(
            { capability: "video.lipsync", input: {}, placeAt: { kind: "stack-video", source: { sceneId: "s1" }, hideSource: true, muteSource: true } },
            { snapshot: SNAPSHOT },
        );
        expect(outcome.placement).toEqual({
            kind: "stack-video", source: { sceneId: "s1" }, hideSource: true, muteSource: true,
            media: { url: "opennan-local://media/video", name: "video.bin", mimeType: "video/webm", durationSeconds: 4 },
        });
    });

    it("stack-video keeps lip sync's audio clip and the pixel sizes: the source's (asked, or reported by the provider) and the result's", async () => {
        const { registry } = tool(["video.upscale", "video.lipsync"], async () => ({
            media: [{ kind: "video", url: "https://cdn/out.mp4", mimeType: "video/mp4", width: 3840, height: 2160 }],
            sourceSize: { width: 1920, height: 1080 },
        }));
        const sized = importer();
        const keepSize = async (media: GeneratedMedia) => ({ ...(await sized(media)), width: 3840, height: 2160 });
        const reported = await createAiRunner(registry, { importMedia: keepSize })(
            { capability: "video.upscale", input: {}, placeAt: { kind: "stack-video", source: { clipId: "c1" } } },
            { snapshot: SNAPSHOT },
        );
        expect(reported.placement).toMatchObject({ kind: "stack-video", sourceSize: { width: 1920, height: 1080 }, media: { width: 3840, height: 2160 } });
        const asked = await createAiRunner(registry, { importMedia: keepSize })(
            { capability: "video.lipsync", input: {}, placeAt: { kind: "stack-video", source: { sceneId: "s1" }, muteSource: true, audioClipId: "a1", sourceSize: { width: 1280, height: 720 } } },
            { snapshot: SNAPSHOT },
        );
        expect(asked.placement).toMatchObject({ audioClipId: "a1", sourceSize: { width: 1280, height: 720 } });
        const bad = await createAiRunner(registry, { importMedia: keepSize })(
            { capability: "video.upscale", input: {}, placeAt: { kind: "stack-video", source: { clipId: "c1" }, sourceSize: { width: -1, height: 2 } } },
            { snapshot: SNAPSHOT },
        );
        expect(bad.error).toMatch(/sourceSize/);
    });

    it("insert-media places every file at the asked time", async () => {
        const { registry } = tool(["image.generate"], async () => ({ media: [{ kind: "image", url: "https://cdn/a.png", mimeType: "image/png", name: "a.png" }] }));
        const outcome = await createAiRunner(registry, { importMedia: importer() })(
            { capability: "image.generate", input: { description: "x" }, placeAt: { kind: "insert-media", at: 12.5 } },
            { snapshot: SNAPSHOT },
        );
        expect(outcome.placement).toEqual({ kind: "insert-media", at: 12.5, media: [{ url: "opennan-local://media/image", name: "a.png", mimeType: "image/png", durationSeconds: 4 }] });
    });

    it("answers an error when the result has nothing to place", async () => {
        const { registry } = tool(["video.upscale"], async () => ({ media: [{ kind: "audio", url: "https://cdn/a.mp3" }] }));
        const outcome = await createAiRunner(registry, { importMedia: importer() })(
            { capability: "video.upscale", input: {}, placeAt: { kind: "stack-video", source: { clipId: "c1" } } },
            { snapshot: SNAPSHOT },
        );
        expect(outcome).toMatchObject({ jobId: "job-tool", error: expect.stringMatching(/no video/) });
    });

    it.each([
        [{ kind: "replace-audio" }, "source"],
        [{ kind: "replace-audio", source: {} }, "source"],
        [{ kind: "replace-audio", source: { clipId: "a", sceneId: "b" } }, "source"],
        [{ kind: "replace-audio", source: { clipId: "" } }, "source"],
        [{ kind: "replace-audio", source: { clipId: "c" }, range: { startSeconds: 3, endSeconds: 1 } }, "range"],
        [{ kind: "replace-audio", source: { clipId: "c" }, range: { startSeconds: -1, endSeconds: 1 } }, "range"],
        [{ kind: "stack-video", source: { clipId: "c" }, hideSource: "yes" }, "hideSource"],
        [{ kind: "stack-video", source: { clipId: "c" }, muteSource: 1 }, "muteSource"],
        [{ kind: "insert-media" }, "at"],
        [{ kind: "insert-media", at: -2 }, "at"],
        [{ kind: "captions-track-translated", sourceTrackIndex: 1.5, language: "th", keepSource: true }, "sourceTrackIndex"],
        [{ kind: "captions-track-translated", sourceTrackIndex: 0, language: "", keepSource: true }, "language"],
        [{ kind: "captions-track-translated", sourceTrackIndex: 0, language: "th" }, "keepSource"],
        [{ kind: "captions-track", style: "caption" }, "captions-track"],
        [{ kind: "teleport" }, "kind"],
    ])("refuses placeAt %j before running the tool", async (placeAt, field) => {
        const { registry, requests } = tool(["audio.isolate-voice"], async () => ({ media: [] }));
        const outcome = await createAiRunner(registry)({ capability: "audio.isolate-voice", input: {}, placeAt }, { snapshot: SNAPSHOT });
        expect(outcome.error).toMatch(new RegExp(`placeAt.*${field}`));
        expect(requests).toEqual([]);
    });
});

describe("job book and cancel", () => {
    it("records the job, its progress, and its cost", async () => {
        const jobs = new AiJobBook();
        const { registry } = tool(["audio.isolate-voice"], async (_r, { report }) => {
            report(0.4, "Isolating");
            return { media: [{ kind: "audio", url: "https://cdn/a.wav" }], costUsd: 0.13 };
        });
        const seen: string[] = [];
        jobs.subscribe((r) => seen.push(`${r.status}:${r.message ?? ""}`));
        await createAiRunner(registry, { jobs, importMedia: importer() })(
            { capability: "audio.isolate-voice", input: {}, placeAt: { kind: "replace-audio", source: { clipId: "c" } } }, { snapshot: SNAPSHOT },
        );
        expect(jobs.get("job-tool")).toMatchObject({ capability: "audio.isolate-voice", status: "succeeded", costUsd: 0.13, cancellable: true, finishedAt: expect.any(Number) });
        expect(seen).toContain("running:Isolating");
    });

    it("records a failure with its refund flag and returns the error", async () => {
        const jobs = new AiJobBook();
        const { registry } = tool(["video.upscale"], async () => {
            throw new JobFailedError("The run failed. You were not charged.", { refunded: true, code: "pipeline_failed" });
        });
        const outcome = await createAiRunner(registry, { jobs })({ capability: "video.upscale", input: {} }, { snapshot: SNAPSHOT });
        expect(outcome).toEqual({ jobId: "job-tool", error: "The run failed. You were not charged." });
        expect(jobs.get("job-tool")).toMatchObject({ status: "failed", error: "The run failed. You were not charged.", refunded: true });
    });

    it("records transcription jobs too, with a cloud transcript's cost", async () => {
        const jobs = new AiJobBook();
        const registry = new ProviderRegistry();
        registry.register(transcriber("opennan", false, { ...TRANSCRIPT, costUsd: 0.005 }).provider);
        await createAiRunner(registry, { jobs })({ capability: "audio.transcribe", input: {} }, { snapshot: SNAPSHOT });
        expect(jobs.get("job-opennan")).toMatchObject({ capability: "audio.transcribe", status: "succeeded", costUsd: 0.005 });
    });

    it("forwards cancellable and, after a refused cancel, places the result when the run succeeds", async () => {
        const jobs = new AiJobBook();
        let finish!: () => void;
        const { registry } = tool(["video.upscale"], (_r, context) => {
            context.onCancel(async () => false);
            context.report(0.5, "Upscaling");
            return new Promise((resolve) => {
                finish = () => resolve({ media: [{ kind: "video", url: "https://cdn/o.webm" }], costUsd: 0.5 });
            });
        });
        const abort = new AbortController();
        const progress: AiRunProgressLike[] = [];
        const pending = createAiRunner(registry, { jobs, importMedia: importer() })(
            { capability: "video.upscale", input: {}, placeAt: { kind: "stack-video", source: { clipId: "c" } } },
            { snapshot: SNAPSHOT, signal: abort.signal, onProgress: (p) => progress.push(p) },
        );
        await vi.waitFor(() => expect(progress.some((p) => p.message === "Upscaling")).toBe(true));
        abort.abort();
        await vi.waitFor(() => expect(progress.some((p) => p.cancellable === false)).toBe(true));
        expect(jobs.get("job-tool")).toMatchObject({ status: "running", cancellable: false });
        finish();
        const outcome = await pending;
        expect(outcome.cancelled).toBeUndefined();
        expect(outcome.placement).toMatchObject({ kind: "stack-video", media: { url: "opennan-local://media/video" } });
        expect(jobs.get("job-tool")).toMatchObject({ status: "succeeded", costUsd: 0.5 });
    });

    it("after a refused cancel, a failure is reported as a failure, not as cancelled", async () => {
        let fail!: () => void;
        const { registry } = tool(["video.upscale"], (_r, context) => {
            context.onCancel(async () => false);
            return new Promise((_resolve, reject) => {
                fail = () => reject(new JobFailedError("The run failed. You were not charged.", { refunded: true }));
            });
        });
        const abort = new AbortController();
        const progress: AiRunProgressLike[] = [];
        const pending = createAiRunner(registry)({ capability: "video.upscale", input: {} }, { snapshot: SNAPSHOT, signal: abort.signal, onProgress: (p) => progress.push(p) });
        await vi.waitFor(() => expect(progress.some((p) => p.status === "running")).toBe(true));
        abort.abort();
        await vi.waitFor(() => expect(progress.some((p) => p.cancellable === false)).toBe(true));
        fail();
        expect(await pending).toEqual({ jobId: "job-tool", error: "The run failed. You were not charged." });
    });

    it("an accepted cancel ends cancelled and is recorded", async () => {
        const jobs = new AiJobBook();
        const { registry } = tool(["video.upscale"], (_r, context) => {
            context.onCancel(async () => true);
            return new Promise(() => undefined);
        });
        const abort = new AbortController();
        const pending = createAiRunner(registry, { jobs })({ capability: "video.upscale", input: {} }, { snapshot: SNAPSHOT, signal: abort.signal });
        await vi.waitFor(() => expect(jobs.get("job-tool")?.status).toBe("running"));
        abort.abort();
        expect(await pending).toEqual({ jobId: "job-tool", cancelled: true });
        expect(jobs.get("job-tool")?.status).toBe("cancelled");
    });
});
