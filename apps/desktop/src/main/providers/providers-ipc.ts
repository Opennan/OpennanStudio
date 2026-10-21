// Cloud provider channels: list, models, run and transcribe (one job in main, events on opennan:providers:job),
// cancel (answers whether the provider stopped the job), price, and voices.
import { IPC } from "../../shared/ipc";
import { handle, type IpcMainLike } from "../ipc/handle";
import type { ProviderHost } from "./provider-host";

export function registerProvidersIpc(ipc: IpcMainLike, { host }: { host: ProviderHost }): void {
    handle(ipc, IPC.providersList, () => host.list());
    handle(ipc, IPC.providersModels, ({ providerId, capability }) => host.models(providerId, capability));
    handle(ipc, IPC.providersRun, ({ providerId, capability, input, projectId }) => host.run({ providerId, capability, input, projectId }));
    handle(ipc, IPC.providersCancel, ({ jobId }) => host.cancel(jobId));
    handle(ipc, IPC.providersTranscribe, ({ providerId, audio, language, model, expectedMaxUsd }) => host.transcribe({
        providerId, audio,
        ...(language === undefined ? {} : { language }),
        ...(model === undefined ? {} : { model }),
        ...(expectedMaxUsd === undefined ? {} : { expectedMaxUsd }),
    }));
    handle(ipc, IPC.providersPrice, ({ providerId, request }) => host.price(providerId, request));
    handle(ipc, IPC.providersVoices, ({ providerId }) => host.voices(providerId));
}
