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

describe("project ids", () => {
    const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

    it("project-scoped channels take local project ids only (projects stay on this device)", () => {
        expect(PAYLOADS[IPC.mediaImportPath].safeParse({ projectId: ID, path: "/a.mp4", kind: "video" }).success).toBe(true);
        expect(PAYLOADS[IPC.sessionAttach].safeParse({ projectId: ID }).success).toBe(true);
        for (const projectId of ["cloud-abc", "cloud-../x", "local-a", ID.toUpperCase()]) {
            expect(PAYLOADS[IPC.mediaImportPath].safeParse({ projectId, path: "/a.mp4", kind: "video" }).success).toBe(false);
            expect(PAYLOADS[IPC.sessionAttach].safeParse({ projectId }).success).toBe(false);
            expect(PAYLOADS[IPC.persistenceLoad].safeParse({ projectId }).success).toBe(false);
        }
    });
});
