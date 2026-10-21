// AI channels (spec §5.9): status, models, transcribe and stabilize (each returns the job id at once; updates go out
// as EVENTS.aiJob), and cancel (either job). Every call goes through handle(): sender check and zod schema first.
import type { ControllerSnapshot } from "@opennan/timeline-core";
import { EVENTS, IPC } from "../../shared/ipc";
import { handle, type IpcMainLike } from "../ipc/handle";
import type { StabilizeService } from "./stabilize";
import type { TranscriptionService } from "./transcription";

export interface AiIpcOptions {
    service: TranscriptionService;
    stabilize?: StabilizeService;
    send(channel: string, payload: unknown): void;
}

export function registerAiIpc(ipc: IpcMainLike, { service, stabilize, send }: AiIpcOptions): () => void {
    handle(ipc, IPC.aiStatus, () => service.status());
    handle(ipc, IPC.aiModels, () => service.models());
    handle(ipc, IPC.aiTranscribe, ({ language, model, snapshot, source }) => service.start({
        ...(language === undefined ? {} : { language }),
        ...(model === undefined ? {} : { model }),
        ...(source ? { source } : { snapshot: snapshot as unknown as ControllerSnapshot }),
    }));
    handle(ipc, IPC.aiStabilize, ({ projectId, source }) => {
        if (!stabilize) throw new Error("Stabilize is not available in this build.");
        return stabilize.start({ projectId, source });
    });
    handle(ipc, IPC.aiCancel, async ({ jobId }) => {
        await Promise.all([service.cancel(jobId), stabilize?.cancel(jobId)]);
    });
    const stops = [service.subscribe((event) => send(EVENTS.aiJob, event)), stabilize?.subscribe((event) => send(EVENTS.aiJob, event))];
    return () => {
        for (const stop of stops) stop?.();
    };
}
