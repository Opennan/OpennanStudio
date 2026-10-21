const { exposed, ipc, webUtils } = vi.hoisted(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        exposed: {} as Record<string, unknown>,
        webUtils: { getPathForFile: vi.fn((file: { path?: string }) => file.path ?? "") },
        ipc: {
            listeners,
            invoke: vi.fn(async (_channel: string, _payload: unknown) => ({ terminalId: "t" })),
            on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
                if (!listeners.has(channel)) listeners.set(channel, new Set());
                listeners.get(channel)!.add(listener);
            }),
            removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => listeners.get(channel)?.delete(listener)),
            emit(channel: string, event: unknown, payload: unknown) {
                for (const listener of listeners.get(channel) ?? []) listener(event, payload);
            },
        },
    };
});

vi.mock("electron", () => ({
    contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed[key] = value; } },
    ipcRenderer: ipc,
    webUtils,
}));

const postMessage = vi.fn();
vi.stubGlobal("window", { postMessage, location: { origin: "opennan-app://app" } });

import type { DesktopBridge } from "../shared/bridge";
import { EVENTS, IPC } from "../shared/channels";

const ID = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("preload bridge", () => {
    let bridge: DesktopBridge;
    beforeAll(async () => {
        await import("./index");
        bridge = exposed.opennan as DesktopBridge;
    });
    beforeEach(() => ipc.invoke.mockClear());

    it("exposes exactly window.opennan with the bridge sections", () => {
        expect(Object.keys(exposed)).toEqual(["opennan"]);
        expect(Object.keys(bridge).sort()).toEqual(["account", "ai", "app", "cloud", "e2e", "exports", "mcp", "media", "persistence", "providers", "secrets", "session", "settings", "terminal"]);
        expect(JSON.stringify(Object.keys(bridge))).not.toMatch(/ipc|invoke|require/i);
    });

    it("invokes typed channels", async () => {
        await bridge.persistence.save(ID, { meta: { id: ID } } as never);
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.persistenceSave, { projectId: ID, state: { meta: { id: ID } } });
        await expect(bridge.terminal.start(ID, "shell", 80, 24)).resolves.toBe("t");
    });

    it("invokes the account and provider channels with exact payloads", async () => {
        await bridge.account.start(true);
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.accountStart, { signup: true });
        await bridge.account.openConsole("billing");
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.accountOpenConsole, { page: "billing" });
        await bridge.providers.run({ providerId: "opennan", capability: "image.generate", input: { description: "x" }, projectId: ID });
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.providersRun, { providerId: "opennan", capability: "image.generate", input: { description: "x" }, projectId: ID });
        const url = `opennan-local://media/${ID}`;
        await bridge.providers.transcribe({ providerId: "opennan", audio: { kind: "media", url, startSeconds: 1, extra: 2 } as never, language: "en" });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.providersTranscribe, { providerId: "opennan", audio: { kind: "media", url, startSeconds: 1 }, language: "en" });
        await bridge.providers.price("opennan", { capability: "audio.isolate-voice", input: {}, units: { seconds: 2 }, extra: 1 } as never);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.providersPrice, { providerId: "opennan", request: { capability: "audio.isolate-voice", input: {}, units: { seconds: 2 } } });
        await bridge.providers.voices("opennan");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.providersVoices, { providerId: "opennan" });
        const changed = vi.fn();
        bridge.account.onChanged(changed);
        ipc.emit(EVENTS.accountChanged, {}, { state: "signed-out" });
        expect(changed).toHaveBeenCalledWith({ state: "signed-out" });
    });

    it("invokes the cloud channels with exactly their fields", async () => {
        await bridge.cloud.request("POST", "/v1/projects/p/changes", { body: { label: "x" }, headers: { "Idempotency-Key": "k" }, signal: {}, extra: 1 } as never);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudRequest, { method: "POST", path: "/v1/projects/p/changes", body: { label: "x" }, headers: { "Idempotency-Key": "k" } });
        await bridge.cloud.request("GET", "/v1/projects", { query: { limit: 5 } });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudRequest, { method: "GET", path: "/v1/projects", query: { limit: 5 } });
        await bridge.cloud.describe(ID);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudDescribe, { mediaId: ID });
        await bridge.cloud.upload(ID, null);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudUpload, { mediaId: ID, serverProjectId: null });
        await bridge.cloud.cache("https://cdn.opennan.com/a.mp4", 10);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudCache, { url: "https://cdn.opennan.com/a.mp4", sizeBytes: 10 });
        await bridge.cloud.duplicate(ID, ID);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudDuplicate, { mediaId: ID, projectId: ID });
        await bridge.cloud.storePut("a@b.c", "sync", "cloud-p", { r: 1 });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudStorePut, { account: "a@b.c", namespace: "sync", key: "cloud-p", value: { r: 1 } });
        await bridge.cloud.storeGet("a@b.c", "sync", "cloud-p");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudStoreGet, { account: "a@b.c", namespace: "sync", key: "cloud-p" });
        await bridge.cloud.storeDelete("a@b.c", "sync", "cloud-p");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudStoreDelete, { account: "a@b.c", namespace: "sync", key: "cloud-p" });
        await bridge.cloud.storeKeys("a@b.c", "mirror");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudStoreKeys, { account: "a@b.c", namespace: "mirror" });
        await bridge.cloud.cachePin([ID]);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudCachePin, { ids: [ID] });
        await bridge.cloud.cacheUsage();
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudCacheUsage, {});
        await bridge.cloud.cacheSetLimit(null);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudCacheSetLimit, { bytes: null });
        await bridge.cloud.cacheSetLimit(2 * 1024 ** 3);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudCacheSetLimit, { bytes: 2 * 1024 ** 3 });
        await bridge.cloud.cacheClear();
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudCacheClear, {});
    });

    it("lists exactly the cloud bridge's methods", () => {
        expect(Object.keys(bridge.cloud).sort()).toEqual([
            "cache", "cacheClear", "cachePin", "cacheSetLimit", "cacheUsage", "describe", "duplicate", "request", "storeDelete", "storeGet", "storeKeys", "storePut",
            "stream", "streamAbort", "upload", "uploadExport",
        ]);
    });

    it("uploads an export by its path and the project's id (phase 9c)", async () => {
        await bridge.cloud.uploadExport("/exports/Trip.mp4", "p1");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudUploadExport, { path: "/exports/Trip.mp4", serverProjectId: "p1" });
    });

    it("streams a director turn: exact start payload, its own chunks, the end, then nothing", async () => {
        ipc.invoke.mockImplementationOnce(async () => ({ ok: true, value: { status: 200 } }) as never);
        const events: unknown[] = [];
        const started = await bridge.cloud.stream("s-1", "POST", "/v1/projects/p/director/turns", { body: { message: "Hi" }, headers: { "Idempotency-Key": "k" }, signal: {}, query: { a: 1 } } as never, (event) => events.push(event));
        expect(started).toEqual({ ok: true, value: { status: 200 } });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudStreamStart, { streamId: "s-1", method: "POST", path: "/v1/projects/p/director/turns", body: { message: "Hi" }, headers: { "Idempotency-Key": "k" } });
        ipc.emit(EVENTS.cloudStreamChunk, {}, { streamId: "s-1", bytes: new Uint8Array([1, 2]) });
        ipc.emit(EVENTS.cloudStreamChunk, {}, { streamId: "other", bytes: new Uint8Array([9]) });
        ipc.emit(EVENTS.cloudStreamEnd, {}, { streamId: "s-1" });
        ipc.emit(EVENTS.cloudStreamChunk, {}, { streamId: "s-1", bytes: new Uint8Array([3]) });
        expect(events).toEqual([{ type: "chunk", bytes: new Uint8Array([1, 2]) }, { type: "end" }]);
        expect(ipc.listeners.get(EVENTS.cloudStreamChunk)?.size ?? 0).toBeLessThanOrEqual(1);
    });

    it("passes a mid-stream error, forgets a refused stream, and aborts by id", async () => {
        const error = { status: 0, code: "network", message: "Can't reach OpenNan.", fromServer: false };
        ipc.invoke.mockImplementationOnce(async () => ({ ok: true, value: { status: 200 } }) as never);
        const failed: unknown[] = [];
        await bridge.cloud.stream("s-2", "POST", "/v1/projects/p/director/turns", {}, (event) => failed.push(event));
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudStreamStart, { streamId: "s-2", method: "POST", path: "/v1/projects/p/director/turns" });
        ipc.emit(EVENTS.cloudStreamEnd, {}, { streamId: "s-2", error });
        expect(failed).toEqual([{ type: "error", error }]);

        ipc.invoke.mockImplementationOnce(async () => ({ ok: false, error: { ...error, status: 404, code: "not_found" } }) as never);
        const refused: unknown[] = [];
        await bridge.cloud.stream("s-3", "POST", "/v1/projects/p/director/turns", {}, (event) => refused.push(event));
        ipc.emit(EVENTS.cloudStreamChunk, {}, { streamId: "s-3", bytes: new Uint8Array([1]) });
        expect(refused).toEqual([]);

        ipc.invoke.mockImplementationOnce(async () => { throw new Error("Invalid payload"); });
        await expect(bridge.cloud.stream("s-4", "GET" as never, "/v1/x", {}, () => undefined)).rejects.toThrow("Invalid");

        ipc.invoke.mockImplementationOnce(async () => ({ ok: true, value: { status: 200 } }) as never);
        const aborted: unknown[] = [];
        await bridge.cloud.stream("s-5", "POST", "/v1/projects/p/director/turns", {}, (event) => aborted.push(event));
        ipc.invoke.mockImplementationOnce(async () => undefined as never);
        await bridge.cloud.streamAbort("s-5");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.cloudStreamAbort, { streamId: "s-5" });
        ipc.emit(EVENTS.cloudStreamChunk, {}, { streamId: "s-5", bytes: new Uint8Array([1]) });
        expect(aborted).toEqual([]);
    });

    it("deletes media scoped to its project", async () => {
        await bridge.media.delete(ID, ID);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.mediaDelete, { projectId: ID, id: ID });
    });

    it("releases a project's media by id", async () => {
        await bridge.media.releaseProject(ID);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.mediaReleaseProject, { projectId: ID });
    });

    it("imports files by path without reading them", async () => {
        const arrayBuffer = vi.fn();
        await bridge.media.import(ID, { path: "/Users/me/clip.mp4", size: 10, arrayBuffer } as never, "video");
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.mediaImportPath, { projectId: ID, path: "/Users/me/clip.mp4", kind: "video" });
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it("sends path-less files as bytes and refuses huge ones before reading", async () => {
        const small = { name: "a.png", type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
        await bridge.media.import(ID, small as never, "image");
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.mediaImportBytes, { projectId: ID, name: "a.png", mimeType: "image/png", kind: "image", bytes: new Uint8Array([1, 2, 3]) });
        const arrayBuffer = vi.fn();
        await expect(bridge.media.import(ID, { name: "huge.mp4", type: "video/mp4", size: 600 * 1024 * 1024, arrayBuffer } as never, "video")).rejects.toThrow("too large");
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it("unsubscribes only the listener it registered", () => {
        const a = vi.fn();
        const b = vi.fn();
        const stopA = bridge.terminal.onData(a);
        bridge.terminal.onData(b);
        stopA();
        ipc.emit(EVENTS.terminalData, {}, { terminalId: "t", data: "hi" });
        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledWith("t", "hi");
    });

    it("answers session requests, errors included", async () => {
        const detach = await bridge.session.attach(ID, async (method) => {
            if (method === "boom") throw new Error("kaput");
            return { method };
        });
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.sessionAttach, { projectId: ID });
        ipc.emit(EVENTS.sessionRequest, {}, { id: 1, method: "snapshot", args: [] });
        ipc.emit(EVENTS.sessionRequest, {}, { id: 2, method: "boom", args: [] });
        await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith(IPC.sessionResponse, { id: 2, ok: false, error: "kaput" }));
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.sessionResponse, { id: 1, ok: true, value: { method: "snapshot" } });
        await detach();
        expect(ipc.invoke).toHaveBeenCalledWith(IPC.sessionDetach, { projectId: ID });
    });

    it("forwards export ports to the page's own origin only", () => {
        const ports = [{}, {}];
        ipc.emit(EVENTS.exportPorts, { ports }, undefined);
        expect(postMessage).toHaveBeenCalledWith("opennan:export-ports", "opennan-app://app", ports);
    });

    it("sends AI requests with exactly their fields and forwards job events", async () => {
        const snapshot = { projectId: ID, project: null, tracks: [], clips: [], scenes: [] } as never;
        await bridge.ai.transcribe({ snapshot });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.aiTranscribe, { snapshot });
        await bridge.ai.transcribe({ language: "th", model: "tiny", snapshot });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.aiTranscribe, { language: "th", model: "tiny", snapshot });
        const mediaUrl = `opennan-local://media/${ID}`;
        await bridge.ai.transcribe({ source: { mediaUrl, startSeconds: 1, endSeconds: 2, extra: true } as never });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.aiTranscribe, { source: { mediaUrl, startSeconds: 1, endSeconds: 2 } });
        await bridge.ai.stabilize({ projectId: ID, source: { mediaUrl, startSeconds: 1, extra: 1 } as never });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.aiStabilize, { projectId: ID, source: { mediaUrl, startSeconds: 1 } });
        await bridge.ai.cancel("job-1");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.aiCancel, { jobId: "job-1" });
        await bridge.ai.models();
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.aiModels, {});
        const seen: unknown[] = [];
        const stop = bridge.ai.onJob((event) => seen.push(event));
        ipc.emit(EVENTS.aiJob, {}, { jobId: "job-1", status: "running", progress: 0.5 });
        stop();
        ipc.emit(EVENTS.aiJob, {}, { jobId: "job-1", status: "succeeded" });
        expect(seen).toEqual([{ jobId: "job-1", status: "running", progress: 0.5 }]);
    });

    it("sends GPU job reports with exactly their fields and forwards main's cancel requests", async () => {
        const snapshot = { projectId: ID, project: null, tracks: [], clips: [], scenes: [] } as never;
        await bridge.exports.gpuBegin({ resolution: "720p" }, snapshot, "mp4", "avc");
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.exportGpuBegin, { options: { resolution: "720p" }, snapshot, container: "mp4", codec: "avc" });
        await bridge.exports.gpuProgress(ID, { phase: "render", ratio: 0.5 });
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.exportGpuProgress, { jobId: ID, phase: "render", ratio: 0.5 });
        await bridge.exports.gpuProgress(ID, { phase: "render", ratio: 0.5, etaSeconds: 3, extra: "/etc/passwd" } as never);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.exportGpuProgress, { jobId: ID, phase: "render", ratio: 0.5, etaSeconds: 3 });
        await bridge.exports.gpuAbort(ID);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.exportGpuAbort, { jobId: ID });
        await bridge.exports.gpuAbort(ID, { code: "unknown", message: "lost", stack: "x" } as never);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.exportGpuAbort, { jobId: ID, error: { code: "unknown", message: "lost" } });
        await bridge.exports.gpuFallback(ID);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.exportGpuFallback, { jobId: ID });
        const cancel = vi.fn();
        const stop = bridge.exports.onGpuCancel(cancel);
        ipc.emit(EVENTS.exportGpuCancel, {}, { jobId: ID });
        stop();
        ipc.emit(EVENTS.exportGpuCancel, {}, { jobId: "other" });
        expect(cancel.mock.calls).toEqual([[ID]]);
    });
});
