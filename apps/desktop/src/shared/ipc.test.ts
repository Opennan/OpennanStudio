import type { ExportErrorCode } from "@opennan/export";
import { EXPORT_ERROR_CODES, IPC, PAYLOADS } from "./ipc";

const snapshot = { projectId: "p", project: null, tracks: [], clips: [], scenes: [] };

describe("AI payload schemas", () => {
    const transcribe = PAYLOADS[IPC.aiTranscribe];

    it("accepts a snapshot with an optional language and catalog model", () => {
        expect(transcribe.safeParse({ snapshot }).success).toBe(true);
        expect(transcribe.safeParse({ language: "auto", model: "tiny", snapshot }).success).toBe(true);
        expect(transcribe.safeParse({ language: "yue", model: "small", snapshot }).success).toBe(true);
    });

    it("accepts one imported media's range instead of a snapshot", () => {
        const mediaUrl = "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
        expect(transcribe.safeParse({ source: { mediaUrl, startSeconds: 1, endSeconds: 3 } }).success).toBe(true);
        expect(transcribe.safeParse({ source: { mediaUrl: "opennan-media://blob/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f" } }).success).toBe(true);
        for (const payload of [
            { source: { mediaUrl: "https://cdn.example/a.mp3" } }, { source: { mediaUrl: "file:///etc/passwd" } }, { source: { mediaUrl, startSeconds: 3, endSeconds: 1 } },
            { source: { mediaUrl, startSeconds: -1 } }, { source: { mediaUrl, extra: 1 } }, { source: { mediaUrl }, snapshot }, {},
        ]) expect(transcribe.safeParse(payload).success).toBe(false);
    });

    it.each([
        [{ language: "en; rm -rf /", snapshot }],
        [{ language: "EN", snapshot }],
        [{ model: "large", snapshot }],
        [{ model: "../tiny", snapshot }],
        [{ snapshot, extra: true }],
        [{ language: "en" }],
        [{ snapshot: { tracks: [] } }],
    ])("refuses %j", (payload) => {
        expect(transcribe.safeParse(payload).success).toBe(false);
    });

    it("accepts only job ids for cancel", () => {
        expect(PAYLOADS[IPC.aiCancel].safeParse({ jobId: "job-abc_123" }).success).toBe(true);
        for (const jobId of ["abc", "job-", "job-../x", `job-${"a".repeat(65)}`]) expect(PAYLOADS[IPC.aiCancel].safeParse({ jobId }).success).toBe(false);
        expect(PAYLOADS[IPC.aiModels].safeParse({ x: 1 }).success).toBe(false);
    });
});

describe("GPU export job payloads (agent exports, phase 10d)", () => {
    const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    const progress = PAYLOADS[IPC.exportGpuProgress];
    const abort = PAYLOADS[IPC.exportGpuAbort];
    const fallback = PAYLOADS[IPC.exportGpuFallback];
    const begin = PAYLOADS[IPC.exportGpuBegin];

    it("accepts a job id, a phase, and finite numbers", () => {
        expect(progress.safeParse({ jobId: ID, phase: "render", ratio: 0.5 }).success).toBe(true);
        expect(progress.safeParse({ jobId: ID, phase: "mux", ratio: 1, etaSeconds: 12.5 }).success).toBe(true);
    });

    it.each([
        [{ jobId: "gpu-1", phase: "render", ratio: 0.5 }],
        [{ jobId: `${ID}/../x`, phase: "render", ratio: 0.5 }],
        [{ jobId: ID, phase: "encode-everything", ratio: 0.5 }],
        [{ jobId: ID, phase: "render", ratio: Number.NaN }],
        [{ jobId: ID, phase: "render", ratio: Number.POSITIVE_INFINITY }],
        [{ jobId: ID, phase: "render", ratio: "0.5" }],
        [{ jobId: ID, phase: "render", ratio: 0.5, etaSeconds: Number.POSITIVE_INFINITY }],
        [{ jobId: ID, phase: "render", ratio: 0.5, etaSeconds: -1 }],
        [{ jobId: ID, phase: "render", ratio: 0.5, path: "/etc/passwd" }],
        [{ jobId: ID, phase: "render", ratio: 0.5, engine: "ffmpeg" }],
    ])("refuses progress %j", (payload) => {
        expect(progress.safeParse(payload).success).toBe(false);
    });

    it("an abort carries at most an error code from the list and a bounded message", () => {
        expect(abort.safeParse({ jobId: ID }).success).toBe(true);
        expect(abort.safeParse({ jobId: ID, error: { code: "media-read-failed", message: "a file could not be read" } }).success).toBe(true);
        expect(abort.safeParse({ jobId: ID, error: { code: "unknown", message: "" } }).success).toBe(true);
        expect(abort.safeParse({ jobId: ID, error: { code: "rm -rf", message: "x" } }).success).toBe(false);
        expect(abort.safeParse({ jobId: ID, error: { code: "unknown", message: "x".repeat(2001) } }).success).toBe(false);
        expect(abort.safeParse({ jobId: ID, error: { code: "unknown", message: "x", path: "/tmp/x" } }).success).toBe(false);
        expect(abort.safeParse({ jobId: ID, path: "/tmp/x" }).success).toBe(false);
    });

    it("lists every export error code", () => {
        expectTypeOf<ExportErrorCode | "unknown">().toEqualTypeOf<(typeof EXPORT_ERROR_CODES)[number]>();
    });

    it("a fallback names only the job (main reuses the job's own snapshot)", () => {
        expect(fallback.safeParse({ jobId: ID }).success).toBe(true);
        expect(fallback.safeParse({ jobId: ID, snapshot }).success).toBe(false);
        expect(fallback.safeParse({ jobId: ID, filterGraph: "[0:v]null" }).success).toBe(false);
    });

    it("a begin may name the WebCodecs codec, which must match the container", () => {
        expect(begin.safeParse({ options: {}, snapshot, container: "mp4", codec: "avc" }).success).toBe(true);
        expect(begin.safeParse({ options: {}, snapshot, container: "webm", codec: "vp9" }).success).toBe(true);
        expect(begin.safeParse({ options: {}, snapshot, container: "mp4" }).success).toBe(true);
        expect(begin.safeParse({ options: {}, snapshot, container: "mp4", codec: "vp9" }).success).toBe(false);
        expect(begin.safeParse({ options: {}, snapshot, container: "webm", codec: "avc" }).success).toBe(false);
        expect(begin.safeParse({ options: {}, snapshot, container: "mp4", codec: "libx264 -y /tmp/x" }).success).toBe(false);
    });
});

