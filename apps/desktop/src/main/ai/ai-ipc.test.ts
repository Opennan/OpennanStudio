import { EVENTS, IPC } from "../../shared/ipc";
import type { AiJobEvent } from "../../shared/bridge";
import type { IpcEventLike, IpcMainLike } from "../ipc/handle";
import { registerAiIpc } from "./ai-ipc";
import type { StabilizeService } from "./stabilize";
import type { TranscriptionService } from "./transcription";

const snapshot = { projectId: "p", project: null, tracks: [], clips: [], scenes: [] };

function setup() {
    const handlers = new Map<string, (event: IpcEventLike, payload: unknown) => unknown>();
    const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
    const top = { url: "opennan-app://app/" } as { url: string; top?: unknown };
    top.top = top;
    let listener: ((event: AiJobEvent) => void) | null = null;
    const service: TranscriptionService = {
        status: vi.fn(() => ({ available: true, reason: null })),
        models: vi.fn(async () => [{ id: "tiny", label: "Tiny", installed: false }]),
        start: vi.fn(async () => ({ jobId: "job-1" })),
        cancel: vi.fn(async () => undefined),
        cancelAll: vi.fn(async () => undefined),
        subscribe: vi.fn((l) => {
            listener = l;
            return () => {
                listener = null;
            };
        }),
    };
    let stabilizeListener: ((event: AiJobEvent) => void) | null = null;
    const stabilize: StabilizeService = {
        status: vi.fn(() => ({ available: true, reason: null })),
        start: vi.fn(async () => ({ jobId: "job-2" })),
        cancel: vi.fn(async () => undefined),
        cancelAll: vi.fn(async () => undefined),
        subscribe: vi.fn((l) => {
            stabilizeListener = l;
            return () => {
                stabilizeListener = null;
            };
        }),
    };
    const send = vi.fn();
    const stop = registerAiIpc(ipc, { service, stabilize, send });
    const invoke = (channel: string, payload: unknown = {}, frame: unknown = top) => handlers.get(channel)!({ senderFrame: frame as never }, payload);
    return { service, stabilize, send, stop, invoke, emit: (event: AiJobEvent) => listener?.(event), emitStabilize: (event: AiJobEvent) => stabilizeListener?.(event) };
}

describe("AI IPC", () => {
    it("answers status and models, starts and cancels jobs, and forwards job events", async () => {
        const { service, send, stop, invoke, emit } = setup();
        expect(await invoke(IPC.aiStatus)).toEqual({ available: true, reason: null });
        expect(await invoke(IPC.aiModels)).toEqual([{ id: "tiny", label: "Tiny", installed: false }]);
        expect(await invoke(IPC.aiTranscribe, { language: "en", model: "tiny", snapshot })).toEqual({ jobId: "job-1" });
        expect(service.start).toHaveBeenCalledWith({ language: "en", model: "tiny", snapshot });
        await invoke(IPC.aiCancel, { jobId: "job-1" });
        expect(service.cancel).toHaveBeenCalledWith("job-1");
        emit({ jobId: "job-1", status: "running", progress: 0.5 });
        expect(send).toHaveBeenCalledWith(EVENTS.aiJob, { jobId: "job-1", status: "running", progress: 0.5 });
        stop();
        emit({ jobId: "job-1", status: "succeeded" });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("starts stabilize on imported media only, cancels either job, and forwards its events", async () => {
        const { stabilize, service, send, stop, invoke, emitStabilize } = setup();
        const projectId = "11111111-2222-4333-8444-555555555555";
        const source = { mediaUrl: "opennan-local://media/3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", startSeconds: 1, endSeconds: 2 };
        expect(await invoke(IPC.aiStabilize, { projectId, source })).toEqual({ jobId: "job-2" });
        expect(stabilize.start).toHaveBeenCalledWith({ projectId, source });
        await expect(invoke(IPC.aiStabilize, { projectId, source: { mediaUrl: "https://cdn.example/a.mp4" } })).rejects.toThrow();
        await expect(invoke(IPC.aiStabilize, { projectId: "../p", source })).rejects.toThrow();
        expect(stabilize.start).toHaveBeenCalledTimes(1);
        await invoke(IPC.aiCancel, { jobId: "job-2" });
        expect(stabilize.cancel).toHaveBeenCalledWith("job-2");
        expect(service.cancel).toHaveBeenCalledWith("job-2");
        emitStabilize({ jobId: "job-2", status: "running", progress: 0.3 });
        expect(send).toHaveBeenCalledWith(EVENTS.aiJob, { jobId: "job-2", status: "running", progress: 0.3 });
        stop();
        emitStabilize({ jobId: "job-2", status: "succeeded" });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("refuses bad payloads and foreign senders before the service runs", async () => {
        const { service, invoke } = setup();
        await expect(invoke(IPC.aiTranscribe, { language: "en; rm -rf /", snapshot })).rejects.toThrow(/language/);
        await expect(invoke(IPC.aiTranscribe, { model: "huge", snapshot })).rejects.toThrow();
        await expect(invoke(IPC.aiCancel, { jobId: "../x" })).rejects.toThrow();
        await expect(invoke(IPC.aiStatus, {}, { url: "https://evil.example/" })).rejects.toThrow();
        expect(service.start).not.toHaveBeenCalled();
        expect(service.cancel).not.toHaveBeenCalled();
    });
});
