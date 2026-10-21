// Settings and API key channels. Secret values go in and never come back out.
import { IPC } from "../../shared/ipc";
import type { SecretStore } from "../store/secrets";
import type { SettingsStore } from "../store/settings";
import { handle, type IpcMainLike } from "./handle";

export function registerSettingsIpc(ipc: IpcMainLike, { settings, secrets, onChange, onSecretsChange }: { settings: SettingsStore; secrets: SecretStore; onChange?(): void; onSecretsChange?(): void }): void {
    handle(ipc, IPC.settingsGet, () => settings.get());
    handle(ipc, IPC.settingsUpdate, (patch) => {
        const next = settings.update(patch);
        onChange?.();
        return next;
    });
    handle(ipc, IPC.secretsList, () => secrets.list());
    handle(ipc, IPC.secretsSet, ({ name, value }) => {
        secrets.set(name, value);
        onSecretsChange?.();
    });
    handle(ipc, IPC.secretsRemove, ({ name }) => {
        secrets.remove(name);
        onSecretsChange?.();
    });
}