describe("cloud project ids (phase 9a)", () => {
    const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    const CLOUD = "cloud-AbC_12-x";
    const media = `opennan-local://media/${ID}`;

    it("project-scoped channels take local ids and cloud-<server id>", () => {
        for (const projectId of [ID, CLOUD, `cloud-${"a".repeat(36)}`]) {
            expect(PAYLOADS[IPC.mediaImportPath].safeParse({ projectId, path: "/a.mp4", kind: "video" }).success).toBe(true);
            expect(PAYLOADS[IPC.mediaImportBytes].safeParse({ projectId, name: "a.png", mimeType: "image/png", kind: "image", bytes: new Uint8Array(1) }).success).toBe(true);
            expect(PAYLOADS[IPC.sessionAttach].safeParse({ projectId }).success).toBe(true);
            expect(PAYLOADS[IPC.sessionDetach].safeParse({ projectId }).success).toBe(true);
            expect(PAYLOADS[IPC.terminalStart].safeParse({ projectId, profile: "shell", cols: 80, rows: 24 }).success).toBe(true);
            expect(PAYLOADS[IPC.aiStabilize].safeParse({ projectId, source: { mediaUrl: media } }).success).toBe(true);
            expect(PAYLOADS[IPC.providersRun].safeParse({ providerId: "opennan", capability: "image.generate", input: {}, projectId }).success).toBe(true);
        }
        for (const projectId of ["cloud-", `cloud-${"a".repeat(37)}`, "cloud-../x", "cloud-a/b", "cloud-a.b", "Cloud-a", "local-a", ID.toUpperCase()]) {
            expect(PAYLOADS[IPC.mediaImportPath].safeParse({ projectId, path: "/a.mp4", kind: "video" }).success).toBe(false);
            expect(PAYLOADS[IPC.sessionAttach].safeParse({ projectId }).success).toBe(false);
        }
    });

    it("local project documents and releasing media take local ids only", () => {
        expect(PAYLOADS[IPC.persistenceLoad].safeParse({ projectId: CLOUD }).success).toBe(false);
        expect(PAYLOADS[IPC.persistenceDelete].safeParse({ projectId: CLOUD }).success).toBe(false);
        expect(PAYLOADS[IPC.mediaReleaseProject].safeParse({ projectId: ID }).success).toBe(true);
        expect(PAYLOADS[IPC.mediaReleaseProject].safeParse({ projectId: CLOUD }).success).toBe(false);
        expect(PAYLOADS[IPC.mediaReleaseProject].safeParse({ projectId: ID, extra: 1 }).success).toBe(false);
    });
});

describe("cloud media cache channels (phase 9a.1)", () => {
    const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    const GB = 1024 ** 3;

    it("pins up to 20,000 media ids, and nothing else", () => {
        const pin = PAYLOADS[IPC.cloudCachePin];
        expect(pin.safeParse({ ids: [] }).success).toBe(true);
        expect(pin.safeParse({ ids: [ID, ID] }).success).toBe(true);
        expect(pin.safeParse({ ids: Array.from({ length: 20_000 }, () => ID) }).success).toBe(true);
        for (const payload of [
            { ids: Array.from({ length: 20_001 }, () => ID) }, { ids: ["opennan-local://media/" + ID] }, { ids: ["../x"] }, { ids: [ID.toUpperCase()] }, { ids: ID }, {}, { ids: [], extra: 1 },
        ]) expect(pin.safeParse(payload).success).toBe(false);
    });

    it("takes a limit between 256 MiB and 1024 GB, or null for the default", () => {
        const limit = PAYLOADS[IPC.cloudCacheSetLimit];
        for (const bytes of [null, 256 * 1024 ** 2, 10 * GB, 1024 * GB]) expect(limit.safeParse({ bytes }).success).toBe(true);
        for (const payload of [{ bytes: 1024 }, { bytes: 1025 * GB }, { bytes: 1.5 }, { bytes: "10" }, {}, { bytes: null, extra: 1 }]) expect(limit.safeParse(payload).success).toBe(false);
    });

    it("usage and clear take an empty payload", () => {
        for (const channel of [IPC.cloudCacheUsage, IPC.cloudCacheClear] as const) {
            expect(PAYLOADS[channel].safeParse({}).success).toBe(true);
            expect(PAYLOADS[channel].safeParse({ all: true }).success).toBe(false);
        }
    });
});
