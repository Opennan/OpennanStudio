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
        expect(Object.keys(bridge).sort()).toEqual(["account", "ai", "app", "e2e", "exports", "mcp", "media", "persistence", "providers", "secrets", "session", "settings", "terminal"]);
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

    it("deletes media scoped to its project", async () => {
        await bridge.media.delete(ID, ID);
        expect(ipc.invoke).toHaveBeenLastCalledWith(IPC.mediaDelete, { projectId: ID, id: ID });
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
